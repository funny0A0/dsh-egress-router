import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { discover } from '../lib/discovery/index.js'

function fixtureProfile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-profile-'))
  const patch = [
    {
      id: 'llm-pi-ai',
      name: '@deepseek-ai/dsh-llm-pi-ai',
      config: {
        providers: {
          gemini: { displayName: 'Gemini', api: 'openai-completions', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKeyEnv: 'GEMINI_API_KEY' },
          kimi: { displayName: 'Kimi', api: 'openai-completions', baseURL: 'https://api.moonshot.cn/v1', apiKeyEnv: 'KIMI_CODING_API_KEY' },
        },
      },
    },
    { id: 'xmanrui-dsh-im', name: '@xmanrui/dsh-im', config: { channels: { telegram: { enabled: true } } } },
    { id: 'some-plugin', name: 'some-plugin', config: { endpoint: 'https://api.unknown-service.example/v2' } },
  ]
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '# fixture\n' + JSON.stringify(patch))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'profile', dsh: { profile: { bundles: ['@deepseek-ai/dsh-llm-pi-ai', '@xmanrui/dsh-im', 'dsh-egress-router'] } } }))
  return dir
}

test('discovery finds configured providers, telegram and unknown endpoints', () => {
  const dir = fixtureProfile()
  const result = discover({ profileDir: dir })
  const ids = result.items.map((item) => item.id)
  assert.ok(ids.includes('llm:gemini'))
  assert.ok(ids.includes('llm:kimi'))
  assert.ok(ids.includes('im:telegram'))
  assert.ok(ids.some((id) => id.startsWith('cfg:api.unknown-service.example')))
  const gemini = result.items.find((item) => item.id === 'llm:gemini')
  assert.equal(gemini.target, 'generativelanguage.googleapis.com:443')
  assert.equal(gemini.confidence, 'certain')
  const guarded = result.items.filter((item) => item.guarded)
  assert.ok(guarded.length > 0)
  const unknown = result.items.find((item) => item.confidence === 'low')
  assert.ok(unknown && unknown.source.includes('cordis.patch.yml'))
})

test('discovery flags a global proxy in .env', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-home-'))
  fs.writeFileSync(path.join(home, '.env'), 'HTTPS_PROXY=http://127.0.0.1:7897\n')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const result = discover({ profileDir: fixtureProfile() })
    assert.ok(result.warnings.some((warn) => warn.code === 'global-proxy-env'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})
