// Connectivity probes: measure direct vs proxied reachability of one target.
import { connectDirect, connectViaProxy } from './relay.js'

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timed out after ' + ms + 'ms')), ms)),
  ])
}

/**
 * Send one request over an established socket and read the status line. TLS reaching
 * "handshake complete" only proves a listener exists; a reset or garbage after the
 * handshake means the endpoint is still unusable (0.3.0: HTTP-layer probe).
 */
function readStatus(socket, host, path, method, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    let done = false
    const finish = (fn, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.destroy()
      fn(value)
    }
    const timer = setTimeout(() => finish(reject, new Error('http probe timed out after ' + timeoutMs + 'ms')), timeoutMs)
    const onData = (chunk) => {
      buffer += chunk.toString('latin1')
      if (buffer.length > 16384) return finish(reject, new Error('http probe response header too large'))
      const end = buffer.indexOf('\r\n\r\n')
      if (end === -1) return
      const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(buffer.slice(0, end))
      if (!match) return finish(reject, new Error('http probe got a non-HTTP response'))
      finish(resolve, Number(match[1]))
    }
    socket.on('data', onData)
    socket.once('error', (err) => finish(reject, err))
    socket.once('close', () => finish(reject, new Error('connection closed before a status line')))
    socket.write(method + ' ' + path + ' HTTP/1.1\r\nHost: ' + host + '\r\nUser-Agent: dsh-egress-router\r\nConnection: close\r\n\r\n')
  })
}

export async function probeOnce({ target, proxyUrl, timeoutMs = 8000, http = false, path = '/', method = 'HEAD', secure = true }) {
  const started = Date.now()
  const [host, portText] = String(target).split(':')
  const port = Number(portText || 443)
  try {
    const socket = proxyUrl
      ? await withTimeout(connectViaProxy(proxyUrl, host, port, { secure, timeoutMs }), timeoutMs + 500, 'proxy connect')
      : await withTimeout(connectDirect(host, port, { secure, timeoutMs }), timeoutMs + 500, 'direct connect')
    if (!http) {
      socket.destroy()
      return { ok: true, status: null, via: proxyUrl ? 'proxy' : 'direct', target, ms: Date.now() - started, error: null }
    }
    const status = await readStatus(socket, host, path, method, timeoutMs)
    return { ok: true, status, via: proxyUrl ? 'proxy' : 'direct', target, ms: Date.now() - started, error: null }
  } catch (err) {
    return { ok: false, status: null, via: proxyUrl ? 'proxy' : 'direct', target, ms: Date.now() - started, error: err?.message ?? String(err) }
  }
}

/**
 * Post-apply check (R9): prove the route actually reaches its target through the same
 * path the relay will use. One retry absorbs a single upstream blip; the HTTP layer is
 * included so "TLS up but the endpoint resets" fails here instead of on the first chat.
 */
export async function verifyApply({ target, proxyUrl, timeoutMs = 12000, retries = 2 }) {
  let last = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    last = await probeOnce({ target, proxyUrl, timeoutMs, http: true })
    if (last.ok) return last
  }
  return last
}

export async function probeTarget({ target, proxyUrl, compare = false }) {
  const direct = await probeOnce({ target, proxyUrl: null })
  if (!compare) return { target, direct, proxy: null, verdict: direct.ok ? 'direct' : 'needs-proxy' }
  const proxied = proxyUrl ? await probeOnce({ target, proxyUrl }) : null
  let verdict = 'direct'
  if (!direct.ok && proxied?.ok) verdict = 'needs-proxy'
  else if (!direct.ok && !proxied?.ok) verdict = 'unreachable'
  return { target, direct, proxy: proxied, verdict }
}
