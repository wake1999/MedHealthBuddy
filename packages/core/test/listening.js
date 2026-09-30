/**
 * The listening probe is the input to a destructive decision: a false FREE makes
 * the app start a second harness on an occupied port, which dies with
 * `EADDRINUSE`. Both directions of error are silent, so the snippet's shape is
 * asserted here.
 *
 * Run: node test/listening.js
 */
import { strict as assert } from 'node:assert'
import { listeningCommand, stopRemote } from '../lib/remote.js'

let failures = 0
const check = async (label, fn) => {
  try {
    await fn()
    console.log(`ok   ${label}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${label}\n     ${error instanceof Error ? error.message : error}`)
  }
}

await check('the port is passed to ss in decimal, as a sport filter', () => {
  const command = listeningCommand(3080)
  // ss takes a decimal port, so a hex form can never match. This is the bug that
  // made the probe report FREE for an occupied port.
  assert.ok(command.includes("'sport = :3080'"), `expected a decimal sport filter in:\n${command}`)
  assert.equal(/\b0C08\b/.test(command), false, 'a hex port must not appear in the ss branch')
})

await check('detection needs no field parsing for ss', () => {
  const command = listeningCommand(3080)
  // ss does the filtering; any output means the port is bound.
  assert.ok(command.includes('grep -q .'))
  assert.equal(/\$NF/.test(command), false, 'field-index matching was removed')
  assert.equal(/\$4 ~ p/.test(command), false, 'field-index matching was removed')
})

await check('the rungs are ordered ss, then netstat, then /proc/net/tcp', () => {
  const command = listeningCommand(3080)
  const ssAt = command.indexOf('command -v ss')
  const netstatAt = command.indexOf('command -v netstat')
  const procAt = command.indexOf('/proc/net/tcp')
  assert.ok(ssAt >= 0, 'ss branch present')
  assert.ok(netstatAt > ssAt, 'netstat must be the second choice')
  assert.ok(procAt > netstatAt, '/proc/net/tcp must be the last resort')
})

await check('the netstat branch matches the decimal port in the local address column', () => {
  const command = listeningCommand(3080)
  assert.ok(command.includes('index($4, p) > 0'))
  assert.ok(command.includes('p=":3080"'))
})

await check('the /proc fallback converts to padded uppercase hex itself', () => {
  const command = listeningCommand(3080)
  // Done inside the remote shell so the padding is the shell's job, not a caller's.
  assert.ok(command.includes("printf '%04X' 3080"))
  assert.ok(command.includes('$4 == "0A"'))
})

await check('each rung returns an explicit status so UNKNOWN stays reachable', () => {
  const command = listeningCommand(3080)
  assert.ok(command.includes('return 0'))
  assert.ok(command.includes('return 1'))
  // Only "no tool at all" is UNKNOWN; a tool that reports nothing is FREE.
  assert.ok(command.includes('return 2'))
  assert.ok(command.includes('echo UNKNOWN'))
})

await check('the wrapper distinguishes the UNKNOWN status from a plain failure', () => {
  const command = listeningCommand(3080)
  // `rc=$?` must be captured before the test, and the comparison is against 2.
  assert.ok(command.includes('rd_listen && echo LISTENING || { rc=$?; [ "$rc" = 2 ] && echo UNKNOWN || echo FREE; }'))
})

await check('the stop script shares the probe detector and gates its port fallback on it', async () => {
  let sent = ''
  await stopRemote({ async exec(command) { sent = command; return { code: 0, stdout: 'FREE\nKILLED=no\n', stderr: '' } } }, { remotePort: 3080 })
  assert.ok(sent.includes("'sport = :3080'"), 'the stop must detect the port the same way the probe does')
  // The fallback runs whenever the port is still held, not only when nothing
  // else was killed: an exec'd harness no longer carries the marker in argv.
  assert.ok(/if rd_listen; then\n\s+if command -v fuser/.test(sent))
  assert.equal(sent.includes('if [ "$killed" = no ]'), false)
})

await check('the stop script\'s pgrep pattern cannot match the stop script itself', async () => {
  // Regression from a real host: the script is the argv of the shell running
  // it, so a pattern that matches its own text makes `kill $pids` kill the
  // stop before it reports back.
  let sent = ''
  await stopRemote({ async exec(command) { sent = command; return { code: 0, stdout: 'FREE\nKILLED=no\n', stderr: '' } } }, { remotePort: 3181 })
  const quoted = /pgrep -f '([^']+)'/.exec(sent)
  assert.ok(quoted !== null, 'expected a single-quoted pgrep pattern')
  const pattern = new RegExp(quoted[1])
  assert.equal(pattern.test(sent), false, `pattern ${quoted[1]} matches the script that contains it`)
  assert.equal(pattern.test('env DSH_SSH_DESKTOP_MARKER=dsh-ssh-desktop:3181 BROWSER=/bin/true dsh'), true)
})

await check('a stop script that never reports back is an unknown outcome, not "nothing running"', async () => {
  const result = await stopRemote({ async exec() { return { code: 143, stdout: '', stderr: '', timedOut: false } } }, { remotePort: 3181 })
  assert.equal(result.stopped, false)
  assert.match(result.note, /did not report back \(exit 143\)/)
})

await check('a low port needs no special casing in the ss branch', () => {
  // The old hex form needed zero padding; the decimal filter does not.
  assert.ok(listeningCommand(80).includes("'sport = :80'"))
})

if (failures > 0) {
  console.error(`\n${String(failures)} listening test(s) failed`)
  process.exit(1)
}
console.log('\nall listening tests passed')
