// Compile every shipped module (and the tests) without executing them.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const roots = ['lib', 'client', 'test', 'scripts']
const files = []
for (const root of roots) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(path.join(entry.parentPath ?? entry.path, entry.name))
  }
}
files.push('lib/index.js')
let failed = 0
for (const file of [...new Set(files)].sort()) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status !== 0) {
    failed += 1
    console.error('syntax error in ' + file + '\n' + (result.stderr || ''))
  }
}
console.log(files.length + ' files checked, ' + failed + ' failed')
process.exit(failed ? 1 : 0)
