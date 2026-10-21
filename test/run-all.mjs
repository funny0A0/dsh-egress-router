// Runs every test file in-process. `node --test` spawns workers, which the
// DSH sandbox denies (EPERM), so the repo ships its own sequential runner.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const files = fs.readdirSync(here).filter((name) => name.endsWith('.test.mjs')).sort()
let failed = 0
for (const file of files) {
  process.stdout.write('== ' + file + '\n')
  const result = spawnSync(process.execPath, [path.join(here, file)], { stdio: 'inherit' })
  if (result.status !== 0) failed += 1
}
process.exit(failed === 0 ? 0 : 1)
