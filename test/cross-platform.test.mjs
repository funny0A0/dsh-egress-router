// 0.12.0 - a release candidate has to survive the boring cross-platform differences:
// CRLF configs written by Windows editors, profile paths with spaces and non-ASCII
// characters, IPv6 targets, two writes racing each other, and an npm that is a script
// rather than an executable.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import yaml from 'js-yaml'
import { planApply, commitApply, rollbackLast } from '../lib/patcher.js'
import { buildRelayRoute, routeKind } from '../lib/relay-routes.js'
import { isTarget, validateState } from '../lib/schema.js'
import { readState, writeRoutes } from '../lib/store.js'
import { apply } from '../lib/index.js'
import { describeNpm, npmSync } from '../scripts/npm-run.mjs'

const WRITE_HEADERS = { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function isolateHome() {
  const home = tempDir('egress-xplat-home-')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  writeRoutes([])
  return () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

function profileFixture({ name = 'egress-xplat-profile-', eol = '\n', providers = { gemini: 'https://generativelanguage.googleapis.com/v1beta/openai' } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name))
  const list = Object.entries(providers).map(([key, baseURL]) => ({
    id: 'llm-pi-ai',
    name: '@deepseek-ai/dsh-llm-pi-ai',
    config: {
      providers: Object.fromEntries(
        Object.entries(providers).map(([provider, url]) => [provider, { displayName: provider, baseURL: url, apiKeyEnv: provider.toUpperCase() + '_API_KEY' }]),
      ),
    },
  }))
  const raw = ['# keep this comment', yaml.dump(list.slice(0, 1))].join(eol)
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), raw)
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'profile', dsh: { profile: { bundles: [] } } }))
  return { dir, raw }
}

test('a CRLF patch file keeps CRLF after a write', async () => {
  const restore = isolateHome()
  try {
    const { dir } = profileFixture({ eol: '\r\n' })
    const file = path.join(dir, 'cordis.patch.yml')
    const plan = planApply({ profileDir: dir, itemId: 'llm:gemini', listenPort: 8794, target: 'generativelanguage.googleapis.com:443' })
    commitApply({ profileDir: dir, plan })
    const after = fs.readFileSync(file, 'utf8')
    assert.equal(/(^|[^\r])\n/.test(after), false, 'every newline must be preceded by \\r in a CRLF file')
    assert.match(after, /baseURL: http:\/\/127\.0\.0\.1:8794\/v1beta\/openai/)
    assert.match(after, /# keep this comment/, 'the header comment must survive')
  } finally {
    restore()
  }
})

test('a profile path with spaces and non-ASCII characters round-trips', async () => {
  const restore = isolateHome()
  try {
    const { dir, raw } = profileFixture({ name: 'egress xplat prof ile 中文 ' })
    const file = path.join(dir, 'cordis.patch.yml')
    const plan = planApply({ profileDir: dir, itemId: 'llm:gemini', listenPort: 8795, target: 'generativelanguage.googleapis.com:443' })
    commitApply({ profileDir: dir, plan })
    assert.notEqual(fs.readFileSync(file, 'utf8'), raw)
    rollbackLast({ routeId: 'llm:gemini', force: true })
    assert.equal(fs.readFileSync(file, 'utf8'), raw, 'rollback must restore the exact bytes')
  } finally {
    restore()
  }
})

test('IPv6 targets are accepted and IPv6 loopback is refused', () => {
  assert.equal(isTarget('[2606:4700:4700::1111]:443'), true)
  assert.equal(isTarget('2606:4700:4700::1111:443'), false, 'an unbracketed IPv6 host is ambiguous')
  const route = buildRelayRoute({ id: 'relay:v6', target: '[2606:4700:4700::1111]:443', listenPort: 8901 })
  assert.equal(route.target, '[2606:4700:4700::1111]:443')
  assert.equal(routeKind(route), 'relay')
  assert.throws(
    () => buildRelayRoute({ id: 'relay:v6loop', target: '[::1]:443', listenPort: 8902 }),
    (err) => err.code === 'loopback_target',
  )
})

test('two concurrent applies are serialised, not interleaved', async () => {
  const profile = profileFixture({ providers: { gemini: 'https://generativelanguage.googleapis.com/v1beta/openai', moonshot: 'https://api.moonshot.cn/v1' } })
  const restore = isolateHome()
  const registrations = []
  const lifecycle = []
  const ctx = {
    logger: { info() {} },
    inject(_services, factory) {
      factory({ webServer: { register(route) { registrations.push(route); return () => {} } } })
    },
    on(event, handler) { lifecycle.push({ event, handler }) },
  }
  // Two providers in one fixture file: patch both blocks so each apply can find its key.
  const file = path.join(profile.dir, 'cordis.patch.yml')
  const doc = yaml.load(fs.readFileSync(file, 'utf8'))
  doc[0].config.providers.moonshot = { displayName: 'Moonshot', baseURL: 'https://api.moonshot.cn/v1', apiKeyEnv: 'MOONSHOT_API_KEY' }
  fs.writeFileSync(file, '# keep this comment\n' + yaml.dump(doc))

  await apply(ctx, { profileDir: profile.dir, routes: [], proxies: {}, verifyAfterApply: false })
  const server = http.createServer(registrations[0].handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port + '/plugins/egress-router'
  const post = async (body) => {
    const res = await fetch(base + '?op=apply', {
      method: 'POST',
      headers: WRITE_HEADERS,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    })
    return { status: res.status, data: await res.json().catch(() => ({})) }
  }
  try {
    const [first, second] = await Promise.all([
      post({ itemId: 'llm:gemini', target: 'generativelanguage.googleapis.com:443', listenPort: 8796 }),
      post({ itemId: 'llm:moonshot', target: 'api.moonshot.cn:443', listenPort: 8797 }),
    ])
    assert.equal(first.status, 200, JSON.stringify(first.data))
    assert.equal(second.status, 200, JSON.stringify(second.data))
    const state = readState()
    assert.deepEqual(validateState(state).errors, [])
    assert.deepEqual(state.routes.map((route) => route.id).sort(), ['llm:gemini', 'llm:moonshot'])
    assert.equal(state.listeners.filter((listener) => listener.ok).length, 2)
    const applied = state.history.filter((entry) => entry.op === 'apply')
    assert.equal(applied.length, 2, 'one history row per apply: ' + JSON.stringify(state.history))
    const patched = fs.readFileSync(file, 'utf8')
    assert.match(patched, /127\.0\.0\.1:8796/)
    assert.match(patched, /127\.0\.0\.1:8797/)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    for (const entry of lifecycle) { try { await entry.handler() } catch {} }
    restore()
  }
})

test('the release gates can find npm in a tarball/corepack layout', () => {
  assert.match(describeNpm(), /npm/)
  const version = npmSync(['--version'], { encoding: 'utf8' })
  assert.equal(version.status, 0, version.error ? version.error.message : version.stderr)
  assert.match(String(version.stdout).trim(), /^\d+\.\d+\.\d+/)
})
