import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
const PROFILE = 'C:/Users/86139/.dsh/profiles/desktop/node_modules/dsh-egress-router'
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-keys-home-'))
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-keys-profile-'))
fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), yaml.dump([{ id: 'llm-pi-ai', config: { providers: { gemini: { baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai' } } } }]))
fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'p', dsh: { profile: { bundles: [] } } }))
const { apply } = await import('file:///' + PROFILE + '/lib/index.js')
const regs = []
const ctx = { logger: { info() {} }, inject(s, f) { f({ webServer: { register(r) { regs.push(r); return () => {} } } }) }, on() {} }
await apply(ctx, { profileDir, routes: [], proxies: { clash: 'http://127.0.0.1:7897' }, verifyAfterApply: false })
const server = http.createServer(regs[0].handler)
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const res = await fetch('http://127.0.0.1:' + server.address().port + '/plugins/egress-router?op=state')
const state = await res.json()
console.log('API keys', Object.keys(state).length)
console.log(Object.keys(state).sort().join(' '))
server.closeAllConnections()
await new Promise((r) => server.close(r))
