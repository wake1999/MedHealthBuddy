/**
 * Contract test for the package surface the harness consumes: the manifest,
 * the bundle patch, the plugin exports, and what `apply` registers.
 *
 * Run: node test/contract.js
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

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

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const plugin = await import('../lib/index.js')

/** A cordis-shaped context that records what the plugin does with it. */
function fakeContext() {
  const routes = []
  const disposed = []
  /** @type {Map<string, Function>} */
  const listeners = new Map()
  const effects = []
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => { disposed.push(route.path) }
      },
    },
    on(name, listener) {
      listeners.set(name, listener)
      return () => { listeners.delete(name) }
    },
    effect(fn) {
      const dispose = fn()
      effects.push(dispose)
      return dispose
    },
    unload: () => {
      for (const dispose of effects.splice(0)) if (typeof dispose === 'function') dispose()
    },
  }
  return { ctx, routes, disposed, listeners }
}

await check('the manifest is an ESM package with a bundle patch and a web client half', () => {
  assert.equal(manifest.name, 'dsh-desktop-link')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.main, 'lib/index.js')
  assert.equal(manifest.exports['.'].default, './lib/index.js')
  assert.equal(manifest.exports['./client'].default, './lib/client.js')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'), 'the header slot lives there')
  assert.ok(manifest.files.includes('lib/**/*.js'))
  assert.equal(manifest.dependencies, undefined, 'the plugin must install with no dependencies')
})

await check('the bundle patch inserts this package by its exact name', () => {
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- insert:/)
  assert.match(patch, new RegExp(`name: ${manifest.name}\\s*$`, 'm'))
})

await check('the plugin exports the cordis contract', () => {
  assert.equal(plugin.name, 'desktop-link')
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plugin.inject, ['webServer'])
})

await check('apply registers exactly the four exact routes, each once, and unload removes them', () => {
  const { ctx, routes, disposed } = fakeContext()
  plugin.apply(ctx, { secret: 'ab'.repeat(32), terminate: () => {} })
  assert.deepEqual(routes.map((r) => `${r.kind} ${r.path}`).sort(), [
    'exact /api/dsh-desktop-link/events',
    'exact /api/dsh-desktop-link/hello',
    'exact /api/dsh-desktop-link/lease',
    'exact /api/dsh-desktop-link/release',
  ])
  assert.ok(routes.every((r) => typeof r.handler === 'function'))
  ctx.unload()
  assert.equal(disposed.length, 4)
})

await check('with a secret, session events are watched; unload stops watching', () => {
  const { ctx, listeners } = fakeContext()
  plugin.apply(ctx, { secret: 'ab'.repeat(32), terminate: () => {} })
  assert.equal(typeof listeners.get('session/event'), 'function')
  ctx.unload()
  assert.equal(listeners.size, 0)
})

await check('routes are registered even without a secret, so they never fall through to the app', () => {
  const { ctx, routes, listeners } = fakeContext()
  plugin.apply(ctx, { secret: undefined, terminate: () => {} })
  assert.equal(routes.length, 4)
  assert.equal(listeners.size, 0, 'nobody to tell, so nothing is watched')
})

await check('the node half requires only node: builtins and its own files', () => {
  for (const file of ['lib/index.js', 'lib/link.js', 'lib/activity.js']) {
    const source = readFileSync(join(root, file), 'utf8')
    const specifiers = [...source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
    for (const specifier of specifiers) {
      assert.ok(specifier.startsWith('node:') || specifier.startsWith('./'), `${file} imports ${specifier}`)
    }
  }
})

if (failures > 0) {
  console.error(`\n${String(failures)} contract test(s) failed`)
  process.exit(1)
}
console.log('\nall contract tests passed')
