/**
 * The home page: what the window shows beneath the connection manager when no
 * remote DSH is on screen. It only opens the manager and the caption menus.
 */
const api = window.dshHome

document.getElementById('btn-manager').addEventListener('click', () => { void api.openManager() })

api.onStatus((text) => {
  document.getElementById('status').textContent = text
})

const menuButtons = [...document.querySelectorAll('.menubar button')]
menuButtons.forEach((button, index) => {
  button.addEventListener('mousedown', (event) => { event.preventDefault() })
  const open = async () => {
    if (button.getAttribute('aria-expanded') === 'true') return
    const rect = button.getBoundingClientRect()
    button.setAttribute('aria-expanded', 'true')
    try { await api.showMenu(button.dataset.menu, rect.left, rect.bottom) } catch { /* window closing */ }
    finally { button.setAttribute('aria-expanded', 'false') }
  }
  button.addEventListener('click', () => { void open() })
  button.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const next = menuButtons[(index + 1) % menuButtons.length]
      button.tabIndex = -1
      next.tabIndex = 0
      next.focus()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      void open()
    }
  })
})
