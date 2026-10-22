// 0.11.0 — the configuration surface: protected hosts, declared origins, declarative
// discovery rules, and the bot map that moved out of state.json.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { discover, applyRules, guardedHosts, isGuarded } from '../lib/discovery/index.js'
import { knownOriginTarget } from '../lib/patcher.js'
import { readBots, writeBot, botsPath, statePath, stateDir, readState } from '../lib/store.js'
import { STATE_VERSION, validateState } from '../lib/schema.js'

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function withHome(fn) {
  const home = tmp('egress-config-home-')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return Promise.resolve()
    .then(() => fn(home))
    .finally(() => {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    })
}

function fixtureProfile(extra = []) {
  const dir = tmp('egress-config-profile-')
  const patch = [
    {
      id: 'llm-pi-ai',
      name: '@deepseek-ai/dsh-llm-pi-ai',
      config: {
        providers: {
          gemini: { displayName: 'Gemini', api: 'openai-completions', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai' },
          kimi: { displayName: 'Kimi', api: 'openai-completions', baseURL: 'https://api.moonshot.cn/v1' },
          sso: { displayName: 'SSO', api: 'openai-completions', baseURL: 'https://sso.example.test/v1' },
        },
      },
    },
    { id: 'some-plugin', name: 'some-plugin', config: { endpoint: 'https://api.unknown-service.example/v2' } },
    ...extra,
  ]
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '# fixture\n' + JSON.stringify(patch))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'profile', dsh: { profile: { bundles: ['@deepseek-ai/dsh-llm-pi-ai'] } } }))
  return dir
}

test('config.guarded appends hosts and normalizes pasted URLs', () => {
  const list = guardedHosts(['https://SSO.Example.Test/login?x=1', 'registry.npmjs.org'])
  assert.ok(list.includes('sso.example.test'), 'a pasted URL becomes a host')
  assert.equal(list.filter((host) => host === 'registry.npmjs.org').length, 1, 'built-ins are not duplicated')
  assert.ok(isGuarded('api.sso.example.test', list), 'suffix match guards subdomains')
  assert.ok(!isGuarded('evil-sso.example.test', list), 'a lookalike suffix is not a subdomain')
})

test('discovery lists config.guarded hosts and flags providers on them', () => {
  const dir = fixtureProfile()
  const result = discover({ profileDir: dir, guarded: ['sso.example.test'] })
  assert.ok(result.guardedHosts.includes('sso.example.test'))
  const row = result.items.find((item) => item.id === 'guarded:sso.example.test')
  assert.ok(row, 'the protected list is visible in the page')
  assert.match(row.source, /config\.guarded/)
  const sso = result.items.find((item) => item.id === 'llm:sso')
  assert.equal(sso.guarded, true, 'a provider on a protected host is marked')
})

test('declarative rules rename, re-classify and can unmark a provider', () => {
  const dir = fixtureProfile()
  const result = discover({
    profileDir: dir,
    discovery: {
      rules: [
        { id: 'internal-api', match: { hostSuffix: 'unknown-service.example' }, kind: 'custom', name: 'Internal API', confidence: 'certain', note: 'owned by infra' },
        { id: 'no-apply-gemini', match: { id: 'llm:gemini' }, patchable: false },
      ],
    },
  })
  assert.equal(result.rulesApplied, 2)
  const internal = result.items.find((item) => item.id.startsWith('cfg:api.unknown-service.example'))
  assert.equal(internal.name, 'Internal API')
  assert.equal(internal.kind, 'custom')
  assert.equal(internal.rule, 'internal-api')
  const gemini = result.items.find((item) => item.id === 'llm:gemini')
  assert.equal(gemini.patchable, false, 'a rule may veto the apply button')
  assert.equal(result.items.find((item) => item.id === 'llm:kimi').patchable, true, 'other rows keep their verdict')
})

test('config.discovery.ignore removes rows entirely', () => {
  const dir = fixtureProfile()
  const result = discover({ profileDir: dir, discovery: { ignore: ['unknown-service.example'] } })
  assert.equal(result.items.some((item) => String(item.id).includes('unknown-service')), false)
})

test('applyRules matches on id, kind, host and urlIncludes; first rule wins', () => {
  const rows = [
    { id: 'cfg:a', kind: 'other', baseURL: 'https://a.example.test/v1', target: 'a.example.test:443' },
    { id: 'llm:b', kind: 'llm', baseURL: 'https://gw.corp.test/openai', target: 'gw.corp.test:443' },
  ]
  const { items, matched } = applyRules(rows, {
    rules: [
      { id: 'by-url', match: { urlIncludes: '/openai' }, name: 'Gateway' },
      { id: 'by-host', match: { host: 'a.example.test' }, name: 'A (host)' },
      { id: 'by-kind', match: { kind: 'other' }, name: 'never used' },
    ],
  })
  assert.equal(matched, 2)
  assert.equal(items[0].name, 'A (host)')
  assert.equal(items[1].name, 'Gateway')
})

test('config.origins supplies the real endpoint when no ledger record exists', () =>
  withHome(() => {
    assert.equal(knownOriginTarget('acme'), null, 'an unknown provider has no built-in endpoint')
    assert.equal(knownOriginTarget('acme', { acme: 'https://gateway.acme.test/v2' }), 'gateway.acme.test:443')
    assert.equal(knownOriginTarget('gemini', {}), 'generativelanguage.googleapis.com:443', 'built-ins still work')
  }))

test('the bot map lives in bots.json and leaves state.json alone', () =>
  withHome(() => {
    writeBot('telegram', { proxy: 'clash', url: 'http://127.0.0.1:7897' })
    const file = botsPath()
    assert.ok(fs.existsSync(file), 'bots.json is created')
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(parsed.version, 1)
    assert.equal(parsed.bots.telegram.proxy, 'clash')
    assert.equal(readBots().telegram.proxy, 'clash')
    assert.equal(Object.prototype.hasOwnProperty.call(readState(), 'bots'), false, 'no second copy in state')
    writeBot('telegram', null)
    assert.deepEqual(readBots(), {})
  }))

test('a pre-v10 state.json is migrated into bots.json exactly once', () =>
  withHome(() => {
    fs.mkdirSync(stateDir(), { recursive: true })
    fs.writeFileSync(statePath(), JSON.stringify({
      version: 9,
      routes: [],
      bots: { telegram: { proxy: 'clash', url: 'http://127.0.0.1:7897' } },
    }))
    const bots = readBots()
    assert.equal(bots.telegram.proxy, 'clash')
    assert.equal(JSON.parse(fs.readFileSync(botsPath(), 'utf8')).bots.telegram.proxy, 'clash')
    assert.equal(Object.prototype.hasOwnProperty.call(readState(), 'bots'), false)
    assert.equal(readBots().telegram.proxy, 'clash', 'the file is now the source of truth')
  }))

test('state v10 validates without a bots field', () =>
  withHome(() => {
    const state = readState()
    assert.equal(STATE_VERSION, 10)
    assert.equal(state.version, 10)
    assert.equal(Object.prototype.hasOwnProperty.call(state, 'bots'), false)
    const check = validateState(state)
    assert.equal(check.ok, true, JSON.stringify(check.errors))
  }))
