/**
 * The desktop shell's decisions, as pure functions.
 *
 * Everything security-relevant about the remote window — which origin counts
 * as "the app", where a navigation or a popup may go, which permissions a page
 * gets — and the small state machines around it (401 recovery, reconnect
 * backoff) live here, free of Electron, so they are unit-tested directly
 * rather than trusted.
 *
 * @module medhealthbuddy-desktop/policy
 */

/** Connection ids are `[A-Za-z0-9_-]{1,64}` (see @dsh-ssh/core/config). */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/**
 * The persistent partition for one connection. Each server gets its own, so
 * cookies, storage and cache never cross between servers, and the login cookie
 * survives an app restart.
 * @param {string} id
 * @returns {string}
 */
export function partitionFor(id) {
  if (!ID_PATTERN.test(id)) throw new Error(`invalid connection id: ${JSON.stringify(id)}`)
  return `persist:conn-${id}`
}

/**
 * The origin the remote window belongs to: the local end of the forward.
 * Always `127.0.0.1`, never `localhost` — the harness cookie is named after the
 * exact authority, so the two are different logins.
 * @param {number} port
 */
export function appOrigin(port) {
  return `http://127.0.0.1:${String(port)}`
}

/** The clean root of the remote UI. */
export function baseUrl(port) {
  return `${appOrigin(port)}/`
}

/**
 * Whether a URL is inside the app origin for this forward.
 * @param {string} url
 * @param {number} port
 */
export function isAppUrl(url, port) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return parsed.origin === appOrigin(port) && parsed.username === '' && parsed.password === ''
}

/** Whether a URL is an ordinary web link that may go to the user's browser. */
function isWebLink(url) {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * What to do with a top-level navigation in the remote window.
 * - `allow`: stays in the app origin.
 * - `external`: an http(s) link elsewhere; cancel it and hand it to the browser.
 * - `deny`: anything else (file:, javascript:, custom schemes).
 * @param {string} url
 * @param {number} port
 * @returns {'allow' | 'external' | 'deny'}
 */
export function navigationDecision(url, port) {
  if (isAppUrl(url, port)) return 'allow'
  if (isWebLink(url)) return 'external'
  return 'deny'
}

/**
 * What to do with `window.open` / `target=_blank` from the remote window.
 * Same-origin popups stay in the app (they need its cookie); other web links go
 * to the user's browser; everything else is refused.
 * @param {string} url
 * @param {number} port
 * @returns {'allow' | 'external' | 'deny'}
 */
export function windowOpenDecision(url, port) {
  return navigationDecision(url, port)
}

/**
 * Permissions the remote page may have. Notifications are the plan's one
 * allowance; clipboard *write* is added because the web UI's copy buttons use
 * `navigator.clipboard.writeText`, and writing is harmless where reading is not.
 */
const ALLOWED_PERMISSIONS = new Set(['notifications', 'clipboard-sanitized-write'])

/**
 * @param {string} permission an Electron permission name.
 * @param {string} requestingUrl
 * @param {number} port
 */
export function permissionAllowed(permission, requestingUrl, port) {
  return ALLOWED_PERMISSIONS.has(permission) && isAppUrl(requestingUrl, port)
}

/**
 * Reconnect delay after a drop: 1s, 2s, 4s, … capped at 30s.
 * @param {number} attempt 0 for the first retry.
 */
export function backoffMs(attempt) {
  const n = Math.max(0, Math.floor(attempt))
  return Math.min(30_000, 1_000 * 2 ** Math.min(n, 15))
}

/**
 * 401 recovery for the remote window, as a state machine.
 *
 * The harness authenticates the window with a `Max-Age` cookie minted by the
 * launch token (see @dsh-ssh/core/remote). The window therefore loads the clean
 * root first — the persistent partition usually still holds a valid cookie —
 * and escalates only on a 401:
 *
 *   base ─401→ token URL from the connect ─401→ token URL re-read from the log ─401→ failed
 *
 * The token is valid for the life of the remote process, so a 401 after the
 * connect's own URL means the process changed underneath; re-reading its log
 * gets the current token. Only a harness with no URL in its log needs a restart.
 *
 * @typedef {'base' | 'token' | 'log' | 'done' | 'failed'} AuthStage
 * @param {AuthStage} stage the URL that just loaded.
 * @param {number} status its HTTP status.
 * @returns {{ stage: AuthStage, action: 'none' | 'load-token' | 'reread-log' | 'failed' }}
 */
export function nextAuthStep(stage, status) {
  if (status !== 401) {
    return stage === 'failed' ? { stage, action: 'none' } : { stage: 'done', action: 'none' }
  }
  switch (stage) {
    case 'base':
      return { stage: 'token', action: 'load-token' }
    case 'token':
    case 'done':
      // `done`: a 401 after a working session (the remote was replaced, or the
      // cookie expired) — the connect's token is the one most likely stale.
      return { stage: 'log', action: 'reread-log' }
    default:
      return { stage: 'failed', action: 'failed' }
  }
}

/** Windows caption height, matching the official desktop (`WINDOWS_TITLEBAR_HEIGHT`). */
export const TITLEBAR_HEIGHT = 40

/** The caption menus a page may ask the shell to pop up. */
const CAPTION_MENUS = new Set(['application', 'edit'])

/**
 * Validate a caption-menu popup request from a renderer: a known menu name and
 * an anchor inside any plausible window.
 * @param {unknown} name
 * @param {unknown} x
 * @param {unknown} y
 * @returns {name is 'application' | 'edit'}
 */
export function isMenuRequest(name, x, y) {
  const coordinate = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100_000
  return typeof name === 'string' && CAPTION_MENUS.has(name) && coordinate(x) && coordinate(y)
}

/**
 * Whether a value is a plain CSS colour the caption overlay may be painted
 * with. Only `#hex` and `rgb()/rgba()` from the renderer's own measurement
 * cross IPC; a fully transparent colour (no page palette yet) is refused.
 * @param {unknown} value
 * @returns {value is string}
 */
export function isCaptionColor(value) {
  if (typeof value !== 'string') return false
  if (/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value)) return true
  const match = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(value)
  if (match === null) return false
  if (match.slice(1, 4).some((c) => Number(c) > 255)) return false
  return match[4] === undefined || Number(match[4]) > 0
}

// ------------------------------------------------------- window.dshSshDesktop

/**
 * The page bridge (`window.dshSshDesktop`, protocol 1). Not `dshDesktop`: the
 * official DSH desktop exposes that name to the same web client, which reads
 * it as its own product API.
 *
 * Every remote plugin can call it, so it is designed as an open attack
 * surface: it offers only harmless things, validates every argument here, and
 * the main process answers only the top frame of one of its remote views
 * while that frame shows the connection's own origin.
 */
export const BRIDGE_PROTOCOL = 1
export const BRIDGE_CAPABILITIES = Object.freeze(['notify', 'setBadge', 'revealInEditor'])

/**
 * Whether a bridge IPC call may be answered.
 * @param {{ fromOwnView: boolean, isMainFrame: boolean, frameUrl: unknown, port: number | undefined }} caller
 *   `fromOwnView`: the sender is the web contents of one of this app's remote
 *   views; `port`: that view's current forward.
 */
export function isBridgeCaller(caller) {
  if (!caller.fromOwnView || !caller.isMainFrame) return false
  if (caller.port === undefined || typeof caller.frameUrl !== 'string') return false
  return isAppUrl(caller.frameUrl, caller.port)
}

/** Drop control characters and collapse whitespace; notification text is one line or a short paragraph. */
function plainText(value, max) {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '')
    .replace(/[ \t]+/g, ' ').trim().slice(0, max)
}

/**
 * `notify({ title, body? })`: title up to 120 characters, body up to 500.
 * @param {unknown} input
 * @returns {{ title: string, body: string }}
 */
export function notifyInput(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('notify expects { title, body? }')
  const { title, body } = /** @type {Record<string, unknown>} */ (input)
  if (typeof title !== 'string' || (body !== undefined && typeof body !== 'string')) throw new Error('notify expects { title, body? }')
  const clean = plainText(title, 120)
  if (clean === '') throw new Error('notify needs a title')
  return { title: clean, body: body === undefined ? '' : plainText(body, 500) }
}

/**
 * `setBadge(count)`: an integer 0..999.
 * @param {unknown} count
 * @returns {number}
 */
export function badgeInput(count) {
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > 999) throw new Error('setBadge expects an integer 0..999')
  return count
}

/**
 * `revealInEditor({ path, line? })`: an absolute POSIX path on the server
 * (it names a file or directory there, never on this machine), and an
 * optional 1-based line.
 * @param {unknown} input
 * @returns {{ path: string, line: number | undefined }}
 */
export function revealInput(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('revealInEditor expects { path, line? }')
  const { path, line } = /** @type {Record<string, unknown>} */ (input)
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 4096) throw new Error('revealInEditor expects an absolute server path')
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(path)) throw new Error('revealInEditor refuses control characters and backslashes')
  if (path.split('/').some((segment) => segment === '..')) throw new Error('revealInEditor refuses ".." segments')
  if (line !== undefined && (typeof line !== 'number' || !Number.isInteger(line) || line < 1 || line > 10_000_000)) {
    throw new Error('revealInEditor expects a positive integer line')
  }
  return { path, line: /** @type {number | undefined} */ (line) }
}

/** ssh targets the app accepts as a Remote-SSH authority: an alias or user@host. */
const REMOTE_AUTHORITY = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+$/

/**
 * The VS Code link that opens `path` on the connection's server through
 * Remote-SSH: `vscode://vscode-remote/ssh-remote+<target><path>[:<line>]`.
 * The target comes from the stored connection, never from the page.
 * @param {string} target the connection's ssh target (a ~/.ssh/config alias or user@host).
 * @param {string} path a path accepted by `revealInput`.
 * @param {number} [line]
 */
export function vscodeRemoteUrl(target, path, line) {
  if (!REMOTE_AUTHORITY.test(target) || target.startsWith('-')) throw new Error('this connection\'s ssh target cannot be used for VS Code Remote-SSH')
  const encoded = path.split('/').map((segment) => encodeURIComponent(segment)).join('/')
  // The authority pattern admits no character that needs escaping.
  return `vscode://vscode-remote/ssh-remote+${target}${encoded}${line === undefined ? '' : `:${String(line)}`}`
}

/**
 * The notification for a finished task on a connection.
 * @param {{ title: string, outcome: 'completed' | 'error' | 'blocked' }} task
 * @param {string} connection the connection's display name.
 * @returns {{ title: string, body: string }}
 */
export function taskNotification(task, connection) {
  const heading = { completed: '任务已完成', error: '任务出错', blocked: '任务受阻，需要处理' }[task.outcome] ?? '任务已结束'
  const name = task.title === '' ? '未命名会话' : task.title
  return { title: `${heading} · ${connection}`, body: name }
}

/**
 * A fixed-window rate limit for page notifications: at most `limit` per
 * `windowMs`, so a misbehaving plugin cannot flood the desktop.
 * @param {number} limit
 * @param {number} windowMs
 * @param {() => number} [now]
 */
export function rateLimiter(limit, windowMs, now = Date.now) {
  /** @type {number[]} */
  let stamps = []
  return () => {
    const t = now()
    stamps = stamps.filter((s) => t - s < windowMs)
    if (stamps.length >= limit) return false
    stamps.push(t)
    return true
  }
}

/**
 * Whether an IPC call comes from the local connection window and nothing else.
 *
 * The sender webContents matching is the real gate: the manager page cannot
 * navigate (will-navigate is prevented) and its CSP allows no frames, so
 * nothing else can speak from that webContents. The frame URL is checked as
 * extra evidence when Chromium reports one — but around a native dialog the
 * frame can briefly be reported as gone (frameUrl undefined) while an invoke
 * is in flight, and that must not lock the user out of their own buttons.
 * @param {{ senderId: number, frameUrl: string | undefined }} caller
 * @param {{ windowId: number | undefined, pageUrl: string }} expected
 */
export function isConnectionWindowCaller(caller, expected) {
  if (expected.windowId === undefined || caller.senderId !== expected.windowId) return false
  if (typeof caller.frameUrl !== 'string') return true
  // Compare without a fragment; the page never navigates anywhere else.
  return caller.frameUrl.split('#')[0] === expected.pageUrl
}
