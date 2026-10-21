import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-loop-'))

function profile() {
  const doc = [{
    id: 'llm-pi-ai',
    config: {
      providers: {
        openrouter: { api: 'openai-completions', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' },
      },
    },
  }]
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '# keep this comment\n' + yaml.dump(doc))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'profile', dsh: { profile: { bundles: [] } } }))
  return dir
}

function withHome(fn) {
  return async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-home-'))
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try { await fn() } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  }
}

const baseURLOf = (file, key) => {
  const doc = yaml.load(fs.readFileSync(file, 'utf8'))
  return doc.find((entry) => entry.id === 'llm-pi-ai').config.providers[key].baseURL
}

test('undo walks back past a re-apply to the real endpoint', withHome(async () => {
  const { planApply, commitApply, rollbackLast } = await import('../lib/patcher.js')
  const profileDir = profile()
  const file = path.join(profileDir, 'cordis.patch.yml')

  const first = planApply({ profileDir, itemId: 'llm:openrouter', listenPort: 8791, target: 'openrouter.ai:443' })
  assert.equal(first.after, 'http://127.0.0.1:8791/api/v1')
  commitApply({ profileDir, plan: first })

  // Applying again sees a loopback baseURL; the ledger must still remember the real one.
  const second = planApply({ profileDir, itemId: 'llm:openrouter', listenPort: 8791, target: 'openrouter.ai:443' })
  assert.equal(second.route.originBaseURL, 'https://openrouter.ai/api/v1')
  commitApply({ profileDir, plan: second })

  const undone = rollbackLast({ routeId: 'llm:openrouter' })
  assert.equal(undone.originRestored, true, 'undo should restore the real endpoint, not the relay URL')
  assert.equal(baseURLOf(file, 'openrouter'), 'https://openrouter.ai/api/v1')
}))

test('the ledger remembers the real endpoint for a loopback row', withHome(async () => {
  const { planApply, commitApply, knownOriginTarget } = await import('../lib/patcher.js')
  const profileDir = profile()
  const plan = planApply({ profileDir, itemId: 'llm:openrouter', listenPort: 8791, target: 'openrouter.ai:443' })
  commitApply({ profileDir, plan })
  assert.equal(knownOriginTarget('openrouter'), 'openrouter.ai:443')
}))

test('a row still pointing at a removed relay is flagged, not shown as its own target', withHome(async () => {
  const { planApply, commitApply } = await import('../lib/patcher.js')
  const { discover } = await import('../lib/discovery/index.js')
  const profileDir = profile()
  const plan = planApply({ profileDir, itemId: 'llm:openrouter', listenPort: 8791, target: 'openrouter.ai:443' })
  commitApply({ profileDir, plan })
  // Simulate the relay being undone while the provider keeps the loopback URL.
  const result = discover({ profileDir, routes: [] })
  const row = result.items.find((item) => item.id === 'llm:openrouter')
  assert.equal(row.routed, false)
  assert.equal(row.stale, true)
  assert.equal(row.target, 'openrouter.ai:443')
}))
test('a provider with no record still recovers its well-known public endpoint', async () => {
  const { knownOriginTarget } = await import('../lib/patcher.js')
  assert.equal(knownOriginTarget('openrouter'), 'openrouter.ai:443')
  assert.equal(knownOriginTarget('gemini'), 'generativelanguage.googleapis.com:443')
  assert.equal(knownOriginTarget('no-such-provider'), null)
})
