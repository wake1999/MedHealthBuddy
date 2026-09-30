/**
 * Remote `dsh web` lifecycle.
 *
 * The server side is deliberately dumb and observable: the remote harness is
 * started fully detached (a systemd transient unit, or `setsid`/`nohup`) with its
 * stdout and stderr written to a per-port log file, and everything this module
 * needs afterwards is read back out of that file and out of `ss`. That keeps the
 * SSH connection disposable — the remote harness survives a dropped link, a
 * laptop suspend, or a desktop app restart, and the local side can always
 * reconstruct the current state from scratch.
 *
 * Reuse is preferred over restart. If something is already listening on the
 * remote port it is treated as *our* harness (the port is the app's own
 * bookkeeping key) and its printed URL is reused, because restarting would
 * throw away running agent turns.
 *
 * How the harness authenticates a browser (upstream
 * `packages/client/connection/src/browser-auth.ts`): the launch token is fixed
 * for the life of one process — not single-use — and exchanging it at `GET /`
 * mints a `Max-Age` cookie named after the request authority and signed with a
 * secret kept in the profile's credential store. That secret survives a
 * restart, so a cookie keeps working across remote restarts; the token in the
 * log of the *running* process is always the current one. A 401 is therefore
 * recovered by re-reading the log, and a restart is needed only when the log
 * has no URL (a harness started some other way).
 *
 * @module @dsh-ssh/core/remote
 */

// NOTE: this module talks to a *transport*, never to ssh directly. A transport
// exposes `exec(command, { timeoutMs, input })`; tests substitute a fake with the
// same shape, which is how the whole lifecycle is exercised without a server.

/** Command timeout for cheap probes. */
const PROBE_TIMEOUT_MS = 15_000

/** How long a single log poll waits before the next attempt. */
const LOG_POLL_INTERVAL_MS = 500

/** Prefix of every remote file and unit this package owns. */
const REMOTE_NAME = 'dsh-ssh-desktop'

/** The environment variable the server plugin reads its secret from. */
export const LINK_SECRET_ENV = 'DSH_DESKTOP_LINK_SECRET'

/** Environment variable carrying {@link runMarker}. */
const LINK_MARKER_ENV = 'DSH_SSH_DESKTOP_MARKER'

/** Accepted secret shape: lowercase hex, so it is inert in any shell context. */
const SECRET_PATTERN = /^[0-9a-f]{32,128}$/

/** Shell-quote one argument for POSIX `sh`. */
export function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** Expand a leading `~` against `$HOME` inside a remote shell expression. */
export function remoteHomePath(path) {
  if (path === '~') return '"$HOME"'
  if (path.startsWith('~/')) return `"$HOME"/${shq(path.slice(2))}`
  return shq(path)
}

/** The per-port log file the remote harness is started against. */
export function logPathFor(remotePort) {
  return `"$HOME"/.dsh/${REMOTE_NAME}-${String(remotePort)}.log`
}

/** The pid file paired with {@link logPathFor}. */
export function pidPathFor(remotePort) {
  return `"$HOME"/.dsh/${REMOTE_NAME}-${String(remotePort)}.pid`
}

/**
 * The one-shot environment file that hands the link secret to the harness.
 * Written 0600 by the start script, sourced and deleted by the harness wrapper.
 */
export function envPathFor(remotePort) {
  return `"$HOME"/.dsh/${REMOTE_NAME}-${String(remotePort)}.env`
}

/** The systemd user unit name a managed harness runs under. */
export function unitNameFor(remotePort) {
  return `${REMOTE_NAME}-${String(remotePort)}`
}

/** Human-readable marker embedded in the remote environment, so the process can be found later. */
export function runMarker(remotePort) {
  return `${REMOTE_NAME}:${String(remotePort)}`
}

/**
 * A shell function `rd_listen` that returns 0 when the port is LISTENING, 1 when
 * FREE, and 2 when no detection tool exists.
 *
 * Detection is layered because each rung depends on a different tool, and the
 * decision it feeds is destructive in one direction: a false FREE makes the
 * app start a second harness on an occupied port, which dies with
 * `EADDRINUSE` and leaves the user with a failed connect.
 *
 * `ss` is asked to do the filtering (`sport = :<port>` takes a *decimal* port)
 * rather than printing everything and matching fields afterwards. Field matching
 * was tried first and was wrong in two separate ways: `ss` prints ports in
 * decimal, so a hex pattern can never match it, and the field index differs
 * between `ss` and `netstat`. Letting the tool filter removes both hazards.
 *
 * @param {number} remotePort
 * @returns {string}
 */
function listenFunction(remotePort) {
  const port = String(remotePort)
  return [
    'rd_listen() {',
    `  if command -v ss >/dev/null 2>&1; then`,
    // -H suppresses the header, so any output at all means the port is bound.
    // `grep -q .` yields a clean 0/1 without caring how many lines matched.
    `    ss -ltnH ${shq(`sport = :${port}`)} 2>/dev/null | grep -q . && return 0`,
    `    return 1`,
    '  fi',
    `  if command -v netstat >/dev/null 2>&1; then`,
    // netstat has no comparable filter, so match the decimal port in the local
    // address column.
    `    netstat -ltn 2>/dev/null | awk -v p=":${port}" 'index($4, p) > 0 { found = 1 } END { exit found ? 0 : 1 }' && return 0`,
    `    return 1`,
    '  fi',
    '  if [ -r /proc/net/tcp ]; then',
    // The kernel prints the port as four uppercase hex digits in field 2; field 4
    // is the state, and 0A is LISTEN.
    `    rd_hex="$(printf '%04X' ${port})"`,
    '    awk -v p=":$rd_hex" \'$4 == "0A" && index($2, p) == length($2) - length(p) + 1 { found = 1 } END { exit found ? 0 : 1 }\' /proc/net/tcp && return 0',
    '    return 1',
    '  fi',
    '  return 2',
    '}',
  ].join('\n')
}

/**
 * A shell snippet that prints whether the port is LISTENING, FREE, or UNKNOWN.
 * See {@link listenFunction} for why detection is layered.
 *
 * @param {number} remotePort
 * @returns {string}
 */
export function listeningCommand(remotePort) {
  return [
    listenFunction(remotePort),
    'rd_listen && echo LISTENING || { rc=$?; [ "$rc" = 2 ] && echo UNKNOWN || echo FREE; }',
  ].join('\n')
}

/**
 * Resolve the remote `dsh` executable.
 *
 * A non-interactive SSH command runs with a minimal PATH that frequently omits
 * the user's npm global bin (nvm, `~/.local/bin`, volta, …), so the command is
 * searched for explicitly rather than relied upon via `command -v` alone. The
 * result is echoed as `DSH=<path>` or `DSH=` when nothing was found.
 *
 * @returns {string}
 */
export function resolveDshCommand() {
  return [
    'p=""',
    'if command -v dsh >/dev/null 2>&1; then p="$(command -v dsh)"; fi',
    'if [ -z "$p" ]; then',
    // First: where this app's installer puts it (see install.js).
    '  for c in "$HOME/.local/opt/node/bin/dsh" "$HOME/.local/bin/dsh" "$HOME/.npm-global/bin/dsh" /usr/local/bin/dsh /usr/bin/dsh; do',
    '    if [ -x "$c" ]; then p="$c"; break; fi',
    '  done',
    'fi',
    'if [ -z "$p" ] && command -v npm >/dev/null 2>&1; then',
    '  np="$(npm prefix -g 2>/dev/null)/bin/dsh"; if [ -x "$np" ]; then p="$np"; fi',
    'fi',
    'printf "DSH=%s\\n" "$p"',
  ].join('\n')
}

/**
 * Probe the remote host for everything the UI needs to explain its state.
 *
 * @param {{ exec: (command: string, options?: { timeoutMs?: number }) => Promise<{ code: number | null, stdout: string, stderr: string, timedOut: boolean }> }} ssh
 *   the transport.
 * @param {import('./config.js').ConnectionConfig} config
 * @returns {Promise<{ dsh: string, workspaceExists: boolean, profileExists: boolean, listening: boolean, nodeVersion: string | null }>}
 */
export async function probe(ssh, config) {
  const workspace = remoteHomePath(config.remoteWorkspace)
  const command = [
    'set -u',
    resolveDshCommand(),
    `if [ -d ${workspace} ]; then printf "WORKSPACE=%s\\n" yes; else printf "WORKSPACE=%s\\n" no; fi`,
    `if [ -d "$HOME/.dsh/profiles"/${shq(config.remoteProfile)} ]; then printf "PROFILE=%s\\n" yes; else printf "PROFILE=%s\\n" no; fi`,
    // The node dsh will run on: the one beside it (see harnessWrapper), else PATH's.
    'n="$(dirname "${p:-/nonexistent/x}")/node"; [ -x "$n" ] || n="$(command -v node 2>/dev/null || true)"',
    `printf "NODE=%s\\n" "$([ -n "$n" ] && "$n" --version 2>/dev/null || echo none)"`,
    listeningCommand(config.remotePort),
  ].join('\n')

  const result = await ssh.exec(command, { timeoutMs: PROBE_TIMEOUT_MS })
  if (result.timedOut) throw new Error('probing the remote host timed out')
  const out = result.stdout
  const pick = (key) => {
    const match = new RegExp(`^${key}=(.*)$`, 'm').exec(out)
    return match === null ? '' : match[1].trim()
  }
  const listeningRaw = /(LISTENING|FREE|UNKNOWN)\s*$/.exec(out.trim())
  return {
    dsh: pick('DSH'),
    workspaceExists: pick('WORKSPACE') === 'yes',
    profileExists: pick('PROFILE') === 'yes',
    listening: listeningRaw !== null && listeningRaw[1] === 'LISTENING',
    nodeVersion: pick('NODE') === 'none' ? null : pick('NODE') || null,
  }
}

/**
 * Extract the authenticated local URL the harness printed for itself.
 *
 * The line is `dsh web: <url>` optionally followed by ` (LAN: <url>)`. Only the
 * first (loopback) URL is wanted: the LAN URL advertises a different authority,
 * and the browser-auth cookie this app relies on is bound to the authority the
 * window actually visits.
 *
 * @param {string} text
 * @returns {string | undefined}
 */
export function parseLaunchUrl(text) {
  const ansi = /\u001B\[[0-9;]*[A-Za-z]/g
  const clean = text.replace(ansi, '')
  const match = /dsh web:\s*(https?:\/\/\S+)/.exec(clean)
  if (match === null) return undefined
  // Drop a trailing parenthetical if the URL somehow absorbed one.
  return match[1].replace(/[),.]+$/, '')
}

/**
 * Read the tail of the remote harness log.
 *
 * A file read, deliberately. `journalctl --user` would be the tidier source for
 * a systemd-run instance, but a user who is not in the `systemd-journal` group
 * gets `No journal files were opened due to insufficient permissions` — a common
 * default on shared RHEL-family hosts — so the unit's output is redirected to a
 * log file instead and this only has to read that.
 *
 * Expect the file to stay empty for a while after the listener comes up: the
 * harness writes its launch line to stdout, Node block-buffers a non-tty stdout,
 * and the line therefore lands in batches. Callers must poll rather than treat an
 * empty log as failure.
 *
 * @param {{ exec: (command: string, options?: { timeoutMs?: number }) => Promise<{ stdout: string }> }} ssh the transport.
 * @param {import('./config.js').ConnectionConfig} config
 * @param {number} [lines]
 * @returns {Promise<string>}
 */
export async function readLog(ssh, config, lines = 200) {
  const command = `f=${logPathFor(config.remotePort)}; if [ -f "$f" ]; then tail -n ${String(lines)} "$f"; fi`
  const result = await ssh.exec(command, { timeoutMs: PROBE_TIMEOUT_MS })
  return result.stdout
}

/**
 * Wait until the printed launch URL appears in the remote log, or the deadline
 * passes.
 *
 * The log is re-read from scratch on every poll instead of being tailed: the
 * line is printed exactly once, near the top of the file, so a fresh `tail` is
 * both cheaper to reason about and immune to a missed byte on a flaky link.
 *
 * @param {any} ssh
 * @param {import('./config.js').ConnectionConfig} config
 * @param {{ deadline: number, onTick?: (elapsedMs: number, log: string) => void }} options
 * @returns {Promise<{ url: string, log: string } | undefined>}
 */
export async function awaitLaunchUrl(ssh, config, options) {
  const started = Date.now()
  while (Date.now() < options.deadline) {
    const log = await readLog(ssh, config, 400)
    const url = parseLaunchUrl(log)
    if (url !== undefined) return { url, log }
    options.onTick?.(Date.now() - started, log)
    await new Promise((r) => setTimeout(r, LOG_POLL_INTERVAL_MS))
  }
  return undefined
}

/**
 * Stop whatever is listening on the remote port.
 *
 * The systemd unit and the pid file identify a harness this app started. The
 * port is this app's own key, so anything *still* holding it afterwards is by
 * definition the instance about to be replaced, and it is stopped by socket —
 * `fuser` preferred, `lsof` as the fallback. When neither exists the command
 * reports that the port is still listening rather than pretending to have
 * stopped something.
 *
 * @param {any} ssh
 * @param {import('./config.js').ConnectionConfig} config
 * @returns {Promise<{ stopped: boolean, note: string }>}
 */
export async function stopRemote(ssh, config) {
  const pidFile = pidPathFor(config.remotePort)
  const marker = runMarker(config.remotePort)
  const unit = unitNameFor(config.remotePort)
  const command = [
    'set -u',
    listenFunction(config.remotePort),
    'killed=no',
    // A systemd-run instance is stopped through its unit, not by signal: the
    // user manager owns that process and would otherwise restart or reap it on
    // its own schedule. `stop` is what makes the teardown deterministic.
    `if command -v systemctl >/dev/null 2>&1; then`,
    `  if systemctl --user stop ${shq(unit)} >/dev/null 2>&1; then killed=yes; fi`,
    `  systemctl --user reset-failed ${shq(unit)} >/dev/null 2>&1 || true`,
    'fi',
    // The marker only survives in a command line that has not exec'd yet (a
    // wrapper shell caught mid-start); a running harness is found by pid or port.
    // The pattern is written `[D]SH_…` so it cannot match itself: this very
    // script is the argv of the shell running it, and a plain pattern made the
    // stop kill its own shell before it could report back (seen on a real host).
    `pids="$(pgrep -f ${shq(`[${LINK_MARKER_ENV[0]}]${LINK_MARKER_ENV.slice(1)}=${marker}`)} 2>/dev/null || true)"`,
    'if [ -n "$pids" ]; then kill $pids 2>/dev/null && killed=yes; fi',
    `if [ -f ${pidFile} ]; then kill "$(cat ${pidFile})" 2>/dev/null && killed=yes; rm -f ${pidFile}; fi`,
    'sleep 1',
    // Port-based fallback, whenever the port is still held: a harness started by
    // hand or by an older launcher, or one that ignored the first signal.
    'if rd_listen; then',
    '  if command -v fuser >/dev/null 2>&1; then',
    `    if fuser -k -n tcp ${String(config.remotePort)} >/dev/null 2>&1; then killed=yes; fi`,
    '  elif command -v lsof >/dev/null 2>&1; then',
    `    opids="$(lsof -t -iTCP:${String(config.remotePort)} -sTCP:LISTEN 2>/dev/null || true)"`,
    '    if [ -n "$opids" ]; then kill $opids 2>/dev/null && killed=yes; fi',
    '  fi',
    '  sleep 1',
    'fi',
    `rm -f ${envPathFor(config.remotePort)}`,
    'rd_listen && echo LISTENING || { rc=$?; [ "$rc" = 2 ] && echo UNKNOWN || echo FREE; }',
    'printf "KILLED=%s\\n" "$killed"',
  ].join('\n')

  const result = await ssh.exec(command, { timeoutMs: 30_000 })
  const killedMatch = /^KILLED=(.*)$/m.exec(result.stdout)
  // No report line means the script died part-way (or the link did); that is an
  // unknown outcome, never "nothing was running".
  if (killedMatch === null) {
    const detail = result.timedOut ? 'timed out' : `exit ${String(result.code)}`
    return { stopped: false, note: `the stop script did not report back (${detail})` }
  }
  const stillRaw = /^(LISTENING|FREE|UNKNOWN)\s*$/m.exec(result.stdout)
  const stillListening = stillRaw !== null && stillRaw[1] === 'LISTENING'
  return {
    stopped: killedMatch[1].trim() === 'yes',
    note: stillListening ? 'the port is still listening after the stop attempt' : '',
  }
}

/**
 * Recover the link secret of a harness this app started in an earlier run.
 *
 * The secret lives in the harness's own environment (see
 * {@link harnessWrapper}), and `/proc/<pid>/environ` is readable by the same
 * user — exactly the account the ssh session runs as, and no other. The
 * process is found the way {@link stopRemote} finds it: the systemd unit's
 * main pid, else the pid file of a `setsid`/`nohup` start. Only this script's
 * stdout carries the secret, over the encrypted channel; it is in no argv.
 *
 * A harness started by hand, or by the old launcher, has no secret: the
 * answer is then undefined and the session stays display-only.
 *
 * @param {any} ssh
 * @param {import('./config.js').ConnectionConfig} config
 * @returns {Promise<string | undefined>}
 */
export async function readLinkSecret(ssh, config) {
  const unit = unitNameFor(config.remotePort)
  const command = [
    'set -u',
    'pids=""',
    'if command -v systemctl >/dev/null 2>&1; then',
    `  p="$(systemctl --user show -p MainPID --value ${shq(unit)} 2>/dev/null || true)"`,
    '  if [ -n "$p" ] && [ "$p" != 0 ]; then pids="$p"; fi',
    'fi',
    `if [ -f ${pidPathFor(config.remotePort)} ]; then pids="$pids $(cat ${pidPathFor(config.remotePort)} 2>/dev/null)"; fi`,
    'for p in $pids; do',
    '  case "$p" in *[!0-9]*|"") continue ;; esac',
    '  [ -r "/proc/$p/environ" ] || continue',
    `  v="$(tr '\\000' '\\n' < "/proc/$p/environ" 2>/dev/null | sed -n 's/^${LINK_SECRET_ENV}=//p' | head -n 1)"`,
    '  if [ -n "$v" ]; then printf "LINKSECRET=%s\\n" "$v"; exit 0; fi',
    'done',
    'printf "LINKSECRET=\\n"',
  ].join('\n')
  const result = await ssh.exec(command, { timeoutMs: PROBE_TIMEOUT_MS })
  const match = /^LINKSECRET=(.*)$/m.exec(result.stdout ?? '')
  const secret = match === null ? '' : match[1].trim()
  return SECRET_PATTERN.test(secret) ? secret : undefined
}

/**
 * The wrapper every harness is started through.
 *
 * It sources the one-shot environment file (when the start script wrote one),
 * deletes it, and `exec`s the real command, so the secret lives only in the
 * harness's own environment — readable by the same user, never by `ps`. The
 * path is spelled with `$HOME` and expanded by the wrapper itself, which works
 * identically under the user manager and under `nohup`.
 *
 * It also puts the directory `dsh` was found in first on PATH. An npm global
 * install makes `dsh` a symlink to a `#!/usr/bin/env node` script, and the
 * user manager's PATH is only the system directories — on a real host that
 * found a system Node 10, which died on the first `import`. The node that npm
 * installed `dsh` with sits in that same `bin` directory.
 *
 * @param {number} remotePort
 * @param {string} dshPath
 */
function harnessWrapper(remotePort, dshPath) {
  const slash = dshPath.lastIndexOf('/')
  const dir = slash > 0 ? dshPath.slice(0, slash) : ''
  return [
    `f=${envPathFor(remotePort)}`,
    'if [ -f "$f" ]; then set -a; . "$f"; set +a; rm -f "$f"; fi',
    ...(dir === '' ? [] : [`PATH=${shq(dir)}:"$PATH"`, 'export PATH']),
    'exec "$@"',
  ].join('; ')
}

/**
 * Build the start command.
 *
 * Survival past the SSH session is the hard part, and neither `nohup` nor
 * `setsid` is sufficient on its own here: the harness must be independent of the
 * session that started it. A systemd *transient unit* is tried first, because it
 * is owned by the user manager rather than the session, so it keeps running after
 * the connection closes. `--unit` makes a restart replace the previous instance
 * instead of colliding with it, and `--collect` reaps a failed unit instead of
 * leaving it behind.
 *
 * Two constraints are baked into the unit invocation, both learned from a real
 * host:
 *
 *  - **Output goes to a file, not to journald.** `journalctl --user` reports
 *    "No journal files were opened due to insufficient permissions" for a user
 *    who is not in the `systemd-journal` group, which is a common default, so the
 *    launch line would be unreadable exactly when it is needed.
 *  - **No `script(1)` pty wrapper.** A pty does make the harness line-buffer its
 *    launch line, but the wrapped process then failed to bind the port at all on
 *    the tested host. A readable-but-late log is strictly better than no
 *    listener, so buffering is tolerated and the caller polls (see
 *    {@link readLog} and the `startTimeoutMs` default).
 *
 * `file:` rather than `append:` because append arrived in systemd 240 and this
 * must keep working on 239 (RHEL 8), where an unsupported property makes
 * `systemd-run` fail outright. The log is truncated by the `: >` above anyway.
 *
 * The plain POSIX detach remains as the fallback for hosts with no user manager
 * (containers, macOS), where `setsid` is genuinely enough. Note that on a host
 * with `Linger=no` only the systemd path survives the last session ending.
 *
 * **The link secret never appears in a command line.** On a multi-user server
 * any argv — the remote `sh -c <script>`, `systemd-run --setenv=…` — is visible
 * to every user through `ps`, which is precisely the audience the secret exists
 * to keep out. It is therefore sent on the command's stdin (`input`), read by
 * the `read` builtin, written by the `printf` builtin into a 0600 file, and
 * picked up by {@link harnessWrapper}.
 *
 * @param {import('./config.js').ConnectionConfig} config
 * @param {string} dshPath
 * @param {{ secret?: string }} [options]
 * @returns {{ script: string, input: string | undefined }}
 *   the remote script (it reports which method won) and the stdin to send with it.
 */
export function startCommand(config, dshPath, options = {}) {
  const secret = options.secret
  if (secret !== undefined && !SECRET_PATTERN.test(secret)) {
    throw new Error('the link secret must be 32-128 lowercase hex characters')
  }
  const log = logPathFor(config.remotePort)
  const pid = pidPathFor(config.remotePort)
  const env = envPathFor(config.remotePort)
  const workspace = remoteHomePath(config.remoteWorkspace)
  const unit = unitNameFor(config.remotePort)
  const marker = runMarker(config.remotePort)

  // One argument list, used verbatim by both launch methods.
  const argv = [
    'sh',
    '-c',
    harnessWrapper(config.remotePort, dshPath),
    'sh',
    'env',
    `${LINK_MARKER_ENV}=${marker}`,
    'BROWSER=/bin/true',
    dshPath,
    '--profile',
    config.remoteProfile,
    '--no-open',
    '--port',
    String(config.remotePort),
  ]
  const command = argv.map(shq).join(' ')

  const label = `dsh via dsh-ssh-desktop (profile ${config.remoteProfile}, port ${String(config.remotePort)})`

  const secretLines = secret === undefined
    ? []
    : [
        'RD_SECRET=""',
        'IFS= read -r RD_SECRET || true',
        'case "$RD_SECRET" in',
        `  ''|*[!0-9a-f]*) echo "dsh-ssh-desktop: no usable link secret on stdin" >&2; exit 4 ;;`,
        'esac',
        // Subshell, so the restrictive umask applies to this file only and not to
        // the harness, whose own files must keep the user's normal permissions.
        `( umask 077; printf '${LINK_SECRET_ENV}=%s\\n' "$RD_SECRET" > "$RD_ENV" )`,
        'unset RD_SECRET',
      ]

  const script = [
    'set -u',
    'mkdir -p "$HOME/.dsh"',
    `: > ${log}`,
    `cd ${workspace} || { echo "dsh-ssh-desktop: workspace directory does not exist" >&2; exit 3; }`,
    `RD_UNIT=${shq(unit)}`,
    `RD_LOG=${log}`,
    `RD_ENV=${env}`,
    // A file left by an earlier start must never leak into this one.
    'rm -f "$RD_ENV"',
    ...secretLines,
    'RD_METHOD=nohup',
    'if command -v systemd-run >/dev/null 2>&1 && systemctl --user is-system-running >/dev/null 2>&1; then',
    `  if systemd-run --user --collect --unit="$RD_UNIT" --description=${shq(label)} \\`,
    `      --property=WorkingDirectory=${workspace} \\`,
    `      --property=StandardOutput=file:$RD_LOG \\`,
    `      --property=StandardError=file:$RD_LOG \\`,
    `      -- ${command} >/dev/null 2>&1; then`,
    '    RD_METHOD=systemd-run',
    '  fi',
    'fi',
    'if [ "$RD_METHOD" = nohup ]; then',
    '  if command -v setsid >/dev/null 2>&1; then',
    `    setsid nohup ${command} >> "$RD_LOG" 2>&1 < /dev/null &`,
    '    RD_METHOD=setsid',
    '  else',
    `    nohup ${command} >> "$RD_LOG" 2>&1 < /dev/null &`,
    '  fi',
    // The wrapper exec's all the way down, so this pid is the harness itself.
    `  echo $! > ${pid}`,
    '  disown 2>/dev/null || true',
    'fi',
    'printf "STARTED=%s\\n" "$RD_METHOD"',
  ].join('\n')

  return { script, input: secret === undefined ? undefined : `${secret}\n` }
}
