/**
 * Structured paper notes.
 *
 * The old `paper.notes` is one free-text blob with `[YYYY-MM-DD HH:mm]`
 * prefixes. That is fine for typing but cannot carry a page anchor, cannot be
 * lifted into the knowledge layer, and cannot be validated. This module adds
 * note *blocks* next to it (the blob keeps rendering for old records) and owns
 * the reading template.
 */
import { randomBytes } from 'node:crypto'

import { readStore, updateStore, type PaperNoteBlock, type ResearchPaper } from './store'

/** The five sections every close read should answer. */
export const READING_TEMPLATE = [
  '研究问题：这篇论文要解决什么？',
  '数据与方法：用了什么数据、什么方法？',
  '主要结论：核心结果是什么（带数字）？',
  '局限：作者承认或可推断的局限？',
  '可复用点：哪一部分能直接搬进我们的工作？',
] as const

/** `@paper:<id>` / `@paper:<arxivId>` mentions, used for link validation. */
const PAPER_MENTION = /@paper:([A-Za-z0-9._-]+)/g
/** Legacy block prefix written by `appendReadingNote`. */
const LEGACY_STAMP = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\s*/m

function newBlockId(): string {
  return `note_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`
}

/**
 * Turn the legacy free-text blob into blocks, one per timestamped entry.
 * Records without stamps become a single block so nothing is lost.
 * @param notes - the raw `paper.notes` value.
 */
export function parseLegacyNotes(notes: string): PaperNoteBlock[] {
  const raw = String(notes || '').trim()
  if (raw === '') return []

  const parts = raw.split(/\n{2,}(?=\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\])/)
  const blocks: PaperNoteBlock[] = []
  parts.forEach((part, index) => {
    const text = part.trim()
    if (text === '') return
    const stamp = text.match(LEGACY_STAMP)
    const content = stamp ? text.replace(LEGACY_STAMP, '').trim() : text
    if (content === '') return
    const parsed = stamp ? Date.parse(`${stamp[1].replace(' ', 'T')}:00`) : Number.NaN
    const at = Number.isFinite(parsed) ? parsed : Date.now() + index
    blocks.push({
      id: `note_legacy_${index}_${Math.abs(at)}`,
      kind: 'note',
      content,
      createdAt: at,
    })
  })
  return blocks
}

/** Fresh blocks for one reading session; empty content, ready to fill. */
export function buildTemplateBlocks(): PaperNoteBlock[] {
  const at = Date.now()
  return READING_TEMPLATE.map((section, index) => ({
    id: `note_tpl_${at.toString(36)}_${index}`,
    kind: 'note' as const,
    content: section,
    createdAt: at + index,
  }))
}

interface LocatedPaper {
  paper: ResearchPaper
}

async function locate(profile: string | undefined, paperId: string): Promise<LocatedPaper> {
  const id = String(paperId || '').trim()
  if (id === '') throw new Error('paper_id_empty')
  const store = await readStore(profile)
  const paper = store.papers.find(row => row.id === id || row.arxivId === id)
  if (paper === undefined) throw new Error('paper_not_found')
  return { paper }
}

/**
 * Read a paper's blocks, migrating the legacy blob on first access.
 * @param profile - research profile.
 * @param paperId - paper row id or arXiv id.
 */
export async function readPaperNotes(
  profile: string | undefined,
  paperId: string,
): Promise<{ paper: ResearchPaper; blocks: PaperNoteBlock[]; migrated: boolean }> {
  const { paper } = await locate(profile, paperId)
  if (Array.isArray(paper.noteBlocks)) {
    return { paper, blocks: paper.noteBlocks, migrated: false }
  }
  const migratedBlocks = parseLegacyNotes(paper.notes)
  if (migratedBlocks.length === 0) return { paper, blocks: [], migrated: false }

  const updated = await updateStore(profile, 'papers.notes-migrated', draft => {
    const row = draft.papers.find(item => item.id === paper.id)
    if (row === undefined) return null
    row.noteBlocks = migratedBlocks
    return row
  })
  return { paper: updated ?? paper, blocks: migratedBlocks, migrated: updated !== null }
}

/**
 * Every `@paper:` mention that does not resolve to a real paper.
 * @param blocks - the blocks about to be saved.
 */
export async function findBrokenLinks(
  profile: string | undefined,
  blocks: readonly PaperNoteBlock[],
): Promise<string[]> {
  const mentions = new Set<string>()
  for (const block of blocks) {
    for (const match of block.content.matchAll(PAPER_MENTION)) mentions.add(match[1])
  }
  if (mentions.size === 0) return []

  const store = await readStore(profile)
  const known = new Set<string>()
  for (const paper of store.papers) {
    if (paper.id) known.add(paper.id)
    if (paper.arxivId) known.add(paper.arxivId)
  }
  return [...mentions].filter(mention => !known.has(mention))
}

/**
 * Replace a paper's blocks.
 * @param profile - research profile.
 * @param paperId - paper row id or arXiv id.
 * @param blocks - the new list (order is preserved).
 */
export async function savePaperNotes(
  profile: string | undefined,
  paperId: string,
  blocks: readonly PaperNoteBlock[],
): Promise<{ paper: ResearchPaper; brokenLinks: string[] }> {
  const { paper } = await locate(profile, paperId)
  const normalized: PaperNoteBlock[] = blocks
    .map(block => ({
      id: String(block.id || '').trim() || newBlockId(),
      kind: (['note', 'highlight', 'question', 'claim', 'gap', 'ink'] as const).includes(block.kind as never)
        ? block.kind
        : 'note',
      content: String(block.content ?? ''),
      ...(String(block.comment ?? '').trim() !== '' ? { comment: String(block.comment).trim() } : {}),
      ...(block.highlightHidden === true ? { highlightHidden: true } : {}),
      // 只接受 #rgb/#rrggbb/#rrggbbaa，别的一律丢弃，避免存进奇怪的字符串。
      ...(/^#[0-9a-f]{3,8}$/i.test(String(block.color ?? '').trim())
        ? { color: String(block.color).trim().toLowerCase() }
        : {}),
      ...(block.anchor && (block.anchor.page !== undefined || block.anchor.quote
        || block.anchor.rects || block.anchor.strokes)
        ? {
            anchor: {
              ...(block.anchor.page ? { page: Number(block.anchor.page) } : {}),
              ...(block.anchor.quote ? { quote: String(block.anchor.quote) } : {}),
              ...(Array.isArray(block.anchor.rects)
                ? {
                    rects: block.anchor.rects
                      .map(rect => ({
                        x: Number(rect?.x) || 0,
                        y: Number(rect?.y) || 0,
                        w: Number(rect?.w) || 0,
                        h: Number(rect?.h) || 0,
                      }))
                      .filter(rect => rect.w > 0 && rect.h > 0)
                      .slice(0, 200),
                  }
                : {}),
              // 手绘：坐标已是 0-1，只做范围与数量约束，避免一笔画把存档撑爆。
              ...(Array.isArray(block.anchor.strokes)
                ? {
                    strokes: block.anchor.strokes
                      .map(stroke => ({
                        color: String(stroke?.color || '#e11d48'),
                        width: Math.min(Math.max(Number(stroke?.width) || 2.5, 0.5), 24),
                        points: (Array.isArray(stroke?.points) ? stroke.points : [])
                          .map(point => ({
                            x: Math.min(Math.max(Number(point?.x) || 0, 0), 1),
                            y: Math.min(Math.max(Number(point?.y) || 0, 0), 1),
                          }))
                          .slice(0, 4000),
                      }))
                      .filter(stroke => stroke.points.length >= 2)
                      .slice(0, 200),
                  }
                : {}),
            },
          }
        : {}),
      createdAt: Number(block.createdAt) || Date.now(),
    }))
    .filter(block => block.content.trim() !== '' || (block.anchor && block.anchor.quote))

  const brokenLinks = await findBrokenLinks(profile, normalized)
  const updated = await updateStore(profile, 'papers.notes-saved', draft => {
    const row = draft.papers.find(item => item.id === paper.id)
    if (row === undefined) return null
    row.noteBlocks = normalized
    return row
  })
  if (updated === null) throw new Error('paper_not_found')
  return { paper: updated, brokenLinks }
}

/**
 * Append the reading template to the paper's blocks.
 * @param profile - research profile.
 * @param paperId - paper row id or arXiv id.
 */
export async function applyReadingTemplate(
  profile: string | undefined,
  paperId: string,
): Promise<{ paper: ResearchPaper; blocks: PaperNoteBlock[] }> {
  const { blocks } = await readPaperNotes(profile, paperId)
  const merged = [...blocks, ...buildTemplateBlocks()]
  const saved = await savePaperNotes(profile, paperId, merged)
  return { paper: saved.paper, blocks: merged }
}
