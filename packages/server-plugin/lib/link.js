/**
 * The server half of the desktop link: handshake, lease and release.
 *
 * Everything here is inert until the desktop that started this harness talks
 * to it, and it only ever talks to that desktop:
 *
 *  - The secret arrives in `DSH_DESKTOP_LINK_SECRET`, injected by the desktop
 *    when it started this process (never on a command line). Without one, every
 *    route answers 404 and the plugin does nothing at all — a harness started by
 *    hand is unaffected.
 *  - Every request must carry `X-DSH-Desktop-Secret` equal to it, from a
 *    loopback socket. Anything else gets the same bare 404 as an unknown path,
 *    so the routes cannot even be discovered. The web server itself has no
 *    authentication (upstream dsh-host-webserver: "no server-level TLS,
 *    authentication or origin policy"), and on a shared server every local
 *    user can reach 127.0.0.1:<port>, so loopback alone proves nothing.
 *  - A lease is a watchdog: once armed, the process stops itself unless it is
 *    renewed within `ttlSec`. It is how a "stop the remote on exit" policy
 *    still holds when the desktop is killed or loses the network for good.
 *    `ttlSec: 0` disarms it (the user chose to leave the remote running).
 *  - `release` stops the process now: the desktop is exiting under that policy.
 *  - `events` is a long-poll feed of finished tasks (see ./activity.js), so the
 *    desktop can notify while its window is hidden. It carries session titles
 *    and ids only, never message content.
 *
 * @module dsh-desktop-link/link
 */

import { timingSafeEqual } from 'node:crypto'

/** Protocol major version; the desktop refuses a different one. */
export const PROTOCOL = 1

/** What this server half can do, announced in the handshake. */
export const CAPABILITIES = Object.freeze(['lease', 'release', 'events'])

/** Route base. */
export const API_BASE = '/api/dsh-desktop-link'

export const PATHS = Object.freeze({
  hello: `${API_BASE}/hello`,
  lease: `${API_BASE}/lease`,
  release: `${API_BASE}/release`,
  events: `${API_BASE}/events`,
})

/** Feed bounds: how many finished tasks are kept, and the longest poll. */
export const EVENT_BUFFER = 50
export const MAX_WAIT_MS = 30_000

/** The request header carrying the secret. */
export const SECRET_HEADER = 'x-dsh-desktop-secret'

/** Accepted secret shape: what the desktop generates (32 random bytes, hex). */
const SECRET_PATTERN = /^[0-9a-f]{32,128}$/

/** Lease bounds: at least half a minute, at most an hour. */
export const MIN_TTL_SEC = 30
export const MAX_TTL_SEC = 3600

/** Body cap; the only body is `{ "ttlSec": n }`. */
const MAX_BODY_BYTES = 4096

/**
 * @typedef {object} LinkOptions
 * @property {string | undefined} secret   usually process.env.DSH_DESKTOP_LINK_SECRET.
 * @property {string} version              this plugin's version, for the handshake.
 * @property {() => void} terminate        stop this harness process.
 * @property {(message: string) => void} [log]
 * @property {() => number} [now]
 * @property {(fn: () => void, ms: number) => unknown} [setTimer]
 * @property {(handle: unknown) => void} [clearTimer]
 */

/** Whether a socket address is loopback (127/8, ::1, IPv4-mapped 127/8). */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  const a = address.toLowerCase()
  if (a === '::1') return true
  const v4 = a.startsWith('::ffff:') ? a.slice(7) : a
  const parts = v4.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

/** Constant-time string comparison. */
function sameSecret(a, b) {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * Build the link: its route handlers and its watchdog.
 * @param {LinkOptions} options
 */
export function createLink(options) {
  const log = options.log ?? (() => {})
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? ((fn, ms) => {
    const handle = setTimeout(fn, ms)
    handle.unref?.()
    return handle
  })
  const clearTimer = options.clearTimer ?? ((handle) => { clearTimeout(/** @type {any} */ (handle)) })
  const secret = typeof options.secret === 'string' && SECRET_PATTERN.test(options.secret) ? options.secret : undefined

  /** @type {unknown} */
  let timer
  /** @type {number | undefined} */
  let expiresAt
  let stopping = false

  // ---- finished-task feed. Ids are this process's own counter; `instance`
  // tells the desktop when a different process (a restart) answers instead.
  const instance = `${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  /** @type {{ id: number, [key: string]: unknown }[]} */
  let events = []
  let lastId = 0
  /** @type {Set<() => void>} */
  const waiters = new Set()

  /**
   * Add one finished task to the feed and wake every waiting poll.
   * @param {Record<string, unknown>} item
   */
  const publish = (item) => {
    if (secret === undefined) return
    lastId += 1
    events.push({ ...item, id: lastId })
    if (events.length > EVENT_BUFFER) events = events.slice(-EVENT_BUFFER)
    for (const wake of [...waiters]) wake()
  }

  /** What a poll after `after` gets; a foreign or future cursor starts from now. */
  const feed = (after, sameInstance) => {
    if (!sameInstance || after > lastId) return { instance, cursor: lastId, events: [], reset: true }
    return { instance, cursor: lastId, events: events.filter((e) => e.id > after) }
  }

  const disarm = () => {
    if (timer !== undefined) clearTimer(timer)
    timer = undefined
    expiresAt = undefined
  }

  const stop = (reason) => {
    if (stopping) return
    stopping = true
    disarm()
    log(`dsh-desktop-link: stopping this harness (${reason})`)
    options.terminate()
  }

  /**
   * Arm (or re-arm) the watchdog; 0 disarms it.
   * @param {number} ttlSec
   */
  const lease = (ttlSec) => {
    disarm()
    if (ttlSec === 0) {
      log('dsh-desktop-link: lease cleared; this harness keeps running')
      return
    }
    expiresAt = now() + ttlSec * 1000
    timer = setTimer(() => { stop(`no lease renewal within ${String(ttlSec)}s`) }, ttlSec * 1000)
  }

  /** Whether a request comes from the desktop that owns this process. */
  const trusted = (req) => {
    if (secret === undefined) return false
    if (!isLoopbackAddress(req.socket?.remoteAddress)) return false
    const presented = req.headers[SECRET_HEADER]
    return typeof presented === 'string' && sameSecret(presented, secret)
  }

  /** The one refusal: indistinguishable from a path nobody registered. */
  const notFound = (res) => {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end('Not Found\n')
  }

  const json = (res, status, payload) => {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  const readBody = (req) => new Promise((resolve) => {
    /** @type {Buffer[]} */
    const chunks = []
    let size = 0
    let tooLarge = false
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        tooLarge = true
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) { resolve(undefined); return }
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') { resolve({}); return }
      try {
        const parsed = JSON.parse(text)
        resolve(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : undefined)
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', () => { resolve(undefined) })
  })

  /**
   * Wrap a handler with the trust check and a method check. A wrong method from
   * a trusted caller is a 405; an untrusted caller never learns the route exists.
   */
  const route = (method, handler) => async (req, res) => {
    if (!trusted(req)) { notFound(res); return }
    if ((req.method ?? 'GET').toUpperCase() !== method) {
      json(res, 405, { ok: false, error: `use ${method}` })
      return
    }
    await handler(req, res)
  }

  const handlers = {
    [PATHS.hello]: route('GET', (_req, res) => {
      json(res, 200, {
        protocol: PROTOCOL,
        plugin: options.version,
        capabilities: CAPABILITIES,
        lease: expiresAt === undefined ? null : { expiresInSec: Math.max(0, Math.round((expiresAt - now()) / 1000)) },
      })
    }),
    [PATHS.lease]: route('POST', async (req, res) => {
      const body = await readBody(req)
      const ttl = body?.ttlSec
      const valid = Number.isInteger(ttl) && (ttl === 0 || (ttl >= MIN_TTL_SEC && ttl <= MAX_TTL_SEC))
      if (!valid) {
        json(res, 400, { ok: false, error: `ttlSec must be 0 or an integer ${String(MIN_TTL_SEC)}..${String(MAX_TTL_SEC)}` })
        return
      }
      lease(ttl)
      json(res, 200, { ok: true, ttlSec: ttl, armed: ttl !== 0 })
    }),
    [PATHS.release]: route('POST', (_req, res) => {
      json(res, 200, { ok: true, stopping: true })
      // Let the reply reach the desktop before the process goes.
      res.once('finish', () => { setTimer(() => { stop('released by the desktop') }, 50) })
    }),
    // GET events?instance=<id>&after=<n>&waitMs=<ms>. Without a matching
    // instance the answer is just the current cursor (start from now); with
    // one, it is every newer task, waiting up to waitMs for the first.
    [PATHS.events]: route('GET', (req, res) => new Promise((resolve) => {
      const query = new URL(req.url ?? '/', 'http://localhost').searchParams
      const after = Number.parseInt(query.get('after') ?? '', 10)
      const waitMs = Math.min(MAX_WAIT_MS, Math.max(0, Number.parseInt(query.get('waitMs') ?? '0', 10) || 0))
      const same = query.get('instance') === instance && Number.isInteger(after) && after >= 0
      const answer = () => { json(res, 200, feed(same ? after : 0, same)); resolve(undefined) }
      if (!same || lastId > after || waitMs === 0) { answer(); return }
      let done = false
      const finish = () => {
        if (done) return
        done = true
        waiters.delete(finish)
        clearTimer(handle)
        if (!res.writableEnded && !res.destroyed) answer()
        else resolve(undefined)
      }
      const handle = setTimer(finish, waitMs)
      waiters.add(finish)
      res.once('close', finish)
    })),
  }

  return {
    /** Whether this process was started by a desktop (has a usable secret). */
    active: secret !== undefined,
    handlers,
    publish,
    /** Unload: the watchdog must not outlive the plugin, nor a poll the routes. */
    dispose: () => {
      disarm()
      for (const wake of [...waiters]) wake()
    },
    /** For tests and diagnostics. */
    state: () => ({ armed: timer !== undefined, expiresAt, stopping, events: events.length, waiting: waiters.size }),
  }
}
