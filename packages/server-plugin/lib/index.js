/**
 * dsh-desktop-link — the server-side companion of dsh-ssh-desktop.
 *
 * Installed into the DSH profile that dsh-ssh-desktop starts on a server. It
 * lets the desktop that started this harness shake hands with it and hold a
 * lease on it (see ./link.js). It is an enhancement, never a requirement: the
 * desktop works against a server without it, and this plugin does nothing
 * unless that desktop started this process with a secret.
 *
 * Stopping is by SIGTERM to this process — the CLI's ordinary supervisor stop
 * request, which it handles with a clean exit 0 (upstream
 * apps/cli/src/profile-boot.ts) and the same signal `systemctl --user stop`
 * sends the unit the desktop started it in.
 *
 * @module dsh-desktop-link
 */

import { readFileSync } from 'node:fs'

import { createActivityWatcher } from './activity.js'
import { API_BASE, CAPABILITIES, PATHS, PROTOCOL, SECRET_HEADER, createLink } from './link.js'

/** Stable cordis plugin name. */
export const name = 'desktop-link'

/** Services required before the plugin can mount. */
export const inject = ['webServer']

/** No configuration: everything comes from the desktop that started the process. */
export const Config = undefined

export { API_BASE, CAPABILITIES, PATHS, PROTOCOL, SECRET_HEADER, createActivityWatcher, createLink }

/** This package's version, announced in the handshake. */
function packageVersion() {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * Mount the route family.
 * @param {any} ctx the cordis context.
 * @param {object} [overrides] tests only: replace the environment-derived parts.
 * @param {string} [overrides.secret]
 * @param {() => void} [overrides.terminate]
 */
export function apply(ctx, overrides = {}) {
  const link = createLink({
    secret: 'secret' in overrides ? overrides.secret : process.env.DSH_DESKTOP_LINK_SECRET,
    version: packageVersion(),
    terminate: overrides.terminate ?? (() => { process.kill(process.pid, 'SIGTERM') }),
    log: (message) => {
      try { ctx.logger?.('desktop-link')?.info?.(message) } catch { /* logging is best effort */ }
    },
  })

  // Finished tasks feed the desktop's notifications; only a desktop-started
  // process has anyone to tell.
  if (link.active && typeof ctx.on === 'function') {
    ctx.effect(() => ctx.on('session/event', createActivityWatcher(link.publish)), 'desktop-link: activity')
  }

  ctx.effect(() => {
    // Registered even without a secret, so these paths always answer a plain
    // 404 rather than falling through to the web app's index page.
    const disposers = Object.entries(link.handlers).map(([path, handler]) =>
      ctx.webServer.register({ kind: 'exact', path, handler }))
    return () => {
      for (const dispose of disposers) dispose()
      link.dispose()
    }
  }, 'desktop-link: routes')
}
