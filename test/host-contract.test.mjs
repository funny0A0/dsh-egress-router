// 0.7.1 - the host plugin contract is undocumented, so the probe *is* the compatibility
// layer. These tests pin the behaviour for every shape a host might use, and for the case
// where none of them is accepted: the plugin must keep loading with routing intact.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, findProfileRoot } from '../lib/index.js'
import { readState } from '../lib/store.js'

const PATCH = [
  '- id: llm-pi-ai',
  '  config:',
  '    providers:',
  '      gemini:',
  '        baseURL: https://generativelanguage.googleapis.com/v1beta/openai',
  '',
].join('\n')

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + process.pid + '-' + Date.now() + '-'))
}

function profileFixture() {
  const dir = tempDir('egress-hc-profile-')
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), PATCH)
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'web', dsh: { profile: { bundles: ['dsh-egress-router'] } } }))
  const nested = path.join(dir, 'node_modules', '.pnpm', 'dsh-egress-router@0.7.1', 'node_modules', 'dsh-egress-router', 'lib')
  fs.mkdirSync(nested, { recursive: true })
  return { dir, nested }
}

function withHome(fn) {
  return async () => {
    const home = tempDir('egress-hc-home-')
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      await fn()
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  }
}

function ctxWith(register) {
  const disposers = []
  return {
    disposers,
    logger: { info: () => {} },
    inject(_names, fn) {
      fn({ webServer: { register } })
    },
    on(event, fn) {
      if (event === 'dispose') disposers.push(fn)
    },
  }
}

async function boot(profileDir, ctx) {
  await apply(ctx, { profileDir, proxies: { clash: 'http://127.0.0.1:7897' } })
  return async () => {
    for (const dispose of ctx.disposers) await dispose()
  }
}

test('the profile root is found by walking up, not by counting ".."', () => {
  const { dir, nested } = profileFixture()
  assert.equal(findProfileRoot(nested), dir)
  assert.equal(findProfileRoot(path.join(dir, 'some', 'deeper', 'place')), dir)
  assert.equal(findProfileRoot(tempDir('egress-hc-orphan-')), null)
})

test('a host that only accepts { path, handler } is recorded as plain', withHome(async () => {
  const { dir } = profileFixture()
  const routes = []
  const ctx = ctxWith((route) => {
    if (route && Object.prototype.hasOwnProperty.call(route, 'kind')) throw new TypeError('kind is not supported here')
    routes.push(route)
    return () => {}
  })
  const close = await boot(dir, ctx)
  try {
    const state = readState()
    assert.equal(state.hostContract.webServer, 'plain')
    assert.equal(state.hostContract.ok, true)
    assert.equal(routes.length, 1)
    assert.equal(typeof routes[0].handler, 'function')
    assert.equal(state.hostEnv.platform, process.platform)
    assert.equal(state.hostEnv.node, process.version)
    assert.equal(typeof state.hostEnv.arch, 'string')
  } finally {
    await close()
  }
}))

test('a host that needs positional arguments is recorded as positional', withHome(async () => {
  const { dir } = profileFixture()
  const calls = []
  const ctx = ctxWith((...args) => {
    if (args.length === 1) throw new TypeError('this host wants (path, handler)')
    calls.push(args)
    return () => {}
  })
  const close = await boot(dir, ctx)
  try {
    assert.equal(readState().hostContract.webServer, 'positional')
    assert.equal(calls.length, 1)
    assert.equal(typeof calls[0][1], 'function')
  } finally {
    await close()
  }
}))

test('a host that accepts no known shape degrades instead of failing to load', withHome(async () => {
  const { dir } = profileFixture()
  const ctx = ctxWith(() => {
    throw new TypeError('unsupported registration signature')
  })
  const close = await boot(dir, ctx)
  try {
    const state = readState()
    assert.equal(state.hostContract.webServer, 'unavailable')
    assert.equal(state.hostContract.ok, false)
    assert.equal(typeof state.hostContract.detail, 'string')
    // Routing is unaffected: the plugin still owns its state and its listeners.
    assert.equal(Array.isArray(state.routes), true)
    assert.equal(state.hostEnv.platform, process.platform)
  } finally {
    await close()
  }
}))
