import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import AdmZip from 'adm-zip'

const version = process.env.MHB_TECTONIC_VERSION || '0.17.0'
const root = resolve(import.meta.dirname, '..')
const dir = join(root, 'packages', 'desktop', 'resources', 'tex')
const target = join(dir, process.platform === 'win32' ? 'tectonic.exe' : 'tectonic')

if (existsSync(target) && statSync(target).size > 10_000_000) {
  console.log(`[fetch-tex] bundled engine already present: ${target}`)
  process.exit(0)
}
if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.log('[fetch-tex] no automatic bundle for this platform; install Tectonic or set MHB_TEX_DIR')
  process.exit(0)
}

const url = `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${version}/tectonic-${version}-x86_64-pc-windows-msvc.zip`
console.log(`[fetch-tex] downloading ${url}`)
const response = await fetch(url)
if (!response.ok) throw new Error(`Tectonic download failed: HTTP ${response.status}`)
const zip = new AdmZip(Buffer.from(await response.arrayBuffer()))
const entry = zip.getEntry('tectonic.exe')
if (!entry) throw new Error('tectonic.exe missing from release archive')
mkdirSync(dir, { recursive: true })
writeFileSync(target, entry.getData())
console.log(`[fetch-tex] bundled ${target}`)
