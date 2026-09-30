/**
 * Connection records and their on-disk store.
 *
 * A connection names a `~/.ssh/config` Host alias and says where the remote
 * harness lives. It carries **no credential material**: identity, jump hosts,
 * ports and agent use all come from the user's own ssh configuration, and this
 * process never sees a private key.
 *
 * The store directory is injected by the caller (Electron passes
 * `app.getPath('userData')`), so this module has no opinion about where it runs
 * and tests never touch a real profile.
 *
 * @module @dsh-ssh/core/config
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** File format version; a mismatched version is ignored rather than misread. */
const FORMAT_VERSION = 1

/** The store's file name inside the injected directory. */
export const STORE_FILE = 'connections.json'

/**
 * What happens to the remote harness when the desktop app exits.
 * - `keep`: leave it running; the next launch reuses it (the default).
 * - `stop`: stop it on the way out.
 * @typedef {'keep' | 'stop'} ClosePolicy
 */

/**
 * @typedef {object} ConnectionConfig
 * @property {string} id              Stable identifier; safe for a partition name (`[A-Za-z0-9_-]`).
 * @property {string} name            Display name.
 * @property {string} target          `~/.ssh/config` Host alias, or `user@host`.
 * @property {string} remoteProfile   Profile name on the server (cannot be `desktop`).
 * @property {string} remoteWorkspace Working directory for the remote harness.
 * @property {number} remotePort      Port the remote `dsh web` listens on (loopback).
 * @property {number} localPort       Local listening port. Defaults to `remotePort` — the
 *   browser-auth cookie is authority-bound, so a differing port is a deliberate deviation.
 * @property {number} startTimeoutMs  How long to wait for the remote URL line.
 * @property {ClosePolicy} closePolicy What to do with the remote harness when the app exits.
 */

/** Identifier shape: usable verbatim in `persist:conn-<id>` and in file names. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Defaults applied for every field the stored record omits.
 *
 * The remote profile is deliberately not `desktop`: the CLI rejects that name
 * (`profile "desktop" is managed exclusively by the Electron application`).
 * @returns {ConnectionConfig}
 */
export function defaults() {
  return {
    id: '',
    name: '',
    target: '',
    remoteProfile: 'web',
    remoteWorkspace: '',
    remotePort: 3080,
    localPort: 3080,
    // Generous on purpose. The launch line is written by a Node process whose
    // stdout is a pipe/file when started detached, and Node *block-buffers* that:
    // measured on a real host, the line appeared after 90 to 160 seconds even
    // though the listener was up within a few. A short timeout would report a
    // failure for a harness that is running perfectly.
    startTimeoutMs: 300_000,
    closePolicy: 'keep',
  }
}

/** Clamp an integer field into range, falling back to the default when unusable. */
function intOr(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) return fallback
  return n
}

/** Coerce an arbitrary string field, falling back to the default when absent. */
function strOr(value, fallback) {
  return typeof value === 'string' ? value : fallback
}

/**
 * Validate and normalize a raw record into a ConnectionConfig.
 *
 * Unknown fields are dropped rather than carried, so a stale key from an older
 * shape (a password, a key path) can never reach the SSH layer. Invalid values
 * fall back to defaults instead of throwing: a half-written record should
 * degrade to "not connected", never crash the app at boot.
 *
 * @param {unknown} raw
 * @returns {ConnectionConfig}
 */
export function normalize(raw) {
  const d = defaults()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return d
  const r = /** @type {Record<string, unknown>} */ (raw)
  const id = strOr(r.id, '').trim()
  const target = strOr(r.target, d.target).trim()
  const remotePort = intOr(r.remotePort, d.remotePort, 1, 65535)
  return {
    id: ID_PATTERN.test(id) ? id : '',
    name: strOr(r.name, '').trim() || target,
    target,
    remoteProfile: strOr(r.remoteProfile, d.remoteProfile).trim() || d.remoteProfile,
    remoteWorkspace: strOr(r.remoteWorkspace, d.remoteWorkspace).trim(),
    remotePort,
    // Default the local port to the remote port: the harness browser-auth cookie
    // is bound to the request authority, so forwarding 3080 -> 3080 is the shape
    // the whole trust model was verified against.
    localPort: intOr(r.localPort, remotePort, 1, 65535),
    startTimeoutMs: intOr(r.startTimeoutMs, d.startTimeoutMs, 5_000, 600_000),
    closePolicy: r.closePolicy === 'stop' ? 'stop' : 'keep',
  }
}

/**
 * Whether a record carries enough information to attempt a connection.
 * @param {ConnectionConfig} config
 * @returns {string | undefined} a human-readable problem, or undefined when usable.
 */
export function validate(config) {
  if (config.target === '') return 'a destination is required: name a ~/.ssh/config Host alias'
  // The target becomes an `ssh` argv element. A leading dash would be parsed as
  // an option (`-oProxyCommand=…` runs a local command), and whitespace or
  // control characters are never part of a real alias.
  if (config.target.startsWith('-') || /[\s\u0000-\u001f\u007f]/.test(config.target)) {
    return 'the destination must be a plain Host alias or user@host (no leading dash, no spaces)'
  }
  if (config.remoteWorkspace === '') return 'remote workspace directory is required'
  if (config.remoteProfile.toLowerCase() === 'desktop') {
    return 'the remote profile cannot be named "desktop" — the CLI reserves that name for the Electron application'
  }
  return undefined
}

/** A fresh identifier for a new connection. */
export function newId() {
  return randomBytes(6).toString('hex')
}

/**
 * The connection store, rooted at a directory the caller chooses.
 *
 * @param {{ dir: string }} options
 */
export function createStore(options) {
  if (typeof options?.dir !== 'string' || options.dir === '') {
    throw new Error('createStore needs the directory to keep connections.json in')
  }
  const file = join(options.dir, STORE_FILE)

  /**
   * Load every stored connection. A missing or corrupt file yields an empty
   * list instead of throwing, so a damaged store degrades to "no servers yet".
   * @returns {ConnectionConfig[]}
   */
  function load() {
    if (!existsSync(file)) return []
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null) return []
      if (parsed.version !== FORMAT_VERSION || !Array.isArray(parsed.connections)) return []
      return withIds(parsed.connections.map(normalize))
    } catch {
      return []
    }
  }

  /**
   * Persist the whole list atomically (temp file + rename), so a crash can never
   * leave a half-written store behind.
   * @param {unknown[]} list
   * @returns {ConnectionConfig[]} the normalized list that was written.
   */
  function save(list) {
    const connections = withIds((Array.isArray(list) ? list : []).map(normalize))
    mkdirSync(options.dir, { recursive: true })
    const temp = `${file}.${String(process.pid)}.tmp`
    writeFileSync(temp, JSON.stringify({ version: FORMAT_VERSION, connections }, null, 2), { mode: 0o600 })
    renameSync(temp, file)
    return connections
  }

  /** Remove the store. @returns {boolean} whether a file was actually removed. */
  function clear() {
    if (!existsSync(file)) return false
    try {
      rmSync(file, { force: true })
      return true
    } catch {
      return false
    }
  }

  return { path: file, load, save, clear }
}

/**
 * Give every record a unique id. A missing or duplicated id is replaced, since
 * the id keys the window partition and two servers must never share cookies.
 * @param {ConnectionConfig[]} list
 * @returns {ConnectionConfig[]}
 */
function withIds(list) {
  const seen = new Set()
  return list.map((entry) => {
    let id = entry.id
    while (id === '' || seen.has(id)) id = newId()
    seen.add(id)
    return id === entry.id ? entry : { ...entry, id }
  })
}
