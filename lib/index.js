// Plugin entry: rebuild listeners from persisted routes, mount the API, expose the settings tab.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RelayManager } from './manager.js'
import { normalizeRoutes } from './patcher.js'
import { loadDefinitions, repairAll } from './patches.js'
import { cleanupManagedEnv, restoreBots } from './bots.js'
import { verifyApply } from './probe.js'
import { repairDrift, startPatchWatcher } from './reconcile.js'
import { makeHandler } from './routes.js'
import { readRoutes, readBots, writeRoutes, rememberListeners, recordHistory, recordError, stateDir, readPatchLedger, writePatchLedger, updateState, recordContract, mergeMetricsTotals, diffMetrics } from './store.js'

const here = path.dirname(fileURLToPath(import.meta.url))
// One active instance per process: the profile may name the plugin twice, and two
// owners of the same loopback ports is always a bug (0.4.1).
const INSTANCE_KEY = Symbol.for('dsh-egress-router.active-instance')

export const name = 'dsh-egress-router'

// A profile root is recognised by `dsh.profile` in its package.json, NOT by the presence of
// cordis.patch.yml: plugins ship their own bundle patch under the same name, so treating that
// file as the marker made the walk stop at `node_modules/dsh-egress-router` and every
// profile-relative read (discovery, patch inspection) silently looked at the wrong directory
// (0.7.3).
function looksLikeProfile(dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    return Boolean(manifest?.dsh?.profile)
  } catch (err) {
    // Every non-profile directory on the way up has no package.json (ENOENT); anything else
    // means the probe itself failed and should not vanish (0.8.0).
    if (err?.code !== 'ENOENT') recordError('profile-probe', err, { history: false })
  }
  return false
}

// Installed layouts differ: hoisted node_modules on Windows and Linux, or pnpm's
// node_modules/.pnpm/<pkg>@<version>/node_modules/<pkg> tree. Counting ".." only works for
// the first, so walk up until a directory is recognisable as the profile root.
export function findProfileRoot(start, maxDepth = 12) {
  let dir = path.resolve(start)
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (looksLikeProfile(dir)) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

// Second signal, for a profile whose package.json lost `dsh.profile` (older layouts): the
// directory that depends on this package is the profile root.
export function findProfileByDependency(start, maxDepth = 12) {
  let dir = path.resolve(start)
  for (let depth = 0; depth < maxDepth; depth += 1) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
      if (manifest?.dependencies?.['dsh-egress-router']) return dir
    } catch (err) {
      if (err?.code !== 'ENOENT') recordError('profile-probe', err, { history: false })
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

export function resolveProfileDir(config) {
  if (config?.profileDir) return config.profileDir
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR
  return findProfileRoot(here) ?? findProfileByDependency(here) ?? path.resolve(here, '..', '..', '..')
}

function hostEnvInfo() {
  return { platform: process.platform, arch: process.arch, node: process.version }
}

export async function apply(ctx, config = {}) {
  const profileDir = resolveProfileDir(config)
  const log = (line) => {
    try { ctx.logger?.info?.(line) } catch {}
  }
  const manager = new RelayManager({
    config,
    log,
    // Watchdog events belong in the audit trail: a listener that died and came back is
    // exactly the kind of thing that otherwise surfaces only as "the model stopped working".
    onEvent: (event) => {
      recordHistory({ op: event.op, routeId: event.id ?? null, ok: event.ok, detail: event.detail })
    },
  })

  // 0.4.1 taught this plugin to stand down when a second instance activated in the same
  // process. That was wrong for the case that actually happens: the host hot-reloads a
  // plugin when cordis.patch.yml changes (we change it ourselves when reconciling), and the
  // old context is torn down *after* the new one activates. Standing down then left the
  // process with no instance at all — listeners alive, HTTP route gone, settings page
  // showing "接口不可用". Take over instead: shut the previous activation down, then install
  // this one (0.5.2).
  const instanceId = Math.random().toString(36).slice(2)
  const previous = globalThis[INSTANCE_KEY]
  if (previous && previous.id !== instanceId) {
    log('[egress] replacing a previous activation in this process (host reload)')
    try { await previous.dispose?.() } catch (err) {
      log('[egress] previous dispose failed: ' + (err?.message ?? String(err)))
      recordError('hot-reload-dispose', err)
    }
    recordHistory({
      op: 'replace-instance',
      routeId: null,
      ok: true,
      detail: 'previous activation disposed before this one took over',
    })
  }

  // State is the source of truth; config.routes is only the first-run seed, so a
  // profile that still carries routes in cordis.patch.yml migrates on this boot.
  const persisted = normalizeRoutes(readRoutes())
  const seed = normalizeRoutes(config.routes ?? [])
  const routes = persisted.length ? persisted : seed
  if (!persisted.length && seed.length) writeRoutes(seed)

  const status = await manager.sync(routes)
  rememberListeners(status)
  recordHistory({
    op: 'start',
    routeId: null,
    ok: status.every((item) => item.ok !== false),
    detail: status.length ? status.map((item) => item.id + ':' + item.port + (item.ok ? '' : ' (down)')).join(', ') : 'no routes',
  })
  log('[egress] listeners: ' + (status.length ? status.map((item) => item.id + ':' + item.port + (item.ok ? '' : ' (down)')).join(', ') : 'none'))

  // 0.9.0: listener counters start at zero on every boot, so "how much did this route move"
  // was unanswerable. Fold the deltas into the persisted totals once a minute and on the
  // way out; the delta (not the raw counter) is what keeps repeated flushes idempotent.
  let flushed = {}
  const flushMetrics = () => {
    const live = manager.metrics()
    const { delta, baseline } = diffMetrics(flushed, live)
    flushed = baseline
    if (Object.keys(delta).length) {
      try { mergeMetricsTotals(delta) } catch (err) { recordError('metrics-totals', err, { history: false }) }
    }
    return live
  }
  const metricsTimer = setInterval(flushMetrics, 60_000)
  metricsTimer.unref?.()

  // 0.5.1: the host rewrites cordis.patch.yml from its own boot-time snapshot, which drops
  // the loopback baseURL this plugin installed. Left alone, the model keeps dialling the old
  // port while the listener sits on the new one (the 2026-10-21 failure). Repair on boot and
  // keep watching the file for the rest of the session.
  try {
    const reconciled = repairDrift({ profileDir, routes, reason: 'boot' })
    if (reconciled.repaired.length) {
      log('[egress] reconciled on boot: ' + reconciled.repaired.map((item) => item.id).join(', '))
    }
    if (reconciled.missing.length) {
      log('[egress] provider missing from config: ' + reconciled.missing.map((item) => item.provider).join(', '))
    }
  } catch (err) {
    log('[egress] boot reconcile failed: ' + (err?.message ?? String(err)))
    recordError('boot-reconcile', err)
  }
  const stopWatcher = startPatchWatcher({ profileDir, log })

  // 0.4.0: a reinstall silently reverts compatibility patches. Heal only the ones this
  // plugin applied before (the ledger) — never a package the user never opted into.
  try {
    const defs = loadDefinitions()
    const ledger = readPatchLedger()
    const repairs = repairAll(defs, { profileDir, stateDir: stateDir(), ledger })
    const repaired = repairs.filter((item) => item.action === 'repaired')
    if (repaired.length) {
      const next = { ...ledger }
      for (const item of repaired) next[item.id] = { appliedAt: new Date().toISOString(), version: item.version, file: item.file }
      writePatchLedger(next)
      recordHistory({ op: 'patch-repair', routeId: null, ok: true, detail: repaired.map((item) => item.id + '@' + item.version).join(', ') })
      log('[egress] repaired patches: ' + repaired.map((item) => item.id).join(', '))
    }
    const broken = repairs.filter((item) => item.action === 'failed' || item.status === 'anchor_missing' || item.status === 'anchor_ambiguous')
    if (broken.length) log('[egress] patch attention needed: ' + broken.map((item) => item.id + ' (' + item.status + ')').join(', '))
  } catch (err) {
    log('[egress] patch repair failed: ' + (err?.message ?? String(err)))
    recordError('patch-repair', err)
  }

  // 0.5.0: chat bots have no baseURL, so their egress is a managed patch plus one
  // environment variable. Put the configured value back into this process during boot,
  // before the messaging plugins build their HTTP transports.
  //
  // 0.7.2: first strip anything 0.7.0/0.7.1 left in $DSH_HOME/.env. The launcher owns that
  // file's protected names, and a stale DSH_TELEGRAM_PROXY line there stops DSH booting at
  // all, before any plugin (including this one) can run.
  try {
    const cleaned = cleanupManagedEnv({ envVar: 'DSH_TELEGRAM_PROXY' })
    if (cleaned.changed) {
      log('[egress] removed ' + cleaned.removed.length + ' managed line(s) from $DSH_HOME/.env (the launcher rejects them)')
      recordHistory({ op: 'env-cleanup', routeId: null, ok: true, detail: 'removed ' + cleaned.removed.length + ' managed line(s) from .env' })
    }
  } catch (err) {
    log('[egress] .env cleanup failed: ' + (err?.message ?? String(err)))
    recordError('env-cleanup', err)
  }

  try {
    const restored = restoreBots({
      bots: readBots(),
      proxies: config?.proxies ?? {},
      profileDir,
      stateDir: stateDir(),
      log,
    })
    const ok = restored.filter((item) => item.ok)
    if (ok.length) {
      recordHistory({ op: 'bot-restore', routeId: null, ok: true, detail: ok.map((item) => item.id + ':' + item.url).join(', ') })
    }
    const failed = restored.filter((item) => !item.ok)
    if (failed.length) log('[egress] bot restore failed: ' + failed.map((item) => item.id + ' (' + item.error + ')').join(', '))
  } catch (err) {
    log('[egress] bot restore crashed: ' + (err?.message ?? String(err)))
    recordError('bot-restore', err)
  }

  // H4: the host's plugin contract is undocumented and has changed shape before (the
  // settings slot moved once). Probe it instead of assuming: try the documented
  // {kind:'exact'} object, then a plain {path, handler}, then the positional form, and
  // record which one this host accepted. A host that accepts none still loads the plugin
  // (listeners and state keep working) — the page simply reports "API unavailable" instead
  // of dying with an unexplained 404.
  ctx.inject(['webServer'], (hostCtx) => {
    const handler = makeHandler({
      config,
      manager,
      profileDir,
      log,
      stateDir: stateDir(),
      // Set verifyAfterApply: false in cordis.patch.yml to skip the post-apply probe.
      verify: config?.verifyAfterApply === false ? null : verifyApply,
    })
    const shapes = [
      ['exact', () => hostCtx.webServer.register({ kind: 'exact', path: '/plugins/egress-router', handler })],
      ['plain', () => hostCtx.webServer.register({ path: '/plugins/egress-router', handler })],
      ['positional', () => hostCtx.webServer.register('/plugins/egress-router', handler)],
    ]
    let lastError = null
    for (const [shape, attempt] of shapes) {
      try {
        const dispose = attempt()
        recordContract({ webServer: shape, ok: true }, hostEnvInfo())
        if (shape !== 'exact') log('[egress] host accepted the ' + shape + ' registration shape; API served in compatibility mode')
        return () => {
          try { dispose?.() } catch (err) { recordError('webServer-dispose', err, { history: false }) }
        }
      } catch (err) {
        lastError = err
      }
    }
    recordError('webServer-register', lastError ?? new Error('no registration shape accepted'))
    recordContract({ webServer: 'unavailable', ok: false, detail: String(lastError?.message ?? lastError ?? 'no registration shape accepted') }, hostEnvInfo())
    log('[egress] this host accepted none of the known webServer registration shapes; the API is unavailable')
    return () => {}
  })

  // One shutdown path, reachable from the host's dispose event and from a later activation
  // that needs this one out of the way. Idempotent: closing an already closed manager is a
  // no-op.
  let stopping = null
  const shutdown = async () => {
    if (stopping) return stopping
    stopping = (async () => {
      // Stop repairing drift first: the host may still be writing the file while we shut down.
      try { stopWatcher?.() } catch (err) { recordError('watcher-stop', err, { history: false }) }
      try { clearInterval(metricsTimer) } catch {}
      try { flushMetrics() } catch (err) { recordError('metrics-totals', err, { history: false }) }
      // Keep the last counters: live numbers reset with the listener, and the page should
      // not open on zeroes right after a restart (0.4.1 flushes them on the way out).
      try {
        const metrics = manager.metrics()
        if (Object.keys(metrics).length) updateState((state) => ({ ...state, metrics }))
      } catch (err) {
        recordError('metrics-flush', err, { history: false })
      }
      try { await manager.dispose() } catch (err) { recordError('dispose', err) }
      try { rememberListeners([]) } catch (err) { recordError('listener-flush', err, { history: false }) }
      if (globalThis[INSTANCE_KEY]?.id === instanceId) delete globalThis[INSTANCE_KEY]
    })()
    return stopping
  }
  globalThis[INSTANCE_KEY] = { id: instanceId, at: Date.now(), dispose: shutdown }

  ctx.on?.('dispose', shutdown)
}
