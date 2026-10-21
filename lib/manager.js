// Owns the loopback listeners: one per enabled route, all bound to 127.0.0.1.
import { createRelayServer } from './relay.js'
import { isPortFree } from './ports.js'

export class RelayManager {
  constructor({ config, log = () => {}, onEvent = () => {} }) {
    this.config = config
    this.log = log
    this.onEvent = onEvent
    this.servers = new Map()
    this.statuses = new Map()
    // Kept so a listener that dies can be rebuilt without another round-trip through state.
    this.routes = new Map()
    this.recovery = new Map()
    // Ids whose close was requested by us: that must not look like a crash to the watchdog.
    this.intentional = new Set()
    const relay = config?.relay ?? {}
    this.recoveryBaseMs = Number(relay.recoveryBaseMs) > 0 ? Number(relay.recoveryBaseMs) : 1000
    this.maxRecoveries = Number(relay.maxRecoveries) > 0 ? Number(relay.maxRecoveries) : 3
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
    this.routes.set(route.id, { ...route })
    const status = {
      id: route.id, host, port, target: route.target, proxy: proxyUrl, ok: true, error: null,
      tuning: this.tuning(route),
    }
    this.statuses.set(route.id, status)
    this.watch(route.id, server)
    this.log('[relay] ' + route.id + ' -> ' + route.target + ' on ' + host + ':' + port + (proxyUrl ? ' via ' + proxyUrl : ' (direct)'))
    return status
  }

  /**
   * A listener is the one part of a route that can stop working with nobody asking: the OS
   * reclaims the port, the server emits an error, something closes it. Nothing used to notice,
   * so the status kept saying ok while nothing was listening (R1, 0.8.0). Watch the server and
   * rebuild it with exponential backoff, bounded so a permanently broken route stops trying.
   */
  watch(id, server) {
    const onFailure = (err) => {
      if (this.intentional.has(id)) return
      if (this.servers.get(id) !== server) return
      this.servers.delete(id)
      const previous = this.statuses.get(id) ?? {}
      this.statuses.set(id, { ...previous, ok: false, error: err?.message ?? 'listener closed unexpectedly' })
      this.log('[relay] ' + id + ' listener stopped unexpectedly: ' + (err?.message ?? 'closed'))
      this.scheduleRecovery(id)
    }
    server.on('close', () => onFailure(null))
    server.on('error', (err) => onFailure(err))
  }

  scheduleRecovery(id) {
    const route = this.routes.get(id)
    if (!route || this.servers.has(id)) return
    const state = this.recovery.get(id) ?? { attempts: 0, timer: null }
    if (state.attempts >= this.maxRecoveries) {
      if (state.timer) clearTimeout(state.timer)
      this.recovery.delete(id)
      this.log('[relay] ' + id + ' gave up after ' + this.maxRecoveries + ' recovery attempts')
      this.onEvent({ op: 'relay-recover', id, ok: false, detail: 'gave up after ' + this.maxRecoveries + ' attempts' })
      return
    }
    const delay = this.recoveryBaseMs * 2 ** state.attempts
    state.attempts += 1
    if (state.timer) clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      state.timer = null
      if (!this.routes.has(id) || this.servers.has(id)) return
      this.start(route)
        .then(() => {
          state.attempts = 0
          this.log('[relay] ' + id + ' recovered on ' + route.listenPort)
          this.onEvent({ op: 'relay-recover', id, ok: true, detail: 'listener rebuilt on port ' + route.listenPort })
        })
        .catch((err) => {
          this.log('[relay] ' + id + ' recovery failed: ' + (err?.message ?? String(err)))
          this.scheduleRecovery(id)
        })
    }, delay)
    state.timer.unref?.()
    this.recovery.set(id, state)
    this.onEvent({ op: 'relay-down', id, ok: false, detail: 'listener stopped unexpectedly; retry in ' + delay + 'ms' })
  }

  async stop(id) {
    const server = this.servers.get(id)
    // An intentional close must not be mistaken for a crash by the watchdog.
    this.intentional.add(id)
    const pending = this.recovery.get(id)
    if (pending?.timer) clearTimeout(pending.timer)
    this.recovery.delete(id)
    this.routes.delete(id)
    // Clear the status even when nothing is running: a failed start must not leave a
    // ghost "down" row behind after rollback (R5).
    this.statuses.delete(id)
    if (!server) {
      this.intentional.delete(id)
      return false
    }
    await new Promise((resolve) => server.close(() => resolve()))
    this.servers.delete(id)
    this.intentional.delete(id)
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
    for (const [, state] of this.recovery) if (state.timer) clearTimeout(state.timer)
    this.recovery.clear()
    for (const id of [...this.servers.keys()]) await this.stop(id)
  }
}
