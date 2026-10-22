// Relay-only routes (0.10.0).
//
// A provider route exists because DSH reads a baseURL: we rewrite it to a loopback port and
// put the real endpoint back on rollback. That mechanism cannot help a target DSH never
// dials through config — a CLI, another plugin, a webhook receiver, a scraper. A relay route
// is the same listener with no provider behind it: the caller points at
// http://127.0.0.1:<port>/ and this plugin forwards, optionally through a proxy.
//
// Validation lives here (not in routes.js) so the rules can be tested without an HTTP round
// trip, and so the state file cannot grow a relay row the rest of the plugin would choke on.
import { isPrivateAddress, isValidPort } from './ports.js'

export const RELAY_PREFIX = 'relay:'
// Names end up in URLs, history lines and support reports: keep them boring.
const NAME = /^[a-z0-9][a-z0-9._-]{0,47}$/i

function fail(status, code, message) {
  const err = new Error(message)
  err.status = status
  err.code = code
  return err
}

export function isRelayId(id) {
  return String(id ?? '').startsWith(RELAY_PREFIX)
}

/** The name part of `relay:<name>`, or null when it is not a legal relay id. */
export function relayName(id) {
  const value = String(id ?? '')
  if (!isRelayId(value)) return null
  const name = value.slice(RELAY_PREFIX.length)
  return NAME.test(name) ? name : null
}

/** Stable id for a target the user did not name: relay:huggingface-co-443. */
export function relayIdFor(target) {
  const slug = String(target || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return RELAY_PREFIX + (slug || 'target')
}

export function routeKind(route) {
  const id = typeof route === 'string' ? route : route?.id
  return isRelayId(id) ? 'relay' : 'provider'
}

/**
 * Validate and normalise one relay route.
 * `existing` keeps tls and tuning the caller did not resend, exactly like planApply does
 * for provider routes: a re-apply must not silently reset the connection pool.
 */
export function buildRelayRoute({ id, target, listenPort, proxy, tls, tuning = {}, existing = null }) {
  const routeId = String(id || '')
  if (!relayName(routeId)) {
    throw fail(400, 'invalid_id', 'relay ids look like relay:<name> using letters, digits, dot, dash or underscore: ' + routeId)
  }
  const value = String(target || '')
  const match = /^([A-Za-z0-9._-]+|\[[0-9a-fA-F:]+\]):(\d{1,5})$/.exec(value)
  if (!match) throw fail(400, 'invalid_target', 'target must be host:port, got: ' + value)
  const port = Number(match[2])
  if (!(port > 0 && port <= 65535)) throw fail(400, 'invalid_target', 'target port out of range: ' + value)
  if (isPrivateAddress(match[1].replace(/^\[|\]$/g, ''))) {
    throw fail(400, 'loopback_target', 'refusing to relay to a private or loopback target: ' + value)
  }
  const listen = Number(listenPort)
  if (!isValidPort(listen)) throw fail(400, 'invalid_port', 'port must be 1024-65535, got: ' + listenPort)
  const route = {
    ...(existing ?? {}),
    id: routeId,
    kind: 'relay',
    target: value,
    listenPort: listen,
    enabled: true,
  }
  // undefined keeps the stored proxy; null or "" clears it (the row sends "" for direct).
  if (proxy !== undefined) route.proxy = proxy === null || proxy === '' ? null : String(proxy)
  if (tls !== undefined && tls !== null) route.tls = Boolean(tls)
  for (const key of ['maxSockets', 'timeoutMs', 'connectTimeoutMs']) {
    if (tuning[key] !== undefined && tuning[key] !== null) route[key] = Number(tuning[key])
  }
  return route
}
