/**
 * What an ssh target really points at, as OpenSSH itself resolves it.
 *
 * `ssh -G <target>` prints the effective configuration for a destination —
 * Host blocks, Match, Include and defaults applied — without connecting. It is
 * how the app can show "devbox → dev@10.0.0.9:22 via bastion" while leaving
 * all of the configuration to `~/.ssh/config`.
 *
 * Only the fields the UI shows are kept. Identity files are not: their paths
 * are the user's own business, and key material is never read at all.
 *
 * @module @dsh-ssh/core/ssh-config
 */

import { spawn } from 'node:child_process'

import { sshCommand } from './transports.js'

/**
 * @typedef {object} SshDestination
 * @property {string} hostname
 * @property {string} user
 * @property {number} port
 * @property {string | undefined} proxyJump
 * @property {boolean} proxyCommand  whether a ProxyCommand is in effect (its text is not kept).
 */

/**
 * Parse `ssh -G` output.
 * @param {string} text
 * @returns {SshDestination | undefined}
 */
export function parseSshG(text) {
  /** @type {Map<string, string>} */
  const values = new Map()
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-z0-9]+)\s+(.*)$/.exec(line.trim())
    // The first value wins, as OpenSSH applies it.
    if (match !== null && !values.has(match[1])) values.set(match[1], match[2].trim())
  }
  const hostname = values.get('hostname')
  if (hostname === undefined || hostname === '') return undefined
  const port = Number.parseInt(values.get('port') ?? '22', 10)
  const jump = values.get('proxyjump')
  const command = values.get('proxycommand')
  return {
    hostname,
    user: values.get('user') ?? '',
    port: Number.isInteger(port) ? port : 22,
    proxyJump: jump === undefined || jump === '' || jump === 'none' ? undefined : jump,
    proxyCommand: command !== undefined && command !== '' && command !== 'none',
  }
}

/**
 * One line for the UI: `user@host:port`, plus the jump host if any.
 * @param {SshDestination} destination
 */
export function describeDestination(destination) {
  const user = destination.user === '' ? '' : `${destination.user}@`
  const port = destination.port === 22 ? '' : `:${String(destination.port)}`
  const via = destination.proxyJump !== undefined ? ` · 经 ${destination.proxyJump}` : destination.proxyCommand ? ' · 经 ProxyCommand' : ''
  return `${user}${destination.hostname}${port}${via}`
}

/**
 * Resolve a target with the local OpenSSH, without connecting.
 * @param {string} target an alias or user@host (already validated by config.validate).
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<SshDestination | undefined>} undefined when ssh cannot resolve it.
 */
export function resolveSshTarget(target, options = {}) {
  if (typeof target !== 'string' || target === '' || target.startsWith('-') || /\s/.test(target)) {
    return Promise.resolve(undefined)
  }
  return new Promise((resolve) => {
    let child
    try {
      // `--` so a target can never be read as an option.
      child = spawn(sshCommand(), ['-G', '--', target], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } catch {
      resolve(undefined)
      return
    }
    let text = ''
    const timer = setTimeout(() => { child.kill() }, options.timeoutMs ?? 5_000)
    timer.unref?.()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { if (text.length < 256 * 1024) text += chunk })
    child.on('error', () => {
      clearTimeout(timer)
      resolve(undefined)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0 ? parseSshG(text) : undefined)
    })
  })
}
