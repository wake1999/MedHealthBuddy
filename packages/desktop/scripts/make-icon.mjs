/**
 * Build the app icon from the base artwork (assets/icon-base.png), a square
 * emblem fitted onto a transparent 1024 × 1024 canvas.
 *
 * Output (assets/):
 *   icon.png            1024 × 1024
 *   icon-<n>.png        256, 128, 64, 48, 32, 24, 16
 *   app.ico             every size above, PNG-encoded (Windows Vista and later)
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
      const canvas = document.createElement('canvas')
      canvas.width = 1024
      canvas.height = 1024
      const ctx = canvas.getContext('2d')
      // Fit the artwork whole into the square, centred, nothing cropped.
      const scale = Math.min(1024 / base.width, 1024 / base.height)
      const width = Math.round(base.width * scale)
      const height = Math.round(base.height * scale)
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(base, (1024 - width) / 2, (1024 - height) / 2, width, height)

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
  // app.ico, not icon.ico: Windows caches taskbar icons by path, so the file
  // was renamed once and must keep that name to read fresh.
  writeFileSync(join(assets, 'app.ico'), ico(images))
  console.log('icon written')
  app.quit()
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
