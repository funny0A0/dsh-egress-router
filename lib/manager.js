// Owns the loopback listeners: one per enabled route, all bound to 127.0.0.1.
import { createRelayServer } from './relay.js'
import { isPortFree } from './ports.js'

export class RelayManager {
  constructor({ config, log = () => {} }) {
    this.config = config
    this.log = log
    this.servers = new Map()
    this.statuses = new Map()
  }

  /** True when this very route already owns that port, so re-apply stays idempotent. */
  owns(id, port) {
    if (!this.servers.has(id)) return false
    const status = this.statuses.get(id)
    return Boolean(status && status.ok && Number(status.port) === Number(port))
  }

  proxyUrlFor(name) {
    if (!name) return null
    const entry = this.config?.proxies?.[name]
    const url = typeof entry === 'string' ? entry : entry?.url
    return url ?? null
  }

  /** Proxy to use when a row does not name one: explicit default, else the first entry. */
  defaultProxyName() {
    const proxies = this.config?.proxies ?? {}
    if (this.config?.defaultProxy && proxies[this.config.defaultProxy]) return this.config.defaultProxy
    const [first] = Object.keys(proxies)
    return first ?? null
  }

  /**
   * Refuse a route whose proxy name is not defined: silently falling back to a direct
   * connection would defeat the whole point of the route (R10).
   */
  resolveProxy(name) {
    if (!name) return null
    const url = this.proxyUrlFor(name)
    if (!url) {
      const err = new Error('proxy "' + name + '" is not defined under config.proxies')
      err.code = 'unknown_proxy'
      throw err
    }
    return url
  }

  /**
   * Pool/connect tuning: config.relay supplies defaults, a route may override them.
   * Bounded so a typo cannot exhaust sockets or leave requests hanging forever.
   */
  tuning(route = {}) {
    const defaults = this.config?.relay ?? {}
    const pick = (value, fallback, min, max) => {
      const number = Number(value)
      if (!Number.isFinite(number)) return fallback
      return Math.min(max, Math.max(min, Math.round(number)))
    }
    return {
      maxSockets: pick(route.maxSockets ?? defaults.maxSockets, 6, 1, 64),
      timeoutMs: pick(route.timeoutMs ?? defaults.timeoutMs, 90000, 1000, 600000),
      connectTimeoutMs: pick(route.connectTimeoutMs ?? defaults.connectTimeoutMs, 15000, 1000, 120000),
    }
  }

  /** Per-route counters plus latency percentiles, for the settings page. */
  metrics() {
    const out = {}
    for (const [id, server] of this.servers) {
      const stats = server.stats
      if (!stats) continue
      const sorted = [...stats.ttfb].sort((a, b) => a - b)
      const at = (ratio) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] * 10) / 10 : null)
      out[id] = {
        requests: stats.requests,
        bytesIn: stats.bytesIn,
        bytesOut: stats.bytesOut,
        errors: stats.errors,
        statuses: stats.statuses,
        startedAt: new Date(stats.startedAt).toISOString(),
        lastAt: stats.lastAt,
        ttfbP50: at(0.5),
        ttfbP95: at(0.95),
        samples: sorted.length,
      }
    }
    return out
  }

  async start(route) {
    if (!route?.target) throw new Error('route has no target: ' + (route?.id ?? '?'))
    if (this.servers.has(route.id)) return this.statuses.get(route.id)
    const host = this.config?.listenHost || '127.0.0.1'
    const port = Number(route.listenPort)
    if (!port) throw new Error('route has no listenPort: ' + route.id)
    if (!(await isPortFree(port, host))) throw new Error('port ' + port + ' is already in use')
    const proxyUrl = this.resolveProxy(route.proxy)
    const server = createRelayServer({
      target: route.target,
      proxyUrl,
      tls: route.tls,
      insecure: route.insecure,
      ...this.tuning(route),
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => { server.removeListener('error', reject); resolve() })
    })
    this.servers.set(route.id, server)
    const status = {
      id: route.id, host, port, target: route.target, proxy: proxyUrl, ok: true, error: null,
      tuning: this.tuning(route),
    }
    this.statuses.set(route.id, status)
    this.log('[relay] ' + route.id + ' -> ' + route.target + ' on ' + host + ':' + port + (proxyUrl ? ' via ' + proxyUrl : ' (direct)'))
    return status
  }

  async stop(id) {
    const server = this.servers.get(id)
    // Clear the status even when nothing is running: a failed start must not leave a
    // ghost "down" row behind after rollback (R5).
    this.statuses.delete(id)
    if (!server) return false
    await new Promise((resolve) => server.close(() => resolve()))
    this.servers.delete(id)
    return true
  }

  async sync(routes) {
    const desired = new Map((routes ?? []).filter((route) => route?.enabled !== false && route?.target).map((route) => [route.id, route]))
    // Include failed ids: a route whose start threw only lives in statuses, and a
    // ghost "down" row must disappear once the route is gone (R5).
    for (const id of new Set([...this.servers.keys(), ...this.statuses.keys()])) {
      if (!desired.has(id)) await this.stop(id)
    }
    const results = []
    for (const [id, route] of desired) {
      if (this.servers.has(id)) {
        const running = this.statuses.get(id)
        const tuning = this.tuning(route)
        const sameTuning = running?.tuning && JSON.stringify(running.tuning) === JSON.stringify(tuning)
        if (running && running.port === Number(route.listenPort) && running.proxy === this.proxyUrlFor(route.proxy) && sameTuning) {
          results.push(running)
          continue
        }
        await this.stop(id)
      }
      try {
        results.push(await this.start(route))
      } catch (err) {
        const failed = { id, port: Number(route.listenPort), target: route.target, ok: false, error: err?.message ?? String(err) }
        this.statuses.set(id, failed)
        results.push(failed)
        this.log('[relay] ' + id + ' failed: ' + failed.error)
      }
    }
    return results
  }

  snapshot() {
    return [...this.statuses.values()]
  }

  async dispose() {
    for (const id of [...this.servers.keys()]) await this.stop(id)
  }
}
