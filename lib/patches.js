// Managed compatibility patches.
//
// Some third-party plugins pick their egress target in code instead of config: the
// only way to route them is to edit the installed file. Hand editing node_modules
// does not survive the next `pnpm add` (it silently reverts), so the edit is
// declared here as a single-anchor replacement, applied atomically, backed up with
// its original digest, and repaired on boot when a reinstall wipes it.
//
// Safety model:
//   * exactly one anchor occurrence, otherwise refuse (anchor_missing / anchor_ambiguous)
//   * version prefixes are declared per patch (unsupported versions are never touched)
//   * the pristine file is kept in state/patches/<id>.bak with its sha256
//   * boot repair only touches patches this plugin applied before (ledger), never a
//     package the user has not opted into
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { recordError } from './store.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_DEFINITIONS = path.join(here, '..', 'patches', 'definitions.json')

export function loadDefinitions(file = DEFAULT_DEFINITIONS) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const list = Array.isArray(parsed) ? parsed : parsed?.patches
    if (!Array.isArray(list)) return []
    return list.filter((def) => def && def.id && def.package && def.file && def.find && def.replace && def.marker)
  } catch {
    return []
  }
}

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function countOf(text, needle) {
  if (!needle) return 0
  let count = 0
  let index = text.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = text.indexOf(needle, index + needle.length)
  }
  return count
}

/** Resolve an installed package from the profile, following pnpm's symlinks. */
export function locatePackage(profileDir, packageName) {
  const direct = path.join(profileDir, 'node_modules', ...packageName.split('/'), 'package.json')
  let manifest = null
  try {
    manifest = fs.realpathSync(direct)
  } catch {
    return null
  }
  let version = null
  try {
    version = JSON.parse(fs.readFileSync(manifest, 'utf8')).version
  } catch {
    return null
  }
  return { dir: path.dirname(manifest), version }
}

function backupPaths(stateDir, def) {
  const dir = path.join(stateDir, 'patches')
  return { dir, file: path.join(dir, def.id + '.bak'), meta: path.join(dir, def.id + '.json') }
}

function versionSupported(def, version) {
  const prefixes = Array.isArray(def.versions) && def.versions.length ? def.versions : null
  if (!prefixes) return Boolean(version)
  return prefixes.some((prefix) => String(version || '').startsWith(String(prefix)))
}

/**
 * Everything the UI and the API need, computed from disk (never from the ledger):
 * status is one of missing_package | unsupported | applied | pending |
 * anchor_missing | anchor_ambiguous | error.
 */
export function inspect(def, { profileDir, stateDir }) {
  const base = {
    id: def.id,
    title: def.title || def.id,
    titleEn: def.titleEn || def.title || def.id,
    note: def.note || '',
    package: def.package,
    file: def.file,
    version: null,
    markerCount: 0,
    anchorCount: 0,
    backup: false,
    backupBuiltAt: null,
    path: null,
    status: 'pending',
    detail: '',
  }

  const found = locatePackage(profileDir, def.package)
  if (!found) return { ...base, status: 'missing_package', detail: def.package + ' 未安装' }

  const target = path.join(found.dir, def.file)
  const bp = backupPaths(stateDir, def)
  base.version = found.version
  base.path = target
  base.backup = fs.existsSync(bp.file)
  if (base.backup) {
    try { base.backupBuiltAt = JSON.parse(fs.readFileSync(bp.meta, 'utf8')).at ?? null } catch (err) {
      recordError('patch-backup-meta', err, { history: false })
    }
  }

  let text
  try {
    text = fs.readFileSync(target, 'utf8')
  } catch (err) {
    return { ...base, status: 'error', detail: '读取 ' + def.file + ' 失败：' + err.message }
  }

  base.markerCount = countOf(text, def.marker)
  base.anchorCount = countOf(text, def.find)

  if (!versionSupported(def, base.version)) {
    return { ...base, status: 'unsupported', detail: def.package + '@' + base.version + ' 不在支持范围 ' + JSON.stringify(def.versions) }
  }
  if (base.markerCount > 0) return { ...base, status: 'applied', detail: '补丁已存在' }
  if (base.anchorCount === 0) {
    return { ...base, status: 'anchor_missing', detail: '找不到要改的代码（插件结构变了？）' }
  }
  if (base.anchorCount > 1) {
    return { ...base, status: 'anchor_ambiguous', detail: '锚点出现 ' + base.anchorCount + ' 次，拒绝修改' }
  }
  return { ...base, status: 'pending', detail: '可以应用' }
}

/** Apply one patch atomically. Idempotent: an already-patched file is reported, not rewritten. */
export function applyPatch(def, { profileDir, stateDir }) {
  const info = inspect(def, { profileDir, stateDir })
  if (info.status === 'applied') return { ...info, changed: false }
  if (info.status !== 'pending') {
    const err = new Error(info.detail || info.status)
    err.code = info.status
    throw err
  }

  const source = fs.readFileSync(info.path)
  const bp = backupPaths(stateDir, def)
  fs.mkdirSync(bp.dir, { recursive: true })
  // Keep the oldest pristine copy: a second apply after a plugin upgrade must not
  // overwrite the only clean version we have with an already-patched one.
  if (!fs.existsSync(bp.file)) fs.writeFileSync(bp.file, source)
  const meta = {
    id: def.id,
    package: def.package,
    version: info.version,
    file: def.file,
    sha256: sha256(source),
    at: new Date().toISOString(),
  }
  fs.writeFileSync(bp.meta, JSON.stringify(meta, null, 2))

  const text = source.toString('utf8')
  const next = text.replace(def.find, def.replace)
  if (next === text) {
    const err = new Error('替换没有产生变化')
    err.code = 'no_change'
    throw err
  }

  const tmp = info.path + '.' + process.pid + '.' + Date.now() + '.tmp'
  fs.writeFileSync(tmp, next)
  fs.renameSync(tmp, info.path)

  const after = inspect(def, { profileDir, stateDir })
  if (after.status !== 'applied') {
    // Leave the tree exactly as we found it.
    try { fs.copyFileSync(bp.file, info.path) } catch (restoreErr) { recordError('patch-restore', restoreErr) }
    const err = new Error('补丁未生效：' + after.status)
    err.code = 'patch_failed'
    throw err
  }
  return { ...after, changed: true, backup: bp.file }
}

/** Restore the pristine bytes captured when the patch was first applied. */
export function revertPatch(def, { profileDir, stateDir }) {
  const info = inspect(def, { profileDir, stateDir })
  const bp = backupPaths(stateDir, def)
  if (!fs.existsSync(bp.file)) {
    const err = new Error('没有备份可还原：' + def.id)
    err.code = 'no_backup'
    throw err
  }
  if (!info.path) {
    const err = new Error(def.package + ' 未安装')
    err.code = 'missing_package'
    throw err
  }
  fs.copyFileSync(bp.file, info.path)
  const after = inspect(def, { profileDir, stateDir })
  if (after.status === 'applied') {
    const err = new Error('还原失败：补丁标记仍然存在')
    err.code = 'revert_failed'
    throw err
  }
  return { ...after, changed: true }
}

/**
 * Boot-time repair. Only ledger entries (patches this plugin applied before) are
 * reconsidered, so an upgrade that wipes our edit heals itself while a package the
 * user never patched is left untouched.
 */
export function repairAll(defs, { profileDir, stateDir, ledger }) {
  const results = []
  for (const def of defs) {
    const record = ledger && ledger[def.id]
    if (!record || !record.appliedAt) continue
    const info = inspect(def, { profileDir, stateDir })
    if (info.status === 'applied' || info.status === 'missing_package') {
      results.push({ ...info, action: 'none' })
      continue
    }
    if (info.status !== 'pending') {
      results.push({ ...info, action: 'skipped' })
      continue
    }
    try {
      const applied = applyPatch(def, { profileDir, stateDir })
      results.push({ ...applied, action: 'repaired' })
    } catch (err) {
      results.push({ ...info, action: 'failed', detail: err.message })
    }
  }
  return results
}
