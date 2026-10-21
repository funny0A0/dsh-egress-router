// Persistent state for the plugin: routes, listener status, discovery cache, backup ledger.
// Kept out of cordis.patch.yml on purpose (that file is the user's config, and the plugin
// must never insert a second copy of itself into the layer stack).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function stateDir() {
  return path.join(dshHome(), 'storages', 'egress-router')
}

export function statePath() {
  return path.join(stateDir(), 'state.json')
}

const EMPTY = {
  version: 8,
  // v8: the public shape of the state document, so a future host/bridge can tell
  // "new fields" from "renamed fields" without guessing from the version counter.
  schemaVersion: 1,
  // v8: reconcile stand-down windows survive a restart (displayed in the page).
  reconcilePaused: {},
  // v8: which host contract shapes this boot accepted (feature probe, not version guess).
  hostContract: null,
  // v8.1: the runtime facts the contract probe was taken under (platform/node/arch).
  hostEnv: null,
  discoveredAt: null,
  discovered: null,
  warnings: [],
  routes: [],
  listeners: [],
  metrics: {},
  // v6: which compatibility patches this plugin applied (boot repair reads it).
  patches: {},
  // v7: per-bot egress (which proxy a messaging plugin should talk through).
  bots: {},
  backups: [],
  history: [],
  lastError: null,
}

const MAX_HISTORY = 50

/**
 * Schema upgrades. The version field is authoritative: writeState always stamps it,
 * readState migrates forward and persists, so a stale file cannot masquerade as current.
 */
export function migrate(state) {
  const next = { ...state }
  const from = Number(next.version) || 0
  next.routes = Array.isArray(next.routes) ? next.routes : []
  next.listeners = Array.isArray(next.listeners) ? next.listeners : []
  next.history = Array.isArray(next.history) ? next.history : []
  next.warnings = Array.isArray(next.warnings) ? next.warnings : []
  // v5 keeps the last known traffic counters so the page shows something sane right
  // after a restart (live counters belong to the listener and start at zero).
  next.metrics = next.metrics && typeof next.metrics === 'object' && !Array.isArray(next.metrics) ? next.metrics : {}
  next.patches = next.patches && typeof next.patches === 'object' && !Array.isArray(next.patches) ? next.patches : {}
  next.bots = next.bots && typeof next.bots === 'object' && !Array.isArray(next.bots) ? next.bots : {}
  next.reconcilePaused =
    next.reconcilePaused && typeof next.reconcilePaused === 'object' && !Array.isArray(next.reconcilePaused) ? next.reconcilePaused : {}
  next.schemaVersion = 1
  next.hostContract = next.hostContract && typeof next.hostContract === 'object' ? next.hostContract : null
  if (from < 4) {
    // v4 records both file digests so a rollback can refuse to clobber hand edits.
    next.backups = (Array.isArray(next.backups) ? next.backups : []).map((entry) => ({
      sha256Before: null,
      sha256After: null,
      format: 'dump',
      ...entry,
    }))
  } else {
    next.backups = Array.isArray(next.backups) ? next.backups : []
  }
  next.version = EMPTY.version
  return next
}

/** Persist the feature probe result: what this host accepted, and when. */
export function recordContract(contract, env = null) {
  const value = { ...contract, at: new Date().toISOString() }
  const hostEnv = env ? { ...env, at: value.at } : null
  try {
    updateState((state) => ({ ...state, hostContract: value, ...(hostEnv ? { hostEnv } : {}) }))
    recordHistory({ op: 'host-contract', routeId: null, ok: value.ok !== false, detail: JSON.stringify(value) })
  } catch {}
  return value
}

export function readState() {
  let parsed = null
  try {
    parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8'))
  } catch {
    return { ...EMPTY }
  }
  const state = migrate({ ...EMPTY, ...parsed })
  if (Number(parsed?.version) !== EMPTY.version) {
    try { writeState(state) } catch {}
  }
  return state
}

export function writeState(next) {
  const dir = stateDir()
  fs.mkdirSync(dir, { recursive: true })
  const target = statePath()
  const tmp = target + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify({ ...next, version: EMPTY.version }, null, 2))
  fs.renameSync(tmp, target)
}

export function updateState(fn) {
  const next = fn(readState())
  writeState(next)
  return next
}

/** Active routes, the source of truth a restarted host rebuilds its listeners from. */
export function readRoutes() {
  const routes = readState().routes
  return Array.isArray(routes) ? routes.filter((route) => route && route.id && route.target) : []
}

export function writeRoutes(routes) {
  return updateState((state) => ({ ...state, routes: Array.isArray(routes) ? routes : [] }))
}

/** What the manager is actually listening on, so the UI can show reality, not intent. */
export function rememberListeners(status) {
  return updateState((state) => ({ ...state, listeners: Array.isArray(status) ? status : [] }))
}

/**
 * One write for the whole apply/rollback outcome. Routes, listeners and the audit line
 * are a single transaction on disk: a crash cannot leave baseURL pointing at a port that
 * the state does not know about.
 */
export function saveRoutesAndListeners({ routes, listeners, metrics = undefined, history = null, lastError = undefined }) {
  return updateState((state) => {
    const next = {
      ...state,
      routes: Array.isArray(routes) ? routes : [],
      listeners: Array.isArray(listeners) ? listeners : [],
    }
    if (metrics && typeof metrics === 'object') next.metrics = metrics
    if (history) {
      next.history = [...(state.history ?? []), { at: new Date().toISOString(), ...history }].slice(-MAX_HISTORY)
    }
    if (lastError !== undefined) next.lastError = lastError
    return next
  })
}

/** Append one audit line (never throws: state is a convenience, not the source of truth). */
export function recordHistory(entry) {
  try {
    updateState((state) => {
      const history = state.history ?? []
      const last = history[history.length - 1]
      // 0.4.1: a duplicate activation or a retried operation used to append the same
      // line several times in a row (one host boot produced ten "start … (down)" rows).
      // Same op + same outcome within a minute is one event, not many.
      const sameAsLast = last &&
        last.op === entry.op &&
        (last.routeId ?? null) === (entry.routeId ?? null) &&
        (last.detail ?? null) === (entry.detail ?? null) &&
        (last.ok ?? null) === (entry.ok ?? null) &&
        Number.isFinite(Date.parse(last.at)) &&
        Date.now() - Date.parse(last.at) < 60000
      if (sameAsLast) return state
      return {
        ...state,
        history: [...history, { at: new Date().toISOString(), ...entry }].slice(-MAX_HISTORY),
      }
    })
  } catch {}
}

export function rememberDiscovery(payload) {
  try {
    updateState((state) => ({
      ...state,
      discoveredAt: new Date().toISOString(),
      discovered: payload,
      warnings: (payload?.warnings ?? []).filter(Boolean),
    }))
  } catch {}
}

/** Per-bot egress: id -> { proxy, url, updatedAt }. */
export function readBots() {
  const bots = readState().bots
  return bots && typeof bots === 'object' ? bots : {}
}

export function writeBot(id, record) {
  const key = String(id)
  return updateState((state) => {
    const bots = { ...(state.bots ?? {}) }
    if (record) bots[key] = { updatedAt: new Date().toISOString(), ...record }
    else delete bots[key]
    return { ...state, bots }
  })
}

/** The patch ledger: id -> { appliedAt, version, file }. */
export function readPatchLedger() {
  const ledger = readState().patches
  return ledger && typeof ledger === 'object' ? ledger : {}
}

export function writePatchLedger(ledger) {
  return updateState((state) => ({ ...state, patches: ledger && typeof ledger === 'object' ? ledger : {} }))
}
