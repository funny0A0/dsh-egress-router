// Per-endpoint loopback relay: plain HTTP in, TLS (optionally via a CONNECT proxy) out.
// Kept dependency-free on purpose (node:http/https/net/tls only).
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
])

export function parseTarget(target) {
  if (typeof target !== 'string') throw new Error('target must be a string host:port')
  const idx = target.lastIndexOf(':')
  if (idx <= 0) throw new Error('target must be host:port, got ' + target)
  const host = target.slice(0, idx)
  const port = Number(target.slice(idx + 1))
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('bad target port: ' + target)
  return { host, port }
}

function stripHeaders(headers) {
  const out = {}
  for (const [key, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) out[key] = value
  }
  return out
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

function proxyParts(proxyUrl) {
  const url = proxyUrl instanceof URL ? proxyUrl : new URL(String(proxyUrl))
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  return { host: url.hostname, port }
}

/** CONNECT through the upstream proxy, then optionally wrap the tunnel in TLS. */
export function connectViaProxy(proxyUrl, host, port, options = {}) {
  const { secure = true, insecure = false, timeoutMs = 15000 } = options
  const proxy = proxyParts(proxyUrl)
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: host + ':' + port,
      headers: { host: host + ':' + port },
      timeout: timeoutMs,
      agent: false,
    })
    const fail = (err) => { request.destroy(); reject(err) }
    request.on('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        reject(new Error('proxy CONNECT ' + response.statusCode))
        return
      }
      if (head && head.length) socket.unshift(head)
      if (!secure) { resolve(socket); return }
      const secured = tls.connect({ socket, servername: host, rejectUnauthorized: !insecure })
      // A tunnel that opens but never finishes the handshake would otherwise hang for
      // the OS default (~2 min) and leak the socket (R8).
      secured.setTimeout(timeoutMs, () => secured.destroy(new Error('tls_handshake_timeout')))
      secured.once('secureConnect', () => { secured.setTimeout(0); resolve(secured) })
      secured.once('error', (err) => { secured.destroy(); reject(err) })
    })
    request.on('timeout', () => fail(new Error('proxy connect timeout')))
    request.on('error', fail)
    request.end()
  })
}

/** Direct connection, optionally wrapped in TLS. */
export function connectDirect(host, port, options = {}) {
  const { secure = true, insecure = false, timeoutMs = 15000 } = options
  return new Promise((resolve, reject) => {
    if (!secure) {
      const socket = net.connect({ host, port })
      const fail = (err) => { socket.destroy(); reject(err) }
      socket.setTimeout(timeoutMs, () => fail(new Error('connect timeout')))
      socket.once('connect', () => { socket.setTimeout(0); resolve(socket) })
      socket.once('error', fail)
      return
    }
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: !insecure })
    const fail = (err) => { socket.destroy(); reject(err) }
    socket.setTimeout(timeoutMs, () => fail(new Error('TLS connect timeout')))
    socket.once('secureConnect', () => { socket.setTimeout(0); resolve(socket) })
    socket.once('error', fail)
  })
}

/**
 * One agent per route so sockets to a single target are reused (keep-alive).
 * The socket factory is handed to the agent instead of the agent's own TCP
 * connect: that is the only way to make the agent go through the tunnel.
 */
export class TunnelAgent extends https.Agent {
  constructor(createSocket, defaultPort, options = {}) {
    super({
      keepAlive: true,
      maxSockets: options.maxSockets ?? 6,
      maxFreeSockets: Math.max(1, Math.min(2, options.maxSockets ?? 6)),
      timeout: options.timeoutMs ?? 90000,
      scheduling: 'lifo',
    })
    this._createSocket = createSocket
    this.defaultPort = defaultPort
  }

  createConnection(_options, callback) {
    // Async connector: settle through the callback, return undefined so the
    // agent does not also treat the return value as a socket.
    let settled = false
    const done = (err, socket) => {
      if (settled) return
      settled = true
      callback(err, socket)
    }
    try {
      const result = this._createSocket()
      if (result && typeof result.then === 'function') {
        result.then((socket) => done(null, socket), (err) => done(err))
        return undefined
      }
      done(null, result)
      return result
    } catch (err) {
      done(err)
      return undefined
    }
  }
}

/** Same tunnel plumbing for cleartext targets (tests and plain-HTTP upstreams). */
export class PlainTunnelAgent extends http.Agent {
  constructor(createSocket, defaultPort, options = {}) {
    super({
      keepAlive: true,
      maxSockets: options.maxSockets ?? 6,
      maxFreeSockets: Math.max(1, Math.min(2, options.maxSockets ?? 6)),
      timeout: options.timeoutMs ?? 90000,
      scheduling: 'lifo',
    })
    this._createSocket = createSocket
    this.defaultPort = defaultPort
  }

  createConnection(_options, callback) {
    // Async connector: settle through the callback, return undefined so the
    // agent does not also treat the return value as a socket.
    let settled = false
    const done = (err, socket) => {
      if (settled) return
      settled = true
      callback(err, socket)
    }
    try {
      const result = this._createSocket()
      if (result && typeof result.then === 'function') {
        result.then((socket) => done(null, socket), (err) => done(err))
        return undefined
      }
      done(null, result)
      return result
    } catch (err) {
      done(err)
      return undefined
    }
  }
}

/**
 * Live counters for one route. Kept in memory next to the listener (they describe this
 * listener, not history); `?op=state` reads them through the manager.
 */
function newStats() {
  return {
    requests: 0,
    bytesIn: 0,
    bytesOut: 0,
    errors: 0,
    statuses: {},
    ttfb: [],
    startedAt: Date.now(),
    lastAt: null,
  }
}

export function createRelayServer(route) {
  const { host, port } = parseTarget(route.target)
  const secure = route.tls !== false
  const insecure = route.insecure === true
  const connectTimeoutMs = Number(route.connectTimeoutMs) > 0 ? Number(route.connectTimeoutMs) : 15000
  const schedule = { maxSockets: route.maxSockets, timeoutMs: route.timeoutMs }
  const connect = route.proxyUrl
    ? () => connectViaProxy(route.proxyUrl, host, port, { secure, insecure, timeoutMs: connectTimeoutMs })
    : () => connectDirect(host, port, { secure, insecure, timeoutMs: connectTimeoutMs })
  const transport = secure ? https : http
  const agent = secure ? new TunnelAgent(connect, port, schedule) : new PlainTunnelAgent(connect, port, schedule)
  const stats = newStats()

  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/__health') {
      sendJson(response, 200, { ok: true, target: route.target, secure, viaProxy: Boolean(route.proxyUrl) })
      return
    }
    const startedAt = process.hrtime.bigint()
    stats.requests += 1
    stats.lastAt = new Date().toISOString()
    request.on('data', (chunk) => { stats.bytesIn += chunk.length })

    const headers = stripHeaders(request.headers)
    const defaultPort = secure ? 443 : 80
    headers.host = port === defaultPort ? host : host + ':' + port
    const upstream = transport.request({ host, port, method: request.method, path: request.url, headers, agent }, (answer) => {
      if (response.destroyed) { answer.destroy(); return }
      const status = answer.statusCode ?? 502
      stats.statuses[status] = (stats.statuses[status] ?? 0) + 1
      if (status >= 500) stats.errors += 1
      const ttfbMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      stats.ttfb.push(ttfbMs)
      if (stats.ttfb.length > 200) stats.ttfb.shift()
      response.writeHead(status, stripHeaders(answer.headers))
      answer.on('data', (chunk) => { stats.bytesOut += chunk.length })
      answer.pipe(response)
      answer.on('error', () => response.destroy())
    })
    // A target that accepts the connection and then goes quiet must not pin a socket until
    // the process dies: route.timeoutMs (default 90 s) is the longest silence tolerated.
    const idleMs = Number(route.timeoutMs) || 90000
    upstream.setTimeout(idleMs, () => upstream.destroy(new Error('upstream_timeout')))
    // The client hanging up before the answer arrives is not an error we can report: it
    // only means the upstream request must stop too (otherwise the socket leaks).
    request.on('aborted', () => upstream.destroy())
    upstream.on('error', (err) => {
      stats.errors += 1
      if (response.headersSent) { response.destroy(); return }
      sendJson(response, 502, {
        error: 'relay_forward_failed',
        message: err && err.message ? err.message : String(err),
        target: route.target,
        hint: route.proxyUrl ? 'upstream proxy unreachable or refused the CONNECT' : 'target unreachable',
      })
    })
    request.pipe(upstream)
    // Only an aborted/early-closed response should tear the upstream request down;
    // destroying it on normal completion defeats keep-alive reuse (R7).
    response.on('close', () => {
      if (!response.writableFinished) upstream.destroy()
    })
  })

  server.stats = stats
  server.on('close', () => agent.destroy())
  server.on('error', () => agent.destroy())
  return server
}
