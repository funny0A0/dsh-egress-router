// 0.9.0 suite: cumulative counters, redacted diagnostics, declared custom targets,
// upstream health, and the API version marker.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import { apply } from '../lib/index.js'
import { readState, mergeMetricsTotals, diffMetrics } from '../lib/store.js'

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-insight-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

function fixtureProfile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-insight-'))
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

async function bootPlugin({ routes = [], targets = null, proxies = {} } = {}) {
  const restoreHome = isolateHome()
  const profileDir = fixtureProfile()
  const config = { profileDir, routes, proxies, targets, verifyAfterApply: false }
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
        method: body === null ? 'GET' : 'POST',
        headers: body === null ? undefined : headers,
        body: body === null ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      })
      return { status: res.status, data: await res.json().catch(() => ({})) }
    },
    async get(query) {
      const res = await fetch(base + query, { signal: AbortSignal.timeout(15000) })
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

test('mergeMetricsTotals only adds and keeps the first `since`', () => {
  const restore = isolateHome()
  try {
    mergeMetricsTotals({ 'llm:a': { requests: 2, bytesIn: 10, bytesOut: 20, errors: 0 } })
    const first = readState().metricsTotals['llm:a']
    mergeMetricsTotals({ 'llm:a': { requests: 3, bytesIn: 5, bytesOut: 6, errors: 1 } })
    const second = readState().metricsTotals['llm:a']
    assert.equal(second.requests, 5)
    assert.equal(second.bytesIn, 15)
    assert.equal(second.errors, 1)
    assert.equal(second.since, first.since, 'since must not move on later flushes')
    assert.ok(second.updatedAt)
  } finally {
    restore()
  }
})

test('diffMetrics called twice with the same snapshot produces no second delta', () => {
  const live = { 'llm:a': { requests: 5, bytesIn: 100, bytesOut: 200, errors: 0 } }
  const first = diffMetrics({}, live)
  assert.deepEqual(first.delta['llm:a'], { requests: 5, bytesIn: 100, bytesOut: 200, errors: 0 })
  const second = diffMetrics(first.baseline, live)
  assert.deepEqual(second.delta, {}, 'flushing the same counters twice must not double count')
})

test('diffMetrics treats a counter that went down as a new baseline', () => {
  const before = { 'llm:a': { requests: 9, bytesIn: 900, bytesOut: 900, errors: 1 } }
  const after = { 'llm:a': { requests: 1, bytesIn: 5, bytesOut: 6, errors: 0 } }
  const { delta, baseline } = diffMetrics(before, after)
  assert.deepEqual(delta, {}, 'a restart must not write negative traffic')
  assert.equal(baseline['llm:a'].requests, 1)
})

test('state exposes apiVersion and metricsTotals', async () => {
  const plugin = await bootPlugin()
  try {
    const { status, data } = await plugin.get('?op=state')
    assert.equal(status, 200)
    assert.equal(data.apiVersion, 1)
    assert.deepEqual(data.metricsTotals, {})
    assert.equal(typeof data.profileOk, 'boolean')
  } finally {
    await plugin.close()
  }
})

test('config.targets becomes a custom row and probe accepts it', async () => {
  const plugin = await bootPlugin({
    targets: [{ id: 'probe-me', name: 'Probe me', host: 'no-such-host.invalid', port: 443 }],
  })
  try {
    const discover = await plugin.get('?op=discover')
    assert.equal(discover.status, 200)
    const row = discover.data.items.find((item) => item.id === 'custom:probe-me')
    assert.ok(row, 'expected custom:probe-me in discover, got ' + JSON.stringify(discover.data.items.map((i) => i.id)))
    assert.equal(row.kind, 'custom')
    assert.equal(row.target, 'no-such-host.invalid:443')
    assert.equal(row.patchable, false)

    // The same target used to fail with unknown_target before 0.9.0.
    const probe = await plugin.call('probe', { target: 'no-such-host.invalid:443' })
    assert.equal(probe.status, 200, JSON.stringify(probe.data))
    assert.equal(typeof probe.data.verdict, 'string')

    // Declared does not mean rewritable: custom rows have no provider block.
    const applyRes = await plugin.call('apply', { itemId: 'custom:probe-me', target: 'no-such-host.invalid:443', listenPort: 8790 })
    assert.equal(applyRes.status, 400)
    assert.equal(applyRes.data.error, 'not_patchable')
  } finally {
    await plugin.close()
  }
})

test('diagnose redacts credentials and stays small', async () => {
  const plugin = await bootPlugin({ proxies: { clash: 'http://user:pass@127.0.0.1:7897' } })
  try {
    const { status, data } = await plugin.get('?op=diagnose')
    assert.equal(status, 200)
    assert.equal(data.apiVersion, 1)
    const text = JSON.stringify(data)
    assert.ok(!text.includes('user:pass'), 'proxy credentials must not survive redaction')
    assert.ok(!text.includes('///'), 'redacted URL must still be a URL')
    assert.ok(Array.isArray(data.bots), 'expected bot rows')
    for (const bot of data.bots) {
      assert.equal(bot.url, undefined, 'bot rows must not carry the proxy URL as `url`')
      assert.equal(typeof bot.configured, 'boolean')
    }
    assert.ok((data.history ?? []).length <= 20)
    assert.ok(text.length < 64 * 1024, 'diagnostics should stay small, got ' + text.length)
    assert.equal(data.config.proxies.clash, 'http://***@127.0.0.1:7897/', 'userinfo replaced with ***')
  } finally {
    await plugin.close()
  }
})

test('upstream reports per-route reachability and requires write intent', async () => {
  const port = await freePort()
  const plugin = await bootPlugin({
    routes: [{ id: 'llm:demo', target: 'no-such-host.invalid:443', listenPort: port, proxy: null, tls: null }],
  })
  try {
    const result = await plugin.call('upstream', {})
    assert.equal(result.status, 200, JSON.stringify(result.data))
    assert.equal(result.data.ok, false)
    assert.equal(result.data.results.length, 1)
    assert.equal(result.data.results[0].id, 'llm:demo')
    assert.equal(result.data.results[0].ok, false)
    assert.ok(result.data.results[0].error, 'expected an error string')

    const noIntent = await fetch('http://127.0.0.1:1/plugins/egress-router?op=upstream').catch(() => null)
    assert.equal(noIntent, null, 'sanity: nothing listens on port 1')
    const foreign = await plugin.call('upstream', {}, { 'content-type': 'application/json', origin: 'https://evil.example' })
    assert.equal(foreign.status, 403)
  } finally {
    await plugin.close()
  }
})
