// Port allocation and validation for the loopback listeners.
import net from 'node:net'

export const FIRST_PORT = 8791
export const LAST_PORT = 8888

export function isValidPort(value) {
  const port = Number(value)
  return Number.isInteger(port) && port >= 1024 && port <= 65535
}

/**
 * Loopback, link-local and RFC1918 literals. Used to refuse "route/probe a private
 * address" requests: the plugin is a client-side egress tool, never a LAN scanner (R4).
 */
export function isPrivateAddress(host) {
  const value = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!value) return true
  if (value === 'localhost' || value.endsWith('.localhost')) return true
  if (value === '::1' || value === '::' || value === '0.0.0.0') return true
  if (value.startsWith('fe80:') || value.startsWith('fc') || value.startsWith('fd')) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
  if (!v4) return false
  const [a, b] = [Number(v4[1]), Number(v4[2])]
  if (a === 127 || a === 10 || a === 0) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  return false
}

export function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', (err) => resolve(err.code === 'EADDRINUSE' ? false : true))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, host)
  })
}

export async function suggestPort(used = [], host = '127.0.0.1', from = FIRST_PORT) {
  const taken = new Set(used.map(Number))
  for (let port = from; port <= LAST_PORT; port++) {
    if (taken.has(port)) continue
    if (await isPortFree(port, host)) return port
  }
  for (let port = LAST_PORT + 1; port <= 65535; port++) {
    if (taken.has(port)) continue
    if (await isPortFree(port, host)) return port
  }
  throw new Error('no free port available')
}
