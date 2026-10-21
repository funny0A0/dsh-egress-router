// 0.7.0 — the outward API is a contract too: lock the state payload's key set and the
// error codes, so a host upgrade that changes the shape fails here instead of in the page.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { RelayManager } from '../lib/manager.js'
import { makeHandler } from '../lib/routes.js'

const STATE_KEYS = [
  'backups',
  'bots',
  'config',
  'contract',
  'discovered',
  'discoveredAt',
  'drift',
  'hostEnv',
  'history',
  'lastError',
  'clientContract',
  'listeners',
  'metrics',
  'patches',
  'paused',
  'profileDir',
  'profileOk',
  'routes',
  'schemaVersion',
  'status',
  'tuning',
  'warnings',
].sort()

const PATCH = [
  '- id: llm-pi-ai',
  '  config:',
  '    providers:',
  '      gemini:',
  '        baseURL: https://generativelanguage.googleapis.com/v1beta/openai',
  '',
].join('\n')

let seq = 0
function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + process.pid + '-' + ++seq + '-'))
}

function boot() {
  const profileDir = tmp('api-profile-')
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), PATCH)
  process.env.DSH_HOME = tmp('api-home-')
  const manager = new RelayManager({ config: { proxies: {} }, log: () => {} })
  const handler = makeHandler({ config: { proxies: {} }, manager, profileDir, log: () => {}, stateDir: path.join(process.env.DSH_HOME, 'storages', 'egress-router'), verify: null })
  const server = http.createServer(handler)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, manager, base: 'http://127.0.0.1:' + server.address().port + '/plugins/egress-router' }))
  })
}

async function call(base, op, { method = 'GET', body = null } = {}) {
  const response = await fetch(base + '?op=' + op, {
    method,
    headers: Object.assign({ 'content-type': 'application/json' }, method === 'POST' ? { 'sec-fetch-site': 'same-origin' } : {}),
    body: body === null ? undefined : JSON.stringify(body),
  })
  const data = await response.json().catch(() => null)
  return { status: response.status, data }
}

const booted = await boot()
try {
  const state = await call(booted.base, 'state')
  assert.equal(state.status, 200)
  assert.deepEqual(Object.keys(state.data).sort(), STATE_KEYS)
  assert.equal(typeof state.data.schemaVersion, 'number')
  assert.equal(Array.isArray(state.data.paused), true)
  assert.equal(Array.isArray(state.data.routes), true)

  const unknown = await call(booted.base, 'nope')
  assert.equal(unknown.status, 404)
  assert.equal(unknown.data.error, 'unknown_op')

  const badAction = await call(booted.base, 'patch', { method: 'POST', body: { id: 'telegram-proxy', action: 'explode' } })
  assert.equal(badAction.status, 400)
  assert.equal(badAction.data.error, 'invalid_action')

  const badPatch = await call(booted.base, 'patch', { method: 'POST', body: { id: 'nope', action: 'verify' } })
  assert.equal(badPatch.status, 404)
  assert.equal(badPatch.data.error, 'unknown_patch')

  const badProvider = await call(booted.base, 'apply', { method: 'POST', body: { itemId: 'llm:nope', target: 'example.com:443', listenPort: 8799 } })
  assert.equal(badProvider.status, 400)
  assert.equal(badProvider.data.error, 'provider_not_found')

  const privateTarget = await call(booted.base, 'probe', { method: 'POST', body: { target: '127.0.0.1:1' } })
  assert.equal(privateTarget.status, 400)
  assert.equal(privateTarget.data.error, 'private_target')

  const badOrigin = await call(booted.base, 'apply', { method: 'POST', body: { itemId: 'llm:gemini', target: 'generativelanguage.googleapis.com:443', listenPort: 8799, origin: 'not a url' } })
  assert.equal(badOrigin.status, 400)
  assert.equal(badOrigin.data.error, 'invalid_origin')
  console.log('ok   api surface: state keys and error codes are stable')
} finally {
  await booted.manager.dispose()
  booted.server.close()
}
