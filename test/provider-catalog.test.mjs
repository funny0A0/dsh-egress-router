// 0.13.0 — providers imported through the app store only models + apiKeyEnv; the host
// resolves baseURL from its pi-ai catalog at runtime. These tests pin the same lookup and
// the apply path that writes the missing baseURL into cordis.patch.yml.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import {
  builtinEndpoints,
  catalogCandidates,
  readProviderCatalog,
  resolveProviderEndpoint,
} from '../lib/provider-catalog.js'
import { discover } from '../lib/discovery/index.js'
import { commitApply, knownOriginTarget, planApply, rollbackLast, findProvider } from '../lib/patcher.js'

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function withHome(fn) {
  const home = tmp('egress-catalog-home-')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return Promise.resolve()
    .then(() => fn(home))
    .finally(() => {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    })
}

function withCatalogDir(fn) {
  const dir = tmp('egress-pi-ai-')
  const catalog = {
    'openai-completions': {
      'chat:kimi-k2.6': {
        id: 'kimi-k2.6',
        name: 'Kimi K2.6',
        api: 'openai-completions',
        provider: 'moonshotai-cn',
        baseUrl: 'https://api.moonshot.cn/v1',
        type: 'chat',
      },
    },
  }
  fs.writeFileSync(path.join(dir, 'moonshotai-cn.json'), JSON.stringify(catalog))
  const previous = process.env.EGRESS_PI_AI_DIR
  process.env.EGRESS_PI_AI_DIR = dir
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      if (previous === undefined) delete process.env.EGRESS_PI_AI_DIR
      else process.env.EGRESS_PI_AI_DIR = previous
    })
}

// A profile whose provider was imported by the app: no baseURL, no api, only models.
function importedProfile() {
  const dir = tmp('egress-catalog-profile-')
  const patch = [
    '# user notes',
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '  config:',
    '    providers:',
    '      moonshotai-cn:',
    '        displayName: Moonshot CN',
    '        apiKeyEnv: MOONSHOTAI_CN_API_KEY',
    '        models:',
    '          - kimi-k2.6',
    '      mystery:',
    '        displayName: Mystery',
    '        apiKeyEnv: MYSTERY_API_KEY',
    '',
  ].join('\n')
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), patch)
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'profile', dsh: { profile: { bundles: ['@deepseek-ai/dsh-llm-pi-ai'] } } }),
  )
  return dir
}

test('the bundled catalog is read without Electron asar support', () => {
  const real = readProviderCatalog('google', { dirs: catalogCandidates({ resourcesPath: 'D:/dsh/resources' }) })
  if (!real) {
    // The desktop install is not part of CI; the fixture tests below still cover the parser.
    assert.ok(true)
    return
  }
  assert.equal(real.api, 'google-generative-ai')
  assert.match(real.baseURL, /^https:\/\/generativelanguage\.googleapis\.com/)
})

test('catalog lookup returns baseURL, api and model count', () => {
  return withCatalogDir(() => {
    const entry = readProviderCatalog('moonshotai-cn')
    assert.equal(entry.baseURL, 'https://api.moonshot.cn/v1')
    assert.equal(entry.api, 'openai-completions')
    assert.equal(entry.models, 1)
    assert.equal(readProviderCatalog('../escape'), null, 'path traversal is not a provider key')
  })
})

test('resolution precedence is config > providerDefaults > catalog > builtin', () => {
  return withCatalogDir(() => {
    assert.equal(resolveProviderEndpoint('moonshotai-cn', { baseURL: 'https://literal.example/v1' }).source, 'config')
    assert.equal(
      resolveProviderEndpoint('moonshotai-cn', { providerDefaults: { 'moonshotai-cn': 'https://declared.example/v1' } }).source,
      'providerDefaults',
    )
    assert.equal(resolveProviderEndpoint('moonshotai-cn').source, 'catalog')
    assert.equal(resolveProviderEndpoint('deepseek').source, 'builtin')
    assert.equal(resolveProviderEndpoint('mystery'), null)
    assert.ok(Object.keys(builtinEndpoints()).includes('google'))
  })
})

test('discovery gives an imported provider a target and marks the endpoint source', () => {
  return withCatalogDir(() => {
    const dir = importedProfile()
    const result = discover({ profileDir: dir })
    const row = result.items.find((item) => item.id === 'llm:moonshotai-cn')
    assert.equal(row.baseURL, 'https://api.moonshot.cn/v1')
    assert.equal(row.target, 'api.moonshot.cn:443')
    assert.equal(row.endpointSource, 'catalog')
    assert.equal(row.api, 'openai-completions')
    assert.equal(row.patchable, true, 'the row now offers apply in the UI')
    const mystery = result.items.find((item) => item.id === 'llm:mystery')
    assert.equal(mystery.target, null, 'unknown providers stay read-only')
    assert.equal(mystery.endpointSource, null)
  })
})

test('config.providerDefaults wins over the catalog in discovery', () => {
  return withCatalogDir(() => {
    const result = discover({
      profileDir: importedProfile(),
      providerDefaults: { 'moonshotai-cn': { baseURL: 'https://gateway.example.test/v1', api: 'openai-completions' } },
    })
    const row = result.items.find((item) => item.id === 'llm:moonshotai-cn')
    assert.equal(row.target, 'gateway.example.test:443')
    assert.equal(row.endpointSource, 'providerDefaults')
  })
})

test('apply inserts baseURL and api for a provider that had neither, and rollback restores it', () => {
  return withHome(() => withCatalogDir(async () => {
    const dir = importedProfile()
    const file = path.join(dir, 'cordis.patch.yml')
    const original = fs.readFileSync(file, 'utf8')
    const plan = planApply({
      profileDir: dir,
      itemId: 'llm:moonshotai-cn',
      listenPort: 8899,
      target: 'api.moonshot.cn:443',
    })
    assert.equal(plan.before, null)
    assert.equal(plan.after, 'http://127.0.0.1:8899/v1')
    assert.equal(plan.insertApi, 'openai-completions')
    const written = commitApply({ profileDir: dir, plan })
    assert.equal(written.format, 'surgical')
    const parsed = yaml.load(fs.readFileSync(file, 'utf8'))
    const provider = findProvider(parsed, 'moonshotai-cn').provider
    assert.equal(provider.baseURL, 'http://127.0.0.1:8899/v1')
    assert.equal(provider.api, 'openai-completions')
    assert.match(fs.readFileSync(file, 'utf8'), /# user notes/, 'comments survive the write')
    rollbackLast({})
    assert.equal(fs.readFileSync(file, 'utf8'), original, 'rollback restores the file byte for byte')
  }))
})

test('a stuck loopback provider is recoverable from the catalog alone', () => {
  return withHome(() => withCatalogDir(async () => {
    const dir = importedProfile()
    const file = path.join(dir, 'cordis.patch.yml')
    const doc = yaml.load(fs.readFileSync(file, 'utf8'))
    findProvider(doc, 'moonshotai-cn').provider.baseURL = 'http://127.0.0.1:7001/v1'
    fs.writeFileSync(file, '# user notes\n' + JSON.stringify(doc, null, 2) + '\n')
    assert.equal(knownOriginTarget('moonshotai-cn'), 'api.moonshot.cn:443')
  }))
})

test('providerDefaults alone can rebuild an endpoint without any catalog', () => {
  return withHome(async () => {
    assert.equal(
      knownOriginTarget('mystery', {}, { mystery: 'https://mystery.example.test/v2' }),
      'mystery.example.test:443',
    )
  })
})