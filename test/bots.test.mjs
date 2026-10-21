// 0.5.0 — chat-bot egress: the managed patch, the environment variable it reads, and
// the API the settings page drives.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { botList, applyBotProxy, clearBotProxy, cleanupManagedEnv, restoreBots } from '../lib/bots.js'
import { loadDefinitions } from '../lib/patches.js'
import { makeHandler } from '../lib/routes.js'
import { readBots, writeBot } from '../lib/store.js'

const ANCHOR = 'new Lze({connections:Uze})'
const ENV = 'DSH_TELEGRAM_PROXY'
const PROXIES = { clash: 'http://127.0.0.1:7897' }
const results = []

async function check(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log('ok   ' + name)
  } catch (err) {
    results.push({ name, ok: false, err })
    console.log('FAIL ' + name + ' :: ' + (err && err.message))
  }
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** A fake profile with dsh-im installed and unpatched. */
function makeProfile() {
  const profileDir = tmpDir('egress-bot-profile-')
  const pkgDir = path.join(profileDir, 'node_modules', '@xmanrui', 'dsh-im')
  fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@xmanrui/dsh-im', version: '5.1.0' }))
  const file = path.join(pkgDir, 'lib', 'index.js')
  fs.writeFileSync(file, 'var t = ' + ANCHOR + ';')
  return { profileDir, file }
}

function isolateState() {
  const home = tmpDir('egress-bot-home-')
  process.env.DSH_HOME = home
  return { home, stateDir: path.join(home, 'storages', 'egress-router') }
}

function callHandler(handler, { method = 'GET', query = '', body = null, headers = {} } = {}) {
  const payload = body === null ? '' : JSON.stringify(body)
  const req = Readable.from([Buffer.from(payload)])
  req.method = method
  req.url = '/plugins/egress-router' + query
  req.headers = Object.assign(
    { 'sec-fetch-site': 'same-origin' },
    payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {},
    headers,
  )
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 0,
      headers: {},
      chunks: [],
      setHeader(key, value) { this.headers[key] = value },
      writeHead(code, extra) { this.statusCode = code; Object.assign(this.headers, extra || {}) },
      end(data) {
        if (data) this.chunks.push(Buffer.from(data))
        resolve({ status: this.statusCode, body: Buffer.concat(this.chunks).toString('utf8') })
      },
    }
    try {
      handler(req, res)
    } catch (err) {
      reject(err)
    }
  })
}

function fakeManager() {
  return {
    snapshot: () => [],
    metrics: () => ({}),
    tuning: () => ({}),
    owns: () => false,
    resolveProxy: () => null,
    proxyUrlFor: () => null,
    defaultProxyName: () => null,
  }
}

await check('bot row reports a pending patch and no proxy on a fresh install', async () => {
  const { profileDir } = makeProfile()
  const { stateDir } = isolateState()
  const [bot] = botList({ bots: {}, proxies: PROXIES, profileDir, stateDir })
  assert.equal(bot.id, 'telegram')
  assert.equal(bot.patch.status, 'pending')
  assert.equal(bot.configured, false)
  assert.equal(bot.proxy, null)
  assert.equal(bot.envVar, ENV)
})

await check('applying a proxy patches the file and sets the environment variable', async () => {
  delete process.env[ENV]
  const { profileDir, file } = makeProfile()
  const { stateDir } = isolateState()
  const result = applyBotProxy({ id: 'telegram', proxyName: 'clash', proxies: PROXIES, profileDir, stateDir })
  assert.equal(result.restartRequired, true)
  assert.equal(result.changed, true)
  assert.equal(result.bot.url, PROXIES.clash)
  assert.equal(process.env[ENV], PROXIES.clash)
  assert.match(fs.readFileSync(file, 'utf8'), /DSH_TELEGRAM_PROXY/)
  const [bot] = botList({ bots: { telegram: { proxy: 'clash' } }, proxies: PROXIES, profileDir, stateDir })
  assert.equal(bot.patch.status, 'applied')
  assert.equal(bot.configured, true)
  assert.equal(bot.envValue, PROXIES.clash)
})

await check('an unknown proxy is rejected before anything is written', async () => {
  delete process.env[ENV]
  const { profileDir, file } = makeProfile()
  const { stateDir } = isolateState()
  const before = fs.readFileSync(file, 'utf8')
  assert.throws(
    () => applyBotProxy({ id: 'telegram', proxyName: 'nope', proxies: PROXIES, profileDir, stateDir }),
    (err) => err.code === 'unknown_proxy' && err.status === 400,
  )
  assert.equal(fs.readFileSync(file, 'utf8'), before)
  assert.equal(process.env[ENV], undefined)
})

await check('clearing drops the environment override but leaves the patch in place', async () => {
  const { profileDir, file } = makeProfile()
  const { stateDir } = isolateState()
  applyBotProxy({ id: 'telegram', proxyName: 'clash', proxies: PROXIES, profileDir, stateDir })
  const result = clearBotProxy({ id: 'telegram' })
  assert.equal(result.restartRequired, true)
  assert.equal(process.env[ENV], undefined)
  assert.match(fs.readFileSync(file, 'utf8'), /DSH_TELEGRAM_PROXY/)
})

await check('an unknown bot id is a 404-shaped error', async () => {
  const { profileDir } = makeProfile()
  const { stateDir } = isolateState()
  assert.throws(
    () => clearBotProxy({ id: 'slack' }),
    (err) => err.code === 'unknown_bot' && err.status === 404,
  )
  assert.equal(botList({ bots: {}, proxies: PROXIES, profileDir, stateDir }).length, 1)
})

await check('boot restore only re-applies the bots the user configured', async () => {
  delete process.env[ENV]
  const { profileDir } = makeProfile()
  const { stateDir } = isolateState()
  const none = restoreBots({ bots: {}, proxies: PROXIES, profileDir, stateDir })
  assert.deepEqual(none, [])
  assert.equal(process.env[ENV], undefined)

  const restored = restoreBots({ bots: { telegram: { proxy: 'clash' } }, proxies: PROXIES, profileDir, stateDir })
  assert.equal(restored.length, 1)
  assert.equal(restored[0].ok, true)
  assert.equal(process.env[ENV], PROXIES.clash)
})

await check('the API exposes bot rows and applies a proxy through ?op=bot', async () => {
  delete process.env[ENV]
  const { profileDir, file } = makeProfile()
  const { stateDir } = isolateState()
  writeBot('telegram', null)
  const handler = makeHandler({
    config: { proxies: PROXIES },
    manager: fakeManager(),
    profileDir,
    stateDir,
    verify: null,
  })

  const state = await callHandler(handler, { query: '?op=state' })
  assert.equal(state.status, 200)
  const stateBody = JSON.parse(state.body)
  assert.ok(Array.isArray(stateBody.bots), 'state should list bot rows')
  assert.equal(stateBody.bots[0].patch.status, 'pending')

  const applied = await callHandler(handler, {
    method: 'POST',
    query: '?op=bot',
    body: { id: 'telegram', proxy: 'clash' },
  })
  assert.equal(applied.status, 200)
  const appliedBody = JSON.parse(applied.body)
  assert.equal(appliedBody.restartRequired, true)
  assert.equal(appliedBody.bots[0].configured, true)
  assert.equal(process.env[ENV], PROXIES.clash)
  assert.match(fs.readFileSync(file, 'utf8'), /DSH_TELEGRAM_PROXY/)
  assert.equal(readBots().telegram.proxy, 'clash')

  const cleared = await callHandler(handler, {
    method: 'POST',
    query: '?op=bot',
    body: { id: 'telegram', proxy: '' },
  })
  assert.equal(cleared.status, 200)
  assert.equal(JSON.parse(cleared.body).bots[0].configured, false)
  assert.equal(readBots().telegram, undefined)

  const hostile = await callHandler(handler, {
    method: 'POST',
    query: '?op=bot',
    body: { id: 'telegram', proxy: 'clash' },
    headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(hostile.status, 403)
})

await check('a bot proxy never writes to $DSH_HOME/.env', async () => {
  delete process.env[ENV]
  const { profileDir } = makeProfile()
  const { home, stateDir } = isolateState()
  const envFile = path.join(home, '.env')
  const original = 'NO_PROXY=localhost,127.0.0.1,::1\nMY_SETTING=keep-me\n'
  fs.writeFileSync(envFile, original)
  applyBotProxy({ id: 'telegram', proxyName: 'clash', proxies: PROXIES, profileDir, stateDir })
  assert.equal(fs.readFileSync(envFile, 'utf8'), original, '.env must stay byte-identical')
  assert.equal(process.env[ENV], PROXIES.clash)
})

await check('the repair removes a poisoned managed block and nothing else', async () => {
  const { home } = isolateState()
  const envFile = path.join(home, '.env')
  fs.writeFileSync(envFile, [
    'NO_PROXY=localhost,127.0.0.1,::1',
    '# dsh-egress-router (managed) — bot egress',
    ENV + '=http://127.0.0.1:7897',
    '# /dsh-egress-router (managed)',
    'KEEP=me',
    ENV + '=http://stray:1',
    '',
  ].join('\n'))
  const result = cleanupManagedEnv({ envVar: ENV })
  assert.equal(result.changed, true)
  assert.equal(result.removed.length, 2)
  const after = fs.readFileSync(envFile, 'utf8')
  assert.equal(after.includes(ENV), false, 'no reserved assignment may survive')
  assert.match(after, /NO_PROXY=localhost/)
  assert.match(after, /KEEP=me/)
  const again = cleanupManagedEnv({ envVar: ENV })
  assert.equal(again.changed, false)
})

await check('a clean .env is left untouched by the repair', async () => {
  const { home } = isolateState()
  const envFile = path.join(home, '.env')
  const text = 'NO_PROXY=localhost\n'
  fs.writeFileSync(envFile, text)
  assert.deepEqual(cleanupManagedEnv({ envVar: ENV }), { changed: false, removed: [] })
  assert.equal(fs.readFileSync(envFile, 'utf8'), text)
})

const passed = results.filter((item) => item.ok).length
const failed = results.length - passed
if (failed) {
  console.log('bots: ' + passed + ' pass, ' + failed + ' fail')
  for (const item of results) if (!item.ok) console.log('  ' + item.name + ' :: ' + item.err.stack)
  process.exitCode = 1
} else {
  console.log('bots: ' + passed + ' pass, 0 fail')
}
