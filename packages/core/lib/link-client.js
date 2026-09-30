/**
 * The desktop half of the desktop link: talks to the dsh-desktop-link plugin
 * on the server, through the local forward, with the secret the desktop
 * injected when it started that harness.
 *
 * Every outcome other than a well-formed handshake of the expected protocol is
 * a downgrade, never an error the user has to deal with: a server without the
 * plugin (404, or the web app answering in its place), a harness this app run
 * did not start (its secret is unknown, so 404 too), an older or newer plugin.
 *
 * @module @dsh-ssh/core/link-client
 */

import { request } from 'node:http'

/** The protocol major version this desktop speaks. */
export const LINK_PROTOCOL = 1

const API_BASE = '/api/dsh-desktop-link'
const SECRET_HEADER = 'x-dsh-desktop-secret'

/** Keep link calls short: they ride a forward that may be dying. */
const DEFAULT_TIMEOUT_MS = 5_000

/**
 * One request to the plugin.
 * @param {{ port: number, secret: string, method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs?: number, signal?: AbortSignal }} options
 * @returns {Promise<{ status: number, json: any }>}
 */
export function linkRequest(options) {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
    const req = request({
      host: '127.0.0.1',
      port: options.port,
      path: `${API_BASE}/${options.path}`,
      method: options.method,
      signal: options.signal,
      headers: {
        [SECRET_HEADER]: options.secret,
        accept: 'application/json',
        ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
      },
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        text += chunk
        // A misrouted request can land on a large page; stop reading it.
        if (text.length > 64 * 1024) req.destroy(new Error('response too large'))
      })
      res.on('end', () => {
        let json
        try { json = JSON.parse(text) } catch { json = undefined }
        resolve({ status: res.statusCode ?? 0, json })
      })
    })
    req.on('timeout', () => { req.destroy(new Error('the desktop link timed out')) })
    req.on('error', reject)
    req.end(payload)
  })
}

/**
 * @typedef {{ status: 'active', plugin: string, capabilities: string[] }
 *   | { status: 'absent', reason: string }
 *   | { status: 'incompatible', reason: string }} Handshake
 */

/**
 * Shake hands with the plugin.
 * @param {{ port: number, secret: string, timeoutMs?: number }} target
 * @returns {Promise<Handshake>}
 */
export async function hello(target) {
  let reply
  try {
    reply = await linkRequest({ ...target, method: 'GET', path: 'hello' })
  } catch (error) {
    return { status: 'absent', reason: `no answer: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (reply.status === 404) {
    return { status: 'absent', reason: 'not installed on the server, or this harness was not started by this app' }
  }
  const body = reply.json
  if (reply.status !== 200 || typeof body !== 'object' || body === null || typeof body.protocol !== 'number') {
    return { status: 'absent', reason: `unexpected answer (HTTP ${String(reply.status)})` }
  }
  if (body.protocol !== LINK_PROTOCOL) {
    return { status: 'incompatible', reason: `the server plugin speaks protocol ${String(body.protocol)}, this app speaks ${String(LINK_PROTOCOL)}` }
  }
  return {
    status: 'active',
    plugin: typeof body.plugin === 'string' ? body.plugin : 'unknown',
    capabilities: Array.isArray(body.capabilities) ? body.capabilities.filter((c) => typeof c === 'string') : [],
  }
}

/**
 * Arm (ttlSec > 0), renew, or disarm (ttlSec 0) the plugin's watchdog.
 * @param {{ port: number, secret: string, timeoutMs?: number }} target
 * @param {number} ttlSec
 */
export async function lease(target, ttlSec) {
  const reply = await linkRequest({ ...target, method: 'POST', path: 'lease', body: { ttlSec } })
  if (reply.status !== 200 || reply.json?.ok !== true) {
    throw new Error(`lease refused (HTTP ${String(reply.status)}): ${String(reply.json?.error ?? '')}`)
  }
}

/**
 * Ask the plugin to stop its harness now.
 * @param {{ port: number, secret: string, timeoutMs?: number }} target
 */
export async function release(target) {
  const reply = await linkRequest({ ...target, method: 'POST', path: 'release' })
  if (reply.status !== 200) throw new Error(`release refused (HTTP ${String(reply.status)})`)
}

/** What a finished-task feed item may say; anything else is dropped. */
const OUTCOMES = new Set(['completed', 'error', 'blocked'])

/**
 * @typedef {{ sessionId: string, title: string, outcome: 'completed' | 'error' | 'blocked', at: number }} TaskEvent
 */

/**
 * Keep only well-formed feed items, trimmed to what a notification shows. The
 * server is ours, but it answers over a port every local user can reach.
 * @param {unknown} raw
 * @returns {TaskEvent | undefined}
 */
export function taskEvent(raw) {
  if (typeof raw !== 'object' || raw === null) return undefined
  const item = /** @type {Record<string, unknown>} */ (raw)
  if (typeof item.sessionId !== 'string' || item.sessionId === '' || !OUTCOMES.has(/** @type {string} */ (item.outcome))) return undefined
  return {
    sessionId: item.sessionId.slice(0, 200),
    title: typeof item.title === 'string' ? item.title.replace(/\s+/g, ' ').trim().slice(0, 120) : '',
    outcome: /** @type {TaskEvent['outcome']} */ (item.outcome),
    at: typeof item.at === 'number' && Number.isFinite(item.at) ? item.at : Date.now(),
  }
}

/**
 * Long-poll the plugin's finished-task feed.
 * @param {{ port: number, secret: string }} target
 * @param {{ instance?: string, after?: number, waitMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<{ instance: string, cursor: number, reset: boolean, events: TaskEvent[] }>}
 */
export async function events(target, options = {}) {
  const waitMs = options.waitMs ?? 0
  const query = new URLSearchParams({ after: String(options.after ?? 0), waitMs: String(waitMs) })
  if (options.instance !== undefined) query.set('instance', options.instance)
  const reply = await linkRequest({
    ...target,
    method: 'GET',
    path: `events?${query.toString()}`,
    timeoutMs: waitMs + 10_000,
    signal: options.signal,
  })
  const body = reply.json
  if (reply.status !== 200 || typeof body?.instance !== 'string' || !Number.isInteger(body?.cursor)) {
    throw new Error(`events refused (HTTP ${String(reply.status)})`)
  }
  return {
    instance: body.instance,
    cursor: body.cursor,
    reset: body.reset === true,
    events: Array.isArray(body.events) ? body.events.map(taskEvent).filter((e) => e !== undefined) : [],
  }
}

/** The real client, as the session consumes it (tests substitute a fake). */
export const linkClient = { hello, lease, release, events }
