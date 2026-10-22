// 0.8.0 suite: reliability and accessibility.
//
// Four things that used to fail silently are pinned here: a listener that dies with nobody
// asking (watchdog), an error that only ever reached console.warn (recordError), a repair
// throttle that counted three hits in one minute and could be dodged by waiting 61 seconds,
// and a client bundle that assumed its host API exists.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { RelayManager } from '../lib/manager.js'
import { noteRepairs, resetThrottle } from '../lib/reconcile.js'
import { cleanupManagedEnv } from '../lib/bots.js'
import { readState, recordError, resetErrorLog } from '../lib/store.js'

const ROOT = path.resolve(import.meta.dirname, '..')

function isolateHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-reliability-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
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

function get(port, routePath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: routePath, method: 'GET' }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function waitFor(predicate, timeoutMs = 4000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  return false
}

test('R1: a listener that dies on its own is rebuilt with backoff', async () => {
  const restore = isolateHome()
  const target = http.createServer((req, res) => res.end('ok'))
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve))
  const events = []
  const manager = new RelayManager({
    config: { proxies: {}, relay: { recoveryBaseMs: 40, maxRecoveries: 5 } },
    onEvent: (event) => events.push(event),
  })
  const route = { id: 'llm:watchdog', target: '127.0.0.1:' + target.address().port, listenPort: await freePort(), proxy: null }
  try {
    await manager.start(route)
    // Nothing calls stop(): the OS or a crash reclaims the listener, which used to leave the
    // status saying ok while no port was open.
    manager.servers.get(route.id).close()
    assert.equal(await waitFor(() => events.some((event) => event.op === 'relay-recover' && event.ok)), true)
    const status = manager.statuses.get(route.id)
    assert.equal(status.ok, true)
    assert.equal(status.port, route.listenPort)
    assert.equal(manager.servers.has(route.id), true)
    const health = await get(route.listenPort, '/__health')
    assert.equal(health.status, 200)
    assert.equal(JSON.parse(health.body).ok, true)
    assert.ok(events.some((event) => event.op === 'relay-down' && event.ok === false))
  } finally {
    await manager.dispose()
    await new Promise((resolve) => target.close(resolve))
    restore()
  }
})

test('R2: recordError keeps the last failure and one audit line per scope per minute', () => {
  const restore = isolateHome()
  try {
    resetErrorLog()
    recordError('demo-op', new Error('boom'))
    let state = readState()
    assert.equal(state.lastError.scope, 'demo-op')
    assert.equal(state.lastError.message, 'boom')
    const lines = () => readState().history.filter((entry) => entry.op === 'error' && entry.detail.includes('demo-op')).length
    assert.equal(lines(), 1)
    recordError('demo-op', new Error('boom again'))
    assert.equal(lines(), 1, 'a failing loop must not flush the audit trail')
    assert.equal(readState().lastError.message, 'boom again')
  } finally {
    restore()
  }
})

test('R4: the repair window slides over ten minutes and the pause escalates', () => {
  const restore = isolateHome()
  try {
    resetThrottle()
    const t0 = Date.now()
    // Three repairs, each a minute apart: the old counter reset every minute, so this never
    // tripped. The window now remembers the whole ten minutes.
    assert.deepEqual(noteRepairs(['gemini'], t0), [])
    assert.deepEqual(noteRepairs(['gemini'], t0 + 61_000), [])
    const first = noteRepairs(['gemini'], t0 + 122_000)
    assert.equal(first.length, 1)
    assert.equal(first[0].minutes, 10)
    assert.equal(first[0].offenses, 1)
    assert.equal(readState().reconcileOffenses.gemini, 1)
    // Standing down means standing down: a repair inside the window is not counted.
    assert.deepEqual(noteRepairs(['gemini'], t0 + 200_000), [])
    // After the window closes, the next offence escalates instead of repeating ten minutes.
    const t1 = t0 + 122_000 + 10 * 60_000 + 5_000
    noteRepairs(['gemini'], t1)
    noteRepairs(['gemini'], t1 + 1_000)
    const second = noteRepairs(['gemini'], t1 + 2_000)
    assert.equal(second.length, 1)
    assert.equal(second[0].minutes, 30)
    assert.equal(second[0].offenses, 2)
  } finally {
    restore()
  }
})

test('C3: the plugin never writes a launcher-reserved name into .env again', () => {
  const restore = isolateHome()
  try {
    const home = process.env.DSH_HOME
    fs.writeFileSync(path.join(home, '.env'), [
      'NO_PROXY=localhost,127.0.0.1,::1',
      '# dsh-egress-router (managed) — bot egress',
      'DSH_TELEGRAM_PROXY=http://127.0.0.1:7897',
      '# /dsh-egress-router (managed)',
      'DSH_TELEGRAM_PROXY=http://127.0.0.1:7897',
      'KEEP_ME=1',
    ].join('\n') + '\n')
    const result = cleanupManagedEnv({ envVar: 'DSH_TELEGRAM_PROXY' })
    assert.equal(result.changed, true)
    const text = fs.readFileSync(path.join(home, '.env'), 'utf8')
    assert.equal(text.includes('DSH_TELEGRAM_PROXY'), false)
    assert.match(text, /^NO_PROXY=localhost/m)
    assert.match(text, /^KEEP_ME=1/m)
    // Idempotent: a clean file is left byte-for-byte alone.
    assert.equal(cleanupManagedEnv({ envVar: 'DSH_TELEGRAM_PROXY' }).changed, false)
    // The only write to .env in the whole plugin is that repair.
    const bots = fs.readFileSync(path.join(ROOT, 'lib/bots.js'), 'utf8')
    assert.equal((bots.match(/writeFileSync\(/g) ?? []).length, 1)
  } finally {
    restore()
  }
})

test('U1/U2/C2: the client probes its loader, aborts stale refreshes and exposes aria state', () => {
  const source = fs.readFileSync(path.join(ROOT, 'client/client.js'), 'utf8')
  // Loader probe: the tab must survive a host that renamed __ModuleLoader__ (0.7.x threw).
  assert.match(source, /typeof __loader\.load !== 'function'/)
  assert.match(source, /window\.__ModuleLoader__/)
  // Sequencing: a stale answer must never overwrite a newer one.
  assert.match(source, /seq !== refreshSeq/)
  assert.match(source, /AbortController/)
  assert.match(source, /refreshController\.abort\(\)/)
  // Bursts collapse into one request. 0.10.0: the timer used to call refreshSoon() again,
  // so a quiet refresh re-armed forever and never reached the host.
  assert.match(source, /function refreshSoon\(\)/)
  assert.match(source, /refreshAll\(\{ quiet: true \}\)/)
  // Every write button is disabled while a write is in flight.
  assert.match(source, /disabled: anyBusy/)
  assert.match(source, /aria-busy/)
  assert.match(source, /role: 'alert'/)
  assert.match(source, /aria-live/)
  // The hint users needed is wired, and the placeholder key is gone.
  assert.match(source, /botLaunchHint/)
  assert.equal(source.includes('botBot'), false)
})
