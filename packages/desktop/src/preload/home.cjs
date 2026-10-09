/**
 * Preload for the home page (the main window's own contents). Least privilege:
 * it can open the connection manager and the caption menus, and hears a status
 * line — nothing that connects, stops or saves.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshHome', {
  openManager: () => ipcRenderer.invoke('dsh-home:openManager'),
  showMenu: (name, x, y) => ipcRenderer.invoke('dsh-home:menu', name, x, y),
  /** The start-up intro has ended; the main process decides what shows next. */
  introDone: () => ipcRenderer.invoke('dsh-home:introDone'),
  /** @param {(text: string) => void} listener */
  onStatus(listener) {
    const wrapped = (_event, text) => { listener(String(text)) }
    ipcRenderer.on('dsh-home:status', wrapped)
    return () => { ipcRenderer.removeListener('dsh-home:status', wrapped) }
  },
})

// Whether a remote view covers this page: its caption must then stop being a
// drag region (see home.css). Handled here, not by the page, so it also holds
// before the page script runs.
ipcRenderer.on('dsh-home:covered', (_event, covered) => {
  const apply = () => { document.body.toggleAttribute('data-covered', covered === true) }
  if (document.body !== null) apply()
  else window.addEventListener('DOMContentLoaded', apply, { once: true })
})
