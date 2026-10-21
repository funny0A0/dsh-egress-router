// Keeping the config file in step with the running listeners.
//
// The DSH host owns cordis.patch.yml and rewrites it from its in-memory config (a settings
// change, a plugin toggle, a restart that saves before loading). It has no idea this plugin
// moved llm-pi-ai.providers.<x>.baseURL to a loopback port, so that write puts the provider
// back on the public host while the listener keeps running on the local port. The model then
// dials a port nothing listens on: the exact failure seen on 2026-10-21 (route :53049, file
// :8792). Reconcile detects that drift and repairs it surgically, never touching anything
// this plugin does not own.
import fs from 'node:fs'
import path from 'node:path'
import { readPatchDocument, findProvider, setProviderBaseURL, sha256 } from './patcher.js'
import { readRoutes, readState, recordHistory, recordError, stateDir, updateState } from './store.js'

const PROVIDER_PREFIX = 'llm:'
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[?::1\]?)$/i

export function providerKeyOf(route) {
  const id = String(route?.id ?? '')
  return id.startsWith(PROVIDER_PREFIX) ? id.slice(PROVIDER_PREFIX.length) : null
}

export function isActive(route) {
  return Boolean(route) && route.enabled !== false && Number.isInteger(Number(route.listenPort))
}

/** The URL that actually reaches this route's listener, keeping the provider's own path. */
export function expectedBaseURL(current, listenPort) {
  const port = Number(listenPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  let suffix = '/'
  try {
    const url = new URL(String(current))
    suffix = url.pathname + url.search
  } catch {
    return null
  }
  return 'http://127.0.0.1:' + port + suffix
}

/** True when this URL already points at the given loopback port (any path). */
export function pointsAt(current, listenPort) {
  try {
    const url = new URL(String(current))
    return url.protocol === 'http:' && LOOPBACK.test(url.hostname) && Number(url.port) === Number(listenPort)
  } catch {
    return false
  }
}

/**
 * Read-only comparison between the config file and the running routes.
 * `drift` entries are repairable; `missing` entries are providers the file no longer has.
 */
export function findDrift({ profileDir, routes = readRoutes() }) {
  const { file, doc } = readPatchDocument(profileDir)
  const drift = []
  const missing = []
  for (const route of routes ?? []) {
    if (!isActive(route)) continue
    const provider = providerKeyOf(route)
    if (!provider) continue
    const found = findProvider(doc, provider)
    const before = found?.provider?.baseURL
    if (typeof before !== 'string' || !before) {
      missing.push({ id: route.id, provider, listenPort: Number(route.listenPort) })
      continue
    }
    if (pointsAt(before, route.listenPort)) continue
    const after = expectedBaseURL(before, route.listenPort)
    if (!after) continue
    drift.push({ id: route.id, provider, listenPort: Number(route.listenPort), before, after })
  }
  return { file, drift, missing }
}

function backupFile(file) {
  const dir = path.join(stateDir(), 'backups')
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = path.join(dir, path.basename(file) + '.' + stamp + '.' + process.pid + '.reconcile.bak')
  fs.copyFileSync(file, target)
  return target
}

// A route the user removed must never be enforced again, so the watcher re-reads the live
// route list instead of the snapshot taken at boot. And when something else keeps rewriting
// the same provider (the host's own loopback relay does exactly that), repairing in a tight
// loop is a tug of war.
//
// 0.8.0: a fixed "three repairs inside one minute" counter was easy to dodge — touching the
// file every 61 seconds never paused. The window now slides over ten minutes and repeated
// offences escalate: first stand-down 10 minutes, then 30, then an hour.
const REPAIR_WINDOW_MS = 10 * 60_000
const REPAIR_LIMIT = 3
const PAUSE_STEPS_MS = [10 * 60_000, 30 * 60_000, 60 * 60_000]
const repairLog = new Map()
const pausedUntil = new Map()
const offenses = new Map()
let pausedLoaded = false

// A pause that disappears on restart lets the tug of war start over silently, so the windows
// and the offence counts are persisted and reloaded lazily (tests reset the cache through
// resetThrottle).
function loadPaused() {
  if (pausedLoaded) return
  pausedLoaded = true
  const state = readState()
  for (const [provider, iso] of Object.entries(state.reconcilePaused ?? {})) {
    const at = Date.parse(iso)
    if (Number.isFinite(at)) pausedUntil.set(provider, at)
  }
  for (const [provider, count] of Object.entries(state.reconcileOffenses ?? {})) {
    const n = Number(count)
    if (Number.isFinite(n) && n > 0) offenses.set(provider, n)
  }
}

function persistPaused() {
  const now = Date.now()
  const saved = {}
  for (const [provider, until] of pausedUntil) if (until > now) saved[provider] = new Date(until).toISOString()
  const counts = {}
  for (const [provider, count] of offenses) if (count > 0) counts[provider] = count
  try {
    updateState((state) => ({ ...state, reconcilePaused: saved, reconcileOffenses: counts }))
  } catch (err) {
    recordError('reconcile-pause', err, { history: false })
  }
}

/** The providers currently standing down, for the state payload and the page. */
export function pausedProviders(now = Date.now()) {
  loadPaused()
  return [...pausedUntil]
    .filter(([, until]) => until > now)
    .map(([provider, until]) => ({ provider, until: new Date(until).toISOString(), offenses: offenses.get(provider) ?? 0 }))
}

function isPaused(provider, now) {
  loadPaused()
  const until = pausedUntil.get(provider)
  return Number.isFinite(until) && now < until
}

/**
 * Sliding-window repair counter: REPAIR_LIMIT repairs inside REPAIR_WINDOW_MS stand the
 * provider down, and each further offence lengthens the pause. Exported as a test hook so the
 * window can be driven without waiting real minutes.
 */
export function noteRepairs(providers, now = Date.now()) {
  loadPaused()
  const paused = []
  for (const provider of providers) {
    if (isPaused(provider, now)) continue
    const hits = (repairLog.get(provider) ?? []).filter((at) => now - at < REPAIR_WINDOW_MS)
    hits.push(now)
    repairLog.set(provider, hits)
    if (hits.length < REPAIR_LIMIT) continue
    const count = (offenses.get(provider) ?? 0) + 1
    offenses.set(provider, count)
    const pauseMs = PAUSE_STEPS_MS[Math.min(count, PAUSE_STEPS_MS.length) - 1]
    pausedUntil.set(provider, now + pauseMs)
    paused.push({ provider, minutes: Math.round(pauseMs / 60000), offenses: count })
  }
  if (paused.length) persistPaused()
  return paused
}

/** Test hook: forget repair history, offences and pauses. */
export function resetThrottle() {
  repairLog.clear()
  pausedUntil.clear()
  offenses.clear()
  pausedLoaded = true
  persistPaused()
}

/**
 * Repair every drifted provider in one write: backup, surgical rewrite per provider,
 * re-parse, then a targeted check that each rewritten URL landed where we expect.
 */
export function repairDrift({ profileDir, routes = readRoutes(), reason = 'drift' } = {}) {
  const found = findDrift({ profileDir, routes })
  const now = Date.now()
  const blocked = found.drift.filter((item) => isPaused(item.provider, now)).map((item) => item.provider)
  const drift = found.drift.filter((item) => !isPaused(item.provider, now))
  if (!drift.length) return { file: found.file, repaired: [], missing: found.missing, paused: blocked }

  const raw = fs.readFileSync(found.file, 'utf8')
  let next = raw
  const repaired = []
  for (const item of drift) {
    const written = setProviderBaseURL(next, item.provider, item.after)
    if (!written) continue
    next = written
    repaired.push(item)
  }
  if (!next || next === raw) return { file: found.file, repaired: [], missing: found.missing, paused: blocked }

  const backup = backupFile(found.file)
  const tmp = found.file + '.' + process.pid + '.reconcile.tmp'
  fs.writeFileSync(tmp, next)
  fs.renameSync(tmp, found.file)

  // Verify what we just wrote, not what we intended to write.
  const after = readPatchDocument(profileDir)
  for (const item of repaired) {
    const value = findProvider(after.doc, item.provider)?.provider?.baseURL
    if (!pointsAt(value, item.listenPort)) {
      fs.copyFileSync(backup, found.file)
      throw new Error('reconcile could not verify ' + item.provider + '.baseURL; restored the backup')
    }
  }

  recordHistory({
    op: 'reconcile',
    routeId: null,
    ok: true,
    detail: repaired.map((item) => item.provider + ': ' + item.before + ' -> ' + item.after).join('; ') + ' (' + reason + ')',
  })
  const paused = noteRepairs(repaired.map((item) => item.provider), Date.now())
  if (paused.length) {
    recordHistory({
      op: 'reconcile-paused',
      routeId: null,
      ok: false,
      detail:
        paused.map((item) => item.provider + ' (' + item.minutes + 'm, offence ' + item.offenses + ')').join(', ') +
        ': something else keeps rewriting this value; standing down',
    })
  }
  return { file: found.file, repaired, missing: found.missing, backup, paused, sha: sha256(fs.readFileSync(found.file, 'utf8')) }
}

/**
 * Watch the profile's patch file: the host rewrites it without asking us, so repair the
 * drift as soon as it appears. Our own writes are ignored through a short cooldown.
 */
export function startPatchWatcher({ profileDir, getRoutes = readRoutes, log = () => {}, debounceMs = 800 }) {
  const file = path.join(profileDir, 'cordis.patch.yml')
  let timer = null
  let mutedUntil = 0
  let closed = false

  const repairQuietly = (reason) => {
    if (closed || Date.now() < mutedUntil) return
    try {
      const routes = typeof getRoutes === 'function' ? getRoutes() : getRoutes
      const result = repairDrift({ profileDir, routes, reason })
      if (result.repaired.length) {
        mutedUntil = Date.now() + 1500
        log('[egress] reconciled ' + result.repaired.map((item) => item.provider).join(', '))
      }
    } catch (err) {
      log('[egress] reconcile failed: ' + (err?.message ?? String(err)))
    }
  }

  let watcher = null
  try {
    watcher = fs.watch(path.dirname(file), (event, name) => {
      if (closed) return
      if (name && name !== path.basename(file)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => repairQuietly('file changed'), debounceMs)
    })
    watcher.on('error', () => {})
  } catch (err) {
    log('[egress] patch watcher unavailable: ' + (err?.message ?? String(err)))
  }

  return () => {
    closed = true
    if (timer) clearTimeout(timer)
    try { watcher?.close() } catch (err) { recordError('watcher-close', err, { history: false }) }
  }
}
