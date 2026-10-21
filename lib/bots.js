// Chat-bot egress.
//
// A messaging plugin has no baseURL to rewrite: it calls its vendor API by hostname in
// code, so the only levers are (a) a small managed patch that makes its HTTP client
// honour an environment variable, and (b) that variable itself. 0.5.0 turns the pair into
// one row the settings page can operate, instead of "install it by hand and hope".
//
// The environment variable is read by the patched client when it builds a transport, so a
// change here lands on the next transport (i.e. after a DSH restart). We therefore always
// report restartRequired: pretending otherwise would leave the user staring at a spinner.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadDefinitions, inspect as inspectPatch, applyPatch } from './patches.js'

// 0.7.2, after 0.7.1 crashed every start: the DSH launcher treats a small set of names as
// "launching environment only" and refuses to boot when one appears in $DSH_HOME/.env —
// DSH_TELEGRAM_PROXY is such a name. Writing it there was my mistake, so this module no
// longer writes to .env at all. The proxy is persisted in the plugin state and applied to
// process.env at boot, before the messaging plugins build a transport; for a value the
// launcher itself needs, the OS environment is the only correct place, and the settings page
// says so instead of doing it.
const ENV_BEGIN = '# dsh-egress-router (managed) — bot egress'
const ENV_END = '# /dsh-egress-router (managed)'

function envFilePath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, '.env')
}

function readEnvText() {
  try {
    return fs.readFileSync(envFilePath(), 'utf8')
  } catch {
    return null
  }
}

/**
 * Remove the block 0.7.0/0.7.1 wrote, plus any stray assignment of a reserved name, and
 * nothing else. This is a repair for hosts already poisoned by the old behaviour: the file
 * only ever loses lines this plugin put there.
 */
export function cleanupManagedEnv({ envVar = 'DSH_TELEGRAM_PROXY' } = {}) {
  const text = readEnvText()
  if (text === null) return { changed: false, removed: [] }
  const removed = []
  const kept = []
  let inside = false
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === ENV_BEGIN) {
      inside = true
      continue
    }
    if (inside) {
      if (trimmed === ENV_END) inside = false
      else removed.push(trimmed)
      continue
    }
    if (trimmed.startsWith(envVar + '=')) {
      removed.push(trimmed)
      continue
    }
    kept.push(line)
  }
  if (!removed.length) return { changed: false, removed: [] }
  while (kept.length && kept[kept.length - 1] === '') kept.pop()
  fs.writeFileSync(envFilePath(), kept.length ? kept.join('\n') + '\n' : '')
  return { changed: true, removed }
}

export const BOT_TARGETS = {
  telegram: {
    id: 'telegram',
    patchId: 'telegram-proxy',
    envVar: 'DSH_TELEGRAM_PROXY',
    title: 'Telegram 机器人',
    titleEn: 'Telegram bot',
    note: '机器人进程内的 HTTP 客户端经本机代理出网；改动在下次启动 DSH 时生效。',
    noteEn: 'The bot talks to its vendor API through this machine; changes apply on the next DSH start.',
  },
}

function fail(status, code, message) {
  const err = new Error(message)
  err.status = status
  err.code = code
  return err
}

export function botTarget(id) {
  return BOT_TARGETS[String(id || '')] ?? null
}

/** Resolve a proxy name against the plugin's configured proxies. */
export function proxyUrlFor(proxies, name) {
  const url = proxies?.[name]
  if (!url) throw fail(400, 'unknown_proxy', 'unknown proxy: ' + name)
  return String(url)
}

function patchFor(target, definitions) {
  return definitions.find((def) => def.id === target.patchId) ?? null
}

/**
 * State of one bot row, computed from disk and the running process (never from the ledger):
 * patch status, the configured proxy, and what the environment currently says.
 */
export function botStatus({ id, bots, proxies, profileDir, stateDir, definitions = loadDefinitions() }) {
  const target = botTarget(id)
  if (!target) return null
  const def = patchFor(target, definitions)
  const record = bots?.[target.id] ?? null
  let patch = { id: target.patchId, status: def ? 'unknown' : 'missing_definition', detail: '', version: null }
  if (def) {
    try {
      const info = inspectPatch(def, { profileDir, stateDir })
      patch = { id: info.id, status: info.status, detail: info.detail, version: info.version, package: info.package, backup: info.backup }
    } catch (err) {
      patch = { id: target.patchId, status: 'error', detail: err?.message ?? String(err), version: null }
    }
  }
  const proxy = record?.proxy ?? null
  const url = proxy ? proxies?.[proxy] ?? null : null
  return {
    id: target.id,
    title: target.title,
    titleEn: target.titleEn,
    note: target.note,
    noteEn: target.noteEn,
    envVar: target.envVar,
    patchId: target.patchId,
    configured: Boolean(proxy),
    proxy,
    url,
    envValue: process.env[target.envVar] ?? null,
    patch,
  }
}

export function botList({ bots, proxies, profileDir, stateDir, definitions = loadDefinitions() }) {
  return Object.keys(BOT_TARGETS).map((id) => botStatus({ id, bots, proxies, profileDir, stateDir, definitions }))
}

/**
 * Point a bot at one of the configured proxies: make sure its patch is in place, then set
 * the environment variable the patched client reads.
 */
export function applyBotProxy({ id, proxyName, proxies, profileDir, stateDir, definitions = loadDefinitions() }) {
  const target = botTarget(id)
  if (!target) throw fail(404, 'unknown_bot', 'unknown bot: ' + id)
  const def = patchFor(target, definitions)
  if (!def) throw fail(500, 'patch_definition_missing', 'no patch definition for ' + target.patchId)
  const url = proxyUrlFor(proxies, proxyName)

  const before = inspectPatch(def, { profileDir, stateDir })
  let patch = before
  if (before.status === 'pending') patch = applyPatch(def, { profileDir, stateDir })
  else if (before.status !== 'applied') {
    throw fail(502, 'patch_' + before.status, 'cannot route this bot: ' + before.detail)
  }

  process.env[target.envVar] = url
  return {
    bot: { id: target.id, envVar: target.envVar, url, proxy: proxyName },
    patch,
    changed: before.status !== 'applied',
    restartRequired: true,
    // Applied to this process only. Writing it to $DSH_HOME/.env is exactly what made DSH
    // refuse to start (0.7.1), so the page tells the user where to set it instead.
    persisted: 'process',
    launchEnvVar: target.envVar,
    launchEnvHint:
      'already active in this session; to have it before DSH starts, set ' +
      target.envVar +
      ' in the OS environment (never in $DSH_HOME/.env, which the launcher rejects)',
  }
}

/** Remove the environment override; the patched client falls back to its own default. */
export function clearBotProxy({ id }) {
  const target = botTarget(id)
  if (!target) throw fail(404, 'unknown_bot', 'unknown bot: ' + id)
  delete process.env[target.envVar]
  cleanupManagedEnv({ envVar: target.envVar })
  return { bot: { id: target.id, envVar: target.envVar, url: null, proxy: null }, changed: true, restartRequired: true }
}

/**
 * Boot-time restore: put the configured bot egress back into this process before the
 * messaging plugins open their connections. Only entries the user configured are touched.
 */
export function restoreBots({ bots, proxies, profileDir, stateDir, definitions = loadDefinitions(), log = () => {} }) {
  const results = []
  for (const id of Object.keys(bots ?? {})) {
    const record = bots[id]
    if (!record?.proxy) continue
    try {
      const result = applyBotProxy({ id, proxyName: record.proxy, proxies, profileDir, stateDir, definitions })
      results.push({ id, ok: true, url: result.bot.url, changed: result.changed })
      log('[egress] bot ' + id + ' -> ' + result.bot.url)
    } catch (err) {
      results.push({ id, ok: false, error: err?.message ?? String(err) })
      log('[egress] bot ' + id + ' restore failed: ' + (err?.message ?? String(err)))
    }
  }
  return results
}
