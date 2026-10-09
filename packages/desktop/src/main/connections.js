/**
 * Connection manager: the stored connections, one `RemoteSession` each, and
 * the policy that keeps a wanted connection alive.
 *
 * "Wanted" is the user's intent. It turns on with connect/restart and off with
 * disconnect/stop, and only a wanted connection is brought back after a drop
 * (backoff 1s → 30s) or after the machine wakes. A connect that fails on its
 * own — no dsh on the server, a wrong workspace — is not retried: that needs
 * the user, not a timer.
 *
 * Free of Electron: the app wires `resume()` to `powerMonitor`, and tests drive
 * the manager with fake sessions and fake timers.
 *
 * @module medhealthbuddy-desktop/connections
 */

import { EventEmitter } from 'node:events'

import { RemoteSession, normalize } from '@dsh-ssh/core'

import { backoffMs } from './policy.js'

/**
 * @typedef {object} Entry
 * @property {import('@dsh-ssh/core').RemoteSession} session
 * @property {boolean} wanted
 * @property {number} attempt  retries since the last successful connect.
 * @property {ReturnType<typeof setTimeout> | undefined} timer
 * @property {number | undefined} retryAt  epoch ms of the scheduled retry.
 * @property {string} lastPhase
 */

/**
 * Events:
 *  - `change` (id): anything about a connection changed.
 *  - `ready` (id): a connection reached ready (initial connect, restart or reconnect).
 *  - `task` (id, TaskEvent): the server plugin reports a finished agent turn.
 */
export class ConnectionManager extends EventEmitter {
  /**
   * @param {object} options
   * @param {{ load: () => any[], save: (list: any[]) => any[] }} options.store
   * @param {(config: any) => any} [options.createSession]
   * @param {{ setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout }} [options.timers]
   * @param {(id: string, line: string) => void} [options.onLine]  every diagnostic line, as recorded (the log file).
   */
  constructor(options) {
    super()
    this.onLine = options.onLine
    this.store = options.store
    this.createSession = options.createSession ?? ((config) => new RemoteSession(config))
    this.timers = options.timers ?? { setTimeout, clearTimeout }
    /** @type {any[]} */
    this.configs = []
    /** @type {Map<string, Entry>} */
    this.entries = new Map()
  }

  /** Read the store and create a session per connection. */
  load() {
    this.configs = this.store.load()
    for (const config of this.configs) this.#ensureEntry(config)
    return this.configs
  }

  /** @returns {any[]} the stored connection records. */
  list() {
    return this.configs
  }

  /**
   * Insert or update one connection and persist the whole list.
   * @param {unknown} raw
   * @returns {any} the normalized, stored record (with its id).
   */
  save(raw) {
    const record = normalize(raw)
    const index = record.id === '' ? -1 : this.configs.findIndex((c) => c.id === record.id)
    // Two connections on one local port would fight over the forward, and the
    // browser keys its login cookie by that port.
    const clash = this.configs.find((c) => c.id !== record.id && c.localPort === record.localPort)
    if (clash !== undefined) {
      throw new Error(`本地端口 ${String(record.localPort)} 已被「${String(clash.name)}」使用，请换一个（建议 ${String(this.freePort())}）`)
    }
    const next = [...this.configs]
    if (index === -1) next.push(record)
    else next[index] = record
    this.configs = this.store.save(next)
    const saved = index === -1 ? this.configs[this.configs.length - 1] : this.configs[index]
    const entry = this.entries.get(saved.id)
    // The session keeps its own copy: it rewrites localPort once bound.
    if (entry === undefined) this.#ensureEntry(saved)
    else entry.session.setConfig({ ...saved })
    this.emit('change', saved.id)
    return saved
  }

  /**
   * Add a line to a connection's diagnostic log.
   * @param {string} id
   * @param {string} line
   */
  log(id, line) {
    const entry = this.entries.get(id)
    if (entry === undefined) return
    entry.session.log.push(line)
    this.emit('change', id)
  }

  /**
   * The lowest port from 3080 no stored connection uses, locally or remotely.
   * Remote and local stay equal by default: the harness cookie is bound to
   * the authority its launch URL names (see @dsh-ssh/core session).
   */
  freePort() {
    const used = new Set(this.configs.flatMap((c) => [c.localPort, c.remotePort]))
    let port = 3080
    while (used.has(port)) port += 1
    return port
  }

  /**
   * Forget a connection: disconnect it (its remote harness keeps running,
   * like any disconnect) and drop it from the store.
   * @param {string} id
   */
  async remove(id) {
    const entry = this.#entry(id)
    entry.wanted = false
    this.#cancelRetry(entry)
    await entry.session.disconnect('the connection was removed')
    entry.session.removeAllListeners()
    this.entries.delete(id)
    this.configs = this.store.save(this.configs.filter((c) => c.id !== id))
    this.emit('change', id)
  }

  /** @param {any} config */
  #ensureEntry(config) {
    if (this.entries.has(config.id)) return
    const session = this.createSession({ ...config })
    if (this.onLine !== undefined) session.log.sink = (line) => { this.onLine?.(config.id, line) }
    /** @type {Entry} */
    const entry = { session, wanted: false, attempt: 0, timer: undefined, retryAt: undefined, lastPhase: session.phase }
    this.entries.set(config.id, entry)
    session.on('change', () => {
      const phase = session.phase
      if (phase !== entry.lastPhase) {
        entry.lastPhase = phase
        if (phase === 'ready') {
          entry.attempt = 0
          this.emit('ready', config.id)
        }
      }
      this.emit('change', config.id)
    })
    session.on('drop', () => {
      if (entry.wanted) this.#schedule(config.id, entry)
    })
    session.on('task', (task) => { this.emit('task', config.id, task) })
  }

  /** @param {string} id */
  #entry(id) {
    const entry = this.entries.get(id)
    if (entry === undefined) throw new Error(`unknown connection: ${id}`)
    return entry
  }

  /** @param {Entry} entry */
  #cancelRetry(entry) {
    if (entry.timer !== undefined) this.timers.clearTimeout(entry.timer)
    entry.timer = undefined
    entry.retryAt = undefined
  }

  /**
   * @param {string} id
   * @param {Entry} entry
   */
  #schedule(id, entry) {
    this.#cancelRetry(entry)
    const delay = backoffMs(entry.attempt)
    entry.attempt += 1
    entry.retryAt = Date.now() + delay
    entry.session.log.push(`reconnecting in ${String(Math.round(delay / 1000))}s (attempt ${String(entry.attempt)})`)
    entry.timer = this.timers.setTimeout(() => {
      entry.timer = undefined
      entry.retryAt = undefined
      void this.#reconnect(id, entry, 'reconnecting after the connection dropped')
    }, delay)
    this.emit('change', id)
  }

  /**
   * Replace the local side of a wanted connection. The remote harness is
   * normally still running, so this takes the reuse path and is quick.
   * @param {string} id
   * @param {Entry} entry
   * @param {string} reason
   */
  async #reconnect(id, entry, reason) {
    if (!entry.wanted) return
    // The next connect renews the lease; clearing it here would open a window
    // in which a crash leaves a 'stop on exit' remote running.
    await entry.session.disconnect(reason, { keepLease: true })
    if (!entry.wanted) return
    await entry.session.connect()
    // A drop during this attempt has already rescheduled; only an attempt that
    // failed outright needs the next one queued here.
    if (entry.wanted && entry.session.phase !== 'ready' && entry.timer === undefined) this.#schedule(id, entry)
  }

  /** @param {string} id */
  async connect(id) {
    const entry = this.#entry(id)
    entry.wanted = true
    entry.attempt = 0
    this.#cancelRetry(entry)
    await entry.session.connect()
    // A first connect that fails is a problem for the user, not for a timer.
    if (entry.session.phase !== 'ready') entry.wanted = false
    this.emit('change', id)
  }

  /** @param {string} id */
  async disconnect(id) {
    const entry = this.#entry(id)
    entry.wanted = false
    this.#cancelRetry(entry)
    await entry.session.disconnect()
  }

  /** @param {string} id */
  async stop(id) {
    const entry = this.#entry(id)
    entry.wanted = false
    this.#cancelRetry(entry)
    await entry.session.stop()
  }

  /** @param {string} id */
  async restart(id) {
    const entry = this.#entry(id)
    entry.wanted = true
    entry.attempt = 0
    this.#cancelRetry(entry)
    await entry.session.restart()
    if (entry.session.phase !== 'ready') entry.wanted = false
    this.emit('change', id)
  }

  /**
   * Re-read the remote log for a fresh launch URL (401 recovery).
   * @param {string} id
   */
  async refreshFromLog(id) {
    return this.#entry(id).session.refreshFromLog()
  }

  /**
   * The machine woke up. A forward that slept through a network change may be
   * dead without its ssh having noticed yet (keepalives take up to a minute),
   * and a dead forward still accepts local connections — so every wanted
   * connection is rebuilt now rather than trusted.
   */
  resume() {
    for (const [id, entry] of this.entries) {
      if (!entry.wanted) continue
      this.#cancelRetry(entry)
      entry.attempt = 0
      entry.session.log.push('the system resumed; rebuilding the connection')
      void this.#reconnect(id, entry, 'the system resumed from sleep')
    }
  }

  /**
   * App exit: apply every connection's close policy.
   * @param {string} reason
   */
  async shutdownAll(reason) {
    const pending = []
    for (const entry of this.entries.values()) {
      entry.wanted = false
      this.#cancelRetry(entry)
      pending.push(entry.session.shutdown(reason).catch(() => {}))
    }
    await Promise.all(pending)
  }

  /**
   * The state the connection window renders.
   * @param {string} id
   */
  snapshot(id) {
    const entry = this.#entry(id)
    return {
      ...entry.session.snapshot(),
      wanted: entry.wanted,
      retryAt: entry.retryAt ?? null,
      retryAttempt: entry.attempt,
    }
  }

  /**
   * The bound local port of a ready connection, or undefined.
   * @param {string} id
   * @returns {number | undefined}
   */
  boundPort(id) {
    return this.entries.get(id)?.session.boundLocalPort
  }

  /**
   * The launch URL (with token) of a ready connection, or undefined.
   * @param {string} id
   * @returns {string | undefined}
   */
  launchUrl(id) {
    return this.entries.get(id)?.session.url
  }
}
