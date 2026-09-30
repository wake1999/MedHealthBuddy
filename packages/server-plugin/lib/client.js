/**
 * dsh-desktop-link — browser half.
 *
 * Hand-authored in the module-loader format the harness serves client bundles
 * in, so the package needs no build step: plain JavaScript, no JSX (hence
 * `React.createElement`), and no imports beyond what the loader supplies.
 *
 * It only does something inside dsh-ssh-desktop, which exposes
 * `window.dshSshDesktop` (protocol 1) to the pages it shows. In an ordinary
 * browser, or in the official desktop app, the bridge is absent and this
 * plugin registers nothing.
 *
 * What it adds: an "open in VS Code" button in the session header, beside
 * DSH's own "Open In" (which stays empty on a server: it opens applications on
 * the machine running DSH). The desktop turns the session's server-side
 * working directory into a VS Code Remote-SSH link for the connection's ssh
 * alias; this page never sees the alias and cannot choose what is opened
 * beyond a path.
 *
 * Finished-task notifications need nothing here: the desktop reads them from
 * the server half's feed, so they arrive even while this page is hidden.
 */
window.__ModuleLoader__.load({
  id: 'dsh-desktop-link',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    const BRIDGE_PROTOCOL = 1
    const SLOT = 'conversation.session.header.utilities'
    const STYLE_ATTR = 'data-dsh-desktop-link-style'

    /** The desktop bridge, when this page is shown by a compatible dsh-ssh-desktop. */
    function bridge() {
      const candidate = typeof window === 'undefined' ? undefined : window.dshSshDesktop
      if (candidate === null || typeof candidate !== 'object') return undefined
      if (candidate.protocol !== BRIDGE_PROTOCOL) return undefined
      if (!Array.isArray(candidate.capabilities)) return undefined
      return candidate
    }

    // Sized like DSH's own header "Open In" pill (ui-open-in-app
    // OpenTargetButton): 24px high, hairline border, 11px label. Colours only
    // from the shell's --dsw-* tokens, so it follows the theme. No `//`
    // comments inside: the sheet is injected verbatim.
    const CSS = `
[data-dsh-desktop-link-open]{display:inline-flex;flex:none;align-self:center;align-items:center;gap:4px;box-sizing:border-box;height:24px;padding:3px 6px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);background:none;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:11px;line-height:16px;white-space:nowrap;cursor:pointer}
[data-dsh-desktop-link-open]:hover:not(:disabled),[data-dsh-desktop-link-open]:focus-visible{background:var(--dsw-alias-interactive-bg-hover);outline:none}
[data-dsh-desktop-link-open]:disabled{cursor:default}
[data-dsh-desktop-link-open][data-failed]{color:var(--dsw-alias-state-error-primary)}
`

    function injectStyles() {
      if (typeof document === 'undefined') return () => {}
      if (document.querySelector(`style[${STYLE_ATTR}]`) !== null) return () => {}
      const style = document.createElement('style')
      style.setAttribute(STYLE_ATTR, '')
      style.textContent = CSS
      document.head.appendChild(style)
      return () => { style.remove() }
    }

    /** VS Code's mark, simplified to a single-colour glyph. */
    function VsCodeIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 13, height: 13, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M11.5 1.75 14.25 3v10l-2.75 1.25L4.5 8l7-6.25Z' }),
        h('path', { d: 'M11.5 1.75v12.5M4.5 8 1.75 5.75M4.5 8l-2.75 2.25' }),
      )
    }

    /**
     * The header button. Hidden until the session has a working directory.
     * @param {{ sessionId: string, useSessions: (select: (state: any) => any) => any }} props
     */
    function OpenInVsCode(props) {
      const cwd = props.useSessions((state) => state?.byId?.[props.sessionId]?.cwd)
      const [state, setState] = React.useState('idle')
      const desktop = bridge()
      if (desktop === undefined || typeof cwd !== 'string' || cwd === '') return null
      const label = state === 'failed' ? '无法打开' : 'VS Code'
      return h(
        'button',
        {
          type: 'button',
          'data-dsh-desktop-link-open': '',
          'data-failed': state === 'failed' ? '' : undefined,
          disabled: state === 'busy',
          title: `在 VS Code 中打开（Remote-SSH）：${cwd}`,
          'aria-label': `在 VS Code 中打开 ${cwd}`,
          onClick: () => {
            setState('busy')
            Promise.resolve(desktop.revealInEditor({ path: cwd })).then(
              () => { setState('idle') },
              (error) => {
                console.warn('dsh-desktop-link: open in VS Code refused:', error)
                setState('failed')
                setTimeout(() => { setState('idle') }, 3000)
              },
            )
          },
        },
        h(VsCodeIcon),
        label,
      )
    }

    /** @param {any} ctx the client root context. */
    function apply(ctx) {
      const desktop = bridge()
      if (desktop === undefined || !desktop.capabilities.includes('revealInEditor')) return
      ctx.effect(() => injectStyles(), 'dsh-desktop-link: stylesheet')
      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: 'dsh-desktop-link-vscode',
        // Just after DSH's own "Open In" (order -10).
        order: -9,
      }, OpenInVsCode))
    }

    exports.name = 'desktop-link'
    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
