/**
 * Installing or upgrading DSH and the server plugin on a connection's server
 * (M4). The scripts and the planning live in @dsh-ssh/core/install; this runs
 * them over a transport of its own and remembers, per connection, the plan the
 * user was shown — `run` executes exactly that plan, never a fresh one the
 * user has not seen.
 *
 * Free of Electron, so it can be tested with a fake transport.
 *
 * @module medhealthbuddy-desktop/installer
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SystemSshTransport, inspectCommand, parseInspection, planInstall, pluginUploadInput, stepScript } from '@dsh-ssh/core'

const here = dirname(fileURLToPath(import.meta.url))

/** A plan is good for this long; after that the server is inspected again. */
const PLAN_TTL_MS = 15 * 60_000

/**
 * The dsh-desktop-link package this app ships: the packed tarball in the
 * app's resources in a packaged build, or `dist/` of this repository in
 * development.
 * @returns {{ version: string, path: string } | undefined}
 */
export function bundledPlugin() {
  // Packaged: the installer puts `dsh-desktop-link-<version>.tgz` in resources.
  if (typeof process.resourcesPath === 'string' && existsSync(process.resourcesPath)) {
    const packed = readdirSync(process.resourcesPath)
      .map((name) => /^dsh-desktop-link-(\d+\.\d+\.\d+(?:-[\w.]+)?)\.tgz$/.exec(name))
      .find((match) => match !== null)
    if (packed !== undefined && packed !== null) return { version: packed[1], path: join(process.resourcesPath, packed[0]) }
  }
  // Development: dist/ of this repository, for the server-plugin package's version.
  const manifest = join(here, '..', '..', '..', 'server-plugin', 'package.json')
  let version
  try {
    version = JSON.parse(readFileSync(manifest, 'utf8')).version
  } catch {
    version = undefined
  }
  if (version === undefined) return undefined
  const path = join(here, '..', '..', '..', '..', 'dist', `dsh-desktop-link-${String(version)}.tgz`)
  return existsSync(path) ? { version, path } : undefined
}

/**
 * @typedef {object} StepProgress
 * @property {string} id
 * @property {'running' | 'done' | 'failed'} status
 * @property {string} output  the tail of what the step printed.
 */

export class Installer {
  /**
   * @param {object} options
   * @param {{ list: () => any[] }} options.manager
   * @param {(config: any) => any} [options.transportFactory]
   * @param {() => { version: string, path: string } | undefined} [options.plugin]
   */
  constructor(options) {
    this.manager = options.manager
    this.transportFactory = options.transportFactory ?? ((config) => new SystemSshTransport(config))
    this.plugin = options.plugin ?? bundledPlugin
    /** @type {Map<string, { facts: any, plan: any, source: 'official' | 'mirror', dshTag: string, at: number }>} */
    this.plans = new Map()
    /** Connections with an install in flight. */
    this.running = new Set()
  }

  /** @param {string} id */
  #config(id) {
    const config = this.manager.list().find((c) => c.id === id)
    if (config === undefined) throw new Error('unknown connection')
    return config
  }

  /**
   * @template T
   * @param {any} config
   * @param {(transport: any) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async #withTransport(config, fn) {
    const transport = this.transportFactory({ ...config })
    await transport.connect()
    try {
      return await fn(transport)
    } finally {
      try { transport.dispose() } catch { /* gone */ }
    }
  }

  /**
   * Look at the server and decide what to do. Read-only on the server.
   * @param {string} id
   * @param {{ dshTag?: string, source?: 'official' | 'mirror' }} [options]
   */
  async inspect(id, options = {}) {
    const config = this.#config(id)
    const plugin = this.plugin()
    const dshTag = options.dshTag === 'next' ? 'next' : 'latest'
    const result = await this.#withTransport(config, (t) => t.exec(inspectCommand(config, { dshTag }), { timeoutMs: 60_000 }))
    if (result.code !== 0 && result.stdout.trim() === '') {
      throw new Error(`检查服务器失败：${result.stderr.trim() || `exit ${String(result.code)}`}`)
    }
    const facts = parseInspection(result.stdout)
    const plan = planInstall(facts, {
      profile: config.remoteProfile,
      pluginVersion: plugin?.version ?? '0.0.0',
      dshTag,
      sourceOverride: options.source,
    })
    if (plugin === undefined) {
      plan.steps = plan.steps.filter((s) => s.id !== 'plugin')
      plan.notes.push('找不到本应用自带的服务器插件包，跳过插件（开发环境请先在 packages/server-plugin 运行 pnpm pack）。')
    }
    const source = options.source ?? facts.source ?? 'mirror'
    this.plans.set(id, { facts, plan, source, dshTag, at: Date.now() })
    return { facts, plan, source, dshTag, pluginVersion: plugin?.version ?? null }
  }

  /**
   * Run the plan the user was shown for this connection, step by step. A
   * failed step stops the run; everything before it stays installed, and every
   * step is safe to run again.
   * @param {string} id
   * @param {(progress: StepProgress) => void} onProgress
   * @returns {Promise<{ ok: boolean, failedStep?: string }>}
   */
  async run(id, onProgress) {
    const shown = this.plans.get(id)
    if (shown === undefined || Date.now() - shown.at > PLAN_TTL_MS) throw new Error('安装计划已过期，请重新检查服务器')
    if (this.running.has(id)) throw new Error('这台服务器正在安装中')
    const config = this.#config(id)
    this.running.add(id)
    this.plans.delete(id)
    try {
      return await this.#withTransport(config, async (transport) => {
        for (const step of shown.plan.steps) {
          onProgress({ id: step.id, status: 'running', output: '' })
          /** @type {string | undefined} */
          let input
          if (step.id === 'plugin') {
            const plugin = this.plugin()
            if (plugin === undefined) throw new Error('找不到服务器插件包')
            input = pluginUploadInput(readFileSync(plugin.path))
          }
          const plugin = this.plugin()
          const { script, timeoutMs } = stepScript(step.id, {
            profile: config.remoteProfile,
            source: shown.source,
            arch: shown.facts.arch,
            dshTag: shown.dshTag,
            pluginVersion: plugin?.version,
          })
          const result = await transport.exec(script, { timeoutMs, input })
          const output = tail(`${result.stdout}\n${result.stderr}`)
          if (result.code !== 0 || result.timedOut) {
            onProgress({ id: step.id, status: 'failed', output: result.timedOut ? `${output}\n（超时）` : output })
            return { ok: false, failedStep: step.id }
          }
          onProgress({ id: step.id, status: 'done', output })
        }
        return { ok: true }
      })
    } finally {
      this.running.delete(id)
    }
  }
}

/** The last lines of a step's output, without terminal colour codes. */
function tail(text, lines = 40) {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, '').replace(/\r(?!\n)/g, '\n')
  return clean.split('\n').map((l) => l.trimEnd()).filter((l) => l !== '').slice(-lines).join('\n')
}
