/**
 * The link's routes over real HTTP, with a fake clock for the watchdog.
 *
 * Run: node test/link.js
 */
import { strict as assert } from 'node:assert'
import { createServer, request } from 'node:http'

import { PATHS, SECRET_HEADER, createLink, isLoopbackAddress } from '../lib/link.js'

const SECRET = 'ab'.repeat(32)

let failures = 0
const check = async (label, fn) => {
  try {
    await fn()
    console.log(`ok   ${label}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${label}\n     ${error instanceof Error ? error.stack : error}`)
  }
}

/** A link on a real loopback server, with timers the test fires by hand. */
async function mount(...args) {
  // Not a default parameter: `mount(undefined)` must mean "no secret".
  const secret = args.length === 0 ? SECRET : args[0]
  /** @type {Map<number, { fn: () => void, ms: number }>} */
  const timers = new Map()
  let nextTimer = 1
  let terminated = 0
  const link = createLink({
    secret,
    version: '9.9.9',
    terminate: () => { terminated += 1 },
    setTimer: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id },
    clearTimer: (id) => { timers.delete(/** @type {number} */ (id)) },
  })
  const server = createServer((req, res) => {
    const handler = link.handlers[new URL(req.url ?? '/', 'http://x').pathname]
    if (handler === undefined) { res.writeHead(404); res.end(); return }
    void handler(req, res)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port
  return {
    link,
    timers,
    terminated: () => terminated,
    fire: async (predicate = () => true) => {
      for (const [id, t] of [...timers]) if (predicate(t)) { timers.delete(id); t.fn() }
      await new Promise((r) => setTimeout(r, 10))
    },
    call: (method, path, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        let text = ''
        res.on('data', (c) => { text += c })
        res.on('end', () => {
          let json
          try { json = JSON.parse(text) } catch { /* not json */ }
          resolve({ status: res.statusCode, text, json })
        })
      })
      req.on('error', reject)
      if (body !== undefined) req.end(typeof body === 'string' ? body : JSON.stringify(body))
      else req.end()
    }),
    close: () => new Promise((r) => server.close(r)),
  }
}

const auth = { [SECRET_HEADER]: SECRET }

await check('hello answers the owning desktop with the protocol and capabilities', async () => {
  const m = await mount()
  const r = await m.call('GET', PATHS.hello, { headers: auth })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { protocol: 1, plugin: '9.9.9', capabilities: ['lease', 'release', 'events'], lease: null })
  await m.close()
})

await check('without the secret header every route is a bare 404', async () => {
  const m = await mount()
  for (const [method, path] of [['GET', PATHS.hello], ['POST', PATHS.lease], ['POST', PATHS.release], ['GET', `${PATHS.events}?after=0`]]) {
    const r = await m.call(method, path, { body: method === 'POST' ? { ttlSec: 60 } : undefined })
    assert.equal(r.status, 404, `${method} ${path}`)
    assert.equal(r.text, 'Not Found\n', 'the refusal must not reveal the route exists')
  }
  assert.equal(m.timers.size, 0)
  assert.equal(m.terminated(), 0)
  await m.close()
})

await check('a wrong secret, or one of a different length, is the same 404', async () => {
  const m = await mount()
  for (const presented of ['cd'.repeat(32), 'ab'.repeat(31), '', `${SECRET}x`]) {
    const r = await m.call('GET', PATHS.hello, { headers: { [SECRET_HEADER]: presented } })
    assert.equal(r.status, 404, JSON.stringify(presented))
  }
  await m.close()
})

await check('a process started without a secret keeps every route closed, even to a guess', async () => {
  for (const secret of [undefined, '', 'short', 'AB'.repeat(32), `${'a'.repeat(64)}; rm -rf ~`]) {
    const m = await mount(secret)
    assert.equal(m.link.active, false)
    const r = await m.call('GET', PATHS.hello, { headers: { [SECRET_HEADER]: typeof secret === 'string' ? secret : '' } })
    assert.equal(r.status, 404, String(secret))
    await m.close()
  }
})

await check('a trusted wrong method is a 405, not a 404', async () => {
  const m = await mount()
  const r = await m.call('POST', PATHS.hello, { headers: auth })
  assert.equal(r.status, 405)
  await m.close()
})

await check('no lease, no watchdog: the harness is never stopped on its own', async () => {
  const m = await mount()
  await m.call('GET', PATHS.hello, { headers: auth })
  assert.equal(m.timers.size, 0)
  await m.fire()
  assert.equal(m.terminated(), 0)
  await m.close()
})

await check('a lease arms the watchdog, and expiry stops the harness once', async () => {
  const m = await mount()
  const r = await m.call('POST', PATHS.lease, { headers: auth, body: { ttlSec: 600 } })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { ok: true, ttlSec: 600, armed: true })
  assert.deepEqual([...m.timers.values()].map((t) => t.ms), [600_000])
  const hello = await m.call('GET', PATHS.hello, { headers: auth })
  assert.equal(hello.json.lease.expiresInSec, 600)
  await m.fire()
  assert.equal(m.terminated(), 1)
  assert.equal(m.link.state().stopping, true)
  await m.close()
})

await check('renewing replaces the watchdog instead of stacking another', async () => {
  const m = await mount()
  await m.call('POST', PATHS.lease, { headers: auth, body: { ttlSec: 600 } })
  await m.call('POST', PATHS.lease, { headers: auth, body: { ttlSec: 600 } })
  await m.call('POST', PATHS.lease, { headers: auth, body: { ttlSec: 120 } })
  assert.deepEqual([...m.timers.values()].map((t) => t.ms), [120_000])
  await m.close()
})

await check('ttlSec 0 disarms: the user chose to leave the remote running', async () => {
  const m = await mount()
  await m.call('POST', PATHS.lease, { headers: auth, body: { ttlSec: 600 } })
  const r = await m.call('POST', PATHS.lease, { headers: auth, body: { ttlSec: 0 } })
  assert.deepEqual(r.json, { ok: true, ttlSec: 0, armed: false })
  assert.equal(m.timers.size, 0)
  await m.fire()
  assert.equal(m.terminated(), 0)
  await m.close()
})

await check('an out-of-range or malformed lease is refused and changes nothing', async () => {
  const m = await mount()
  await m.call('POST', PATHS.lease, { headers: auth, body: { ttlSec: 600 } })
  for (const body of [{ ttlSec: 5 }, { ttlSec: 7200 }, { ttlSec: 60.5 }, { ttlSec: '600' }, {}, 'not json', '[1]']) {
    const r = await m.call('POST', PATHS.lease, { headers: auth, body })
    assert.equal(r.status, 400, JSON.stringify(body))
  }
  assert.deepEqual([...m.timers.values()].map((t) => t.ms), [600_000], 'the existing lease stands')
  await m.close()
})

await check('an oversized body is refused', async () => {
  const m = await mount()
  const r = await m.call('POST', PATHS.lease, { headers: auth, body: JSON.stringify({ ttlSec: 600, pad: 'x'.repeat(10_000) }) })
    .catch(() => ({ status: 'reset' }))
  assert.ok(r.status === 400 || r.status === 'reset', `got ${String(r.status)}`)
  assert.equal(m.timers.size, 0)
  await m.close()
})

await check('release answers first, then stops the harness', async () => {
  const m = await mount()
  await m.call('POST', PATHS.lease, { headers: auth, body: { ttlSec: 600 } })
  const r = await m.call('POST', PATHS.release, { headers: auth })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { ok: true, stopping: true })
  assert.equal(m.terminated(), 0, 'not before the reply is out')
  await m.fire((t) => t.ms === 50)
  assert.equal(m.terminated(), 1)
  assert.equal(m.timers.size, 0, 'the lease watchdog is gone too')
  await m.close()
})

await check('dispose clears an armed watchdog', async () => {
  const m = await mount()
  await m.call('POST', PATHS.lease, { headers: auth, body: { ttlSec: 600 } })
  m.link.dispose()
  assert.equal(m.timers.size, 0)
  await m.close()
})

// ------------------------------------------------------------ task feed

const TASK = { sessionId: 's1', title: 't', outcome: 'completed', at: 5 }
const events = (query) => `${PATHS.events}?${new URLSearchParams(query).toString()}`

await check('the first poll (no instance) only learns the instance and cursor', async () => {
  const m = await mount()
  m.link.publish(TASK)
  const r = await m.call('GET', events({ after: '0', waitMs: '25000' }), { headers: auth })
  assert.equal(r.status, 200)
  assert.equal(typeof r.json.instance, 'string')
  assert.equal(r.json.cursor, 1)
  assert.equal(r.json.reset, true)
  assert.deepEqual(r.json.events, [], 'no backlog without a matching instance')
  assert.equal(m.timers.size, 0, 'and no wait either')
  await m.close()
})

await check('a poll with the instance gets what is newer than its cursor', async () => {
  const m = await mount()
  const { json: first } = await m.call('GET', events({ after: '0' }), { headers: auth })
  m.link.publish(TASK)
  m.link.publish({ ...TASK, sessionId: 's2' })
  const r = await m.call('GET', events({ instance: first.instance, after: '1', waitMs: '25000' }), { headers: auth })
  assert.deepEqual(r.json.events, [{ ...TASK, sessionId: 's2', id: 2 }])
  assert.equal(r.json.cursor, 2)
  await m.close()
})

await check('an empty poll waits, and a publish answers it at once', async () => {
  const m = await mount()
  const { json: first } = await m.call('GET', events({ after: '0' }), { headers: auth })
  const pending = m.call('GET', events({ instance: first.instance, after: '0', waitMs: '25000' }), { headers: auth })
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual([...m.timers.values()].map((t) => t.ms), [25_000])
  assert.equal(m.link.state().waiting, 1)
  m.link.publish(TASK)
  const r = await pending
  assert.deepEqual(r.json.events, [{ ...TASK, id: 1 }])
  assert.equal(m.timers.size, 0, 'the wait timer is cleared')
  assert.equal(m.link.state().waiting, 0)
  await m.close()
})

await check('an empty poll answers empty when its wait runs out, capped at 30s', async () => {
  const m = await mount()
  const { json: first } = await m.call('GET', events({ after: '0' }), { headers: auth })
  const pending = m.call('GET', events({ instance: first.instance, after: '0', waitMs: '999999' }), { headers: auth })
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual([...m.timers.values()].map((t) => t.ms), [30_000])
  await m.fire()
  const r = await pending
  assert.deepEqual(r.json.events, [])
  assert.equal(r.json.cursor, 0)
  await m.close()
})

await check('a cursor from another process, or from the future, resets to now', async () => {
  const m = await mount()
  m.link.publish(TASK)
  const { json: first } = await m.call('GET', events({ after: '0' }), { headers: auth })
  for (const query of [{ instance: 'someone-else', after: '0' }, { instance: first.instance, after: '9' }, { instance: first.instance, after: '-1' }]) {
    const r = await m.call('GET', events(query), { headers: auth })
    assert.equal(r.json.reset, true, JSON.stringify(query))
    assert.deepEqual(r.json.events, [])
    assert.equal(r.json.cursor, 1)
  }
  await m.close()
})

await check('the feed keeps only the latest 50 tasks', async () => {
  const m = await mount()
  const { json: first } = await m.call('GET', events({ after: '0' }), { headers: auth })
  for (let i = 0; i < 60; i += 1) m.link.publish({ ...TASK, sessionId: `s${String(i)}` })
  const r = await m.call('GET', events({ instance: first.instance, after: '0' }), { headers: auth })
  assert.equal(r.json.events.length, 50)
  assert.equal(r.json.events[0].id, 11)
  await m.close()
})

await check('without a secret nothing is recorded', async () => {
  const m = await mount(undefined)
  m.link.publish(TASK)
  assert.equal(m.link.state().events, 0)
  await m.close()
})

await check('dispose answers every waiting poll', async () => {
  const m = await mount()
  const { json: first } = await m.call('GET', events({ after: '0' }), { headers: auth })
  const pending = m.call('GET', events({ instance: first.instance, after: '0', waitMs: '25000' }), { headers: auth })
  await new Promise((r) => setTimeout(r, 30))
  m.link.dispose()
  const r = await pending
  assert.equal(r.status, 200)
  assert.equal(m.link.state().waiting, 0)
  await m.close()
})

await check('loopback detection accepts 127/8, ::1 and mapped IPv4 only', () => {
  for (const ok of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopbackAddress(ok), true, ok)
  for (const bad of ['10.0.0.1', '::ffff:10.0.0.1', '128.0.0.1', '127.0.0.256', 'localhost', '', undefined]) {
    assert.equal(isLoopbackAddress(bad), false, String(bad))
  }
})

if (failures > 0) {
  console.error(`\n${String(failures)} link test(s) failed`)
  process.exit(1)
}
console.log('\nall link tests passed')
