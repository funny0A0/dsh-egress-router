/**
 * Install smoke: pack this checkout, install the tarball into a throwaway profile the way a
 * user would, boot the installed copy with a fake host context, and assert the outward surface.
 *
 * This is the test that would have caught the 0.7.x packaging mistakes (`exports['./client']`
 * missing, a state schema that no longer matches the declared keys, a profile root resolved one
 * directory too low), because it exercises the tarball, not the source tree.
 *
 * Runs on Windows, Linux and macOS in CI; no DSH installation is required.
 */
import { npmExec } from './npm-run.mjs'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Windows cannot execFileSync('npm.cmd') (EINVAL); run npm's JS entry with the current node
// instead, which behaves the same on all three platforms and needs no shell quoting.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-install-smoke-'))
const log = (line) => console.log('[install-smoke] ' + line)

function run(args, options = {}) {
  const cwd = options.cwd ?? root
  const stdio = ['ignore', 'pipe', 'pipe']
  // Same resolver as check-package: npm may be a JS entry, a .cmd shim, or not on PATH at all.
  return npmExec(args, { cwd, encoding: 'utf8', stdio })
}

// 1. Pack exactly what would be published.
const packed = run(['pack', '--silent', '--pack-destination', work]).trim().split(/\r?\n/).pop()
const tarball = path.join(work, packed)
if (!fs.existsSync(tarball)) throw new Error('npm pack produced no tarball: ' + packed)
log('packed ' + path.basename(tarball) + ' (' + fs.statSync(tarball).size + ' bytes)')

// 2. Install into a consumer profile, with the tarball as the only dependency.
const consumer = path.join(work, 'consumer')
fs.mkdirSync(consumer)
fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({
  name: 'egress-consumer',
  private: true,
  type: 'module',
  dependencies: { 'dsh-egress-router': 'file:' + tarball.split(path.sep).join('/') },
}, null, 2))
run(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: consumer })
log('installed into a clean consumer profile')

// 3. Boot the installed copy against a fake host context and a throwaway profile.
const installed = path.join(consumer, 'node_modules', 'dsh-egress-router')
const manifest = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'))
const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'test', 'contract', 'api-surface.json'), 'utf8'))

const profileDir = path.join(work, 'profile')
fs.mkdirSync(profileDir)
fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), [
  '- id: llm-pi-ai',
  '  config:',
  '    providers:',
  '      gemini:',
  '        baseURL: https://generativelanguage.googleapis.com/v1beta/openai',
  '',
].join('\n'))
fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'smoke-profile', dsh: { profile: { bundles: [] } } }, null, 2))
process.env.DSH_HOME = path.join(work, 'home')

const { apply } = await import(pathToFileURL(path.join(installed, 'lib', 'index.js')).href)
const registrations = []
const disposers = []
const ctx = {
  logger: { info() {} },
  inject(_services, factory) {
    factory({ webServer: { register(route) { registrations.push(route); return () => {} } } })
  },
  on(event, handler) { if (event === 'dispose') disposers.push(handler) },
}
await apply(ctx, { profileDir, routes: [], proxies: {}, verifyAfterApply: false })
if (registrations.length !== 1) throw new Error('expected one registered route, got ' + registrations.length)

const server = http.createServer(registrations[0].handler)
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + server.address().port + '/plugins/egress-router'
const state = await (await fetch(base + '?op=state')).json()
const discover = await (await fetch(base + '?op=discover')).json()

// 4. Assert the contract a fresh install must honour.
const failures = []
const check = (label, condition, detail = '') => { if (!condition) failures.push(label + (detail ? ': ' + detail : '')) }
check('apiVersion', state.apiVersion === snapshot.apiVersion, String(state.apiVersion))
check('state key count', Object.keys(state).length === snapshot.stateKeys.length, Object.keys(state).length + ' vs ' + snapshot.stateKeys.length)
check('state keys', JSON.stringify(Object.keys(state).sort()) === JSON.stringify(snapshot.stateKeys))
check('schemaOk', state.schemaOk === true, JSON.stringify(state.schemaErrors))
check('profileOk', state.profileOk === true)
check('plugin version', state.plugin === undefined || manifest.version === state.plugin.version)
check('discovery reads the profile', (discover.items ?? []).some((item) => item.kind === 'llm'))
check('client export is packaged', fs.existsSync(path.join(installed, 'client', 'client.js')))
check('bundle patch is packaged', fs.existsSync(path.join(installed, 'cordis.patch.yml')))

server.closeAllConnections()
await new Promise((resolve) => server.close(resolve))
for (const dispose of disposers) { try { await dispose() } catch {} }

if (failures.length > 0) {
  console.error('[install-smoke] FAILED\n  - ' + failures.join('\n  - '))
  process.exit(1)
}
log('OK ' + manifest.version + ' platform=' + process.platform + ' node=' + process.version + ' keys=' + Object.keys(state).length)
