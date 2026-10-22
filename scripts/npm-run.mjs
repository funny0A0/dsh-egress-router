/**
 * One npm entry point for the release gates.
 *
 * `npm` is not reliably an executable on PATH: a Node tarball ships it as a script under
 * `<prefix>/lib/node_modules/npm`, Windows installs it as `npm.cmd`, corepack shims it, and a
 * WSL/container image may expose only `node`. Resolving the JS entry first keeps
 * `check-package` and `install-smoke` usable in all of those layouts (0.12.0).
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

function candidates() {
  const execDir = path.dirname(process.execPath)
  return [
    path.join(execDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Windows: C:\Program Files\nodejs\node_modules\npm
    path.join(execDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Unix tarball: <prefix>/bin/node + <prefix>/lib/node_modules/npm
    path.join(execDir, '..', 'share', 'nodejs', 'npm', 'bin', 'npm-cli.js'), // some Linux distributions
    path.join(execDir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // custom prefixes
  ].map((entry) => path.normalize(entry))
}

/** Resolve once per process: { kind: 'node' | 'bin', command, prefix[] }. */
export function npmCommand() {
  for (const candidate of candidates()) {
    if (fs.existsSync(candidate)) return { kind: 'node', command: process.execPath, prefix: [candidate] }
  }
  return { kind: 'bin', command: process.platform === 'win32' ? 'npm.cmd' : 'npm', prefix: [] }
}

export function describeNpm() {
  const resolved = npmCommand()
  return resolved.kind === 'node' ? 'node ' + resolved.prefix[0] : resolved.command + ' (PATH)'
}

function explain(where) {
  return (
    where + ' could not run npm (' + describeNpm() + ').\n' +
    'Tried: ' + candidates().join('\n       ') + '\n' +
    (process.platform === 'win32' ? '       npm.cmd (PATH)\n' : '       npm (PATH)\n') +
    'Install npm next to this node, or add npm to PATH.'
  )
}

/** spawnSync-shaped: returns { status, stdout, stderr, error }. */
export function npmSync(args, options = {}) {
  const resolved = npmCommand()
  const stdio = options.stdio ?? ['ignore', 'pipe', 'pipe']
  const spawn = resolved.kind === 'node'
    ? spawnSync(resolved.command, [...resolved.prefix, ...args], { ...options, stdio })
    : spawnSync(resolved.command, args, { ...options, stdio, shell: process.platform === 'win32' })
  if (spawn.error && spawn.error.code === 'ENOENT') spawn.error.message = explain('spawnSync')
  return spawn
}

/** execFileSync-shaped: throws on a non-zero exit, returns stdout. */
export function npmExec(args, options = {}) {
  const resolved = npmCommand()
  const stdio = options.stdio ?? ['ignore', 'pipe', 'pipe']
  if (resolved.kind === 'node') {
    return execFileSync(resolved.command, [...resolved.prefix, ...args], { ...options, stdio })
  }
  try {
    return execFileSync(resolved.command, args, { ...options, stdio, shell: process.platform === 'win32' })
  } catch (err) {
    if (err?.code === 'ENOENT') throw new Error(explain('execFileSync'))
    throw err
  }
}
