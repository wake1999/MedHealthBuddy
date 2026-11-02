/**
 * Resolve a paper's metadata from an identifier the user pasted.
 *
 * Order matters and mirrors what readers expect: arXiv first (exact, fast, no
 * key), then Crossref by DOI. When nothing matches, the caller gets
 * `source: 'none'` and shows the form empty instead of inventing fields.
 *
 * Nothing is written here: the panel previews the result, the user confirms,
 * and only then does a paper row get created.
 */
import { logger } from '../../public/logging'

const ARXIV_API = 'https://export.arxiv.org/api/query'
const CROSSREF_API = 'https://api.crossref.org/works'
const TIMEOUT_MS = 15_000

/** `2401.01234`, `2401.01234v2`, `hep-th/9901001`. */
const ARXIV_ID = /\b(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)\b/
const ARXIV_URL = /arxiv\.org\/(?:abs|pdf)\/([^\s?#]+)/
const DOI = /\b(10\.\d{4,9}\/[^\s"'<>]+)/

export interface ResolvedPaperMetadata {
  title: string
  authors: string
  year: string
  venue: string
  doi: string
  url: string
  arxivId: string
  abstract: string
  /** Where the fields came from; `none` means the input was not recognised. */
  source: 'arxiv' | 'crossref' | 'none'
}

const EMPTY: ResolvedPaperMetadata = {
  title: '', authors: '', year: '', venue: '', doi: '', url: '', arxivId: '', abstract: '', source: 'none',
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function xmlTag(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))
  return match ? decodeEntities(match[1].replace(/\s+/g, ' ').trim()) : ''
}

function xmlTags(block: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi')
  const values: string[] = []
  for (const match of block.matchAll(pattern)) values.push(decodeEntities(match[1].trim()))
  return values
}

function yearOf(value: string): string {
  const match = String(value || '').match(/\b(19|20)\d{2}\b/)
  return match ? match[0] : ''
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'ekko-research/1.0 (metadata lookup)' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'follow',
  })
  if (!response.ok) throw new Error(`http_${response.status}`)
  return response.text()
}

async function fromArxiv(id: string): Promise<ResolvedPaperMetadata | null> {
  try {
    const xml = await fetchText(`${ARXIV_API}?id_list=${encodeURIComponent(id)}`)
    const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/i)?.[1] ?? ''
    if (entry === '') return null
    const title = xmlTag(entry, 'title')
    if (title === '') return null
    const authors = xmlTags(entry, 'name').join(', ')
    return {
      title,
      authors,
      year: yearOf(xmlTag(entry, 'published')),
      venue: 'arXiv preprint',
      doi: xmlTag(entry, 'doi'),
      url: `https://arxiv.org/abs/${id.replace(/v\d+$/, '')}`,
      arxivId: id,
      abstract: xmlTag(entry, 'summary'),
      source: 'arxiv',
    }
  } catch (error: any) {
    logger.warn('[research-metadata] arxiv lookup failed: %s', error?.message || error)
    return null
  }
}

async function fromCrossref(doi: string): Promise<ResolvedPaperMetadata | null> {
  try {
    const text = await fetchText(`${CROSSREF_API}/${encodeURIComponent(doi)}`)
    const message = (JSON.parse(text) as { message?: any }).message
    if (!message) return null
    const title = Array.isArray(message.title) ? String(message.title[0] || '') : String(message.title || '')
    if (title === '') return null
    const authors = Array.isArray(message.author)
      ? message.author
        .map((item: any) => [item?.given, item?.family].filter(Boolean).join(' ') || String(item?.name || ''))
        .filter(Boolean)
        .join(', ')
      : ''
    const parts = message.issued?.['date-parts']?.[0] ?? []
    return {
      title,
      authors,
      year: parts[0] ? String(parts[0]) : '',
      venue: Array.isArray(message['container-title']) ? String(message['container-title'][0] || '') : '',
      doi: String(message.DOI || doi),
      url: String(message.URL || `https://doi.org/${doi}`),
      arxivId: '',
      abstract: String(message.abstract || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      source: 'crossref',
    }
  } catch (error: any) {
    logger.warn('[research-metadata] crossref lookup failed: %s', error?.message || error)
    return null
  }
}

/**
 * Recognise an arXiv id / DOI / arXiv URL and fill in what the registries know.
 * @param input - whatever the user pasted.
 */
export async function resolvePaperMetadata(input: string): Promise<ResolvedPaperMetadata> {
  const raw = String(input || '').trim()
  if (raw === '') return EMPTY

  const arxivFromUrl = raw.match(ARXIV_URL)?.[1]?.replace(/\.pdf$/i, '')
  const arxivId = arxivFromUrl || raw.match(ARXIV_ID)?.[1] || ''
  if (arxivId) {
    const resolved = await fromArxiv(arxivId)
    if (resolved) return resolved
  }

  const doi = raw.match(DOI)?.[1]?.replace(/[.,;)]+$/, '') || ''
  if (doi) {
    const resolved = await fromCrossref(doi)
    if (resolved) return resolved
  }

  return EMPTY
}
