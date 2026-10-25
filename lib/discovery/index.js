// Read-only discovery: what in this DSH profile talks to the outside world.
// Zero network access here; probes live behind the UI's "check" button.
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { dshHome } from '../store.js'
import { knownOriginTarget } from '../patcher.js'
import { resolveProviderEndpoint } from '../provider-catalog.js'

const GUARDED = [
  'platform.deepseek.com',
  'api.deepseek.com',
  'registry.npmjs.org',
  'awesome-dsh-plugin.com',
  'dsh-plugin-catalog',
]

/**
 * The protected list is a default, not a law (0.11.0): config.guarded appends hosts, so an
 * operator can protect their own identity provider without editing this file. A trailing
 * path/port is accepted and dropped, because people paste URLs where hosts are expected.
 */
export function guardedHosts(extra = null) {
  const list = [...GUARDED]
  if (Array.isArray(extra)) {
    for (const raw of extra) {
      const host = String(raw || '')
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .split('/')[0]
        .replace(/:\d+$/, '')
      if (host && !list.includes(host)) list.push(host)
    }
  }
  return list
}

/** Suffix-aware membership: guarding example.com also guards api.example.com. */
export function isGuarded(host, list = GUARDED) {
  if (!host) return false
  const h = String(host).toLowerCase().split(':')[0]
  return list.some((entry) => h === entry || h.endsWith('.' + entry))
}

const NOISE_HOSTS = new Set([
  'github.com', 'raw.githubusercontent.com', 'npmjs.com', 'www.npmjs.com', 'nodejs.org',
  'schema.org', 'json-schema.org', 'w3.org', 'developer.mozilla.org', 'wikipedia.org',
  'opensource.org', 'reactjs.org', 'rollupjs.org', 'esbuild.github.io', 'vitest.dev',
])

export function readPatch(profileDir) {
  const file = path.join(profileDir, 'cordis.patch.yml')
  try {
    const doc = yaml.load(fs.readFileSync(file, 'utf8'))
    return { file, doc: Array.isArray(doc) ? doc : [] }
  } catch {
    return { file, doc: [] }
  }
}

export function hostOf(url) {
  try {
    const parsed = new URL(String(url))
    const port = parsed.port ? ':' + parsed.port : ''
    return parsed.hostname + port
  } catch {
    return null
  }
}

function targetOf(url) {
  try {
    const parsed = new URL(String(url))
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
    return parsed.hostname + ':' + port
  } catch {
    return null
  }
}

// Routes this plugin already installed, read back from its own patch entry.
export function configuredRoutes(patch) {
  const routes = []
  for (const entry of patch.doc) {
    if (!entry || typeof entry !== 'object') continue
    const id = String(entry.id || '')
    const name = String(entry.name || '')
    if (id !== 'egress-router' && name !== 'dsh-egress-router') continue
    for (const route of entry.config?.routes ?? []) {
      if (route && route.target) routes.push(route)
    }
  }
  return routes
}

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[?::1\]?)$/i

// A baseURL already pointing at one of our relays describes the relay, not the
// real service: report the configured target instead so the UI never shows a
// self-loop and never re-routes a target into itself.
function hostnameOf(value) {
  try { return new URL(String(value)).hostname } catch { return '' }
}

function routedThrough(baseURL, routes) {
  if (!baseURL) return null
  let parsed
  try { parsed = new URL(baseURL) } catch { return null }
  if (!LOOPBACK.test(parsed.hostname)) return null
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
  return routes.find((route) => Number(route.listenPort) === port) ?? null
}

function llmItems(patch, routes, options = {}) {
  const items = []
  const guardedList = options.guarded ?? GUARDED
  const origins = options.origins ?? {}
  for (const entry of patch.doc) {
    if (!entry || typeof entry !== 'object') continue
    if (entry.id !== 'llm-pi-ai' && !String(entry.name || '').includes('llm-pi-ai')) continue
    const providers = entry.config?.providers
    if (!providers || typeof providers !== 'object') continue
    for (const [key, provider] of Object.entries(providers)) {
      if (!provider || typeof provider !== 'object') continue
      const baseURL = typeof provider.baseURL === 'string' ? provider.baseURL : null
      const route = routedThrough(baseURL, routes)
      // 0.13.0: providers imported through the app carry only models + apiKeyEnv; the host
      // fills baseURL from its pi-ai catalog at runtime. Resolve the same endpoint here so
      // the row is configurable instead of showing "—". Resolve even when a literal baseURL
      // exists: the answer also says whether the host catalog owns the provider, which is
      // what forbids writing an `api` field (0.13.1).
      const resolved = resolveProviderEndpoint(key, {
        baseURL,
        api: provider.api ?? null,
        providerDefaults: options.providerDefaults ?? {},
        dirs: options.catalogDirs ?? null,
      })
      const endpoint = baseURL || resolved?.baseURL || null
      // A loopback baseURL with no live route means the relay was undone while the provider
      // kept pointing at it. Show the endpoint we know instead of "127.0.0.1:<port>", which
      // reads like a target and gets refused by apply (0.5.4).
      const baseHost = baseURL ? hostnameOf(baseURL) : ''
      const stale = Boolean(baseHost && LOOPBACK.test(baseHost) && !route)
      const recovered = stale ? knownOriginTarget(key, origins, options.providerDefaults ?? {}) : null
      const target = route ? route.target : recovered || (endpoint ? targetOf(endpoint) : null)
      items.push({
        id: 'llm:' + key,
        kind: 'llm',
        name: provider.displayName || key,
        api: provider.api || null,
        catalogApi: resolved?.catalogApi ?? null,
        reuseCatalog: Boolean(resolved?.reuseCatalog),
        baseURL: endpoint,
        configuredBaseURL: baseURL,
        endpointSource: baseURL ? (stale ? 'ledger' : 'config') : resolved?.source ?? null,
        target,
        apiKeyEnv: provider.apiKeyEnv || null,
        source: 'cordis.patch.yml › llm-pi-ai.providers.' + key,
        confidence: 'certain',
        guarded: target ? isGuarded(hostOf(endpoint), guardedList) : false,
        routed: Boolean(route),
        stale,
        listenPort: route ? Number(route.listenPort) : null,
        proxy: route?.proxy ?? null,
      })
    }
  }
  return items
}

function imItems(patch, installed) {
  const items = []
  const hasIm = installed.some((name) => /dsh-im$/.test(name))
  for (const entry of patch.doc) {
    if (!entry || typeof entry !== 'object') continue
    const name = String(entry.name || '')
    const id = String(entry.id || '')
    if (!/im$/i.test(id) && !/dsh-im/.test(name)) continue
    const channels = entry.config?.channels ?? entry.config?.bots ?? entry.config
    if (channels && typeof channels === 'object') {
      for (const [channel, value] of Object.entries(channels)) {
        const endpoint = typeof value?.endpoint === 'string' ? value.endpoint : null
        const target = endpoint ? targetOf(endpoint) : null
        if (channel === 'telegram' || (target && /telegram/.test(target))) {
          items.push({
            id: 'im:telegram',
            kind: 'im',
            name: 'Telegram',
            baseURL: endpoint || 'https://api.telegram.org',
            target: target || 'api.telegram.org:443',
            apiKeyEnv: null,
            source: 'cordis.patch.yml › ' + (id || name) + ' › ' + channel,
            confidence: 'certain',
            guarded: false,
            bot: 'telegram',
          })
        }
      }
    }
  }
  if (!items.length && hasIm) {
    items.push({
      id: 'im:telegram',
      kind: 'im',
      name: 'Telegram',
      baseURL: 'https://api.telegram.org',
      target: 'api.telegram.org:443',
      apiKeyEnv: null,
      source: 'installed bundle @xmanrui/dsh-im (default endpoint)',
      confidence: 'likely',
      guarded: false,
      bot: 'telegram',
    })
  }
  return items
}

function scanConfigHosts(value, out, trail) {
  if (typeof value === 'string') {
    const match = value.match(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?/gi)
    if (match) for (const url of match) out.push({ url, trail })
    return
  }
  if (Array.isArray(value)) { value.forEach((item, index) => scanConfigHosts(item, out, trail + '[' + index + ']')); return }
  if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) scanConfigHosts(inner, out, trail + '.' + key)
  }
}

/** Exact host equality: a prefix test would treat api.example.com.evil as api.example.com. */
function sameHost(target, host) {
  return String(target || '').split(':')[0].toLowerCase() === String(host || '').split(':')[0].toLowerCase()
}

function unknownBundleItems(patch, profileDir, known, installed, guardedList = GUARDED) {
  const found = new Map()
  for (const entry of patch.doc) {
    if (!entry || typeof entry !== 'object' || entry.config === undefined) continue
    const hits = []
    scanConfigHosts(entry.config, hits, String(entry.id || entry.name || 'entry'))
    for (const hit of hits) {
      const host = hostOf(hit.url)
      if (!host || NOISE_HOSTS.has(host.split(':')[0])) continue
      if (isGuarded(host, guardedList)) continue
      if (known.some((item) => item.target && sameHost(item.target, host))) continue
      const target = targetOf(hit.url)
      if (!target) continue
      const key = 'cfg:' + host
      if (!found.has(key)) {
        found.set(key, {
          id: key,
          kind: 'other',
          name: hit.url.replace(/^https?:\/\//, '').split('/')[0],
          baseURL: hit.url,
          target,
          apiKeyEnv: null,
          source: 'cordis.patch.yml › ' + hit.trail,
          confidence: 'low',
          guarded: false,
        })
      }
    }
  }
  for (const name of installed) {
    if (name.startsWith('@deepseek-ai/')) continue
    const patchFile = path.join(profileDir, 'node_modules', name, 'cordis.patch.yml')
    if (!fs.existsSync(patchFile)) continue
    let text = ''
    try { text = fs.readFileSync(patchFile, 'utf8') } catch { continue }
    const hosts = text.match(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?/gi) || []
    for (const url of hosts) {
      const host = hostOf(url)
      if (!host || NOISE_HOSTS.has(host.split(':')[0])) continue
      if (isGuarded(host, guardedList)) continue
      const key = 'pkg:' + host
      if (found.has(key) || known.some((item) => item.target && sameHost(item.target, host))) continue
      found.set(key, {
        id: key,
        kind: 'other',
        name: name + ' → ' + host,
        baseURL: url,
        target: targetOf(url),
        apiKeyEnv: null,
        source: 'bundle ' + name + '/cordis.patch.yml',
        confidence: 'low',
        guarded: false,
      })
    }
  }
  return [...found.values()]
}

export function installedBundles(profileDir) {
  const manifest = path.join(profileDir, 'package.json')
  try {
    const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'))
    const list = pkg?.dsh?.profile?.bundles
    if (Array.isArray(list) && list.length) return list.filter((name) => typeof name === 'string')
    return Object.keys(pkg?.dependencies ?? {})
  } catch {
    return []
  }
}

function envWarnings() {
  const warnings = []
  const file = path.join(dshHome(), '.env')
  try {
    const text = fs.readFileSync(file, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*(https?_proxy|all_proxy)\s*=/i.test(line)) {
        warnings.push({
          code: 'global-proxy-env',
          message: '.env 里仍然设置了 ' + line.split('=')[0].trim() + '：它会对整个 DSH 进程生效，代理一挂就全盘皆挂。建议删除，改用本插件的逐项端口。',
        })
      }
    }
  } catch {
    // no .env is the healthy case
  }
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    if (process.env[key]) warnings.push({ code: 'global-proxy-env', message: '进程环境变量里有 ' + key + '，会对整个 DSH 进程生效。' })
  }
  return warnings
}

/**
 * config.targets entries (0.9.0): endpoints the user wants to observe even though they never
 * appear in a provider baseURL. Accepts {host, port}, {target: 'host:port'} or {url}, because
 * all three read naturally in YAML and guessing wrong silently hides the row.
 */
export function normalizeTargets(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    let host = typeof raw.host === 'string' ? raw.host.trim() : ''
    let port = Number(raw.port) || 0
    if (!host && typeof raw.target === 'string') {
      const [h, p] = raw.target.split(':')
      host = (h ?? '').trim()
      port = port || Number(p) || 0
    }
    if (!host && typeof raw.url === 'string') {
      try {
        const parsed = new URL(raw.url)
        host = parsed.hostname
        port = port || Number(parsed.port) || (parsed.protocol === 'http:' ? 80 : 443)
      } catch {
        host = ''
      }
    }
    if (!host) continue
    const id = String(raw.id || host).trim().replace(/[^a-z0-9_.:-]+/gi, '-')
    out.push({ id, name: String(raw.name || raw.id || host), host, port: port || 443 })
  }
  return out
}

function customItems(targets, known) {
  const seen = new Set(known.map((item) => item.target).filter(Boolean))
  const items = []
  for (const entry of normalizeTargets(targets)) {
    const target = entry.host + ':' + entry.port
    if (seen.has(target)) continue
    seen.add(target)
    items.push({
      id: 'custom:' + entry.id,
      kind: 'custom',
      name: entry.name,
      baseURL: null,
      target,
      apiKeyEnv: null,
      source: 'config.targets',
      confidence: 'certain',
      guarded: false,
    })
  }
  return items
}

/** Host part of a `host:port` target, lower-cased; empty when the row has no target. */
function targetHost(item) {
  return String(item?.target || '').toLowerCase().split(':')[0]
}

const RULE_FIELDS = ['kind', 'name', 'patchable', 'guarded', 'confidence', 'note']

/**
 * Declarative discovery rules (0.11.0).
 *
 * The built-in scan is a set of heuristics: it knows llm-pi-ai providers, dsh-im channels and
 * "some https:// literal in a config". That cannot cover an operator's own services, and it
 * cannot be taught without shipping a release. A rule is a match plus the fields to override;
 * all conditions in `match` must hold, and the first matching rule wins, so ordering is the
 * user's precedence control.
 */
function ruleMatches(rule, item) {
  const m = rule?.match
  if (!m || typeof m !== 'object') return false
  const host = targetHost(item)
  const id = String(item?.id || '')
  if (typeof m.id === 'string' && m.id) {
    const prefix = m.id.replace(/\*$/, '')
    if (!id.startsWith(prefix)) return false
  }
  if (typeof m.kind === 'string' && m.kind && String(item?.kind || '') !== m.kind) return false
  if (typeof m.host === 'string' && m.host && host !== m.host.toLowerCase()) return false
  if (typeof m.hostSuffix === 'string' && m.hostSuffix) {
    const suffix = m.hostSuffix.toLowerCase().replace(/^\*?\./, '')
    if (host !== suffix && !host.endsWith('.' + suffix)) return false
  }
  if (typeof m.urlIncludes === 'string' && m.urlIncludes && !String(item?.baseURL || '').includes(m.urlIncludes)) return false
  return true
}

/** Apply ignore-list + rules to discovered rows. Pure: the caller keeps the raw list. */
export function applyRules(items, { rules = null, ignore = null } = {}) {
  const ignored = (Array.isArray(ignore) ? ignore : [])
    .map((raw) => String(raw || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/:\d+$/, ''))
    .filter(Boolean)
  const compiled = (Array.isArray(rules) ? rules : []).filter((rule) => rule && typeof rule === 'object')
  const out = []
  let matched = 0
  for (const item of items) {
    const host = targetHost(item)
    if (ignored.length && ignored.some((entry) => host === entry || host.endsWith('.' + entry))) continue
    const rule = compiled.find((candidate) => ruleMatches(candidate, item))
    let next = item
    if (rule) {
      matched += 1
      const patch = {}
      for (const field of RULE_FIELDS) if (rule[field] !== undefined) patch[field] = rule[field]
      next = { ...item, ...patch, rule: String(rule.id || rule.name || 'rule') }
    }
    out.push(next)
  }
  return { items: out, matched }
}

export function discover({
  profileDir,
  routes: activeRoutes = null,
  targets = null,
  guarded = null,
  origins = {},
  providerDefaults = {},
  catalogDirs = null,
  discovery = null,
}) {
  const patch = readPatch(profileDir)
  // Routes live in the plugin's state since 0.2.1; the patch entry is only a legacy
  // seed, so prefer the caller's live list and fall back to it for old profiles.
  const routes = Array.isArray(activeRoutes) && activeRoutes.length ? activeRoutes : configuredRoutes(patch)
  const installed = installedBundles(profileDir)
  const guardedList = guardedHosts(guarded)
  const llm = llmItems(patch, routes, { guarded: guardedList, origins, providerDefaults, catalogDirs })
  const im = imItems(patch, installed)
  const known = [...llm, ...im]
  const others = unknownBundleItems(patch, profileDir, known, installed, guardedList)
  const custom = customItems(targets, [...known, ...others])
  const guardedItems = guardedList.map((host) => ({
    id: 'guarded:' + host,
    kind: 'guarded',
    name: host,
    baseURL: null,
    target: null,
    apiKeyEnv: null,
    source: 'protected list (built-in + config.guarded)',
    confidence: 'certain',
    guarded: true,
  }))
  const merged = applyRules([...llm, ...im, ...others, ...custom, ...guardedItems], discovery ?? {})
  return {
    generatedAt: new Date().toISOString(),
    profileDir,
    // Only llm providers have a rewritable baseURL; the UI must not offer "apply"
    // for the rest (im/telegram, third-party hosts) — those need a patch upstream.
    // A rule may override the verdict, and the host may accept a provider id that the
    // config does not contain (apply then answers provider_not_found, which is honest).
    items: merged.items.map((item) => ({
      ...item,
      patchable: item.patchable === undefined ? item.kind === 'llm' : Boolean(item.patchable),
    })),
    rulesApplied: merged.matched,
    guardedHosts: guardedList,
    warnings: envWarnings(),
    patchFile: patch.file,
  }
}
