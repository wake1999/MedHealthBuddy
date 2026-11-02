/**
 * Paper-level AI: a structured summary and grounded Q&A.
 *
 * Both read the extracted full text (page-marked by `fulltext.ts`) and go
 * through the profile's own model via `llm.ts` — no external service, no key in
 * the browser. Answers must cite page numbers, otherwise they are just another
 * chat message and nobody can check them.
 */
import { completeText, completeVision, resolveLlmTarget, resolveVisionTarget, type ChatTurn } from './llm'
import { readPaperFulltext } from './fulltext'
import { readStore, updateStore, type ResearchPaper } from './store'

/** Summaries look at the opening of the paper: abstract, intro, method. */
const SUMMARY_WINDOW = 20_000
/** Each retrieved chunk is capped so five of them still fit a context. */
const CHUNK_CHARS = 2_400
const TOP_CHUNKS = 5

const SUMMARY_PROMPT = [
  '你是论文阅读助手。下面是一篇论文的正文（按 `## Page N` 标注页码）。',
  '请用中文输出五段结构，每段以「小标题：」开头，不要寒暄、不要总结写作过程：',
  '研究问题：这篇论文要解决什么。',
  '数据与方法：用了什么数据、什么方法。',
  '主要结论：核心结果，尽量带上具体数字。',
  '局限：作者承认或可推断的局限。',
  '与当前课题的关联：若文中看不出，写「未提及」。',
].join('\n')

interface TextChunk {
  page: number
  text: string
}

/** One page the answer was built from: where, and what it actually said. */
export interface PaperCitation {
  page: number
  snippet: string
}

/** Split the page-marked full text back into per-page chunks. */
function splitPages(fulltext: string): TextChunk[] {
  const chunks: TextChunk[] = []
  const pattern = /## Page (\d+)\s*\n([\s\S]*?)(?=\n## Page \d+\s*\n|$)/g
  for (const match of fulltext.matchAll(pattern)) {
    const page = Number(match[1])
    const text = match[2].trim()
    if (text) chunks.push({ page, text })
  }
  if (chunks.length === 0 && fulltext.trim()) chunks.push({ page: 1, text: fulltext.trim() })
  return chunks
}

/** Cheap lexical scoring: Chinese bigrams + latin words, no embedding needed. */
function scoreChunk(chunk: string, terms: string[]): number {
  const haystack = chunk.toLowerCase()
  let score = 0
  for (const term of terms) {
    if (term.length < 2) continue
    let index = haystack.indexOf(term)
    while (index !== -1) {
      score += 1
      index = haystack.indexOf(term, index + term.length)
    }
  }
  return score
}

function questionTerms(question: string): string[] {
  const terms = new Set<string>()
  for (const word of question.toLowerCase().match(/[a-z0-9]{2,}/g) || []) terms.add(word)
  const han = question.replace(/[^\u4e00-\u9fa5]/g, '')
  for (let i = 0; i < han.length - 1; i += 1) terms.add(han.slice(i, i + 2))
  return [...terms]
}

/** 整页正文翻译：保留段落结构，只输出译文。 */
const TRANSLATE_PROMPT = [
  '你是学术论文翻译助手。把用户给出的论文正文翻译成简体中文。',
  '要求：保留段落结构；专业术语首次出现时可在括号里保留英文原词；不要总结、不要删减、不要添加解释。',
  '只输出译文本身。',
].join('\n')

/**
 * Translate one block of paper body text (a page, or a selected passage).
 * @param profile - research profile.
 * @param text - the body text to translate.
 */
export async function translatePaperText(
  profile: string | undefined,
  text: string,
): Promise<string> {
  const source = text.trim()
  if (source === '') throw new Error('text_empty')
  const target = await resolveLlmTarget(profile)
  if (!target) throw new Error('llm_unavailable')
  const messages: ChatTurn[] = [
    { role: 'system', content: TRANSLATE_PROMPT },
    { role: 'user', content: source.slice(0, 16_000) },
  ]
  const output = await completeText(target, messages, { temperature: 0.2, maxTokens: 4000 })
  if (output === '') throw new Error('translate_empty')
  return output.trim()
}

/**
 * Ask the model for a five-part summary and persist it on the paper.
 * @param profile - research profile.
 * @param paperId - the paper row id.
 */
export async function summarizePaper(
  profile: string | undefined,
  paperId: string,
): Promise<{ paper: ResearchPaper; summary: string }> {
  const target = await resolveLlmTarget(profile)
  if (!target) throw new Error('llm_unavailable')

  const { paper, text } = await readPaperFulltext(profile, paperId)
  const window = text.slice(0, SUMMARY_WINDOW)

  const messages: ChatTurn[] = [
    { role: 'system', content: SUMMARY_PROMPT },
    { role: 'user', content: `标题：${paper.title}\n\n正文：\n${window}` },
  ]
  const summary = await completeText(target, messages, { temperature: 0.2, maxTokens: 1200 })
  if (summary === '') throw new Error('summary_empty')

  const updated = await updateStore(profile, 'papers.summarized', draft => {
    const row = draft.papers.find(item => item.id === paper.id)
    if (row === undefined) return null
    row.aiSummary = summary
    return row
  })
  if (updated === null) throw new Error('paper_not_found')
  return { paper: updated, summary }
}

/**
 * Answer a question against the paper, citing page numbers.
 * @param profile - research profile.
 * @param paperId - the paper row id.
 * @param question - what the user asked.
 */
export async function askPaper(
  profile: string | undefined,
  paperId: string,
  question: string,
): Promise<{ answer: string; pages: number[]; citations: PaperCitation[] }> {
  const target = await resolveLlmTarget(profile)
  if (!target) throw new Error('llm_unavailable')

  const { paper, text } = await readPaperFulltext(profile, paperId)
  const chunks = splitPages(text)
  const terms = questionTerms(question)
  const ranked = chunks
    .map(chunk => ({ ...chunk, score: scoreChunk(chunk.text, terms) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_CHUNKS)
    .sort((a, b) => a.page - b.page)

  const context = ranked
    .map(chunk => `## Page ${chunk.page}\n${chunk.text.slice(0, CHUNK_CHARS)}`)
    .join('\n\n')

  const messages: ChatTurn[] = [
    {
      role: 'system',
      content: [
        '你是论文问答助手。只依据下面给出的论文片段回答，不要引入外部知识。',
        '回答末尾用「（见第 N 页）」标注出处；片段里没有的信息，直接说「论文未提及」。',
        '中文回答，简洁，不要复述问题。',
      ].join('\n'),
    },
    { role: 'user', content: `论文：${paper.title}\n\n片段：\n${context}\n\n问题：${question}` },
  ]
  const answer = await completeText(target, messages, { temperature: 0.2, maxTokens: 1200 })
  if (answer === '') throw new Error('answer_empty')

  // A page number alone is not verifiable: send back the excerpt the model read
  // so the panel can show "what it actually saw" next to each citation.
  const citations: PaperCitation[] = ranked.map(chunk => ({
    page: chunk.page,
    snippet: chunk.text.replace(/\s+/g, ' ').slice(0, 220),
  }))
  return { answer, pages: citations.map(item => item.page), citations }
}

/** Tags + relevance the model proposes; nothing is written until the reader confirms. */
export interface PaperTagSuggestion {
  tags: string[]
  /** 0-10 relevance to the current project. */
  score: number
  reason: string
}

const TAG_PROMPT = [
  '你是文献标注助手。根据给出的论文信息，产出三项：',
  '1. tags：3-5 个短标签，中英文皆可，每个不超过 12 个字；必须是能用于检索的具体术语（方法、任务、数据集、领域），不要「研究」「论文」「分析」这类泛词。',
  '2. score：0-10 的整数，表示这篇论文对当前课题的价值。',
  '3. reason：一句话说明打分理由，不超过 40 字。',
  '只输出一行 JSON，不要代码块、不要解释：{"tags":["a","b"],"score":7,"reason":"…"}',
].join('\n')

/** Pull the first JSON object out of a model reply that may carry prose. */
function extractJsonObject(raw: string): any {
  const cleaned = raw.replace(/```json|```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return null
  }
}

/**
 * Propose tags and a relevance score for one paper.
 *
 * Read-only on purpose: the panel shows the proposal and only writes it when
 * the reader accepts, so hand-made tags are never overwritten silently.
 * @param profile - research profile.
 * @param paperId - paper row id or arXiv id.
 * @param projectTitle - current project, used when judging relevance.
 */
export async function suggestPaperTags(
  profile: string | undefined,
  paperId: string,
  projectTitle = '',
): Promise<PaperTagSuggestion> {
  const target = await resolveLlmTarget(profile)
  if (!target) throw new Error('llm_unavailable')

  const store = await readStore(profile)
  const paper = store.papers.find(item => item.id === paperId || item.arxivId === paperId)
  if (!paper) throw new Error('paper_not_found')

  let body = String(paper.aiSummary || '').trim() || String(paper.notes || '').trim()
  if (body === '') {
    try {
      const { text } = await readPaperFulltext(profile, paper.id)
      body = text.replace(/^## Page \d+\s*/gm, ' ').replace(/\s+/g, ' ').trim()
    } catch {
      body = ''
    }
  }

  const messages: ChatTurn[] = [
    { role: 'system', content: TAG_PROMPT },
    {
      role: 'user',
      content: [
        `标题：${paper.title}`,
        `出处：${[paper.authors, paper.venue, paper.year].filter(Boolean).join(' · ')}`,
        projectTitle === '' ? '' : `当前课题：${projectTitle}`,
        '',
        `摘要/要点：${body.slice(0, 3000) || '（无摘要）'}`,
      ].filter(Boolean).join('\n'),
    },
  ]

  const raw = await completeText(target, messages, { temperature: 0.2, maxTokens: 1600 })
  const parsed = extractJsonObject(raw)
  if (!parsed) throw new Error('suggest_unparsable')

  const tags: string[] = Array.isArray(parsed.tags)
    ? Array.from(new Set<string>(
      (parsed.tags as unknown[])
        .map(tag => String(tag ?? '').trim().replace(/^#/, ''))
        .filter(tag => tag !== '' && tag.length <= 24),
    )).slice(0, 6)
    : []
  const score = Math.min(10, Math.max(0, Math.round(Number(parsed.score) || 0)))

  return {
    tags,
    score,
    reason: String(parsed.reason ?? '').trim().slice(0, 120),
  }
}

/**
 * Answer a question about rendered page images (a figure, a table, a layout).
 *
 * Unlike {@link runPaperSkill} this does not read the extracted text: the whole
 * point is to look at the pixels, which the default text model cannot do, so it
 * resolves a vision-capable target first and fails loudly when there is none.
 */
export async function askPaperFigure(
  profile: string | undefined,
  paperId: string,
  question: string,
  imagesBase64: readonly string[],
): Promise<{ answer: string; visionModel: string }> {
  if (imagesBase64.length === 0) throw new Error('image_empty')
  const target = await resolveVisionTarget(profile)
  if (!target) throw new Error('vision_unavailable')

  const store = await readStore(profile)
  const paper = store.papers.find(item => item.id === paperId || item.arxivId === paperId)

  const prompt = [
    paper ? `这是论文《${paper.title}》的页面截图。` : '这是论文的页面截图。',
    '请只依据图片中实际可见的内容回答，不要脑补看不到的信息。',
    '',
    `问题：${question}`,
    '',
    '回答要求：先说这张图/表在展示什么，再给关键数值与单位，最后说作者用它支持了什么结论；看不清的地方直接说看不清。',
  ].join('\n')

  // No explicit cap: the default leaves room for a reasoning model's thinking.
  const answer = await completeVision(target, prompt, imagesBase64, { temperature: 0.2 })
  if (answer === '') throw new Error('answer_empty')
  return { answer, visionModel: target.model }
}

/** The paper-level analyses the panel offers. */
export type PaperSkill = 'full_read' | 'passage_qa' | 'figure_qa' | 'concept'

/** How much of one paper goes into a cross-paper review. */
const REVIEW_PER_PAPER_CHARS = 500
/**
 * Hard cap on papers per review. The upstream gateway cuts the connection at
 * ~18s, and generation time grows with the input; ten keeps a review inside
 * that window with room to finish.
 */
const REVIEW_MAX_PAPERS = 10

const REVIEW_PROMPT = [
  '你是文献综述助手。下面是同一课题下若干篇论文的标题、出处与摘要。',
  '请写一份中文主题化综述，总长控制在 800 字以内，结构固定：',
  '## 研究主题',
  '按主题把文献分组，每组 1-2 句概括这一组在做什么。',
  '## 方法对比',
  '对比各篇的方法路线与适用场景，指出差异。',
  '## 研究空白',
  '列出 2-3 个尚未解决或互相矛盾的点。',
  '只依据给出的材料，不要编造文献或数字；材料不足的部分写「材料未覆盖」。不要寒暄，不要写总结段落。',
].join('\n')

/**
 * Cross-paper review over the current project's library.
 * @param profile - research profile.
 * @param options - project scope, explicit paper ids, or a focus topic.
 */
export async function runLiteratureReview(
  profile: string | undefined,
  options: { projectId?: string; paperIds?: readonly string[]; topic?: string } = {},
): Promise<{ output: string; paperCount: number }> {
  const target = await resolveLlmTarget(profile)
  if (!target) throw new Error('llm_unavailable')

  const store = await readStore(profile)
  const wanted = new Set((options.paperIds || []).map(id => String(id)))
  const papers = store.papers
    .filter(paper => (options.projectId ? paper.projectId === options.projectId : true))
    .filter(paper => (wanted.size > 0 ? wanted.has(paper.id) || wanted.has(paper.arxivId) : true))
    .slice(0, REVIEW_MAX_PAPERS)

  if (papers.length === 0) throw new Error('review_no_papers')

  // Only material already distilled on disk: the AI summary, then the abstract
  // captured at import time. Reading full texts here made the call slow enough
  // to time out on a 28-paper library, and the extra text did not help.
  const blocks: string[] = []
  for (const paper of papers) {
    const body = String(paper.aiSummary || '').trim() || String(paper.notes || '').trim()
    const head = body.replace(/\s+/g, ' ').slice(0, REVIEW_PER_PAPER_CHARS)
    blocks.push([
      `### ${paper.title}`,
      [paper.authors, paper.venue, paper.year].filter(Boolean).join(' · '),
      head === '' ? '（无摘要，仅标题与出处）' : head,
    ].join('\n'))
  }

  const messages: ChatTurn[] = [
    { role: 'system', content: REVIEW_PROMPT },
    {
      role: 'user',
      content: [
        options.topic ? `聚焦主题：${options.topic}` : '',
        `文献数量：${papers.length}`,
        '',
        blocks.join('\n\n'),
      ].filter(Boolean).join('\n'),
    },
  ]
  const output = await completeText(target, messages, { temperature: 0.3, maxTokens: 1200 })
  if (output === '') throw new Error('answer_empty')
  return { output, paperCount: papers.length }
}

export interface PaperSkillResult {
  skill: PaperSkill
  output: string
  pages: number[]
  citations: PaperCitation[]
}

/** Prompt per analysis. `full_read` and `passage_qa` reuse the two above. */
const SKILL_PROMPTS: Record<'figure_qa' | 'concept', string> = {
  figure_qa: [
    '你是论文图表解读助手。只依据给出的论文片段（正文、图注、表格文字）作答，不要引入外部知识。',
    '请说明：这张图/表在展示什么；坐标轴、单位、图例的含义；关键数值与趋势；作者用它支持了什么结论。',
    '片段里没有的信息直接说「论文未提及」。末尾用「（见第 N 页）」标注出处。',
  ].join('\n'),
  concept: [
    '你是概念梳理助手。基于给出的论文内容提炼 3-6 个核心概念。',
    '每个概念输出一行，严格控制在 40 字以内：`- 概念名：一句话定义（作用：在本方法里做什么）[第 N 页]`。',
    '最后用一段不超过 80 字的话说明这些概念之间的关系。不要寒暄，不要复述原文，不要展开公式推导。',
  ].join('\n'),
}

/**
 * Run one of the paper-level skills.
 * @param profile - research profile.
 * @param paperId - the paper row id.
 * @param skill - which analysis to run.
 * @param question - required for `passage_qa` and `figure_qa`, optional otherwise.
 */
export async function runPaperSkill(
  profile: string | undefined,
  paperId: string,
  skill: PaperSkill,
  question = '',
): Promise<PaperSkillResult> {
  if (skill === 'full_read') {
    const { summary } = await summarizePaper(profile, paperId)
    return { skill, output: summary, pages: [], citations: [] }
  }

  if (skill === 'passage_qa') {
    const result = await askPaper(profile, paperId, question)
    return { skill, output: result.answer, pages: result.pages, citations: result.citations }
  }

  const target = await resolveLlmTarget(profile)
  if (!target) throw new Error('llm_unavailable')

  const { paper, text } = await readPaperFulltext(profile, paperId)
  const chunks = splitPages(text)
  let context: string
  let pages: number[]

  if (skill === 'figure_qa') {
    // A question about a figure is answered from the passages that mention
    // figures/tables plus whatever the question itself names.
    const terms = [...questionTerms(question), 'figure', 'table', 'fig.', '图', '表']
    const ranked = chunks
      .map(chunk => ({ ...chunk, score: scoreChunk(chunk.text, terms) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_CHUNKS)
      .sort((a, b) => a.page - b.page)
    context = ranked.map(chunk => `## Page ${chunk.page}\n${chunk.text.slice(0, CHUNK_CHARS)}`).join('\n\n')
    pages = ranked.map(chunk => chunk.page)
  } else {
    // Concepts are scattered: feed the opening window, which covers abstract,
    // intro and method for a normal paper.
    context = text.slice(0, SUMMARY_WINDOW)
    pages = chunks.slice(0, 8).map(chunk => chunk.page)
  }

  const output = await completeText(target, [
    { role: 'system', content: SKILL_PROMPTS[skill] },
    {
      role: 'user',
      content: `论文：${paper.title}\n\n内容：\n${context}${question === '' ? '' : `\n\n问题：${question}`}`,
    },
    // Reasoning models spend this budget on thinking first; too small a
    // ceiling comes back empty and forces an expensive retry.
  ], { temperature: 0.2, maxTokens: skill === 'concept' ? 3200 : 2400 })
  if (output === '') throw new Error('answer_empty')

  return { skill, output, pages, citations: [] }
}
