// HTTP API consumed by the settings UI. Single exact path, op dispatch in query.
// Every op that writes — or that makes the host connect somewhere — is gated on
// same-origin browser intent, because any local process can reach this loopback port.
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import { discover, guardedHosts, normalizeTargets } from './discovery/index.js'
import {
  planApply,
  commitApply,
  rollbackLast,
  normalizeRoutes,
  upsertRoute,
  removeRoute,
  knownOriginTarget,
} from './patcher.js'
import { probeTarget, probeOnce, verifyApply } from './probe.js'
import { FIRST_PORT, LAST_PORT, isValidPort, isPortFree, isPrivateAddress } from './ports.js'
import { loadDefinitions, inspect as inspectPatch, applyPatch, revertPatch } from './patches.js'
import { botList, applyBotProxy, clearBotProxy } from './bots.js'
import { findDrift, repairDrift, pausedProviders } from './reconcile.js'
import { readState, readRoutes, readBots, writeBot, saveRoutesAndListeners, rememberDiscovery, readPatchLedger, writePatchLedger, recordHistory, recordError, stateDir as defaultStateDir } from './store.js'
import { validateState } from './schema.js'
import { isRelayId, relayIdFor, routeKind, buildRelayRoute } from './relay-routes.js'
import { builtinEndpoints, catalogCandidates } from './provider-catalog.js'

function pluginVersion() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))
    return manifest.version ?? null
  } catch {
    return null
  }
}

/** Strip userinfo from a proxy URL: some users put credentials straight in the YAML. */
function redactUrl(value) {
  if (!value) return null
  try {
    const parsed = new URL(String(value))
    if (parsed.username || parsed.password) {
      parsed.username = '***'
      parsed.password = ''
    }
    return parsed.toString()
  } catch {
    return String(value).replace(/^([a-z]+:\/\/)[^/@]+@/i, '$1***@')
  }
}

const MAX_BODY = 256 * 1024
// A batch is a UI convenience, not a bulk import: 20 rows is already more than the page shows.
const MAX_BATCH = 20

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function httpError(status, code, message) {
  const err = new Error(message)
  err.status = status
  err.code = code
  return err
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(httpError(413, 'body_too_large', 'request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve({})
      try { resolve(JSON.parse(text)) } catch (err) { reject(httpError(400, 'invalid_json', 'invalid JSON body: ' + err.message)) }
    })
    req.on('error', reject)
  })
}

/**
 * CSRF boundary for write and intrusive ops.
 *
 * The desktop GUI is a `dsh-app://app` document that forwards `/plugins/…` to this
 * loopback route, so its Origin is a custom scheme (or absent) and can never equal the
 * request Host. Requiring Origin===Host therefore rejected the real settings page.
 *
 * What actually stops a hostile web page is the JSON content type: a cross-origin
 * `fetch` with `application/json` forces a CORS preflight, this route never answers one
 * with CORS headers, so the browser blocks the request before it is sent; a plain HTML
 * form cannot set that type either. A local native process can spoof headers and can
 * edit the file directly, so header checks never defended against it.
 *
 * Accept the shell (custom scheme / absent Origin) and our own origin; reject an
 * explicitly foreign http(s) Origin as a cheap extra check.
 */
function isTrustedWrite(req) {
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase()
  if (site === 'same-origin' || site === 'same-site' || site === 'none') return true
  const origin = req.headers.origin
  if (!origin) return true
  const value = String(origin)
  if (/^(dsh-app|dsh|app|file):/i.test(value)) return true
  if (value === 'null') return true
  const host = req.headers.host
  // An explicit foreign Origin without a Host header is not a same-origin shell request.
  if (!host) return false
  try {
    const parsed = new URL(value)
    if (parsed.host === String(host)) return true
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'
  } catch {
    return false
  }
}

function assertWriteAllowed(req) {
  if (req.method !== 'POST') throw httpError(405, 'method_not_allowed', 'write ops must use POST')
  if (!isTrustedWrite(req)) throw httpError(403, 'unauthorized', 'this endpoint only accepts calls from the DSH settings page')
  const type = String(req.headers['content-type'] || '').toLowerCase()
  if (!type.includes('application/json')) throw httpError(415, 'unsupported_media_type', 'content-type must be application/json')
}

function parseTarget(body) {
  const itemId = String(body.itemId || '')
  if (!/^llm:./.test(itemId)) {
    throw httpError(400, 'not_patchable', 'only llm:<provider> items can be rewritten, got: ' + itemId)
  }
  const listenPort = Number(body.listenPort)
  if (!isValidPort(listenPort)) throw httpError(400, 'invalid_port', 'port must be 1024-65535, got: ' + body.listenPort)
  const target = String(body.target || '')
  if (!/^[A-Za-z0-9._-]+:\d{1,5}$/.test(target)) throw httpError(400, 'invalid_target', 'target must be host:port, got: ' + target)
  if (isPrivateAddress(target.split(':')[0])) {
    throw httpError(400, 'loopback_target', 'refusing to route a private or loopback target: ' + target)
  }
  return { itemId, listenPort, target }
}

function parseTuning(body) {
  const bounds = { maxSockets: [1, 64], timeoutMs: [1000, 600000], connectTimeoutMs: [1000, 120000] }
  const tuning = {}
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const raw = body?.[key]
    if (raw === undefined || raw === null || raw === '') continue
    const value = Number(raw)
    if (!Number.isInteger(value) || value < min || value > max) {
      throw httpError(400, 'invalid_tuning', key + ' must be an integer between ' + min + ' and ' + max + ', got: ' + raw)
    }
    tuning[key] = value
  }
  return tuning
}

/** One request through a route's loopback listener: proves relay + tunnel + upstream. */
function relayRequest({ port, path = '/', method = 'HEAD', timeoutMs = 15000 }) {
  return new Promise((resolve) => {
    const started = Date.now()
    const request = http.request(
      { host: '127.0.0.1', port, method, path, headers: { 'user-agent': 'dsh-egress-router-test' }, timeout: timeoutMs, agent: false },
      (response) => {
        const status = response.statusCode ?? null
        response.resume()
        response.on('end', () => resolve({
          ok: status !== null && status < 500,
          status,
          ms: Date.now() - started,
          error: status !== null && status >= 500 ? 'upstream returned HTTP ' + status : null,
        }))
      },
    )
    request.on('timeout', () => request.destroy(new Error('timed out after ' + timeoutMs + 'ms')))
    request.on('error', (err) => resolve({ ok: false, status: null, ms: Date.now() - started, error: err?.message ?? String(err) }))
    request.end()
  })
}

export function makeHandler({
  config,
  manager,
  profileDir,
  log = () => {},
  verify = verifyApply,
  probe = probeTarget,
  persist = saveRoutesAndListeners,
  stateDir = null,
}) {
  const listenHost = config?.listenHost || '127.0.0.1'
  // 0.11.0: operator-declared real endpoints, e.g. an enterprise gateway that is not in the
  // built-in table. Used only as a fallback when the ledger has no record.
  const origins = config?.origins && typeof config.origins === 'object' ? config.origins : {}
  // 0.13.0: endpoint overrides for providers that do not spell out baseURL.
  const providerDefaults = config?.providerDefaults && typeof config.providerDefaults === 'object' ? config.providerDefaults : {}
  const catalogDirs = Array.isArray(config?.catalogDirs) ? config.catalogDirs : null
  const patchStateDir = stateDir || defaultStateDir()

  /** Compatibility patches, with their on-disk status and the boot-repair ledger. */
  // Read-only: the settings page shows a warning when the config file and the
// running routes disagree (0.5.1). Never write from a GET.
function safeDrift() {
  try {
    const result = findDrift({ profileDir, routes: normalizeRoutes(readRoutes()) })
    return { drift: result.drift, missing: result.missing }
  } catch (err) {
    return { drift: [], missing: [], error: err?.message ?? String(err) }
  }
}

function patchList() {
    const ledger = readPatchLedger()
    return loadDefinitions().map((def) => {
      let info
      try {
        info = inspectPatch(def, { profileDir, stateDir: patchStateDir })
      } catch (err) {
        info = { id: def.id, title: def.title || def.id, package: def.package, file: def.file, status: 'error', detail: err.message }
      }
      return { ...info, ledger: ledger[def.id] ?? null }
    })
  }

  /** Targets the user already knows about: discovered rows plus live routes. */
  function knownTargets() {
    const state = readState()
    const discovered = (state.discovered?.items ?? []).map((item) => item.target).filter(Boolean)
    const routes = normalizeRoutes(readRoutes()).map((route) => route.target)
    // 0.9.0: config.targets is a declared list, so those hosts count as known before the
    // first scan (otherwise every declared endpoint fails probe with unknown_target).
    const custom = normalizeTargets(config?.targets).map((entry) => entry.host + ':' + entry.port)
    return new Set([...discovered, ...routes, ...custom])
  }


  /** Redacted, self-contained snapshot for bug reports (0.9.0). */
  function diagnose(state) {
    const bots = botList({ bots: readBots(), proxies: config?.proxies ?? {}, profileDir, stateDir: patchStateDir })
    return {
      apiVersion: 1,
      generatedAt: new Date().toISOString(),
      plugin: {
        name: 'dsh-egress-router',
        version: pluginVersion(),
        profileDir,
        profileOk: fs.existsSync(path.join(profileDir, 'cordis.patch.yml')),
        contract: state.hostContract ?? null,
        hostEnv: state.hostEnv ?? null,
      },
      config: {
        listenHost,
        proxies: Object.fromEntries(Object.entries(config?.proxies ?? {}).map(([name, url]) => [name, redactUrl(url)])),
        targets: normalizeTargets(config?.targets),
        verifyAfterApply: config?.verifyAfterApply !== false,
        // 0.11.0: the effective protected list (built-ins + config.guarded), so a bug report
        // can show why a host was refused without the reporter reading the source.
        guarded: guardedHosts(config?.guarded),
        discovery: {
          rules: Array.isArray(config?.discovery?.rules) ? config.discovery.rules.length : 0,
          ignore: Array.isArray(config?.discovery?.ignore) ? config.discovery.ignore.length : 0,
        },
        origins: Object.keys(origins),
        providerDefaults: Object.keys(providerDefaults),
      },
      // Where endpoints may be resolved from when a provider has no baseURL (0.13.0).
      catalog: {
        builtin: Object.keys(builtinEndpoints()).length,
        dirs: (catalogDirs ?? catalogCandidates({ profileDir })).length,
        first: (catalogDirs ?? catalogCandidates({ profileDir }))[0] ?? null,
      },
      routes: normalizeRoutes(readRoutes()),
      listeners: state.listeners ?? [],
      metrics: manager.metrics(),
      metricsTotals: state.metricsTotals ?? {},
      drift: safeDrift(),
      paused: pausedProviders(),
      patches: patchList().map((item) => ({ id: item.id, package: item.package, status: item.status, version: item.version })),
      bots: bots.map((bot) => ({
        id: bot.id,
        envVar: bot.envVar,
        configured: Boolean(bot.proxy),
        proxy: bot.proxy ?? null,
        patch: { id: bot.patch?.id ?? null, status: bot.patch?.status ?? null },
      })),
      history: (state.history ?? []).slice(-20),
      lastError: state.lastError ?? null,
      schemaVersion: state.schemaVersion ?? 1,
    }
  }

async function applyRoute(body, options = {}) {
    // Compensation must not spend another 12 s of verification: it only needs the file back.
    const verifier = options.verify === false ? null : verify
    // H11: a provider whose real endpoint was lost can be rebuilt from a public URL the
    // user types in. Accepting it here means "Apply" is never a dead end.
    const requestedOrigin = body.origin === undefined || body.origin === null || body.origin === '' ? null : String(body.origin)
    if (requestedOrigin) {
      let parsedOrigin = null
      try {
        parsedOrigin = new URL(requestedOrigin)
      } catch {
        throw httpError(400, 'invalid_origin', 'origin must be an absolute URL, got: ' + requestedOrigin)
      }
      if (!/^https?:$/.test(parsedOrigin.protocol) || isPrivateAddress(parsedOrigin.hostname)) {
        throw httpError(400, 'invalid_origin', 'origin must be a public http(s) URL, got: ' + requestedOrigin)
      }
      const port = parsedOrigin.port || (parsedOrigin.protocol === 'https:' ? '443' : '80')
      body = { ...body, target: parsedOrigin.hostname + ':' + port }
    }
    const requested = String(body.target || '')
    const host = requested.split(':')[0]
    if (host && isPrivateAddress(host)) {
      const providerKey = String(body.itemId || '').replace(/^llm:/, '')
      const recovered = providerKey ? knownOriginTarget(providerKey, origins, providerDefaults) : null
      if (recovered) body = { ...body, target: recovered }
      else {
        throw httpError(400, 'loopback_target',
          'this provider still points at the local relay, but no original endpoint is on record; restore its baseURL by hand (or upgrade the plugin) instead of routing ' + requested)
      }
    }
    const { itemId, listenPort, target } = parseTarget(body)
    const tuning = parseTuning(body)
    const previous = normalizeRoutes(readRoutes())

    if (body.proxy !== undefined && body.proxy !== null && body.proxy !== '') {
      try { manager.resolveProxy(String(body.proxy)) } catch (err) { throw httpError(400, 'unknown_proxy', err.message) }
    }

    // Our own listener already holds the port when the user re-applies the same row.
    if (!manager.owns(itemId, listenPort) && !(await isPortFree(listenPort, listenHost))) {
      throw httpError(409, 'port_in_use', 'port ' + listenPort + ' is already in use')
    }

    const plan = planApply({
      profileDir,
      itemId,
      listenPort,
      target,
      proxy: body.proxy,   // undefined keeps the existing proxy (no silent downgrade to direct)
      tls: body.tls,
      tuning,
      origin: requestedOrigin,
      origins,
      providerDefaults,
    })
    const candidate = upsertRoute(previous, plan.route)
    let written = null
    try {
      // Listener first, file second: a failed write must not leave a baseURL that
      // points at a port nothing is listening on.
      const started = await manager.sync(candidate)
      const failed = started.find((item) => item.id === itemId && item.ok === false)
      if (failed) {
        await manager.sync(previous)
        throw httpError(502, 'listener_failed', failed.error || 'listener failed to start')
      }

      written = commitApply({ profileDir, plan })

      let check = null
if (verifier) {
        check = await verifier({ target: plan.route.target, proxyUrl: manager.proxyUrlFor(plan.route.proxy), timeoutMs: 12000, retries: 2 })
        if (!check || !check.ok) {
          throw httpError(502, 'apply_unverified', 'route started but the target is unreachable: ' + (check?.error ?? 'unknown error'))
        }
      }

      // Routes, listeners and the audit trail land in one write (R2).
      persist({ routes: candidate, listeners: manager.snapshot(), metrics: manager.metrics() })
      log('[egress] applied ' + itemId + ' -> 127.0.0.1:' + listenPort + ' (' + written.format + ')')
      return {
        diff: plan.diff,
        routes: candidate,
        status: manager.snapshot(),
        metrics: manager.metrics(),
        backup: written.backup,
        format: written.format,
        verified: verifier ? true : null,
        verifyStatus: check?.status ?? null,
        restartRequired: true,
      }
    } catch (err) {
      await manager.sync(previous).catch(() => {})
      if (written) {
        try { rollbackLast({ routeId: itemId, force: true, origins }) } catch (err) { recordError('apply-rollback', err, { history: false }) }
      }
      try {
        persist({
          routes: previous,
          listeners: manager.snapshot(),
          metrics: manager.metrics(),
          history: { op: 'apply', routeId: itemId, ok: false, detail: err?.message ?? String(err) },
        })
      } catch (err) {
        recordError('apply-persist', err, { history: false })
      }
      throw err
    }
  }

  async function rollback(body) {
    const itemId = body?.itemId ? String(body.itemId) : null
    const force = body?.force === true
    const restored = rollbackLast({ routeId: itemId, force, origins })
    const routes = restored.routeId ? removeRoute(normalizeRoutes(readRoutes()), restored.routeId) : normalizeRoutes(readRoutes())
    // sync() stops listeners whose route disappeared, so rollback also releases the port.
    const status = await manager.sync(routes)
    persist({ routes, listeners: status, metrics: manager.metrics() })
    return { restored, routes, status, metrics: manager.metrics(), restartRequired: true }
  }

  /** One route as the settings page sees it: stored fields plus the live listener state. */
  function routeRow(route) {
    const live = manager.snapshot().find((item) => item.id === route.id) ?? null
    return {
      id: route.id,
      kind: routeKind(route),
      target: route.target,
      listenPort: Number(route.listenPort),
      proxy: route.proxy ?? null,
      tls: route.tls ?? null,
      originBaseURL: route.originBaseURL ?? null,
      enabled: route.enabled !== false,
      tuning: manager.tuning(route),
      origin: routeKind(route) === 'relay' ? 'http://127.0.0.1:' + Number(route.listenPort) : null,
      status: live,
    }
  }

  function routeRows() {
    return normalizeRoutes(readRoutes()).map(routeRow)
  }

  /**
   * Create or change one route. A provider id keeps the original apply path (rewrite the
   * baseURL, verify, roll back on failure). A relay id only owns a listener: there is no
   * config file to touch, so only the listener can be rolled back (0.10.0).
   */
  async function upsertRouteAction(body) {
    // Batches pass itemId; the routes op passes id. One parser for both.
    const id = String(body?.id || body?.itemId || '')
    if (!id) throw httpError(400, 'id_required', 'id required: llm:<provider> or relay:<name>')
    const listenPort = Number(body.listenPort)
    if (!isValidPort(listenPort)) throw httpError(400, 'invalid_port', 'port must be 1024-65535, got: ' + body.listenPort)
    const tuning = parseTuning(body)
    if (!isRelayId(id)) {
      if (!/^llm:./.test(id)) throw httpError(400, 'invalid_id', 'ids must be llm:<provider> or relay:<name>, got: ' + id)
      return applyRoute({ ...body, itemId: id, listenPort })
    }

    const previous = normalizeRoutes(readRoutes())
    const existing = previous.find((route) => route.id === id) ?? null
    const route = buildRelayRoute({
      id,
      target: body.target,
      listenPort,
      proxy: body.proxy,
      tls: body.tls,
      tuning,
      existing,
    })
    if (route.proxy) {
      try { manager.resolveProxy(route.proxy) } catch (err) { throw httpError(400, 'unknown_proxy', err.message) }
    }
    if (!manager.owns(id, listenPort) && !(await isPortFree(listenPort, listenHost))) {
      throw httpError(409, 'port_in_use', 'port ' + listenPort + ' is already in use')
    }
    const candidate = upsertRoute(previous, route)
    const started = await manager.sync(candidate)
    const failed = started.find((item) => item.id === id && item.ok === false)
    if (failed) {
      await manager.sync(previous)
      throw httpError(502, 'listener_failed', failed.error || 'listener failed to start')
    }

    const unchanged = Boolean(existing && existing.target === route.target && Number(existing.listenPort) === listenPort && (existing.proxy ?? null) === (route.proxy ?? null))
    let check = null
    if (!unchanged && verify) {
      check = await verify({ target: route.target, proxyUrl: manager.proxyUrlFor(route.proxy), timeoutMs: 12000, retries: 2 })
      if (!check || !check.ok) {
        await manager.sync(previous).catch(() => {})
        throw httpError(502, 'route_unverified', 'listener started but the target is unreachable: ' + (check?.error ?? 'unknown error'))
      }
    }
    persist({ routes: candidate, listeners: manager.snapshot(), metrics: manager.metrics() })
    recordHistory({
      op: existing ? 'route-update' : 'route-create',
      routeId: id,
      ok: true,
      detail: route.target + ' on :' + listenPort + (route.proxy ? ' via ' + route.proxy : ' (direct)'),
    })
    log('[egress] relay ' + (existing ? 'updated ' : 'created ') + id + ' -> ' + route.target + ' on :' + listenPort)
    return {
      action: existing ? 'update' : 'create',
      route: routeRow(route),
      diff: [{ path: 'routes.' + id, before: existing, after: route }],
      status: manager.snapshot(),
      metrics: manager.metrics(),
      verified: verify && !unchanged ? Boolean(check?.ok) : null,
      restartRequired: false,
    }
  }

  /** Remove one route. Provider routes put the config file back first; relay routes just stop. */
  async function deleteRouteAction(body) {
    const id = String(body?.id || body?.itemId || '')
    if (!id) throw httpError(400, 'id_required', 'id required')
    const routes = normalizeRoutes(readRoutes())
    const existing = routes.find((route) => route.id === id) ?? null
    if (!existing) throw httpError(404, 'unknown_route', 'no route with id ' + id)
    if (!isRelayId(id)) {
      const result = await rollback({ itemId: id, force: body?.force === true })
      recordHistory({ op: 'route-delete', routeId: id, ok: true, detail: 'restored ' + (result.restored?.restored ?? '-') })
      return {
        action: 'delete',
        route: routeRow(existing),
        restored: result.restored,
        routes: result.routes,
        status: result.status,
        metrics: result.metrics,
        restartRequired: true,
      }
    }
    const candidate = removeRoute(routes, id)
    const status = await manager.sync(candidate)
    persist({ routes: candidate, listeners: status, metrics: manager.metrics() })
    recordHistory({ op: 'route-delete', routeId: id, ok: true, detail: existing.target })
    log('[egress] relay removed ' + id)
    return {
      action: 'delete',
      route: routeRow(existing),
      routes: candidate,
      status,
      metrics: manager.metrics(),
      restartRequired: false,
    }
  }

  /** Reverse a run of batch steps, newest first, best effort. */
  async function compensate(entries) {
    let done = 0
    for (const entry of entries) {
      try {
        if (entry.kind === 'applied') {
          await deleteRouteAction({ id: entry.itemId, force: true })
        } else if (isRelayId(entry.itemId)) {
          await upsertRouteAction({
            id: entry.itemId,
            target: entry.route.target,
            listenPort: entry.route.listenPort,
            proxy: entry.route.proxy ?? null,
            tls: entry.route.tls ?? null,
          })
        } else {
          await applyRoute({
            itemId: entry.itemId,
            target: entry.route.target,
            listenPort: entry.route.listenPort,
            proxy: entry.route.proxy ?? undefined,
            origin: entry.route.originBaseURL ?? undefined,
          }, { verify: false })
        }
        done += 1
      } catch (err) {
        recordError('batch-compensate', err, { history: false })
      }
    }
    return done
  }

  /**
   * Apply or undo several routes as one unit. Everything is validated before the first
   * write - a batch that dies halfway is worse than one that never started - and a runtime
   * failure compensates the steps that already succeeded (0.10.0).
   */
  async function batchActions(body) {
    const actions = Array.isArray(body?.actions) ? body.actions : null
    if (!actions || actions.length === 0) throw httpError(400, 'no_actions', 'actions[] is required')
    if (actions.length > MAX_BATCH) throw httpError(400, 'too_many_actions', 'at most ' + MAX_BATCH + ' actions per batch')

    const routes = normalizeRoutes(readRoutes())
    const claims = new Map()
    const prepared = []
    for (const [index, raw] of actions.entries()) {
      const itemId = String(raw?.itemId || '')
      const action = String(raw?.action || 'apply')
      if (!itemId) throw httpError(400, 'invalid_action', 'actions[' + index + '] needs itemId')
      if (action !== 'apply' && action !== 'rollback') {
        throw httpError(400, 'invalid_action', 'actions[' + index + '] action must be apply or rollback, got: ' + action)
      }
      if (action === 'rollback') {
        if (!routes.some((route) => route.id === itemId)) {
          throw httpError(404, 'unknown_route', 'actions[' + index + ']: no route with id ' + itemId)
        }
        prepared.push({ itemId, action })
        continue
      }
      const listenPort = Number(raw.listenPort)
      if (!isValidPort(listenPort)) throw httpError(400, 'invalid_port', 'actions[' + index + ']: port must be 1024-65535')
      if (claims.has(listenPort)) {
        throw httpError(409, 'port_in_use', 'actions[' + index + '] and actions[' + claims.get(listenPort) + '] both ask for port ' + listenPort)
      }
      claims.set(listenPort, index)
      const target = String(raw.target || '')
      if (!target) throw httpError(400, 'invalid_target', 'actions[' + index + '] needs target')
      if (raw.proxy !== undefined && raw.proxy !== null && raw.proxy !== '') {
        try { manager.resolveProxy(String(raw.proxy)) } catch (err) { throw httpError(400, 'unknown_proxy', err.message) }
      }
      if (isRelayId(itemId)) {
        buildRelayRoute({
          id: itemId,
          target,
          listenPort,
          proxy: raw.proxy,
          tls: raw.tls,
          tuning: parseTuning(raw),
          existing: routes.find((route) => route.id === itemId) ?? null,
        })
      } else if (!/^llm:./.test(itemId)) {
        throw httpError(400, 'invalid_id', 'actions[' + index + ']: ids must be llm:<provider> or relay:<name>')
      }
      if (!manager.owns(itemId, listenPort) && !(await isPortFree(listenPort, listenHost))) {
        throw httpError(409, 'port_in_use', 'actions[' + index + ']: port ' + listenPort + ' is already in use')
      }
      prepared.push({ itemId, action, body: { ...raw, itemId, listenPort, target } })
    }

    const results = []
    const undo = []
    for (const step of prepared) {
      try {
        if (step.action === 'apply') {
          await upsertRouteAction(step.body)
          results.push({ itemId: step.itemId, action: 'apply', ok: true })
          undo.push({ kind: 'applied', itemId: step.itemId })
        } else {
          const route = routes.find((item) => item.id === step.itemId)
          const detail = await deleteRouteAction({ id: step.itemId })
          results.push({ itemId: step.itemId, action: 'rollback', ok: true, restored: detail.restored?.restored ?? null })
          undo.push({ kind: 'reverted', itemId: step.itemId, route })
        }
      } catch (err) {
        const undone = await compensate(undo.reverse())
        recordHistory({
          op: 'batch',
          routeId: step.itemId,
          ok: false,
          detail: 'stopped at ' + step.itemId + ': ' + (err?.message ?? String(err)) + '; ' + undone + ' undone',
        })
        const failure = httpError(502, err?.code || 'batch_failed',
          'batch stopped at ' + step.itemId + ': ' + (err?.message ?? String(err)) + '; ' + undone + ' earlier action(s) undone')
        failure.payload = { results, compensated: undone }
        throw failure
      }
    }

    const status = manager.snapshot()
    recordHistory({ op: 'batch', routeId: null, ok: true, detail: prepared.length + ' action(s)' })
    return { ok: true, results, compensated: 0, routes: routeRows(), status, metrics: manager.metrics(), restartRequired: true }
  }

  // Mutating ops run one at a time: two clicks (or a retry racing an apply) must never
  // interleave the read-modify-write on state.json or on the patch file. Reads stay concurrent.
  const WRITE_OPS = new Set(['apply', 'rollback', 'routes', 'batch', 'patch', 'bot', 'reconcile'])
  let writeChain = Promise.resolve()
  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const op = url.searchParams.get('op') || 'state'
    try {
      if (op === 'state') {
        const state = readState()
        // A malformed document is reported, never silently repaired here: the page must be
        // able to say "your state file has a broken row" instead of showing an empty list.
        const stateCheck = validateState(state)
        return json(res, 200, {
          // 0.9.0: consumers can tell additive changes from breaking ones.
          apiVersion: 1,
          config,
          routes: normalizeRoutes(readRoutes()).map((route) => ({ ...route, kind: routeKind(route) })),
          status: manager.snapshot(),
          metrics: Object.fromEntries(
            Object.entries({ ...(state.metrics ?? {}), ...manager.metrics() }).map(([id, row]) => [
              id,
              { ...row, totals: state.metricsTotals?.[id] ?? null },
            ]),
          ),
          metricsTotals: state.metricsTotals ?? {},
          tuning: manager.tuning({}),
          listeners: state.listeners ?? [],
          discovered: state.discovered ?? null,
          discoveredAt: state.discoveredAt ?? null,
          warnings: state.warnings ?? [],
          history: (state.history ?? []).slice(-10),
          backups: (state.backups ?? []).length,
          schemaVersion: state.schemaVersion ?? 1,
          schemaOk: stateCheck.ok,
          schemaErrors: stateCheck.errors,
          contract: state.hostContract ?? null,
          hostEnv: state.hostEnv ?? null,
          // Last swallowed failure, so "it just stopped working" has an answer (0.8.0).
          lastError: state.lastError ?? null,
          // What this plugin's client half needs from the host. Declared, not guessed: when a
          // future host renames the loader or the slot, the page can say which contract broke.
          clientContract: {
            loader: 'window.__ModuleLoader__.load',
            slot: 'settings.plugins.tab',
            bundle: 'exports["./client"]',
            patch: 'dsh.client',
          },
          drift: safeDrift(),
          paused: pausedProviders(),
          patches: patchList(),
          bots: botList({ bots: readBots(), proxies: config?.proxies ?? {}, profileDir, stateDir: patchStateDir }),
          profileDir,
          // Which directory the plugin thinks the profile is. When it is wrong, discovery finds
          // nothing and the patch rows say "not installed"; showing the flag turns that silent
          // failure into a visible one (0.7.3).
          profileOk: fs.existsSync(path.join(profileDir, 'cordis.patch.yml')),
        })
      }
      if (op === 'discover') {
        const result = discover({
          profileDir,
          routes: normalizeRoutes(readRoutes()),
          targets: config?.targets,
          guarded: config?.guarded,
          origins,
          providerDefaults,
          catalogDirs,
          discovery: config?.discovery,
        })
        rememberDiscovery(result)
        return json(res, 200, result)
      }
      if (op === 'diagnose') {
        // Read-only snapshot meant to be sent to someone else: credentials, proxy userinfo
        // and absolute backup paths never leave the machine.
        return json(res, 200, diagnose(readState()))
      }
      if (op === 'upstream') {
        // Upstream health is the one thing the page could not answer before 0.9.0: a dead
        // proxy looked exactly like a dead model. Probing opens sockets through the same
        // path the relay uses, so it needs write intent.
        assertWriteAllowed(req)
        await readBody(req)
        const routes = normalizeRoutes(readRoutes())
        const results = []
        for (const route of routes) {
          const proxyName = route.proxy ?? null
          let proxyUrl = null
          try {
            if (proxyName) proxyUrl = manager.proxyUrlFor(proxyName)
          } catch (err) {
            results.push({ id: route.id, target: route.target, proxy: proxyName, via: 'proxy', ok: false, ms: 0, error: err.message })
            continue
          }
          const one = await probeOnce({ target: route.target, proxyUrl, timeoutMs: 6000 })
          results.push({
            id: route.id,
            target: route.target,
            proxy: proxyName,
            via: one.via,
            ok: one.ok,
            ms: one.ms,
            error: one.error,
          })
        }
        return json(res, 200, {
          checkedAt: new Date().toISOString(),
          ok: results.every((item) => item.ok),
          results,
        })
      }
      if (op === 'probe') {
        // Probing makes the host open sockets, so it needs the same intent check as a
        // write, and it may only touch targets the user can already see (R4).
        assertWriteAllowed(req)
        const body = await readBody(req)
        const routes = normalizeRoutes(readRoutes())
        const route = body.id ? routes.find((item) => item.id === body.id) ?? null : null
        const target = String(body.target || route?.target || '')
        if (!target) throw httpError(400, 'target_required', 'target required')
        if (isPrivateAddress(target.split(':')[0])) {
          throw httpError(400, 'private_target', 'refusing to probe a private or loopback target: ' + target)
        }
        if (!knownTargets().has(target)) {
          throw httpError(400, 'unknown_target', 'probe only accepts targets discovered by this plugin; scan first: ' + target)
        }
        const proxyName = body.proxy ?? route?.proxy ?? null
        if (proxyName) {
          try { manager.resolveProxy(proxyName) } catch (err) { throw httpError(400, 'unknown_proxy', err.message) }
        }
        const proxyUrl = manager.proxyUrlFor(proxyName ?? manager.defaultProxyName())
        return json(res, 200, await probe({ target, proxyUrl, compare: Boolean(proxyUrl) }))
      }
      if (op === 'plan') {
        // Dry run: same validation and diff as apply, but nothing is written and no
        // listener is started, so the page can show "what would change" first.
        assertWriteAllowed(req)
        const body = await readBody(req)
        const { itemId, listenPort, target } = parseTarget(body)
        const tuning = parseTuning(body)
        const previous = normalizeRoutes(readRoutes())
        if (body.proxy !== undefined && body.proxy !== null && body.proxy !== '') {
          try { manager.resolveProxy(String(body.proxy)) } catch (err) { throw httpError(400, 'unknown_proxy', err.message) }
        }
        const ownsPort = manager.owns(itemId, listenPort)
        const portFree = ownsPort || (await isPortFree(listenPort, listenHost))
        const plan = planApply({ profileDir, itemId, listenPort, target, proxy: body.proxy, tls: body.tls, tuning, origins, providerDefaults })
        return json(res, 200, {
          diff: plan.diff,
          route: plan.route,
          current: previous.find((route) => route.id === itemId) ?? null,
          ownsPort,
          portFree,
          warnings: portFree ? [] : ['port ' + listenPort + ' is already in use'],
        })
      }
      if (op === 'suggest') {
        // Read-only: hand the page a port it can actually bind. Ports claimed by this
        // plugin's own routes are skipped, otherwise every row suggests the one busy
        // port (8792) and applying a second route always fails with port_in_use.
        const itemId = url.searchParams.get('itemId') || ''
        const claimed = normalizeRoutes(readRoutes()).map((route) => Number(route.listenPort))
        const running = manager.snapshot().map((item) => Number(item.port))
        const used = [...claimed, ...running].filter((port) => Number.isInteger(port) && port > 0)
        // A row that already has a port keeps it: re-applying must never move a live
        // route, and the UI only needs a suggestion when the port is still empty.
        const known = normalizeRoutes(readRoutes()).find((route) => route.id === itemId)
        const live = manager.snapshot().find((item) => item.id === itemId)
        const existing = Number(known?.listenPort || live?.port || 0)
        if (existing) return json(res, 200, { host: listenHost, port: existing, used: [...new Set(used)].sort((a, b) => a - b), reuse: true })
        let port = null
        for (let candidate = FIRST_PORT; candidate <= LAST_PORT; candidate += 1) {
          if (itemId && manager.owns(itemId, candidate)) { port = candidate; break }
          if (used.includes(candidate)) continue
          if (await isPortFree(candidate, listenHost)) { port = candidate; break }
        }
        return json(res, 200, { host: listenHost, port, used: [...new Set(used)].sort((a, b) => a - b) })
      }
      if (op === 'ports') {
        // Read-only: only asks the OS whether a loopback port can be bound.
        const asked = url.searchParams.getAll('port').map(Number).filter((port) => isValidPort(port))
        const candidates = new Set([...asked, ...normalizeRoutes(readRoutes()).map((route) => Number(route.listenPort))])
        const ports = {}
        for (const port of candidates) ports[port] = await isPortFree(port, listenHost)
        return json(res, 200, { host: listenHost, ports })
      }
      if (op === 'test') {
        // One real request through the listener: the only check that covers the whole
        // chain (loopback -> relay -> tunnel -> upstream -> HTTP status).
        assertWriteAllowed(req)
        const body = await readBody(req)
        const running = manager.snapshot().find((item) => (body.id ? item.id === body.id : Number(item.port) === Number(body.listenPort)))
        if (!running) throw httpError(400, 'route_not_running', 'no running route for ' + (body.id ?? body.listenPort))
        if (running.ok === false) throw httpError(400, 'route_not_running', running.error ?? 'route is not running')
        const path = String(body.path || '/')
        if (!path.startsWith('/')) throw httpError(400, 'invalid_path', 'path must start with /')
        const method = String(body.method || 'HEAD').toUpperCase()
        const result = await relayRequest({ port: running.port, path, method })
        return json(res, 200, { id: running.id, target: running.target, port: running.port, path, method, ...result })
      }
      if (op === 'reconcile') {
        // Re-points every drifted provider at its listener. Same intent gate as an apply:
        // it edits cordis.patch.yml and can only be started from the settings page.
        assertWriteAllowed(req)
        await readBody(req)
        const result = repairDrift({ profileDir, routes: normalizeRoutes(readRoutes()), reason: 'manual' })
        return json(res, 200, { repaired: result.repaired, missing: result.missing, backup: result.backup ?? null })
      }
      if (op === 'patches') {
        return json(res, 200, { patches: patchList() })
      }
      if (op === 'patch') {
        // Patching writes into another plugin's installed file, so it needs the same
        // browser-intent check as an apply, and the ledger so boot repair can heal it.
        assertWriteAllowed(req)
        const body = await readBody(req)
        const defs = loadDefinitions()
        const def = defs.find((item) => item.id === body.id)
        if (!def) throw httpError(404, 'unknown_patch', 'unknown patch: ' + body.id)
        const action = String(body.action || 'apply')
        const options = { profileDir, stateDir: patchStateDir }
        if (action === 'verify') return json(res, 200, { patch: inspectPatch(def, options) })
        if (action === 'apply') {
          const result = applyPatch(def, options)
          if (result.changed) {
            const ledger = readPatchLedger()
            ledger[def.id] = { appliedAt: new Date().toISOString(), version: result.version, file: def.file }
            writePatchLedger(ledger)
            recordHistory({ op: 'patch-apply', routeId: null, ok: true, detail: def.id + '@' + result.version })
          }
          return json(res, 200, { patch: result, restartRequired: result.changed })
        }
        if (action === 'revert') {
          const result = revertPatch(def, options)
          const ledger = readPatchLedger()
          if (ledger[def.id]) {
            delete ledger[def.id]
            writePatchLedger(ledger)
          }
          recordHistory({ op: 'patch-revert', routeId: null, ok: true, detail: def.id })
          return json(res, 200, { patch: result, restartRequired: true })
        }
        throw httpError(400, 'invalid_action', 'action must be apply, revert or verify: ' + action)
      }
      if (op === 'bot') {
        // A messaging plugin has no baseURL to rewrite: the levers are its managed patch and
        // the environment variable that patch reads. This op performs both, records the
        // choice so the next boot restores it before the bots connect, and says plainly that
        // the running bot keeps its old transport until DSH restarts.
        assertWriteAllowed(req)
        const body = await readBody(req)
        const id = String(body.id || '')
        const proxies = config?.proxies ?? {}
        if (body.proxy === undefined) throw httpError(400, 'proxy_required', 'proxy required: send a proxy name, or an empty string for the patched default')
        const proxyName = String(body.proxy || '')
        let result
        if (!proxyName) {
          result = clearBotProxy({ id })
          writeBot(id, null)
          recordHistory({ op: 'bot-clear', routeId: id, ok: true, detail: 'patched default' })
        } else {
          result = applyBotProxy({ id, proxyName, proxies, profileDir, stateDir: patchStateDir })
          writeBot(id, { proxy: proxyName, url: result.bot.url })
          recordHistory({ op: 'bot-apply', routeId: id, ok: true, detail: proxyName + ' ' + result.bot.url })
        }
        return json(res, 200, {
          ...result,
          bots: botList({ bots: readBots(), proxies, profileDir, stateDir: patchStateDir }),
        })
      }
      if (op === 'routes') {
        // Route CRUD (0.10.0). GET is read-only; writes need the same intent check as an
        // apply, because they either edit cordis.patch.yml or open a listener.
        if (req.method === 'GET') {
          return json(res, 200, {
            apiVersion: 1,
            routes: routeRows(),
            proxies: Object.keys(config?.proxies ?? {}),
            listenHost,
          })
        }
        assertWriteAllowed(req)
        const body = await readBody(req)
        const action = String(body.action || 'upsert')
        if (action === 'upsert' || action === 'create' || action === 'update') {
          return json(res, 200, await upsertRouteAction(body))
        }
        if (action === 'delete') return json(res, 200, await deleteRouteAction(body))
        throw httpError(400, 'invalid_action', 'action must be upsert or delete: ' + action)
      }
      if (op === 'batch') {
        // One unit of work for the page's checkboxes. Preflight and compensation live in
        // batchActions; this op only owns the transport rules.
        assertWriteAllowed(req)
        const body = await readBody(req)
        return json(res, 200, await batchActions(body))
      }

      if (op === 'apply') {
        assertWriteAllowed(req)
        const body = await readBody(req)
        return json(res, 200, await applyRoute(body))
      }
      if (op === 'rollback') {
        assertWriteAllowed(req)
        const body = await readBody(req)
        return json(res, 200, await rollback(body))
      }
      throw httpError(404, 'unknown_op', 'unknown op: ' + op)
    } catch (err) {
      const status = Number(err?.status) || 500
      log('[egress] op ' + op + ' failed (' + status + '): ' + err.message)
      return json(res, status, {
        error: err?.code || 'internal_error',
        message: err?.message ?? String(err),
        // Ops that stop halfway (batch) carry their per-item results in payload.
        ...(err?.payload && typeof err.payload === 'object' ? err.payload : {}),
      })
    }
  }
  return (req, res) => {
    let op = ''
    try { op = new URL(req.url, 'http://127.0.0.1').searchParams.get('op') || 'state' } catch { op = '' }
    if (req.method === 'POST' && WRITE_OPS.has(op)) {
      const run = () => handle(req, res)
      const next = writeChain.then(run, run)
      writeChain = next.then(() => {}, () => {})
      return next
    }
    return handle(req, res)
  }
}
