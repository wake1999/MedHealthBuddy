/**
 * The installer's pure parts: parsing an inspection, planning, and the step
 * scripts' shape. Plus `ssh -G` parsing.
 *
 * Run: node test/install.js
 */
import { strict as assert } from 'node:assert'

import {
  compareVersions, inspectCommand, nodeSatisfies, parseInspection, planInstall, pluginUploadInput, stepScript,
} from '../lib/install.js'
import { describeDestination, parseSshG } from '../lib/ssh-config.js'

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

const balanced = (script) => (script.match(/'/g) ?? []).length % 2 === 0

/** An inspection as the script prints it. */
function inspection(overrides = {}) {
  const facts = {
    HOME: '/home/test', ARCH: 'x86_64', OS: 'Linux', HAS_CURL: 'yes', HAS_TAR: 'yes', HAS_XZ: 'yes', HAS_SHA256SUM: 'yes',
    MANAGED_NODE: '', DSH: '', PNPM: '', PROFILE: 'no', PLUGIN: '', PING_OFFICIAL: '200 1.44', PING_MIRROR: '200 0.09',
    DSH_AVAILABLE: '0.1.7-rc.2', ...overrides,
  }
  const nodes = /** @type {string[]} */ (overrides.NODECAND ?? [])
  return [...Object.entries(facts).filter(([k]) => k !== 'NODECAND').map(([k, v]) => `${k}=${String(v)}`), ...nodes.map((n) => `NODECAND=${n}`)].join('\n')
}

const PLAN = { profile: 'web', pluginVersion: '0.2.0' }

check('version helpers follow DSH\'s engine range and semver order', () => {
  for (const ok of ['v24.0.0', 'v22.19.0', 'v25.1.0', '24.21.0']) assert.equal(nodeSatisfies(ok), true, ok)
  for (const bad of ['v22.18.9', 'v20.11.0', 'v10.24.0', 'none', '', undefined]) assert.equal(nodeSatisfies(bad), false, String(bad))
  assert.ok(compareVersions('0.2.0', '0.1.0') > 0)
  assert.ok(compareVersions('0.2.0-rc.2', '0.2.0') < 0)
  assert.ok(compareVersions('0.2.0-rc.2', '0.2.0-rc.1') > 0)
  assert.equal(compareVersions('v24.1.0', '24.1.0'), 0)
})

check('the inspection script is read-only and well quoted', () => {
  const script = inspectCommand({ remoteProfile: 'web' })
  assert.ok(balanced(script))
  for (const writer of ['npm install', 'rm ', 'mkdir', 'ln -s', '> "$', 'tar -x']) assert.equal(script.includes(writer), false, writer)
  assert.match(script, /registry\.npmmirror\.com\/-\/ping/)
  assert.match(script, /"latest":/)
  assert.match(inspectCommand({ remoteProfile: 'web' }, { dshTag: 'next' }), /"next":/)
  assert.match(inspectCommand({ remoteProfile: 'web' }, { dshTag: '"; rm -rf ~' }), /"latest":/, 'an unknown tag falls back')
})

check('a clean account: Node, pnpm, DSH and the plugin, from the faster mirror', () => {
  const facts = parseInspection(inspection())
  assert.equal(facts.arch, 'x64')
  assert.equal(facts.source, 'mirror')
  assert.equal(facts.node, undefined)
  const plan = planInstall(facts, PLAN)
  assert.deepEqual(plan.blockers, [])
  assert.deepEqual(plan.steps.map((s) => s.id), ['node', 'pnpm', 'dsh', 'plugin'])
  assert.match(plan.steps[2].title, /0\.1\.7-rc\.2/)
})

check('a system Node is not used for npm -g, which would write outside $HOME', () => {
  const facts = parseInspection(inspection({ NODECAND: ['/usr/bin/node v24.1.0'] }))
  assert.equal(facts.managedNode, false)
  const [first] = planInstall(facts, PLAN).steps
  assert.equal(first.id, 'node')
  assert.match(first.detail, /不在家目录里/)
})

check('an up-to-date managed install needs nothing', () => {
  const facts = parseInspection(inspection({
    NODECAND: ['/home/test/.local/opt/node/bin/node v24.21.0'],
    DSH: '/home/test/.local/opt/node/bin/dsh', DSH_VERSION: '0.1.7-rc.2', PNPM: '/home/test/.local/opt/node/bin/pnpm',
    PROFILE: 'yes', PLUGIN: '0.2.0',
  }))
  const plan = planInstall(facts, PLAN)
  assert.deepEqual(plan.steps, [])
  assert.equal(plan.notes.length, 2)
})

check('an older DSH and plugin are upgraded; an unmanaged dsh is left alone', () => {
  const managed = parseInspection(inspection({
    NODECAND: ['/home/test/.local/opt/node/bin/node v24.21.0'],
    DSH: '/home/test/.local/opt/node/bin/dsh', DSH_VERSION: 'dsh 0.1.7-rc.1', PNPM: '/home/test/.local/opt/node/bin/pnpm',
    PROFILE: 'yes', PLUGIN: '0.1.0',
  }))
  assert.equal(managed.dshVersion, '0.1.7-rc.1', 'the version is picked out of the --version line')
  assert.deepEqual(planInstall(managed, PLAN).steps.map((s) => s.id), ['dsh', 'plugin'])
  const foreign = parseInspection(inspection({
    NODECAND: ['/home/test/.local/opt/node/bin/node v24.21.0'], PNPM: '/home/test/.local/opt/node/bin/pnpm',
    DSH: '/home/test/.local/bin/dsh', DSH_VERSION: '0.1.0', PLUGIN: '0.2.0',
  }))
  const plan = planInstall(foreign, PLAN)
  assert.deepEqual(plan.steps, [])
  assert.ok(plan.notes.some((n) => n.includes('不是本应用管理的安装')))
})

check('missing tools, no network or an odd CPU block the plan with reasons', () => {
  assert.ok(planInstall(parseInspection(inspection({ HAS_XZ: 'no' })), PLAN).blockers.some((b) => b.includes('xz')))
  assert.ok(planInstall(parseInspection(inspection({ PING_OFFICIAL: 'fail', PING_MIRROR: '000 6.0' })), PLAN).blockers.some((b) => b.includes('连不上')))
  assert.ok(planInstall(parseInspection(inspection({ ARCH: 'riscv64' })), PLAN).blockers.some((b) => b.includes('架构')))
  assert.ok(planInstall(parseInspection(inspection({ OS: 'Darwin' })), PLAN).blockers.some((b) => b.includes('Linux')))
})

check('the source can be forced, and the official one wins when faster', () => {
  assert.equal(parseInspection(inspection({ PING_OFFICIAL: '200 0.05', PING_MIRROR: '200 0.20' })).source, 'official')
  const plan = planInstall(parseInspection(inspection()), { ...PLAN, sourceOverride: 'official' })
  assert.match(plan.steps.find((s) => s.id === 'pnpm')?.command ?? '', /registry\.npmjs\.org/)
})

check('step scripts: home only, checksummed, well quoted', () => {
  const node = stepScript('node', { profile: 'web', source: 'mirror', arch: 'x64' }).script
  assert.ok(balanced(node))
  assert.match(node, /sha256sum -c/)
  assert.match(node, /\.local\/opt/)
  assert.match(node, /grep -o '"version":"v24\\\.\[0-9\]\*\\\.\[0-9\]\*"'/)
  assert.throws(() => stepScript('node', { profile: 'web', source: 'mirror', arch: 'x86' }))
  const dsh = stepScript('dsh', { profile: 'web', source: 'official', dshTag: 'next' }).script
  assert.match(dsh, /npm install -g @deepseek-ai\/dsh@next --registry 'https:\/\/registry\.npmjs\.org'/)
  const plugin = stepScript('plugin', { profile: "we'b", source: 'mirror', pluginVersion: '0.2.0' }).script
  assert.ok(balanced(plugin))
  assert.match(plugin, /base64 -d/)
  assert.match(plugin, /plugin --profile 'we'\\''b' add/)
  assert.throws(() => stepScript('plugin', { profile: 'web', source: 'mirror', pluginVersion: '1; rm -rf ~' }))
  assert.throws(() => stepScript('node', { profile: 'web', source: 'nowhere', arch: 'x64' }))
  for (const script of [node, dsh, plugin]) {
    assert.equal(/\bsudo\b/.test(script), false)
    assert.equal(/(^|\s)\/(usr|opt|etc)\//m.test(script.replace(/\/usr\/bin\/env/g, '')), false, 'nothing outside $HOME')
  }
})

check('the plugin travels as wrapped base64', () => {
  const input = pluginUploadInput(Buffer.alloc(200, 7))
  assert.ok(input.split('\n').every((line) => line.length <= 76))
  assert.deepEqual(Buffer.from(input.replace(/\n/g, ''), 'base64'), Buffer.alloc(200, 7))
})

check('ssh -G output: host, user, port and jump host, first value wins', () => {
  const text = 'user dev\nhostname 10.0.0.9\nport 2222\nproxyjump bastion\nidentityfile ~/.ssh/id_x\nhostname other\n'
  const destination = parseSshG(text)
  assert.deepEqual(destination, { hostname: '10.0.0.9', user: 'dev', port: 2222, proxyJump: 'bastion', proxyCommand: false })
  assert.equal(describeDestination(/** @type {any} */ (destination)), 'dev@10.0.0.9:2222 · 经 bastion')
  assert.equal(describeDestination(/** @type {any} */ (parseSshG('user me\nhostname h\nport 22\nproxyjump none\n'))), 'me@h')
  assert.equal(parseSshG('garbage'), undefined)
  assert.equal(JSON.stringify(destination).includes('id_x'), false, 'identity files are not kept')
})

if (failures > 0) {
  console.error(`\n${String(failures)} install test(s) failed`)
  process.exit(1)
}
console.log('\nall install tests passed')
