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
  isCoreApi,
  readProviderCatalog,
  resolveProviderEndpoint,
} from '../lib/provider-catalog.js'
import { discover } from '../lib/discovery/index.js'
import { commitApply, knownOriginTarget, planApply, repairInvalidApis, rollbackLast, findProvider } from '../lib/patcher.js'

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
  // A catalog entry whose protocol name is NOT one llm-pi-ai's settings schema accepts.
  // Writing this value into a provider block is exactly the 0.13.0 regression.
  const google = {
    'google-generative-ai': {
      'chat:gemini-3.8-flash': {
        id: 'gemini-3.8-flash',
        name: 'Gemini 3.8 Flash',
        api: 'google-generative-ai',
        provider: 'google',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        type: 'chat',
      },
    },
  }
  fs.writeFileSync(path.join(dir, 'google.json'), JSON.stringify(google))
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
    assert.equal(row.api, null, 'the row does not claim a protocol it never wrote')
    assert.equal(row.catalogApi, 'openai-completions')
    assert.equal(row.reuseCatalog, true, 'the host owns this provider, so api must stay absent')
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

test('apply writes only baseURL for a catalog-backed provider and rollback restores it', () => {
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
    // 0.13.1: llm-pi-ai's schema accepts only three protocol names and a catalog-backed
    // provider must leave `api` absent, so this write must not add one.
    assert.equal(plan.insertApi, null)
    const written = commitApply({ profileDir: dir, plan })
    assert.equal(written.format, 'surgical')
    const parsed = yaml.load(fs.readFileSync(file, 'utf8'))
    const provider = findProvider(parsed, 'moonshotai-cn').provider
    assert.equal(provider.baseURL, 'http://127.0.0.1:8899/v1')
    assert.equal(provider.api, undefined, 'no api line is added for a catalog provider')
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /^\s+api:/m)
    assert.match(fs.readFileSync(file, 'utf8'), /# user notes/, 'comments survive the write')
    rollbackLast({})
    assert.equal(fs.readFileSync(file, 'utf8'), original, 'rollback restores the file byte for byte')
  }))
})

test('a catalog protocol name is rejected instead of written', () => {
  return withHome(() => withCatalogDir(async () => {
    const dir = importedProfile()
    assert.equal(isCoreApi('google-generative-ai'), false)
    assert.throws(
      () => planApply({
        profileDir: dir,
        itemId: 'llm:moonshotai-cn',
        listenPort: 8899,
        target: 'api.moonshot.cn:443',
        providerDefaults: { 'moonshotai-cn': { baseURL: 'https://api.moonshot.cn/v1', api: 'google-generative-ai' } },
      }),
      /unsupported_api|must be one of/,
    )
    const plan = planApply({
      profileDir: dir,
      itemId: 'llm:moonshotai-cn',
      listenPort: 8899,
      target: 'api.moonshot.cn:443',
      providerDefaults: { 'moonshotai-cn': { baseURL: 'https://api.moonshot.cn/v1', api: 'openai-completions' } },
    })
    assert.equal(plan.insertApi, null, 'catalog-backed providers never get an api, even a valid one')
    assert.match(plan.warnings.join('\n'), /ignored: the host catalog already implements this provider/)
  }))
})

test('boot repair removes a catalog protocol name and leaves unknown providers alone', () => {
  return withHome(() => withCatalogDir(async () => {
    const dir = importedProfile()
    const file = path.join(dir, 'cordis.patch.yml')
    const broken = fs.readFileSync(file, 'utf8')
      .replace('      mystery:\n', '      google:\n        api: google-generative-ai\n        baseURL: https://generativelanguage.googleapis.com/v1beta\n      mystery:\n')
    fs.writeFileSync(file, broken)
    const report = repairInvalidApis({ profileDir: dir })
    assert.deepEqual(report.removed, [{ key: 'google', api: 'google-generative-ai' }])
    const after = fs.readFileSync(file, 'utf8')
    assert.doesNotMatch(after, /google-generative-ai/, 'the offending value is gone')
    assert.match(after, /google:\n\s+baseURL: https:\/\/generativelanguage\.googleapis\.com\/v1beta/, 'baseURL stays')
    assert.ok(report.backup && fs.existsSync(report.backup), 'a backup is written before the repair')
    const doc = yaml.load(after)
    assert.equal(findProvider(doc, 'google').provider.api, undefined)
    // An unknown provider keeps its value: deleting it would swap a schema error for a
    // runtime "this build cannot serve" error.
    fs.appendFileSync(file, '      unknown-one:\n        api: not-a-protocol\n')
    const second = repairInvalidApis({ profileDir: dir })
    assert.deepEqual(second.kept, [{ key: 'unknown-one', api: 'not-a-protocol' }])
    assert.match(fs.readFileSync(file, 'utf8'), /not-a-protocol/)
  }))
})

test('the plugin repairs the file on boot, before anything else reads it', () => {
  const source = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(source, /repairInvalidApis\(\{ profileDir/)
  assert.match(source, /op: 'config-repair'/)
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