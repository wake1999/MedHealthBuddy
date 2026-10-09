/**
 * The shell's security and recovery decisions.
 *
 * Run: node test/policy.js
 */
import { strict as assert } from 'node:assert'

import {
  appOrigin,
  backoffMs,
  badgeInput,
  baseUrl,
  isAppUrl,
  isBridgeCaller,
  isCaptionColor,
  isConnectionWindowCaller,
  isMenuRequest,
  navigationDecision,
  nextAuthStep,
  notifyInput,
  partitionFor,
  permissionAllowed,
  rateLimiter,
  revealInput,
  taskNotification,
  vscodeRemoteUrl,
  windowOpenDecision,
} from '../src/main/policy.js'

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

check('each connection gets its own persistent partition', () => {
  assert.equal(partitionFor('ab12'), 'persist:conn-ab12')
  assert.notEqual(partitionFor('a'), partitionFor('b'))
  for (const bad of ['', '../x', 'a b', 'a:b', 'x'.repeat(65)]) {
    assert.throws(() => partitionFor(bad), /invalid connection id/, bad)
  }
})

check('the app origin is 127.0.0.1 with the forward port, never localhost', () => {
  assert.equal(appOrigin(3080), 'http://127.0.0.1:3080')
  assert.equal(baseUrl(3080), 'http://127.0.0.1:3080/')
})

check('isAppUrl matches only the exact origin of the forward', () => {
  assert.equal(isAppUrl('http://127.0.0.1:3080/', 3080), true)
  assert.equal(isAppUrl('http://127.0.0.1:3080/session/abc?x=1#y', 3080), true)
  for (const url of [
    'http://localhost:3080/', // a different cookie authority
    'http://127.0.0.1:3081/', // another forward
    'https://127.0.0.1:3080/',
    'http://127.0.0.1.evil.com:3080/',
    'http://user:pw@127.0.0.1:3080/',
    'file:///C:/Windows/win.ini',
    'javascript:alert(1)',
    'not a url',
  ]) {
    assert.equal(isAppUrl(url, 3080), false, url)
  }
})

check('navigation stays in the app, sends web links out, refuses the rest', () => {
  assert.equal(navigationDecision('http://127.0.0.1:3080/x', 3080), 'allow')
  assert.equal(navigationDecision('https://github.com/deepseek-ai', 3080), 'external')
  assert.equal(navigationDecision('http://127.0.0.1:22/', 3080), 'external')
  assert.equal(navigationDecision('file:///C:/', 3080), 'deny')
  assert.equal(navigationDecision('vscode://file/x', 3080), 'deny')
  assert.equal(navigationDecision('javascript:void(0)', 3080), 'deny')
  // A window that has not loaded yet has no origin to allow.
  assert.equal(navigationDecision('http://127.0.0.1:3080/', -1), 'external')
})

check('popups follow the same rule', () => {
  assert.equal(windowOpenDecision('http://127.0.0.1:3080/preview', 3080), 'allow')
  assert.equal(windowOpenDecision('https://example.org/', 3080), 'external')
  assert.equal(windowOpenDecision('data:text/html,hi', 3080), 'deny')
})

check('only notifications and clipboard write are granted, and only to the app', () => {
  assert.equal(permissionAllowed('notifications', 'http://127.0.0.1:3080/', 3080), true)
  assert.equal(permissionAllowed('clipboard-sanitized-write', 'http://127.0.0.1:3080/', 3080), true)
  for (const p of ['clipboard-read', 'media', 'geolocation', 'openExternal', 'fileSystem', 'hid', 'serial', 'usb', 'pointerLock']) {
    assert.equal(permissionAllowed(p, 'http://127.0.0.1:3080/', 3080), false, p)
  }
  assert.equal(permissionAllowed('notifications', 'https://evil.example/', 3080), false)
  assert.equal(permissionAllowed('notifications', 'http://127.0.0.1:3080', 3080), true, 'an origin without a path counts')
})

check('backoff doubles from 1s and caps at 30s', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 50].map(backoffMs), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
  assert.equal(backoffMs(-3), 1000)
})

check('401 recovery: base, then the connect token, then the log, then give up', () => {
  assert.deepEqual(nextAuthStep('base', 200), { stage: 'done', action: 'none' })
  assert.deepEqual(nextAuthStep('base', 401), { stage: 'token', action: 'load-token' })
  assert.deepEqual(nextAuthStep('token', 200), { stage: 'done', action: 'none' })
  assert.deepEqual(nextAuthStep('token', 401), { stage: 'log', action: 'reread-log' })
  assert.deepEqual(nextAuthStep('log', 200), { stage: 'done', action: 'none' })
  assert.deepEqual(nextAuthStep('log', 401), { stage: 'failed', action: 'failed' })
  assert.deepEqual(nextAuthStep('failed', 401), { stage: 'failed', action: 'failed' })
})

check('a 401 after a working session re-reads the log instead of reusing a stale token', () => {
  // The remote was replaced (or the cookie expired) while the window was open.
  assert.deepEqual(nextAuthStep('done', 401), { stage: 'log', action: 'reread-log' })
})

check('a non-401 error page is not an auth problem', () => {
  assert.deepEqual(nextAuthStep('base', 502), { stage: 'done', action: 'none' })
})

check('IPC is served only to the connection page in the connection window', () => {
  const expected = { windowId: 7, pageUrl: 'file:///C:/app/src/renderer/connection.html' }
  assert.equal(isConnectionWindowCaller({ senderId: 7, frameUrl: 'file:///C:/app/src/renderer/connection.html' }, expected), true)
  assert.equal(isConnectionWindowCaller({ senderId: 7, frameUrl: 'file:///C:/app/src/renderer/connection.html#x' }, expected), true)
  // The remote window, even if it somehow had ipcRenderer.
  assert.equal(isConnectionWindowCaller({ senderId: 9, frameUrl: 'http://127.0.0.1:3080/' }, expected), false)
  // Right window, wrong page (a navigation or an injected frame).
  assert.equal(isConnectionWindowCaller({ senderId: 7, frameUrl: 'http://127.0.0.1:3080/' }, expected), false)
  assert.equal(isConnectionWindowCaller({ senderId: 7, frameUrl: 'file:///C:/other.html' }, expected), false)
  // The webContents matches and the frame is briefly unreported (in flight
  // around a native dialog): the sender gate alone must let it through.
  assert.equal(isConnectionWindowCaller({ senderId: 7, frameUrl: undefined }, expected), true)
  // No connection window at all.
  assert.equal(isConnectionWindowCaller({ senderId: 7, frameUrl: expected.pageUrl }, { ...expected, windowId: undefined }), false)
})

check('caption menu requests name a known menu and a sane anchor', () => {
  assert.equal(isMenuRequest('application', 48, 40), true)
  assert.equal(isMenuRequest('edit', 0, 0), true)
  for (const [name, x, y] of [
    ['file', 1, 1], ['', 1, 1], [undefined, 1, 1], ['edit', -1, 1], ['edit', 1, Number.NaN],
    ['edit', Infinity, 1], ['edit', '1', 1], ['edit', 1, 200_000],
  ]) {
    assert.equal(isMenuRequest(name, x, y), false, JSON.stringify([name, x, y]))
  }
})

check('only plain opaque-ish colours may paint the caption', () => {
  for (const ok of ['#fff', '#1b1b1c', 'rgb(27, 27, 28)', 'rgba(249, 250, 251, 1)', 'rgba(0,0,0,0.5)']) {
    assert.equal(isCaptionColor(ok), true, ok)
  }
  for (const bad of [
    'rgba(0, 0, 0, 0)', // no page palette yet
    'red', 'var(--x)', 'url(javascript:1)', 'rgb(300, 0, 0)', '#12345', 'rgb(1,2,3); background:red', 42, null,
  ]) {
    assert.equal(isCaptionColor(bad), false, String(bad))
  }
})

// ------------------------------------------------------- window.dshSshDesktop

check('the bridge answers only the top frame of our own view on its own forward', () => {
  const ok = { fromOwnView: true, isMainFrame: true, frameUrl: 'http://127.0.0.1:3080/session/1', port: 3080 }
  assert.equal(isBridgeCaller(ok), true)
  // Forged or misplaced callers.
  const refused = {
    'another web contents (the manager, a popup, a stranger)': { ...ok, fromOwnView: false },
    'an iframe inside the remote page': { ...ok, isMainFrame: false },
    'the same view after navigating elsewhere': { ...ok, frameUrl: 'https://evil.example/' },
    'another forward\'s port': { ...ok, frameUrl: 'http://127.0.0.1:3081/' },
    'localhost instead of 127.0.0.1': { ...ok, frameUrl: 'http://localhost:3080/' },
    'credentials in the URL': { ...ok, frameUrl: 'http://a:b@127.0.0.1:3080/' },
    'a file: page': { ...ok, frameUrl: 'file:///C:/x.html' },
    'a view whose forward is gone': { ...ok, port: undefined },
    'no frame URL at all': { ...ok, frameUrl: undefined },
  }
  for (const [label, caller] of Object.entries(refused)) assert.equal(isBridgeCaller(caller), false, label)
})

check('notify takes a title and an optional body, trimmed and bounded', () => {
  assert.deepEqual(notifyInput({ title: ' Done ', body: 'all\tgood' }), { title: 'Done', body: 'all good' })
  assert.deepEqual(notifyInput({ title: 'x' }), { title: 'x', body: '' })
  assert.equal(notifyInput({ title: 'a'.repeat(500) }).title.length, 120)
  assert.equal(notifyInput({ title: 't', body: 'b'.repeat(900) }).body.length, 500)
  assert.equal(notifyInput({ title: 'a\u202eb\u0007c' }).title, 'abc', 'no bidi overrides or control characters')
  for (const bad of [null, 'text', [], {}, { title: '' }, { title: '  ' }, { title: 1 }, { title: 't', body: 2 }]) {
    assert.throws(() => notifyInput(bad), JSON.stringify(bad))
  }
})

check('setBadge takes an integer 0..999', () => {
  for (const ok of [0, 1, 999]) assert.equal(badgeInput(ok), ok)
  for (const bad of [-1, 1000, 1.5, Number.NaN, '3', null]) assert.throws(() => badgeInput(bad), String(bad))
})

check('revealInEditor takes an absolute server path and an optional line', () => {
  assert.deepEqual(revealInput({ path: '/home/dev/work' }), { path: '/home/dev/work', line: undefined })
  assert.deepEqual(revealInput({ path: '/w/a b.ts', line: 12 }), { path: '/w/a b.ts', line: 12 })
  for (const bad of [
    null, '/w', { path: 'relative/x' }, { path: 'C:\\Users\\x' }, { path: '/w/../etc/passwd' }, { path: '/w\nx' },
    { path: '/w', line: 0 }, { path: '/w', line: 1.5 }, { path: '/w', line: '3' }, { path: `/${'a'.repeat(5000)}` },
  ]) {
    assert.throws(() => revealInput(bad), JSON.stringify(bad))
  }
})

check('the VS Code link names the stored ssh target and an encoded path', () => {
  assert.equal(vscodeRemoteUrl('devbox', '/home/dev/work'), 'vscode://vscode-remote/ssh-remote+devbox/home/dev/work')
  assert.equal(vscodeRemoteUrl('me@host.example', '/w/a b#1.ts', 7), 'vscode://vscode-remote/ssh-remote+me@host.example/w/a%20b%231.ts:7')
  for (const bad of ['-oProxyCommand=x', 'a b', 'host/path', 'a@b@c', '']) {
    assert.throws(() => vscodeRemoteUrl(bad, '/w'), bad)
  }
})

check('a finished task reads as one line of what happened and where', () => {
  assert.deepEqual(taskNotification({ title: 'Fix build', outcome: 'completed' }, 'devbox'), { title: '任务已完成 · devbox', body: 'Fix build' })
  assert.equal(taskNotification({ title: '', outcome: 'error' }, 'devbox').body, '未命名会话')
  assert.match(taskNotification({ title: 't', outcome: 'blocked' }, 'devbox').title, /受阻/)
})

check('page notifications are rate limited', () => {
  let t = 0
  const allow = rateLimiter(3, 10_000, () => t)
  assert.deepEqual([allow(), allow(), allow(), allow()], [true, true, true, false])
  t = 10_001
  assert.equal(allow(), true, 'the window slides')
})

if (failures > 0) {
  console.error(`\n${String(failures)} policy test(s) failed`)
  process.exit(1)
}
console.log('\nall policy tests passed')
