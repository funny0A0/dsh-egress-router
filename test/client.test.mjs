import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

test('client bundle registers a settings tab', () => {
  const source = fs.readFileSync(path.join(here, '..', 'client', 'client.js'), 'utf8')
  let loaded = null
  let registered = null
  let injected = null
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
  }
  const sandbox = {
    window: { __ModuleLoader__: { load: (mod) => { loaded = mod } } },
    console,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout,
    clearTimeout,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  assert.ok(loaded, 'module loader was not called')
  assert.equal(loaded.id, 'dsh-egress-router')
  const exportsObj = loaded.factory((name) => {
    if (name === 'react') return react
    throw new Error('unexpected require: ' + name)
  })
  assert.equal(exportsObj.name, 'dsh-egress-router')
  assert.equal(exportsObj.inject.join(','), 'slots')
  exportsObj.apply({
    slots: {
      inject(name, fn) { injected = name; fn() },
      register(meta, component) { registered = { meta, component } },
    },
  })
  assert.equal(injected, 'settings.plugins.tab')
  assert.ok(registered, 'settings slot was not used')
  assert.equal(registered.meta.id, 'egress-router')
  assert.equal(registered.meta.name, 'settings.plugins.tab')
  assert.equal(registered.meta.label(), '出口路由')
  assert.equal(typeof registered.component, 'function')
})

test('client bundle survives a host without the settings slot', () => {
  const source = fs.readFileSync(path.join(here, '..', 'client', 'client.js'), 'utf8')
  let loaded = null
  const sandbox = { window: { __ModuleLoader__: { load: (mod) => { loaded = mod } } }, console, fetch: async () => ({}) }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  const exportsObj = loaded.factory(() => ({ createElement: () => null }))
  assert.doesNotThrow(() => exportsObj.apply({}))
})

test('client renders a proxy picker whose options come from config.proxies', () => {
  const source = fs.readFileSync(path.join(here, '..', 'client', 'client.js'), 'utf8')
  let loaded = null
  let registered = null
  let hooks = 0
  const loadedState = {
    loading: false,
    config: { proxies: { clash: 'http://127.0.0.1:7897' } },
    discovered: { items: [{ id: 'llm:openrouter', kind: 'llm', name: 'OpenRouter', target: 'openrouter.ai:443', patchable: true }] },
    routes: [], status: [], metrics: {}, history: [], patches: [], listeners: [], warnings: [], backups: 0,
  }
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (initial) => { const index = hooks++; return [index === 0 ? loadedState : initial, () => {}] },
    useEffect: () => {},
  }
  const sandbox = { window: { __ModuleLoader__: { load: (mod) => { loaded = mod } } }, console, fetch: async () => ({ ok: true, json: async () => ({}) }) }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  const exportsObj = loaded.factory((name) => {
    if (name === 'react') return react
    throw new Error('unexpected require: ' + name)
  })
  exportsObj.apply({
    slots: {
      inject(name, fn) { fn() },
      register(meta, component) { registered = { meta, component } },
    },
  })
  assert.ok(registered, 'settings slot was not used')
  const tree = registered.component()
  const nodes = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    nodes.push(node)
    ;(node.children || []).forEach(walk)
  }
  walk(tree)
  const select = nodes.find((node) => node.type === 'select')
  assert.ok(select, 'no proxy select was rendered')
  const values = (select.children || []).flat(Infinity).filter((option) => option && option.type === 'option').map((option) => option.props && option.props.value)
  assert.deepEqual(values, ['', 'clash'])
})

test('the page loads the row list on mount instead of waiting for a manual scan', async () => {
  const source = fs.readFileSync(path.join(here, '..', 'client', 'client.js'), 'utf8')
  let loaded = null
  let registered = null
  let hooks = 0
  const effects = []
  const urls = []
  const loadedState = {
    loading: false,
    config: { proxies: {} },
    discovered: { items: [] },
    routes: [], status: [], metrics: {}, history: [], patches: [], bots: [], listeners: [], warnings: [], backups: 0,
  }
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (initial) => { const index = hooks++; return [index === 0 ? loadedState : initial, () => {}] },
    useEffect: (fn) => { effects.push(fn) },
  }
  const sandbox = {
    window: { __ModuleLoader__: { load: (mod) => { loaded = mod } } },
    console,
    fetch: async (url) => {
      urls.push(String(url))
      const body = String(url).includes('op=discover') ? { items: [], warnings: [] } : {}
      return { ok: true, json: async () => body }
    },
    setTimeout,
    clearTimeout,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  const exportsObj = loaded.factory((name) => {
    if (name === 'react') return react
    throw new Error('unexpected require: ' + name)
  })
  exportsObj.apply({
    slots: {
      inject(name, fn) { fn() },
      register(meta, component) { registered = { meta, component } },
    },
  })
  registered.component()
  effects.forEach((fn) => fn())
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(urls.some((url) => url.includes('op=state')), 'state was not fetched on mount')
  assert.ok(urls.some((url) => url.includes('op=discover')), 'the row list was not fetched on mount')
})


test('the 0.10.0 page reaches the relay and batch ops', () => {
  const source = fs.readFileSync(path.join(here, '..', 'client', 'client.js'), 'utf8')
  assert.ok(source.includes("call('routes'"), 'relay rows never call the routes op')
  assert.ok(source.includes("callRaw('POST', BASE + '?op=batch'"), 'batch never calls the batch op')
  assert.ok(source.includes('relayTitle'), 'the relay section has no heading')
  assert.ok(source.includes('navigator.clipboard'), 'the copy-address button has no implementation')
  assert.ok(source.includes("t('batchSelect')"), 'the selection checkbox has no accessible label')
  for (const key of ['route-create', 'route-update', 'route-delete', 'batch']) {
    assert.ok(source.includes(key), 'history label missing: ' + key)
  }
})

test('a quiet refresh reaches the host instead of re-arming itself', () => {
  const source = fs.readFileSync(path.join(here, '..', 'client', 'client.js'), 'utf8')
  const body = source.slice(source.indexOf('function refreshSoon()'), source.indexOf('function refreshSoon()') + 400)
  assert.ok(!/refreshSoon\(\)\s*\n\s*\}, 150\)/.test(body), 'the debounce still calls itself')
  assert.ok(body.includes('refreshAll({ quiet: true })'), 'the debounce does not refresh')
})

test('a failed call keeps the machine code and payload', () => {
  const source = fs.readFileSync(path.join(here, '..', 'client', 'client.js'), 'utf8')
  assert.ok(source.includes('failure.code = json.error'), 'the error code is dropped')
  assert.ok(source.includes('failure.payload = json'), 'the batch payload is dropped')
})
