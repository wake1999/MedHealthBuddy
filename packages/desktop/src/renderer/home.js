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

// ------------------------------------------------------------------ intro
// An ECG monitor scene: a green trace sweeps across a dark gridded screen with
// an erase gap ahead of it, the BPM readout ticks on every beat, then the
// whole thing fades into the app. Click or press any key to skip.

const intro = document.getElementById('intro')
const canvas = document.getElementById('intro-canvas')
const bpmHeart = document.getElementById('intro-bpm-heart')
let introFinished = false

function finishIntro() {
  if (introFinished) return
  introFinished = true
  intro.setAttribute('data-done', '')
  setTimeout(() => {
    intro.remove()
    // The main process opens the connection manager unless something is
    // already auto-connecting (then the home status stays on screen).
    void api.introDone()
  }, 650)
}

/** The ECG shape over one beat, phase 0..1: P wave, QRS complex, T wave. */
function beat(p) {
  const bump = (center, width, height) => { const d = (p - center) / width; return height * Math.exp(-(d * d)) }
  return bump(0.16, 0.030, 0.10) + bump(0.30, 0.013, -0.16) + bump(0.34, 0.011, 1)
    + bump(0.375, 0.015, -0.28) + bump(0.56, 0.05, 0.22)
}

function playIntro() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    finishIntro()
    return
  }
  const dpr = window.devicePixelRatio || 1
  const width = window.innerWidth
  const height = window.innerHeight
  canvas.width = Math.round(width * dpr)
  canvas.height = Math.round(height * dpr)
  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)
  const mid = height * 0.5
  const span = Math.min(height * 0.26, 170)

  // The monitor grid lives on its own layer, blitted back after every frame's
  // clear: fine cells, stronger lines every fifth.
  const gridLayer = document.createElement('canvas')
  gridLayer.width = canvas.width
  gridLayer.height = canvas.height
  const grid = gridLayer.getContext('2d')
  grid.scale(dpr, dpr)
  const fine = 22
  grid.fillStyle = '#0a1210'
  grid.fillRect(0, 0, width, height)
  grid.strokeStyle = 'rgba(0, 229, 128, .07)'
  grid.lineWidth = 1
  grid.beginPath()
  for (let x = 0.5; x < width; x += fine) { grid.moveTo(x, 0); grid.lineTo(x, height) }
  for (let y = 0.5; y < height; y += fine) { grid.moveTo(0, y); grid.lineTo(width, y) }
  grid.stroke()
  grid.strokeStyle = 'rgba(0, 229, 128, .16)'
  grid.beginPath()
  for (let x = 0.5; x < width; x += fine * 5) { grid.moveTo(x, 0); grid.lineTo(x, height) }
  for (let y = 0.5; y < height; y += fine * 5) { grid.moveTo(0, y); grid.lineTo(width, y) }
  grid.stroke()
  // CRT scanlines: a faint dark line every three pixels.
  grid.fillStyle = 'rgba(0, 0, 0, .12)'
  for (let y = 0; y < height; y += 3) grid.fillRect(0, y, width, 1)

  // One screen column of trace each: a number, or null where the sweep has
  // erased what was before it.
  const trace = new Array(width).fill(null)
  const beatsPerPass = 2
  const wavelength = width / beatsPerPass
  const passes = 2
  const duration = 3600
  const pixelsPerMs = (width * passes) / duration
  const gap = 46
  let head = 0
  let last = performance.now()
  let lastPeak = -2

  const draw = (now) => {
    const dt = Math.min(50, now - last)
    last = now
    if (introFinished) return
    head += pixelsPerMs * dt

    // Advance the sweep: write the waveform behind the head, erase ahead of it.
    const steps = Math.max(1, Math.round(pixelsPerMs * dt))
    for (let i = 1; i <= steps; i++) {
      const x = Math.round(head) - steps + i
      if (x < 0 || x >= width) continue
      const p = ((x / wavelength) % 1 + 1) % 1
      trace[x] = mid - beat(p) * span
    }
    for (let i = 1; i <= gap; i++) {
      const x = Math.round(head + i)
      if (x >= 0 && x < width) trace[x] = null
    }

    // The heart pulses on every R peak the head passes (peak at ~1/3 into
    // each beat, where the QRS spike sits).
    const peak = Math.floor(head / wavelength - 0.34)
    if (peak !== lastPeak) {
      lastPeak = peak
      bpmHeart.setAttribute('data-beat', '')
      setTimeout(() => { bpmHeart.removeAttribute('data-beat') }, 160)
    }

    // Redraw the trace with a glow; brighten the segment just written.
    ctx.clearRect(0, 0, width, height)
    ctx.drawImage(gridLayer, 0, 0, width, height)
    ctx.lineWidth = 2.2
    ctx.lineJoin = 'round'
    ctx.shadowColor = 'rgba(0, 229, 128, .8)'
    ctx.shadowBlur = 10
    ctx.strokeStyle = 'rgba(0, 229, 128, .45)'
    ctx.beginPath()
    let pen = false
    for (let x = 0; x < width; x++) {
      if (trace[x] === null) { pen = false; continue }
      pen ? ctx.lineTo(x, trace[x]) : ctx.moveTo(x, trace[x])
      pen = true
    }
    ctx.stroke()
    ctx.strokeStyle = '#4dffb0'
    ctx.beginPath()
    pen = false
    for (let x = Math.max(0, Math.round(head) - 220); x <= Math.min(width - 1, Math.round(head)); x++) {
      if (trace[x] === null) { pen = false; continue }
      pen ? ctx.lineTo(x, trace[x]) : ctx.moveTo(x, trace[x])
      pen = true
    }
    ctx.stroke()
    ctx.shadowBlur = 0

    // A soft light band sweeping down the screen, like the monitor's refresh.
    const bandY = ((now / 2800) % 1) * (height + 260) - 130
    const band = ctx.createLinearGradient(0, bandY - 130, 0, bandY + 130)
    band.addColorStop(0, 'rgba(140, 255, 205, 0)')
    band.addColorStop(0.5, 'rgba(140, 255, 205, .06)')
    band.addColorStop(1, 'rgba(140, 255, 205, 0)')
    ctx.fillStyle = band
    ctx.fillRect(0, bandY - 130, width, 260)

    // The head dot.
    const hx = Math.min(width - 1, Math.round(head))
    const hy = trace[hx]
    if (hy !== null && hy !== undefined) {
      ctx.beginPath()
      ctx.arc(hx, hy, 4, 0, Math.PI * 2)
      ctx.fillStyle = '#b8ffdd'
      ctx.shadowColor = 'rgba(0, 229, 128, 1)'
      ctx.shadowBlur = 14
      ctx.fill()
      ctx.shadowBlur = 0
    }

    if (head < width * passes) return
    finishIntro()
  }
  // Driven by a timer, not requestAnimationFrame: once a remote view covers
  // this page (auto-connect), the page counts as hidden and the compositor
  // freezes RAF after a frame or two — the trace would never sweep.
  const timer = setInterval(() => {
    if (introFinished) { clearInterval(timer); return }
    draw(performance.now())
    if (head >= width * passes) clearInterval(timer)
  }, 16)
}

intro.addEventListener('click', finishIntro)
window.addEventListener('keydown', finishIntro, { once: true })
playIntro()
