// 0.2.2 hardening suite: R1 state versioning, R3 drift guard, R4 probe scope,
// R5 ghost status, R6 surgical YAML, R7 keep-alive, R8 TLS timeout, R9 verify, R10 proxies.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import { RelayManager } from '../lib/manager.js'
import { makeHandler } from '../lib/routes.js'
import { sha256, setProviderBaseURL } from '../lib/patcher.js'
import { createRelayServer, connectViaProxy } from '../lib/relay.js'
import { isPrivateAddress } from '../lib/ports.js'
import { readState, writeState, stateDir, statePath, updateState } from '../lib/store.js'

const WRITE_HEADERS = { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** Point DSH_HOME at a fresh directory so state never touches the real profile. */
function withHome(fn) {
  return async () => {
    const home = tempDir('egress-home22-')
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

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolve(port))
    })
  })
}

function fixtureProfile({ anchors = false } = {}) {
  const dir = tempDir('egress-profile22-')
  const body = anchors
    ? [
        '# keep this comment',
        '- id: llm-pi-ai',
        '  name: "@deepseek-ai/dsh-llm-pi-ai"',
        '  config:',
        '    providers:',
        '      gemini:',
        '        # gemini endpoint, do not lose me',
        '        baseURL: &gemini_base https://generativelanguage.googleapis.com/v1beta/openai',
        '        apiKeyEnv: GEMINI_API_KEY',
        '      mirror:',
        '        baseURL: *gemini_base',
        '        displayName: mirror',
        '',
      ].join('\n')
    : '# keep this comment\n' + yaml.dump([{
        id: 'llm-pi-ai',
        name: '@deepseek-ai/dsh-llm-pi-ai',
        config: {
          providers: {
            gemini: { displayName: 'Gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKeyEnv: 'GEMINI_API_KEY' },
          },
        },
      }])
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), body)
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'profile', dsh: { profile: { bundles: [] } } }))
  return dir
}

function patchText(profileDir) {
  return fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8')
}

/** Boot the real handler over a throwaway HTTP server with injectable side effects. */
async function bootHandler({ profileDir, config = {}, verify = null, persist, probe } = {}) {
  const manager = new RelayManager({ config, log: () => {} })
  const handler = makeHandler({
    config,
    manager,
    profileDir,
    log: () => {},
    verify,
    ...(persist ? { persist } : {}),
    ...(probe ? { probe } : {}),
  })
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port + '/plugins/egress-router'
  return {
    manager,
    async call(op, body, headers = WRITE_HEADERS) {
      const res = await fetch(base + '?op=' + op, {
        method: body ? 'POST' : 'GET',
        headers: body ? headers : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10000),
      })
      const data = await res.json().catch(() => ({}))
      return { status: res.status, data }
    },
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      await manager.dispose()
    },
  }
}

const OK_VERIFY = async () => ({ ok: true, via: 'direct', error: null })

// ---------------------------------------------------------------- R1: schema version

test('R1 state upgrades v2 -> v8 and keeps routes', withHome(async () => {
  fs.mkdirSync(stateDir(), { recursive: true })
  fs.writeFileSync(statePath(), JSON.stringify({
    version: 2,
    routes: [{ id: 'llm:gemini', target: 'example.com:443', listenPort: 8799 }],
    backups: [{ routeId: 'llm:gemini', backup: 'x.bak' }],
  }))
  const state = readState()
  assert.equal(state.version, 8)
  assert.deepEqual(state.metrics, {})
  assert.deepEqual(state.patches, {})
  assert.deepEqual(state.bots, {})
  assert.deepEqual(state.reconcilePaused, {})
  assert.equal(state.schemaVersion, 1)
  assert.equal(state.routes.length, 1)
  assert.equal(state.backups[0].sha256After, null)
  assert.equal(JSON.parse(fs.readFileSync(statePath(), 'utf8')).version, 8)
}))

test('R1 writeState stamps the current version even when the caller is stale', withHome(async () => {
  writeState({ version: 2, routes: [] })
  assert.equal(JSON.parse(fs.readFileSync(statePath(), 'utf8')).version, 8)
}))

// ---------------------------------------------------------------- R4: probe scope

test('R4 probe from a foreign web origin is rejected', withHome(async () => {
  const plugin = await bootHandler({ profileDir: fixtureProfile() })
  try {
    const result = await plugin.call('probe', { target: 'example.com:443' }, { 'content-type': 'application/json', origin: 'https://evil.example' })
    assert.equal(result.status, 403)
    assert.equal(result.data.error, 'unauthorized')
  } finally {
    await plugin.close()
  }
}))

test('R4 probe accepts the desktop shell origin (dsh-app://app)', withHome(async () => {
  const plugin = await bootHandler({ profileDir: fixtureProfile() })
  try {
    // The shell forwards the settings page's fetch, so Origin is the app scheme rather
    // than the loopback Host. The gate must let it through; the target is still checked.
    const result = await plugin.call('probe', { target: '127.0.0.1:1' }, { 'content-type': 'application/json', origin: 'dsh-app://app' })
    assert.equal(result.status, 400, JSON.stringify(result.data))
    assert.equal(result.data.error, 'private_target')
  } finally {
    await plugin.close()
  }
}))

test('R4 probe refuses private and loopback targets', withHome(async () => {
  const plugin = await bootHandler({ profileDir: fixtureProfile() })
  try {
    for (const target of ['127.0.0.1:1', '192.168.1.1:445', '169.254.169.254:80', 'localhost:80']) {
      const result = await plugin.call('probe', { target })
      assert.equal(result.status, 400, target)
      assert.equal(result.data.error, 'private_target', target)
    }
  } finally {
    await plugin.close()
  }
}))

test('R4 probe refuses targets the user has never been shown', withHome(async () => {
  const plugin = await bootHandler({ profileDir: fixtureProfile() })
  try {
    const result = await plugin.call('probe', { target: 'internal.example.com:443' })
    assert.equal(result.status, 400)
    assert.equal(result.data.error, 'unknown_target')
  } finally {
    await plugin.close()
  }
}))

test('R10 probe falls back to the configured default proxy', withHome(async () => {
  const seen = []
  const profileDir = fixtureProfile()
  await updateState((state) => ({
    ...state,
    discovered: { items: [{ id: 'llm:gemini', target: 'example.com:443' }] },
  }))
  const plugin = await bootHandler({
    profileDir,
    config: { proxies: { clash: 'http://127.0.0.1:7897' } },
    probe: async (args) => { seen.push(args); return { verdict: 'needs-proxy' } },
  })
  try {
    const result = await plugin.call('probe', { target: 'example.com:443', id: 'llm:gemini' })
    assert.equal(result.status, 200, JSON.stringify(result.data))
    assert.equal(seen[0].proxyUrl, 'http://127.0.0.1:7897')
    assert.equal(seen[0].compare, true)
  } finally {
    await plugin.close()
  }
}))

test('R10 an undefined proxy name is a 400, not a silent direct connection', withHome(async () => {
  const plugin = await bootHandler({ profileDir: fixtureProfile(), config: { proxies: { clash: 'http://127.0.0.1:7897' } } })
  try {
    const listenPort = await freePort()
    const result = await plugin.call('apply', { itemId: 'llm:gemini', target: 'example.com:443', listenPort, proxy: 'nope' })
    assert.equal(result.status, 400, JSON.stringify(result.data))
    assert.equal(result.data.error, 'unknown_proxy')
    assert.equal(readState().routes.length, 0)
  } finally {
    await plugin.close()
  }
}))

test('R10 manager refuses an undefined proxy name at start', withHome(async () => {
  const manager = new RelayManager({ config: { proxies: {} }, log: () => {} })
  assert.throws(() => manager.resolveProxy('nope'), /not defined/)
}))

// ---------------------------------------------------------------- R5: ghost status

test('R5 a failed listener does not leave a ghost status behind', withHome(async () => {
  const listenPort = await freePort()
  const blocker = net.createServer()
  await new Promise((resolve) => blocker.listen(listenPort, '127.0.0.1', resolve))
  const manager = new RelayManager({ config: {}, log: () => {} })
  try {
    const status = await manager.sync([{ id: 'llm:gemini', target: 'example.com:443', listenPort }])
    assert.equal(status[0].ok, false)
    assert.equal(manager.snapshot().length, 1)
    await manager.sync([])
    assert.equal(manager.snapshot().length, 0, 'failed status must not survive a stop')
  } finally {
    await manager.dispose()
    await new Promise((resolve) => blocker.close(resolve))
  }
}))

// ---------------------------------------------------------------- R3: rollback drift

test('R3 rollback refuses to clobber a hand edit, force overrides it', withHome(async () => {
  const profileDir = fixtureProfile()
  const listenPort = await freePort()
  const original = patchText(profileDir)
  const plugin = await bootHandler({ profileDir, config: { proxies: {} }, verify: OK_VERIFY })
  try {
    const applied = await plugin.call('apply', { itemId: 'llm:gemini', target: 'example.com:443', listenPort })
    assert.equal(applied.status, 200, JSON.stringify(applied.data))
    assert.equal(applied.data.format, 'surgical')

    const edited = patchText(profileDir) + '\n# my own note after apply\n'
    fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), edited)

    const refused = await plugin.call('rollback', {})
    assert.equal(refused.status, 409, JSON.stringify(refused.data))
    assert.equal(refused.data.error, 'file_changed_since_backup')
    assert.equal(patchText(profileDir), edited, 'a refused rollback must not touch the file')

    const forced = await plugin.call('rollback', { force: true })
    assert.equal(forced.status, 200, JSON.stringify(forced.data))
    assert.equal(patchText(profileDir), original)
    assert.equal(readState().routes.length, 0)
  } finally {
    await plugin.close()
  }
}))

// ---------------------------------------------------------------- R6: surgical YAML

test('R6 surgical write keeps comments, anchors and aliases', withHome(async () => {
  const profileDir = fixtureProfile({ anchors: true })
  const before = patchText(profileDir)
  const after = setProviderBaseURL(before, 'gemini', 'http://127.0.0.1:8792/v1beta/openai')
  assert.ok(after, 'the provider block should be found')
  assert.match(after, /# gemini endpoint, do not lose me/)
  assert.match(after, /&gemini_base/)
  assert.match(after, /baseURL: \*gemini_base/)
  assert.match(after, /baseURL: (?:&\S+ )?http:\/\/127\.0\.0\.1:8792\/v1beta\/openai/)
  const parsed = yaml.load(after)
  assert.equal(parsed[0].config.providers.gemini.baseURL, 'http://127.0.0.1:8792/v1beta/openai')
  // The alias is kept, so it now resolves to the rewritten value: text preservation,
  // not semantic rewriting, is what the surgical edit promises.
  assert.equal(parsed[0].config.providers.mirror.baseURL, 'http://127.0.0.1:8792/v1beta/openai')
}))

// ---------------------------------------------------------------- R2 / R9: apply paths

test('R2 a failed persist rolls the file and the listener back', withHome(async () => {
  const profileDir = fixtureProfile()
  const listenPort = await freePort()
  const original = patchText(profileDir)
  const plugin = await bootHandler({
    profileDir,
    config: { proxies: {} },
    verify: OK_VERIFY,
    persist: () => { throw new Error('disk full') },
  })
  try {
    const result = await plugin.call('apply', { itemId: 'llm:gemini', target: 'example.com:443', listenPort })
    assert.equal(result.status, 500, JSON.stringify(result.data))
    assert.equal(patchText(profileDir), original, 'config must be restored')
    assert.equal(readState().routes.length, 0, 'no half-applied route may survive')
    let reachable = true
    try {
      await fetch('http://127.0.0.1:' + listenPort + '/__health', { signal: AbortSignal.timeout(1500) })
    } catch { reachable = false }
    assert.equal(reachable, false, 'listener must be closed again')
  } finally {
    await plugin.close()
  }
}))

test('R9 an unreachable target fails verification and rolls back', withHome(async () => {
  const profileDir = fixtureProfile()
  const listenPort = await freePort()
  const original = patchText(profileDir)
  const plugin = await bootHandler({
    profileDir,
    config: { proxies: {} },
    verify: async () => ({ ok: false, via: 'direct', error: 'boom' }),
  })
  try {
    const result = await plugin.call('apply', { itemId: 'llm:gemini', target: 'example.com:443', listenPort })
    assert.equal(result.status, 502, JSON.stringify(result.data))
    assert.equal(result.data.error, 'apply_unverified')
    assert.equal(patchText(profileDir), original)
    assert.equal(readState().routes.length, 0)
  } finally {
    await plugin.close()
  }
}))

// ---------------------------------------------------------------- R7 / R8: relay

test('R7 two requests reuse one upstream tunnel', withHome(async () => {
  const upstream = http.createServer((req, res) => res.end('upstream:' + req.url))
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamPort = upstream.address().port

  let connects = 0
  const proxy = http.createServer()
  proxy.on('connect', (req, socket) => {
    connects += 1
    const [host, port] = req.url.split(':')
    const conn = net.connect(Number(port), host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      conn.pipe(socket)
      socket.pipe(conn)
    })
    conn.on('error', () => socket.destroy())
  })
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))

  const relay = createRelayServer({
    target: '127.0.0.1:' + upstreamPort,
    proxyUrl: 'http://127.0.0.1:' + proxy.address().port,
    tls: false,
  })
  await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + relay.address().port
  try {
    const first = await fetch(base + '/a', { signal: AbortSignal.timeout(4000) })
    assert.equal(await first.text(), 'upstream:/a')
    const second = await fetch(base + '/b', { signal: AbortSignal.timeout(4000) })
    assert.equal(await second.text(), 'upstream:/b')
    assert.equal(connects, 1, 'keep-alive should not open a second CONNECT')
  } finally {
    relay.closeAllConnections()
    await new Promise((resolve) => relay.close(resolve))
    proxy.closeAllConnections()
    await new Promise((resolve) => proxy.close(resolve))
    await new Promise((resolve) => upstream.close(resolve))
  }
}))

test('R8 a tunnel that never completes TLS times out', withHome(async () => {
  const held = []
  const proxy = http.createServer()
  proxy.on('connect', (req, socket) => {
    held.push(socket)
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
  })
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  try {
    const started = Date.now()
    await assert.rejects(
      connectViaProxy('http://127.0.0.1:' + proxy.address().port, 'example.com', 443, { timeoutMs: 300 }),
      /tls_handshake_timeout/,
    )
    assert.ok(Date.now() - started < 5000, 'must fail on the handshake timeout, not the OS default')
  } finally {
    for (const socket of held) socket.destroy()
    proxy.closeAllConnections()
    await new Promise((resolve) => proxy.close(resolve))
  }
}))

// ---------------------------------------------------------------- helpers

test('isPrivateAddress classifies the ranges the probe must refuse', () => {
  for (const host of ['127.0.0.1', 'localhost', '10.1.2.3', '172.16.0.1', '192.168.0.10', '169.254.169.254', '::1', 'fe80::1', '0.0.0.0']) {
    assert.equal(isPrivateAddress(host), true, host)
  }
  for (const host of ['example.com', '8.8.8.8', '192.0.2.1', 'generativelanguage.googleapis.com']) {
    assert.equal(isPrivateAddress(host), false, host)
  }
})

test('sha256 helper is stable', () => {
  assert.equal(sha256('abc'), sha256('abc'))
  assert.notEqual(sha256('abc'), sha256('abd'))
})

test('R9 verification runs with a wider timeout and two retries', withHome(async () => {
  const profileDir = fixtureProfile()
  const listenPort = await freePort()
  let seen = null
  const plugin = await bootHandler({
    profileDir,
    config: { proxies: {} },
    verify: async (options) => { seen = options; return { ok: true, via: 'direct', error: null } },
  })
  try {
    const result = await plugin.call('apply', { itemId: 'llm:gemini', target: 'example.com:443', listenPort })
    assert.equal(result.status, 200, JSON.stringify(result.data))
    assert.equal(seen.timeoutMs, 12000, 'a slow proxy node must not fail on the 5s budget')
    assert.equal(seen.retries, 2)
  } finally {
    await plugin.close()
  }
}))

// --- 0.4.1 -----------------------------------------------------------------

/** Minimal plugin ctx: enough for apply() to mount the API and expose dispose. */
function fakeCtx() {
  const registered = []
  const disposers = []
  return {
    registered,
    disposers,
    logger: { info: () => {} },
    inject(_names, fn) {
      fn({
        webServer: {
          register(route) {
            registered.push(route)
            return () => {}
          },
        },
      })
    },
    on(event, fn) {
      if (event === 'dispose') disposers.push(fn)
    },
  }
}

test('0.4.1 identical history lines collapse instead of piling up', withHome(async () => {
  const { recordHistory } = await import('../lib/store.js')
  const entry = { op: 'start', routeId: null, ok: false, detail: 'llm:gemini:8792 (down)' }
  recordHistory(entry)
  recordHistory(entry)
  recordHistory({ ...entry })
  const history = readState().history
  assert.equal(history.length, 1, 'a repeated identical outcome inside a minute is one line')
  recordHistory({ ...entry, detail: 'llm:gemini:8793 (down)' })
  assert.equal(readState().history.length, 2, 'a different outcome is still recorded')
}))

test('0.5.2 a second activation takes over instead of leaving no endpoint at all', withHome(async () => {
  const { apply } = await import('../lib/index.js')
  const profileDir = fixtureProfile()
  const listenPort = await freePort()
  const config = { routes: [{ id: 'llm:gemini', target: 'example.com:443', listenPort }], proxies: {} }
  const first = fakeCtx()
  await apply(first, config)
  assert.equal(first.registered.length, 1, 'the first activation owns the endpoint')
  const second = fakeCtx()
  try {
    // The host tears the old plugin context down *after* activating the new one, so standing
    // down here used to leave the process with listeners but no HTTP route.
    await apply(second, config)
    assert.equal(second.registered.length, 1, 'the new activation owns the endpoint')
    const state = readState()
    assert.ok(state.history.some((item) => item.op === 'replace-instance'), 'the hand-over is recorded')
    assert.ok(!state.history.some((item) => item.op === 'duplicate-instance'), 'the stand-down path is gone')
    assert.equal(state.listeners.filter((item) => item.ok).length, 1, 'the port moved to the new instance')
  } finally {
    await Promise.all(second.disposers.map((fn) => fn()))
  }
}))

test('0.4.1 dispose keeps the last traffic counters in state', withHome(async () => {
  const { apply } = await import('../lib/index.js')
  const profileDir = fixtureProfile()
  const listenPort = await freePort()
  const config = { routes: [{ id: 'llm:gemini', target: 'example.com:443', listenPort }], proxies: {}, relay: { connectTimeoutMs: 1500 } }
  const ctx = fakeCtx()
  await apply(ctx, config)
  try {
    assert.equal(readState().metrics['llm:gemini'], undefined, 'nothing flushed yet')
    // Any request counts, even one whose upstream connection fails: the counter is the
    // proof that a restart does not wipe the page's numbers.
    await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: listenPort, path: '/', method: 'GET', timeout: 2500 })
      const done = () => resolve()
      req.on('response', (res) => { res.resume(); res.on('end', done) })
      req.on('error', done)
      req.on('timeout', () => { req.destroy(); done() })
      req.end()
    })
    await Promise.all(ctx.disposers.map((fn) => fn()))
    const metrics = readState().metrics['llm:gemini']
    assert.ok(metrics, 'dispose writes the counters')
    assert.ok(metrics.requests >= 1, 'the request that went through is counted')
  } finally {
    await Promise.all(ctx.disposers.map((fn) => fn()))
  }
}))
