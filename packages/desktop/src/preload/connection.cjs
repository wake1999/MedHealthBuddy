/**
 * Preload for the connection manager dialog only (never a remote view).
 *
 * Sandboxed preloads must be CommonJS. The bridge is a fixed list of calls;
 * the main process re-checks that each one comes from the manager page in the
 * manager's own view.
 */
const { contextBridge, ipcRenderer } = require('electron')

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args)

contextBridge.exposeInMainWorld('dshSsh', {
  getState: call('dsh:getState'),
  save: call('dsh:save'),
  connect: call('dsh:connect'),
  disconnect: call('dsh:disconnect'),
  stop: call('dsh:stop'),
  restart: call('dsh:restart'),
  remove: call('dsh:remove'),
  /** Read-only look at a server: what is installed, and the plan to finish it. */
  inspect: call('dsh:inspect'),
  /** Run the plan the last `inspect` showed for that connection. */
  install: call('dsh:install'),
  exportDiagnostics: call('dsh:exportDiagnostics'),
  openUserData: call('dsh:openUserData'),
  openLogs: call('dsh:openLogs'),
  /** Hide the dialog; connections are unaffected. */
  close: call('dsh:close'),
  /** Change the app-level options (auto-connect and friends). */
  saveSettings: call('dsh:saveSettings'),
  /** @param {(state: unknown) => void} listener */
  onState(listener) {
    const wrapped = (_event, state) => { listener(state) }
    ipcRenderer.on('dsh:state', wrapped)
    return () => { ipcRenderer.removeListener('dsh:state', wrapped) }
  },
  /** @param {(progress: unknown) => void} listener */
  onInstallProgress(listener) {
    const wrapped = (_event, progress) => { listener(progress) }
    ipcRenderer.on('dsh:install-progress', wrapped)
    return () => { ipcRenderer.removeListener('dsh:install-progress', wrapped) }
  },
})
