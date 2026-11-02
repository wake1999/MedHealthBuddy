/**
 * Whole-document PDF translation that keeps the original layout.
 *
 * Rather than re-rendering text in the browser (which cannot preserve the
 * layout: Chinese glyph widths differ from Latin ones), this shells out to
 * `pdf2zh` — the tool behind PDFMathTranslate — which extracts text + bbox with
 * pdfminer, translates it, and writes the translation back into the original
 * boxes with PyMuPDF. The default backend is accurate for PDFs that already
 * carry a native text layer (the papers here), so no OCR / model download is
 * needed.
 *
 * pdf2zh writes `<name>-mono.pdf` (translation only, original layout) and
 * `<name>-dual.pdf` (source page / translated page alternating). Neither is a
 * true side-by-side spread, so `compare` is built here with PyMuPDF: every
 * source page and its translation are stitched into one double-width page,
 * which is what the reader shows for "原文 / 译文 对比".
 *
 * @module dsh-client-ui-mimir/server/translate-pdf
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Where pdf2zh might live. An explicit env var always wins. */
const PDF2ZH_CANDIDATES = [
  process.env.PDF2ZH_BIN,
  'pdf2zh',
  process.platform === 'win32' ? 'D:\\python3.11\\Scripts\\pdf2zh.exe' : '/usr/local/bin/pdf2zh',
].filter((value): value is string => typeof value === 'string' && value !== '')

/** PyMuPDF is used for the compare spread; it ships with pdf2zh's environment. */
const PYTHON_CANDIDATES = [
  process.env.PYTHON_BIN,
  process.platform === 'win32' ? 'D:\\python3.11\\python.exe' : 'python3',
  'python',
].filter((value): value is string => typeof value === 'string' && value !== '')

/** Hard cap: a paper translation should not hang a request forever. */
const TRANSLATE_TIMEOUT_MS = 8 * 60 * 1000
const COMPARE_TIMEOUT_MS = 60 * 1000

/** The model the panel is currently using; forwarded to pdf2zh's openai service. */
export interface TranslateModel {
  baseUrl: string
  apiKey: string
  model: string
}

export interface TranslateOptions {
  /** When present, translation goes through this OpenAI-compatible endpoint. */
  readonly model?: TranslateModel
  readonly sourceLang?: string
  readonly targetLang?: string
}

/**
 * Which translated PDF to hand back:
 *  - `mono` replaces the body text in place — the page keeps its original layout
 *    and reads entirely in Chinese ("英文直接变中文").
 *  - `dual` alternates source pages and translated pages.
 *  - `compare` stitched each source page next to its translation (double width),
 *    which is the "原文 / 译文" spread the reader shows.
 */
export type PdfVariant = 'mono' | 'dual' | 'compare'

/** Path of the produced PDF for a variant, without invoking the tool. */
export function variantPdfPathFor(inputPath: string, outDir: string, variant: PdfVariant): string {
  const base = path.basename(inputPath, path.extname(inputPath))
  return path.join(outDir, `${base}-${variant}.pdf`)
}

function run(
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      env: options.env ? { ...process.env, ...options.env } : process.env,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
    }, options.timeoutMs ?? TRANSLATE_TIMEOUT_MS)
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: String(error?.message || error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** Build the side-by-side spread: source page | its translation, per page. */
const COMPARE_SCRIPT = `
import sys
import fitz

src_path, tr_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
src = fitz.open(src_path)
tr = fitz.open(tr_path)
out = fitz.open()
count = min(len(src), len(tr))
for i in range(count):
    a = src[i]
    b = tr[i]
    aw, ah = a.rect.width, a.rect.height
    bw, bh = b.rect.width, b.rect.height
    height = max(ah, bh)
    page = out.new_page(width=aw + bw, height=height)
    page.show_pdf_page(fitz.Rect(0, 0, aw, ah), src, i, keep_proportion=True)
    page.show_pdf_page(fitz.Rect(aw, 0, aw + bw, bh), tr, i, keep_proportion=True)
out.save(out_path, garbage=4, deflate=True)
`

/**
 * Stitch `sourcePath` and `translatedPath` into one double-width page per page.
 * @returns the produced path.
 */
async function buildComparePdf(
  sourcePath: string,
  translatedPath: string,
  outPath: string,
): Promise<string> {
  const scriptPath = path.join(os.tmpdir(), `mimir-compare-${process.pid}.py`)
  await fs.writeFile(scriptPath, COMPARE_SCRIPT, 'utf-8')
  let lastError = ''
  try {
    for (const bin of PYTHON_CANDIDATES) {
      const result = await run(
        bin,
        [scriptPath, sourcePath, translatedPath, outPath],
        { timeoutMs: COMPARE_TIMEOUT_MS },
      )
      if (result.code === 0) return outPath
      lastError = `${bin}: exit ${String(result.code)} — ${(result.stderr || result.stdout).trim().slice(-400)}`
      if (result.code !== -1) break
    }
  } finally {
    await fs.unlink(scriptPath).catch(() => {})
  }
  throw new Error(`compare build failed: ${lastError || 'python unavailable'}`)
}

/**
 * Run pdf2zh once; it writes both `<name>-mono.pdf` and `<name>-dual.pdf`.
 * @returns the mono path (the canonical translated copy).
 */
async function runPdf2zh(
  inputPath: string,
  outDir: string,
  options: TranslateOptions,
): Promise<string> {
  const sourceLang = options.sourceLang ?? 'en'
  const targetLang = options.targetLang ?? 'zh'
  const mono = variantPdfPathFor(inputPath, outDir, 'mono')

  // With a resolved model we go through the OpenAI-compatible service, so the
  // whole paper is translated by the same model the panel is already using.
  // Otherwise fall back to bing: pdf2zh's default (Google) is unreachable from
  // mainland China. PDF2ZH_SERVICE still overrides the fallback.
  const useModel = options.model !== undefined && options.model.apiKey !== ''
  const service = useModel ? 'openai' : ((process.env.PDF2ZH_SERVICE ?? 'bing').trim() || 'bing')
  const env: NodeJS.ProcessEnv = {}
  if (useModel && options.model) {
    env.OPENAI_BASE_URL = options.model.baseUrl
    env.OPENAI_API_KEY = options.model.apiKey
    env.OPENAI_MODEL = options.model.model
  }

  // babeldoc 首次运行要从 HuggingFace 拉版面模型，用国内镜像。
  if (env.HF_ENDPOINT === undefined && process.env.HF_ENDPOINT === undefined) {
    env.HF_ENDPOINT = 'https://hf-mirror.com'
  }

  let lastError = ''
  for (const bin of PDF2ZH_CANDIDATES) {
    /*
     * `--babeldoc`：换成版面感知后端。
     *
     * 默认的 pdfminer 后端是「按字符框替换」，中文比英文窄，替换后
     * 正文会和公式、表格、页边注挤在一起重叠。babeldoc 先做版面分析
     * （段落 / 图 / 表 / 公式分开），只重排正文段落，公式表格整块原样保留。
     * 代价是首次要下载 ONNX 模型（已指向 hf-mirror）。
     */
    const args = [
      '-li', sourceLang, '-lo', targetLang, '-s', service,
      '--babeldoc',
      '-o', outDir, inputPath,
    ]
    const result = await run(bin, args, { env, timeoutMs: 30 * 60 * 1000 })
    if (result.code === 0) {
      await relocateProducts(inputPath, outDir, targetLang)
      return mono
    }
    lastError = `${bin}: exit ${String(result.code)} — ${(result.stderr || result.stdout).trim().slice(-400)}`
    // ENOENT (-1) means this candidate is not installed; try the next one.
    if (result.code !== -1) break
  }
  throw new Error(`pdf2zh failed: ${lastError || 'no candidate ran'}`)
}

/**
 * babeldoc 的产物命名是 `<base>.<lang>.mono.pdf` / `<base>.<lang>.dual.pdf`，
 * 而阅读器按 `<base>-mono.pdf` 取文件。这里把 babeldoc 产物复制成阅读器期望的名字。
 */
async function relocateProducts(inputPath: string, outDir: string, lang: string): Promise<void> {
  const base = path.basename(inputPath, path.extname(inputPath))
  for (const v of ['mono', 'dual'] as const) {
    const expected = variantPdfPathFor(inputPath, outDir, v)
    const exists = await fs.stat(expected).then(() => true).catch(() => false)
    if (exists) continue
    for (const candidate of [
      path.join(outDir, `${base}.${lang}.${v}.pdf`),
      path.join(outDir, `${base}.${v}.pdf`),
    ]) {
      const ok = await fs.stat(candidate).then(() => true).catch(() => false)
      if (!ok) continue
      await fs.copyFile(candidate, expected).catch(() => null)
      break
    }
  }
}

/**
 * Translate one PDF into `variant`, keeping the original layout.
 *
 * @param inputPath - absolute path of the source PDF.
 * @param outDir - directory the products are written into.
 * @param variant - `mono`, `dual` or the side-by-side `compare`.
 * @param options - the model to translate with, plus language pair.
 * @returns absolute path of the produced PDF.
 */
export async function translatePdf(
  inputPath: string,
  outDir: string,
  variant: PdfVariant = 'compare',
  options: TranslateOptions = {},
): Promise<string> {
  const target = variantPdfPathFor(inputPath, outDir, variant)
  if (variant !== 'compare') {
    await runPdf2zh(inputPath, outDir, options)
    return target
  }
  // compare needs the mono copy first (same pdf2zh run also produces dual).
  const mono = variantPdfPathFor(inputPath, outDir, 'mono')
  const monoExists = await fs.stat(mono).then(() => true).catch(() => false)
  if (!monoExists) await runPdf2zh(inputPath, outDir, options)
  return buildComparePdf(inputPath, mono, target)
}
