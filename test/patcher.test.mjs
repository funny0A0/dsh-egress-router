// 0.2.1: the plugin owns its routes in state, so a config write only touches baseURL.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import { planApply, commitApply, rollbackLast } from '../lib/patcher.js'
import { readRoutes, writeRoutes } from '../lib/store.js'

function fixtureProfile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-patch-'))
  const doc = [{
    id: 'llm-pi-ai',
    name: '@deepseek-ai/dsh-llm-pi-ai',
    config: { providers: { gemini: { displayName: 'Gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKeyEnv: 'GEMINI_API_KEY' } } },
  }]
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '# original\n' + yaml.dump(doc))
  return dir
}

function withHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  writeRoutes([])
  return () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

function readPatch(dir) {
  return yaml.load(fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8'))
}

test('apply rewrites baseURL, keeps comments, and never inserts the plugin itself', () => {
  const restore = withHome()
  try {
    const dir = fixtureProfile()
    const plan = planApply({ profileDir: dir, itemId: 'llm:gemini', listenPort: 8791, target: 'generativelanguage.googleapis.com:443', proxy: 'clash' })
    assert.equal(plan.after, 'http://127.0.0.1:8791/v1beta/openai')
    assert.equal(plan.route.proxy, 'clash')
    const written = commitApply({ profileDir: dir, plan })
    assert.ok(fs.existsSync(written.backup))

    const text = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')
    assert.match(text, /# original/)
    const parsed = readPatch(dir)
    assert.equal(parsed[0].config.providers.gemini.baseURL, 'http://127.0.0.1:8791/v1beta/openai')
    assert.equal(parsed[0].config.providers.gemini.apiKeyEnv, 'GEMINI_API_KEY')
    assert.equal(parsed.find((entry) => entry.id === 'egress-router'), undefined, 'no self-insertion into the patch')
    // Routes live in state, not in the user's config.
    assert.equal(readRoutes().length, 0)
  } finally {
    restore()
  }
})

test('a second apply replaces the route instead of duplicating it', () => {
  const restore = withHome()
  try {
    const dir = fixtureProfile()
    writeRoutes([])
    for (const port of [8791, 8792]) {
      const plan = planApply({ profileDir: dir, itemId: 'llm:gemini', listenPort: port, target: 'generativelanguage.googleapis.com:443' })
      commitApply({ profileDir: dir, plan })
      writeRoutes([plan.route])
    }
    assert.equal(readRoutes().length, 1)
    assert.equal(readRoutes()[0].listenPort, 8792)
  } finally {
    restore()
  }
})

test('an omitted proxy keeps the existing one; an explicit value replaces it', () => {
  const restore = withHome()
  try {
    const dir = fixtureProfile()
    writeRoutes([{ id: 'llm:gemini', target: 'generativelanguage.googleapis.com:443', listenPort: 8791, proxy: 'clash' }])
    const kept = planApply({ profileDir: dir, itemId: 'llm:gemini', listenPort: 8792, target: 'generativelanguage.googleapis.com:443' })
    assert.equal(kept.route.proxy, 'clash', 're-apply must not silently downgrade to direct')
    const swapped = planApply({ profileDir: dir, itemId: 'llm:gemini', listenPort: 8791, target: 'generativelanguage.googleapis.com:443', proxy: 'other' })
    assert.equal(swapped.route.proxy, 'other')
  } finally {
    restore()
  }
})

test('rollback restores the previous baseURL and reports which route it undid', () => {
  const restore = withHome()
  try {
    const dir = fixtureProfile()
    const before = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')
    const plan = planApply({ profileDir: dir, itemId: 'llm:gemini', listenPort: 8791, target: 'generativelanguage.googleapis.com:443' })
    commitApply({ profileDir: dir, plan })
    const restored = rollbackLast({ routeId: 'llm:gemini' })
    assert.equal(restored.restored, 'https://generativelanguage.googleapis.com/v1beta/openai')
    assert.equal(restored.routeId, 'llm:gemini')
    assert.equal(restored.listenPort, 8791)
    assert.equal(fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8'), before)
  } finally {
    restore()
  }
})

test('apply refuses an unknown provider with a 400', () => {
  const restore = withHome()
  try {
    const dir = fixtureProfile()
    assert.throws(
      () => planApply({ profileDir: dir, itemId: 'llm:nope', listenPort: 8791, target: 'example.com:443' }),
      (err) => err.status === 400 && err.code === 'provider_not_found',
    )
  } finally {
    restore()
  }
})

test('apply refuses non-llm items and bad targets', () => {
  const restore = withHome()
  try {
    const dir = fixtureProfile()
    assert.throws(() => planApply({ profileDir: dir, itemId: 'im:telegram', listenPort: 8791, target: 'api.telegram.org:443' }), (err) => err.code === 'not_patchable')
    assert.throws(() => planApply({ profileDir: dir, itemId: 'llm:gemini', listenPort: 8791, target: 'nonsense' }), (err) => err.code === 'invalid_target')
  } finally {
    restore()
  }
})

test('rollback with no backup is a 400, and an unknown route id is too', () => {
  const restore = withHome()
  try {
    assert.throws(() => rollbackLast(), (err) => err.status === 400 && err.code === 'no_backup')
    assert.throws(() => rollbackLast({ routeId: 'llm:none' }), (err) => err.status === 400 && err.code === 'no_backup')
  } finally {
    restore()
  }
})
