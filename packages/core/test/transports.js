/**
 * The system-ssh transport's local, network-free parts: the shared option list
 * and the loopback listener probes. Carried over from the old plugin's
 * integration test, minus everything that exercised ssh2.
 *
 * Run: node test/transports.js
 */
import { strict as assert } from 'node:assert'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

import { SystemSshTransport, baseSshArgs, probeListener, sshCommand, waitForListener } from '../lib/transports.js'

let failures = 0
const check = async (label, fn) => {
  try {
    await fn()
    console.log(`ok   ${label}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${label}\n     ${error && error.stack ? error.stack : error}`)
  }
}

const server = createServer((socket) => socket.end())
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const openPort = /** @type {import('node:net').AddressInfo} */ (server.address()).port

await check('baseSshArgs renders the options every system-ssh call shares', () => {
  const args = baseSshArgs()
  // BatchMode is what stops an unattended app from hanging on a prompt.
  assert.ok(args.includes('BatchMode=yes'))
  assert.ok(args.includes('ConnectTimeout=15'))
  assert.ok(args.includes('ServerAliveInterval=15'))
  // No multiplexing: on Windows OpenSSH the control master fails to start at all
  // (`getsockname failed: Not a socket`), so the transport must never ask for one.
  assert.equal(args.some((a) => a.startsWith('ControlPath=') || a.startsWith('ControlMaster=')), false)
  assert.equal(args.includes('-M'), false)
})

await check('baseSshArgs leaves identity, port and agent to ~/.ssh/config', () => {
  const args = baseSshArgs()
  for (const flag of ['-i', '-p', '-J', '-A', '-l']) assert.equal(args.includes(flag), false, flag)
})

await check('on Windows the system OpenSSH is used, not whichever ssh PATH finds first', () => {
  const command = sshCommand()
  if (process.platform !== 'win32') {
    assert.equal(command, 'ssh')
    return
  }
  const bundled = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
  assert.equal(command, existsSync(bundled) ? bundled : 'ssh')
  assert.equal(/\\Git\\/i.test(command), false, "Git for Windows' MSYS ssh must never be picked")
})

await check('a listening loopback port is reported as such, a closed one is not', async () => {
  assert.equal(await probeListener(openPort), true)
  assert.equal(await probeListener(1), false)
})

await check('waitForListener resolves false instead of hanging on a dead port', async () => {
  const started = Date.now()
  const ok = await waitForListener(1, 600)
  assert.equal(ok, false)
  assert.ok(Date.now() - started < 5_000)
})

await check('dispose without a forward is harmless and idempotent', () => {
  const transport = new SystemSshTransport(/** @type {any} */ ({ target: 'devbox' }))
  transport.dispose()
  transport.dispose()
  assert.equal(transport.forward, null)
})

server.close()

if (failures > 0) {
  console.error(`\n${String(failures)} transport test(s) failed`)
  process.exit(1)
}
console.log('\nall transport tests passed')
