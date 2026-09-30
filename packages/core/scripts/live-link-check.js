/**
 * M2 acceptance against a real server with dsh-desktop-link installed.
 *
 *  A. crash fallback: under close policy "stop", arm a short lease, then die
 *     the way a killed app dies — no release, no lease clear, renewals just
 *     stop and the forward goes — and check the remote stops itself.
 *  B. clean exit: under "stop", quit normally and check the plugin's release
 *     stopped the remote.
 *
 * Uses its own remote port (default 3181), so a harness on 3080 is left alone.
 *
 * Run:
 *   node scripts/live-link-check.js --target devbox --workspace <remote dir> [--profile web] [--port 3181] [--ttl 60]
 */
import { parseArgs } from 'node:util'

import { RemoteSession, normalize, probe, validate } from '../lib/index.js'
import { SystemSshTransport } from '../lib/transports.js'

const { values } = parseArgs({
  options: {
    target: { type: 'string' },
    workspace: { type: 'string' },
    profile: { type: 'string', default: 'web' },
    port: { type: 'string', default: '3181' },
    ttl: { type: 'string', default: '60' },
    only: { type: 'string' },
  },
})

const config = normalize({
  id: 'live-link',
  target: values.target,
  remoteWorkspace: values.workspace,
  remoteProfile: values.profile,
  remotePort: values.port,
  closePolicy: 'stop',
})
const ttl = Number.parseInt(values.ttl ?? '60', 10)
const problem = validate(config)
if (problem !== undefined || !Number.isInteger(ttl) || ttl < 30) {
  console.error(`invalid arguments: ${problem ?? 'ttl must be an integer >= 30'}`)
  process.exit(2)
}

const started = Date.now()
const stamp = () => `[${String(Math.round((Date.now() - started) / 1000)).padStart(4)}s]`
const say = (line) => { console.log(`${stamp()} ${line}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Mirror a session's log as it grows. */
function follow(session, label) {
  let shown = 0
  const pump = setInterval(() => {
    const lines = session.log.lines
    for (; shown < lines.length; shown += 1) {
      if (!lines[shown].includes('waiting for the remote URL')) say(`${label} ${lines[shown]}`)
    }
  }, 250)
  return () => { clearInterval(pump) }
}

/** Whether the remote port is still held, asked over a fresh ssh connection. */
async function remoteListening() {
  const transport = new SystemSshTransport(config)
  await transport.connect()
  try {
    return (await probe(transport, config)).listening
  } finally {
    transport.dispose()
  }
}

/** Wait until the link is active and the lease armed, or give up. */
async function awaitLease(session, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const link = session.snapshot().link
    if (link.status === 'active' && link.leased) return link
    if (link.status === 'absent' || link.status === 'incompatible') {
      throw new Error(`the server plugin did not answer: ${String(link.status)} — ${String(link.detail)}`)
    }
    await sleep(250)
  }
  throw new Error('the lease was not armed in time')
}

let failed = false
const fail = (message) => { failed = true; console.error(`\nFAILED: ${message}`) }

// ---------------------------------------------------------------- A: crash
if (values.only === undefined || values.only === 'crash') {
  say(`== A. crash fallback (lease ${String(ttl)}s)`)
  // Renewals go through these timers; "crashing" switches them off.
  let alive = true
  const timers = {
    setTimeout: (fn, ms) => setTimeout(() => { if (alive) fn() }, ms),
    clearTimeout: (handle) => { clearTimeout(handle) },
  }
  const session = new RemoteSession({ ...config }, { leaseTtlSec: ttl, timers })
  const stop = follow(session, 'A')
  try {
    await session.connect()
    if (session.phase !== 'ready') throw new Error(`connect ended in ${session.phase}: ${session.message}`)
    const link = await awaitLease(session, 20_000)
    say(`A link active (server plugin ${String(link.plugin)}), lease armed`)
    // Die: no release, no lease clear. Renewals stop and the forward goes.
    alive = false
    session.transport?.dispose()
    say(`A "crashed"; waiting ${String(ttl)}s + 25s for the lease to run out`)
    await sleep((ttl + 25) * 1000)
    const listening = await remoteListening()
    say(`A remote port ${values.port} after the lease: ${listening ? 'STILL LISTENING' : 'free'}`)
    if (listening) fail('the remote did not stop itself after the lease ran out')
  } catch (error) {
    fail(`A: ${error instanceof Error ? error.message : String(error)}`)
    await session.stop().catch(() => {})
  } finally {
    stop()
  }
}

// ---------------------------------------------------------------- B: exit
if (!failed && (values.only === undefined || values.only === 'exit')) {
  say('== B. clean exit under "stop"')
  const session = new RemoteSession({ ...config }, { leaseTtlSec: ttl })
  const stop = follow(session, 'B')
  try {
    await session.connect()
    if (session.phase !== 'ready') throw new Error(`connect ended in ${session.phase}: ${session.message}`)
    await awaitLease(session, 20_000)
    await session.shutdown('live check: the app is quitting')
    const released = session.log.lines.some((l) => l.includes('released; the remote harness is stopping itself'))
    if (!released) fail('shutdown did not go through the plugin release')
    await sleep(3_000)
    const listening = await remoteListening()
    say(`B remote port ${values.port} after exit: ${listening ? 'STILL LISTENING' : 'free'}`)
    if (listening) fail('the remote is still running after a "stop" exit')
  } catch (error) {
    fail(`B: ${error instanceof Error ? error.message : String(error)}`)
    await session.stop().catch(() => {})
  } finally {
    stop()
  }
}

console.log(failed ? '\nM2 live check failed' : '\nM2 live check passed')
process.exit(failed ? 1 : 0)
