/**
 * Create a paper record straight from an uploaded PDF.
 *
 * The older flow required a paper row to exist before a PDF could be attached,
 * which made "I have a PDF on disk" a dead end in the panel. This builds the
 * record first (title from the PDF's own metadata, falling back to the file
 * name), then runs the usual store → extract path.
 */
import { newId, readStore, updateStore, type ResearchPaper } from './store'
import { assertPdfBytes, attachPaperPdf, extractPaperFulltext } from './fulltext'

/** Isolate the ESM import from the CommonJS build, same trick as fulltext.ts. */
async function dynamicImport(specifier: string): Promise<any> {
  const importer = new Function('s', 'return import(s)') as (s: string) => Promise<any>
  return importer(specifier)
}

/** PDF metadata is often machine-generated junk; keep only plausible titles. */
function cleanTitle(raw: string): string {
  const value = raw.replace(/\s+/g, ' ').trim()
  if (value.length < 8) return ''
  if (/^microsoft (word|powerpoint|office)/i.test(value)) return ''
  if (/\.(docx?|pptx?|tex|pdf|indd)$/i.test(value)) return ''
  return value.slice(0, 300)
}

/** `Administrator` and friends are never an author list. */
function cleanAuthors(raw: string): string {
  const value = raw.replace(/\s+/g, ' ').trim()
  if (value.length < 3) return ''
  if (/^(administrator|admin|user|owner|unknown|microsoft|windows)/i.test(value)) return ''
  return value.slice(0, 300)
}

/** `MILCAnet_ a dominant…detection_2.pdf` → `MILCAnet a dominant…detection`. */
export function titleFromFilename(filename: string): string {
  return filename
    .replace(/\.pdf$/i, '')
    .replace(/_\d+$/, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

/**
 * Import one PDF as a new paper.
 * @param profile - research profile.
 * @param bytes - raw upload body.
 * @param options - owning project and the original file name.
 */
export async function importPaperFromPdf(
  profile: string | undefined,
  bytes: Buffer,
  options: { projectId?: string; filename?: string } = {},
): Promise<{ paper: ResearchPaper; fulltextChars: number | null; fulltextError: string }> {
  assertPdfBytes(bytes)

  let metaTitle = ''
  let metaAuthors = ''
  try {
    const pdfjs = await dynamicImport('pdfjs-dist/legacy/build/pdf.mjs')
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
    }).promise
    const meta = await doc.getMetadata().catch(() => null)
    const info = (meta as any)?.info ?? {}
    metaTitle = cleanTitle(String(info.Title ?? ''))
    metaAuthors = cleanAuthors(String(info.Author ?? ''))
    await doc.destroy?.()
  } catch {
    // Metadata is a nicety; the file name still gives a usable title.
  }

  const filename = String(options.filename ?? '').trim()
  const title = metaTitle !== '' ? metaTitle : (titleFromFilename(filename) || '未命名文献')
  let projectId = String(options.projectId ?? '').trim()
  if (projectId === '') {
    // 面板没选项目时（用户只是想先把 PDF 存进库里）落到第一个项目：
    // 之前这里把空串一路传到 projectDir('')，直接抛 invalid_project_id，
    // 上传就变成 500，卡片自然也不会出现。
    const store = await readStore(profile)
    projectId = store.projects[0]?.id ?? ''
  }
  if (projectId === '') throw new Error('project_required')

  const created = await updateStore(profile, 'papers.imported-from-pdf', draft => {
    const paper: ResearchPaper = {
      id: newId('paper'),
      projectId,
      title,
      authors: metaAuthors,
      year: '',
      venue: 'PDF',
      doi: '',
      url: '',
      arxivId: '',
      score: 0,
      status: 'new',
      notes: '',
      tags: [],
      addedAt: Date.now(),
    }
    draft.papers.push(paper)
    return paper
  })
  if (created === null) throw new Error('paper_create_failed')

  await attachPaperPdf(profile, created.id, bytes)

  // Extraction is best-effort: a scanned PDF still imports, minus its text.
  let fulltextChars: number | null = null
  let fulltextError = ''
  try {
    const { text } = await extractPaperFulltext(profile, created.id)
    fulltextChars = text.length
  } catch (error: any) {
    fulltextError = String(error?.message ?? '')
  }

  return { paper: created, fulltextChars, fulltextError }
}
