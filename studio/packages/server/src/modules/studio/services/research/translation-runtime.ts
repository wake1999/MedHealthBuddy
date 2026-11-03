/**
 * Managed translation runtime.
 *
 * Windows installations can download a self-contained pdf2zh/babeldoc/PyMuPDF
 * runtime on first use. No system Python is required. Linux/remote deployments
 * can continue to provide `PDF2ZH_BIN` / `PYTHON_BIN` (or install the plugin in
 * the same directory layout).
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PLUGIN_DEFAULTS: Record<string, { url: string; sha256: string }> = {
  'win-x64': {
    url: 'http://36.140.151.191:8648/downloads/translation-runtime-win-x64.tar.gz',
    sha256: '4c9c6b172f34f49ea7158e65f3258c9d74219d518a645f1bad4b75196915a952',
  },
  'linux-x64': {
    url: 'http://36.140.151.191:8648/downloads/translation-runtime-linux-x64.tar.gz',
    sha256: '1f7ccbb9abc9dcd0c3ecba18241393b6d8f0f982971e0adb229731811f12f34f',
  },
}
const INSTALL_LOCK_WAIT_MS = 30_000

function platformKey(): string {
  if (process.platform === 'win32') return process.arch === 'arm64' ? 'win-arm64' : 'win-x64'
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
  return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
}

export function translationRuntimeRoot(): string {
  const explicit = (process.env.MHB_TRANSLATION_RUNTIME_DIR || '').trim()
  if (explicit !== '') return path.resolve(explicit)
  const state = (process.env.HERMES_WEBUI_STATE_DIR || process.env.HERMES_WEB_UI_HOME || '').trim()
  const root = state !== '' ? state : path.join(os.homedir(), '.hermes-web-ui')
  return path.join(root, 'translation-runtime', platformKey())
}

export function translationRuntimeBinaries(): { pdf2zh: string; python: string } {
  const root = translationRuntimeRoot()
  if (process.platform === 'win32') {
    return {
      pdf2zh: path.join(root, 'pdf2zh.cmd'),
      python: path.join(root, 'python', 'python.exe'),
    }
  }
  return {
    pdf2zh: path.join(root, 'pdf2zh'),
    python: path.join(root, 'python', 'bin', 'python3'),
  }
}

export interface TranslationRuntimeHealth {
  installed: boolean
  platform: string
  root: string
  pdf2zh: string
  python: string
  pymupdf: string
  error: string
}

async function fileExists(file: string): Promise<boolean> {
  return fs.stat(file).then(() => true).catch(() => false)
}

function runVersion(command: string, args: readonly string[], timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
    })
    let output = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
    }, timeoutMs)
    child.stdout?.on('data', chunk => { output += String(chunk) })
    child.stderr?.on('data', chunk => { output += String(chunk) })
    child.on('error', () => {
      clearTimeout(timer)
      resolve('')
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve(output.trim())
    })
  })
}

export async function translationRuntimeHealth(): Promise<TranslationRuntimeHealth> {
  const managed = translationRuntimeBinaries()
  const configuredPdf2zh = (process.env.PDF2ZH_BIN || '').trim()
  const configuredPython = (process.env.PYTHON_BIN || '').trim()
  const pdf2zh = configuredPdf2zh !== '' ? configuredPdf2zh : managed.pdf2zh
  const python = configuredPython !== '' ? configuredPython : managed.python
  const root = translationRuntimeRoot()
  const installed = await fileExists(pdf2zh) && await fileExists(python)
  let pymupdf = ''
  let error = ''
  if (installed) {
    pymupdf = await runVersion(python, ['-c', 'import fitz; print(fitz.__version__)'])
    if (pymupdf === '') error = 'PyMuPDF is not importable'
  } else {
    error = 'translation runtime is not installed'
  }
  return {
    installed: installed && error === '',
    platform: platformKey(),
    root,
    pdf2zh,
    python,
    pymupdf,
    error,
  }
}

export interface TranslationRuntimeProgress {
  phase: 'downloading' | 'extracting' | 'validating'
  percent: number | null
  message: string
}

let installPromise: Promise<TranslationRuntimeHealth> | null = null

function bundledArchiveDir(): string {
  const dir = (process.env.MHB_TRANSLATION_PLUGIN_BUNDLE_DIR || '').trim()
  return dir === '' ? '' : path.resolve(dir)
}

function bundledArchivePath(): string {
  const dir = bundledArchiveDir()
  if (dir === '') return ''
  return path.join(dir, `translation-runtime-${platformKey()}.tar.gz`)
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function download(url: string, target: string, onProgress?: (p: TranslationRuntimeProgress) => void): Promise<string> {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || response.body === null) throw new Error(`plugin_download_http_${response.status}`)
  const total = Number(response.headers.get('content-length') || 0)
  const reader = response.body.getReader()
  const output = createWriteStream(target)
  const hash = createHash('sha256')
  let received = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      const chunk = Buffer.from(value)
      hash.update(chunk)
      if (!output.write(chunk)) {
        await new Promise<void>(resolve => output.once('drain', () => resolve()))
      }
      received += chunk.length
      onProgress?.({
        phase: 'downloading',
        percent: total > 0 ? Math.min(99, Math.round((received / total) * 100)) : null,
        message: `Downloading translation plugin (${Math.round(received / 1024 / 1024)} MB)`,
      })
    }
  } finally {
    await new Promise<void>(resolve => output.end(() => resolve()))
  }
  return hash.digest('hex')
}

function extractArchive(archive: string, destination: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xzf', archive, '-C', destination], {
      windowsHide: true,
    })
    let stderr = ''
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => reject(new Error(`plugin_extract_failed: ${error.message}`)))
    child.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`plugin_extract_failed: ${stderr.trim().slice(-300) || `exit ${String(code)}`}`))
    })
  })
}

/**
 * Ensure the managed runtime exists. Concurrent callers share one install.
 * Only Windows is auto-installed; Linux uses the deployment-provided runtime.
 */
export async function ensureTranslationRuntime(
  onProgress?: (p: TranslationRuntimeProgress) => void,
): Promise<TranslationRuntimeHealth> {
  const current = await translationRuntimeHealth()
  if (current.installed) return current
  if (installPromise !== null) return installPromise

  installPromise = (async () => {
    const defaults = PLUGIN_DEFAULTS[platformKey()]
    if (defaults === undefined) throw new Error('translation_runtime_platform_unsupported')
    const allowDownload = ['1', 'true', 'on', 'yes'].includes(
      (process.env.MHB_TRANSLATION_PLUGIN_ALLOW_DOWNLOAD || '').trim().toLowerCase(),
    )
    const expectedSha = (process.env.MHB_TRANSLATION_PLUGIN_SHA256 || defaults.sha256).trim().toLowerCase()
    const bundled = bundledArchivePath()
    const useBundled = bundled !== '' && await fileExists(bundled)
    if (!useBundled && !allowDownload) {
      throw new Error(`translation_plugin_bundle_missing: ${path.basename(bundled || 'translation-runtime')}`)
    }
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mhb-translation-plugin-'))
    const archive = useBundled ? bundled : path.join(tempDir, 'runtime.tar.gz')
    const extracted = path.join(tempDir, 'extracted')
    try {
      await fs.mkdir(extracted)
      const actualSha = useBundled
        ? await hashFile(archive)
        : await download((process.env.MHB_TRANSLATION_PLUGIN_URL || defaults.url).trim(), archive, onProgress)
      if (expectedSha !== '' && actualSha !== expectedSha) {
        throw new Error(`plugin_checksum_mismatch: expected ${expectedSha}, got ${actualSha}`)
      }
      onProgress?.({ phase: 'extracting', percent: useBundled ? 0 : 99, message: 'Extracting translation plugin' })
      await extractArchive(archive, extracted)
      const binaries = translationRuntimeBinaries()
      const targetRoot = path.dirname(binaries.pdf2zh)
      await fs.rm(targetRoot, { recursive: true, force: true }).catch(() => null)
      await fs.mkdir(targetRoot, { recursive: true })
      // Extraction contains the runtime files at its root.
      await fs.cp(extracted, targetRoot, { recursive: true, force: true })
      if (process.platform !== 'win32') {
        await fs.chmod(binaries.pdf2zh, 0o755).catch(() => null)
        await fs.chmod(binaries.python, 0o755).catch(() => null)
      }
      onProgress?.({ phase: 'validating', percent: 100, message: 'Checking translation plugin' })
      const health = await translationRuntimeHealth()
      if (!health.installed) throw new Error(`plugin_validation_failed: ${health.error}`)
      return health
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => null)
      installPromise = null
    }
  })()
  return installPromise
}

export function translationRuntimeLockWaitMs(): number {
  return INSTALL_LOCK_WAIT_MS
}
