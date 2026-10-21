// 0.3.0 suite: per-route traffic counters, HTTP-layer probe, dry-run preview, port check
// and a live request through the listener.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import { apply } from '../lib/index.js'
import { RelayManager } from '../lib/manager.js'
import { probeOnce } from '../lib/probe.js'
import { createRelayServer } from '../lib/relay.js'

const WRITE_HEADERS = { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolve(port))
    })
  })
}

async function startTarget(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function fixtureProfile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-observability-'))
  const doc = [{
    id: 'llm-pi-ai',
    name: '@deepseek-ai/dsh-llm-pi-ai',
    config: {
      providers: {
        gemini: { displayName: 'Gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKeyEnv: 'GEMINI_API_KEY' },
      },
    },
  }]
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '# keep this comment\n' + yaml.dump(doc))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'profile', dsh: { profile: { bundles: [] } } }))
  return dir
}

function isolateHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

async function bootPlugin(profileDir, routes = []) {
  const restoreHome = isolateHome()
  const config = { profileDir, routes, proxies: {}, verifyAfterApply: false }
  const registrations = []
  const lifecycle = []
  const ctx = {
    logger: { info() {} },
    inject(services, factory) {
      factory({ webServer: { register(route) { registrations.push(route); return () => {} } } })
    },
    on(event, handler) { lifecycle.push({ event, handler }) },
  }
  await apply(ctx, config)
  assert.equal(registrations.length, 1)
  const server = http.createServer(registrations[0].handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port + '/plugins/egress-router'
  return {
    config,
    async call(op, body, headers = WRITE_HEADERS) {
      const res = await fetch(base + '?op=' + op, {
        method: body ? 'POST' : 'GET',
        headers: body ? headers : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(8000),
      })
      return { status: res.status, data: await res.json().catch(() => ({})) }
    },
    async get(query) {
      return fetch(base + query, { signal: AbortSignal.timeout(8000) })
    },
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      for (const entry of lifecycle) { try { await entry.handler() } catch {} }
      restoreHome()
    },
  }
}

test('relay counts requests, bytes and latency', async () => {
  const upstream = await startTarget((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '5' })
    res.end('hello')
  })
  const port = await freePort()
  const server = createRelayServer({ target: '127.0.0.1:' + upstream.port, tls: false })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  try {
    for (let index = 0; index < 2; index++) {
      const res = await fetch('http://127.0.0.1:' + port + '/x', { signal: AbortSignal.timeout(5000) })
      assert.equal(res.status, 200)
      await res.text()
    }
    const stats = server.stats
    assert.equal(stats.requests, 2)
    assert.equal(stats.errors, 0)
    assert.equal(stats.ttfb.length, 2)
    assert.ok(stats.bytesOut >= 10, 'expected response bytes to be counted, got ' + stats.bytesOut)
    assert.ok(stats.lastAt, 'expected a lastAt timestamp')
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await upstream.close()
  }
})

test('relay counts upstream failures as errors', async () => {
  const port = await freePort()
  const deadTarget = await freePort()
  const server = createRelayServer({ target: '127.0.0.1:' + deadTarget, tls: false })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/x', { signal: AbortSignal.timeout(5000) })
    assert.equal(res.status, 502)
    await res.text()
    assert.equal(server.stats.errors, 1)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('manager exposes per-route percentiles', async () => {
  const upstream = await startTarget((req, res) => { res.writeHead(204); res.end() })
  const port = await freePort()
  const manager = new RelayManager({ config: { listenHost: '127.0.0.1', proxies: {} } })
  try {
    const status = await manager.sync([{ id: 'llm:local', target: '127.0.0.1:' + upstream.port, listenPort: port, tls: false }])
    assert.equal(status[0].ok, true)
    for (let index = 0; index < 3; index++) {
      const res = await fetch('http://127.0.0.1:' + port + '/', { signal: AbortSignal.timeout(5000) })
      await res.text()
    }
    const metrics = manager.metrics()['llm:local']
    assert.equal(metrics.requests, 3)
    assert.equal(metrics.errors, 0)
    assert.equal(typeof metrics.ttfbP50, 'number')
    assert.equal(typeof metrics.ttfbP95, 'number')
    assert.equal(metrics.samples, 3)
    assert.ok(metrics.statuses['204'] >= 3)
  } finally {
    await manager.dispose()
    await upstream.close()
  }
})

test('probe reads the HTTP status, not just the TLS handshake', async () => {
  const upstream = await startTarget((req, res) => { res.writeHead(418); res.end() })
  try {
    const result = await probeOnce({ target: '127.0.0.1:' + upstream.port, http: true, secure: false, timeoutMs: 3000 })
    assert.equal(result.ok, true)
    assert.equal(result.status, 418)
  } finally {
    await upstream.close()
  }
})

test('probe reports a reset instead of a silent success', async () => {
  // A listener that accepts and immediately destroys proves "connect ok, HTTP unusable".
  const server = net.createServer((socket) => socket.destroy())
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const result = await probeOnce({ target: '127.0.0.1:' + port, http: true, secure: false, timeoutMs: 2000 })
    assert.equal(result.ok, false)
    assert.equal(result.status, null)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('plan previews the diff without touching the file', async () => {
  const profileDir = fixtureProfile()
  const plugin = await bootPlugin(profileDir)
  const file = path.join(profileDir, 'cordis.patch.yml')
  const before = sha256(file)
  try {
    const { status, data } = await plugin.call('plan', { itemId: 'llm:gemini', target: 'generativelanguage.googleapis.com:443', listenPort: 8794 })
    assert.equal(status, 200)
    assert.equal(data.diff.length, 2)
    assert.equal(data.portFree, true)
    assert.equal(data.route.listenPort, 8794)
    assert.equal(sha256(file), before, 'plan must not write the config file')
  } finally {
    await plugin.close()
  }
})

test('plan reports a busy port without writing', async () => {
  const profileDir = fixtureProfile()
  const plugin = await bootPlugin(profileDir)
  const file = path.join(profileDir, 'cordis.patch.yml')
  const before = sha256(file)
  const busy = net.createServer()
  await new Promise((resolve) => busy.listen(0, '127.0.0.1', resolve))
  try {
    const { status, data } = await plugin.call('plan', { itemId: 'llm:gemini', target: 'generativelanguage.googleapis.com:443', listenPort: busy.address().port })
    assert.equal(status, 200)
    assert.equal(data.portFree, false)
    assert.equal(data.warnings.length, 1)
    assert.equal(sha256(file), before)
  } finally {
    await new Promise((resolve) => busy.close(resolve))
    await plugin.close()
  }
})

test('ports op reports which loopback ports can be bound', async () => {
  const profileDir = fixtureProfile()
  const plugin = await bootPlugin(profileDir)
  const busy = net.createServer()
  await new Promise((resolve) => busy.listen(0, '127.0.0.1', resolve))
  const busyPort = busy.address().port
  const free = await freePort()
  try {
    const res = await plugin.get('?op=ports&port=' + free + '&port=' + busyPort)
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.ports[free], true)
    assert.equal(data.ports[busyPort], false)
  } finally {
    await new Promise((resolve) => busy.close(resolve))
    await plugin.close()
  }
})

test('suggest op hands out a free port and skips the ones this plugin already runs', async () => {
  const profileDir = fixtureProfile()
  const upstream = await startTarget((req, res) => { res.writeHead(200); res.end('ok') })
  const claimed = await freePort()
  const plugin = await bootPlugin(profileDir, [{ id: 'llm:gemini', target: '127.0.0.1:' + upstream.port, listenPort: claimed, tls: false }])
  try {
    const other = await plugin.get('?op=suggest&itemId=llm:openrouter')
    assert.equal(other.status, 200)
    const picked = await other.json()
    assert.ok(picked.port >= 8791 && picked.port <= 8888)
    assert.notEqual(picked.port, claimed)
    assert.ok(picked.used.includes(claimed))
    assert.ok(!picked.used.includes(picked.port))

    // The picked port must be bindable right now, not just absent from the ledger.
    const probe = net.createServer()
    await new Promise((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(picked.port, '127.0.0.1', resolve)
    })
    await new Promise((resolve) => probe.close(resolve))

    // A route that already owns its port keeps it, so re-applying never moves a live row.
    const own = await plugin.get('?op=suggest&itemId=llm:gemini')
    const ownBody = await own.json()
    assert.equal(ownBody.port, claimed)
  } finally {
    await plugin.close()
    await upstream.close()
  }
})
test('test op drives one request through the running route', async () => {
  const profileDir = fixtureProfile()
  const upstream = await startTarget((req, res) => {
    assert.equal(req.method, 'HEAD')
    assert.equal(req.url, '/probe-path')
    res.writeHead(200)
    res.end()
  })
  const port = await freePort()
  const plugin = await bootPlugin(profileDir, [{ id: 'llm:local', target: '127.0.0.1:' + upstream.port, listenPort: port, tls: false }])
  try {
    const { status, data } = await plugin.call('test', { id: 'llm:local', path: '/probe-path' })
    assert.equal(status, 200)
    assert.equal(data.status, 200)
    assert.equal(typeof data.ms, 'number')
  } finally {
    await plugin.close()
    await upstream.close()
  }
})

test('state reports live metrics for a running route', async () => {
  const profileDir = fixtureProfile()
  const upstream = await startTarget((req, res) => { res.writeHead(200); res.end('x') })
  const port = await freePort()
  const plugin = await bootPlugin(profileDir, [{ id: 'llm:local', target: '127.0.0.1:' + upstream.port, listenPort: port, tls: false }])
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/', { signal: AbortSignal.timeout(5000) })
    await res.text()
    const { status, data } = await plugin.call('state')
    assert.equal(status, 200)
    assert.equal(data.metrics['llm:local'].requests, 1)
    assert.equal(typeof data.tuning.maxSockets, 'number')
  } finally {
    await plugin.close()
    await upstream.close()
  }
})
