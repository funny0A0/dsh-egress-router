import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import { apply } from '../lib/index.js'

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolve(port))
    })
  })
}

function profileFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-plugin-'))
  const doc = [{ id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { gemini: { baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai' } } } }]
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), yaml.dump(doc))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'profile', dsh: { profile: { bundles: [] } } }))
  return dir
}

test('apply starts a listener and mounts the settings API', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const profileDir = profileFixture()
  const listenPort = await freePort()
  const config = { profileDir, routes: [{ id: 'smoke', target: '192.0.2.1:9', listenPort, tls: false, enabled: true }], proxies: {} }
  const registrations = []
  const disposers = []
  const lifecycle = []
  const ctx = {
    logger: { info() {} },
    inject(services, factory) {
      const hostCtx = {
        webServer: {
          register(route) {
            registrations.push(route)
            return () => {}
          },
        },
      }
      disposers.push(factory(hostCtx))
    },
    on(event, handler) { lifecycle.push({ event, handler }) },
  }
  try {
    await apply(ctx, config)
    assert.equal(registrations.length, 1)
    assert.equal(registrations[0].path, '/plugins/egress-router')
    const server = http.createServer(registrations[0].handler)
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    const state = await (await fetch('http://127.0.0.1:' + port + '?op=state', { signal: AbortSignal.timeout(5000) })).json()
    assert.equal(state.status[0].id, 'smoke')
    assert.equal(state.status[0].port, listenPort)
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  } finally {
    for (const entry of lifecycle) { try { entry.handler() } catch {} }
    for (const dispose of disposers) { try { dispose() } catch {} }
    const state = await (await fetch('http://127.0.0.1:' + listenPort + '/__health', { signal: AbortSignal.timeout(2000) }).catch(() => null))
    assert.equal(state, null)
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})
