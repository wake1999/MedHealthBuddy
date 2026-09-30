/**
 * The connection manager: intent ("wanted"), reconnect with backoff after a
 * drop, rebuild on resume, and exit handling — driven by fake sessions and a
 * fake clock, so no timer ever really waits.
 *
 * Run: node test/connections.js
 */
import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'

import { ConnectionManager } from '../src/main/connections.js'

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

/** A session whose connect outcome the test scripts, one result per call. */
class FakeSession extends EventEmitter {
  constructor(config) {
    super()
    this.config = config
    this.phase = 'idle'
    this.message = ''
    this.log = { lines: [], push: (line) => { this.log.lines.push(line) } }
    /** @type {string[]} */
    this.calls = []
    /** @type {Array<'ready' | 'error'>} */
    this.outcomes = []
    this.boundLocalPort = undefined
    this.url = undefined
  }

  #set(phase) {
    this.phase = phase
    this.emit('change')
  }

  async connect() {
    this.calls.push('connect')
    this.#set('connecting')
    const outcome = this.outcomes.shift() ?? 'ready'
    if (outcome === 'ready') {
      this.boundLocalPort = this.config.localPort
      this.url = `http://127.0.0.1:${String(this.config.localPort)}/?token=t`
    }
    this.#set(outcome)
  }

  async disconnect(reason) {
    this.calls.push(`disconnect:${reason ?? ''}`)
    this.boundLocalPort = undefined
    this.#set('stopped')
  }

  async stop() { this.calls.push('stop'); this.#set('stopped') }
  async restart() { this.calls.push('restart'); await this.connect() }
  async shutdown(reason) { this.calls.push(`shutdown:${reason}`); this.#set('stopped') }
  async refreshFromLog() { return { ok: true, message: '' } }
  setConfig(config) { this.calls.push('setConfig'); this.config = config }
  snapshot() { return { phase: this.phase, message: this.message } }

  /** Simulate the forward dying under a live session. */
  drop() {
    this.#set('error')
    this.emit('drop', new Error('the ssh forward exited'))
  }
}

/** Timers that run only when the test says so. */
function fakeTimers() {
  let next = 1
  /** @type {Map<number, { fn: () => void, ms: number }>} */
  const pending = new Map()
  return {
    pending,
    setTimeout: (fn, ms) => { const id = next++; pending.set(id, { fn, ms }); return id },
    clearTimeout: (id) => { pending.delete(id) },
    delays: () => [...pending.values()].map((t) => t.ms),
    async fireAll() {
      const due = [...pending.entries()]
      pending.clear()
      for (const [, t] of due) t.fn()
      // Let the reconnect's awaits settle.
      for (let i = 0; i < 10; i += 1) await Promise.resolve()
    },
  }
}

function memoryStore(initial = []) {
  let list = initial
  let n = 0
  return {
    load: () => list.map((c) => ({ ...c })),
    save: (next) => {
      list = next.map((c) => (c.id === '' ? { ...c, id: `id${String(++n)}` } : c))
      return list.map((c) => ({ ...c }))
    },
  }
}

const DEVBOX = { id: 'devbox', name: 'devbox', target: 'devbox', remoteProfile: 'web', remoteWorkspace: '/w', remotePort: 3080, localPort: 3080, startTimeoutMs: 180000, closePolicy: 'keep' }

function setup(initial = [DEVBOX]) {
  const timers = fakeTimers()
  /** @type {Map<string, FakeSession>} */
  const sessions = new Map()
  const manager = new ConnectionManager({
    store: memoryStore(initial),
    timers,
    createSession: (config) => {
      const session = new FakeSession(config)
      sessions.set(config.id, session)
      return session
    },
  })
  manager.load()
  const readies = []
  manager.on('ready', (id) => readies.push(id))
  return { manager, timers, sessions, readies, session: sessions.get('devbox') }
}

await check('connect marks the connection wanted and reports ready', async () => {
  const { manager, readies, session } = setup()
  await manager.connect('devbox')
  assert.equal(session.phase, 'ready')
  assert.equal(manager.snapshot('devbox').wanted, true)
  assert.deepEqual(readies, ['devbox'])
  assert.equal(manager.boundPort('devbox'), 3080)
})

await check('a failed first connect is not retried', async () => {
  const { manager, timers, session } = setup()
  session.outcomes.push('error')
  await manager.connect('devbox')
  assert.equal(manager.snapshot('devbox').wanted, false)
  assert.equal(timers.pending.size, 0)
})

await check('a drop on a wanted connection reconnects with backoff', async () => {
  const { manager, timers, session, readies } = setup()
  await manager.connect('devbox')
  session.outcomes.push('error', 'error', 'ready')
  session.drop()
  assert.deepEqual(timers.delays(), [1000])
  assert.ok(manager.snapshot('devbox').retryAt !== null)
  await timers.fireAll()
  assert.deepEqual(timers.delays(), [2000], 'second retry doubles')
  await timers.fireAll()
  assert.deepEqual(timers.delays(), [4000])
  await timers.fireAll()
  assert.equal(session.phase, 'ready')
  assert.equal(timers.pending.size, 0)
  assert.equal(manager.snapshot('devbox').retryAt, null)
  assert.deepEqual(readies, ['devbox', 'devbox'], 'the window is told to follow the new forward')
  // Each retry releases the dead local side first.
  assert.equal(session.calls.filter((c) => c.startsWith('disconnect:reconnecting')).length, 3)
})

await check('backoff restarts from 1s after a successful reconnect', async () => {
  const { manager, timers, session } = setup()
  await manager.connect('devbox')
  session.outcomes.push('error', 'ready')
  session.drop()
  await timers.fireAll()
  await timers.fireAll()
  assert.equal(session.phase, 'ready')
  session.drop()
  assert.deepEqual(timers.delays(), [1000])
})

await check('a drop after the user disconnected is ignored', async () => {
  const { manager, timers, session } = setup()
  await manager.connect('devbox')
  await manager.disconnect('devbox')
  session.drop()
  assert.equal(timers.pending.size, 0)
})

await check('disconnect during a pending retry cancels it', async () => {
  const { manager, timers, session } = setup()
  await manager.connect('devbox')
  session.drop()
  assert.equal(timers.pending.size, 1)
  await manager.disconnect('devbox')
  assert.equal(timers.pending.size, 0)
  assert.equal(manager.snapshot('devbox').retryAt, null)
})

await check('stop turns the intent off and never reconnects', async () => {
  const { manager, timers, session } = setup()
  await manager.connect('devbox')
  await manager.stop('devbox')
  session.drop()
  assert.equal(timers.pending.size, 0)
  assert.ok(session.calls.includes('stop'))
})

await check('resume rebuilds every wanted connection at once, and only those', async () => {
  const { manager, timers, sessions } = setup([DEVBOX, { ...DEVBOX, id: 'idle', target: 'idle', remotePort: 3090, localPort: 3090 }])
  await manager.connect('devbox')
  sessions.get('devbox').drop()
  assert.equal(timers.pending.size, 1)
  manager.resume()
  assert.equal(timers.pending.size, 0, 'the pending backoff is replaced by an immediate rebuild')
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  assert.ok(sessions.get('devbox').calls.includes('disconnect:the system resumed from sleep'))
  assert.equal(sessions.get('devbox').phase, 'ready')
  assert.deepEqual(sessions.get('idle').calls, [], 'a connection nobody wanted is left alone')
})

await check('saving a record creates it, gives it an id, and hands the session a copy', async () => {
  const { manager, sessions } = setup([])
  const saved = manager.save({ target: 'devbox', remoteWorkspace: '/w' })
  assert.match(saved.id, /^id\d+$/)
  assert.deepEqual(manager.list().map((c) => c.id), [saved.id])
  const session = sessions.get(saved.id)
  assert.ok(session !== undefined)
  assert.notEqual(session.config, saved, 'the session must not share the stored object')
  manager.save({ ...saved, remoteWorkspace: '/other' })
  assert.ok(session.calls.includes('setConfig'))
  assert.equal(manager.list().length, 1)
})

await check('shutdownAll applies every close policy and cancels retries', async () => {
  const { manager, timers, session } = setup()
  await manager.connect('devbox')
  session.drop()
  await manager.shutdownAll('the app is quitting')
  assert.equal(timers.pending.size, 0)
  assert.ok(session.calls.includes('shutdown:the app is quitting'))
  assert.equal(manager.snapshot('devbox').wanted, false)
})

await check('two servers cannot share a local port; freePort suggests the next one', async () => {
  const { manager } = setup()
  assert.equal(manager.freePort(), 3081)
  assert.throws(() => manager.save({ target: 'test', remoteWorkspace: '/w', remotePort: 3081, localPort: 3080 }), /3080.*devbox.*3081/)
  const second = manager.save({ target: 'test', remoteWorkspace: '/w', remotePort: 3081, localPort: 3081 })
  assert.equal(manager.list().length, 2)
  assert.equal(manager.freePort(), 3082)
  // Saving a record again with its own port is not a clash with itself.
  assert.doesNotThrow(() => manager.save({ ...second, name: 'renamed' }))
})

await check('two servers connect side by side and stay independent', async () => {
  const { manager, sessions } = setup()
  const second = manager.save({ target: 'test', remoteWorkspace: '/w', remotePort: 3081, localPort: 3081 })
  await manager.connect('devbox')
  await manager.connect(second.id)
  assert.equal(manager.boundPort('devbox'), 3080)
  assert.equal(manager.boundPort(second.id), 3081)
  sessions.get('devbox')?.drop()
  assert.equal(manager.snapshot(second.id).phase, 'ready', 'a drop on one leaves the other alone')
})

await check('removing a server disconnects it and forgets it', async () => {
  const { manager, session } = setup()
  await manager.connect('devbox')
  /** @type {string[]} */
  const changes = []
  manager.on('change', (id) => { changes.push(id) })
  await manager.remove('devbox')
  assert.ok(session.calls.includes('disconnect:the connection was removed'))
  assert.deepEqual(manager.list(), [])
  assert.throws(() => manager.snapshot('devbox'), /unknown connection/)
  assert.ok(changes.includes('devbox'))
  // Its session no longer reports into the manager.
  session.drop()
  assert.equal(manager.entries.size, 0)
})

await check('an unknown id is refused', async () => {
  const { manager } = setup()
  await assert.rejects(() => manager.connect('nope'), /unknown connection/)
})

if (failures > 0) {
  console.error(`\n${String(failures)} connection-manager test(s) failed`)
  process.exit(1)
}
console.log('\nall connection-manager tests passed')
