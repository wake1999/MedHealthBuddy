/**
 * Paper intake endpoints: upload a PDF, extract its text, read the text back,
 * and resolve metadata from an arXiv id / DOI / link.
 *
 * Kept out of `research.ts` (1700+ lines) so the paper pipeline stays readable
 * and the existing handlers are untouched.
 */
import {
  askPaper,
  askPaperFigure,
  runLiteratureReview,
  runPaperSkill,
  suggestPaperTags,
  summarizePaper,
  translatePaperText,
  type PaperSkill,
} from '../services/research/analysis'
import { applyReadingTemplate, readPaperNotes, savePaperNotes } from '../services/research/notes'
import { searchLibrary } from '../services/research/library-search'
import { searchPubmed } from '../services/research/pubmed'
import { extractFigureRefs } from '../services/research/caption-index'
import { importPaperFromPdf } from '../services/research/intake'
import { isResearchCollection, readStore, researchRoot, updateStore } from '../services/research/store'
import { translatePdf, variantPdfPathFor, type PdfVariant } from '../services/research/translate-pdf'
import { resolveLlmTarget } from '../services/research/llm'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { PaperNoteBlock } from '../services/research/store'
import {
  attachPaperPdf,
  extractPaperFulltext,
  readPaperFulltext,
} from '../services/research/fulltext'
import { resolvePaperMetadata } from '../services/research/metadata'

/** Same ceiling as the arXiv fetcher: a paper is well under this. */
const PAPER_PDF_LIMIT = 80 * 1024 * 1024

function profileOf(ctx: any): string | undefined {
  return ctx.state?.profile?.name
}

function fail(ctx: any, status: number, error: string, code = 'invalid_request') {
  ctx.status = status
  ctx.body = { error, code }
}

/** Map a service error code onto an HTTP response the panel can show verbatim. */
function failFromCode(ctx: any, code: string, fallback: string) {
  switch (code) {
    case 'paper_not_found':
      return fail(ctx, 404, '论文不存在', code)
    case 'paper_id_empty':
      return fail(ctx, 400, '缺少论文 id', code)
    case 'pdf_empty':
      return fail(ctx, 400, '空文件', code)
    case 'pdf_not_pdf':
      return fail(ctx, 400, '不是有效的 PDF 文件', code)
    case 'pdf_too_large':
      return fail(ctx, 413, 'PDF 超过 80MB', code)
    case 'pdf_missing':
      return fail(ctx, 409, '这篇论文还没有 PDF，请先上传或抓取', code)
    case 'pdf_path_invalid':
      return fail(ctx, 409, 'PDF 路径不在研究目录内', code)
    case 'fulltext_empty':
      return fail(ctx, 422, '这份 PDF 没有可抽取的文本层（可能是扫描件）', code)
    case 'llm_unavailable':
      return fail(ctx, 422, '当前 profile 没有可用的默认模型，请先在设置里配置', code)
    case 'summary_empty':
      return fail(ctx, 502, '模型没有返回摘要，请重试', code)
    case 'answer_empty':
      return fail(ctx, 502, '模型没有返回回答，请重试', code)
    case 'review_no_papers':
      return fail(ctx, 422, '没有可用于综述的文献', code)
    case 'vision_unavailable':
      return fail(ctx, 422, '当前 profile 没有可用的视觉模型，请在设置里配置一个（如 qwen3.8-flash）', code)
    default:
      return fail(ctx, 500, code || fallback)
  }
}

/**
 * POST `/api/studio/research/papers/:id/pdf`
 *
 * Raw `application/pdf` body (same shape as the figure upload). Storing the
 * bytes and extracting the text both happen here, so the panel needs one call.
 */
export async function uploadPaperPdf(ctx: any) {
  const paperId = String(ctx.params.id || '').trim()
  if (paperId === '') return fail(ctx, 400, '缺少论文 id')

  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of ctx.req) {
      const buf = chunk as Buffer
      size += buf.length
      if (size > PAPER_PDF_LIMIT) return fail(ctx, 413, 'PDF 超过 80MB', 'pdf_too_large')
      chunks.push(buf)
    }
  } catch {
    return fail(ctx, 400, '读取上传数据失败')
  }

  const bytes = Buffer.concat(chunks)
  if (bytes.length === 0) return fail(ctx, 400, '空文件')

  let paper
  try {
    paper = await attachPaperPdf(profileOf(ctx), paperId, bytes)
  } catch (error: any) {
    return failFromCode(ctx, String(error?.message || ''), '上传 PDF 失败')
  }

  // Extraction is best-effort: a scanned PDF keeps the upload and reports why
  // the text layer is missing, instead of failing the whole request.
  let fulltextError = ''
  try {
    paper = (await extractPaperFulltext(profileOf(ctx), paperId)).paper
  } catch (error: any) {
    fulltextError = String(error?.message || 'fulltext_failed')
  }

  ctx.body = { paper, fulltextError }
}

/** POST `/api/studio/research/papers/:id/fulltext` — (re)extract an existing PDF. */
export async function extractPaperFulltextHandler(ctx: any) {
  const paperId = String(ctx.params.id || '').trim()
  if (paperId === '') return fail(ctx, 400, '缺少论文 id')
  try {
    const { paper, text } = await extractPaperFulltext(profileOf(ctx), paperId)
    ctx.body = { paper, chars: text.length }
  } catch (error: any) {
    return failFromCode(ctx, String(error?.message || ''), '抽取全文失败')
  }
}

/** GET `/api/studio/research/papers/:id/fulltext` — text for the reader / Q&A. */
export async function readPaperFulltextHandler(ctx: any) {
  const paperId = String(ctx.params.id || '').trim()
  if (paperId === '') return fail(ctx, 400, '缺少论文 id')
  try {
    const { paper, text } = await readPaperFulltext(profileOf(ctx), paperId)
    ctx.body = { paper, text, chars: text.length }
  } catch (error: any) {
    return failFromCode(ctx, String(error?.message || ''), '读取全文失败')
  }
}

/**
 * POST `/api/studio/research/papers/resolve` — `{ input }`
 *
 * Recognises an arXiv id / DOI / arXiv link and returns what the registry
 * knows. Writes nothing: the panel previews, the user confirms.
 */
export async function resolvePaperMetadataHandler(ctx: any) {
  const body = ctx.request?.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail(ctx, 400, '请求体无效')
  }
  const input = String((body as Record<string, unknown>).input ?? '').trim()
  if (input === '') return fail(ctx, 400, '请输入 arXiv 编号、DOI 或链接')

  try {
    const metadata = await resolvePaperMetadata(input)
    ctx.body = { metadata }
  } catch (error: any) {
    ctx.status = 502
    ctx.body = { error: error?.message || '解析元数据失败', code: 'metadata_failed' }
  }
}

/**
 * POST `/api/studio/research/papers/:id/summary`
 *
 * Five-part structured summary from the full text, saved on the paper so the
 * panel can show it without paying for the call twice.
 */
export async function summarizePaperHandler(ctx: any) {
  const paperId = String(ctx.params.id || '').trim()
  if (paperId === '') return fail(ctx, 400, '缺少论文 id')
  try {
    const { paper, summary } = await summarizePaper(profileOf(ctx), paperId)
    ctx.body = { paper, summary }
  } catch (error: any) {
    return failFromCode(ctx, String(error?.message || ''), '生成摘要失败')
  }
}

/**
 * POST `/api/studio/research/papers/:id/ask` — `{ question }`
 *
 * Answers from the retrieved page chunks only, and cites the pages it used.
 */
export async function askPaperHandler(ctx: any) {
  const paperId = String(ctx.params.id || '').trim()
  if (paperId === '') return fail(ctx, 400, '缺少论文 id')
  const body = ctx.request?.body
  const question = body && typeof body === 'object' && !Array.isArray(body)
    ? String((body as Record<string, unknown>).question ?? '').trim()
    : ''
  if (question === '') return fail(ctx, 400, '请输入问题')
  if (question.length > 1000) return fail(ctx, 400, '问题过长')

  try {
    const { answer, pages, citations } = await askPaper(profileOf(ctx), paperId, question)
    ctx.body = { answer, pages, citations }
  } catch (error: any) {
    return failFromCode(ctx, String(error?.message || ''), '回答失败')
  }
}

const PAPER_SKILLS: ReadonlySet<string> = new Set(['full_read', 'passage_qa', 'figure_qa', 'concept'])

/**
 * POST `/api/studio/research/papers/:id/skill` — `{ skill, question? }`
 *
 * One entry point for the paper-level analyses (`full_read`, `passage_qa`,
 * `figure_qa`, `concept`); the shape of the answer is the same for all four.
 */
export async function runPaperSkillHandler(ctx: any) {
  const paperId = String(ctx.params.id || '').trim()
  if (paperId === '') return fail(ctx, 400, '缺少论文 id')

  const body = ctx.request?.body
  const raw = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {}
  const skill = String(raw.skill ?? '').trim()
  if (!PAPER_SKILLS.has(skill)) return fail(ctx, 400, '未知的分析类型')
  const question = String(raw.question ?? '').trim()
  if ((skill === 'passage_qa' || skill === 'figure_qa') && question === '') {
    return fail(ctx, 400, '这个分析需要一个问题')
  }
  if (question.length > 1000) return fail(ctx, 400, '问题过长')

  try {
    const result = await runPaperSkill(profileOf(ctx), paperId, skill as PaperSkill, question)
    ctx.body = result
  } catch (error: any) {
    return failFromCode(ctx, String(error?.message || ''), '分析失败')
  }
}

/**
 * POST `/api/studio/research/papers/import-pdf?projectId=&filename=`
 *
 * Raw `application/pdf` body. Creates the paper first (title from the PDF's own
 * metadata, else the file name), then stores and extracts it — the missing
 * "I have a PDF, put it in the library" path.
 */
export async function importPaperPdfHandler(ctx: any) {
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of ctx.req) {
      const buf = chunk as Buffer
      size += buf.length
      if (size > PAPER_PDF_LIMIT) return fail(ctx, 413, 'PDF 超过 80MB', 'pdf_too_large')
      chunks.push(buf)
    }
  } catch {
    return fail(ctx, 400, '读取上传数据失败')
  }

  const bytes = Buffer.concat(chunks)
  if (bytes.length === 0) return fail(ctx, 400, '空文件')

  const projectId = String(ctx.query?.projectId ?? '').trim()
  const filename = String(ctx.query?.filename ?? '').trim()

  try {
    const result = await importPaperFromPdf(profileOf(ctx), bytes, {
      ...(projectId === '' ? {} : { projectId }),
      ...(filename === '' ? {} : { filename }),
    })
    ctx.body = result
  } catch (error: any) {
    return failFromCode(ctx, String(error?.message || ''), '导入 PDF 失败')
  }
}

/**
 * POST `/api/studio/research/papers/:id/translate` — `{ text }`
 *
 * One-shot translation of the paper's body text (one page, or a selected
 * passage). Returns the Chinese translation only; nothing is persisted.
 */
export async function translatePaperHandler(ctx: any) {
  const paperId = String(ctx.params.id || '').trim()
  if (paperId === '') return fail(ctx, 400, '缺少论文 id')

  const body = ctx.request?.body
  const raw = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {}
  const text = String(raw.text ?? '').trim()
  if (text === '') return fail(ctx, 400, '要翻译的正文不能为空')
  if (text.length > 20_000) return fail(ctx, 400, '正文过长')

  try {
    const output = await translatePaperText(profileOf(ctx), text)
    ctx.body = { output }
  } catch (error: any) {
    return failFromCode(ctx, String(error?.message || ''), '翻译失败')
  }
}

/**
 * POST `/api/studio/research/papers/:id/translate-pdf` — whole-document
 * translation that keeps the original layout.
 *
 * Shells out to `pdf2zh` (PDFMathTranslate) which writes `<name>-dual.pdf`
 * beside the source: source text and Chinese translation side by side. The
 * result is cached — a dual file newer than the source PDF is returned as-is,
 * so re-opening a paper costs nothing.
 *
 * @returns the dual PDF bytes, ready to feed straight into the reader canvas.
 */
export async function translatePaperPdfHandler(ctx: any) {
  const paperId = String(ctx.params.id || '').trim()
  if (paperId === '') return fail(ctx, 400, '缺少论文 id')

  const profile = profileOf(ctx)
  const store = await readStore(profile)
  const matches = store.papers.filter(row => row.arxivId === paperId || row.id === paperId)
  const paper = matches.find(row => (row.pdfPath ?? '').trim() !== '')
  if (paper === undefined) return failFromCode(ctx, 'pdf_not_found', '这篇文献还没有 PDF')

  const stored = (paper.pdfPath ?? '').trim()
  const root = path.resolve(researchRoot(profile))
  const source = path.resolve(stored)
  if (source !== root && !source.startsWith(`${root}${path.sep}`)) {
    return fail(ctx, 400, 'PDF 路径非法', 'pdf_path_invalid')
  }

  const outDir = path.dirname(source)
  // `compare` = source page | translated page, double width (the reader's
  // "原文 / 译文" spread); `mono` = body text swapped in place; `dual` = alternating.
  const requested = String(ctx.query?.variant ?? 'compare').trim()
  const variant: PdfVariant = requested === 'mono' || requested === 'dual' ? requested : 'compare'
  const target = variantPdfPathFor(source, outDir, variant)
  const abort = new AbortController()
  const onRequestAborted = (): void => { abort.abort() }
  const onResponseClosed = (): void => {
    // A normal response close has writableEnded=true; only a client-side
    // disconnect should stop the pdf2zh process tree.
    if (!ctx.res.writableEnded) abort.abort()
  }
  ctx.req?.once('aborted', onRequestAborted)
  ctx.res?.once('close', onResponseClosed)

  try {
    // Reuse a cached translation when it is at least as new as the source.
    const [sourceStat, targetStat] = await Promise.all([
      fs.stat(source),
      fs.stat(target).catch(() => null),
    ])
    if (targetStat === null || targetStat.mtimeMs < sourceStat.mtimeMs) {
      // Translate with the model the panel is already using, so the wording
      // matches the rest of the workspace. Falls back to bing if unresolved.
      const llm = await resolveLlmTarget(profile)
      const model = llm !== null && llm.apiKey !== ''
        ? { baseUrl: llm.baseUrl, apiKey: llm.apiKey, model: llm.model }
        : undefined
      await translatePdf(source, outDir, variant, {
        ...(model === undefined ? {} : { model }),
        signal: abort.signal,
      })
    }
    if (abort.signal.aborted) return
    const bytes = await fs.readFile(target)
    // 记下翻译时间：卡片据此显示「已翻译」徽章，菜单也能避免重复翻译。
    await updateStore(profile, 'papers.translated', draft => {
      const row = draft.papers.find(item => item.id === paper.id)
      if (row === undefined) return null
      row.translatedAt = Date.now()
      return row
    }).catch(() => null)
    /*
     * The Web UI fetches this endpoint. Returning `application/pdf` makes
     * Chrome and download managers such as IDM treat it as a file download,
     * and `Content-Disposition: inline` additionally makes Chrome answer the
     * fetch with 204. Both modes below keep the response as JSON:
     *  - `json` only reports completion (card menu / badge trigger);
     *  - `base64` carries the PDF bytes for the reader without a PDF MIME type.
     * The plain PDF fallback remains for older clients.
     */
    const responseFormat = String(ctx.query?.format ?? '').trim().toLowerCase()
    if (responseFormat === 'json' || responseFormat === 'base64') {
      ctx.set('Content-Type', 'application/json; charset=utf-8')
      ctx.set('Cache-Control', 'no-store')
      ctx.body = JSON.stringify(responseFormat === 'json'
        ? { ok: true, variant }
        : { ok: true, variant, base64: bytes.toString('base64') })
      return
    }
    ctx.set('Content-Type', 'application/pdf')
    ctx.set('Cache-Control', 'no-store')
    ctx.body = bytes
  } catch (error: any) {
    // The reader already disconnected; there is no response to write. Keep any
    // earlier completed translation on disk instead of deleting it.
    if (abort.signal.aborted || /translation_aborted/.test(String(error?.message || ''))) return
    return fail(ctx, 500, String(error?.message || '整篇翻译失败'), 'translate_pdf_failed')
  } finally {
    ctx.req?.removeListener('aborted', onRequestAborted)
    ctx.res?.removeListener('close', onResponseClosed)
  }
}

/**
 * POST `/api/studio/research/papers/:id/suggest` — `{ projectTitle? }`
 *
 * Proposes tags and a relevance score without writing anything; the panel shows
 * the proposal and applies it only after the reader confirms.
 */
export async function suggestPaperTagsHandler(ctx: any) {
  const paperId = String(ctx.params.id || '').trim()
  if (paperId === '') return fail(ctx, 400, '缺少论文 id')
  const body = ctx.request?.body
  const raw = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {}
  const projectTitle = String(raw.projectTitle ?? '').trim().slice(0, 200)

  try {
    ctx.body = await suggestPaperTags(profileOf(ctx), paperId, projectTitle)
  } catch (error: any) {
    return failFromCode(ctx, String(error?.message || ''), '生成标签建议失败')
  }
}

/**
 * GET `/api/studio/research/papers/:id/figures`
 *
 * Caption index parsed from the full text: label, kind, page and title. The
 * panel uses it to jump straight to a figure without typing its number.
 */
export async function listPaperFiguresHandler(ctx: any) {
  const paperId = String(ctx.params.id || '').trim()
  if (paperId === '') return fail(ctx, 400, '缺少论文 id')
  try {
    ctx.body = { figures: await extractFigureRefs(profileOf(ctx), paperId) }
  } catch (error: any) {
    return failFromCode(ctx, String(error?.message || ''), '读取图表清单失败')
  }
}

/**
 * POST `/api/studio/research/papers/:id/vision` — `{ question, images: string[] }`
 *
 * Looks at rendered page images (figures, tables) with a vision-capable model.
 * The images come from the panel's own canvas, so the server never renders PDFs.
 */
export async function askPaperFigureHandler(ctx: any) {
  const paperId = String(ctx.params.id || '').trim()
  if (paperId === '') return fail(ctx, 400, '缺少论文 id')

  const body = ctx.request?.body
  const raw = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {}
  const question = String(raw.question ?? '').trim()
  if (question === '') return fail(ctx, 400, '请输入问题')
  if (question.length > 1000) return fail(ctx, 400, '问题过长')

  const images = Array.isArray(raw.images)
    ? (raw.images as unknown[]).map(item => String(item ?? '')).filter(item => item !== '')
    : []
  if (images.length === 0) return fail(ctx, 400, '缺少页面截图')
  if (images.length > 3) return fail(ctx, 400, '一次最多 3 张图')
  if (images.reduce((sum, item) => sum + item.length, 0) > 12_000_000) {
    return fail(ctx, 413, '图片过大，请降低缩放后再试')
  }

  try {
    ctx.body = await askPaperFigure(profileOf(ctx), paperId, question, images)
  } catch (error: any) {
    return failFromCode(ctx, String(error?.message || ''), '图像解读失败')
  }
}

/**
 * POST `/api/studio/research/review` — `{ projectId?, paperIds?, topic? }`
 *
 * Cross-paper review: groups the library's papers by theme, compares methods,
 * and names the gaps. Paper bodies come from the AI summary when present.
 */
export async function runLiteratureReviewHandler(ctx: any) {
  const body = ctx.request?.body
  const raw = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {}
  const projectId = String(raw.projectId ?? '').trim()
  const topic = String(raw.topic ?? '').trim()
  const paperIds = Array.isArray(raw.paperIds) ? (raw.paperIds as unknown[]).map(String) : []
  if (topic.length > 500) return fail(ctx, 400, '主题过长')

  try {
    ctx.body = await runLiteratureReview(profileOf(ctx), {
      ...(projectId === '' ? {} : { projectId }),
      ...(paperIds.length === 0 ? {} : { paperIds }),
      ...(topic === '' ? {} : { topic }),
    })
  } catch (error: any) {
    return failFromCode(ctx, String(error?.message || ''), '生成综述失败')
  }
}

/**
 * GET `/api/studio/research/pubmed/search?q=&max=`
 *
 * PubMed via E-utilities: search → summary → abstracts. Same result shape as
 * the arXiv search so the panel can reuse one result card.
 */
export async function searchPubmedHandler(ctx: any) {
  const query = String(ctx.query?.q ?? '').trim()
  if (query === '') return fail(ctx, 400, '请输入检索词')
  const maxRaw = Number(ctx.query?.max)
  try {
    ctx.body = await searchPubmed(query, Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : 10)
  } catch (error: any) {
    ctx.status = 502
    ctx.body = { entries: [], query, error: error?.message || 'PubMed 检索失败', tookMs: 0 }
  }
}

/** GET `/api/studio/research/papers/:id/notes` — blocks, migrating the legacy blob once. */
export async function readPaperNotesHandler(ctx: any) {
  const paperId = String(ctx.params.id || '').trim()
  if (paperId === '') return fail(ctx, 400, '缺少论文 id')
  try {
    const { paper, blocks, migrated } = await readPaperNotes(profileOf(ctx), paperId)
    ctx.body = { paper, blocks, migrated }
  } catch (error: any) {
    return failFromCode(ctx, String(error?.message || ''), '读取笔记失败')
  }
}

/**
 * PUT `/api/studio/research/papers/:id/notes` — `{ blocks }`
 *
 * Replaces the block list. `@paper:` mentions that do not resolve come back in
 * `brokenLinks` so the panel can flag them without rejecting the save.
 */
export async function savePaperNotesHandler(ctx: any) {
  const paperId = String(ctx.params.id || '').trim()
  if (paperId === '') return fail(ctx, 400, '缺少论文 id')
  const body = ctx.request?.body
  const blocks = body && typeof body === 'object' && !Array.isArray(body) && Array.isArray((body as any).blocks)
    ? ((body as any).blocks as PaperNoteBlock[])
    : null
  if (!blocks) return fail(ctx, 400, '缺少 blocks')
  if (blocks.length > 500) return fail(ctx, 400, '笔记块过多')

  try {
    const { paper, brokenLinks } = await savePaperNotes(profileOf(ctx), paperId, blocks)
    ctx.body = { paper, brokenLinks }
  } catch (error: any) {
    return failFromCode(ctx, String(error?.message || ''), '保存笔记失败')
  }
}

/** POST `/api/studio/research/papers/:id/notes/template` — append the five close-read prompts. */
export async function applyReadingTemplateHandler(ctx: any) {
  const paperId = String(ctx.params.id || '').trim()
  if (paperId === '') return fail(ctx, 400, '缺少论文 id')
  try {
    const { paper, blocks } = await applyReadingTemplate(profileOf(ctx), paperId)
    ctx.body = { paper, blocks }
  } catch (error: any) {
    return failFromCode(ctx, String(error?.message || ''), '插入模板失败')
  }
}

/**
 * POST `/api/studio/research/items/:collection/batch`
 *
 * Body is either `{ ids: string[], patch }` or `{ items: [{ id, patch }] }`.
 * Returns the previous values per row so the caller can offer one-click undo:
 * sending the returned `undo` back as `items` reverts the batch.
 */
export async function batchUpdateItemsHandler(ctx: any) {
  const collection = String(ctx.params.collection || '').trim()
  if (!isResearchCollection(collection)) return fail(ctx, 400, '未知集合')
  const body = ctx.request?.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(ctx, 400, '请求体无效')

  const raw = body as Record<string, unknown>
  const patch = raw.patch && typeof raw.patch === 'object' && !Array.isArray(raw.patch)
    ? (raw.patch as Record<string, unknown>)
    : null
  const ids = Array.isArray(raw.ids) ? raw.ids.map(id => String(id)) : []
  const items = Array.isArray(raw.items)
    ? (raw.items as Array<{ id?: unknown; patch?: unknown }>)
      .map(item => ({
        id: String(item?.id ?? ''),
        patch: item?.patch && typeof item.patch === 'object' && !Array.isArray(item.patch)
          ? (item.patch as Record<string, unknown>)
          : null,
      }))
      .filter(item => item.id !== '' && item.patch !== null)
    : []

  if (items.length === 0 && (ids.length === 0 || patch === null)) {
    return fail(ctx, 400, '需要 ids+patch 或 items')
  }
  if (ids.length + items.length > 500) return fail(ctx, 400, '单次最多 500 条')

  try {
    const target = items.length > 0
      ? items
      : ids.map(id => ({ id, patch: patch as Record<string, unknown> }))

    const undo: Array<{ id: string; patch: Record<string, unknown> }> = []
    const result = await updateStore(profileOf(ctx), `${collection}.batch-updated`, draft => {
      const list = draft[collection] as unknown as Array<Record<string, unknown>>
      let updated = 0
      for (const entry of target) {
        const row = list.find(item => String(item.id) === entry.id)
        if (row === undefined) continue
        const entryPatch = entry.patch as Record<string, unknown>
        const previous: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(entryPatch)) {
          // Never let a batch rewrite identity or ownership.
          if (key === 'id' || key === 'projectId' || key === 'addedAt' || key === 'createdAt') continue
          previous[key] = row[key]
          row[key] = value
        }
        if (Object.keys(previous).length > 0) {
          undo.push({ id: entry.id, patch: previous })
          updated += 1
        }
      }
      return updated > 0 ? { updated, undo } : null
    })

    if (result === null) return fail(ctx, 404, '没有可更新的记录', 'nothing_updated')
    ctx.body = result
  } catch (error: any) {
    ctx.status = 500
    ctx.body = { error: error?.message || '批量更新失败', code: 'batch_failed' }
  }
}

/**
 * GET `/api/studio/research/library/search?q=&projectId=&limit=`
 *
 * Searches titles, authors, tags, notes, AI summaries and the extracted full
 * text on disk. Matching folds punctuation so `3,000` finds `3000`.
 */
export async function searchLibraryHandler(ctx: any) {
  const query = String(ctx.query?.q ?? '').trim()
  if (query === '') return fail(ctx, 400, '请输入检索词')
  const projectId = String(ctx.query?.projectId ?? '').trim()
  const limitRaw = Number(ctx.query?.limit)
  try {
    const result = await searchLibrary(profileOf(ctx), query, {
      ...(projectId ? { projectId } : {}),
      ...(Number.isFinite(limitRaw) && limitRaw > 0 ? { limit: limitRaw } : {}),
    })
    ctx.body = result
  } catch (error: any) {
    ctx.status = 502
    ctx.body = { error: error?.message || '检索失败', code: 'search_failed' }
  }
}
