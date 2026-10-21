// 0.5.1: the host rewrites cordis.patch.yml from its own snapshot, so a routed provider can
// silently fall back to the public host while the listener keeps running. These tests pin
// the detection, the surgical repair, the backup, and the idempotence.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expectedBaseURL, findDrift, pointsAt, repairDrift, providerKeyOf, resetThrottle } from '../lib/reconcile.js'
import { readState, writeRoutes } from '../lib/store.js'

let passed = 0
let failed = 0
async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log('  ok   ' + name)
  } catch (err) {
    failed++
    console.log('  FAIL ' + name + '\n       ' + (err && err.message ? err.message : err))
  }
}

const PROFILE_YAML = [
  '- id: llm-pi-ai',
  '  config:',
  '    providers:',
  '      gemini:',
  '        api: openai-completions',
  '        baseURL: https://generativelanguage.googleapis.com/v1beta/openai',
  '        apiKeyEnv: GEMINI_API_KEY',
  '      openrouter:',
  '        api: openai-completions',
  '        baseURL: http://127.0.0.1:8791/api/v1',
  '        apiKeyEnv: OPENROUTER_API_KEY',
  '',
].join('\n')

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-reconcile-'))
  const profileDir = path.join(home, 'profiles', 'desktop')
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), PROFILE_YAML)
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  resetThrottle()
  return {
    home,
    profileDir,
    routes: [
      { id: 'llm:gemini', target: 'generativelanguage.googleapis.com:443', listenPort: 8792, enabled: true },
      { id: 'llm:openrouter', target: 'openrouter.ai:443', listenPort: 8791, enabled: true },
    ],
    restore() {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      fs.rmSync(home, { recursive: true, force: true })
    },
  }
}

await test('providerKeyOf only maps llm:<provider> routes', () => {
  assert.equal(providerKeyOf({ id: 'llm:gemini' }), 'gemini')
  assert.equal(providerKeyOf({ id: 'im:telegram' }), null)
  assert.equal(providerKeyOf({}), null)
})

await test('expectedBaseURL keeps the provider path and moves host:port', () => {
  assert.equal(expectedBaseURL('https://generativelanguage.googleapis.com/v1beta/openai', 8792), 'http://127.0.0.1:8792/v1beta/openai')
  assert.equal(expectedBaseURL('http://127.0.0.1:8791/api/v1', 9000), 'http://127.0.0.1:9000/api/v1')
  assert.equal(expectedBaseURL('not a url', 8792), null)
})

await test('pointsAt is true only for that loopback port', () => {
  assert.equal(pointsAt('http://127.0.0.1:8792/v1beta/openai', 8792), true)
  assert.equal(pointsAt('http://127.0.0.1:8792/anything', 8792), true)
  assert.equal(pointsAt('http://127.0.0.1:8793/v1beta/openai', 8792), false)
  assert.equal(pointsAt('https://generativelanguage.googleapis.com/v1beta/openai', 8792), false)
})

await test('drift detects the public host and leaves an already-routed provider alone', () => {
  const fx = fixture()
  try {
    const found = findDrift({ profileDir: fx.profileDir, routes: fx.routes })
    assert.equal(found.drift.length, 1)
    assert.equal(found.drift[0].provider, 'gemini')
    assert.equal(found.drift[0].before, 'https://generativelanguage.googleapis.com/v1beta/openai')
    assert.equal(found.drift[0].after, 'http://127.0.0.1:8792/v1beta/openai')
    assert.deepEqual(found.missing, [])
  } finally { fx.restore() }
})

await test('repair rewrites only the drifted provider and keeps the rest byte-identical', () => {
  const fx = fixture()
  try {
    const before = fs.readFileSync(path.join(fx.profileDir, 'cordis.patch.yml'), 'utf8')
    const result = repairDrift({ profileDir: fx.profileDir, routes: fx.routes, reason: 'test' })
    assert.equal(result.repaired.length, 1)
    assert.ok(result.backup && fs.existsSync(result.backup), 'backup must exist')

    const after = fs.readFileSync(path.join(fx.profileDir, 'cordis.patch.yml'), 'utf8')
    assert.ok(after.includes('baseURL: http://127.0.0.1:8792/v1beta/openai'), 'gemini must point at the listener')
    assert.ok(after.includes('baseURL: http://127.0.0.1:8791/api/v1'), 'openrouter must be untouched')
    assert.ok(after.includes('apiKeyEnv: GEMINI_API_KEY'), 'unrelated keys must survive')
    assert.notEqual(after, before)
  } finally { fx.restore() }
})

await test('repair records a reconcile entry in the audit history', () => {
  const fx = fixture()
  try {
    repairDrift({ profileDir: fx.profileDir, routes: fx.routes, reason: 'test' })
    const history = readState().history ?? []
    const last = history[history.length - 1]
    assert.equal(last.op, 'reconcile')
    assert.equal(last.ok, true)
    assert.match(last.detail, /gemini/)
  } finally { fx.restore() }
})

await test('repair is idempotent: a second pass writes nothing', () => {
  const fx = fixture()
  try {
    repairDrift({ profileDir: fx.profileDir, routes: fx.routes })
    const settled = fs.readFileSync(path.join(fx.profileDir, 'cordis.patch.yml'), 'utf8')
    const again = repairDrift({ profileDir: fx.profileDir, routes: fx.routes })
    assert.equal(again.repaired.length, 0)
    assert.equal(fs.readFileSync(path.join(fx.profileDir, 'cordis.patch.yml'), 'utf8'), settled)
  } finally { fx.restore() }
})

await test('a provider the file no longer has is reported as missing, not repaired', () => {
  const fx = fixture()
  try {
    const routes = fx.routes.concat([{ id: 'llm:gone', target: 'gone.example.com:443', listenPort: 8794, enabled: true }])
    const found = findDrift({ profileDir: fx.profileDir, routes })
    assert.equal(found.missing.length, 1)
    assert.equal(found.missing[0].provider, 'gone')
    const result = repairDrift({ profileDir: fx.profileDir, routes })
    assert.equal(result.repaired.length, 1)
    assert.equal(result.missing.length, 1)
  } finally { fx.restore() }
})

await test('a disabled route is never touched', () => {
  const fx = fixture()
  try {
    const routes = [{ id: 'llm:gemini', listenPort: 8792, enabled: false }]
    const found = findDrift({ profileDir: fx.profileDir, routes })
    assert.equal(found.drift.length, 0)
    const result = repairDrift({ profileDir: fx.profileDir, routes })
    assert.equal(result.repaired.length, 0)
  } finally { fx.restore() }
})

await test('a route removed from state is never written back into the config', () => {
  const fx = fixture()
  try {
    const file = path.join(fx.profileDir, 'cordis.patch.yml')
    fs.writeFileSync(file, PROFILE_YAML.replace('http://127.0.0.1:8791/api/v1', 'https://openrouter.ai/api/v1'))
    writeRoutes([{ id: 'llm:gemini', target: 'generativelanguage.googleapis.com:443', listenPort: 8792, enabled: true }])
    repairDrift({ profileDir: fx.profileDir, reason: 'test' })
    const after = fs.readFileSync(file, 'utf8')
    assert.ok(after.includes('http://127.0.0.1:8792/v1beta/openai'), 'the live route must still be repaired')
    assert.ok(after.includes('https://openrouter.ai/api/v1'), 'a route that no longer exists must be left alone')
  } finally { fx.restore() }
})

await test('repairs stop after three rounds when something else keeps rewriting', () => {
  const fx = fixture()
  try {
    resetThrottle()
    const file = path.join(fx.profileDir, 'cordis.patch.yml')
    for (let round = 0; round < 3; round++) {
      fs.writeFileSync(file, PROFILE_YAML)
      assert.equal(repairDrift({ profileDir: fx.profileDir, routes: fx.routes, reason: 'test' }).repaired.length, 1)
    }
    fs.writeFileSync(file, PROFILE_YAML)
    const result = repairDrift({ profileDir: fx.profileDir, routes: fx.routes, reason: 'test' })
    assert.equal(result.repaired.length, 0, 'the fourth round must stand down')
    assert.ok(result.paused.includes('gemini'), 'gemini must be reported as paused')
    const history = readState().history ?? []
    assert.ok(history.some((entry) => entry.op === 'reconcile-paused'), 'the pause must be audited')
  } finally { resetThrottle(); fx.restore() }
})

console.log('reconcile: ' + passed + ' pass, ' + failed + ' fail')
if (failed) process.exit(1)
