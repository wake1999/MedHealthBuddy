/**
 * Session orchestrator: the one object that owns the SSH transport, the remote
 * harness lifecycle, and the local forward for one connection.
 *
 * The sequence for a connect is fixed and observable at every step, because the
 * interesting failures each need explaining rather than collapsing into "connect
 * failed":
 *
 *   1. open the transport
 *   2. probe the remote (dsh path, node, workspace, profile, port)
 *   3. reuse the running harness, or start one detached
 *   4. wait for the printed launch URL
 *   5. start the local forward
 *
 * Every phase transition is recorded in the log ring, so the UI can show the
 * whole story without a terminal.
 *
 * @module @dsh-ssh/core/session
 */

import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'

import { validate } from './config.js'
import { linkClient as defaultLinkClient } from './link-client.js'
import { LogRing } from './log.js'
import { awaitLaunchUrl, parseLaunchUrl, probe, readLinkSecret, readLog, startCommand, stopRemote } from './remote.js'
import { SystemSshTransport } from './transports.js'

/** @typedef {'idle' | 'connecting' | 'starting' | 'stopping' | 'ready' | 'error' | 'stopped'} Phase */

/** Config keys whose change does not invalidate a live connection. */
const SESSION_NEUTRAL_KEYS = new Set(['name', 'closePolicy'])

/** Default lease: the remote stops itself this long after the desktop is gone. */
const DEFAULT_LEASE_TTL_SEC = 600

/** How long a link call may hold up a disconnect or an exit. */
const LINK_EXIT_TIMEOUT_MS = 2_000

/** Profiles `dsh` creates from its bundled templates on first use (upstream apps/cli README). */
const BUILTIN_PROFILES = new Set(['web', 'headless', 'sdk', 'sdk-minimal', 'acp'])

/** How long one finished-task poll waits on the server before answering empty. */
const TASK_POLL_WAIT_MS = 25_000

/** Race a promise against a timer that does not keep the process alive. */
function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => { reject(new Error(`timed out after ${String(ms)}ms`)) }, ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => { clearTimeout(timer) })
}

/** A fresh link secret: 32 random bytes as lowercase hex. */
function defaultSecret() {
  return randomBytes(32).toString('hex')
}

/**
 * Events:
 *  - `change`: the phase, message or log changed; call `snapshot()` for the state.
 *  - `drop` (error): a live connection was lost without anyone asking for it.
 *    The session moves to `error`; reconnecting is the owner's decision.
 *  - `task` (TaskEvent): the server plugin reports a finished agent turn
 *    (only while the link is active and the plugin offers `events`).
 */
export class RemoteSession extends EventEmitter {
  /**
   * @param {import('./config.js').ConnectionConfig} config
   * @param {object} [options]
   * @param {(config: import('./config.js').ConnectionConfig) => any} [options.transportFactory]
   *   Overrides transport construction. Production passes nothing and the
   *   system-ssh transport is used; tests inject a fake so the whole
   *   orchestration — phase transitions, reuse detection, URL adoption, teardown
   *   — runs without a network. Injection exists because this sequence is where
   *   the subtle bugs live, and it is otherwise only reachable with a live server.
   * @param {() => string} [options.generateSecret] Overrides link-secret generation (tests).
   * @param {typeof defaultLinkClient} [options.linkClient] Overrides the desktop-link client (tests).
   * @param {number} [options.leaseTtlSec] Lease length; renewed every third of it.
   * @param {{ setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout }} [options.timers]
   */
  constructor(config, options = {}) {
    super()
    this.config = config
    this.transportFactory = options.transportFactory ?? ((c) => new SystemSshTransport(c))
    this.generateSecret = options.generateSecret ?? defaultSecret
    this.linkClient = options.linkClient ?? defaultLinkClient
    this.leaseTtlSec = options.leaseTtlSec ?? DEFAULT_LEASE_TTL_SEC
    this.timers = options.timers ?? { setTimeout, clearTimeout }
    /**
     * The desktop link to the server plugin, as far as this app knows it.
     *  - unavailable: no secret for this harness (not started by this app) or not connected
     *  - checking:    handshake in flight
     *  - absent:      no plugin answered (not installed, or a different secret)
     *  - incompatible: a plugin of another protocol version
     *  - active:      handshake done; `leased` says whether the watchdog is armed,
     *                 `tasks` whether finished tasks are being followed
     * @type {{ status: 'unavailable' | 'checking' | 'absent' | 'incompatible' | 'active', leased: boolean, plugin?: string, detail?: string, tasks?: boolean }}
     */
    this.link = { status: 'unavailable', leased: false }
    /** @type {Phase} */
    this.phase = 'idle'
    /** @type {string} */
    this.message = 'not connected'
    /** @type {string | undefined} */
    this.url = undefined
    /** @type {boolean} */
    this.reused = false
    /** @type {Record<string, unknown> | undefined} */
    this.facts = undefined
    /** @type {SystemSshTransport | undefined} */
    this.transport = undefined
    /** @type {number | undefined} */
    this.boundLocalPort = undefined
    /**
     * The secret injected into the remote harness this app started, kept in
     * memory only — never written to disk and never part of `snapshot()`. It
     * survives a disconnect, because a reconnect (after sleep, say) reuses the
     * same remote process; it is dropped whenever that process is replaced or
     * stopped. Undefined means integration with the server plugin is unavailable.
     * @type {string | undefined}
     */
    this.linkSecret = undefined
    this.log = new LogRing()
    /** @type {Promise<void> | undefined} */
    this.#inFlight = undefined
    /** @type {number} */
    this.#generation = 0
  }

  /** @type {Promise<void> | undefined} */
  #inFlight
  /** @type {number} */
  #generation
  /** Pending lease renewal. */
  /** @type {unknown} */
  #heartbeat
  /** Cuts the finished-task long poll short when the link goes. */
  /** @type {AbortController | undefined} */
  #feedAbort
  /** Where the task feed was read up to, for the harness holding `secret`. */
  /** @type {{ secret: string, instance: string, cursor: number } | undefined} */
  #feedPosition

  /** Record a line in the log ring. */
  #log(line) {
    this.log.push(line)
    this.emit('change')
  }

  /** Move to a new phase, logging the transition. */
  #setPhase(phase, message) {
    this.phase = phase
    this.message = message
    this.#log(`[${phase}] ${message}`)
  }

  /**
   * Replace the configuration. A live session is dropped, because its reported
   * state would otherwise describe a connection the new config no longer covers.
   * @param {import('./config.js').ConnectionConfig} config
   * @returns {boolean} whether a live session had to be closed.
   */
  setConfig(config) {
    const wasLive = this.phase === 'connecting' || this.phase === 'starting' || this.phase === 'ready'
    const previous = this.config
    this.config = config
    // Settings that only matter at exit leave the live connection alone.
    const connectionUnchanged = Object.keys({ ...previous, ...config })
      .filter((key) => !SESSION_NEUTRAL_KEYS.has(key))
      .every((key) => previous[key] === config[key])
    if (connectionUnchanged) {
      // A live connect rewrites the bound local port into its config; keep it.
      if (wasLive) config.localPort = previous.localPort
      if (previous.closePolicy !== config.closePolicy) void this.#applyLeasePolicy()
      return false
    }
    // A different server or port means a different remote process.
    this.linkSecret = undefined
    if (wasLive) {
      void this.disconnect('configuration changed')
      return true
    }
    if (this.url !== undefined || this.facts !== undefined) {
      this.url = undefined
      this.facts = undefined
      this.phase = 'idle'
      this.message = 'configuration changed — connect again'
    }
    return false
  }

  /**
   * Connect, or join the in-flight attempt. Concurrent callers share one
   * attempt: the UI polls, and a double click must not open two transports.
   * @returns {Promise<void>}
   */
  connect() {
    if (this.#inFlight !== undefined) return this.#inFlight
    if (this.phase === 'ready') return Promise.resolve()
    const generation = ++this.#generation
    this.#inFlight = this.#runConnect(generation).finally(() => { this.#inFlight = undefined })
    return this.#inFlight
  }

  /**
   * The connect sequence. A generation check after every await aborts an attempt
   * that a concurrent `disconnect()`/`restart()` superseded, so a stale attempt
   * can never bind a forward or overwrite newer state.
   * @param {number} generation
   */
  async #runConnect(generation) {
    const stale = () => generation !== this.#generation
    try {
      // A transport left over from a dropped session (its forward is already
      // dead) must be released before a new one takes its place.
      if (this.transport !== undefined) this.#teardown()
      this.url = undefined
      this.boundLocalPort = undefined
      this.reused = false
      const problem = validate(this.config)
      if (problem !== undefined) throw new Error(problem)
      this.#setPhase('connecting', `connecting to ${this.config.target}`)

      const transport = await this.#openTransport(stale, (error) => {
        if (stale()) return
        this.#log(`transport dropped: ${error instanceof Error ? error.message : String(error)}`)
        if (this.phase !== 'ready') return
        this.#stopHeartbeat()
        this.#setPhase('error', 'the SSH connection dropped — reconnect to resume')
        this.emit('drop', error)
      })
      if (transport === undefined) return
      this.transport = transport

      const facts = await probe(transport, this.config)
      if (stale()) return
      this.facts = /** @type {any} */ (facts)
      this.#log(
        `remote: dsh=${facts.dsh === '' ? 'NOT FOUND' : facts.dsh} node=${facts.nodeVersion ?? 'NOT FOUND'} ` +
          `workspace=${facts.workspaceExists ? 'ok' : 'MISSING'} profile=${facts.profileExists ? 'ok' : 'MISSING'} ` +
          `port=${facts.listening ? 'in use' : 'free'}`,
      )
      if (facts.dsh === '') {
        throw new Error(
          'the `dsh` command was not found on the server. Install it there (' +
            '`npm i -g @deepseek-ai/dsh`) or put it on the non-interactive PATH.',
        )
      }
      if (!facts.workspaceExists) {
        throw new Error(`the remote workspace directory does not exist: ${this.config.remoteWorkspace}`)
      }
      // The CLI initialises its built-in profiles from their templates on first
      // use; any other name must exist already.
      if (!facts.profileExists && !BUILTIN_PROFILES.has(this.config.remoteProfile)) {
        throw new Error(
          `the remote profile "${this.config.remoteProfile}" does not exist. Create it on the server first ` +
            `(a shell that boots the profile once, or \`dsh plugin --profile ${this.config.remoteProfile} install\`), ` +
            'then connect again.',
        )
      }

      if (facts.listening) {
        this.reused = true
        this.#setPhase('starting', `reusing the harness already listening on remote port ${String(this.config.remotePort)}`)
        const existing = parseLaunchUrl(await readLog(transport, this.config, 400))
        if (stale()) return
        if (existing === undefined) {
          throw new Error(
            `something is listening on remote port ${String(this.config.remotePort)} but no launch URL could be read ` +
              'from its log. Use "Restart remote" to replace it.',
          )
        }
        this.url = existing
        this.#log('reused the running harness and the launch URL from its log')
        if (this.linkSecret !== undefined) {
          this.#log('keeping the link secret from the start earlier in this app run')
        } else {
          // A harness this app started in an earlier run still holds its secret
          // in its environment; read it back instead of asking for a restart.
          const recovered = await readLinkSecret(transport, this.config).catch(() => undefined)
          if (stale()) return
          this.linkSecret = recovered
          this.#log(
            recovered === undefined
              ? 'integration unavailable: this harness was not started by this app — restart the remote to enable it'
              : 'recovered the link secret from the running harness',
          )
        }
      } else {
        this.#setPhase('starting', 'starting the remote harness')
        const secret = this.generateSecret()
        const start = startCommand(this.config, facts.dsh, { secret })
        const started = await transport.exec(start.script, { timeoutMs: 30_000, input: start.input })
        if (stale()) return
        if (started.code !== 0) {
          throw new Error(
            `starting the remote harness failed (exit ${String(started.code)}): ${started.stderr.trim() || 'no stderr'}`,
          )
        }
        // The process now running holds this secret, whatever happens next.
        this.linkSecret = secret
        const method = /^STARTED=(.*)$/m.exec(started.stdout)
        this.#log(`launch method: ${method === null ? 'unknown' : method[1].trim()}`)
        this.#log(
          'waiting for the launch line — the harness block-buffers a detached stdout, so this can take a minute or two',
        )
        const found = await awaitLaunchUrl(transport, this.config, {
          deadline: Date.now() + this.config.startTimeoutMs,
          onTick: (elapsed) => {
            if (elapsed % 5_000 < 600) this.#log(`waiting for the remote URL… (${String(Math.round(elapsed / 1000))}s)`)
          },
        })
        if (stale()) return
        if (found === undefined) {
          const tail = await readLog(transport, this.config, 60).catch(() => '')
          throw new Error(
            `the remote harness did not print a launch URL within ` +
              `${String(Math.round(this.config.startTimeoutMs / 1000))}s. Last log lines:\n` +
              (tail.trim() || '(the log is empty)'),
          )
        }
        this.url = found.url
        this.#log(`remote harness printed its URL: ${found.url}`)
      }

      // The local port defaults to the remote port on purpose: the harness
      // browser-auth cookie is bound to the authority, so 3080 -> 3080 is the
      // shape the trust model was verified against.
      const bound = await transport.startTunnel(this.config.remotePort, this.config.localPort, (line) => { this.#log(line) })
      if (stale()) return
      this.boundLocalPort = bound.localPort
      this.config.localPort = bound.localPort

      if (bound.localPort !== this.config.remotePort) {
        this.#log(
          `WARNING: the local port (${String(bound.localPort)}) differs from the remote port ` +
            `(${String(this.config.remotePort)}). The printed URL advertises the remote authority, so the window ` +
            'will not match the harness cookie. Set the local port equal to the remote port to avoid this.',
        )
        this.url = this.url.replace(
          new RegExp(`:${String(this.config.remotePort)}(?=/|$)`),
          `:${String(bound.localPort)}`,
        )
      }
      this.#setPhase('ready', `ready at http://127.0.0.1:${String(bound.localPort)}/`)
      void this.#startLink(generation)
    } catch (error) {
      if (stale()) return
      this.#setPhase('error', error instanceof Error ? error.message : String(error))
      this.#teardown()
    }
  }

  /**
   * Open an authenticated transport.
   * @param {() => boolean} stale whether the calling attempt was superseded.
   * @param {(error: unknown) => void} [onDrop] called when an open transport drops.
   * @returns {Promise<SystemSshTransport | undefined>}
   *   undefined when the caller went stale; throws when the connection fails.
   */
  async #openTransport(stale, onDrop) {
    const transport = this.transportFactory(this.config)
    try {
      await transport.connect(onDrop)
    } catch (error) {
      try { transport.dispose() } catch { /* already gone */ }
      this.#log(`ssh failed: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
    if (stale()) {
      try { transport.dispose() } catch { /* already gone */ }
      return undefined
    }
    this.#log(`ssh established to ${this.config.target}`)
    return transport
  }

  /**
   * Stop the remote harness and close the local forward.
   *
   * Works whether or not a session is live: without one, a short-lived
   * transport is opened only to run the stop, so a harness left running by an
   * earlier disconnect (or by a previous app run) can still be shut down.
   * @returns {Promise<void>}
   */
  async stop() {
    const generation = ++this.#generation
    const stale = () => generation !== this.#generation
    // Take ownership of the live transport up front, so a connect started while
    // the stop runs builds its own instead of inheriting one about to close.
    let transport = this.transport
    this.transport = undefined
    this.boundLocalPort = undefined
    this.url = undefined
    this.linkSecret = undefined
    this.#resetLink()
    this.#setPhase('stopping', 'stopping the remote harness')
    try {
      if (transport === undefined) {
        transport = await this.#openTransport(stale)
        if (transport === undefined) return
      }
      const stopped = await stopRemote(transport, this.config)
      if (stale()) return
      this.#log(`remote stop: killed=${String(stopped.stopped)}${stopped.note === '' ? '' : ` (${stopped.note})`}`)
      if (this.facts !== undefined) this.facts = { ...this.facts, listening: stopped.note !== '' }
      if (stopped.note !== '') this.#setPhase('error', `the remote harness may still be running: ${stopped.note}`)
      else this.#setPhase('stopped', stopped.stopped ? 'the remote harness was stopped' : 'no remote harness was running')
    } catch (error) {
      if (stale()) return
      this.#setPhase('error', `stopping the remote harness failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      // The forward points at a harness that is gone, and a transport opened
      // only for the stop must not outlive it either.
      try { transport?.dispose() } catch { /* already gone */ }
    }
  }

  /**
   * App exit. Applies the connection's close policy.
   *
   * With `closePolicy: 'stop'`, a live session also stops its remote harness.
   * The stop is best effort: the process may exit before it completes. It is
   * ordered so that the part that matters most happens synchronously — the stop
   * runs in its own `ssh` process, spawned before this returns, so the forward is
   * closed at once and the stop still reaches the server if this process exits
   * first.
   *
   * Only a live session is stopped: a harness the user already disconnected
   * from is left alone rather than dialling the server during shutdown.
   * @param {string} reason
   * @returns {Promise<void>}
   */
  async shutdown(reason) {
    const transport = this.transport
    if (this.config.closePolicy !== 'stop' || transport === undefined) {
      await this.disconnect(reason)
      return
    }
    this.#generation += 1
    this.#log(`${reason}: stopping the remote harness (close policy: stop)`)
    this.#stopHeartbeat()
    const target = this.#linkTarget()
    if (this.link.status === 'active' && target !== undefined) {
      // The plugin stops its own harness at once; the ssh stop below is the
      // guarantee when it cannot.
      try {
        await withTimeout(this.linkClient.release(target), LINK_EXIT_TIMEOUT_MS)
        this.#log('desktop link: released; the remote harness is stopping itself')
      } catch (error) {
        this.#log(`desktop link: release failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const pending = stopRemote(transport, this.config)
    this.linkSecret = undefined
    await this.disconnect(reason, { keepLease: true })
    try {
      await pending
    } catch { /* best effort during shutdown */ }
  }

  /** Dispose the transport, leaving state intact so the UI can show why. */
  #teardown() {
    const transport = this.transport
    this.transport = undefined
    this.boundLocalPort = undefined
    try { transport?.dispose() } catch { /* already gone */ }
  }

  /**
   * Tear down the local side. The remote harness keeps running.
   *
   * A deliberate disconnect also clears an armed lease: the user chose to leave
   * the remote running, so it must not stop itself later. A reconnect (after a
   * drop, after sleep) keeps it, since the next connect renews it.
   * @param {string} [reason]
   * @param {{ keepLease?: boolean }} [options]
   * @returns {Promise<void>}
   */
  async disconnect(reason = 'disconnected by the user', options = {}) {
    this.#generation += 1
    this.#stopHeartbeat()
    const target = this.#linkTarget()
    if (options.keepLease !== true && this.link.leased && target !== undefined) {
      try {
        await withTimeout(this.linkClient.lease(target, 0), LINK_EXIT_TIMEOUT_MS)
        this.#log('desktop link: lease cleared; the remote harness keeps running')
      } catch (error) {
        this.#log(`desktop link: could not clear the lease: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    this.#resetLink()
    const transport = this.transport
    this.transport = undefined
    this.boundLocalPort = undefined
    if (transport !== undefined) {
      try { transport.dispose() } catch { /* already gone */ }
      this.#log('transport closed and the local forward stopped')
    }
    this.url = undefined
    if (this.phase !== 'idle') this.#setPhase('stopped', reason)
  }

  /**
   * Replace the remote harness with a fresh one, then reconnect.
   *
   * Needed when a harness left no launch URL in its log (started some other
   * way), so no token can be recovered from it, and to enable integration for a
   * harness this app run did not start (its link secret is unknown).
   * @returns {Promise<void>}
   */
  async restart() {
    const transport = this.transport
    if (transport === undefined) {
      // Not connected: stop whatever holds the port, then start fresh.
      await this.stop()
      if (this.phase === 'error') return
      this.phase = 'idle'
      await this.connect()
      return
    }
    this.#generation += 1
    this.url = undefined
    this.linkSecret = undefined
    this.#resetLink()
    this.#setPhase('starting', 'stopping the remote harness')
    try {
      const stopped = await stopRemote(transport, this.config)
      this.#log(`remote stop: killed=${String(stopped.stopped)}${stopped.note === '' ? '' : ` (${stopped.note})`}`)
    } catch (error) {
      this.#log(`remote stop failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.#teardown()
    this.phase = 'idle'
    await this.connect()
  }

  // ---------------------------------------------------------------- desktop link

  /** Where the plugin can be reached, when it can. */
  #linkTarget() {
    if (this.linkSecret === undefined || this.boundLocalPort === undefined) return undefined
    return { port: this.boundLocalPort, secret: this.linkSecret }
  }

  #resetLink() {
    this.#stopHeartbeat()
    this.#feedAbort?.abort()
    this.#feedAbort = undefined
    this.link = { status: 'unavailable', leased: false }
  }

  #stopHeartbeat() {
    if (this.#heartbeat !== undefined) this.timers.clearTimeout(this.#heartbeat)
    this.#heartbeat = undefined
  }

  #scheduleRenewal() {
    this.#stopHeartbeat()
    /** @type {any} */
    const handle = this.timers.setTimeout(() => {
      this.#heartbeat = undefined
      void this.#renew()
    }, Math.floor((this.leaseTtlSec * 1000) / 3))
    this.#heartbeat = handle
    // A renewal must never keep the process alive on its own.
    if (typeof handle?.unref === 'function') handle.unref()
  }

  /**
   * Shake hands with the server plugin once the forward is up. Every outcome
   * but a handshake of our protocol is a quiet downgrade to display-only.
   * @param {number} generation
   */
  async #startLink(generation) {
    const target = this.#linkTarget()
    if (target === undefined) {
      this.link = { status: 'unavailable', leased: false, detail: 'this harness was not started by this app' }
      this.emit('change')
      return
    }
    this.link = { status: 'checking', leased: false }
    this.emit('change')
    const handshake = await this.linkClient.hello(target)
    if (generation !== this.#generation) return
    if (handshake.status !== 'active') {
      this.link = { status: handshake.status, leased: false, detail: handshake.reason }
      this.#log(`desktop link: ${handshake.status} — ${handshake.reason}; continuing display-only`)
      return
    }
    const tasks = handshake.capabilities.includes('events') && typeof this.linkClient.events === 'function'
    this.link = { status: 'active', leased: false, plugin: handshake.plugin, tasks }
    this.#log(`desktop link: active (server plugin ${handshake.plugin})`)
    if (tasks) void this.#followTasks(generation)
    await this.#applyLeasePolicy()
  }

  /**
   * Follow the plugin's finished-task feed for as long as this link lives,
   * re-emitting each item as `task`. The first answer only fixes where "now"
   * is: tasks that finished before this app connected are not news. Failures
   * back off; a disconnect, stop or restart ends the loop and its open poll.
   * @param {number} generation
   */
  async #followTasks(generation) {
    const abort = new AbortController()
    this.#feedAbort?.abort()
    this.#feedAbort = abort
    const live = () => generation === this.#generation && !abort.signal.aborted
    // A reconnect to the same harness (same secret) picks up where the last
    // link stopped, so a task that finished while the laptop slept still counts.
    const kept = this.#feedPosition
    let instance = kept !== undefined && kept.secret === this.linkSecret ? kept.instance : undefined
    let cursor = instance === undefined ? 0 : /** @type {any} */ (kept).cursor
    let failures = 0
    while (live()) {
      const target = this.#linkTarget()
      if (target === undefined) return
      try {
        const reply = await this.linkClient.events(target, {
          instance, after: cursor, waitMs: instance === undefined ? 0 : TASK_POLL_WAIT_MS, signal: abort.signal,
        })
        if (!live()) return
        const fresh = instance !== undefined && !reply.reset
        instance = reply.instance
        cursor = reply.cursor
        this.#feedPosition = { secret: target.secret, instance, cursor }
        failures = 0
        if (fresh) for (const task of reply.events) this.emit('task', task)
      } catch (error) {
        if (!live()) return
        failures += 1
        if (failures === 1) this.#log(`desktop link: task feed interrupted: ${error instanceof Error ? error.message : String(error)}`)
        await new Promise((resolve) => {
          const handle = /** @type {any} */ (this.timers.setTimeout(resolve, Math.min(30_000, 1_000 * 2 ** failures)))
          if (typeof handle?.unref === 'function') handle.unref()
        })
      }
    }
  }

  /**
   * The lease follows the close policy: under "stop" the remote holds a
   * watchdog that stops it once this app is gone (killed, crashed, offline for
   * good); under "keep" there must be none.
   */
  async #applyLeasePolicy() {
    if (this.link.status !== 'active') return
    const target = this.#linkTarget()
    if (target === undefined) return
    if (this.config.closePolicy === 'stop') {
      await this.#renew()
      return
    }
    this.#stopHeartbeat()
    const generation = this.#generation
    try {
      await this.linkClient.lease(target, 0)
      if (generation !== this.#generation) return
      if (this.link.leased) this.#log('desktop link: lease cleared (close policy: keep)')
      this.link = { ...this.link, leased: false }
      this.emit('change')
    } catch (error) {
      this.#log(`desktop link: could not clear the lease: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Arm or renew the lease, then schedule the next renewal. */
  async #renew() {
    const target = this.#linkTarget()
    if (target === undefined || this.link.status !== 'active' || this.config.closePolicy !== 'stop') return
    const generation = this.#generation
    try {
      await this.linkClient.lease(target, this.leaseTtlSec)
      if (generation !== this.#generation) return
      if (!this.link.leased) {
        this.#log(`desktop link: lease armed — the remote stops itself ${String(this.leaseTtlSec)}s after this app is gone`)
      }
      this.link = { ...this.link, leased: true }
      this.emit('change')
    } catch (error) {
      if (generation !== this.#generation) return
      this.#log(`desktop link: lease renewal failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (generation === this.#generation && this.config.closePolicy === 'stop' && this.link.status === 'active') {
        this.#scheduleRenewal()
      }
    }
  }

  /**
   * Re-read the remote log and adopt a newly printed URL. The cheap recovery
   * path for a 401: the forward stays bound, so the window does not have to move.
   * @returns {Promise<{ ok: boolean, message: string }>}
   */
  async refreshFromLog() {
    if (this.transport === undefined) return { ok: false, message: 'not connected' }
    const url = parseLaunchUrl(await readLog(this.transport, this.config, 400))
    if (url === undefined) return { ok: false, message: 'no launch URL found in the remote log' }
    this.url = url
    return { ok: true, message: 'adopted the URL from the remote log' }
  }

  /** Re-probe the remote host without touching the running harness. */
  async refreshFacts() {
    if (this.transport === undefined) return
    try {
      this.facts = /** @type {any} */ (await probe(this.transport, this.config))
    } catch (error) {
      this.#log(`probe failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * The UI-facing snapshot. Carries no credential material: neither the link
   * secret nor anything from the ssh configuration.
   * @returns {Record<string, unknown>}
   */
  snapshot() {
    const transport = this.transport
    const forward = transport === undefined ? null : (/** @type {any} */ (transport).forward ?? null)
    return {
      id: this.config.id,
      name: this.config.name,
      phase: this.phase,
      message: this.message,
      url: this.url ?? null,
      reused: this.reused,
      integrationAvailable: this.linkSecret !== undefined,
      link: {
        status: this.link.status,
        leased: this.link.leased,
        plugin: this.link.plugin ?? null,
        detail: this.link.detail ?? null,
        tasks: this.link.tasks === true,
      },
      localPort: this.boundLocalPort ?? this.config.localPort,
      remotePort: this.config.remotePort,
      remoteProfile: this.config.remoteProfile,
      remoteWorkspace: this.config.remoteWorkspace,
      destination: this.config.target,
      closePolicy: this.config.closePolicy,
      facts: this.facts ?? null,
      forward,
      log: this.log.tail(200),
    }
  }
}
