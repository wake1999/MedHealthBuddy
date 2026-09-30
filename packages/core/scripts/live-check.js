/**
 * M0 acceptance against a real server: connect → ready → stop.
 *
 * This starts and then stops a real `dsh web` on the server. It uses its own
 * remote port (default 3181), so a harness already running on 3080 — the old
 * plugin's, or one started by hand — is left alone.
 *
 * Run:
 *   node scripts/live-check.js --target devbox --workspace <remote dir> [--profile web] [--port 3181]
 */
import { request } from 'node:http'
import { parseArgs } from 'node:util'

import { RemoteSession, normalize, validate } from '../lib/index.js'

const { values } = parseArgs({
  options: {
    target: { type: 'string' },
    workspace: { type: 'string' },
    profile: { type: 'string', default: 'web' },
    port: { type: 'string', default: '3181' },
    'keep-running': { type: 'boolean', default: false },
  },
})

const config = normalize({
  id: 'live-check',
  target: values.target,
  remoteWorkspace: values.workspace,
  remoteProfile: values.profile,
  remotePort: values.port,
})
const problem = validate(config)
if (problem !== undefined) {
  console.error(`invalid arguments: ${problem}`)
  console.error('usage: node scripts/live-check.js --target <ssh alias> --workspace <remote dir> [--profile web] [--port 3181]')
  process.exit(2)
}

const session = new RemoteSession(config)
const started = Date.now()
const elapsed = () => `${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s`

// Mirror the session log as it grows, so a minute-long wait is visibly alive.
let shown = 0
const pump = setInterval(() => {
  const lines = session.log.lines
  for (; shown < lines.length; shown += 1) console.log(`[${elapsed()}] ${lines[shown]}`)
}, 250)

/** GET the forwarded root and report the status, without following redirects. */
function statusOf(port) {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/', method: 'GET', timeout: 10_000 }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('timeout', () => { req.destroy(); resolve(0) })
    req.on('error', () => resolve(0))
    req.end()
  })
}

let exitCode = 0
try {
  await session.connect()
  if (session.phase !== 'ready') throw new Error(`connect ended in ${session.phase}: ${session.message}`)
  const snap = session.snapshot()
  const status = await statusOf(Number(snap.localPort))
  console.log(`\n== ready: phase=${snap.phase} reused=${String(snap.reused)} integration=${String(snap.integrationAvailable)}`)
  console.log(`== GET http://127.0.0.1:${String(snap.localPort)}/ through the forward -> HTTP ${String(status)}`)
  if (status === 0) throw new Error('the forward is bound but nothing answered through it')

  if (values['keep-running']) {
    await session.disconnect('live check finished (remote left running)')
  } else {
    await session.stop()
    if (session.phase !== 'stopped') throw new Error(`stop ended in ${session.phase}: ${session.message}`)
    console.log(`== stopped: ${session.message}`)
  }
} catch (error) {
  exitCode = 1
  console.error(`\nFAILED: ${error instanceof Error ? error.message : String(error)}`)
  // Never leave a half-started harness behind on failure.
  if (!values['keep-running']) await session.stop().catch(() => {})
} finally {
  clearInterval(pump)
  for (const line of session.log.lines.slice(shown)) console.log(`[${elapsed()}] ${line}`)
}
console.log(exitCode === 0 ? '\nM0 live check passed' : '\nM0 live check failed')
process.exit(exitCode)
