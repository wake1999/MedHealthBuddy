/**
 * The connection store: an injected directory, atomic writes, and a record
 * shape that can never carry credential material.
 *
 * Replaces the old plugin's merge test, whose subject — keeping a stored
 * password across a blank form field — no longer exists: nothing secret is
 * stored at all.
 *
 * Run: node test/store.js
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore, normalize, STORE_FILE, validate } from '../lib/config.js'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-ssh-store-'))

let failures = 0
const check = (label, fn) => {
  try {
    fn()
    console.log(`ok   ${label}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${label}\n     ${error instanceof Error ? error.message : error}`)
  }
}

/** A fresh store in its own subdirectory, so cases cannot see each other. */
let n = 0
const freshStore = () => createStore({ dir: join(scratch, String(n++)) })

const devbox = {
  name: 'devbox',
  target: 'devbox',
  remoteWorkspace: '/home/dev/work',
  remoteProfile: 'web',
  remotePort: 3080,
  localPort: 3080,
}

check('the store lives in the directory the caller names, and nowhere else', () => {
  const dir = join(scratch, 'injected')
  const store = createStore({ dir })
  assert.equal(store.path, join(dir, STORE_FILE))
  store.save([devbox])
  assert.deepEqual(readdirSync(dir), [STORE_FILE], 'no temp file may be left behind')
})

check('createStore refuses to guess a directory', () => {
  assert.throws(() => createStore({}), /directory/)
  assert.throws(() => createStore({ dir: '' }), /directory/)
})

check('a missing store is an empty list', () => {
  assert.deepEqual(freshStore().load(), [])
})

check('a round trip keeps every field and assigns an id', () => {
  const store = freshStore()
  const [saved] = store.save([devbox])
  assert.match(saved.id, /^[0-9a-f]{12}$/)
  const [back] = store.load()
  assert.deepEqual(back, saved)
  assert.equal(back.target, 'devbox')
  assert.equal(back.remoteWorkspace, '/home/dev/work')
  assert.equal(back.closePolicy, 'keep')
  assert.equal(validate(back), undefined)
})

check('ids are stable across saves', () => {
  const store = freshStore()
  const [first] = store.save([devbox])
  const [second] = store.save([{ ...first, remotePort: 4444 }])
  assert.equal(second.id, first.id)
  assert.equal(store.load()[0].remotePort, 4444)
})

check('duplicate ids are split, so two servers never share a partition', () => {
  const store = freshStore()
  const saved = store.save([{ ...devbox, id: 'same' }, { ...devbox, id: 'same', target: 'other' }])
  assert.equal(saved[0].id, 'same')
  assert.notEqual(saved[1].id, 'same')
})

check('nothing credential-shaped reaches the file', () => {
  const store = freshStore()
  store.save([{ ...devbox, password: 'hunter2', passphrase: 'pp', keyPath: '~/.ssh/shared.key' }])
  const text = readFileSync(store.path, 'utf8')
  assert.equal(text.includes('hunter2'), false)
  assert.equal(text.includes('"pp"'), false)
  assert.equal(text.includes('shared.key'), false)
})

check('a corrupt or foreign-version file degrades to an empty list', () => {
  const store = freshStore()
  store.save([devbox])
  writeFileSync(store.path, '{ not json')
  assert.deepEqual(store.load(), [])
  writeFileSync(store.path, JSON.stringify({ version: 99, connections: [devbox] }))
  assert.deepEqual(store.load(), [])
})

check('clear removes the file and reports whether it did', () => {
  const store = freshStore()
  assert.equal(store.clear(), false)
  store.save([devbox])
  assert.equal(store.clear(), true)
  assert.equal(existsSync(store.path), false)
})

check('a numeric string from a form input is coerced, not rejected', () => {
  // A form sends input values as strings; a rejected coercion would silently
  // reset the port to its default.
  const merged = normalize({ ...devbox, remotePort: '4444', localPort: '4444' })
  assert.equal(merged.remotePort, 4444)
  assert.equal(merged.localPort, 4444)
})

check('an out-of-range port falls back to the default rather than staying invalid', () => {
  assert.equal(normalize({ ...devbox, remotePort: '99999' }).remotePort, 3080)
})

rmSync(scratch, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\n${String(failures)} store test(s) failed`)
  process.exit(1)
}
console.log('\nall store tests passed')
