/**
 * Paper PDF intake and full-text extraction.
 *
 * The literature view used to be arXiv-only: a paper either had a fetched PDF
 * or nothing. This module makes any PDF a first-class paper:
 *
 *   upload bytes → references/<paperId>.pdf → text → references/<paperId>.md
 *
 * The extracted text keeps page markers (`## Page 3`), so a later model answer
 * can cite a page number and the reader can jump to it. Parsing happens on the
 * same disk as the PDF; nothing is cached outside the project directory.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { projectDir } from './paper'
import { readStore, researchRoot, updateStore, type ResearchPaper } from './store'

/** A scanned paper can be large; keep the same ceiling as the arXiv fetcher. */
const MAX_PDF_BYTES = 80 * 1024 * 1024
/** Guard against a pathological text layer blowing up the state file. */
const MAX_FULLTEXT_CHARS = 2_000_000

/**
 * `pdfjs-dist` 5.x ships ESM only. This server is compiled to CommonJS, where a
 * plain `import()` gets rewritten to `require()` and fails, so the specifier is
 * imported through `new Function` to keep a real dynamic import.
 */
const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<any>

interface PaperLocation {
  paper: ResearchPaper
  dir: string
}

/** Locate a paper by row id across the profile (the panel knows the id, not the project). */
async function locatePaper(profile: string | undefined, paperId: string): Promise<PaperLocation> {
  const id = paperId.trim()
  if (id === '') throw new Error('paper_id_empty')
  const store = await readStore(profile)
  const paper = store.papers.find(row => row.id === id || row.arxivId === id)
  if (paper === undefined) throw new Error('paper_not_found')
  const dir = path.join(projectDir(paper.projectId, profile), 'references')
  return { paper, dir }
}

function pdfTarget(dir: string, paper: ResearchPaper): string {
  const safe = (paper.id || 'paper').replace(/[^A-Za-z0-9._-]/g, '_')
  return path.join(dir, `${safe}.pdf`)
}

function fulltextTarget(dir: string, paper: ResearchPaper): string {
  const safe = (paper.id || 'paper').replace(/[^A-Za-z0-9._-]/g, '_')
  return path.join(dir, `${safe}.md`)
}

/** Reject anything that is not actually a PDF before it reaches the parser. */
export function assertPdfBytes(bytes: Buffer): void {
  if (bytes.length === 0) throw new Error('pdf_empty')
  if (bytes.length > MAX_PDF_BYTES) throw new Error('pdf_too_large')
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('pdf_not_pdf')
}

/**
 * Store uploaded bytes as the paper's PDF and record the path.
 * @param profile - research profile.
 * @param paperId - the paper row id (arXiv id also accepted).
 * @param bytes - raw upload body.
 */
export async function attachPaperPdf(
  profile: string | undefined,
  paperId: string,
  bytes: Buffer,
): Promise<ResearchPaper> {
  assertPdfBytes(bytes)
  const { paper, dir } = await locatePaper(profile, paperId)
  await fs.mkdir(dir, { recursive: true })
  const target = pdfTarget(dir, paper)
  await fs.writeFile(target, bytes)

  const updated = await updateStore(profile, 'papers.pdf-uploaded', draft => {
    const row = draft.papers.find(item => item.id === paper.id)
    if (row === undefined) return null
    row.pdfPath = target
    return row
  })
  if (updated === null) throw new Error('paper_not_found')
  return updated
}

/** Pull the text layer out of a PDF, one `## Page N` block per page. */
async function extractText(bytes: Buffer): Promise<string> {
  const pdfjs = await dynamicImport('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise

  const pages: string[] = []
  for (let index = 1; index <= doc.numPages; index += 1) {
    const page = await doc.getPage(index)
    const content = await page.getTextContent()
    const text = (content.items as Array<{ str?: unknown }>)
      .map(item => (typeof item.str === 'string' ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    pages.push(`## Page ${index}\n\n${text}`)
    page.cleanup?.()
  }
  await doc.destroy?.()
  return pages.join('\n\n')
}

/**
 * Extract the paper's PDF into text and remember where it landed.
 * @param profile - research profile.
 * @param paperId - the paper row id.
 * @returns the stored row plus the extracted text.
 */
export async function extractPaperFulltext(
  profile: string | undefined,
  paperId: string,
): Promise<{ paper: ResearchPaper; text: string }> {
  const { paper, dir } = await locatePaper(profile, paperId)
  const source = (paper.pdfPath ?? '').trim()
  if (source === '') throw new Error('pdf_missing')

  const root = path.resolve(researchRoot(profile))
  const resolved = path.resolve(source)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('pdf_path_invalid')

  const bytes = await fs.readFile(resolved)
  const text = (await extractText(bytes)).slice(0, MAX_FULLTEXT_CHARS)
  if (text.trim() === '') throw new Error('fulltext_empty')

  await fs.mkdir(dir, { recursive: true })
  const target = fulltextTarget(dir, paper)
  await fs.writeFile(target, text, 'utf-8')

  const updated = await updateStore(profile, 'papers.fulltext-extracted', draft => {
    const row = draft.papers.find(item => item.id === paper.id)
    if (row === undefined) return null
    row.fulltextPath = target
    row.fulltextChars = text.length
    return row
  })
  if (updated === null) throw new Error('paper_not_found')
  return { paper: updated, text }
}

/**
 * Read a paper's extracted text, extracting it first when the file is missing.
 * @param profile - research profile.
 * @param paperId - the paper row id.
 */
export async function readPaperFulltext(
  profile: string | undefined,
  paperId: string,
): Promise<{ paper: ResearchPaper; text: string }> {
  const { paper } = await locatePaper(profile, paperId)
  const stored = (paper.fulltextPath ?? '').trim()
  if (stored === '') return extractPaperFulltext(profile, paperId)
  try {
    const text = await fs.readFile(stored, 'utf-8')
    return { paper, text }
  } catch {
    return extractPaperFulltext(profile, paperId)
  }
}
