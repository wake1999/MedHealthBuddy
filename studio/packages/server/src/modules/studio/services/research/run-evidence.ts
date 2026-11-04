import { completeText, resolveLlmTarget, type ChatTurn } from './llm'
import { readPaperFulltext } from './fulltext'
import { addEvidence, getRun, replaceClaims, type ClaimInput } from './runs'
import { readStore } from './store'

const MAX_PAPERS = 5
const MAX_ROWS_PER_PAPER = 5
const MAX_TEXT_CHARS = 24_000

interface ExtractedRow {
  claim?: unknown
  quote?: unknown
  page?: unknown
  section?: unknown
  support?: unknown
  confidence?: unknown
  note?: unknown
}

function clean(value: unknown, max = 4000): string {
  return String(value ?? '').trim().slice(0, max)
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const raw = text.replace(/```(?:json)?/gi, '').trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function pageBlocks(text: string): Array<{ page: number; text: string }> {
  const blocks: Array<{ page: number; text: string }> = []
  const pattern = /^## Page (\d+)\s*$/gm
  const matches = [...text.matchAll(pattern)]
  if (matches.length === 0) return [{ page: 0, text }]
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]
    const start = (match.index || 0) + match[0].length
    const end = index + 1 < matches.length ? matches[index + 1].index || text.length : text.length
    blocks.push({ page: Number(match[1]), text: text.slice(start, end) })
  }
  return blocks
}

function quotePage(text: string, quote: string): number | null {
  const needle = normalize(quote)
  if (needle === '') return null
  for (const block of pageBlocks(text)) {
    if (normalize(block.text).includes(needle)) return block.page > 0 ? block.page : null
  }
  return null
}

function promptForPaper(question: string, paperTitle: string, text: string): ChatTurn[] {
  return [
    {
      role: 'system',
      content: [
        'You extract source-grounded evidence from a research paper.',
        'Return JSON only, with this shape:',
        '{"evidence":[{"claim":"...","quote":"...","page":3,"section":"...","support":"supports|contradicts|mixed|context","confidence":0.0,"note":"..."}]}',
        'Rules:',
        '- quote must be a verbatim substring copied from the supplied text, 20-400 characters.',
        '- page must be the page marker containing the quote.',
        '- claim states what the quote supports or contradicts in the context of the research question.',
        '- Do not invent rows, citations, metrics, or page numbers.',
        '- Return 1-5 high-value rows, not a summary of the whole paper.',
        '- If nothing is source-grounded, return {"evidence":[]}.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `Research question: ${question}\nPaper: ${paperTitle}\n\nText with page markers:\n${text.slice(0, MAX_TEXT_CHARS)}`,
    },
  ]
}

export interface ExtractEvidenceResult {
  added: number
  skipped: number
  paperErrors: string[]
}

export async function extractEvidenceForRun(
  profile: string,
  runId: string,
  input: {
    paperIds?: string[]
    maxPerPaper?: number
    onProgress?: (progress: { phase: string; current: number; total: number; message: string }) => void
  } = {},
): Promise<ExtractEvidenceResult> {
  const run = await getRun(profile, runId)
  const store = await readStore(profile)
  const selected = (Array.isArray(input.paperIds) && input.paperIds.length > 0 ? input.paperIds : run.paperIds)
    .filter(id => store.papers.some(paper => paper.id === id))
    .slice(0, MAX_PAPERS)
  if (selected.length === 0) throw new Error('research_run_no_papers')
  const target = await resolveLlmTarget(profile)
  if (!target) throw new Error('research_model_unavailable')
  const perPaper = Math.max(1, Math.min(MAX_ROWS_PER_PAPER, Math.round(input.maxPerPaper || 4)))
  const existing = new Set(run.evidence.map(row => normalize(`${row.paperId}|${row.quote}`)))
  let added = 0
  let skipped = 0
  const paperErrors: string[] = []
  input.onProgress?.({ phase: 'reading', current: 0, total: selected.length, message: '' })

  for (let index = 0; index < selected.length; index += 1) {
    const paperId = selected[index]
    const paper = store.papers.find(row => row.id === paperId)
    if (!paper) continue
    input.onProgress?.({ phase: 'reading', current: index, total: selected.length, message: paper.title })
    let fulltext = ''
    try {
      fulltext = (await readPaperFulltext(profile, paperId)).text
    } catch (error) {
      paperErrors.push(`${paper.title}: full text unavailable`)
      continue
    }
    if (normalize(fulltext) === '') {
      paperErrors.push(`${paper.title}: empty full text`)
      continue
    }
    input.onProgress?.({ phase: 'extracting', current: index, total: selected.length, message: paper.title })
    let content = ''
    try {
      content = await completeText(target, promptForPaper(run.question, paper.title, fulltext), {
        temperature: 0.1,
        maxTokens: 5000,
      })
    } catch (error) {
      paperErrors.push(`${paper.title}: ${(error as Error).message}`)
      continue
    }
    const parsed = parseJsonObject(content)
    const rows = Array.isArray(parsed?.evidence) ? parsed.evidence as ExtractedRow[] : []
    let acceptedForPaper = 0
    for (const row of rows) {
      if (acceptedForPaper >= perPaper) break
      const claim = clean(row.claim, 2000)
      const quote = clean(row.quote, 4000)
      if (claim === '' || quote.length < 20) {
        skipped += 1
        continue
      }
      const page = quotePage(fulltext, quote)
      if (page === null) {
        // A model paraphrase is not evidence. Drop it rather than storing a
        // quote that cannot be checked against the paper.
        skipped += 1
        continue
      }
      const dedupKey = normalize(`${paperId}|${quote}`)
      if (existing.has(dedupKey)) {
        skipped += 1
        continue
      }
      const support = ['supports', 'contradicts', 'mixed', 'context'].includes(String(row.support))
        ? String(row.support) as 'supports' | 'contradicts' | 'mixed' | 'context'
        : 'supports'
      await addEvidence(profile, runId, {
        paperId,
        paperTitle: paper.title,
        claim,
        quote,
        page,
        section: clean(row.section, 300),
        support,
        confidence: typeof row.confidence === 'number' ? row.confidence : Number(row.confidence) || 0.5,
        note: clean(row.note, 2000),
      })
      existing.add(dedupKey)
      acceptedForPaper += 1
      added += 1
    }
    input.onProgress?.({ phase: 'reading', current: index + 1, total: selected.length, message: paper.title })
  }
  input.onProgress?.({ phase: 'done', current: selected.length, total: selected.length, message: '' })
  return { added, skipped, paperErrors }
}

export async function deriveClaimsForRun(profile: string, runId: string): Promise<number> {
  const run = await getRun(profile, runId)
  if (run.evidence.length === 0) throw new Error('research_evidence_empty')
  const target = await resolveLlmTarget(profile)
  if (!target) throw new Error('research_model_unavailable')
  const payload = run.evidence.map(row => ({
    id: row.id,
    claim: row.claim,
    support: row.support,
    paper: row.paperTitle,
    quote: row.quote.slice(0, 500),
  }))
  const content = await completeText(target, [
    {
      role: 'system',
      content: [
        'Map the supplied evidence rows into a small set of research claims.',
        'Return JSON only: {"claims":[{"text":"...","status":"supported|contradicted|mixed|gap","evidenceIds":["..."],"confidence":0.0,"note":"..."}]}',
        'Rules:',
        '- Every claim must cite one or more evidence ids from the supplied rows.',
        '- Do not invent evidence ids, papers, or claims not grounded in the rows.',
        '- Merge duplicates; return 1-6 claims maximum.',
        '- A gap is allowed only when the supplied rows explicitly show missing evidence.',
      ].join('\n'),
    },
    { role: 'user', content: JSON.stringify(payload) },
  ], { temperature: 0.1, maxTokens: 3500 })
  const parsed = parseJsonObject(content)
  const rawClaims = Array.isArray(parsed?.claims) ? parsed.claims as Array<Record<string, unknown>> : []
  const inputs: ClaimInput[] = rawClaims.map(row => ({
    text: clean(row.text, 2000),
    status: ['supported', 'contradicted', 'mixed', 'gap'].includes(String(row.status))
      ? String(row.status) as ClaimInput['status']
      : 'supported',
    evidenceIds: Array.isArray(row.evidenceIds) ? row.evidenceIds.map(id => clean(id, 120)) : [],
    confidence: typeof row.confidence === 'number' ? row.confidence : Number(row.confidence) || 0.5,
    note: clean(row.note, 2000),
  })).filter(row => row.text !== '' && row.evidenceIds.length > 0)
  if (inputs.length === 0) throw new Error('research_claims_empty')
  const updated = await replaceClaims(profile, runId, inputs)
  if (updated.claims.length === 0) throw new Error('research_claims_empty')
  return updated.claims.length
}
