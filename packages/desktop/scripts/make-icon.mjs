/**
 * Build the app icon: the base artwork (assets/icon-base.png) with "SSH" set
 * in its bottom-right corner, so the app is told apart from the official DSH
 * desktop at a glance.
 *
 * The lettering follows the artwork: the whale's own slate gradient (#2d313a
 * at the core to #3c434f at the lit edges), a heavy geometric sans with the
 * same soft rounded feel, and the same faint drop shadow.
 *
 * Output (assets/):
 *   icon.png            1024 × 1024
 *   icon-<n>.png        256, 128, 64, 48, 32, 24, 16
 *   icon.ico            every size above, PNG-encoded (Windows Vista and later)
 *
 * Drawn in an offscreen Electron page with a 2D canvas, so no image library is
 * needed. Run from packages/desktop:
 *   electron [--no-sandbox] scripts/make-icon.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BrowserWindow, app } from 'electron'

const assets = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets')
const SIZES = [256, 128, 64, 48, 32, 24, 16]

/** Runs in the page: draw the icon and every size, return PNG data URLs. */
function draw(baseUrl, sizes) {
  return new Promise((resolve, reject) => {
    const base = new Image()
    base.onerror = () => { reject(new Error('the base image did not load')) }
    base.onload = async () => {
      await document.fonts.ready
      const canvas = document.createElement('canvas')
      canvas.width = 1024
      canvas.height = 1024
      const ctx = canvas.getContext('2d')
      ctx.drawImage(base, 0, 0, 1024, 1024)

      const text = 'SSH'
      ctx.font = "700 152px 'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif"
      ctx.letterSpacing = '2px'
      ctx.textBaseline = 'alphabetic'
      const metrics = ctx.measureText(text)
      // Right edge and baseline inside the rounded square (opaque 32–991),
      // clear of the whale's lower fin.
      const right = 920
      const baseline = 934
      const left = right - metrics.actualBoundingBoxRight
      const top = baseline - metrics.actualBoundingBoxAscent
      const gradient = ctx.createLinearGradient(left, top, right, baseline)
      gradient.addColorStop(0, '#2d313a')
      gradient.addColorStop(0.55, '#343841')
      gradient.addColorStop(1, '#3f4551')
      ctx.save()
      ctx.shadowColor = 'rgba(15, 17, 21, 0.18)'
      ctx.shadowBlur = 10
      ctx.shadowOffsetY = 3
      ctx.fillStyle = gradient
      ctx.fillText(text, left, baseline)
      ctx.restore()

      /** Downscale in halving steps: one big jump would alias the edges. */
      const scaled = (size) => {
        let source = canvas
        let current = 1024
        while (current / 2 >= size) {
          const step = document.createElement('canvas')
          step.width = step.height = current / 2
          const c = step.getContext('2d')
          c.imageSmoothingQuality = 'high'
          c.drawImage(source, 0, 0, current / 2, current / 2)
          source = step
          current /= 2
        }
        if (current === size) return source.toDataURL('image/png')
        const last = document.createElement('canvas')
        last.width = last.height = size
        const c = last.getContext('2d')
        c.imageSmoothingQuality = 'high'
        c.drawImage(source, 0, 0, size, size)
        return last.toDataURL('image/png')
      }
      resolve({
        full: canvas.toDataURL('image/png'),
        sizes: Object.fromEntries(sizes.map((s) => [s, scaled(s)])),
        box: { left: Math.round(left), top: Math.round(top), right, baseline },
      })
    }
    base.src = baseUrl
  })
}

/**
 * An .ico holding PNG images (the format Windows Vista+ reads for every size).
 * @param {{ size: number, png: Buffer }[]} images
 */
function ico(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  const entries = []
  let offset = 6 + 16 * images.length
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(size >= 256 ? 0 : size, 0)
    entry.writeUInt8(size >= 256 ? 0 : size, 1)
    entry.writeUInt8(0, 2)
    entry.writeUInt8(0, 3)
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(png.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    offset += png.length
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)])
}

const fromDataUrl = (url) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 64, height: 64, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html,<!doctype html><meta charset=utf-8><body></body>')
  const baseUrl = `data:image/png;base64,${readFileSync(join(assets, 'icon-base.png')).toString('base64')}`
  const result = await win.webContents.executeJavaScript(`(${draw.toString()})(${JSON.stringify(baseUrl)}, ${JSON.stringify(SIZES)})`)
  writeFileSync(join(assets, 'icon.png'), fromDataUrl(result.full))
  const images = SIZES.map((size) => ({ size, png: fromDataUrl(result.sizes[size]) }))
  for (const { size, png } of images) writeFileSync(join(assets, `icon-${String(size)}.png`), png)
  writeFileSync(join(assets, 'icon.ico'), ico(images))
  console.log(`icon written; text box ${JSON.stringify(result.box)}`)
  app.quit()
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
