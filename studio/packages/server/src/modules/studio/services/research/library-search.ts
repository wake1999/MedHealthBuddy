/**
 * Local library search across everything a paper knows about itself.
 *
 * The panel's search box used to be arXiv-only: you could find papers you had
 * not read yet, but not the one you wrote a note in last week. This walks the
 * stored records (title / authors / tags / notes / AI summary) plus the
 * extracted full text on disk, so a phrase from page 4 is findable.
 *
 * Matching is deliberately loose: comma-grouped numbers (`3,000`) match
 * `3000`, full-width punctuation is folded, and case is irrelevant.
 */
import { promises as fs } from 'node:fs'

import { readStore, type ResearchPaper } from './store'

/** Only the head of a full text is scanned; a hit past this is rare in practice. */
const FULLTEXT_SCAN_CHARS = 200_000
/** Characters shown around a match. */
const SNIPPET_PAD = 60

export interface LibraryHit {
  paperId: string
  arxivId: string
  title: string
  field: 'title' | 'authors' | 'tags' | 'notes' | 'summary' | 'fulltext'
  snippet: string
  /** Page the match sits on, when it came from the full text. */
  page?: number
  /** Number of occurrences in that field, used for ranking. */
  hits: number
}

/** Fold punctuation and spacing so `3,000` and `3000` are the same needle. */
function normalize(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[\uFF01-\uFF5E]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[,，_\-\s]+/g, ' ')
    .trim()
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/** A short window around the first hit, collapsed to one line. */
function snippetAround(text: string, needle: string): string {
  const flat = text.replace(/\s+/g, ' ')
  const at = flat.toLowerCase().indexOf(needle)
  if (at === -1) return flat.slice(0, SNIPPET_PAD * 2)
  const start = Math.max(0, at - SNIPPET_PAD)
  const end = Math.min(flat.length, at + needle.length + SNIPPET_PAD)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

/** Page number of a character offset in the page-marked full text. */
function pageAt(text: string, offset: number): number | undefined {
  const head = text.slice(0, offset)
  const matches = [...head.matchAll(/## Page (\d+)/g)]
  const last = matches[matches.length - 1]
  return last ? Number(last[1]) : undefined
}

function paperText(paper: ResearchPaper): string[] {
  const blocks = Array.isArray(paper.noteBlocks)
    ? paper.noteBlocks.map(block => block.content)
    : [paper.notes || '']
  return [
    ...(paper.tags || []),
    paper.notes || '',
    ...blocks,
    paper.aiSummary || '',
  ]
}

/**
 * Search the library.
 * @param profile - research profile.
 * @param query - free text typed into the search box.
 * @param options - optional project scope and result cap.
 */
export async function searchLibrary(
  profile: string | undefined,
  query: string,
  options: { projectId?: string; limit?: number } = {},
): Promise<{ hits: LibraryHit[]; scanned: number }> {
  const needle = normalize(query)
  if (needle === '') return { hits: [], scanned: 0 }

  const store = await readStore(profile)
  const papers = options.projectId
    ? store.papers.filter(paper => paper.projectId === options.projectId)
    : store.papers
  const limit = Math.min(Math.max(options.limit ?? 40, 1), 200)
  const hits: LibraryHit[] = []

  for (const paper of papers) {
    const base = { paperId: paper.id, arxivId: paper.arxivId || '', title: paper.title }

    // Shallow fields first: they are cheap and rank highest.
    const titleHits = countOccurrences(normalize(paper.title), needle)
    if (titleHits > 0) {
      hits.push({ ...base, field: 'title', snippet: paper.title, hits: titleHits })
    }
    const authorHits = countOccurrences(normalize(paper.authors), needle)
    if (authorHits > 0) {
      hits.push({ ...base, field: 'authors', snippet: paper.authors, hits: authorHits })
    }
    const tagHits = countOccurrences(normalize((paper.tags || []).join(' ')), needle)
    if (tagHits > 0) {
      hits.push({ ...base, field: 'tags', snippet: (paper.tags || []).join('、'), hits: tagHits })
    }
    const localText = paperText(paper).join('\n')
    const localHits = countOccurrences(normalize(localText), needle)
    if (localHits > 0) {
      hits.push({
        ...base,
        field: paper.aiSummary && normalize(paper.aiSummary).includes(needle) ? 'summary' : 'notes',
        snippet: snippetAround(localText, needle),
        hits: localHits,
      })
    }

    // Then the full text, if it was ever extracted.
    const fulltextPath = String(paper.fulltextPath || '').trim()
    if (fulltextPath === '') continue
    let text = ''
    try {
      const handle = await fs.open(fulltextPath, 'r')
      try {
        const buffer = Buffer.alloc(FULLTEXT_SCAN_CHARS)
        const { bytesRead } = await handle.read(buffer, 0, FULLTEXT_SCAN_CHARS, 0)
        text = buffer.subarray(0, bytesRead).toString('utf-8')
      } finally {
        await handle.close()
      }
    } catch {
      continue
    }
    const normalizedText = normalize(text)
    const fulltextHits = countOccurrences(normalizedText, needle)
    if (fulltextHits > 0) {
      const at = normalizedText.indexOf(needle)
      hits.push({
        ...base,
        field: 'fulltext',
        snippet: snippetAround(text, needle),
        page: pageAt(text, Math.min(at, text.length - 1)),
        hits: fulltextHits,
      })
    }
  }

  const weight: Record<LibraryHit['field'], number> = {
    title: 5, tags: 4, summary: 3, notes: 3, authors: 2, fulltext: 1,
  }
  hits.sort((a, b) => (weight[b.field] * b.hits) - (weight[a.field] * a.hits))
  return { hits: hits.slice(0, limit), scanned: papers.length }
}
