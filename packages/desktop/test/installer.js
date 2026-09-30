/**
 * The install runner: it inspects read-only, remembers the plan it showed,
 * runs exactly that plan in order, stops at the first failure, and uploads the
 * plugin on stdin — all against a fake transport.
 *
 * Run: node test/installer.js
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Installer } from '../src/main/installer.js'

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

const CLEAN = [
  'HOME=/home/test', 'ARCH=x86_64', 'OS=Linux', 'HAS_CURL=yes', 'HAS_TAR=yes', 'HAS_XZ=yes', 'HAS_SHA256SUM=yes',
  'DSH=', 'PNPM=', 'PROFILE=no', 'PLUGIN=', 'PING_OFFICIAL=200 1.4', 'PING_MIRROR=200 0.1', 'DSH_AVAILABLE=0.1.7-rc.2',
].join('\n')

const scratch = mkdtempSync(join(tmpdir(), 'dsh-installer-'))
const pluginPath = join(scratch, 'plugin.tgz')
writeFileSync(pluginPath, Buffer.from('fake tarball'))

/**
 * @param {{ failOn?: string }} [options]
 */
function setup(options = {}) {
  /** @type {{ command: string, input?: string }[]} */
  const execs = []
  let transports = 0
  const installer = new Installer({
    manager: { list: () => [{ id: 't1', target: 'test', remoteProfile: 'web', remotePort: 3081 }] },
    plugin: () => ({ version: '0.2.0', path: pluginPath }),
    transportFactory: () => {
      transports += 1
      return {
        async connect() {},
        async exec(command, opts = {}) {
          execs.push({ command, input: opts.input })
          if (command.includes('PING_MIRROR')) return { code: 0, stdout: CLEAN, stderr: '' }
          const failing = options.failOn !== undefined && command.includes(options.failOn)
          return failing ? { code: 1, stdout: '', stderr: 'npm ERR! network timeout' } : { code: 0, stdout: 'ok\n', stderr: '' }
        },
        dispose() {},
      }
    },
  })
  return { installer, execs, transports: () => transports }
}

await check('inspect is read-only and returns the plan it will run', async () => {
  const { installer, execs } = setup()
  const { plan, source } = await installer.inspect('t1')
  assert.equal(execs.length, 1)
  assert.equal(source, 'mirror')
  assert.deepEqual(plan.steps.map((s) => s.id), ['node', 'pnpm', 'dsh', 'plugin'])
})

await check('run executes exactly the shown plan, in order, and uploads the plugin on stdin', async () => {
  const { installer, execs } = setup()
  await installer.inspect('t1')
  /** @type {string[]} */
  const progress = []
  const result = await installer.run('t1', (p) => { progress.push(`${p.id}:${p.status}`) })
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(progress, ['node:running', 'node:done', 'pnpm:running', 'pnpm:done', 'dsh:running', 'dsh:done', 'plugin:running', 'plugin:done'])
  const steps = execs.slice(1)
  assert.match(steps[0].command, /sha256sum -c/)
  assert.match(steps[1].command, /pnpm@11/)
  assert.match(steps[2].command, /@deepseek-ai\/dsh@latest/)
  assert.match(steps[3].command, /base64 -d/)
  assert.equal(Buffer.from(String(steps[3].input).replace(/\n/g, ''), 'base64').toString(), 'fake tarball')
  assert.equal(steps.slice(0, 3).every((s) => s.input === undefined), true)
})

await check('a failed step stops the run and says which', async () => {
  const { installer, execs } = setup({ failOn: '@deepseek-ai/dsh@' })
  await installer.inspect('t1')
  /** @type {any[]} */
  const progress = []
  const result = await installer.run('t1', (p) => { progress.push(p) })
  assert.deepEqual(result, { ok: false, failedStep: 'dsh' })
  assert.equal(progress.at(-1).status, 'failed')
  assert.match(progress.at(-1).output, /network timeout/)
  assert.equal(execs.some((e) => e.command.includes('base64 -d')), false, 'nothing after the failure runs')
})

await check('there is no run without a plan the user saw, and no second run of one', async () => {
  const { installer } = setup()
  await assert.rejects(() => installer.run('t1', () => {}), /过期/)
  await installer.inspect('t1')
  await installer.run('t1', () => {})
  await assert.rejects(() => installer.run('t1', () => {}), /过期/, 'a plan is used once')
})

await check('an unknown connection is refused', async () => {
  const { installer } = setup()
  await assert.rejects(() => installer.inspect('nope'), /unknown connection/)
})

rmSync(scratch, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\n${String(failures)} installer test(s) failed`)
  process.exit(1)
}
console.log('\nall installer tests passed')
