/**
 * Self-test for the pure logic: config normalization and validation, log
 * redaction, launch-URL parsing, shell quoting.
 *
 * Run: node test/selftest.js
 */
import { strict as assert } from 'node:assert'

import { defaults, normalize, validate } from '../lib/config.js'
import { LogRing, redact } from '../lib/log.js'
import { parseLaunchUrl, remoteHomePath, shq } from '../lib/remote.js'

let failures = 0
const test = (label, fn) => {
  try {
    fn()
    console.log(`ok   ${label}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${label}\n     ${error.message}`)
  }
}

test('normalize clamps a bogus port', () => {
  const c = normalize({ remotePort: 'abc', localPort: -1 })
  assert.equal(c.remotePort, 3080)
  assert.equal(c.localPort, 3080)
})

test('normalize defaults localPort to remotePort', () => {
  assert.equal(normalize({ remotePort: 4567 }).localPort, 4567)
})

test('normalize keeps an explicit differing localPort', () => {
  assert.equal(normalize({ remotePort: 3080, localPort: 4000 }).localPort, 4000)
})

test('normalize drops credential fields from an older record shape', () => {
  const c = normalize({
    target: 'devbox',
    password: 'hunter2',
    passphrase: 'pp',
    keyPath: '~/.ssh/id',
    identityFile: '~/.ssh/id',
    transport: 'ssh2',
    host: 'h',
    user: 'u',
    authKind: 'password',
    agentForward: true,
  })
  for (const key of ['password', 'passphrase', 'keyPath', 'identityFile', 'transport', 'host', 'user', 'authKind', 'agentForward']) {
    assert.equal(key in c, false, `${key} must not survive normalization`)
  }
  assert.equal(JSON.stringify(c).includes('hunter2'), false)
})

test('normalize defaults closePolicy to keep and accepts only stop otherwise', () => {
  assert.equal(normalize({}).closePolicy, 'keep')
  assert.equal(normalize({ closePolicy: 'stop' }).closePolicy, 'stop')
  assert.equal(normalize({ closePolicy: 'explode' }).closePolicy, 'keep')
  // The old boolean is not silently reinterpreted.
  assert.equal(normalize({ stopOnClose: true }).closePolicy, 'keep')
})

test('normalize accepts only partition-safe ids', () => {
  assert.equal(normalize({ id: 'abc_12-X' }).id, 'abc_12-X')
  assert.equal(normalize({ id: '../evil' }).id, '')
  assert.equal(normalize({ id: 'has space' }).id, '')
  assert.equal(normalize({ id: 'x'.repeat(65) }).id, '')
})

test('normalize names a connection after its target when unnamed', () => {
  assert.equal(normalize({ target: 'devbox' }).name, 'devbox')
  assert.equal(normalize({ target: 'devbox', name: 'Lab box' }).name, 'Lab box')
})

test('validate reports the fields that block a connection', () => {
  assert.match(validate(defaults()), /destination is required/)
  assert.equal(validate(normalize({ target: 'devbox' })), 'remote workspace directory is required')
  assert.equal(
    validate(normalize({ target: 'devbox', remoteWorkspace: '/srv/w', remoteProfile: 'desktop' })),
    'the remote profile cannot be named "desktop" — the CLI reserves that name for the Electron application',
  )
  assert.equal(validate(normalize({ target: 'devbox', remoteWorkspace: '/srv/w' })), undefined)
  assert.equal(validate(normalize({ target: 'me@example.org', remoteWorkspace: '~/w' })), undefined)
})

test('validate refuses a target ssh would parse as an option', () => {
  // `-oProxyCommand=…` as a destination would run a local command.
  assert.match(String(validate(normalize({ target: '-oProxyCommand=calc', remoteWorkspace: '/w' }))), /leading dash/)
  assert.match(String(validate(normalize({ target: 'devbox extra', remoteWorkspace: '/w' }))), /no spaces/)
  assert.match(String(validate(normalize({ target: 'devbox\u0007', remoteWorkspace: '/w' }))), /no spaces/)
})

test('parseLaunchUrl reads the loopback URL, not the LAN one', () => {
  const log = 'boot\nfoo\ndsh web: http://127.0.0.1:3080/?token=abc123 (LAN: http://10.0.0.5:3080/?token=abc123)\n'
  assert.equal(parseLaunchUrl(log), 'http://127.0.0.1:3080/?token=abc123')
})

test('parseLaunchUrl survives ANSI colour codes', () => {
  const log = '\u001B[32mdsh web:\u001B[0m http://127.0.0.1:3080/?token=deadbeef\n'
  assert.equal(parseLaunchUrl(log), 'http://127.0.0.1:3080/?token=deadbeef')
})

test('parseLaunchUrl returns undefined when absent', () => {
  assert.equal(parseLaunchUrl('nothing here'), undefined)
})

test('redact strips launch tokens from log lines', () => {
  const out = redact('dsh web: http://127.0.0.1:3080/?token=supersecret')
  assert.equal(out.includes('supersecret'), false)
  assert.equal(out.includes('<redacted>'), true)
})

test('redact strips auth cookies', () => {
  const out = redact('set-cookie: dsh-auth-abc=xyz; Path=/')
  assert.equal(out.includes('xyz'), false)
})

test('redact strips the desktop-link secret in both of its spellings', () => {
  const hex = 'ab'.repeat(32)
  assert.equal(redact(`env DSH_DESKTOP_LINK_SECRET=${hex} dsh`).includes(hex), false)
  assert.equal(redact(`X-DSH-Desktop-Secret: ${hex}`).includes(hex), false)
})

test('LogRing bounds its line count and redacts', () => {
  const ring = new LogRing()
  for (let i = 0; i < 500; i += 1) ring.push(`?token=secret${i} line ${i}`)
  assert.equal(ring.lines.length, 400)
  assert.equal(ring.lines.join('').includes('secret'), false)
  assert.equal(ring.tail(2).length, 2)
})

test('LogRing ignores blank lines and splits chunks', () => {
  const ring = new LogRing()
  ring.pushChunk('a\n\nb\n')
  assert.deepEqual(ring.lines, ['a', 'b'])
})

test('shq escapes single quotes', () => {
  assert.equal(shq("it's"), `'it'\\''s'`)
})

test('remoteHomePath expands ~ against $HOME', () => {
  assert.equal(remoteHomePath('~/work'), '"$HOME"/\'work\'')
  assert.equal(remoteHomePath('/srv/work'), `'/srv/work'`)
})

if (failures > 0) {
  console.error(`\n${String(failures)} test(s) failed`)
  process.exit(1)
}
console.log('\nall self-tests passed')
