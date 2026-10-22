// 0.10.0 suite: relay-only routes (no config file) and the batch unit of work.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import { apply } from '../lib/index.js'
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

function isolateHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-crud-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

function fixtureProfile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-crud-'))
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

async function bootPlugin({ routes = [], proxies = { clash: 'http://127.0.0.1:7897' } } = {}) {
  const restoreHome = isolateHome()
  const profileDir = fixtureProfile()
  const config = { profileDir, routes, proxies, verifyAfterApply: false }
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
    base,
    async call(op, body, headers = WRITE_HEADERS) {
      const res = await fetch(base + '?op=' + op, {
        method: body === null ? 'GET' : 'POST',
        headers: body === null ? undefined : headers,
        body: body === null ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      })
      return { status: res.status, data: await res.json().catch(() => ({})) }
    },
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      for (const entry of lifecycle) { try { await entry.handler() } catch {} }
      restoreHome()
    },
  }
}

async function health(port) {
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/__health', { signal: AbortSignal.timeout(3000) })
    return { status: res.status, data: await res.json().catch(() => ({})) }
  } catch (err) {
    return { status: 0, error: err.message }
  }
}

test('GET ?op=routes lists provider rows with their kind', async () => {
  const plugin = await bootPlugin({ routes: [{ id: 'llm:gemini', target: 'generativelanguage.googleapis.com:443', listenPort: await freePort() }] })
  try {
    const { status, data } = await plugin.call('routes', null)
    assert.equal(status, 200)
    assert.equal(data.apiVersion, 1)
    assert.ok(data.proxies.includes('clash'))
    assert.equal(data.listenHost, '127.0.0.1')
    assert.equal(data.routes.length, 1)
    const row = data.routes[0]
    assert.equal(row.kind, 'provider')
    assert.equal(row.id, 'llm:gemini')
    assert.equal(row.origin, null, 'a provider route has no relay origin')
    assert.ok(row.status && row.status.ok)
  } finally {
    await plugin.close()
  }
})

test('a relay route owns a listener and needs no config rewrite', async () => {
  const plugin = await bootPlugin()
  const port = await freePort()
  try {
    const before = fs.readFileSync(path.join(plugin.config.profileDir, 'cordis.patch.yml'), 'utf8')
    const created = await plugin.call('routes', { action: 'upsert', id: 'relay:hf', target: 'huggingface.co:443', listenPort: port })
    assert.equal(created.status, 200)
    assert.equal(created.data.action, 'create')
    assert.equal(created.data.route.kind, 'relay')
    assert.equal(created.data.route.origin, 'http://127.0.0.1:' + port)
    assert.equal(created.data.restartRequired, false)
    const healthResult = await health(port)
    assert.equal(healthResult.status, 200)
    assert.equal(healthResult.data.ok, true)
    const after = fs.readFileSync(path.join(plugin.config.profileDir, 'cordis.patch.yml'), 'utf8')
    assert.equal(after, before, 'a relay route must not touch cordis.patch.yml')
    assert.equal(readRoutes().length, 1)
    assert.equal(readRoutes()[0].id, 'relay:hf')
  } finally {
    await plugin.close()
  }
})

test('re-applying a relay route on its own port is idempotent', async () => {
  const plugin = await bootPlugin()
  const port = await freePort()
  try {
    await plugin.call('routes', { action: 'upsert', id: 'relay:hf', target: 'huggingface.co:443', listenPort: port, proxy: 'clash' })
    const again = await plugin.call('routes', { action: 'upsert', id: 'relay:hf', target: 'huggingface.co:443', listenPort: port })
    assert.equal(again.status, 200, JSON.stringify(again.data))
    assert.equal(again.data.action, 'update')
    assert.equal(again.data.route.proxy, 'clash', 'a resend without proxy keeps the stored one')
    assert.equal(readRoutes().length, 1)
  } finally {
    await plugin.close()
  }
})

test('deleting a relay route stops its listener', async () => {
  const plugin = await bootPlugin()
  const port = await freePort()
  try {
    await plugin.call('routes', { action: 'upsert', id: 'relay:hf', target: 'huggingface.co:443', listenPort: port })
    const removed = await plugin.call('routes', { action: 'delete', id: 'relay:hf' })
    assert.equal(removed.status, 200)
    assert.equal(removed.data.action, 'delete')
    assert.equal(removed.data.restartRequired, false)
    assert.equal((await health(port)).status, 0, 'the listener must be gone')
    assert.equal(readRoutes().length, 0)
    const missing = await plugin.call('routes', { action: 'delete', id: 'relay:hf' })
    assert.equal(missing.status, 404)
    assert.equal(missing.data.error, 'unknown_route')
  } finally {
    await plugin.close()
  }
})

test('relay routes reject private targets and unknown proxies', async () => {
  const plugin = await bootPlugin()
  const port = await freePort()
  try {
    const loopback = await plugin.call('routes', { action: 'upsert', id: 'relay:local', target: '127.0.0.1:9', listenPort: port })
    assert.equal(loopback.status, 400)
    assert.equal(loopback.data.error, 'loopback_target')
    const badId = await plugin.call('routes', { action: 'upsert', id: 'relay:has space', target: 'huggingface.co:443', listenPort: port })
    assert.equal(badId.status, 400)
    assert.equal(badId.data.error, 'invalid_id')
    const badProxy = await plugin.call('routes', { action: 'upsert', id: 'relay:hf', target: 'huggingface.co:443', listenPort: port, proxy: 'nope' })
    assert.equal(badProxy.status, 400)
    assert.equal(badProxy.data.error, 'unknown_proxy')
    assert.equal(readRoutes().length, 0, 'a rejected upsert writes nothing')
  } finally {
    await plugin.close()
  }
})

test('batch applies and undoes several routes', async () => {
  const plugin = await bootPlugin()
  const first = await freePort()
  const second = await freePort()
  try {
    const applied = await plugin.call('batch', {
      actions: [
        { itemId: 'relay:a', action: 'apply', target: 'huggingface.co:443', listenPort: first },
        { itemId: 'relay:b', action: 'apply', target: 'openrouter.ai:443', listenPort: second },
      ],
    })
    assert.equal(applied.status, 200, JSON.stringify(applied.data))
    assert.equal(applied.data.results.length, 2)
    assert.equal(applied.data.compensated, 0)
    assert.equal(applied.data.routes.length, 2)
    assert.equal((await health(first)).status, 200)
    assert.equal((await health(second)).status, 200)

    const undone = await plugin.call('batch', {
      actions: [
        { itemId: 'relay:a', action: 'rollback' },
        { itemId: 'relay:b', action: 'rollback' },
      ],
    })
    assert.equal(undone.status, 200, JSON.stringify(undone.data))
    assert.equal(undone.data.results.length, 2)
    assert.equal(readRoutes().length, 0)
    assert.equal((await health(first)).status, 0)
  } finally {
    await plugin.close()
  }
})

test('batch preflight refuses duplicate ports before writing anything', async () => {
  const plugin = await bootPlugin()
  const port = await freePort()
  try {
    const result = await plugin.call('batch', {
      actions: [
        { itemId: 'relay:a', action: 'apply', target: 'huggingface.co:443', listenPort: port },
        { itemId: 'relay:b', action: 'apply', target: 'openrouter.ai:443', listenPort: port },
      ],
    })
    assert.equal(result.status, 409)
    assert.equal(result.data.error, 'port_in_use')
    assert.equal(readRoutes().length, 0, 'preflight failure must leave state untouched')
    assert.equal((await health(port)).status, 0)
  } finally {
    await plugin.close()
  }
})

test('batch compensates the steps it already applied', async () => {
  const plugin = await bootPlugin()
  const first = await freePort()
  const second = await freePort()
  try {
    const result = await plugin.call('batch', {
      actions: [
        { itemId: 'relay:a', action: 'apply', target: 'huggingface.co:443', listenPort: first },
        { itemId: 'llm:absent', action: 'apply', target: 'absent.example:443', listenPort: second },
      ],
    })
    assert.equal(result.status, 502)
    assert.equal(result.data.error, 'provider_not_found')
    assert.equal(result.data.compensated, 1)
    assert.equal(result.data.results.length, 1)
    assert.equal(result.data.results[0].itemId, 'relay:a')
    assert.equal(readRoutes().length, 0, 'the applied step must be undone')
    assert.equal((await health(first)).status, 0, 'its listener must be closed')
  } finally {
    await plugin.close()
  }
})

test('route writes still require the settings-page intent', async () => {
  const plugin = await bootPlugin()
  try {
    const port = await freePort()
    const res = await fetch(plugin.base + '?op=routes', {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'upsert', id: 'relay:hf', target: 'huggingface.co:443', listenPort: port }),
      signal: AbortSignal.timeout(10000),
    })
    assert.equal(res.status, 403)
    const body = await res.json()
    assert.equal(body.error, 'unauthorized')
    assert.equal(readRoutes().length, 0)
  } finally {
    await plugin.close()
  }
})
