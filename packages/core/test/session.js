/**
 * Session orchestration tests.
 *
 * `RemoteSession` is where the subtle bugs live: phase transitions, the
 * start-versus-reuse decision, launch-URL adoption, the local-port/authority
 * invariant, the link secret's lifetime, and teardown on failure. Reaching any
 * of it otherwise needs a live server, so the session takes an injectable
 * transport factory and this file drives it with a fake that answers the exact
 * commands `probe`, `startCommand`, and `readLog` issue.
 *
 * The fake's command matching is intentionally loose (substring, not equality):
 * it must keep working when the shell text is refactored, while still failing
 * loudly if the probe stops asking the questions the decision depends on.
 *
 * Run: node test/session.js
 */
import { strict as assert } from 'node:assert'

import { normalize } from '../lib/config.js'
import { RemoteSession } from '../lib/session.js'
import { parseLaunchUrl } from '../lib/remote.js'
import { taskEvent } from '../lib/link-client.js'

const TOKEN = 'blll_WO7-im5BJ5ucfrn5MudALK8inj-_iE_L9VV92Q'
const LAUNCH_LINE = `dsh web: http://127.0.0.1:3080/?token=${TOKEN}`

let failures = 0
/**
 * Run one case under a hard timeout.
 *
 * A hang must be reported as a failure, not leave the process waiting on an
 * unsettled top-level await: node then exits non-zero with none of the earlier
 * results visible, which hides which case broke.
 */
const check = async (label, fn, timeoutMs = 20_000) => {
  let timer
  try {
    await Promise.race([
      fn(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(`timed out after ${String(timeoutMs)}ms`)) }, timeoutMs)
      }),
    ])
    console.log(`ok   ${label}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${label}\n     ${error instanceof Error ? error.message : error}`)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false, truncated: false })

/**
 * A programmable stand-in for a transport.
 *
 * `listening` may be flipped by the test between connects, which is how a
 * reconnect to a still-running harness is simulated.
 *
 * @param {object} scenario
 * @param {boolean} [scenario.dshFound]
 * @param {boolean} [scenario.workspaceExists]
 * @param {boolean} [scenario.profileExists]
 * @param {boolean} [scenario.listening]
 * @param {string} [scenario.logText]
 * @param {(command: string) => object | undefined} [scenario.onCommand]
 * @param {boolean} [scenario.connectFails]
 */
function fakeTransport(scenario) {
  /** @type {{ command: string, options: any }[]} */
  const execs = []
  const state = {
    connects: 0,
    disposes: 0,
    tunnels: [],
    execs,
    get calls() { return execs.map((e) => e.command) },
    dropHandler: undefined,
  }
  const transport = {
    async connect(onDrop) {
      state.connects += 1
      state.dropHandler = onDrop
      if (scenario.connectFails === true) throw new Error('SSH authentication failed for devbox: Permission denied (publickey)')
    },
    async exec(command, options) {
      execs.push({ command, options })
      const custom = scenario.onCommand?.(command)
      if (custom !== undefined) return { ...ok(), ...custom }
      // Identification matches on markers that only appear in one command's
      // text. `DSH=` in particular occurs inside the probe's own script
      // (`printf "DSH=%s\n"`), so matching on it would misclassify the probe.
      if (command.includes('echo ok')) return ok('ok\n')
      // Before the probe branch: the stop script embeds the same `rd_listen()`
      // port check the probe uses.
      if (command.includes('KILLED=')) {
        scenario.listening = false
        return ok('FREE\nKILLED=yes\n')
      }
      if (command.includes('rd_listen()')) {
        const dsh = scenario.dshFound === false ? '' : '/home/dev/.local/bin/dsh'
        return ok(
          `DSH=${dsh}\n` +
            `WORKSPACE=${scenario.workspaceExists === false ? 'no' : 'yes'}\n` +
            `PROFILE=${scenario.profileExists === false ? 'no' : 'yes'}\n` +
            'NODE=v24.21.0\n' +
            `${scenario.listening === true ? 'LISTENING' : 'FREE'}\n`,
        )
      }
      if (command.includes('tail -n')) return ok(scenario.logText ?? '')
      if (command.includes('/environ')) return ok(`LINKSECRET=${scenario.runningSecret ?? ''}\n`)
      if (command.includes('printf "STARTED=')) {
        scenario.listening = true
        return ok('STARTED=systemd-run\n')
      }
      return ok()
    },
    async startTunnel(remotePort, localPort) {
      state.tunnels.push({ remotePort, localPort })
      return { localPort: localPort === 0 ? remotePort : localPort }
    },
    dispose() {
      state.disposes += 1
    },
    forward: null,
  }
  return { transport, state }
}

/** Deterministic secrets: s1, s2, … padded to a valid 64-hex shape. */
function secretSequence() {
  let n = 0
  return () => {
    n += 1
    return String(n).padStart(64, 'a')
  }
}

/** A session wired to a fake, with a fast start timeout so failures are quick. */
function makeSession(scenario, overrides = {}) {
  const config = normalize({
    id: 'devbox1',
    target: 'devbox',
    remoteWorkspace: '/home/dev/work',
    remoteProfile: 'web',
    remotePort: 3080,
    localPort: 3080,
    startTimeoutMs: 5_000,
    ...overrides,
  })
  const built = fakeTransport(scenario)
  const link = fakeLink(scenario.link ?? 'absent', scenario.feed)
  const timers = fakeTimers()
  const session = new RemoteSession(config, {
    transportFactory: () => built.transport,
    generateSecret: secretSequence(),
    linkClient: link.client,
    leaseTtlSec: 600,
    timers,
  })
  return { session, config, transport: built.transport, state: built.state, scenario, link, timers }
}

/**
 * A stand-in for the desktop-link plugin. Never real HTTP: the fake forward
 * binds nothing, and 127.0.0.1:3080 may be a real DSH on the test machine.
 * @param {'active' | 'absent' | 'incompatible'} mode
 * @param {any[]} [feed] scripted answers of the finished-task feed, in order;
 *   when given, the plugin announces `events`. Past the end a poll hangs until
 *   it is aborted, like a real long poll with nothing to say.
 */
function fakeLink(mode, feed) {
  /** @type {string[]} */
  const calls = []
  let failLease = false
  /** @type {AbortSignal[]} */
  const polls = []
  const client = {
    async hello(target) {
      calls.push(`hello ${String(target.port)} ${target.secret.slice(-1)}`)
      if (mode === 'active') return { status: 'active', plugin: '0.1.0', capabilities: feed === undefined ? ['lease', 'release'] : ['lease', 'release', 'events'] }
      return { status: mode, reason: `fake ${mode}` }
    },
    async lease(_target, ttlSec) {
      calls.push(`lease ${String(ttlSec)}`)
      if (failLease) throw new Error('forward is gone')
    },
    async release() { calls.push('release') },
    async events(_target, options) {
      calls.push(`events ${String(options.instance)} ${String(options.after)} ${String(options.waitMs)}`)
      polls.push(options.signal)
      const next = feed?.shift()
      if (next !== undefined) return next
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => { reject(new Error('aborted')) })
      })
    },
  }
  return { client, calls, polls, failLeases: (value) => { failLease = value } }
}

/** Timers the test fires by hand. */
function fakeTimers() {
  let next = 1
  /** @type {Map<number, { fn: () => void, ms: number }>} */
  const pending = new Map()
  return {
    pending,
    setTimeout: (fn, ms) => { const id = next++; pending.set(id, { fn, ms }); return id },
    clearTimeout: (id) => { pending.delete(id) },
    async fire() {
      const due = [...pending.values()]
      pending.clear()
      for (const t of due) t.fn()
      await settle()
    },
  }
}

/** Let fire-and-forget link work (handshake, renewals) finish. */
const settle = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve() }

await check('a fresh start reaches ready, parses the URL, and binds the forward', async () => {
  const { session, state } = makeSession({ listening: false, logText: `${LAUNCH_LINE}\n` })
  await session.connect()
  assert.equal(session.phase, 'ready', `expected ready, got ${session.phase}: ${session.message}`)
  assert.equal(session.url, `http://127.0.0.1:3080/?token=${TOKEN}`)
  assert.equal(session.reused, false)
  assert.equal(state.tunnels.length, 1)
  assert.deepEqual(state.tunnels[0], { remotePort: 3080, localPort: 3080 })
  assert.equal(session.snapshot().localPort, 3080)
  // A start, not a reuse: the stop command must not have been issued, and the
  // start command must have been.
  assert.equal(state.calls.some((c) => c.includes('KILLED=')), false)
  assert.equal(state.calls.some((c) => c.includes('printf "STARTED=')), true)
})

await check('a fresh start sends a link secret on stdin, never in the command', async () => {
  const { session, state } = makeSession({ listening: false, logText: `${LAUNCH_LINE}\n` })
  await session.connect()
  const start = state.execs.find((e) => e.command.includes('printf "STARTED='))
  assert.ok(start !== undefined)
  const secret = '1'.padStart(64, 'a')
  assert.equal(start.options.input, `${secret}\n`)
  for (const { command } of state.execs) assert.equal(command.includes(secret), false)
  assert.equal(session.linkSecret, secret)
})

await check('the snapshot reports integration but never carries the secret', async () => {
  const { session } = makeSession({ listening: false, logText: `${LAUNCH_LINE}\n` })
  await session.connect()
  const snapshot = session.snapshot()
  assert.equal(snapshot.integrationAvailable, true)
  assert.equal(JSON.stringify(snapshot).includes(session.linkSecret), false)
  // The URL field carries the token by design (the window loads it once); the
  // log must not.
  assert.equal(snapshot.log.join('\n').includes(TOKEN), false, 'the log in the snapshot is redacted')
})

await check('the launch URL may arrive only after the harness flushes its buffer', async () => {
  // The real host block-buffers the launch line, so the URL is absent on early
  // polls. The session must keep polling rather than treat an empty log as
  // failure — this reproduces the measured 60-90 second delay in miniature.
  let polls = 0
  const { session } = makeSession({
    listening: false,
    onCommand: (command) => {
      if (!command.includes('tail -n')) return undefined
      polls += 1
      // Empty for the first two polls, then the line appears.
      return { stdout: polls >= 3 ? `${LAUNCH_LINE}\n` : '' }
    },
  }, { startTimeoutMs: 10_000 })
  await session.connect()
  assert.equal(session.phase, 'ready', `expected ready, got ${session.phase}: ${session.message}`)
  assert.equal(polls >= 3, true, `expected several polls, got ${String(polls)}`)
  assert.equal(session.url, `http://127.0.0.1:3080/?token=${TOKEN}`)
})

await check('a listening port reuses the running harness instead of starting one', async () => {
  const { session, state } = makeSession({ listening: true, logText: `${LAUNCH_LINE}\n` })
  await session.connect()
  assert.equal(session.phase, 'ready', `expected ready, got ${session.phase}: ${session.message}`)
  assert.equal(session.reused, true)
  assert.equal(state.calls.some((c) => c.includes('printf "STARTED=')), false, 'must not start a second harness')
  assert.match(session.message + session.log.tail(50).join('\n'), /reused/)
})

await check('reusing a harness this app run did not start leaves integration off, and says why', async () => {
  const { session } = makeSession({ listening: true, logText: `${LAUNCH_LINE}\n` })
  await session.connect()
  const snapshot = session.snapshot()
  assert.equal(snapshot.reused, true)
  assert.equal(snapshot.integrationAvailable, false)
  const log = snapshot.log.join('\n')
  assert.match(log, /launch URL from its log/)
  assert.match(log, /restart the remote to enable it/)
})

await check('a reconnect to the harness this app started keeps its secret', async () => {
  // The sleep/resume path: disconnect, then connect again to a harness that is
  // still running. The remote process is the same, so the secret still holds.
  const { session, state } = makeSession({ listening: false, logText: `${LAUNCH_LINE}\n` })
  await session.connect()
  const first = session.linkSecret
  assert.ok(first !== undefined)
  await session.disconnect('network lost')
  await session.connect()
  assert.equal(session.phase, 'ready', session.message)
  assert.equal(session.reused, true)
  assert.equal(session.linkSecret, first)
  assert.equal(session.snapshot().integrationAvailable, true)
  assert.equal(state.calls.filter((c) => c.includes('printf "STARTED=')).length, 1)
})

await check('a missing dsh stops before starting anything', async () => {
  const { session, state } = makeSession({ dshFound: false })
  await session.connect()
  assert.equal(session.phase, 'error')
  assert.match(session.message, /`dsh` command was not found/)
  assert.equal(state.calls.some((c) => c.includes('printf "STARTED=')), false)
  assert.equal(state.tunnels.length, 0)
  assert.equal(state.disposes, 1, 'the transport must be disposed on failure')
})

await check('a missing workspace is reported with the path', async () => {
  const { session } = makeSession({ workspaceExists: false })
  await session.connect()
  assert.equal(session.phase, 'error')
  assert.match(session.message, /workspace directory does not exist/)
  assert.match(session.message, /\/home\/dev\/work/)
})

await check('a missing custom profile explains how to create it', async () => {
  const { session } = makeSession({ profileExists: false }, { remoteProfile: 'mine' })
  await session.connect()
  assert.equal(session.phase, 'error')
  assert.match(session.message, /profile "mine" does not exist/)
})

await check('a missing built-in profile is left for dsh to create on first start', async () => {
  const { session } = makeSession({ profileExists: false, listening: false, logText: `${LAUNCH_LINE}\n` })
  await session.connect()
  assert.equal(session.phase, 'ready', session.message)
})

await check('an invalid record fails before dialling anything', async () => {
  const { session, state } = makeSession({}, { target: '-oProxyCommand=calc' })
  await session.connect()
  assert.equal(session.phase, 'error')
  assert.match(session.message, /leading dash/)
  assert.equal(state.connects, 0)
})

await check('a listening port with no readable URL is an explicit failure', async () => {
  const { session } = makeSession({ listening: true, logText: 'nothing useful here\n' })
  await session.connect()
  assert.equal(session.phase, 'error')
  assert.match(session.message, /no launch URL could be read/)
})

await check('a harness that never prints a URL times out with the log tail attached', async () => {
  const { session } = makeSession({ listening: false, logText: 'still booting\n' })
  await session.connect()
  assert.equal(session.phase, 'error')
  assert.match(session.message, /did not print a launch URL/)
  assert.match(session.message, /still booting/, 'the remote log tail must be carried into the error')
})

await check('a transport that cannot authenticate fails once, with ssh\'s own diagnostic', async () => {
  const { session, state } = makeSession({ connectFails: true })
  await session.connect()
  assert.equal(state.connects, 1)
  assert.equal(state.disposes, 1)
  assert.equal(session.phase, 'error')
  assert.match(session.message, /Permission denied \(publickey\)/)
})

await check('a local port differing from the remote port is rewritten and warned about', async () => {
  const { session } = makeSession({ listening: true, logText: `${LAUNCH_LINE}\n` }, { localPort: 4000 })
  await session.connect()
  assert.equal(session.phase, 'ready', session.message)
  const log = session.snapshot().log.join('\n')
  assert.match(log, /WARNING: the local port \(4000\) differs/)
  // The advertised authority must follow the local listener, or the window
  // cannot match the authority-bound cookie.
  assert.match(session.url, /^http:\/\/127\.0\.0\.1:4000\//)
})

await check('disconnect closes the transport and clears the advertised URL', async () => {
  const { session, state } = makeSession({ listening: true, logText: `${LAUNCH_LINE}\n` })
  await session.connect()
  assert.equal(session.phase, 'ready')
  await session.disconnect('test teardown')
  assert.equal(session.phase, 'stopped')
  assert.equal(session.url, undefined)
  assert.equal(state.disposes, 1)
  assert.equal(state.calls.some((c) => c.includes('KILLED=')), false, 'disconnect leaves the remote running')
})

await check('a dropped transport during a live session surfaces as an error, not silence', async () => {
  const { session, state } = makeSession({ listening: true, logText: `${LAUNCH_LINE}\n` })
  await session.connect()
  assert.equal(session.phase, 'ready')
  const drops = []
  session.on('drop', (error) => drops.push(error))
  state.dropHandler?.(new Error('the ssh forward exited (code 255)'))
  assert.equal(session.phase, 'error')
  assert.match(session.message, /SSH connection dropped/)
  assert.equal(drops.length, 1, 'the owner is told, so it can reconnect')
})

await check('a drop after a deliberate disconnect is not reported', async () => {
  const { session, state } = makeSession({ listening: true, logText: `${LAUNCH_LINE}\n` })
  await session.connect()
  await session.disconnect('user')
  const drops = []
  session.on('drop', (error) => drops.push(error))
  state.dropHandler?.(new Error('the ssh forward exited (code 1)'))
  assert.equal(drops.length, 0)
  assert.equal(session.phase, 'stopped')
})

await check('every phase transition emits change', async () => {
  const { session } = makeSession({ listening: true, logText: `${LAUNCH_LINE}\n` })
  const phases = []
  session.on('change', () => { if (phases.at(-1) !== session.phase) phases.push(session.phase) })
  await session.connect()
  assert.deepEqual(phases, ['connecting', 'starting', 'ready'])
})

await check('concurrent connect calls share one attempt', async () => {
  const { session, state } = makeSession({ listening: true, logText: `${LAUNCH_LINE}\n` })
  await Promise.all([session.connect(), session.connect(), session.connect()])
  assert.equal(session.phase, 'ready', session.message)
  assert.equal(state.connects, 1, 'three concurrent connects must open one transport')
})

await check('restart stops the remote harness, starts a fresh one, and rotates the secret', async () => {
  const { session, state } = makeSession({ listening: true, logText: `${LAUNCH_LINE}\n` })
  await session.connect()
  assert.equal(session.reused, true)
  await session.restart()
  assert.equal(session.phase, 'ready', session.message)
  assert.equal(state.calls.some((c) => c.includes('KILLED=')), true, 'restart must issue the remote stop')
  assert.equal(state.calls.some((c) => c.includes('printf "STARTED=')), true, 'and then start a new harness')
  assert.equal(session.reused, false)
  assert.equal(session.snapshot().integrationAvailable, true, 'a restart is how integration gets enabled')
  assert.equal(state.disposes >= 1, true)
})

await check('restart while disconnected replaces the harness rather than reusing it', async () => {
  const { session, state } = makeSession({ listening: true, logText: `${LAUNCH_LINE}\n` })
  await session.restart()
  assert.equal(session.phase, 'ready', session.message)
  assert.equal(session.reused, false)
  const stopAt = state.calls.findIndex((c) => c.includes('KILLED='))
  const startAt = state.calls.findIndex((c) => c.includes('printf "STARTED='))
  assert.ok(stopAt >= 0 && startAt > stopAt, 'stop first, then start')
})

await check('refreshFromLog refuses while not connected', async () => {
  const { session } = makeSession({ listening: true, logText: 'no url yet\n' })
  await session.connect()
  assert.equal(session.phase, 'error')
  const result = await session.refreshFromLog()
  assert.equal(result.ok, false)
  assert.match(result.message, /not connected/)
})

await check('setConfig on a live session closes it, says so, and forgets the secret', async () => {
  const { session, state } = makeSession({ listening: false, logText: `${LAUNCH_LINE}\n` })
  await session.connect()
  assert.equal(session.phase, 'ready')
  assert.ok(session.linkSecret !== undefined)
  const dropped = session.setConfig(normalize({ id: 'devbox1', target: 'other', remoteWorkspace: '/w', remoteProfile: 'web' }))
  assert.equal(dropped, true)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(state.disposes >= 1, true)
  assert.equal(session.linkSecret, undefined)
})

await check('changing only the name or close policy keeps a live session', async () => {
  const { session, state, config } = makeSession({ listening: false, logText: `${LAUNCH_LINE}\n` })
  await session.connect()
  const secret = session.linkSecret
  const dropped = session.setConfig({ ...config, name: 'renamed', closePolicy: 'stop' })
  assert.equal(dropped, false)
  assert.equal(session.phase, 'ready')
  assert.equal(state.disposes, 0)
  assert.equal(session.config.closePolicy, 'stop')
  assert.equal(session.linkSecret, secret)
})

await check('stop on a live session stops the remote harness and closes the forward', async () => {
  const { session, state } = makeSession({ listening: false, logText: `${LAUNCH_LINE}\n` })
  await session.connect()
  assert.equal(session.phase, 'ready')
  await session.stop()
  assert.equal(session.phase, 'stopped', session.message)
  assert.equal(session.url, undefined)
  assert.equal(session.transport, undefined)
  assert.equal(session.linkSecret, undefined, 'the stopped process took its secret with it')
  assert.equal(state.calls.filter((c) => c.includes('KILLED=')).length, 1)
  assert.equal(state.disposes, 1, 'the live transport is closed')
  assert.equal(session.snapshot().facts.listening, false, 'the UI no longer offers reuse')
})

await check('stop without a live session opens a transport only for the stop', async () => {
  const { session, state } = makeSession({})
  await session.stop()
  assert.equal(session.phase, 'stopped', session.message)
  assert.equal(state.connects, 1)
  assert.equal(state.calls.some((c) => c.includes('KILLED=')), true)
  assert.equal(state.calls.some((c) => c.includes('printf "STARTED=')), false, 'a stop never starts anything')
  assert.equal(state.disposes, 1, 'the one-off transport is released')
})

await check('stop reports a port that is still listening afterwards', async () => {
  const { session } = makeSession({
    onCommand: (c) => (c.includes('KILLED=') ? { stdout: 'LISTENING\nKILLED=no\n' } : undefined),
  })
  await session.stop()
  assert.equal(session.phase, 'error')
  assert.match(session.message, /may still be running/)
})

await check('a stop whose script dies silently is reported as an error', async () => {
  const { session } = makeSession({
    onCommand: (c) => (c.includes('KILLED=') ? { code: 143, stdout: '' } : undefined),
  })
  await session.stop()
  assert.equal(session.phase, 'error')
  assert.match(session.message, /did not report back/)
})

await check('shutdown with closePolicy keep leaves the remote running', async () => {
  const { session, state } = makeSession({ listening: true, logText: `${LAUNCH_LINE}\n` })
  await session.connect()
  await session.shutdown('the app is quitting')
  assert.equal(state.calls.some((c) => c.includes('KILLED=')), false)
  assert.equal(state.disposes, 1)
  assert.equal(session.phase, 'stopped')
})

await check('shutdown with closePolicy stop stops the remote and closes the forward', async () => {
  const { session, state } = makeSession({ listening: true, logText: `${LAUNCH_LINE}\n` }, { closePolicy: 'stop' })
  await session.connect()
  await session.shutdown('the app is quitting')
  assert.equal(state.calls.filter((c) => c.includes('KILLED=')).length, 1)
  assert.equal(state.disposes >= 1, true)
  assert.equal(session.transport, undefined)
  assert.equal(session.linkSecret, undefined)
})

await check('shutdown with closePolicy stop does not dial a server it is not connected to', async () => {
  const { session, state } = makeSession({}, { closePolicy: 'stop' })
  await session.shutdown('the app is quitting')
  assert.equal(state.connects, 0)
  assert.equal(state.calls.length, 0)
})

await check('parseLaunchUrl tolerates the ANSI and LAN forms a real host emits', () => {
  assert.equal(parseLaunchUrl(`\u001B[32m${LAUNCH_LINE}\u001B[0m (LAN: http://10.155.121.100:3080/?token=x)`), `http://127.0.0.1:3080/?token=${TOKEN}`)
  assert.equal(parseLaunchUrl(''), undefined)
  assert.equal(parseLaunchUrl('dsh web:'), undefined)
})

// ----------------------------------------------------------------- desktop link

await check('without the server plugin the session stays display-only, and says so', async () => {
  const { session, link, timers } = makeSession({ listening: false, logText: `${LAUNCH_LINE}\n`, link: 'absent' })
  await session.connect()
  await settle()
  assert.equal(session.phase, 'ready')
  assert.equal(session.snapshot().link.status, 'absent')
  assert.deepEqual(link.calls, [`hello 3080 1`])
  assert.equal(timers.pending.size, 0, 'nothing to renew')
  assert.match(session.log.tail(20).join('\n'), /continuing display-only/)
})

await check('a plugin of another protocol is treated like no plugin', async () => {
  const { session, link } = makeSession({ listening: false, logText: `${LAUNCH_LINE}\n`, link: 'incompatible' })
  await session.connect()
  await settle()
  assert.equal(session.snapshot().link.status, 'incompatible')
  assert.equal(link.calls.some((c) => c.startsWith('lease')), false)
})

await check('a reused harness this run did not start is not even asked', async () => {
  const { session, link } = makeSession({ listening: true, logText: `${LAUNCH_LINE}\n`, link: 'active' })
  await session.connect()
  await settle()
  assert.equal(session.snapshot().link.status, 'unavailable')
  assert.deepEqual(link.calls, [], 'no secret, so no request')
})

const RUNNING_SECRET = 'e'.repeat(64)

await check('reusing a harness started in an earlier app run recovers its secret and the link', async () => {
  const { session, link, state } = makeSession({ listening: true, logText: `${LAUNCH_LINE}\n`, link: 'active', runningSecret: RUNNING_SECRET })
  await session.connect()
  await settle()
  assert.equal(session.reused, true)
  assert.equal(session.snapshot().link.status, 'active', 'no restart needed')
  assert.deepEqual(link.calls.slice(0, 1), ['hello 3080 e'], 'the handshake uses the recovered secret')
  assert.ok(session.log.lines.some((l) => l.includes('recovered the link secret')))
  assert.equal(session.log.lines.some((l) => l.includes(RUNNING_SECRET)), false, 'the secret never reaches the log')
  assert.equal(state.execs.some((e) => e.command.includes(RUNNING_SECRET)), false, 'nor any command')
  assert.equal(JSON.stringify(session.snapshot()).includes(RUNNING_SECRET), false, 'nor the snapshot')
})

await check('a running harness without a usable secret stays display-only', async () => {
  for (const runningSecret of ['', 'not-hex', 'E'.repeat(64)]) {
    const { session, link } = makeSession({ listening: true, logText: `${LAUNCH_LINE}\n`, link: 'active', runningSecret })
    await session.connect()
    await settle()
    assert.equal(session.snapshot().link.status, 'unavailable', JSON.stringify(runningSecret))
    assert.deepEqual(link.calls, [])
  }
})

const TASK = { sessionId: 'session-7', title: 'fix the build', outcome: 'completed', at: 1 }

await check('the task feed: the first answer only marks "now", later ones become task events', async () => {
  const feed = [
    { instance: 'i1', cursor: 3, reset: true, events: [{ ...TASK, sessionId: 'old' }] },
    { instance: 'i1', cursor: 4, reset: false, events: [TASK] },
  ]
  const { session, link } = makeSession({ listening: false, logText: `${LAUNCH_LINE}\n`, link: 'active', feed })
  /** @type {any[]} */
  const tasks = []
  session.on('task', (task) => { tasks.push(task) })
  await session.connect()
  await settle()
  assert.deepEqual(tasks, [TASK], 'what finished before the connect is not news')
  assert.equal(session.snapshot().link.tasks, true, 'the UI must be able to see that tasks are followed')
  assert.deepEqual(link.calls.filter((c) => c.startsWith('events')), [
    'events undefined 0 0',
    'events i1 3 25000',
    'events i1 4 25000',
  ])
})

await check('a disconnect cuts the open task poll and ends the loop', async () => {
  const feed = [{ instance: 'i1', cursor: 0, reset: true, events: [] }]
  const { session, link } = makeSession({ listening: false, logText: `${LAUNCH_LINE}\n`, link: 'active', feed })
  await session.connect()
  await settle()
  assert.equal(link.polls.length, 2)
  assert.equal(link.polls[1].aborted, false, 'the long poll is open while connected')
  await session.disconnect()
  await settle()
  assert.equal(link.polls[1].aborted, true)
  assert.equal(link.polls.length, 2, 'no poll after the disconnect')
})

await check('feed items are checked and trimmed before anyone shows them', () => {
  assert.deepEqual(taskEvent({ ...TASK, extra: 'x' }), TASK)
  assert.equal(taskEvent({ ...TASK, outcome: 'aborted' }), undefined)
  assert.equal(taskEvent({ ...TASK, sessionId: '' }), undefined)
  assert.equal(taskEvent(null), undefined)
  const long = taskEvent({ ...TASK, title: `  a\n\nb ${'x'.repeat(300)}` })
  assert.equal(long?.title.length, 120)
  assert.ok(long?.title.startsWith('a b '), 'whitespace runs collapse')
})

await check('a plugin without the events capability is never polled', async () => {
  const { session, link } = makeSession({ listening: false, logText: `${LAUNCH_LINE}\n`, link: 'active' })
  await session.connect()
  await settle()
  assert.equal(link.calls.some((c) => c.startsWith('events')), false)
  assert.equal(session.snapshot().link.tasks, false)
})

await check('under "keep" an active link clears any lease and never renews', async () => {
  const { session, link, timers } = makeSession({ listening: false, logText: `${LAUNCH_LINE}\n`, link: 'active' })
  await session.connect()
  await settle()
  const snap = session.snapshot().link
  assert.equal(snap.status, 'active')
  assert.equal(snap.leased, false)
  assert.equal(snap.plugin, '0.1.0')
  assert.deepEqual(link.calls, ['hello 3080 1', 'lease 0'], 'a lease left by an earlier run is cleared')
  assert.equal(timers.pending.size, 0)
})

await check('under "stop" the lease is armed and renewed every third of its length', async () => {
  const { session, link, timers } = makeSession({ listening: false, logText: `${LAUNCH_LINE}\n`, link: 'active' }, { closePolicy: 'stop' })
  await session.connect()
  await settle()
  assert.equal(session.snapshot().link.leased, true)
  assert.deepEqual(link.calls, ['hello 3080 1', 'lease 600'])
  assert.deepEqual([...timers.pending.values()].map((t) => t.ms), [200_000])
  await timers.fire()
  await timers.fire()
  assert.deepEqual(link.calls.slice(2), ['lease 600', 'lease 600'])
  assert.equal(timers.pending.size, 1, 'always exactly one renewal pending')
  assert.match(session.log.tail(30).join('\n'), /lease armed/)
})

await check('a failed renewal is logged and retried on schedule, not fatal', async () => {
  const { session, link, timers } = makeSession({ listening: false, logText: `${LAUNCH_LINE}\n`, link: 'active' }, { closePolicy: 'stop' })
  await session.connect()
  await settle()
  link.failLeases(true)
  await timers.fire()
  assert.equal(session.phase, 'ready')
  assert.match(session.log.tail(10).join('\n'), /lease renewal failed: forward is gone/)
  assert.equal(timers.pending.size, 1, 'the next renewal is still scheduled')
})

await check('switching a live session from "stop" to "keep" clears the lease at once', async () => {
  const { session, link, timers, config } = makeSession({ listening: false, logText: `${LAUNCH_LINE}\n`, link: 'active' }, { closePolicy: 'stop' })
  await session.connect()
  await settle()
  session.setConfig({ ...config, closePolicy: 'keep' })
  await settle()
  assert.equal(link.calls.at(-1), 'lease 0')
  assert.equal(session.snapshot().link.leased, false)
  assert.equal(timers.pending.size, 0)
  session.setConfig({ ...config, closePolicy: 'stop' })
  await settle()
  assert.equal(link.calls.at(-1), 'lease 600', 'and back')
  assert.equal(session.phase, 'ready', 'a policy change never drops the connection')
})

await check('a deliberate disconnect clears the lease: the remote keeps running', async () => {
  const { session, link, timers } = makeSession({ listening: false, logText: `${LAUNCH_LINE}\n`, link: 'active' }, { closePolicy: 'stop' })
  await session.connect()
  await settle()
  await session.disconnect()
  assert.equal(link.calls.at(-1), 'lease 0')
  assert.equal(timers.pending.size, 0)
  assert.equal(session.snapshot().link.status, 'unavailable')
})

await check('a reconnecting disconnect keeps the lease, and the next connect renews it', async () => {
  const { session, link } = makeSession({ listening: false, logText: `${LAUNCH_LINE}\n`, link: 'active' }, { closePolicy: 'stop' })
  await session.connect()
  await settle()
  await session.disconnect('reconnecting', { keepLease: true })
  assert.equal(link.calls.includes('lease 0'), false)
  await session.connect()
  await settle()
  assert.equal(session.reused, true, 'the same remote process')
  assert.deepEqual(link.calls.slice(-2), ['hello 3080 1', 'lease 600'])
})

await check('exit under "stop" releases through the plugin before the ssh stop', async () => {
  const { session, link, state } = makeSession({ listening: false, logText: `${LAUNCH_LINE}\n`, link: 'active' }, { closePolicy: 'stop' })
  await session.connect()
  await settle()
  const before = state.calls.length
  await session.shutdown('the app is quitting')
  assert.equal(link.calls.at(-1), 'release')
  assert.equal(link.calls.includes('lease 0'), false, 'no pointless disarm of a harness that is stopping')
  assert.equal(state.calls.slice(before).some((c) => c.includes('KILLED=')), true, 'the ssh stop still runs')
})

await check('exit under "keep" neither releases nor stops', async () => {
  const { session, link, state } = makeSession({ listening: false, logText: `${LAUNCH_LINE}\n`, link: 'active' })
  await session.connect()
  await settle()
  const before = state.calls.length
  await session.shutdown('the app is quitting')
  assert.equal(link.calls.includes('release'), false)
  assert.equal(state.calls.slice(before).some((c) => c.includes('KILLED=')), false)
})

await check('a dropped forward stops the renewals', async () => {
  const { session, state, timers } = makeSession({ listening: false, logText: `${LAUNCH_LINE}\n`, link: 'active' }, { closePolicy: 'stop' })
  await session.connect()
  await settle()
  assert.equal(timers.pending.size, 1)
  state.dropHandler?.(new Error('the ssh forward exited (code 255)'))
  assert.equal(timers.pending.size, 0)
})

await check('the snapshot shows the link but never the secret', async () => {
  const { session } = makeSession({ listening: false, logText: `${LAUNCH_LINE}\n`, link: 'active' }, { closePolicy: 'stop' })
  await session.connect()
  await settle()
  const text = JSON.stringify(session.snapshot())
  assert.equal(text.includes(session.linkSecret), false)
  assert.match(text, /"link":\{"status":"active","leased":true,"plugin":"0.1.0"/)
})

if (failures > 0) {
  console.error(`\n${String(failures)} session test(s) failed`)
  process.exit(1)
}
console.log('\nall session tests passed')
