/**
 * @dsh-ssh/core — the connection engine behind medhealthbuddy-desktop.
 *
 * Pure Node: no Electron, no ssh library. Everything reaches the server through
 * the system `ssh` client and the user's own `~/.ssh/config`.
 *
 * @module @dsh-ssh/core
 */

export { createStore, defaults, newId, normalize, validate, STORE_FILE } from './config.js'
export { LogRing, redact } from './log.js'
export { LINK_SECRET_ENV, parseLaunchUrl, probe, readLinkSecret, readLog, startCommand, stopRemote } from './remote.js'
export { LINK_PROTOCOL, linkClient, taskEvent } from './link-client.js'
export { RemoteSession } from './session.js'
export { SystemSshTransport, baseSshArgs, probeListener, runSsh, sshAvailable, sshCommand, waitForListener } from './transports.js'
export {
  DSH_TAGS, NODE_MAJOR, SOURCES, compareVersions, inspectCommand, parseInspection, planInstall, pluginUploadInput, stepScript,
} from './install.js'
export { describeDestination, parseSshG, resolveSshTarget } from './ssh-config.js'
