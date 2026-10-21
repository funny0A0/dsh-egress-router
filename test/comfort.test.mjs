// 0.6.0 — the comfort fixes: bot proxy persisted for the next boot, reconcile pauses that
// survive a restart, an explicit origin for a provider whose endpoint was lost, and a client
// that explains an empty response instead of echoing a JSON parse error.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyBotProxy, clearBotProxy } from '../lib/bots.js'
import { planApply } from '../lib/patcher.js'
import { pausedProviders, repairDrift, resetThrottle } from '../lib/reconcile.js'
import { readState } from '../lib/store.js'

const ENV = 'DSH_TELEGRAM_PROXY'
const PROXIES = { clash: 'http://127.0.0.1:7897' }
const PATCH = [
  '- id: llm-pi-ai',
  '  config:',
  '    providers:',
  '      gemini:',
  '        baseURL: https://generativelanguage.googleapis.com/v1beta/openai',
  '',
].join('\n')

let seq = 0
function check(name, fn) {
  return (async () => {
    try {
      await fn()
      console.log('ok   ' + name)
    } catch (err) {
      console.log('FAIL ' + name + ' :: ' + (err && err.message))
      process.exitCode = 1
      throw err
    }
  })()
}

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + process.pid + '-' + ++seq + '-'))
}

function makeProfile({ patched = false } = {}) {
  const profileDir = tmp('egress-profile-')
  const pkgDir = path.join(profileDir, 'node_modules', '@xmanrui', 'dsh-im')
  fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@xmanrui/dsh-im', version: '5.1.0' }))
  const anchor = 'new Lze({connections:Uze})'
  const body = patched
    ? 'var t = new Lze({connections:Uze,httpProxy:process.env.DSH_TELEGRAM_PROXY,httpsProxy:process.env.DSH_TELEGRAM_PROXY,noProxy:""});'
    : 'var t = ' + anchor + ';'
  fs.writeFileSync(path.join(pkgDir, 'lib', 'index.js'), body)
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), PATCH)
  return { profileDir }
}

function makeHome() {
  const home = tmp('egress-home-')
  process.env.DSH_HOME = home
  return { home, stateDir: path.join(home, 'storages', 'egress-router') }
}

await check('the bot proxy stays in-process and never touches $DSH_HOME/.env', async () => {
  delete process.env[ENV]
  const { profileDir } = makeProfile()
  const { home, stateDir } = makeHome()
  const envFile = path.join(home, '.env')
  const original = 'NO_PROXY=localhost\n'
  fs.writeFileSync(envFile, original)
  const result = applyBotProxy({ id: 'telegram', proxyName: 'clash', proxies: PROXIES, profileDir, stateDir })
  assert.equal(result.bot.url, 'http://127.0.0.1:7897')
  assert.equal(result.persisted, 'process')
  assert.equal(fs.readFileSync(envFile, 'utf8'), original, 'the launcher rejects this name in .env')
  assert.equal(process.env[ENV], 'http://127.0.0.1:7897')
  clearBotProxy({ id: 'telegram' })
  assert.equal(process.env[ENV], undefined)
  assert.equal(fs.readFileSync(envFile, 'utf8'), original)
})

await check('a reconcile pause is persisted and reported, and reset clears it', async () => {
  const { profileDir } = makeProfile()
  const { stateDir } = makeHome()
  resetThrottle()
  const publicURL = 'https://generativelanguage.googleapis.com/v1beta/openai'
  const routes = [{ id: 'llm:gemini', target: 'generativelanguage.googleapis.com:443', listenPort: 8799, enabled: true }]
  for (let index = 0; index < 3; index += 1) {
    fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), PATCH.replace(publicURL, publicURL))
    repairDrift({ profileDir, routes, reason: 'test' })
  }
  const paused = readState().reconcilePaused
  assert.deepEqual(Object.keys(paused), ['gemini'])
  assert.equal(pausedProviders().length, 1)
  assert.equal(pausedProviders()[0].provider, 'gemini')
  resetThrottle()
  assert.deepEqual(readState().reconcilePaused, {})
  assert.equal(fs.existsSync(path.join(stateDir, 'backups')), true)
})

await check('an explicit origin rebuilds a provider whose endpoint was lost', async () => {
  const { profileDir } = makeProfile()
  makeHome()
  const lost = 'http://127.0.0.1:9999/v1beta/openai'
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), PATCH.replace('https://generativelanguage.googleapis.com/v1beta/openai', lost))
  const origin = 'https://generativelanguage.googleapis.com/v1beta/openai'
  const plan = planApply({
    profileDir,
    itemId: 'llm:gemini',
    listenPort: 8799,
    target: 'generativelanguage.googleapis.com:443',
    origin,
  })
  assert.equal(plan.route.originBaseURL, origin)
  assert.equal(plan.after, 'http://127.0.0.1:8799/v1beta/openai')
  assert.equal(plan.before, lost)
})

await check('the client parses the body as text and explains an empty response', async () => {
  const source = fs.readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes('res.text()'), true)
  assert.equal(source.includes('emptyResponse'), true)
})

// 0.7.3 — the plugin ships its own cordis.patch.yml at the package root, so recognising a
// profile by that file made the upward walk stop one level short and every profile-relative
// read looked at node_modules/dsh-egress-router: discovery returned no targets at all and the
// patch rows claimed the bot package was not installed.
await check('profile discovery skips the plugin package that ships its own cordis.patch.yml', async () => {
  const { findProfileRoot, findProfileByDependency } = await import('../lib/index.js')
  const profileDir = tmp('egress-root-')
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'desktop', dsh: { profile: { bundles: [] } } }))
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), PATCH)
  const pkgDir = path.join(profileDir, 'node_modules', 'dsh-egress-router')
  fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh-egress-router', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  fs.writeFileSync(path.join(pkgDir, 'cordis.patch.yml'), PATCH)
  assert.equal(findProfileRoot(path.join(pkgDir, 'lib')), profileDir)

  // Without dsh.profile the second signal still finds it: the profile depends on this package.
  const plain = tmp('egress-root-dep-')
  fs.writeFileSync(path.join(plain, 'package.json'), JSON.stringify({ name: 'desktop', dependencies: { 'dsh-egress-router': 'file:x.tgz' } }))
  const nested = path.join(plain, 'node_modules', 'dsh-egress-router', 'lib')
  fs.mkdirSync(nested, { recursive: true })
  fs.writeFileSync(path.join(plain, 'node_modules', 'dsh-egress-router', 'package.json'), JSON.stringify({ name: 'dsh-egress-router' }))
  fs.writeFileSync(path.join(plain, 'node_modules', 'dsh-egress-router', 'cordis.patch.yml'), PATCH)
  assert.equal(findProfileRoot(nested), null)
  assert.equal(findProfileByDependency(nested), plain)
})

