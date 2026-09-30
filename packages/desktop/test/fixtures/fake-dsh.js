/**
 * A fake transport plus a fake `dsh web`, for the smoke test.
 *
 * The transport answers the commands @dsh-ssh/core issues as if a server were
 * there; its "forward" is a local HTTP server that authenticates the way the
 * real harness does (upstream browser-auth.ts): `GET /?token=<t>` answers 303
 * to `./` and sets a `Max-Age` cookie, a request carrying that cookie gets the
 * UI, anything else gets 401.
 *
 * Every request is appended to $FAKE_DSH_LOG so the test can see exactly what
 * the window sent.
 */
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'

const TOKEN = 'fake-launch-token'
const COOKIE = 'dsh-auth-fake=v1.signed'

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false, truncated: false })

function record(line) {
  const file = process.env.FAKE_DSH_LOG
  if (file) appendFileSync(file, `${line}\n`)
}

export function createTransport(config) {
  /** @type {import('node:http').Server | undefined} */
  let server
  return {
    async connect() {},
    async exec(command) {
      if (command.includes('echo ok')) return ok('ok\n')
      if (command.includes('KILLED=')) return ok('FREE\nKILLED=yes\n')
      if (command.includes('rd_listen()')) return ok('DSH=/usr/bin/dsh\nWORKSPACE=yes\nPROFILE=yes\nNODE=v24\nFREE\n')
      if (command.includes('printf "STARTED=')) return ok('STARTED=nohup\n')
      if (command.includes('tail -n')) return ok(`dsh web: http://127.0.0.1:${String(config.remotePort)}/?token=${TOKEN}\n`)
      return ok()
    },
    async startTunnel(remotePort, localPort) {
      const port = localPort === 0 ? remotePort : localPort
      server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://x')
        const hasCookie = (req.headers.cookie ?? '').split(';').some((c) => c.trim() === COOKIE)
        let status
        if (url.pathname === '/' && url.searchParams.get('token') === TOKEN) {
          status = 303
          res.writeHead(303, {
            location: './',
            'cache-control': 'no-store',
            'set-cookie': `${COOKIE}; Max-Age=86400; Path=/; HttpOnly; SameSite=Strict`,
          })
          res.end()
        } else if (url.pathname === '/' && hasCookie) {
          status = 200
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          res.end('<!doctype html><title>Fake DSH</title><p>authenticated</p>')
        } else if (url.pathname === '/') {
          status = 401
          res.writeHead(401, { 'content-type': 'text/plain' })
          res.end('dsh web authentication required\n')
        } else {
          status = 404
          res.writeHead(404)
          res.end()
        }
        record(`${req.method} ${url.searchParams.has('token') ? '/?token' : url.pathname} ${String(status)}`)
      })
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', resolve)
      })
      return { localPort: port }
    },
    get forward() {
      return server === undefined ? null : { localPort: config.localPort, active: 1, total: 0 }
    },
    dispose() {
      server?.close()
      server?.closeAllConnections?.()
      server = undefined
    },
  }
}
