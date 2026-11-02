/**
 * PubMed retrieval through NCBI E-utilities.
 *
 * Three public calls, no key: esearch (pmids) → esummary (metadata) → efetch
 * (abstracts). Abstracts matter for a medical library — a title alone cannot
 * tell a clinician whether the paper is relevant — so the third call is not
 * optional when there are hits.
 *
 * Failures come back as data (`error`), never thrown, so an offline box still
 * renders its cached library.
 */
const ESEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi'
const ESUMMARY = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi'
const EFETCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi'
const TIMEOUT_MS = 20_000
/** NCBI asks every client to identify itself. */
const HEADERS = { 'User-Agent': 'ekko-research/1.0 (medical literature panel)' }

export interface PubmedEntry {
  pmid: string
  title: string
  authors: string
  year: string
  venue: string
  doi: string
  url: string
  abstract: string
  published: string
}

export interface PubmedSearchResult {
  entries: PubmedEntry[]
  query: string
  error: string
  tookMs: number
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_all, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_all, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

async function fetchText(url: string): Promise<Response> {
  return fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) })
}

/** One batch of abstracts, keyed by PMID. */
async function fetchAbstracts(pmids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (pmids.length === 0) return out
  try {
    const response = await fetchText(
      `${EFETCH}?db=pubmed&rettype=abstract&retmode=xml&id=${encodeURIComponent(pmids.join(','))}`,
    )
    if (!response.ok) return out
    const xml = await response.text()
    for (const block of xml.split(/<PubmedArticle>/).slice(1)) {
      const pmid = block.match(/<PMID[^>]*>(\d+)<\/PMID>/)?.[1] || ''
      if (pmid === '') continue
      const parts: string[] = []
      for (const match of block.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)) {
        const label = match[1].match(/Label="([^"]+)"/)?.[1] || ''
        const text = decodeEntities(match[2])
        if (text === '') continue
        parts.push(label ? `${label}: ${text}` : text)
      }
      if (parts.length > 0) out.set(pmid, parts.join(' '))
    }
  } catch {
    // Abstracts are a bonus; metadata already came back.
  }
  return out
}

interface EsummaryDoc {
  title?: string
  pubdate?: string
  fulljournalname?: string
  source?: string
  authors?: Array<{ name?: string }>
  articleids?: Array<{ idtype?: string; value?: string }>
  elocationid?: string
  volume?: string
  issue?: string
  pages?: string
}

/**
 * Search PubMed.
 * @param query - free text, or a PubMed query string (`diabetes AND 2024[dp]`).
 * @param maxResults - 1..50 results.
 */
export async function searchPubmed(query: string, maxResults = 10): Promise<PubmedSearchResult> {
  const started = Date.now()
  const trimmed = query.trim()
  if (trimmed === '') return { entries: [], query: '', error: '缺少检索词', tookMs: 0 }

  const max = Math.min(Math.max(Math.trunc(maxResults) || 10, 1), 50)
  try {
    const searchUrl = `${ESEARCH}?db=pubmed&retmode=json&sort=relevance&retmax=${max}`
      + `&term=${encodeURIComponent(trimmed)}`
    const searchRes = await fetchText(searchUrl)
    if (!searchRes.ok) {
      return { entries: [], query: trimmed, error: `PubMed 返回 HTTP ${searchRes.status}`, tookMs: Date.now() - started }
    }
    const searchJson: any = await searchRes.json().catch(() => ({}))
    const ids: string[] = Array.isArray(searchJson?.esearchresult?.idlist)
      ? searchJson.esearchresult.idlist.map((id: unknown) => String(id))
      : []
    if (ids.length === 0) {
      return { entries: [], query: trimmed, error: '', tookMs: Date.now() - started }
    }

    const summaryRes = await fetchText(
      `${ESUMMARY}?db=pubmed&retmode=json&id=${encodeURIComponent(ids.join(','))}`,
    )
    if (!summaryRes.ok) {
      return { entries: [], query: trimmed, error: `PubMed 摘要信息返回 HTTP ${summaryRes.status}`, tookMs: Date.now() - started }
    }
    const summaryJson: any = await summaryRes.json().catch(() => ({}))
    const abstracts = await fetchAbstracts(ids)

    const entries: PubmedEntry[] = []
    for (const pmid of ids) {
      const doc: EsummaryDoc | undefined = summaryJson?.result?.[pmid]
      if (!doc || !doc.title) continue
      const doi = (doc.articleids || []).find(item => item.idtype === 'doi')?.value || ''
      const authors = (doc.authors || [])
        .map(item => String(item.name || '').trim())
        .filter(Boolean)
        .join(', ')
      const published = String(doc.pubdate || '')
      entries.push({
        pmid,
        title: decodeEntities(String(doc.title)).replace(/\.$/, ''),
        authors,
        year: published.slice(0, 4),
        venue: String(doc.fulljournalname || doc.source || ''),
        doi,
        url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
        abstract: abstracts.get(pmid) || '',
        published,
      })
    }

    return { entries, query: trimmed, error: '', tookMs: Date.now() - started }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      entries: [],
      query: trimmed,
      error: /timeout|aborted/i.test(message) ? 'PubMed 请求超时' : `PubMed 请求失败：${message}`,
      tookMs: Date.now() - started,
    }
  }
}
