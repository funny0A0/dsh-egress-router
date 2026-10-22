/**
 * State-document schema (v10).
 *
 * The state file is the plugin's only source of truth, and it is edited by older
 * versions of this plugin, by hand, and by crash-truncated writes. A reader that
 * merely spreads `{ ...EMPTY, ...state }` hides malformed rows until a listener
 * fails at runtime, so the HTTP layer validates the document and reports what is
 * wrong instead of pretending everything is fine.
 *
 * Deliberately dependency-free and read-only: validation never repairs. Repairs are
 * the migration's job (`lib/store.js`), and a repair that silently rewrites user data
 * is exactly the failure mode this file exists to surface.
 */

export const STATE_VERSION = 10

/** Top-level keys every state document must carry. */
export const TOP_LEVEL = [
  'backups',
  'discovered',
  'discoveredAt',
  'history',
  'hostContract',
  'hostEnv',
  'lastError',
  'listeners',
  'metrics',
  'metricsTotals',
  'patches',
  'reconcileOffenses',
  'reconcilePaused',
  'routes',
  'schemaVersion',
  'version',
  'warnings',
]

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isInt = (value) => Number.isInteger(value)
const isString = (value) => typeof value === 'string'
const isPort = (value) => isInt(value) && value > 0 && value <= 65535

/** `host:port`, with IPv6 in brackets. Same shape the relay and the discovery agree on. */
export function isTarget(value) {
  if (!isString(value) || value.length === 0 || value.length > 300) return false
  const match = /^(?:\[[0-9a-fA-F:]+\]|[^\s:/]+):(\d{1,5})$/.exec(value)
  if (!match) return false
  const port = Number(match[1])
  return port > 0 && port <= 65535
}

function expect(errors, path, condition, expected, actual) {
  if (condition) return
  if (errors.length >= 50) return
  errors.push({ path, expected, actual: describe(actual) })
}

function describe(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array(' + value.length + ')'
  return typeof value
}

function counters(errors, path, row) {
  expect(errors, path, isObject(row), 'object', row)
  if (!isObject(row)) return
  for (const key of ['requests', 'bytesIn', 'bytesOut', 'errors']) {
    if (row[key] === undefined) continue
    expect(errors, path + '.' + key, Number.isFinite(row[key]) && row[key] >= 0, 'non-negative number', row[key])
  }
}

/**
 * Validate one parsed state document.
 * @returns {{ ok: boolean, version: number, errors: Array<{path: string, expected: string, actual: string}> }}
 */
export function validateState(state) {
  const errors = []
  expect(errors, '$', isObject(state), 'object', state)
  if (!isObject(state)) return { ok: false, version: 0, errors }

  for (const key of TOP_LEVEL) {
    expect(errors, '$.' + key, key in state, 'present', state[key] === undefined ? 'missing' : state[key])
  }

  expect(errors, '$.version', isInt(state.version) && state.version >= 1, 'integer >= 1', state.version)
  expect(errors, '$.schemaVersion', isInt(state.schemaVersion) && state.schemaVersion >= 1, 'integer >= 1', state.schemaVersion)
  expect(errors, '$.warnings', Array.isArray(state.warnings), 'array', state.warnings)

  expect(errors, '$.routes', Array.isArray(state.routes), 'array', state.routes)
  for (const [index, route] of (Array.isArray(state.routes) ? state.routes : []).entries()) {
    const at = '$.routes[' + index + ']'
    expect(errors, at, isObject(route), 'object', route)
    if (!isObject(route)) continue
    expect(errors, at + '.id', isString(route.id) && route.id.length > 0, 'non-empty string', route.id)
    expect(errors, at + '.target', isTarget(route.target), 'host:port', route.target)
    expect(errors, at + '.listenPort', isPort(route.listenPort), 'port 1-65535', route.listenPort)
    expect(errors, at + '.proxy', route.proxy === null || route.proxy === undefined || isString(route.proxy), 'string or null', route.proxy)
    expect(errors, at + '.tls', route.tls === undefined || typeof route.tls === 'boolean', 'boolean or absent', route.tls)
  }

  expect(errors, '$.listeners', Array.isArray(state.listeners), 'array', state.listeners)
  for (const [index, row] of (Array.isArray(state.listeners) ? state.listeners : []).entries()) {
    const at = '$.listeners[' + index + ']'
    expect(errors, at, isObject(row), 'object', row)
    if (!isObject(row)) continue
    expect(errors, at + '.id', isString(row.id) && row.id.length > 0, 'non-empty string', row.id)
    expect(errors, at + '.port', isPort(row.port), 'port 1-65535', row.port)
    expect(errors, at + '.ok', typeof row.ok === 'boolean', 'boolean', row.ok)
  }

  for (const key of ['metrics', 'metricsTotals']) {
    expect(errors, '$.' + key, isObject(state[key]), 'object', state[key])
    if (!isObject(state[key])) continue
    for (const [id, row] of Object.entries(state[key])) counters(errors, '$.' + key + '.' + id, row)
  }

  expect(errors, '$.backups', Array.isArray(state.backups), 'array', state.backups)
  expect(errors, '$.history', Array.isArray(state.history), 'array', state.history)
  for (const [index, row] of (Array.isArray(state.history) ? state.history : []).entries()) {
    const at = '$.history[' + index + ']'
    expect(errors, at, isObject(row), 'object', row)
    if (isObject(row)) expect(errors, at + '.op', isString(row.op) && row.op.length > 0, 'non-empty string', row.op)
  }

  for (const key of ['patches', 'reconcilePaused', 'reconcileOffenses']) {
    expect(errors, '$.' + key, isObject(state[key]), 'object', state[key])
  }

  expect(errors, '$.discovered', state.discovered === null || isObject(state.discovered), 'object or null', state.discovered)
  if (isObject(state.discovered)) {
    expect(errors, '$.discovered.items', Array.isArray(state.discovered.items), 'array', state.discovered.items)
  }
  expect(errors, '$.discoveredAt', state.discoveredAt === null || isString(state.discoveredAt), 'string or null', state.discoveredAt)

  expect(errors, '$.lastError', state.lastError === null || isObject(state.lastError), 'object or null', state.lastError)
  if (isObject(state.lastError)) {
    expect(errors, '$.lastError.scope', isString(state.lastError.scope) && state.lastError.scope.length > 0, 'non-empty string', state.lastError.scope)
    expect(errors, '$.lastError.message', isString(state.lastError.message), 'string', state.lastError.message)
  }

  expect(errors, '$.hostContract', state.hostContract === null || isObject(state.hostContract), 'object or null', state.hostContract)
  expect(errors, '$.hostEnv', state.hostEnv === null || isObject(state.hostEnv), 'object or null', state.hostEnv)

  return { ok: errors.length === 0, version: isInt(state.version) ? state.version : 0, errors }
}
