// Config writes: preview a diff, back up, write atomically, keep a rollback ledger.
// A write touches exactly one place: the provider baseURL the host reads at start-up.
// Routes live in this plugin's own state (see store.js), so the plugin never inserts a
// second copy of itself into the user's cordis.patch.yml.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { stateDir, readState, readRoutes, updateState, recordError } from './store.js'
import { resolveProviderEndpoint, isCoreApi, hasCatalogProvider } from './provider-catalog.js'

const MAX_HISTORY = 50
const MAX_BACKUPS = 20

function httpError(status, code, message) {
  const err = new Error(message)
  err.status = status
  err.code = code
  return err
}

export function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex')
}

export function readPatchDocument(profileDir) {
  const file = path.join(profileDir, 'cordis.patch.yml')
  const raw = fs.readFileSync(file, 'utf8')
  const doc = yaml.load(raw) ?? []
  if (!Array.isArray(doc)) throw httpError(500, 'patch_not_a_list', 'cordis.patch.yml is not a YAML list')
  return { file, raw, doc }
}

export function findProvider(doc, providerKey) {
  for (const entry of doc) {
    if (!entry || typeof entry !== 'object') continue
    if (entry.id !== 'llm-pi-ai' && !String(entry.name || '').includes('llm-pi-ai')) continue
    const provider = entry.config?.providers?.[providerKey]
    if (provider) return { entry, provider }
  }
  return null
}

export function normalizeRoutes(list) {
  if (!Array.isArray(list)) return []
  return list.filter((route) => route && typeof route === 'object' && route.id && route.target)
}

export function upsertRoute(routes, route) {
  const next = normalizeRoutes(routes)
  const index = next.findIndex((item) => item.id === route.id)
  if (index >= 0) next[index] = { ...next[index], ...route }
  else next.push(route)
  return next
}

export function removeRoute(routes, id) {
  return normalizeRoutes(routes).filter((route) => route.id !== id)
}

/**
 * A loopback baseURL means this plugin already owns this provider. Undo restores the file as
 * it was before *that* apply, which may itself be a loopback URL (re-apply after apply), so
 * the ledger also remembers the last real endpoint (0.5.4).
 */
export function isLoopbackURL(value) {
  try {
    const host = new URL(String(value)).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  } catch { return false }
}

/** Last real (non-loopback) endpoint this plugin knows for a provider, as host:port. */
// Providers whose public endpoint is not recoverable from our own records still have a
// well-known address. Without this, a provider caught pointing at a loopback port with no
// backup on record becomes a dead end: the row can never be routed again.
const DEFAULT_ORIGINS = {
  openrouter: 'https://openrouter.ai/api/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  moonshot: 'https://api.moonshot.cn/v1',
  deepseek: 'https://api.deepseek.com',
}

export function knownOriginTarget(providerKey, origins = {}, providerDefaults = {}) {
  const key = 'llm:' + String(providerKey || '')
  const state = readState()
  const fromRoutes = normalizeRoutes(readRoutes()).find((route) => route.id === key)?.originBaseURL
  const fromBackups = [...(state.backups ?? [])].reverse()
    .filter((entry) => entry.providerKey === providerKey && entry.originBaseURL && !isLoopbackURL(entry.originBaseURL))
    .map((entry) => entry.originBaseURL)[0]
  // 0.13.0: providers imported through the app have no baseURL on record, but the host
  // catalog knows their endpoint, so a stuck loopback row can still be rebuilt.
  const fromCatalog = resolveProviderEndpoint(providerKey, { providerDefaults })?.baseURL ?? null
  return (
    endpointOf(fromRoutes) ??
    endpointOf(fromBackups) ??
    endpointOf(origins?.[providerKey]) ??
    endpointOf(fromCatalog) ??
    endpointOf(DEFAULT_ORIGINS[providerKey]) ??
    null
  )
}

function endpointOf(baseURL) {
  if (!baseURL || isLoopbackURL(baseURL)) return null
  try {
    const url = new URL(String(baseURL))
    return url.hostname + ':' + (url.port || (url.protocol === 'http:' ? '80' : '443'))
  } catch { return null }
}

function rewriteBaseURL(baseURL, listenPort) {
  const parsed = new URL(baseURL)
  const pathPart = parsed.pathname + parsed.search
  return 'http://127.0.0.1:' + listenPort + (pathPart === '/' ? '' : pathPart)
}

/** Leading comment block of the user's file, so a re-dump does not delete their notes. */
function leadingComments(raw) {
  const lines = String(raw).split(/\r?\n/)
  const kept = []
  for (const line of lines) {
    if (/^\s*#/.test(line) || line.trim() === '') kept.push(line)
    else break
  }
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop()
  return kept.length ? kept.join('\n') + '\n' : ''
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Surgical edit: replace (or insert) just the baseURL line inside one provider block,
 * leaving comments, anchors, key order and quoting everywhere else untouched.
 * Returns the new text, or null when the shape is not what we recognise (caller falls
 * back to a full dump, which is why the result records `format`).
 */
export function setProviderBaseURL(raw, providerKey, value, options = {}) {
  const eol = String(raw).includes('\r\n') ? '\r\n' : '\n'
  const lines = String(raw).split(/\r?\n/)
  const keyPattern = new RegExp('^(\\s*)("|\')?' + escapeRegExp(providerKey) + '\\2\\s*:\\s*(#.*)?$')
  let start = -1
  let indent = ''
  for (let i = 0; i < lines.length; i += 1) {
    const match = keyPattern.exec(lines[i])
    if (match) { start = i; indent = match[1]; break }
  }
  if (start < 0) return null

  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.trim()) continue
    const lead = line.match(/^\s*/)[0].length
    if (lead <= indent.length) { end = i; break }
  }

  const propertyIndent = indent + '  '
  // A provider imported without an endpoint also lacks "api"; pi-ai needs both, so the
  // same surgical write may have to add it. Existing api values are never touched.
  const api = typeof options.api === 'string' && options.api ? options.api : null
  if (api) {
    const apiPattern = /^(\s*)api:\s*(.*)$/
    let hasApi = false
    for (let i = start + 1; i < end; i += 1) {
      if (apiPattern.test(lines[i])) { hasApi = true; break }
    }
    if (!hasApi) {
      lines.splice(start + 1, 0, propertyIndent + 'api: ' + api)
      end += 1
    }
  }

  const basePattern = /^(\s*)baseURL:(\s*)(.*)$/
  for (let i = start + 1; i < end; i += 1) {
    const match = basePattern.exec(lines[i])
    if (!match) continue
    const remainder = match[3]
    // Keep an inline YAML anchor (`baseURL: &gemini https://…`) and any trailing
    // comment: dropping either changes meaning elsewhere in the file.
    const anchor = /^\s*(&\S+)/.exec(remainder)
    const comment = /\s+#.*$/.exec(remainder)
    lines[i] = match[1] + 'baseURL:' + (match[2] || ' ') + (anchor ? anchor[1] + ' ' : '') + value + (comment ? ' ' + comment[0].trim() : '')
    return lines.join(eol)
  }
  // No baseURL yet: insert as a property of that provider block.
  lines.splice(start + 1, 0, propertyIndent + 'baseURL: ' + value)
  return lines.join(eol)
}

function cloneDoc(doc) {
  return JSON.parse(JSON.stringify(doc))
}

/** True when the two documents differ only in that one provider's baseURL. */
function sameExceptBaseURL(before, after, providerKey, insertedApi = null) {
  const left = cloneDoc(before)
  const right = cloneDoc(after)
  const strip = (doc) => {
    const found = findProvider(doc, providerKey)
    if (!found) return
    delete found.provider.baseURL
    // Only fields this write may have added are exempt; anything else must be unchanged.
    if (insertedApi) delete found.provider.api
  }
  strip(left)
  strip(right)
  return JSON.stringify(left) === JSON.stringify(right)
}

export function planApply({ profileDir, itemId, listenPort, target, proxy, tls = null, tuning = {}, origin = null, origins = {}, providerDefaults = {} }) {
  const id = String(itemId || '')
  if (!/^llm:./.test(id)) {
    throw httpError(400, 'not_patchable', 'only llm:<provider> items can be rewritten, got: ' + id)
  }
  if (!target || !/^[A-Za-z0-9._-]+:\d{1,5}$/.test(String(target))) {
    throw httpError(400, 'invalid_target', 'target must be host:port, got: ' + target)
  }
  const { file, doc } = readPatchDocument(profileDir)
  const providerKey = id.slice('llm:'.length)
  const found = findProvider(doc, providerKey)
  if (!found) throw httpError(400, 'provider_not_found', 'provider not found in cordis.patch.yml: ' + providerKey)
  const before = typeof found.provider.baseURL === 'string' && found.provider.baseURL ? found.provider.baseURL : null
  const declaredApi = typeof found.provider.api === 'string' && found.provider.api ? found.provider.api : null

  // An explicit origin is how a row whose real endpoint was lost gets rebuilt: the user
  // types the public URL, we derive the loopback URL from its path and record the origin
  // so a later rollback can put the provider back where it came from.
  let originBaseURL = null
  if (origin !== null && origin !== undefined && origin !== '') {
    const value = String(origin)
    let parsed = null
    try {
      parsed = new URL(value)
    } catch {
      throw httpError(400, 'invalid_origin', 'origin must be an absolute URL, got: ' + value)
    }
    if (!/^https?:$/.test(parsed.protocol)) throw httpError(400, 'invalid_origin', 'origin must be http(s), got: ' + value)
    originBaseURL = value
  }

  // 0.13.0: a provider imported through the app stores only models + apiKeyEnv. Its
  // endpoint lives in the host catalog (or config.providerDefaults), so resolve that
  // before deciding there is nothing to rewrite.
  const resolved = before || originBaseURL
    ? null
    : resolveProviderEndpoint(providerKey, { providerDefaults, api: declaredApi })
  const seed = originBaseURL ?? before ?? resolved?.baseURL ?? null
  if (!seed) {
    throw httpError(
      400,
      'no_base_url',
      'provider has no baseURL and no known endpoint for ' + providerKey + '; pass origin=<public URL>',
    )
  }

  const existing = normalizeRoutes(readRoutes()).find((route) => route.id === id) ?? null
  if (!originBaseURL) {
    originBaseURL = isLoopbackURL(seed) ? existing?.originBaseURL ?? lastRealBaseURL(providerKey, origins, providerDefaults) ?? null : seed
  }
  const after = rewriteBaseURL(seed, listenPort)
  const route = { ...(existing ?? {}), id, target: String(target), listenPort: Number(listenPort), enabled: true }
  if (originBaseURL) route.originBaseURL = originBaseURL
  // undefined keeps the stored proxy (re-apply must not downgrade to direct);
  // an explicit null or "" clears it, which is what the row's proxy picker sends.
  if (proxy !== undefined) route.proxy = proxy === null || proxy === '' ? null : proxy
  if (tls !== undefined && tls !== null) route.tls = tls
  // Per-route pool/connect tuning (0.3.0): absent keys keep whatever the route had.
  for (const key of ['maxSockets', 'timeoutMs', 'connectTimeoutMs']) {
    if (tuning[key] !== undefined && tuning[key] !== null) route[key] = Number(tuning[key])
  }
  // 0.13.1: writing the catalog's protocol name broke llm-pi-ai outright — its schema
  // accepts only CORE_APIS, and a catalog-backed provider must leave `api` absent so the
  // host reuses the catalog implementation. So: only add an api for a provider the host
  // catalog does NOT serve, and only a name the schema actually accepts.
  const requestedApi = (() => {
    const value = providerDefaults?.[providerKey]?.api
    return typeof value === 'string' && value ? value : null
  })()
  if (requestedApi && !isCoreApi(requestedApi)) {
    throw httpError(
      400,
      'unsupported_api',
      'providerDefaults.' + providerKey + '.api must be one of openai-completions | openai-responses | anthropic-messages, got: ' + requestedApi,
    )
  }
  const warnings = []
  let insertApi = null
  if (!declaredApi) {
    const candidate = requestedApi ?? resolved?.api ?? null
    if (resolved?.reuseCatalog) {
      if (requestedApi) {
        warnings.push('providerDefaults.' + providerKey + '.api is ignored: the host catalog already implements this provider')
      }
    } else if (candidate && isCoreApi(candidate)) {
      insertApi = candidate
    } else if (candidate) {
      warnings.push('api "' + candidate + '" is not one of the three protocols llm-pi-ai accepts, so it is not written')
    }
  }
  return {
    file,
    providerKey,
    before,
    after,
    insertApi,
    warnings,
    route,
    diff: [
      { path: 'llm-pi-ai.providers.' + providerKey + '.baseURL', before, after },
      ...(insertApi ? [{ path: 'llm-pi-ai.providers.' + providerKey + '.api', before: null, after: insertApi }] : []),
      ...(originBaseURL && originBaseURL !== before ? [{ path: 'egress-router.originBaseURL', before: null, after: originBaseURL }] : []),
      { path: 'egress-router.routes', before: existing, after: route },
    ],
  }
}

/**
 * Remove one `key: value` line from a provider block, leaving every other byte intact.
 * Returns null when the provider block or the property is not found.
 */
export function removeProviderProperty(raw, providerKey, property) {
  const eol = String(raw).includes('\r\n') ? '\r\n' : '\n'
  const lines = String(raw).split(/\r?\n/)
  const keyPattern = new RegExp('^(\\s*)("|\')?' + escapeRegExp(providerKey) + '\\2\\s*:\\s*(#.*)?$')
  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (keyPattern.test(lines[i])) { start = i; break }
  }
  if (start < 0) return null
  const indent = lines[start].match(/^\s*/)[0].length
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue
    if (lines[i].match(/^\s*/)[0].length <= indent) { end = i; break }
  }
  const propPattern = new RegExp('^(\\s*)' + escapeRegExp(property) + '\\s*:')
  for (let i = start + 1; i < end; i += 1) {
    if (propPattern.test(lines[i])) {
      lines.splice(i, 1)
      return lines.join(eol)
    }
  }
  return null
}

/**
 * 0.13.1 repair: 0.13.0 could write a catalog protocol name (e.g. `google-generative-ai`)
 * into a provider block, and one such value makes llm-pi-ai reject its entire config entry:
 * every provider disappears and the settings form stops working. Remove only values the
 * host can serve without them — a provider the catalog knows falls back to catalog reuse
 * once `api` is gone; an unknown provider is left untouched, because deleting its api would
 * trade a schema error for a runtime one.
 */
export function repairInvalidApis({ profileDir, dirs = null } = {}) {
  const { file, raw, doc } = readPatchDocument(profileDir)
  const candidates = []
  for (const entry of doc) {
    if (!entry || typeof entry !== 'object') continue
    if (entry.id !== 'llm-pi-ai' && !String(entry.name || '').includes('llm-pi-ai')) continue
    const providers = entry.config?.providers
    if (!providers || typeof providers !== 'object') continue
    for (const [key, provider] of Object.entries(providers)) {
      const api = provider && typeof provider.api === 'string' ? provider.api : null
      if (api && !isCoreApi(api)) candidates.push({ key, api })
    }
  }
  const removed = []
  const kept = []
  let next = raw
  for (const item of candidates) {
    if (!hasCatalogProvider(item.key, { dirs })) { kept.push(item); continue }
    const written = removeProviderProperty(next, item.key, 'api')
    if (written === null) { kept.push(item); continue }
    next = written
    removed.push(item)
  }
  if (!removed.length) return { file, backup: null, removed, kept }
  const backup = backupOf(file)
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, next, 'utf8')
  fs.renameSync(tmp, file)
  return { file, backup, removed, kept }
}

function backupOf(file) {
  const dir = path.join(stateDir(), 'backups')
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = path.join(dir, path.basename(file) + '.' + stamp + '.' + process.pid + '.bak')
  fs.copyFileSync(file, target)
  return target
}

/** Keep the ledger and the backup directory in step (R14). */
function pruneBackupFiles(entries) {
  const keep = new Set(entries.map((entry) => entry.backup))
  try {
    for (const name of fs.readdirSync(path.join(stateDir(), 'backups'))) {
      const full = path.join(stateDir(), 'backups', name)
      if (!keep.has(full)) {
        try { fs.unlinkSync(full) } catch (err) { recordError('backup-prune', err, { history: false }) }
      }
    }
  } catch (err) {
    recordError('backup-prune', err, { history: false })
  }
}

export function commitApply({ profileDir, plan }) {
  // Re-read instead of trusting the plan's snapshot: the listener started in between
  // and the user may have edited the file by hand.
  const { file, raw, doc } = readPatchDocument(profileDir)
  const found = findProvider(doc, plan.providerKey)
  if (!found) throw httpError(409, 'stale_plan', 'provider vanished before write: ' + plan.providerKey)
  const current = found.provider.baseURL ?? null
  if (current !== (plan.before ?? null)) {
    throw httpError(409, 'stale_plan', 'baseURL changed since preview (now ' + current + '); scan again')
  }

  const sha256Before = sha256(raw)
  const surgical = setProviderBaseURL(raw, plan.providerKey, plan.after, { api: plan.insertApi ?? null })
  let text
  let format
  if (surgical) {
    text = surgical
    format = 'surgical'
  } else {
    found.provider.baseURL = plan.after
    if (plan.insertApi && !found.provider.api) found.provider.api = plan.insertApi
    text = leadingComments(raw) + yaml.dump(doc, { lineWidth: 120, noRefs: true })
    format = 'rewritten'
  }

  // Validate before touching the real file: parse it back and prove nothing else moved.
  let parsed
  try {
    parsed = yaml.load(text)
  } catch (err) {
    throw httpError(500, 'write_failed', 'generated YAML does not parse: ' + err.message)
  }
  const written = Array.isArray(parsed) ? findProvider(parsed, plan.providerKey) : null
  if (!written || written.provider.baseURL !== plan.after) {
    throw httpError(500, 'write_failed', 'written file did not round-trip for ' + plan.providerKey)
  }
  if (plan.insertApi && written.provider.api !== plan.insertApi) {
    throw httpError(500, 'write_failed', 'written file did not record api for ' + plan.providerKey)
  }
  if (format === 'surgical' && !sameExceptBaseURL(doc, parsed, plan.providerKey, plan.insertApi ?? null)) {
    throw httpError(500, 'write_failed', 'surgical edit changed more than baseURL; refusing to write')
  }

  const backup = backupOf(file)
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, text)
  try {
    fs.renameSync(tmp, file)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch (cleanupErr) { recordError('tmp-cleanup', cleanupErr, { history: false }) }
    fs.copyFileSync(backup, file)
    throw httpError(500, 'write_failed', err?.message ?? String(err))
  }

  const sha256After = sha256(text)
  const at = new Date().toISOString()
  updateState((state) => {
    const backups = [
      ...(state.backups ?? []),
      {
        at,
        file,
        backup,
        routeId: plan.route.id,
        providerKey: plan.providerKey,
        before: plan.before ?? null,
        after: plan.after,
        insertApi: plan.insertApi ?? null,
        listenPort: plan.route.listenPort,
        target: plan.route.target,
        originBaseURL: plan.route.originBaseURL ?? (isLoopbackURL(plan.before) ? null : plan.before),
        sha256Before,
        sha256After,
        format,
      },
    ].slice(-MAX_BACKUPS)
    pruneBackupFiles(backups)
    return {
      ...state,
      backups,
      history: [...(state.history ?? []), {
        at,
        op: 'apply',
        routeId: plan.route.id,
        ok: true,
        detail: plan.before + ' -> ' + plan.after + ' on :' + plan.route.listenPort + ' (' + format + ')',
      }].slice(-MAX_HISTORY),
    }
  })
  return { file, backup, before: plan.before, after: plan.after, route: plan.route, format, sha256Before, sha256After }
}

/** The most recent real baseURL any ledger entry remembers for this provider. */
function lastRealBaseURL(providerKey, origins = {}, providerDefaults = {}) {
  const state = readState()
  const candidates = [...(state.backups ?? [])].reverse()
    .filter((entry) => entry.providerKey === providerKey)
    .flatMap((entry) => [entry.originBaseURL, entry.before, entry.after])
  const known = candidates.find((value) => value && !isLoopbackURL(value))
  if (known) return known
  // 0.11.0: an operator-declared endpoint beats the built-in guess when the ledger is empty.
  const declared = origins?.[providerKey]
  if (declared && !isLoopbackURL(declared)) return declared
  // 0.13.0: the catalog is a better answer than nothing when the ledger is empty.
  return resolveProviderEndpoint(providerKey, { providerDefaults })?.baseURL ?? null
}

/**
 * Undo the last write, optionally scoped to one route id.
 * The file is only replaced when it still holds what this plugin wrote; otherwise the
 * caller gets 409 and must pass force (R3).
 */
export function rollbackLast({ routeId = null, force = false, origins = {} } = {}) {
  const state = readState()
  const backups = [...(state.backups ?? [])]
  let index = backups.length - 1
  if (routeId) {
    index = backups.map((entry) => entry.routeId).lastIndexOf(routeId)
    if (index < 0) throw httpError(400, 'no_backup', 'no backup for ' + routeId)
  }
  const last = backups[index]
  if (!last) throw httpError(400, 'no_backup', 'nothing to roll back')

  if (!force) {
    if (!last.sha256After) {
      throw httpError(409, 'file_changed_since_backup', 'backup has no digest (written by an older version); pass force to roll back anyway')
    }
    const current = sha256(fs.readFileSync(last.file, 'utf8'))
    if (current !== last.sha256After) {
      throw httpError(409, 'file_changed_since_backup', 'cordis.patch.yml changed after this apply; pass force to overwrite those edits')
    }
  }

  fs.copyFileSync(last.backup, last.file)
  // Undo must not leave the provider dialling a listener we just removed: if the restored
  // file still points at our loopback relay and we know the real endpoint, put it back.
  let restoredTo = last.before
  let originRestored = false
  try {
    if (isLoopbackURL(last.before)) {
      const origin = last.originBaseURL && !isLoopbackURL(last.originBaseURL) ? last.originBaseURL : null
      const known = origin ?? lastRealBaseURL(last.providerKey, origins)
      if (known) {
        const raw = fs.readFileSync(last.file, 'utf8')
        const patched = setProviderBaseURL(raw, last.providerKey, known)
        const parsed = yaml.load(patched)
        const check = findProvider(parsed, last.providerKey)
        if (check?.provider?.baseURL === known) {
          fs.writeFileSync(last.file, patched)
          restoredTo = known
          originRestored = true
        }
      }
    }
  } catch (err) {
    recordError('rollback-origin-restore', err, { history: false })
  }
  backups.splice(index, 1)
  updateState((next) => ({
    ...next,
    backups,
    history: [...(next.history ?? []), {
      at: new Date().toISOString(),
      op: 'rollback',
      routeId: last.routeId ?? null,
      ok: true,
      detail: 'restored ' + restoredTo + (originRestored ? ' (back to the real endpoint)' : '') + (force ? ' (forced)' : ''),
    }].slice(-MAX_HISTORY),
  }))
  return {
    file: last.file,
    restored: restoredTo,
    originRestored,
    removed: last.after,
    routeId: last.routeId ?? null,
    listenPort: last.listenPort ?? null,
    forced: Boolean(force),
  }
}
