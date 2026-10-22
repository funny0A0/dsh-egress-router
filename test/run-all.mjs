// Runs every test file in-process. `node --test` spawns workers, which the
// DSH sandbox denies (EPERM), so the repo ships its own sequential runner. It also prints
// one summary line, so CI logs and release notes can quote exact numbers (0.12.0).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const files = fs.readdirSync(here).filter((name) => name.endsWith('.test.mjs')).sort()
let failed = 0
let passes = 0
let failures = 0

// Node prints TAP when stdout is a pipe and the spec reporter on a TTY: accept both.
function count(output, name) {
  const matches = [...String(output).matchAll(new RegExp('^(?:#|ℹ) ' + name + ' (\\d+)$', 'gm'))]
  if (matches.length === 0) return 0
  return Number(matches[matches.length - 1][1])
}

for (const file of files) {
  process.stdout.write('== ' + file + '\n')
  const result = spawnSync(process.execPath, [path.join(here, file)], { encoding: 'utf8' })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  passes += count(result.stdout, 'pass')
  failures += count(result.stdout, 'fail')
  if (result.status !== 0) failed += 1
}
process.stdout.write('files=' + files.length + ' pass=' + passes + ' fail=' + failures + ' failedFiles=' + failed + '\n')
process.exit(failed === 0 ? 0 : 1)
