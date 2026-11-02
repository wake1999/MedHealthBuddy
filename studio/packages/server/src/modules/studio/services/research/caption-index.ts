/**
 * Figure and table index for one paper.
 *
 * The full-text extractor joins a page's text items into long lines, so a
 * caption is **not** on its own line: `Figure 1: The Transformer - model
 * architecture. The Transformer follows… 3.1 Encoder and Decoder Stacks`.
 * Captions are therefore recognised by shape rather than by position:
 *
 *   `Figure 3: some title`   ← caption
 *   `as shown in Figure 3.`  ← in-body mention, rejected by the prefix check
 *
 * No model call; this is a cheap index used to jump to a figure.
 *
 * Kept apart from `figures.ts`, which converts SVG charts into embeddable PDFs.
 */
import { readPaperFulltext } from './fulltext'

export interface FigureRef {
  /** Caption label as written, normalised to `Figure 3` / `Table 2`. */
  label: string
  kind: 'figure' | 'table'
  /** 1-based page the caption sits on. */
  page: number
  /** Caption text, cut at the first sentence end. */
  title: string
}

/** `Figure 3:` / `Fig. 3.` / `Table 2:` anywhere in the text. */
const CAPTION = /(Figure|Fig\.?|Table)\s*([0-9]{1,3})\s*[:.]\s*/gi

/** Words that mean "this label was referenced", not "this is the caption". */
const REFERENCE_PREFIX = /(?:in|see|of|and|the|from|figure|table|shown|cf\.?)\s+$/i

/** Longest caption text we keep. */
const TITLE_LIMIT = 200

/**
 * Pull the caption index out of a paper's full text.
 * @param profile - research profile.
 * @param paperId - paper row id or arXiv id.
 */
export async function extractFigureRefs(
  profile: string | undefined,
  paperId: string,
): Promise<FigureRef[]> {
  const { text } = await readPaperFulltext(profile, paperId)

  // `## Page N` fences each page; the split keeps the number and the body.
  const pages = text.split(/^## Page ([0-9]+)[ \t]*$/gm)
  const out: FigureRef[] = []
  const seen = new Set<string>()

  for (let index = 1; index < pages.length; index += 2) {
    const pageNumber = Number(pages[index]) || 1
    const body = pages[index + 1] ?? ''

    CAPTION.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = CAPTION.exec(body)) !== null) {
      const isTable = match[1].toLowerCase().startsWith('table')
      const label = `${isTable ? 'Table' : 'Figure'} ${match[2]}`
      if (seen.has(label)) continue

      // "…shown in Figure 3. This" is a reference; "Figure 3: The model" is a caption.
      const before = body.slice(Math.max(0, match.index - 20), match.index)
      if (REFERENCE_PREFIX.test(before)) continue

      seen.add(label)
      const start = match.index + match[0].length
      const tail = body.slice(start, start + TITLE_LIMIT + 40)
      // Cut at the first sentence boundary; captions run one or two sentences.
      const sentenceEnd = tail.search(/[.!?]\s/)
      const raw = sentenceEnd > 10 ? tail.slice(0, sentenceEnd) : tail.slice(0, TITLE_LIMIT)
      out.push({
        label,
        kind: isTable ? 'table' : 'figure',
        page: pageNumber,
        title: raw.replace(/\s+/g, ' ').trim(),
      })
    }
  }

  const numberOf = (ref: FigureRef): number => Number(ref.label.split(' ')[1]) || 0
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'figure' ? -1 : 1
    return numberOf(a) - numberOf(b)
  })
  return out
}
