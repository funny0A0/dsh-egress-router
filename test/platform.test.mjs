// 0.7.1 - the same code has to run on Windows and Linux. The things that differ in
// practice: how paths are walked, which characters a file name may contain, and whether
// an edited text file keeps LF endings (a .env parser that sees "\r" treats the value as
// part of the URL).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import { planApply, commitApply } from '../lib/patcher.js'
import { readRoutes, writeRoutes, stateDir } from '../lib/store.js'
import { applyBotProxy } from '../lib/bots.js'

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + process.pid + '-' + Date.now() + '-'))
}

function withHome(fn) {
  return async () => {
    const home = tempDir('egress-plat-home-')
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    writeRoutes([])
    try {
      await fn(home)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  }
}

function profileFixture() {
  const dir = tempDir('egress-plat-profile-')
  const doc = [{
    id: 'llm-pi-ai',
    name: '@deepseek-ai/dsh-llm-pi-ai',
    config: { providers: { gemini: { displayName: 'Gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKeyEnv: 'GEMINI_API_KEY' } } },
  }]
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '# original\n' + yaml.dump(doc))
  return dir
}

test('backup file names are legal on Windows and keep a stable suffix', withHome(async () => {
  const dir = profileFixture()
  const plan = planApply({ profileDir: dir, itemId: 'llm:gemini', listenPort: 8794, target: 'generativelanguage.googleapis.com:443' })
  commitApply({ profileDir: dir, plan })
  const backups = fs.readdirSync(path.join(stateDir(), 'backups'))
  assert.ok(backups.length >= 1)
  for (const name of backups) {
    assert.equal(name.includes(':'), false, 'a colon is illegal in a Windows file name: ' + name)
    assert.equal(/[<>"|?*]/.test(name), false, 'reserved character in ' + name)
    assert.match(name, /^cordis\.patch\.yml\..+\.bak$/)
  }
}))

test('state.json is written with LF endings only', withHome(async (home) => {
  const dir = profileFixture()
  const plan = planApply({ profileDir: dir, itemId: 'llm:gemini', listenPort: 8794, target: 'generativelanguage.googleapis.com:443' })
  commitApply({ profileDir: dir, plan })
  const raw = fs.readFileSync(path.join(home, 'storages', 'egress-router', 'state.json'), 'utf8')
  assert.equal(raw.includes('\r'), false)
}))

test('re-applying a bot proxy stays in-process and leaves .env alone', withHome(async (home) => {
  const dir = profileFixture()
  const imRoot = path.join(dir, 'node_modules', '@xmanrui', 'dsh-im')
  const imDir = path.join(imRoot, 'lib')
  fs.mkdirSync(imDir, { recursive: true })
  fs.writeFileSync(path.join(imRoot, 'package.json'), JSON.stringify({ name: '@xmanrui/dsh-im', version: '5.1.0', main: 'lib/index.js' }))
  fs.writeFileSync(path.join(imDir, 'index.js'), 'var transport = new Agent({ connections: 4 })\n')
  const definitions = [{
    id: 'telegram-proxy',
    package: '@xmanrui/dsh-im',
    versions: ['5.'],
    file: 'lib/index.js',
    marker: 'DSH_TELEGRAM_PROXY',
    find: 'new Agent({ connections: 4 })',
    replace: 'new Agent({ connections: 4, proxy: process.env.DSH_TELEGRAM_PROXY || "http://127.0.0.1:7897" })',
  }]
  const proxies = { clash: 'http://127.0.0.1:7897' }
  const envFile = path.join(home, '.env')
  const original = 'NO_PROXY=localhost\n'
  fs.writeFileSync(envFile, original)
  const args = { id: 'telegram', proxyName: 'clash', proxies, profileDir: dir, stateDir: path.join(home, 'storages', 'egress-router'), definitions }
  applyBotProxy(args)
  applyBotProxy(args)
  assert.equal(process.env.DSH_TELEGRAM_PROXY, 'http://127.0.0.1:7897', 'the value must be in the process environment')
  assert.equal(fs.readFileSync(envFile, 'utf8'), original, 'the launcher rejects this name in .env, so it must never be written')
}))
