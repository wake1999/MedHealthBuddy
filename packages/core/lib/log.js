/**
 * Bounded in-memory log ring for the connection window's diagnostics view.
 *
 * The remote `dsh web` writes its startup line (the one bearing the launch
 * token) to a log file on the server; this ring mirrors whatever this machine
 * observed — local connection events and the remote log tail. Nothing here is
 * persisted: the ring exists so the UI can explain a failure without the user
 * opening a terminal, and it is redacted on the way in (see `redact`).
 *
 * @module @dsh-ssh/core/log
 */

/** Maximum retained lines. The UI shows a tail; older lines are dropped. */
const MAX_LINES = 400

/** Maximum retained characters per line, so one huge line cannot flood the ring. */
const MAX_LINE_CHARS = 2_000

/**
 * Strip launch tokens, cookie material and the desktop-link secret out of a
 * line before it is retained.
 *
 * The remote harness prints an authenticated URL of the form
 * `http://127.0.0.1:3080/?token=<secret>`. That token is a bearer credential for
 * exactly one cookie exchange, and this ring is rendered in a window, so the
 * token must never survive into it. The URL is still available to the caller
 * through the session's dedicated `url` field.
 *
 * @param {string} line
 * @returns {string}
 */
export function redact(line) {
  return line
    // `?token=...` / `&token=...` in any printed URL.
    .replace(/([?&](?:token|launchToken)=)[^\s&"']+/gi, '$1<redacted>')
    // Set-Cookie style material, should anything echo headers back.
    .replace(/(set-cookie:\s*)[^\r\n]+/gi, '$1<redacted>')
    // dsh-auth cookie pairs.
    .replace(/(dsh-auth-[A-Za-z0-9_-]*=)[^\s;]+/g, '$1<redacted>')
    // The integration secret, should a remote log or an error ever echo it.
    .replace(/(DSH_DESKTOP_LINK_SECRET=)[^\s;'"]+/g, '$1<redacted>')
    .replace(/(x-dsh-desktop-secret:\s*)[^\s;]+/gi, '$1<redacted>')
}

/**
 * The bounded line ring.
 */
export class LogRing {
  constructor() {
    /** @type {string[]} */
    this.lines = []
    /**
     * Also receives every line as it is kept — already redacted — e.g. to
     * mirror it to a log file. A failing sink never fails the push.
     * @type {((line: string) => void) | undefined}
     */
    this.sink = undefined
  }

  /**
   * Append one line, redacting and truncating it first.
   * A trailing newline is tolerated so callers can hand over raw chunks split on
   * newlines without pre-trimming.
   * @param {string} line
   */
  push(line) {
    const text = redact(String(line).replace(/\r?\n$/, ''))
    if (text === '') return
    const kept = text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text
    this.lines.push(kept)
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES)
    try { this.sink?.(kept) } catch { /* a log file must never break a connection */ }
  }

  /**
   * Append every line of a multi-line chunk.
   * @param {string} chunk
   */
  pushChunk(chunk) {
    for (const line of String(chunk).split(/\r?\n/)) this.push(line)
  }

  /**
   * The retained tail.
   * @param {number} [limit] Maximum number of trailing lines to return.
   * @returns {string[]}
   */
  tail(limit = 200) {
    return this.lines.slice(-limit)
  }

  /** Drop everything. */
  clear() {
    this.lines.length = 0
  }
}
