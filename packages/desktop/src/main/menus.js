/**
 * The shell's native menus: the caption's "应用 / 编辑" menus in both windows,
 * the remote window's context menu, and a hidden application menu that only
 * carries shortcuts (F12, Ctrl+R). Modelled on the official desktop
 * (upstream apps/desktop/src/main.ts): Windows shows no menu bar; the caption
 * buttons pop these menus instead.
 *
 * @module medhealthbuddy-desktop/menus
 */

import { Menu, app } from 'electron'

const MESSAGES = {
  zh: {
    application: '应用',
    edit: '编辑',
    connections: '连接管理',
    openWindow: '返回 DSH',
    reloadPage: '重新加载页面',
    reconnect: '重新连接',
    restartRemote: '重启远端…',
    testNotification: '测试通知',
    switchServer: '切换服务器',
    about: '关于 DSH 连接',
    exit: '退出',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '复制',
    paste: '粘贴',
    delete: '删除',
    selectAll: '全选',
  },
  en: {
    application: 'Application',
    edit: 'Edit',
    connections: 'Connections',
    openWindow: 'Back to DSH',
    reloadPage: 'Reload Page',
    reconnect: 'Reconnect',
    restartRemote: 'Restart Remote…',
    testNotification: 'Test Notification',
    switchServer: 'Switch Server',
    about: 'About DSH Connect',
    exit: 'Exit',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    delete: 'Delete',
    selectAll: 'Select All',
  },
}

/** The shell's copy in the system language (Chinese or English). */
export function messages() {
  return app.getLocale().toLowerCase().startsWith('zh') ? MESSAGES.zh : MESSAGES.en
}

/**
 * Edit commands for a remote page. The DSH editor keeps its own history and
 * listens for key events rather than Chromium's native edit commands, so each
 * item replays the shortcut into the page instead of using a menu role.
 * @param {(keyCode: string, modifiers: Array<'control'>) => void} sendKey
 * @returns {import('electron').MenuItemConstructorOptions[]}
 */
export function remoteEditItems(sendKey) {
  const m = messages()
  const item = (label, keyCode, modifiers, accelerator) => ({
    label,
    ...(accelerator === undefined ? {} : { accelerator }),
    // The shortcut is only a label here; the page handles the real key.
    registerAccelerator: false,
    click: () => { sendKey(keyCode, modifiers) },
  })
  return [
    item(m.undo, 'Z', ['control'], 'Ctrl+Z'),
    item(m.redo, 'Y', ['control'], 'Ctrl+Y'),
    { type: 'separator' },
    item(m.cut, 'X', ['control'], 'Ctrl+X'),
    item(m.copy, 'C', ['control'], 'Ctrl+C'),
    item(m.paste, 'V', ['control'], 'Ctrl+V'),
    item(m.delete, 'Delete', []),
    { type: 'separator' },
    item(m.selectAll, 'A', ['control'], 'Ctrl+A'),
  ]
}

/**
 * Edit commands for the shell's own pages, which use native editing.
 * @returns {import('electron').MenuItemConstructorOptions[]}
 */
export function nativeEditItems() {
  const m = messages()
  return [
    { role: 'undo', label: m.undo },
    { role: 'redo', label: m.redo },
    { type: 'separator' },
    { role: 'cut', label: m.cut },
    { role: 'copy', label: m.copy },
    { role: 'paste', label: m.paste },
    { role: 'delete', label: m.delete },
    { type: 'separator' },
    { role: 'selectAll', label: m.selectAll },
  ]
}

/**
 * The right-click menu: editing commands in an editable field, copy for a
 * selection, nothing otherwise (as upstream).
 * @param {import('electron').ContextMenuParams} params
 * @returns {import('electron').MenuItemConstructorOptions[]}
 */
export function contextMenuItems(params) {
  const m = messages()
  const flags = params.editFlags
  // Empty accelerators keep Electron from printing default shortcut labels.
  if (params.isEditable) {
    return [
      { role: 'undo', label: m.undo, enabled: flags.canUndo, accelerator: '' },
      { role: 'redo', label: m.redo, enabled: flags.canRedo, accelerator: '' },
      { type: 'separator' },
      { role: 'cut', label: m.cut, enabled: flags.canCut, accelerator: '' },
      { role: 'copy', label: m.copy, enabled: flags.canCopy, accelerator: '' },
      { role: 'paste', label: m.paste, enabled: flags.canPaste, accelerator: '' },
      { type: 'separator' },
      { role: 'selectAll', label: m.selectAll, enabled: flags.canSelectAll, accelerator: '' },
    ]
  }
  if (params.selectionText.length > 0) {
    return [{ role: 'copy', label: m.copy, enabled: flags.canCopy, accelerator: '' }]
  }
  return []
}

/**
 * No visible menu bar anywhere (the caption buttons replace it); the menu
 * exists only to keep the developer tools and reload shortcuts.
 */
export function installApplicationMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'toggleDevTools', visible: false },
    { role: 'toggleDevTools', visible: false, accelerator: 'F12' },
    { role: 'reload', visible: false },
  ]))
}

/**
 * Pop a menu under a caption button and resolve when it closes. Every page
 * fills the window from its top-left corner, so page coordinates are window
 * coordinates once scaled by that page's zoom.
 * @param {import('electron').BrowserWindow} window
 * @param {import('electron').WebContents} contents  the page that asked.
 * @param {import('electron').MenuItemConstructorOptions[]} items
 * @param {number} x CSS px from the page.
 * @param {number} y CSS px from the page.
 */
export function popupAt(window, contents, items, x, y) {
  const zoom = contents.getZoomFactor()
  return new Promise((resolve) => {
    Menu.buildFromTemplate(items).popup({ window, x: Math.round(x * zoom), y: Math.round(y * zoom), callback: () => resolve(undefined) })
  })
}
