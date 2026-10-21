import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { createRelayServer } from '../lib/relay.js'

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

function shut(server) {
  server.closeAllConnections?.()
  return new Promise((resolve) => server.close(() => resolve()))
}

function stubProxy() {
  const server = http.createServer((req, res) => { res.writeHead(405); res.end() })
  server.on('connect', (req, clientSocket, head) => {
    const [host, port] = req.url.split(':')
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })
  return server
}

test('relay forwards through the tunnel proxy and answers health', async () => {
  const target = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ host: req.headers.host, path: req.url, method: req.method }))
  })
  const targetPort = await listen(target)
  const proxy = stubProxy()
  const proxyPort = await listen(proxy)
  const relay = createRelayServer({ target: '127.0.0.1:' + targetPort, proxyUrl: 'http://127.0.0.1:' + proxyPort, tls: false })
  const relayPort = await listen(relay)
  try {
    const health = await fetch('http://127.0.0.1:' + relayPort + '/__health', { signal: AbortSignal.timeout(5000) })
    assert.equal(health.status, 200)
    assert.equal((await health.json()).target, '127.0.0.1:' + targetPort)
    const echo = await fetch('http://127.0.0.1:' + relayPort + '/v1/echo', { signal: AbortSignal.timeout(5000) })
    assert.equal(echo.status, 200)
    const body = await echo.json()
    assert.equal(body.host, '127.0.0.1:' + targetPort)
    assert.equal(body.path, '/v1/echo')
  } finally {
    await shut(relay)
    await shut(proxy)
    await shut(target)
  }
})

test('relay returns 502 when the proxy is down', async () => {
  const relay = createRelayServer({ target: '127.0.0.1:9', proxyUrl: 'http://127.0.0.1:1', tls: false })
  const port = await listen(relay)
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/x', { method: 'POST', body: '{}', signal: AbortSignal.timeout(5000) })
    assert.equal(res.status, 502)
    const payload = await res.json()
    assert.equal(payload.error, 'relay_forward_failed')
  } finally {
    await shut(relay)
  }
})

