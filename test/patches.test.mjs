// 0.4.0 — managed compatibility patches: inspect / apply / revert / boot repair.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { loadDefinitions, inspect, applyPatch, revertPatch, repairAll } from '../lib/patches.js'
import { makeHandler } from '../lib/routes.js'

const ANCHOR = 'new Lze({connections:Uze})'
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

/** A fake profile with one installed plugin whose file contains the anchor. */
function makeProfile({ version = '5.1.0', body = 'var t = ' + ANCHOR + ';', packageName = '@xmanrui/dsh-im' } = {}) {
  const profileDir = tmpDir('egress-patch-profile-')
  const pkgDir = path.join(profileDir, 'node_modules', ...packageName.split('/'))
  fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: packageName, version }))
  fs.writeFileSync(path.join(pkgDir, 'lib', 'index.js'), body)
  return { profileDir, pkgDir, file: path.join(pkgDir, 'lib', 'index.js') }
}

const defs = loadDefinitions()
const def = defs[0]

await check('definitions load from the shipped file', async () => {
  assert.ok(defs.length >= 1)
  assert.equal(def.id, 'telegram-proxy')
  assert.equal(def.package, '@xmanrui/dsh-im')
})

await check('inspect reports pending for an installed, supported plugin', async () => {
  const { profileDir } = makeProfile()
  const stateDir = tmpDir('egress-patch-state-')
  const info = inspect(def, { profileDir, stateDir })
  assert.equal(info.status, 'pending')
  assert.equal(info.version, '5.1.0')
  assert.equal(info.markerCount, 0)
  assert.equal(info.anchorCount, 1)
  assert.equal(info.backup, false)
})

await check('apply writes the marker, keeps a pristine backup, and is idempotent', async () => {
  const { profileDir, file } = makeProfile()
  const stateDir = tmpDir('egress-patch-state-')
  const before = fs.readFileSync(file, 'utf8')
  const applied = applyPatch(def, { profileDir, stateDir })
  assert.equal(applied.changed, true)
  assert.equal(applied.status, 'applied')
  const after = fs.readFileSync(file, 'utf8')
  assert.notEqual(after, before)
  assert.ok(after.includes(def.marker))
  const backup = path.join(stateDir, 'patches', def.id + '.bak')
  assert.equal(fs.readFileSync(backup, 'utf8'), before)
  const again = applyPatch(def, { profileDir, stateDir })
  assert.equal(again.changed, false)
  assert.equal(fs.readFileSync(file, 'utf8'), after)
})

await check('revert restores the exact original bytes', async () => {
  const { profileDir, file } = makeProfile()
  const stateDir = tmpDir('egress-patch-state-')
  const before = fs.readFileSync(file, 'utf8')
  applyPatch(def, { profileDir, stateDir })
  const reverted = revertPatch(def, { profileDir, stateDir })
  assert.equal(reverted.changed, true)
  assert.equal(reverted.status, 'pending')
  assert.equal(fs.readFileSync(file, 'utf8'), before)
})

await check('revert without a backup fails with no_backup', async () => {
  const { profileDir } = makeProfile()
  const stateDir = tmpDir('egress-patch-state-')
  assert.throws(() => revertPatch(def, { profileDir, stateDir }), (err) => err.code === 'no_backup')
})

await check('unsupported major version is never patched', async () => {
  const { profileDir } = makeProfile({ version: '6.0.0' })
  const stateDir = tmpDir('egress-patch-state-')
  const info = inspect(def, { profileDir, stateDir })
  assert.equal(info.status, 'unsupported')
  assert.throws(() => applyPatch(def, { profileDir, stateDir }), (err) => err.code === 'unsupported')
})

await check('missing anchor is refused, not guessed', async () => {
  const { profileDir } = makeProfile({ body: 'var x = 1;' })
  const stateDir = tmpDir('egress-patch-state-')
  assert.equal(inspect(def, { profileDir, stateDir }).status, 'anchor_missing')
  assert.throws(() => applyPatch(def, { profileDir, stateDir }), (err) => err.code === 'anchor_missing')
})

await check('ambiguous anchor is refused', async () => {
  const { profileDir } = makeProfile({ body: 'var a = ' + ANCHOR + '; var b = ' + ANCHOR + ';' })
  const stateDir = tmpDir('egress-patch-state-')
  const info = inspect(def, { profileDir, stateDir })
  assert.equal(info.status, 'anchor_ambiguous')
  assert.equal(info.anchorCount, 2)
})

await check('missing package reports missing_package', async () => {
  const profileDir = tmpDir('egress-patch-profile-')
  const stateDir = tmpDir('egress-patch-state-')
  assert.equal(inspect(def, { profileDir, stateDir }).status, 'missing_package')
})

await check('boot repair re-applies a wiped patch that the ledger remembers', async () => {
  const { profileDir, file } = makeProfile()
  const stateDir = tmpDir('egress-patch-state-')
  const original = fs.readFileSync(file, 'utf8')
  applyPatch(def, { profileDir, stateDir })
  // Simulate `pnpm add` reinstalling the package: our edit is gone, backup remains.
  fs.writeFileSync(file, original)
  const ledger = { [def.id]: { appliedAt: new Date().toISOString(), version: '5.1.0' } }
  const repairs = repairAll(defs, { profileDir, stateDir, ledger })
  assert.equal(repairs.length, 1)
  assert.equal(repairs[0].action, 'repaired')
  assert.equal(repairs[0].status, 'applied')
  assert.ok(fs.readFileSync(file, 'utf8').includes(def.marker))
})

await check('boot repair leaves unledgered packages untouched', async () => {
  const { profileDir, file } = makeProfile()
  const stateDir = tmpDir('egress-patch-state-')
  const original = fs.readFileSync(file, 'utf8')
  const repairs = repairAll(defs, { profileDir, stateDir, ledger: {} })
  assert.equal(repairs.length, 0)
  assert.equal(fs.readFileSync(file, 'utf8'), original)
})

await check('API: state lists patches and only same-origin may apply', async () => {
  const home = tmpDir('egress-patch-home-')
  process.env.DSH_HOME = home
  const { profileDir, file } = makeProfile()
  const manager = {
    snapshot: () => [],
    metrics: () => ({}),
    tuning: () => ({ maxSockets: 6, timeoutMs: 90000, connectTimeoutMs: 12000 }),
    owns: () => false,
    resolveProxy: () => { throw new Error('no proxies') },
    proxyUrlFor: () => null,
    defaultProxyName: () => null,
    sync: async () => [],
    dispose: async () => {},
  }
  const handler = makeHandler({ config: {}, manager, profileDir, log: () => {}, verify: null, stateDir: path.join(home, 'storages', 'egress-router') })
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port + '/plugins/egress-router'

  const state = await (await fetch(base + '?op=state')).json()
  assert.equal(state.patches.length, 1)
  assert.equal(state.patches[0].status, 'pending')

  const foreign = await fetch(base + '?op=patch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ id: def.id, action: 'apply' }),
  })
  assert.equal(foreign.status, 403)
  assert.ok(!fs.readFileSync(file, 'utf8').includes(def.marker))

  const applied = await fetch(base + '?op=patch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ id: def.id, action: 'apply' }),
  })
  assert.equal(applied.status, 200)
  const body = await applied.json()
  assert.equal(body.patch.status, 'applied')
  assert.ok(fs.readFileSync(file, 'utf8').includes(def.marker))

  const verify = await (await fetch(base + '?op=patch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ id: def.id, action: 'verify' }),
  })).json()
  assert.equal(verify.patch.status, 'applied')

  server.closeAllConnections()
  server.close()
  fs.rmSync(home, { recursive: true, force: true })
})

const failed = results.filter((item) => !item.ok)
console.log('\npatches: ' + (results.length - failed.length) + ' pass, ' + failed.length + ' fail')
if (failed.length) process.exitCode = 1
