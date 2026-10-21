// 0.2.1 regression suite: state-backed routes, restart rebuild, rollback, write auth, ordering.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import { apply } from '../lib/index.js'
import { RelayManager } from '../lib/manager.js'
import { readPatchDocument } from '../lib/patcher.js'
import { readRoutes } from '../lib/store.js'

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

function fixtureProfile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-write-'))
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

async function bootPlugin(profileDir, routes = []) {
  const config = { profileDir, routes, proxies: { clash: 'http://127.0.0.1:7897' }, verifyAfterApply: false }
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
  const port = server.address().port
  const base = 'http://127.0.0.1:' + port + '/plugins/egress-router'
  return {
    config,
    async call(op, body, headers = WRITE_HEADERS) {
      const res = await fetch(base + '?op=' + op, {
        method: body ? 'POST' : 'GET',
        headers: body ? headers : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(8000),
      })
      const data = await res.json().catch(() => ({}))
      return { status: res.status, data }
    },
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      for (const entry of lifecycle) { try { await entry.handler() } catch {} }
    },
  }
}

function patchText(profileDir) {
  return fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8')
}

function withHome(fn) {
  return async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-home-'))
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      await fn()
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  }
}

test('apply rewrites baseURL, persists the route in state, keeps the comment', withHome(async () => {
  const profileDir = fixtureProfile()
  const listenPort = await freePort()
  const plugin = await bootPlugin(profileDir)
  try {
    const result = await plugin.call('apply', { itemId: 'llm:gemini', target: 'generativelanguage.googleapis.com:443', listenPort, proxy: 'clash' })
    assert.equal(result.status, 200, JSON.stringify(result.data))
    assert.equal(result.data.restartRequired, true)

    const { doc } = readPatchDocument(profileDir)
    assert.equal(doc[0].config.providers.gemini.baseURL, 'http://127.0.0.1:' + listenPort + '/v1beta/openai')
    assert.equal(doc.find((entry) => entry.id === 'egress-router'), undefined, 'plugin must not insert itself')

    const routes = readRoutes()
    assert.equal(routes.length, 1)
    assert.equal(routes[0].id, 'llm:gemini')
    assert.equal(routes[0].listenPort, listenPort)
    assert.equal(routes[0].proxy, 'clash')
    assert.match(patchText(profileDir), /# keep this comment/)
  } finally {
    await plugin.close()
  }
}))

test('restart: routes read from state rebuild the listener', withHome(async () => {
  const profileDir = fixtureProfile()
  const listenPort = await freePort()
  const first = await bootPlugin(profileDir)
  try {
    const applied = await first.call('apply', { itemId: 'llm:gemini', target: '192.0.2.1:9', listenPort })
    assert.equal(applied.status, 200, JSON.stringify(applied.data))
  } finally {
    await first.close()
  }
  // A restart is exactly this: a fresh manager fed only from state (no config seed).
  const routes = readRoutes()
  assert.equal(routes.length, 1)
  const manager = new RelayManager({ config: { proxies: {} }, log: () => {} })
  try {
    const status = await manager.sync(routes)
    assert.equal(status[0].ok, true, JSON.stringify(status))
    const health = await fetch('http://127.0.0.1:' + listenPort + '/__health', { signal: AbortSignal.timeout(3000) })
    assert.equal(health.status, 200)
  } finally {
    await manager.dispose()
  }
}))

test('a legacy config seed migrates into state on boot', withHome(async () => {
  const profileDir = fixtureProfile()
  const listenPort = await freePort()
  const plugin = await bootPlugin(profileDir, [{ id: 'llm:gemini', target: '192.0.2.1:9', listenPort }])
  try {
    assert.equal(readRoutes().length, 1)
    assert.equal(readRoutes()[0].listenPort, listenPort)
  } finally {
    await plugin.close()
  }
}))

test('re-applying the same row on its own port succeeds and keeps the proxy', withHome(async () => {
  const profileDir = fixtureProfile()
  const listenPort = await freePort()
  const plugin = await bootPlugin(profileDir)
  try {
    const first = await plugin.call('apply', { itemId: 'llm:gemini', target: '192.0.2.1:9', listenPort, proxy: 'clash' })
    assert.equal(first.status, 200, JSON.stringify(first.data))
    // Same port, no proxy in the body: must not 409 and must not lose `clash`.
    const second = await plugin.call('apply', { itemId: 'llm:gemini', target: '192.0.2.1:9', listenPort })
    assert.equal(second.status, 200, JSON.stringify(second.data))
    assert.equal(readRoutes()[0].proxy, 'clash')
  } finally {
    await plugin.close()
  }
}))

test('rollback restores the file and stops the listener', withHome(async () => {
  const profileDir = fixtureProfile()
  const listenPort = await freePort()
  const before = patchText(profileDir)
  const plugin = await bootPlugin(profileDir)
  try {
    const applied = await plugin.call('apply', { itemId: 'llm:gemini', target: '192.0.2.1:9', listenPort })
    assert.equal(applied.status, 200, JSON.stringify(applied.data))
    assert.equal(readRoutes().length, 1)

    const rolled = await plugin.call('rollback', {})
    assert.equal(rolled.status, 200, JSON.stringify(rolled.data))

    assert.equal(patchText(profileDir), before)
    assert.equal(readRoutes().length, 0)
    const state = await plugin.call('state')
    assert.equal((state.data.status || []).filter((item) => item.id === 'llm:gemini').length, 0)
    let reachable = true
    try {
      await fetch('http://127.0.0.1:' + listenPort + '/__health', { signal: AbortSignal.timeout(2000) })
    } catch {
      reachable = false
    }
    assert.equal(reachable, false, 'listener should be closed after rollback')
  } finally {
    await plugin.close()
  }
}))

test('a foreign web origin is rejected and changes nothing', withHome(async () => {
  const profileDir = fixtureProfile()
  const listenPort = await freePort()
  const before = patchText(profileDir)
  const plugin = await bootPlugin(profileDir)
  try {
    const denied = await plugin.call('apply', { itemId: 'llm:gemini', target: '192.0.2.1:9', listenPort }, { 'content-type': 'application/json', origin: 'https://evil.example' })
    assert.equal(denied.status, 403, JSON.stringify(denied.data))
    assert.equal(denied.data.error, 'unauthorized')
    assert.equal(patchText(profileDir), before)

    const wrongType = await plugin.call('apply', { itemId: 'llm:gemini', target: '192.0.2.1:9', listenPort }, { 'sec-fetch-site': 'same-origin', 'content-type': 'text/plain' })
    assert.equal(wrongType.status, 415)
    assert.equal(patchText(profileDir), before)
  } finally {
    await plugin.close()
  }
}))

test('port in use fails the apply and leaves the file byte-identical', withHome(async () => {
  const profileDir = fixtureProfile()
  const listenPort = await freePort()
  const blocker = net.createServer()
  await new Promise((resolve) => blocker.listen(listenPort, '127.0.0.1', resolve))
  const before = patchText(profileDir)
  const plugin = await bootPlugin(profileDir)
  try {
    const result = await plugin.call('apply', { itemId: 'llm:gemini', target: '192.0.2.1:9', listenPort })
    assert.equal(result.status, 409, JSON.stringify(result.data))
    assert.equal(result.data.error, 'port_in_use')
    assert.equal(patchText(profileDir), before)
    assert.equal(readRoutes().length, 0)
  } finally {
    await plugin.close()
    await new Promise((resolve) => blocker.close(resolve))
  }
}))

test('unknown provider is a 400, not a 500', withHome(async () => {
  const profileDir = fixtureProfile()
  const listenPort = await freePort()
  const plugin = await bootPlugin(profileDir)
  try {
    const result = await plugin.call('apply', { itemId: 'llm:nope', target: 'example.com:443', listenPort })
    assert.equal(result.status, 400)
    assert.equal(result.data.error, 'provider_not_found')
  } finally {
    await plugin.close()
  }
}))

test('state exposes persisted routes, listeners and restart hint', withHome(async () => {
  const profileDir = fixtureProfile()
  const listenPort = await freePort()
  const plugin = await bootPlugin(profileDir)
  try {
    const applied = await plugin.call('apply', { itemId: 'llm:gemini', target: '192.0.2.1:9', listenPort })
    assert.equal(applied.status, 200, JSON.stringify(applied.data))
    const state = await plugin.call('state')
    assert.equal(state.status, 200)
    assert.equal(state.data.routes.length, 1)
    assert.ok(Array.isArray(state.data.listeners), 'listeners must be persisted for an honest UI')
    assert.ok(state.data.history.some((entry) => entry.op === 'apply' && entry.ok === true))
  } finally {
    await plugin.close()
  }
}))

test('the proxy picker can both set and clear the stored proxy', withHome(async () => {
  const profileDir = fixtureProfile()
  const port = await freePort()
  const plugin = await bootPlugin(profileDir)
  try {
    const withProxy = await plugin.call('apply', { itemId: 'llm:gemini', target: 'generativelanguage.googleapis.com:443', listenPort: port, proxy: 'clash' })
    assert.equal(withProxy.status, 200)
    let state = await plugin.call('state')
    assert.equal(state.data.routes[0].proxy, 'clash')
    assert.equal(state.data.status.find((item) => item.id === 'llm:gemini').ok, true)

    // "直连" in the picker sends an explicit empty string; that must clear the proxy
    // instead of keeping the old one (an omitted field is what keeps it).
    const direct = await plugin.call('apply', { itemId: 'llm:gemini', target: 'generativelanguage.googleapis.com:443', listenPort: port, proxy: '' })
    assert.equal(direct.status, 200)
    state = await plugin.call('state')
    assert.equal(state.data.routes[0].proxy, null)
    assert.equal(state.data.status[0].ok, true)

    // Re-applying without the field keeps whatever is stored, so the picker's silence
    // never silently downgrades a proxied route.
    const back = await plugin.call('apply', { itemId: 'llm:gemini', target: 'generativelanguage.googleapis.com:443', listenPort: port, proxy: 'clash' })
    const keep = await plugin.call('apply', { itemId: 'llm:gemini', target: 'generativelanguage.googleapis.com:443', listenPort: port })
    assert.equal(keep.status, 200)
    state = await plugin.call('state')
    assert.equal(state.data.routes[0].proxy, 'clash')
  } finally {
    await plugin.close()
  }
}))
