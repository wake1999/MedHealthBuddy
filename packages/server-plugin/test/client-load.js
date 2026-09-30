/**
 * Load the browser half against a fake slot registry, with and without the
 * dsh-ssh-desktop bridge.
 *
 * Not a browser: it catches a bundle that throws at load, requires something
 * the loader does not supply, registers against the wrong slot, or renders
 * the button where it should not.
 *
 * Run: node test/client-load.js
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

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

// ------------------------------------------------------------------ shims

class El {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.parentElement = null; this.attributes = new Map(); this.textContent = '' }
  setAttribute(k, v) { this.attributes.set(k, String(v)) }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null }
  appendChild(node) { node.parentElement = this; this.children.push(node); return node }
  remove() {
    if (this.parentElement === null) return
    const siblings = this.parentElement.children
    siblings.splice(siblings.indexOf(this), 1)
    this.parentElement = null
  }
}

/** A React stand-in: elements are plain objects; state is seeded per render. */
const stateSeed = []
const ReactShim = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [stateSeed.length > 0 ? stateSeed.shift() : initial, () => {}],
}

/**
 * Evaluate the bundle in a fresh fake page.
 * @param {unknown} bridge what `window.dshSshDesktop` holds.
 */
function load(bridge) {
  const head = new El('head')
  const document = {
    head,
    createElement: (tag) => new El(tag),
    querySelector: (sel) => {
      const m = /^style\[([a-z-]+)\]$/.exec(sel)
      if (m === null) throw new Error(`unexpected selector: ${sel}`)
      return head.children.find((c) => c.getAttribute(m[1]) !== null) ?? null
    },
  }
  let loaded
  const window = {
    dshSshDesktop: bridge,
    __ModuleLoader__: {
      load({ id, factory }) {
        assert.equal(id, 'dsh-desktop-link')
        loaded = factory((name) => {
          if (name === 'react') return ReactShim
          throw new Error(`unexpected require: ${name}`)
        })
      },
    },
  }
  globalThis.window = window
  globalThis.document = document
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', source)(window, document)
  const registrations = []
  const effects = []
  const ctx = {
    effect: (fn) => { effects.push(fn()) },
    slots: {
      inject: (_name, fn) => { effects.push(fn()) },
      register: (options, component) => {
        const entry = { options, component }
        registrations.push(entry)
        return () => { registrations.splice(registrations.indexOf(entry), 1) }
      },
    },
  }
  loaded.apply(ctx)
  const unload = () => { for (const d of effects.splice(0)) if (typeof d === 'function') d() }
  return { loaded, head, registrations, unload }
}

/** Render the registered component for a session whose cwd is `cwd`. */
function render(component, cwd) {
  const state = { byId: { s1: { cwd } } }
  return component({ sessionId: 's1', useSessions: (select) => select(state) })
}

const calls = []
const BRIDGE = {
  protocol: 1,
  capabilities: ['notify', 'setBadge', 'revealInEditor'],
  revealInEditor: async (input) => { calls.push(input) },
}

// ------------------------------------------------------------------- tests

await check('the bundle declares the plugin contract and needs only react', () => {
  const { loaded } = load(undefined)
  assert.equal(loaded.name, 'desktop-link')
  assert.equal(typeof loaded.apply, 'function')
  assert.deepEqual(loaded.inject, ['slots'])
})

await check('without the bridge (a plain browser) it registers nothing', () => {
  for (const bridge of [undefined, null, {}, { protocolVersion: 1 }, { protocol: 2, capabilities: ['revealInEditor'] }, { protocol: 1, capabilities: [] }]) {
    const { registrations, head } = load(bridge)
    assert.equal(registrations.length, 0, JSON.stringify(bridge))
    assert.equal(head.children.length, 0, 'no stylesheet either')
  }
})

await check('the official desktop\'s window.dshDesktop is not mistaken for ours', () => {
  const { registrations } = load(undefined)
  globalThis.window.dshDesktop = { protocolVersion: 1 }
  assert.equal(registrations.length, 0)
})

await check('with the bridge it adds one header utility beside Open In', () => {
  const { registrations, head } = load(BRIDGE)
  assert.equal(registrations.length, 1)
  const [{ options }] = registrations
  assert.equal(options.name, 'conversation.session.header.utilities')
  assert.equal(options.id, 'dsh-desktop-link-vscode')
  assert.equal(options.order, -9)
  const css = head.children[0]?.textContent ?? ''
  assert.ok(css.includes('[data-dsh-desktop-link-open]'))
  assert.equal(/(^|[^:])\/\//.test(css), false, 'no // comments in the injected CSS')
})

await check('the button asks the desktop to open the session directory, nothing else', async () => {
  const { registrations } = load(BRIDGE)
  const tree = render(registrations[0].component, '/home/dev/work')
  assert.equal(tree.type, 'button')
  assert.ok(tree.children.includes('VS Code'))
  assert.match(tree.props.title, /\/home\/dev\/work/)
  calls.length = 0
  tree.props.onClick()
  await Promise.resolve()
  assert.deepEqual(calls, [{ path: '/home/dev/work' }])
})

await check('no directory yet, no button', () => {
  const { registrations } = load(BRIDGE)
  assert.equal(render(registrations[0].component, undefined), null)
  assert.equal(render(registrations[0].component, ''), null)
})

await check('a refused open shows on the button', () => {
  const { registrations } = load(BRIDGE)
  stateSeed.push('failed')
  const tree = render(registrations[0].component, '/w')
  assert.ok(tree.children.includes('无法打开'))
  assert.equal(tree.props['data-failed'], '')
})

await check('unload removes the registration and the stylesheet', () => {
  const { registrations, head, unload } = load(BRIDGE)
  unload()
  assert.equal(registrations.length, 0)
  assert.equal(head.children.length, 0)
})

if (failures > 0) {
  console.error(`\n${String(failures)} client test(s) failed`)
  process.exit(1)
}
console.log('\nall client tests passed')
