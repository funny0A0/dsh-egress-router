// Endpoint resolution for providers whose profile entry only names models + apiKeyEnv.
//
// DSH fills baseURL/api at runtime from the pi-ai catalog bundled with the host, so a
// config-only reader sees nothing. We resolve the same values, in this order:
//   1. the literal baseURL in cordis.patch.yml   (the caller checks this first)
//   2. an endpoint this plugin recorded earlier  (route.originBaseURL / backups)
//   3. config.providerDefaults[key]
//   4. the host's pi-ai catalog (dist/providers/data/<key>.json)
//   5. a small table of public endpoints that rarely change
// Nothing here touches the network, and a missing catalog is not an error: the caller
// reports "unknown endpoint" and the UI keeps the row read-only.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const BUILTIN_ENDPOINTS = {
  deepseek: { baseURL: 'https://api.deepseek.com', api: 'openai-completions' },
  moonshot: { baseURL: 'https://api.moonshot.cn/v1', api: 'openai-completions' },
  'moonshotai-cn': { baseURL: 'https://api.moonshot.cn/v1', api: 'openai-completions' },
  moonshotai: { baseURL: 'https://api.moonshot.ai/v1', api: 'openai-completions' },
  google: { baseURL: 'https://generativelanguage.googleapis.com/v1beta', api: 'google-generative-ai' },
  openai: { baseURL: 'https://api.openai.com/v1', api: 'openai-completions' },
  anthropic: { baseURL: 'https://api.anthropic.com', api: 'anthropic-messages' },
  xai: { baseURL: 'https://api.x.ai/v1', api: 'openai-completions' },
  openrouter: { baseURL: 'https://openrouter.ai/api/v1', api: 'openai-completions' },
  groq: { baseURL: 'https://api.groq.com/openai/v1', api: 'openai-completions' },
  mistral: { baseURL: 'https://api.mistral.ai/v1', api: 'openai-completions' },
  together: { baseURL: 'https://api.together.xyz/v1', api: 'openai-completions' },
  fireworks: { baseURL: 'https://api.fireworks.ai/inference/v1', api: 'openai-completions' },
  cerebras: { baseURL: 'https://api.cerebras.ai/v1', api: 'openai-completions' },
  huggingface: { baseURL: 'https://router.huggingface.co/v1', api: 'openai-completions' },
  zai: { baseURL: 'https://api.z.ai/api/paas/v4', api: 'openai-completions' },
  minimax: { baseURL: 'https://api.minimax.io/v1', api: 'openai-completions' },
}

export function builtinEndpoints() {
  return JSON.parse(JSON.stringify(BUILTIN_ENDPOINTS))
}

function canBeProviderKey(key) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(key || ''))
}

/**
 * Directories that may hold pi-ai's provider data. The Electron host keeps the whole
 * dependency tree inside app.asar, which plain Node cannot read, but the desktop host
 * itself can — and in dev/CI the same files sit in node_modules.
 */
export function catalogCandidates({ profileDir = null, resourcesPath = process.resourcesPath } = {}) {
  const dirs = []
  const explicit = process.env.EGRESS_PI_AI_DIR
  if (explicit) dirs.push(path.resolve(explicit))
  const suffix = path.join('@earendil-works', 'pi-ai', 'dist', 'providers', 'data')
  if (resourcesPath) {
    dirs.push(path.join(resourcesPath, 'app.asar', 'dsh', 'node_modules', suffix))
    dirs.push(path.join(resourcesPath, 'app', 'node_modules', suffix))
  }
  let cursor = profileDir ? path.resolve(profileDir) : null
  for (let depth = 0; cursor && depth < 6; depth += 1) {
    dirs.push(path.join(cursor, 'node_modules', suffix))
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  if (profileDir) {
    try {
      const require = createRequire(path.join(profileDir, 'package.json'))
      const pkg = require.resolve('@earendil-works/pi-ai/package.json')
      dirs.push(path.join(path.dirname(pkg), 'dist', 'providers', 'data'))
    } catch {
      // Not installed next to the profile: the other candidates may still work.
    }
  }
  return [...new Set(dirs)]
}

function pickGroup(doc, api) {
  const groups = Object.entries(doc).filter(([, value]) => value && typeof value === 'object')
  if (api && doc[api] && typeof doc[api] === 'object') return [api, doc[api]]
  const usable = groups.filter(([, models]) =>
    Object.values(models).some((model) => model && typeof model.baseUrl === 'string' && model.baseUrl))
  return usable[0] ?? groups[0] ?? null
}

// Electron patches fs to read inside app.asar; plain Node (dsh web, CI) does not have
// that patch. This reads an entry out of the archive directly so both hosts resolve the
// same catalog. Header layout: JSON starts at byte 16, its length is the u32 at byte 12.
const asarHeaders = new Map()

function asarEntry(asarPath, innerPath) {
  let header = asarHeaders.get(asarPath)
  if (!header) {
    let stat
    try {
      stat = fs.statSync(asarPath)
    } catch {
      return null
    }
    const cacheKey = stat.mtimeMs + ':' + stat.size
    header = asarHeaders.get(asarPath)
    if (!header || header.cacheKey !== cacheKey) {
      let fd
      try {
        fd = fs.openSync(asarPath, 'r')
        const head = Buffer.alloc(16)
        fs.readSync(fd, head, 0, 16, 0)
        const jsonLen = head.readUInt32LE(12)
        if (!jsonLen || jsonLen > 64 * 1024 * 1024) return null
        const body = Buffer.alloc(jsonLen)
        fs.readSync(fd, body, 0, jsonLen, 16)
        header = {
          cacheKey,
          json: JSON.parse(body.toString('utf8')),
          dataBase: 16 + jsonLen + ((4 - ((16 + jsonLen) % 4)) % 4),
        }
        asarHeaders.set(asarPath, header)
      } catch {
        return null
      } finally {
        if (fd !== undefined) {
          try { fs.closeSync(fd) } catch { /* already gone */ }
        }
      }
    }
  }
  let node = header.json
  for (const part of innerPath.split('/')) {
    if (node && node.files) node = node.files
    if (!node || !node[part]) return null
    node = node[part]
  }
  if (!node || typeof node.size !== 'number' || node.offset === undefined) return null
  let fd
  try {
    fd = fs.openSync(asarPath, 'r')
    const buf = Buffer.alloc(node.size)
    fs.readSync(fd, buf, 0, node.size, header.dataBase + Number(node.offset))
    return buf.toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch { /* already gone */ }
    }
  }
}

function readCatalogFile(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    const marker = file.toLowerCase().indexOf('.asar' + path.sep.toLowerCase())
    if (marker < 0) return null
    const asarPath = file.slice(0, marker + 5)
    return asarEntry(asarPath, file.slice(marker + 6).split(path.sep).join('/'))
  }
}

/** Read one provider's bundled catalog entry. Returns null when the file is absent. */
export function readProviderCatalog(providerKey, { dirs = null, api = null } = {}) {
  if (!canBeProviderKey(providerKey)) return null
  for (const dir of dirs ?? catalogCandidates()) {
    const file = path.join(dir, String(providerKey) + '.json')
    const raw = readCatalogFile(file)
    if (raw === null) continue
    let doc
    try {
      doc = JSON.parse(raw)
    } catch {
      continue
    }
    const group = pickGroup(doc, api)
    if (!group) continue
    const [groupApi, models] = group
    const listed = Object.values(models).filter((model) => model && typeof model === 'object')
    const urls = [...new Set(listed.map((model) => model.baseUrl).filter((url) => typeof url === 'string' && url))]
    if (!urls.length) continue
    return {
      baseURL: urls[0],
      api: groupApi,
      models: listed.length,
      variants: urls,
      file,
      source: 'catalog',
    }
  }
  return null
}

function normalizeDefault(value) {
  if (!value) return null
  if (typeof value === 'string') return { baseURL: value, api: null }
  if (typeof value === 'object' && typeof value.baseURL === 'string') {
    return { baseURL: value.baseURL, api: typeof value.api === 'string' ? value.api : null }
  }
  return null
}

/**
 * Resolve one provider endpoint. `baseURL` is the literal config value; routes and the
 * plugin's own ledger are resolved by the caller because only it knows that history.
 */
export function resolveProviderEndpoint(providerKey, {
  baseURL = null,
  api = null,
  providerDefaults = {},
  dirs = null,
} = {}) {
  if (typeof baseURL === 'string' && baseURL) return { baseURL, api: api ?? null, source: 'config' }
  const declared = normalizeDefault(providerDefaults?.[providerKey])
  if (declared) return { baseURL: declared.baseURL, api: api ?? declared.api ?? null, source: 'providerDefaults' }
  const catalog = readProviderCatalog(providerKey, { dirs, api })
  if (catalog) return { baseURL: catalog.baseURL, api: api ?? catalog.api, source: 'catalog', catalog }
  const builtin = BUILTIN_ENDPOINTS[providerKey]
  if (builtin) return { baseURL: builtin.baseURL, api: api ?? builtin.api ?? null, source: 'builtin' }
  return null
}