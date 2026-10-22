// 0.9.1 — the outward surface is a contract, and so is the client half. Both are locked
// against a checked-in snapshot so a host upgrade that renames a slot, drops an export or
// reshapes the state payload fails here instead of in the settings page.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { RelayManager } from '../lib/manager.js'
import { makeHandler } from '../lib/routes.js'
import { readState } from '../lib/store.js'
import { STATE_VERSION, validateState } from '../lib/schema.js'

const snapshot = JSON.parse(fs.readFileSync(new URL('./contract/api-surface.json', import.meta.url), 'utf8'))
const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const clientSource = fs.readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

const PATCH = [
  '- id: llm-pi-ai',
  '  config:',
  '    providers:',
  '      gemini:',
  '        baseURL: https://generativelanguage.googleapis.com/v1beta/openai',
  '',
].join('\n')

let seq = 0
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix + process.pid + '-' + ++seq + '-'))

const profileDir = tmp('contract-profile-')
fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), PATCH)
process.env.DSH_HOME = tmp('contract-home-')
const config = { proxies: {} }
const manager = new RelayManager({ config, log: () => {} })
const handler = makeHandler({ config, manager, profileDir, log: () => {}, stateDir: path.join(process.env.DSH_HOME, 'storages', 'egress-router'), verify: null })
const server = http.createServer(handler)
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + server.address().port + '/plugins/egress-router'

const get = async (op) => {
  const response = await fetch(base + '?op=' + op)
  return { status: response.status, data: await response.json().catch(() => null) }
}
const post = async (op, body) => {
  const response = await fetch(base + '?op=' + op, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify(body),
  })
  return { status: response.status, data: await response.json().catch(() => null) }
}

try {
  const { status, data: state } = await get('state')
  assert.equal(status, 200)

  // 1. Server surface: exact key set, protocol version, declared schema version.
  assert.deepEqual(Object.keys(state).sort(), snapshot.stateKeys, 'state payload keys drifted from the snapshot')
  assert.equal(state.apiVersion, snapshot.apiVersion)
  assert.equal(state.schemaVersion, snapshot.schemaVersion)
  assert.equal(state.schemaOk, true, 'the state document does not satisfy the declared schema')
  assert.deepEqual(state.schemaErrors, [])

  // 2. The validator agrees with the document the plugin just wrote, and it rejects garbage.
  const written = validateState(readState())
  assert.equal(written.ok, true, JSON.stringify(written.errors))
  assert.equal(written.version, STATE_VERSION)
  const broken = validateState({ ...readState(), routes: [{ id: 'x', target: 'no-port', listenPort: 0 }] })
  assert.equal(broken.ok, false)
  assert.ok(broken.errors.some((row) => row.path.endsWith('.listenPort')))

  // 3. Error codes are part of the contract: a caller switches on them.
  const probes = {
    unknown_op: () => get('nope'),
    invalid_action: () => post('patch', { id: 'telegram-proxy', action: 'explode' }),
    unknown_patch: () => post('patch', { id: 'nope', action: 'verify' }),
    provider_not_found: () => post('apply', { itemId: 'llm:nope', target: 'example.com:443', listenPort: 8799 }),
    private_target: () => post('probe', { target: '127.0.0.1:1' }),
    unknown_route: () => post('routes', { action: 'delete', id: 'relay:nope' }),
    no_actions: () => post('batch', { actions: [] }),
    loopback_target: () => post('routes', { action: 'upsert', id: 'relay:local', target: '127.0.0.1:9', listenPort: 8799 }),
  }
  for (const [code, expected] of Object.entries(snapshot.errorCodes)) {
    const result = await probes[code]()
    assert.equal(result.data?.error, code, 'expected error code ' + code)
    assert.equal(result.status, expected, 'status for ' + code + ' drifted')
  }

  // 3b. The 0.10.0 route surface: listing is read-only and carries the api version.
  const listed = await get('routes')
  assert.equal(listed.status, 200)
  assert.equal(listed.data.apiVersion, snapshot.apiVersion)
  assert.ok(Array.isArray(listed.data.routes))

  // 4. Client half: the host loads it by these strings, so they are contract too.
  assert.deepEqual(state.clientContract.loader, snapshot.client.loader)
  assert.deepEqual(state.clientContract.slot, snapshot.client.slot)
  assert.ok(clientSource.includes(snapshot.client.loader), 'client does not use the declared loader')
  assert.ok(clientSource.includes("'" + snapshot.client.slot + "'"), 'client does not register on the declared slot')
  assert.ok(clientSource.includes(snapshot.client.label), 'client no longer labels the tab')
  // 0.10.0: the page must actually reach the two new ops.
  assert.ok(clientSource.includes('?op=batch'), 'client does not call the batch op')
  assert.ok(clientSource.includes("call('routes'"), 'client does not call the routes op')

  // 5. Package metadata the host reads before it ever runs our code.
  assert.deepEqual(Object.keys(manifest.exports).sort(), snapshot.client.exports)
  assert.deepEqual(manifest.dsh.client, snapshot.client.dshClient)
  assert.equal(typeof manifest.dsh.bundle.patch, 'string')

  console.log('ok   contract: state keys, error codes, client loader/slot and package exports match the snapshot (v' + snapshot.apiVersion + ', state v' + STATE_VERSION + ')')
} finally {
  await manager.dispose()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
