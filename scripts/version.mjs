// Single source of truth for the release version: package.json. The README version list
// and CHANGELOG must mention it, so a release cannot ship half-documented.
import fs from 'node:fs'

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const args = process.argv.slice(2)
if (args[0] === '--set' && args[1]) {
  pkg.version = args[1]
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')
  console.log('package.json -> ' + pkg.version + ' (now add a CHANGELOG entry and a README version line)')
  process.exit(0)
}
const readme = fs.readFileSync('README.md', 'utf8')
const changelog = fs.readFileSync('CHANGELOG.md', 'utf8')
const problems = []
if (!readme.includes(pkg.version + ' —')) problems.push('README.md has no "' + pkg.version + ' —" version line')
if (!changelog.includes('## ' + pkg.version)) problems.push('CHANGELOG.md has no "## ' + pkg.version + '" section')
console.log('version ' + pkg.version + (problems.length ? '' : ' — documented'))
for (const problem of problems) console.error('  ' + problem)
process.exit(problems.length ? 1 : 0)
