/**
 * The system-ssh transport.
 *
 * The OpenSSH client the user already has is the only way this package reaches
 * a server. Honouring `~/.ssh/config` (Host aliases, IdentityFile, ProxyJump,
 * Include) is often the entire configuration, and it means this process never
 * reads key material: `ssh -N -L` makes OpenSSH own the local listener itself,
 * so keys, agent use, and host-key checking all stay inside the client.
 *
 * Interface the session relies on (tests substitute a fake with the same shape):
 *
 *   connect(onDrop?): Promise<void>
 *   exec(command, { timeoutMs, input }?): Promise<{ code, stdout, stderr, timedOut, truncated }>
 *   startTunnel(remotePort, localPort, onEvent): Promise<{ localPort }>
 *   forward: { localPort, active, total } | null
 *   dispose(): void
 *
 * @module @dsh-ssh/core/transports
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect as netConnect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** How long to wait for an SSH connection or a forward to come up. */
const READY_TIMEOUT_MS = 25_000

/**
 * The ssh client to run.
 *
 * On Windows this is pinned to the OpenSSH that ships with the system, not
 * whatever `ssh` comes first on PATH. Git for Windows puts its own MSYS build
 * there, which reads a different home and agent, and which dies at startup
 * inside a restricted parent (seen from Electron as
 * `NtCreateDirectoryObject(\BaseNamedObjects\msys-2.0…): 0xC0000022`). PATH
 * is only the fallback for a system without the bundled client.
 * @returns {string}
 */
export function sshCommand() {
  if (process.platform !== 'win32') return 'ssh'
  const bundled = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
  return existsSync(bundled) ? bundled : 'ssh'
}

/**
 * The option list every system-ssh invocation shares.
 *
 * `BatchMode=yes` is what keeps a failure fast: without it `ssh` can block on an
 * interactive password or host-key prompt reading from a stdin nobody is
 * watching, and the app would look like it hung. Host-key checking is left at
 * the user's own setting so an unknown host fails with ssh's own diagnostic.
 *
 * Everything else — port, identity, jump host, agent forwarding — is the
 * user's `~/.ssh/config` to decide.
 *
 * @returns {string[]}
 */
export function baseSshArgs() {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=4',
  ]
}

/**
 * Run one `ssh` invocation and buffer its output.
 *
 * Two capture strategies. Pipes are tried first because they need no temporary
 * file and give the cleanest backpressure behaviour. Some confined environments
 * forbid opening a pipe to a child at all — the spawn fails outright with EPERM
 * — so a fallback redirects the child's descriptors straight to a temporary file
 * instead. That path needs no pipe and works where the piped one cannot; the
 * only cost is a small temp file per command.
 *
 * `input`, when given, is written to the remote command's stdin. It is how a
 * secret reaches the server without ever appearing in a command line (see
 * `startCommand` in remote.js).
 *
 * @param {string[]} args
 * @param {{ timeoutMs?: number, input?: string }} [options]
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, timedOut: boolean, truncated: boolean }>}
 */
export function runSsh(args, options = {}) {
  return runSshPiped(args, options).catch((error) => {
    if (error?.code === 'EPERM') return runSshViaFile(args, options)
    throw error
  })
}

/** Capture through pipes. */
function runSshPiped(args, options) {
  const timeoutMs = options.timeoutMs ?? 30_000
  const input = options.input
  return new Promise((resolvePromise, rejectPromise) => {
    let child
    try {
      child = spawn(sshCommand(), args, {
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      rejectPromise(error)
      return
    }
    /** @type {Buffer[]} */
    const out = []
    /** @type {Buffer[]} */
    const err = []
    let timedOut = false
    let settled = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch { /* gone */ }
    }, timeoutMs)
    timer.unref?.()
    if (input !== undefined) {
      // A remote that exits before reading its stdin closes the pipe under us;
      // that is the command's outcome to report, not a write error to throw.
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    }
    child.stdout.on('data', (c) => out.push(c))
    child.stderr.on('data', (c) => err.push(c))
    const settle = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
        truncated: false,
      })
    }
    child.on('error', (error) => {
      // A spawn failure must reject so the caller can retry by file; encoding it
      // as output would look like a successful ssh run with odd stderr.
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectPromise(error)
    })
    child.on('close', (code) => { settle(code) })
  })
}

/** Capture by pointing the child's descriptors at a temporary file. */
async function runSshViaFile(args, options) {
  const timeoutMs = options.timeoutMs ?? 30_000
  const stdin = inputFile(options.input)
  let spawned
  try {
    spawned = spawnToFile(args, [stdin?.fd ?? 'ignore'])
  } finally {
    // The child holds its own duplicate; the parent's copy and the file itself
    // are no longer needed once the spawn has happened (or failed).
    stdin?.cleanup()
  }
  try {
    const code = await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => { try { spawned.child.kill() } catch { /* gone */ } }, timeoutMs)
      timer.unref?.()
      spawned.child.on('error', (error) => { clearTimeout(timer); rejectPromise(error) })
      spawned.child.on('close', (value) => { clearTimeout(timer); resolvePromise(value) })
    })
    return { code, stdout: spawned.read(), stderr: '', timedOut: false, truncated: false }
  } finally {
    spawned.cleanup()
  }
}

/**
 * Stage stdin for the file-based path: a private temp file opened for reading.
 * @param {string | undefined} input
 * @returns {{ fd: number, cleanup: () => void } | undefined}
 */
function inputFile(input) {
  if (input === undefined) return undefined
  const file = join(tmpdir(), `dsh-ssh-in-${String(process.pid)}-${randomBytes(4).toString('hex')}`)
  writeFileSync(file, input, { mode: 0o600 })
  const fd = openSync(file, 'r')
  return {
    fd,
    cleanup: () => {
      try { closeSync(fd) } catch { /* already closed */ }
      try { rmSync(file, { force: true }) } catch { /* left for the OS */ }
    },
  }
}

/**
 * Spawn a child with its stdout and stderr pointed straight at a temporary file
 * instead of pipes.
 *
 * Pipes are unavailable in some confined environments (the spawn fails with
 * EPERM before the process exists), and unlike a short command a long-lived
 * forwarder cannot simply be re-run with different plumbing — it has to start
 * this way. Pointing descriptors at a file needs no pipe, so it works in both
 * environments; the tradeoff is a small temp file per child.
 *
 * @param {string[]} args
 * @param {import('node:child_process').StdioOptions} stdinMode
 * @returns {{ child: import('node:child_process').ChildProcess, file: string, read: () => string, cleanup: () => void }}
 */
function spawnToFile(args, stdinMode) {
  const file = join(tmpdir(), `dsh-ssh-${String(process.pid)}-${randomBytes(4).toString('hex')}.log`)
  const fd = openSync(file, 'w')
  let child
  try {
    child = spawn(sshCommand(), args, { stdio: [.../** @type {any[]} */ (stdinMode), fd, fd], windowsHide: true })
  } catch (error) {
    try { closeSync(fd) } catch { /* already closed */ }
    try { rmSync(file, { force: true }) } catch { /* nothing to remove */ }
    throw error
  }
  // The child holds its own duplicate of the descriptor, so the parent's copy can
  // be closed immediately; leaving it open would keep the file locked on Windows.
  try { closeSync(fd) } catch { /* already closed */ }
  return {
    child,
    file,
    read: () => {
      try { return readFileSync(file, 'utf8') } catch { return '' }
    },
    cleanup: () => {
      try { rmSync(file, { force: true }) } catch { /* left for the OS */ }
    },
  }
}

/**
 * Whether a loopback port accepts a connection.
 *
 * A connect attempt is used rather than a platform tool so the check is the same
 * on Windows and POSIX and needs no privileges.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export function probeListener(port) {
  return new Promise((resolvePromise) => {
    const socket = netConnect(port, '127.0.0.1')
    const done = (value) => {
      socket.destroy()
      resolvePromise(value)
    }
    socket.setTimeout(1_000, () => { done(false) })
    socket.on('connect', () => { done(true) })
    socket.on('error', () => { done(false) })
  })
}

/**
 * Poll until a loopback port accepts a connection.
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
export async function waitForListener(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probeListener(port)) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

/**
 * The system-`ssh` transport.
 *
 * Two long-lived concerns and one deliberate absence:
 *
 *  - **Commands** each run as their own `ssh` invocation. There is no control
 *    master and no multiplexing.
 *  - **The forward** is a long-lived `ssh -N -L` child, so OpenSSH owns the
 *    local listener, the bind, and every reconnect-free detail of it. This class
 *    only waits for the bind and tears the child down.
 *  - **No `-M`/`ControlMaster`.** It is tempting, because multiplexing would make
 *    each command cheaper, but on Windows OpenSSH the master process fails to
 *    start at all in some environments — observed as
 *    `getsockname failed: Not a socket` on the very first `-M -N` — which would
 *    take the whole transport down with it. A fresh connection per command is
 *    slower and works everywhere, which is the right trade for a control plane.
 *
 * `-o ExitOnForwardFailure=yes` turns a port conflict into an immediate,
 * reportable failure instead of a listener that accepts and drops.
 */
export class SystemSshTransport {
  /**
   * @param {import('./config.js').ConnectionConfig} config
   */
  constructor(config) {
    this.config = config
    /** @type {import('node:child_process').ChildProcess | undefined} */
    this.forwarder = undefined
    /** @type {number | undefined} */
    this.boundPort = undefined
    /** @type {ReturnType<typeof spawnToFile> | undefined} */
    this.forwarderLog = undefined
    /** @type {((error: unknown) => void) | undefined} */
    this.onDrop = undefined
  }

  /**
   * Prove the connection authenticates and can execute, by running one command.
   *
   * There is nothing to establish first: each command opens its own connection.
   * This check exists so a failure is reported at connect time, with the remote's
   * own diagnostic, rather than surfacing later as a puzzling probe error.
   * @param {(error: unknown) => void} [onDrop] called when the forward child exits unexpectedly.
   */
  async connect(onDrop) {
    this.onDrop = onDrop
    const check = await this.exec('echo ok', { timeoutMs: 25_000 })
    if (check.code !== 0) {
      const detail = (check.stderr || check.stdout).trim()
      throw new Error(
        `SSH authentication failed for ${this.config.target}: ${detail || `exit ${String(check.code)}`}`,
      )
    }
  }

  /**
   * @param {string} command
   * @param {{ timeoutMs?: number, input?: string }} [options]
   */
  async exec(command, options = {}) {
    const args = [...baseSshArgs(), this.config.target, command]
    return runSsh(args, options)
  }

  /**
   * Start the forward. OpenSSH owns the listener; this only waits for the bind.
   * @param {number} remotePort
   * @param {number} localPort
   * @param {(line: string) => void} [onEvent]
   */
  async startTunnel(remotePort, localPort, onEvent) {
    const actualLocal = localPort === 0 ? remotePort : localPort
    const args = [
      '-N',
      '-o', 'ExitOnForwardFailure=yes',
      // Loopback on both ends, pinned: the design depends on the forwarded
      // traffic arriving at the remote harness as a loopback request.
      '-L', `127.0.0.1:${String(actualLocal)}:127.0.0.1:${String(remotePort)}`,
      ...baseSshArgs(),
      this.config.target,
    ]
    const spawned = spawnToFile(args, ['ignore'])
    const child = spawned.child
    this.forwarder = child
    this.forwarderLog = spawned

    /** Text already relayed, so the poll below reports each line once. */
    let relayed = ''
    const relayNew = () => {
      const text = spawned.read()
      if (text.length <= relayed.length) return
      const fresh = text.slice(relayed.length)
      relayed = text
      for (const line of fresh.split(/\r?\n/)) if (line.trim() !== '') onEvent?.(`ssh: ${line.trim()}`)
    }

    const deadline = Date.now() + READY_TIMEOUT_MS
    let up = false
    while (Date.now() < deadline) {
      relayNew()
      if (child.exitCode !== null) break
      if (await probeListener(actualLocal)) { up = true; break }
      await new Promise((r) => setTimeout(r, 250))
    }
    relayNew()
    if (!up) {
      const detail = spawned.read().trim()
      try { child.kill() } catch { /* gone */ }
      this.forwarder = undefined
      this.forwarderLog = undefined
      spawned.cleanup()
      throw new Error(
        `the local forward on 127.0.0.1:${String(actualLocal)} did not come up` +
          (detail === '' ? '' : `: ${detail}`),
      )
    }
    this.boundPort = actualLocal
    // The forward is the only long-lived connection, so its exit is how a dropped
    // link (network loss, sleep, server restart) becomes visible. `dispose()`
    // clears `forwarder` first, so a deliberate teardown is not reported.
    child.once('exit', (code) => {
      if (this.forwarder !== child) return
      relayNew()
      this.onDrop?.(new Error(`the ssh forward exited (code ${String(code)})`))
    })
    onEvent?.(`listening on 127.0.0.1:${String(actualLocal)} -> remote 127.0.0.1:${String(remotePort)} (system ssh)`)
    return { localPort: actualLocal }
  }

  /** Whether the forward child is still running. */
  get forward() {
    const child = this.forwarder
    if (child === undefined || this.boundPort === undefined) return null
    return { localPort: this.boundPort, active: child.exitCode === null ? 1 : 0, total: 0 }
  }

  dispose() {
    const child = this.forwarder
    this.forwarder = undefined
    this.boundPort = undefined
    try { child?.kill() } catch { /* already gone */ }
    this.forwarderLog?.cleanup()
    this.forwarderLog = undefined
  }
}

/** Whether the system `ssh` client is reachable on this platform. */
export function sshAvailable() {
  if (process.platform !== 'win32') return true
  return existsSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe'))
}
