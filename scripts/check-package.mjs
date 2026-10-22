// Release gate: what npm would publish, checked against the manifest's promise.
// Required files must be present; working files must not be; the tarball stays small.
import fs from 'node:fs'
import { describeNpm, npmSync } from './npm-run.mjs'

const REQUIRED = [
  'package.json',
  'lib/index.js',
  'lib/routes.js',
  'client/client.js',
  'cordis.patch.yml',
  'patches/definitions.json',
  'README.md',
  'README.en.md',
  'CHANGELOG.md',
  'LICENSE',
  'docs/compatibility.md',
  'docs/install.md',
  'docs/RELEASE.md',
  'docs/rollback.md',
]
const FORBIDDEN = [/^test\//, /^preview\//, /\.tgz$/, /^REVIEW-/, /^PROMPT-/, /^node_modules\//, /\.bak$/, /^\.git\//]
const MAX_BYTES = 2 * 1024 * 1024

const result = npmSync(['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' })
if (result.status !== 0) {
  console.error('npm pack --dry-run failed (' + describeNpm() + '):\n' + (result.error ? result.error.message : (result.stderr || result.stdout)))
  process.exit(1)
}
const parsed = JSON.parse(result.stdout)
const listed = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
const files = listed.files.map((entry) => entry.path.replace(/\\/g, '/'))
const problems = []
for (const file of REQUIRED) if (!files.includes(file)) problems.push('missing from the tarball: ' + file)
for (const file of files) for (const rule of FORBIDDEN) if (rule.test(file)) problems.push('must not be published: ' + file)
const size = listed.size ?? listed.unpackedSize ?? 0
if (size > MAX_BYTES) problems.push('tarball is ' + size + ' bytes (limit ' + MAX_BYTES + ')')

console.log(listed.name + '@' + listed.version + ' — ' + files.length + ' files, ' + size + ' bytes')
for (const problem of [...new Set(problems)]) console.error('  ' + problem)
process.exit(problems.length ? 1 : 0)
