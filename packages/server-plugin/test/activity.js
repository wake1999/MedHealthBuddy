/**
 * Which session events become finished tasks on the feed.
 *
 * Run: node test/activity.js
 */
import { strict as assert } from 'node:assert'

import { createActivityWatcher } from '../lib/activity.js'

let failures = 0
const check = (label, fn) => {
  try {
    fn()
    console.log(`ok   ${label}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${label}\n     ${error instanceof Error ? error.stack : error}`)
  }
}

/** A watcher plus what it published. */
function watch() {
  /** @type {any[]} */
  const published = []
  return { on: createActivityWatcher((item) => { published.push(item) }), published }
}

const session = (id, header = {}) => ({ id, header: { id, ...header } })
const turnEnd = (kind, time = 42) => ({ type: 'turn/end', seq: 9, time, data: { turn: 1, reason: { kind } } })
const titled = (title) => ({ type: 'session/title', seq: 3, time: 1, data: { title } })

check('a completed turn of a top-level session is published with its title', () => {
  const w = watch()
  w.on(session('s1'), titled('  Fix the build  '))
  w.on(session('s1'), turnEnd('completed'))
  assert.deepEqual(w.published, [{ sessionId: 's1', title: 'Fix the build', outcome: 'completed', at: 42 }])
})

check('error and blocked turns are published; max-tokens counts as completed', () => {
  const w = watch()
  w.on(session('s1'), turnEnd('error'))
  w.on(session('s1'), turnEnd('blocked'))
  w.on(session('s1'), turnEnd('max-tokens'))
  assert.deepEqual(w.published.map((p) => p.outcome), ['error', 'blocked', 'completed'])
})

check('a cancel, a crash closer or a fork seed is not news', () => {
  const w = watch()
  for (const kind of ['aborted', 'interrupted', 'forked', 'something-new']) w.on(session('s1'), turnEnd(kind))
  assert.deepEqual(w.published, [])
})

check('subagent children stay quiet', () => {
  const w = watch()
  w.on(session('c1', { origin: 'subagent' }), turnEnd('completed'))
  w.on(session('c2', { delegationDepth: 1 }), turnEnd('completed'))
  assert.deepEqual(w.published, [])
})

check('other events, and malformed ones, are ignored', () => {
  const w = watch()
  w.on(session('s1'), { type: 'user/message', seq: 1, time: 1, data: { content: 'secret prompt' } })
  w.on(session('s1'), null)
  w.on({}, turnEnd('completed'))
  w.on(session('s1'), { type: 'session/title', data: { title: 7 } })
  assert.deepEqual(w.published, [])
})

check('without a title the item says so with an empty string, and nothing else leaks', () => {
  const w = watch()
  w.on(session('s9'), turnEnd('completed'))
  assert.deepEqual(Object.keys(w.published[0]).sort(), ['at', 'outcome', 'sessionId', 'title'])
  assert.equal(w.published[0].title, '')
})

check('titles are bounded in length and in number', () => {
  const w = watch()
  w.on(session('s1'), titled('x'.repeat(500)))
  w.on(session('s1'), turnEnd('completed'))
  assert.equal(w.published[0].title.length, 120)
  for (let i = 0; i < 250; i += 1) w.on(session(`n${String(i)}`), titled(`t${String(i)}`))
  w.on(session('n0'), turnEnd('completed'))
  w.on(session('n249'), turnEnd('completed'))
  assert.equal(w.published[1].title, '', 'the oldest title was dropped')
  assert.equal(w.published[2].title, 't249')
})

if (failures > 0) {
  console.error(`\n${String(failures)} activity test(s) failed`)
  process.exit(1)
}
console.log('\nall activity tests passed')
