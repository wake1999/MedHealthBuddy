// @ts-nocheck 鈥?vendored ui-mimir island: React 18 JSX plus dsh-* SDK modules that exist only as ambient stubs here, so project-wide type checking cannot cover it. Transformed by esbuild with jsxImportSource=react and verified at runtime.
/**
 * The papers view: a library-first homepage — the header row carries the
 * title filter, the sort selector and the collect toggle (arXiv/PubMed/Web
 * search, subscriptions and Zotero live inside that collapsible panel), then
 * the literature library as a card grid — title (linked to the arXiv page), authors, added
 * date, a
 * three-line-clamped summary the reader can expand, tag pills and
 * linked-project badges, the agent's working notes, a PDF section (fetch the
 * arXiv PDF into the workspace, then read it inline or fullscreen on the
 * `/api/studio/research/paper-pdf` route, with a reading-notes side panel appending
 * timestamped entries into the record's notes), and edit/delete actions. The
 * edit action opens an inline editor (tags, project links, notes); a filter
 * bar above the grid narrows the library by one tag and/or the currently
 * selected project (the project filter defaults ON while a project is
 * selected, so each project's literature view shows its own papers); each
 * card can be appended to the selected project's `references.bib` in one
 * click. The toolbar button hands the currently filtered selection to the
 * current session's agent: "draft the related work section".
 * @module dsh-client-ui-mimir/client/PapersView
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ArxivEntry, PaperRecord, ResearchProjectView, WebSearchEntry } from 'dsh-mimir/types'
import type {
  ResearchArxivSearchView, ResearchFailureView, ResearchImportCounts, ResearchPapersView, ResearchWebSearchView,
  ResearchSxngConfigView,  ResearchSubscriptionsView, ResearchZoteroSearchView, ResearchZoteroView,
} from './controller.ts'
import { fetchResearchState, type ResearchFolder } from '@/api/studio/research'
import { VueChatIsland } from './VueChatIsland.tsx'
import { arxivIdFromUrl, failureCopy, filterPapers, paperPdfUrl, type ResearchT } from './view-common.ts'
import { appendReadingNote, parseReadingNotes } from './paper-notes.ts'
import { buildRelatedWorkPrompt } from './related-work.ts'
import { EmptyState } from './EmptyState.tsx'
import { SubscriptionsBar } from './SubscriptionsBar.tsx'
import { ViewHead } from './ViewHead.tsx'
import { ZoteroSection } from './ZoteroSection.tsx'
import css from './ResearchPanel.module.css'

/** Fields the inline editor and the score picker save back through `updatePaper`. */
interface PaperPatch {
  readonly tags?: string[]
  readonly projectIds?: string[]
  readonly notes?: string
  readonly score?: number
  readonly favorite?: boolean
  readonly pinned?: boolean
  readonly status?: 'new' | 'reading' | 'read'
  readonly folderId?: string
}

/**
 * 卡片这三项状态由后端持久化，但共享的 `PaperRecord` 类型还没同步；
 * 用一个窄扩展读取，避免为三处 UI 去改跨包类型。
 */
interface PaperRecordExtra {
  readonly pinned?: boolean
  readonly translatedAt?: number
  readonly status?: 'new' | 'reading' | 'read'
  readonly folderId?: string
}
const extraOf = (paper: PaperRecord): PaperRecordExtra => paper as unknown as PaperRecordExtra

interface ProjectSessionMessageView {
  readonly id: string
  readonly role: string
  readonly content: string
  readonly timestamp: number
}

interface ProjectSessionSnapshotView {
  readonly sessionId: string | null
  readonly title: string
  readonly messages: readonly ProjectSessionMessageView[]
}

/** 父组件尚未提供会话镜像时的空快照：阅读器侧栏据此显示"暂无会话"。 */
const EMPTY_SESSION: ProjectSessionSnapshotView = { sessionId: null, title: '', messages: [] }

/** 父组件未提供会话通道时的占位：返回失败而不是抛 "not a function"。 */
const NO_SESSION_REQUEST = async (): Promise<{ readonly ok: boolean; readonly error?: string }> => ({ ok: false, error: 'no-session' })

/** One structured note block, as `/papers/:id/notes` returns it. */
interface PaperNoteBlockView {
  readonly id: string
  readonly kind: string
  readonly content: string
  /** 读者对这条高亮写的批注。 */
  readonly comment?: string
  /** 仅隐藏色块，保留批注与右侧「笔记」标记。 */
  readonly highlightHidden?: boolean
  readonly anchor?: { page?: number; quote?: string; rects?: readonly HighlightRectView[] }
  readonly createdAt: number
}

/** Settle feedback of one card's add-to-bibliography button. */
type AddToBibState = 'idle' | 'adding' | 'added' | 'exists'

/** How long the added/exists feedback shows before the button resets. */
const ADD_TO_BIB_RESET_MS = 2000

/** The 0-10 scale the panel and the `wiki_note` tool share. */
const SCORE_STEPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const

/** 页内搜索最多收集这么多处命中，超出的用「+」标注，避免长文档卡死。 */
const SEARCH_MATCH_LIMIT = 500

/** 阅读区左右内边距之和（左 64 给竖排工具条、右 10）加一点余量。 */
const STAGE_SIDE_PADDING = 90

/**
 * One card's PDF section: a fetch button (downloads the arXiv PDF into the
 * workspace through `fetchPaperPdf`, labeled refetch once linked) and, once
 * the record carries a `pdfPath`, a read button lifting the iframe reader on
 * the `/api/studio/research/paper-pdf` route (next to the reading-notes side
 * panel) straight into a viewport-sized overlay — Esc or the header button
 * exits. Nothing renders inline: the card already carries the metadata and the
 * full notes, and an embedded 480px frame made it three screens tall. A
 * successful fetch bumps the cache-bust version and opens the overlay. The
 * overlay is portaled to `document.body`: rendered inside the card, the card's
 * `backdrop-filter` (and hover `transform`) would become its containing block
 * and trap the `position: fixed` overlay inside the card's box.
 */
/**
 * The paper's relevance score, on the 0-10 scale the agent writes through the
 * `wiki_note` tool (`set_paper` with `score`). 0 means "not scored yet": those
 * cards get no chip rather than a meaningless 0/10.
 */
function ScoreChip({ score, t }: { readonly score: number; readonly t: ResearchT }) {
  if (!Number.isFinite(score) || score <= 0) return null
  const band = score >= 7 ? 'high' : score >= 4 ? 'mid' : 'low'
  const shown = Math.min(score, 10)
  return (
    <span className={css.relevanceChip} data-band={band}>
      {t('papers.relevance')} {shown.toFixed(shown % 1 === 0 ? 0 : 1)}/10
    </span>
  )
}

/**
 * Manual scorer for one card. Writes the same `score` field the `wiki_note`
 * tool's `set_paper` writes, so a hand-picked number and an agent verdict are
 * the same thing downstream. 0 clears it (the chip then disappears).
 */
function ScorePicker({ paper, updatePaper, onError, t }: {
  readonly paper: PaperRecord
  readonly updatePaper: (arxivId: string, patch: PaperPatch) => Promise<ResearchFailureView | null>
  readonly onError: (message: string) => void
  readonly t: ResearchT
}) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const current = Math.min(10, Math.max(0, Number(paper.score ?? 0)))
  const apply = (score: number): void => {
    setSaving(true)
    void updatePaper(paper.arxivId, { score })
      .then((failure) => {
        if (failure === null) setOpen(false)
        else onError(`${t('papers.saveFailed')}：${failure.message}`)
      })
      .finally(() => { setSaving(false) })
  }
  return (
    <div className={css.scorePicker}>
      <button
        type="button"
        className={css.btn}
        disabled={saving}
        aria-expanded={open}
        onClick={() => { setOpen(prev => !prev) }}
      >
        {current > 0 ? `${t('papers.relevance')} ${current}/10` : t('papers.score')}
      </button>
      {open && (
        <div className={css.scoreMenu} role="group" aria-label={t('papers.relevance')}>
          {SCORE_STEPS.map(step => (
            <button
              key={step}
              type="button"
              className={css.scoreStep}
              data-active={step === current || undefined}
              onClick={() => { apply(step) }}
            >
              {step}
            </button>
          ))}
          {current > 0 && (
            <button type="button" className={css.scoreClear} onClick={() => { apply(0) }}>
              {t('papers.clearScore')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Headers the paper-pipeline endpoints expect: the same API key and profile
 * the Vue shell sends, read straight from localStorage. This island talks to
 * the new endpoints directly instead of widening the controller surface.
 */
function researchApiHeaders(): Record<string, string> {
  const apiKey = window.localStorage.getItem('hermes_api_key') || ''
  const profile = window.localStorage.getItem('hermes_active_profile_name') || ''
  return {
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...(profile ? { 'X-Hermes-Profile': profile } : {}),
  }
}

/** The server accepts either the row id or the arXiv id. */
function paperKey(paper: PaperRecord): string {
  const id = String((paper as { id?: string }).id || '').trim()
  return id !== '' ? id : paper.arxivId
}

/**
 * Library header filter: the needle matches the title, any author or any tag
 * (case-insensitive). Empty needle callers skip this — everything passes.
 */
function libraryHit(paper: PaperRecord, needle: string): boolean {
  return paper.title.toLowerCase().includes(needle)
    || paper.authors.some(author => author.toLowerCase().includes(needle))
}


type PaperCoverData = { readonly src: string; readonly pages: number }

const paperCoverCache = new Map<string, PaperCoverData>()
const paperCoverPending = new Map<string, Promise<PaperCoverData>>()
const paperCoverQueue: Array<() => void> = []
let paperCoverActive = 0

/** Serialize thumbnail work: visible cards render two at a time, never the whole library at once. */
function schedulePaperCover(work: () => Promise<PaperCoverData>): Promise<PaperCoverData> {
  return new Promise((resolve, reject) => {
    const run = (): void => {
      paperCoverActive += 1
      void work().then(resolve, reject).finally(() => {
        paperCoverActive -= 1
        paperCoverQueue.shift()?.()
      })
    }
    if (paperCoverActive < 2) run()
    else paperCoverQueue.push(run)
  })
}

/** Render and cache page one; the document itself is destroyed immediately after the snapshot. */
function loadPaperCover(paper: PaperRecord): Promise<PaperCoverData> {
  const key = paperKey(paper)
  const cached = paperCoverCache.get(key)
  if (cached) return Promise.resolve(cached)
  const pending = paperCoverPending.get(key)
  if (pending) return pending
  const task = schedulePaperCover(async () => {
    const remembered = paperCoverCache.get(key)
    if (remembered) return remembered
    const pdfjs: any = await import('pdfjs-dist')
    pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'
    const response = await fetch(paperPdfUrl(key, 0), { headers: researchApiHeaders() })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const doc = await pdfjs.getDocument({ data: bytes, disableAutoFetch: true }).promise
    try {
      const first = await doc.getPage(1)
      const base = first.getViewport({ scale: 1 })
      const viewport = first.getViewport({ scale: Math.min(1.5, 420 / base.width) })
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      const context = canvas.getContext('2d')
      if (!context) throw new Error('canvas unavailable')
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      await first.render({ canvasContext: context, viewport }).promise
      const result = { src: canvas.toDataURL('image/jpeg', 0.84), pages: Number(doc.numPages) || 0 }
      paperCoverCache.set(key, result)
      return result
    } finally {
      await doc.destroy()
    }
  })
  paperCoverPending.set(key, task)
  void task.finally(() => { paperCoverPending.delete(key) }).catch(() => {})
  return task
}


/** Short relative timestamp for the card footer; older entries fall back to their calendar date. */
function relativePaperTime(iso: string, t: ResearchT): string {
  const timestamp = new Date(iso).getTime()
  if (!Number.isFinite(timestamp)) return iso.slice(0, 10).replaceAll('-', '/')
  const elapsed = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(elapsed / 60000)
  if (minutes < 1) return t('papers.timeJustNow')
  if (minutes < 60) return t('papers.minutesAgo', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('papers.hoursAgo', { count: hours })
  const days = Math.floor(hours / 24)
  if (days < 7) return t('papers.daysAgo', { count: days })
  return iso.slice(0, 10).replaceAll('-', '/')
}

/** Cover, title and metadata; the open area and hover actions are separate siblings. */
function PaperCardFront({ paper, busy, selecting, selected, t, translating, summarizing, onTranslate, onSummarize }: {
  readonly paper: PaperRecord
  readonly busy: boolean
  readonly selecting: boolean
  readonly selected: boolean
  readonly t: ResearchT
  readonly translating: boolean
  readonly summarizing: boolean
  readonly onTranslate: () => void
  readonly onSummarize: () => void
}) {
  const remembered = paperCoverCache.get(paper.arxivId)
  const [cover, setCover] = useState(remembered?.src ?? '')
  const hostRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const cached = paperCoverCache.get(paperKey(paper))
    if (cached) {
      setCover(cached.src)
      return undefined
    }
    if (paper.pdfPath === undefined) return undefined
    let cancelled = false
    const load = (): void => {
      void loadPaperCover(paper).then((result) => {
        if (cancelled) return
        setCover(result.src)
      }).catch(() => { /* 封面失败保留文字占位，点卡片仍可打开阅读器 */ })
    }
    const host = hostRef.current
    if (!host || typeof IntersectionObserver === 'undefined') {
      load()
      return () => { cancelled = true }
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some(entry => entry.isIntersecting)) return
      observer.disconnect()
      load()
    }, { rootMargin: '240px' })
    observer.observe(host)
    return () => {
      cancelled = true
      observer.disconnect()
    }
  }, [paper.arxivId, paper.pdfPath])

  return (
    <>
      <div ref={hostRef} className={css.paperCover}>
        {selecting && (
          <span className={css.paperSelectMark} data-selected={selected || undefined} aria-hidden="true">
            {selected ? '✓' : ''}
          </span>
        )}
        {cover !== '' ? (
          <img src={cover} alt="" draggable={false} />
        ) : (
          <div className={css.paperCoverFallback} aria-hidden="true">
            <span>PDF</span>
            <p>{paper.title}</p>
          </div>
        )}
        {busy && <span className={css.paperCoverStatus}>{t('papers.openingPdf')}</span>}
      </div>
      <h3 className={css.paperCardTitle}>{paper.title}</h3>
      <p className={css.paperCardMeta}>
        <span>PDF</span>
        <span>{relativePaperTime(paper.addedAt, t)}</span>
      </p>
      {/*
        状态徽章兼作按钮：点「未翻译」直接整篇翻译、点「未摘要」直接生成摘要，
        请求期间徽章自己显示「翻译中 / 摘要中」的转圈状态，完成后刷新成已完成。
      */}
      <p className={css.paperCardBadges}>
        <button
          type="button"
          className={css.paperCardBadge}
          data-on={extraOf(paper).translatedAt !== undefined || undefined}
          data-busy={translating || undefined}
          disabled={translating}
          title={t('papers.translateMono')}
          onClick={(event) => { event.stopPropagation(); onTranslate() }}
        >
          <span className={css.paperCardBadgeDot} aria-hidden="true">
            {extraOf(paper).translatedAt === undefined ? '' : '✓'}
          </span>
          {t(translating
            ? 'papers.translatingBadge'
            : extraOf(paper).translatedAt === undefined ? 'papers.untranslated' : 'papers.translated')}
        </button>
        <button
          type="button"
          className={css.paperCardBadge}
          data-on={paper.aiSummary === undefined ? undefined : true}
          data-busy={summarizing || undefined}
          disabled={summarizing}
          title={t('papers.aiSummary')}
          onClick={(event) => { event.stopPropagation(); onSummarize() }}
        >
          <span className={css.paperCardBadgeDot} aria-hidden="true">
            {paper.aiSummary === undefined ? '' : '✓'}
          </span>
          {t(summarizing
            ? 'papers.summarizingBadge'
            : paper.aiSummary === undefined ? 'papers.unsummarized' : 'papers.summarized')}
        </button>
      </p>
    </>
  )
}

/** Upload a local PDF; the server stores it and extracts the text in one call. */
async function uploadPaperPdfFile(
  paper: PaperRecord,
  file: File,
): Promise<{ fulltextChars: number | null; fulltextError: string }> {
  const res = await fetch(`/api/studio/research/papers/${encodeURIComponent(paperKey(paper))}/pdf`, {
    method: 'POST',
    headers: { ...researchApiHeaders(), 'Content-Type': 'application/pdf' },
    body: file,
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
  return {
    fulltextChars: typeof body?.paper?.fulltextChars === 'number' ? body.paper.fulltextChars : null,
    fulltextError: String(body?.fulltextError || ''),
  }
}

async function requestPaperSummary(paper: PaperRecord): Promise<string> {
  const res = await fetch(`/api/studio/research/papers/${encodeURIComponent(paperKey(paper))}/summary`, {
    method: 'POST',
    headers: researchApiHeaders(),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
  return String(body?.summary || '')
}

/** One retrieved page behind an answer: where it came from and what it said. */
interface PaperCitationView {
  readonly page: number
  readonly snippet: string
}

async function requestPaperAnswer(
  paper: PaperRecord,
  question: string,
): Promise<{ answer: string; pages: number[]; citations: readonly PaperCitationView[] }> {
  const res = await fetch(`/api/studio/research/papers/${encodeURIComponent(paperKey(paper))}/ask`, {
    method: 'POST',
    headers: { ...researchApiHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
  return {
    answer: String(body?.answer || ''),
    pages: Array.isArray(body?.pages) ? body.pages : [],
    citations: Array.isArray(body?.citations) ? body.citations : [],
  }
}

/** One knowledge row as the store returns it. */
interface KnowledgeRowView {
  readonly id: string
  readonly projectId: string
  readonly kind: string
  readonly statement: string
  readonly paperId?: string
  readonly blockId?: string
  readonly createdAt: number
}

/** Human label per knowledge kind. */
const KNOWLEDGE_KIND_LABEL: Record<string, string> = {
  full_read: 'papers.kindFullRead',
  literature_review: 'papers.kindReview',
  passage_qa: 'papers.kindPassageQa',
  figure_qa: 'papers.kindFigureQa',
  concept: 'papers.kindConcept',
  claim: 'papers.kindClaim',
  gap: 'papers.kindGap',
}

/** One PubMed hit, shaped like an arXiv entry so the panels stay symmetric. */
interface PubmedEntryView {
  readonly pmid: string
  readonly title: string
  readonly authors: string
  readonly year: string
  readonly venue: string
  readonly doi: string
  readonly url: string
  readonly abstract: string
}

async function searchPubmedOnline(query: string, max = 10): Promise<{ entries: readonly PubmedEntryView[]; error: string }> {
  const res = await fetch(
    `/api/studio/research/pubmed/search?q=${encodeURIComponent(query)}&max=${max}`,
    { headers: researchApiHeaders() },
  )
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
  return {
    entries: Array.isArray(body?.entries) ? body.entries : [],
    error: String(body?.error || ''),
  }
}

/** Create a paper row from a PubMed hit; the abstract becomes the initial note. */
async function importPubmedEntry(entry: PubmedEntryView, projectId: string | undefined): Promise<void> {
  const res = await fetch('/api/studio/research/items/papers', {
    method: 'POST',
    headers: { ...researchApiHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(projectId ? { projectId } : {}),
      title: entry.title,
      authors: entry.authors,
      year: entry.year,
      venue: entry.venue,
      doi: entry.doi,
      url: entry.url,
      pmid: entry.pmid,
      arxivId: '',
      status: 'new',
      ...(entry.abstract ? { notes: `[PubMed 摘要]\n${entry.abstract}` } : {}),
    }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
}

/** The paper-level analyses the panel exposes (mirrors the server's skill set). */
type PaperSkillView = 'full_read' | 'passage_qa' | 'figure_qa' | 'concept'

/**
 * Run one paper-level analysis.
 * Same response shape for every skill: text plus the pages it leaned on.
 */
async function requestPaperSkill(
  paper: PaperRecord,
  skill: PaperSkillView,
  question = '',
): Promise<{ output: string; pages: number[]; citations: readonly PaperCitationView[] }> {
  const res = await fetch(`/api/studio/research/papers/${encodeURIComponent(paperKey(paper))}/skill`, {
    method: 'POST',
    headers: { ...researchApiHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ skill, ...(question === '' ? {} : { question }) }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
  return {
    output: String(body?.output || ''),
    pages: Array.isArray(body?.pages) ? body.pages : [],
    citations: Array.isArray(body?.citations) ? body.citations : [],
  }
}

/**
 * One paper's AI block: the four paper-level skills, all derived from the
 * extracted full text. Collapsed to a button row until the reader asks for
 * something, so the card does not grow three screens tall.
 */
/** A paper's first project id, used when lifting an analysis into knowledge. */
function paperProjectId(paper: PaperRecord): string {
  const ids = (paper as { projectIds?: readonly string[] }).projectIds
  return Array.isArray(ids) && ids.length > 0 ? String(ids[0]) : ''
}

/** Lift one analysis (or one note block) into the project's knowledge list. */
async function saveKnowledgeItem(input: {
  projectId: string
  kind: string
  statement: string
  paperId: string
  blockId?: string
}): Promise<void> {
  const res = await fetch('/api/studio/research/items/knowledge', {
    method: 'POST',
    headers: { ...researchApiHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
}

function PaperAiSection({ paper, onError, onJumpToPage, t }: {
  readonly paper: PaperRecord
  readonly onError: (message: string) => void
  /** Open this paper's reader on a page (citation → PDF). */
  readonly onJumpToPage?: (page: number) => void
  readonly t: ResearchT
}) {
  const [summary, setSummary] = useState(() => String((paper as { aiSummary?: string }).aiSummary || ''))
  const [summarizing, setSummarizing] = useState(false)
  const [asking, setAsking] = useState(false)
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [pages, setPages] = useState<number[]>([])
  const [citations, setCitations] = useState<readonly PaperCitationView[]>([])
  const [openCitation, setOpenCitation] = useState(-1)
  const [answering, setAnswering] = useState(false)
  // 问段落与问图表共用同一个输入框，用这个区分提交到哪个 skill。
  const [askMode, setAskMode] = useState<'passage_qa' | 'figure_qa'>('passage_qa')
  const [skillOutput, setSkillOutput] = useState<{ skill: string; text: string } | null>(null)
  const [runningSkill, setRunningSkill] = useState('')
  const [savingKnowledge, setSavingKnowledge] = useState(false)
  const [knowledgeDone, setKnowledgeDone] = useState(false)

  const hasFulltext = Boolean(String((paper as { fulltextPath?: string }).fulltextPath || '').trim())

  const summarize = (): void => {
    if (summarizing) return
    setSummarizing(true)
    void requestPaperSummary(paper)
      .then((text) => { if (text !== '') setSummary(text) })
      .catch((error: Error) => { onError(`${t('papers.aiSummaryFailed')}：${error.message}`) })
      .finally(() => { setSummarizing(false) })
  }

  const ask = (): void => {
    const value = question.trim()
    if (answering || value === '') return
    setAnswering(true)
    if (askMode === 'figure_qa') {
      void requestPaperSkill(paper, 'figure_qa', value)
        .then((result) => { setSkillOutput({ skill: 'figure_qa', text: result.output }) })
        .catch((error: Error) => { onError(`${t('papers.askFailed')}：${error.message}`) })
        .finally(() => { setAnswering(false) })
      return
    }
    void requestPaperAnswer(paper, value)
      .then((result) => {
        setAnswer(result.answer)
        setPages(result.pages)
        setCitations(result.citations)
        setOpenCitation(-1)
      })
      .catch((error: Error) => { onError(`${t('papers.askFailed')}：${error.message}`) })
      .finally(() => { setAnswering(false) })
  }

  /** Skills that need no question run straight from the button. */
  const runSkill = (skill: 'concept'): void => {
    if (runningSkill !== '') return
    setRunningSkill(skill)
    void requestPaperSkill(paper, skill)
      .then((result) => { setSkillOutput({ skill, text: result.output }) })
      .catch((error: Error) => { onError(`${t('papers.skillFailed')}：${error.message}`) })
      .finally(() => { setRunningSkill('') })
  }

  const openAsk = (mode: 'passage_qa' | 'figure_qa'): void => {
    setAskMode(mode)
    setAsking(true)
  }

  /** Turn the current analysis output into a knowledge row. */
  const liftToKnowledge = (kind: string, text: string): void => {
    const projectId = paperProjectId(paper)
    if (projectId === '') { onError(t('papers.knowledgeNoProject')); return }
    if (savingKnowledge || text.trim() === '') return
    setSavingKnowledge(true)
    void saveKnowledgeItem({
      projectId,
      kind,
      statement: text.trim().slice(0, 4000),
      paperId: paperKey(paper),
    })
      .then(() => { setKnowledgeDone(true) })
      .catch((error: Error) => { onError(`${t('papers.knowledgeFailed')}：${error.message}`) })
      .finally(() => { setSavingKnowledge(false) })
  }

  return (
    <div className={css.paperAi}>
      <div className={css.paperAiActions}>
        <button
          type="button"
          className={css.btn}
          disabled={summarizing || !hasFulltext}
          title={hasFulltext ? undefined : t('papers.aiNeedPdf')}
          onClick={summarize}
        >
          {summarizing ? t('papers.summarizing') : t('papers.skillFullRead')}
        </button>
        <button
          type="button"
          className={css.btn}
          disabled={!hasFulltext}
          title={hasFulltext ? undefined : t('papers.aiNeedPdf')}
          aria-expanded={asking && askMode === 'passage_qa'}
          onClick={() => { openAsk('passage_qa') }}
        >
          {t('papers.skillPassageQa')}
        </button>
        <button
          type="button"
          className={css.btn}
          disabled={!hasFulltext}
          title={hasFulltext ? undefined : t('papers.aiNeedPdf')}
          aria-expanded={asking && askMode === 'figure_qa'}
          onClick={() => { openAsk('figure_qa') }}
        >
          {t('papers.skillFigureQa')}
        </button>
        <button
          type="button"
          className={css.btn}
          disabled={runningSkill !== '' || !hasFulltext}
          title={hasFulltext ? undefined : t('papers.aiNeedPdf')}
          onClick={() => { runSkill('concept') }}
        >
          {runningSkill === 'concept' ? t('papers.skillRunning') : t('papers.skillConcept')}
        </button>
      </div>

      {summary !== '' && (
        <div className={css.paperAiSummary}>{summary}</div>
      )}

      {skillOutput !== null && (
        <div className={css.paperAiSummary} data-skill={skillOutput.skill}>
          {skillOutput.text}
          <div className={css.paperAiFooter}>
            <button
              type="button"
              className={css.btn}
              disabled={savingKnowledge || knowledgeDone}
              onClick={() => { liftToKnowledge(skillOutput.skill, skillOutput.text) }}
            >
              {knowledgeDone
                ? t('papers.knowledgeSaved')
                : savingKnowledge ? t('papers.knowledgeSaving') : t('papers.saveToKnowledge')}
            </button>
          </div>
        </div>
      )}

      {asking && (
        <div className={css.paperAsk}>
          <div className={css.paperAskRow}>
            <input
              className={css.paperAskInput}
              value={question}
              placeholder={askMode === 'figure_qa' ? t('papers.figureAskPlaceholder') : t('papers.askPlaceholder')}
              disabled={answering}
              onChange={(event) => { setQuestion(event.target.value) }}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); ask() } }}
            />
            <button type="button" className={css.btn} disabled={answering || question.trim() === ''} onClick={ask}>
              {answering ? t('papers.asking') : t('papers.ask')}
            </button>
          </div>
          {answer !== '' && (
            <div className={css.paperAiSummary}>
              {answer}
              {citations.length > 0 ? (
                <div className={css.paperCitations}>
                  <p className={css.paperCitationsHead}>{t('papers.citedPages')}</p>
                  {citations.map((citation, index) => (
                    <div key={`${citation.page}-${index}`} className={css.paperCitationRow}>
                      <button
                        type="button"
                        className={css.paperCitation}
                        data-open={openCitation === index || undefined}
                        title={citation.snippet}
                        onClick={() => { setOpenCitation(openCitation === index ? -1 : index) }}
                      >
                        <span className={css.paperCitationPage}>
                          {t('papers.pagePrefix')}{citation.page}{t('papers.pageSuffix')}
                        </span>
                        <span className={css.paperCitationText}>{citation.snippet}</span>
                      </button>
                      {onJumpToPage !== undefined && hasFulltext && (
                        <button
                          type="button"
                          className={css.paperCitationJump}
                          onClick={() => { onJumpToPage(citation.page) }}
                        >
                          {t('papers.openInPdf')}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ) : pages.length > 0 && (
                <span className={css.paperAskPages}>{t('papers.pagesCited')}：{pages.join('、')}</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

async function fetchPaperNotes(paper: PaperRecord): Promise<readonly PaperNoteBlockView[]> {
  const res = await fetch(`/api/studio/research/papers/${encodeURIComponent(paperKey(paper))}/notes`, {
    headers: researchApiHeaders(),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
  return Array.isArray(body?.blocks) ? body.blocks : []
}

async function savePaperNotes(paper: PaperRecord, blocks: readonly PaperNoteBlockView[]): Promise<string[]> {
  const res = await fetch(`/api/studio/research/papers/${encodeURIComponent(paperKey(paper))}/notes`, {
    method: 'PUT',
    headers: { ...researchApiHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
  return Array.isArray(body?.brokenLinks) ? body.brokenLinks : []
}

async function insertReadingTemplate(paper: PaperRecord): Promise<readonly PaperNoteBlockView[]> {
  const res = await fetch(`/api/studio/research/papers/${encodeURIComponent(paperKey(paper))}/notes/template`, {
    method: 'POST',
    headers: researchApiHeaders(),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
  return Array.isArray(body?.blocks) ? body.blocks : []
}

/**
 * Tag + relevance proposal for one card.
 *
 * Deliberately two-step: the model only proposes, nothing touches `paper.tags`
 * or `paper.score` until the reader presses apply. Hand-made tags are merged,
 * never replaced.
 */
function PaperTagSuggest({ paper, projectTitle, updatePaper, onError, t }: {
  readonly paper: PaperRecord
  readonly projectTitle: string
  readonly updatePaper: (arxivId: string, patch: PaperPatch) => Promise<ResearchFailureView | null>
  readonly onError: (message: string) => void
  readonly t: ResearchT
}) {
  const [running, setRunning] = useState(false)
  const [applying, setApplying] = useState(false)
  const [suggestion, setSuggestion] = useState<{
    tags: readonly string[]
    score: number
    reason: string
  } | null>(null)

  const suggest = (): void => {
    if (running) return
    setRunning(true)
    setSuggestion(null)
    void fetch(`/api/studio/research/papers/${encodeURIComponent(paperKey(paper))}/suggest`, {
      method: 'POST',
      headers: { ...researchApiHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectTitle }),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
        setSuggestion({
          tags: Array.isArray(body?.tags) ? body.tags : [],
          score: Number(body?.score) || 0,
          reason: String(body?.reason ?? ''),
        })
      })
      .catch((error: Error) => { onError(`${t('papers.suggestFailed')}：${error.message}`) })
      .finally(() => { setRunning(false) })
  }

  const apply = (): void => {
    if (suggestion === null || applying) return
    setApplying(true)
    const merged = [...new Set([...(paper.tags ?? []), ...suggestion.tags])]
    void updatePaper(paper.arxivId, { tags: merged, score: suggestion.score })
      .then((failure) => {
        if (failure === null) setSuggestion(null)
        else onError(`${t('papers.saveFailed')}：${failure.message}`)
      })
      .finally(() => { setApplying(false) })
  }

  return (
    <div className={css.paperSuggest}>
      <div className={css.paperAiActions}>
        <button
          type="button"
          className={css.btn}
          disabled={running}
          title={t('papers.suggestHint')}
          onClick={suggest}
        >
          {running ? t('papers.suggesting') : t('papers.suggestTags')}
        </button>
      </div>

      {suggestion !== null && (
        <div className={css.paperSuggestBox}>
          <div className={css.paperSuggestTags}>
            {suggestion.tags.map(tag => (
              <span key={tag} className={css.paperSuggestTag}>{tag}</span>
            ))}
            <span className={css.paperSuggestScore}>
              {t('papers.scoreLabel')} {suggestion.score}/10
            </span>
          </div>
          {suggestion.reason !== '' && (
            <p className={css.paperSuggestReason}>{suggestion.reason}</p>
          )}
          <div className={css.paperSuggestActions}>
            <button type="button" className={css.btn} disabled={applying} onClick={apply}>
              {applying ? t('papers.suggestApplying') : t('papers.suggestApply')}
            </button>
            <button
              type="button"
              className={css.btn}
              disabled={applying}
              onClick={() => { setSuggestion(null) }}
            >
              {t('papers.suggestCancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Structured notes for one paper: the migrated legacy entries plus whatever
 * the reader adds here. One save replaces the whole list, which keeps the
 * server contract simple and makes deletions honest.
 */
function PaperNotesSection({ paper, onError, refreshToken, onJumpToPage, t }: {
  readonly paper: PaperRecord
  readonly onError: (message: string) => void
  /** Bumped by the reader after a highlight is saved. */
  readonly refreshToken?: number
  /** A block with a page anchor asks the reader to jump there. */
  readonly onJumpToPage?: (page: number) => void
  readonly t: ResearchT
}) {
  const [blocks, setBlocks] = useState<readonly PaperNoteBlockView[]>([])
  const [loaded, setLoaded] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [savingBlockId, setSavingBlockId] = useState('')
  const [savedBlockIds, setSavedBlockIds] = useState<ReadonlySet<string>>(new Set())

  const load = (): void => {
    void fetchPaperNotes(paper)
      .then((list) => { setBlocks(list); setLoaded(true) })
      .catch((error: Error) => { setLoaded(true); onError(`${t('papers.notesLoadFailed')}：${error.message}`) })
  }

  useEffect(() => { load() /* eslint-disable-line react-hooks/exhaustive-deps */ }, [paper.arxivId, refreshToken])

  const persist = (next: readonly PaperNoteBlockView[]): void => {
    setSaving(true)
    void savePaperNotes(paper, next)
      .then((brokenLinks) => {
        setBlocks(next)
        if (brokenLinks.length > 0) {
          onError(`${t('papers.notesBrokenLinks')}：${brokenLinks.join('、')}`)
        }
      })
      .catch((error: Error) => { onError(`${t('papers.notesSaveFailed')}：${error.message}`) })
      .finally(() => { setSaving(false) })
  }

  const addBlock = (): void => {
    const content = draft.trim()
    if (content === '' || saving) return
    persist([...blocks, {
      id: `note_${Date.now().toString(36)}`,
      kind: 'note',
      content,
      createdAt: Date.now(),
    }])
    setDraft('')
  }

  const removeBlock = (id: string): void => {
    if (saving) return
    persist(blocks.filter(block => block.id !== id))
  }

  /** Lift one block into the project's knowledge list. */
  const liftBlock = (block: PaperNoteBlockView): void => {
    const projectId = paperProjectId(paper)
    if (projectId === '') { onError(t('papers.knowledgeNoProject')); return }
    const statement = (block.comment || block.content || '').trim()
    if (statement === '' || savingBlockId !== '') return
    setSavingBlockId(block.id)
    void saveKnowledgeItem({
      projectId,
      kind: block.kind === 'highlight' ? 'passage_qa' : block.kind === 'gap' ? 'gap' : 'claim',
      statement: statement.slice(0, 4000),
      paperId: paperKey(paper),
      blockId: block.id,
    })
      .then(() => {
        setSavedBlockIds((previous) => new Set(previous).add(block.id))
      })
      .catch((error: Error) => { onError(`${t('papers.knowledgeFailed')}：${error.message}`) })
      .finally(() => { setSavingBlockId('') })
  }

  return (
    <div className={css.paperNotes}>
      <div className={css.paperNotesHead}>
        <span className={css.paperNotesCount}>{t('papers.notesBlocks')} {blocks.length}</span>
      </div>

      {loaded && blocks.length === 0 && <p className={css.hint}>{t('papers.notesBlocksEmpty')}</p>}

      {blocks.length > 0 && (
        <ul className={css.paperNoteBlockList}>
          {blocks.map(block => (
            <li key={block.id} className={css.paperNoteBlock} data-kind={block.kind}>
              <span className={css.paperNoteBlockText}>
                {block.content}
                {block.comment !== undefined && block.comment !== '' && (
                  <span className={css.paperNoteBlockComment}>{block.comment}</span>
                )}
              </span>
              {block.anchor?.page !== undefined && onJumpToPage !== undefined ? (
                <button
                  type="button"
                  className={css.paperNoteBlockMeta}
                  title={t('papers.jumpToPage')}
                  onClick={() => { onJumpToPage(block.anchor!.page as number) }}
                >
                  p.{block.anchor.page}
                </button>
              ) : block.anchor?.page !== undefined ? (
                <span className={css.paperNoteBlockMeta}>p.{block.anchor.page}</span>
              ) : null}
              <button
                type="button"
                className={css.paperNoteBlockLift}
                aria-label={t('papers.saveToKnowledge')}
                title={savedBlockIds.has(block.id) ? t('papers.knowledgeSaved') : t('papers.saveToKnowledge')}
                disabled={saving || savingBlockId === block.id || savedBlockIds.has(block.id)}
                onClick={() => { liftBlock(block) }}
              >
                {savedBlockIds.has(block.id) ? '✓' : '+'}
              </button>
              <button
                type="button"
                className={css.paperNoteBlockRemove}
                aria-label={t('papers.notesRemoveBlock')}
                title={t('papers.notesRemoveBlock')}
                disabled={saving}
                onClick={() => { removeBlock(block.id) }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className={css.paperAskRow}>
        <input
          className={css.paperAskInput}
          value={draft}
          placeholder={t('papers.notesBlockPlaceholder')}
          disabled={saving}
          onChange={(event) => { setDraft(event.target.value) }}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addBlock() } }}
        />
        <button type="button" className={css.btn} disabled={saving || draft.trim() === ''} onClick={addBlock}>
          {t('papers.notesAddBlock')}
        </button>
      </div>
    </div>
  )
}

/**
 * The PDF reader: one page at a time on a canvas, with page/zoom controls.
 *
 * Replaces a bare `<iframe>` for three reasons the iframe could never do:
 * we know the current page (so a citation can jump to it), we can render an
 * overlay layer later (highlights), and the bytes come through our own fetch,
 * so the API key in localStorage is actually sent.
 *
 * pdfjs runs without a worker here: the `?url` import Vite uses for the worker
 * does not survive esbuild's pass over this file, and the fake-worker fallback
 * is fast enough for one page of a paper.
 */
type ToolIconName = 'highlight' | 'pen' | 'text' | 'frame' | 'search' | 'figures' | 'fit' | 'outline' | 'bookmark' | 'close' | 'grid' | 'list' | 'translate' | 'dual' | 'mono' | 'chat'

/** 整篇翻译的产物：纯译文（原样式）与原文/译文左右对比。 */
type PdfVariantView = 'mono' | 'dual' | 'compare'

/** 阅读器工具栏的线性图标：20px，颜色跟随 currentColor。 */
function ToolIcon({ name }: { readonly name: ToolIconName }) {
  const common = {
    width: 20,
    height: 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }
  switch (name) {
    case 'dual':
      return (
        <svg {...common}>
          <rect x="3" y="4" width="7" height="16" rx="1.5" />
          <rect x="14" y="4" width="7" height="16" rx="1.5" />
        </svg>
      )
    case 'mono':
      return (
        <svg {...common}>
          <rect x="4" y="3" width="16" height="18" rx="2" />
          <path d="M8 8h8M8 12h8M8 16h5" />
        </svg>
      )
    case 'translate':
      return (
        <svg {...common}>
          <path d="M4 5h9M8.5 5v14M4 19h9" />
          <path d="M14 12h6M17 12v7" />
        </svg>
      )
    case 'bookmark':
      return <svg {...common}><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" /></svg>
    case 'close':
      return <svg {...common}><path d="M18 6 6 18M6 6l12 12" /></svg>
    case 'grid':
      return (
        <svg {...common}>
          <rect width="7" height="7" x="3" y="3" rx="1.5" />
          <rect width="7" height="7" x="14" y="3" rx="1.5" />
          <rect width="7" height="7" x="3" y="14" rx="1.5" />
          <rect width="7" height="7" x="14" y="14" rx="1.5" />
        </svg>
      )
    case 'list':
      return <svg {...common}><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>
    case 'highlight':
      return <svg {...common}><path d="M4 20h16" /><path d="M8 16l1.5-4.5L16 5a2.1 2.1 0 0 1 3 3l-6.5 6.5L8 16z" /></svg>
    case 'pen':
      return <svg {...common}><path d="M4 20l4-1 10-10a2.1 2.1 0 0 0-3-3L5 16l-1 4z" /></svg>
    case 'text':
      return <svg {...common}><path d="M5 6h14" /><path d="M12 6v13" /></svg>
    case 'frame':
      return <svg {...common}><rect x="3.5" y="3.5" width="17" height="17" rx="2" strokeDasharray="3 2" /></svg>
    case 'search':
      return <svg {...common}><circle cx="11" cy="11" r="6" /><path d="M16 16l4 4" /></svg>
    case 'chat':
      return (
        <svg {...common}>
          <path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H11l-4.5 3v-3H5A1.5 1.5 0 0 1 3.5 16V7A1.5 1.5 0 0 1 5 5.5z" />
          <path d="M8 10h8M8 13.5h5" />
        </svg>
      )
    case 'figures':
      return <svg {...common}><rect x="3.5" y="3.5" width="17" height="17" rx="2" /><path d="M3.5 10h17M10 10v10.5" /></svg>
    case 'outline':
      return (
        <svg {...common}>
          <path d="M9 6h11M9 12h11M9 18h11" />
          <circle cx="4.5" cy="6" r="1" />
          <circle cx="4.5" cy="12" r="1" />
          <circle cx="4.5" cy="18" r="1" />
        </svg>
      )
    case 'fit':
      return <svg {...common}><path d="M4 12h16" /><path d="M8 8l-4 4 4 4M16 8l4 4-4 4" /></svg>
    default:
      return <svg {...common}><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" /></svg>
  }
}

/** One text run as PDF sees it: viewport coordinates, before the page offset. */
interface GlyphItem {
  readonly str: string
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
  /** 基线 y。同一行的词基线一致，而 top 会因字号不同而漂移，分组要用它。 */
  readonly baseline: number
}

/** One line of a highlight, in 0-1 page coordinates. */
interface HighlightRectView {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** One caption from the paper's figure index. */
interface FigureRefView {
  readonly label: string
  readonly kind: 'figure' | 'table'
  readonly page: number
  readonly title: string
}



/**
 * 把浏览器的选区（Range）直接定位到文本层 span，读每个 span 绑定的字形矩形，
 * 折成 0-1 页面坐标，一行一矩形。
 *
 * 这是 pdf.js（用 PDF 字形矩形做坐标）与 react-pdf-highlighter（用 Range 直接
 * 定位、绝不拿选区文本反查）两个思路的结合：
 *  - 矩形来自 PDF 权威字形，边界不受浏览器字体度量漂移影响；
 *  - 「选区覆盖哪些字形」由 Range 的 DOM 节点决定，天然就是用户实际划选的内容。
 *
 * 页面里同一个词重复出现多次也不会命中错误位置 —— 这是之前用选区文本在整页
 * 字形里 `indexOf` 反查时会犯的错，正是选区错乱的根因。
 */
function measureSelectionFromSpans(
  container: HTMLElement | null,
  range: Range,
  box: DOMRect,
): HighlightRectView[] {
  if (container === null || box.width === 0 || box.height === 0) return []

  // Range 的起止节点向上找到所属 span（文本层里 span 直接包一个 text node）。
  const spanOf = (node: Node): HTMLElement | null => {
    const el = node.nodeType === Node.ELEMENT_NODE
      ? (node as HTMLElement)
      : (node as Text).parentElement
    if (el === null || el === undefined) return null
    const span = el.closest('span')
    if (span === null || !container.contains(span)) return null
    return span as HTMLElement
  }
  const startSpan = spanOf(range.startContainer)
  const endSpan = spanOf(range.endContainer)
  if (startSpan === null || endSpan === null) return []

  const spans = [...container.querySelectorAll('span')]
  const startIndex = spans.indexOf(startSpan)
  const endIndex = spans.indexOf(endSpan)
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) return []

  interface LineBox { x1: number; y1: number; x2: number; y2: number }
  const lines = new Map<number, LineBox>()

  for (let index = startIndex; index <= endIndex; index += 1) {
    const span = spans[index]
    const g = {
      left: Number(span.dataset.gLeft),
      top: Number(span.dataset.gTop),
      width: Number(span.dataset.gWidth),
      height: Number(span.dataset.gHeight),
      baseline: Number(span.dataset.gBaseline),
    }
    if (!Number.isFinite(g.left) || !Number.isFinite(g.top) || !Number.isFinite(g.width) || !Number.isFinite(g.height)) continue
    const length = (span.textContent ?? '').length
    if (length === 0) continue
    // 首尾 span 按 Range 偏移做部分覆盖；中间的 span 整段覆盖。
    const from = index === startIndex && range.startContainer.nodeType === Node.TEXT_NODE
      ? Math.min(Math.max(range.startOffset, 0), length) / length
      : 0
    const to = index === endIndex && range.endContainer.nodeType === Node.TEXT_NODE
      ? Math.min(Math.max(range.endOffset, 0), length) / length
      : 1
    if (to <= from) continue

    const x1 = box.left + g.left + g.width * from
    const x2 = box.left + g.left + g.width * to
    const y1 = box.top + g.top
    const y2 = y1 + g.height
    const key = Math.round(Number.isFinite(g.baseline) ? g.baseline : g.top)
    const line = lines.get(key)
    if (line === undefined) {
      lines.set(key, { x1, y1, x2, y2 })
    } else {
      line.x1 = Math.min(line.x1, x1)
      line.x2 = Math.max(line.x2, x2)
      line.y1 = Math.min(line.y1, y1)
      line.y2 = Math.max(line.y2, y2)
    }
  }

  const PAD_Y = 1.2
  const out: HighlightRectView[] = []
  for (const line of lines.values()) {
    const x = Math.min(Math.max((line.x1 - box.left) / box.width, 0), 1)
    const top = line.y1 - PAD_Y
    const bottom = line.y2 + PAD_Y
    const y = Math.min(Math.max((top - box.top) / box.height, 0), 1)
    out.push({
      x,
      y,
      w: Math.max(0, Math.min((line.x2 - line.x1) / box.width, 1 - x)),
      h: Math.max(0, Math.min((bottom - top) / box.height, 1 - y)),
    })
  }
  return out
}

/**
 * Measure a selection as one rect per visual line.
 *
 * `range.getClientRects()` cannot be used directly: for a multi-line range the
 * browser returns line boxes, whose width includes trailing whitespace and the
 * stretch of justified text — that is what made highlights overhang the right
 * margin. Measuring character by character and merging per line lands exactly
 * on the visible glyphs.
 */
function measureSelectionLines(range: Range, box: DOMRect): HighlightRectView[] {
  const root = range.commonAncestorContainer
  const nodes: Text[] = []
  if (root.nodeType === Node.TEXT_NODE) {
    nodes.push(root as Text)
  } else {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode() as Text | null
    while (node) {
      if (range.intersectsNode(node)) nodes.push(node)
      node = walker.nextNode() as Text | null
    }
  }

  interface LineBox { x1: number; y1: number; x2: number; y2: number }
  const lines: LineBox[] = []

  const lineOf = (rect: DOMRect): LineBox => {
    // 同一行的字形可能因升部/降部不同而 top 不同；用中心线聚类，避免一行被拆成多条矩形。
    const center = rect.top + rect.height / 2
    const found = lines.find(line => Math.abs((line.y1 + line.y2) / 2 - center) <= Math.max(2, rect.height * 0.55))
    if (found) return found
    const created = { x1: rect.left, y1: rect.top, x2: rect.right, y2: rect.bottom }
    lines.push(created)
    return created
  }

  for (const node of nodes) {
    const data = node.data
    const start = node === range.startContainer ? range.startOffset : 0
    const end = node === range.endContainer ? range.endOffset : data.length
    for (let at = start; at < end; at += 1) {
      if (/\s/.test(data[at])) continue
      const charRange = document.createRange()
      charRange.setStart(node, at)
      charRange.setEnd(node, at + 1)
      const rect = charRange.getBoundingClientRect()
      if (rect.width < 0.5 || rect.height < 0.5) continue
      const line = lineOf(rect)
      line.x1 = Math.min(line.x1, rect.left)
      line.x2 = Math.max(line.x2, rect.right)
      line.y1 = Math.min(line.y1, rect.top)
      line.y2 = Math.max(line.y2, rect.bottom)
    }
  }

  /*
   * 字号框比行框略短，需要少量上下 padding 才连成一条高亮带。
   * 但相邻行各自加 padding 会互相重叠（截图里更深的色带）。
   * 这里按两行字框的中线切分间隙：上一行底 = 下一行顶，既不叠色也不漏缝。
   */
  lines.sort((a, b) => a.y1 - b.y1)
  const PAD_Y = 1.4
  const out: HighlightRectView[] = []
  let previousBottom = Number.NEGATIVE_INFINITY
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const next = lines[index + 1]
    const top = Math.max(line.y1 - PAD_Y, previousBottom)
    const naturalBottom = line.y2 + PAD_Y
    const bottom = next === undefined
      ? naturalBottom
      : Math.min(naturalBottom, (line.y2 + next.y1) / 2)
    const safeBottom = Math.max(bottom, top + 0.5)
    previousBottom = safeBottom

    const x = Math.min(Math.max((line.x1 - box.left) / box.width, 0), 1)
    const y = Math.min(Math.max((top - box.top) / box.height, 0), 1)
    out.push({
      x,
      y,
      w: Math.max(0, Math.min((line.x2 - line.x1) / box.width, 1 - x)),
      h: Math.max(0, Math.min((safeBottom - top) / box.height, 1 - y)),
    })
  }
  return out
}

/** One freehand stroke, points already normalised to 0-1. */
interface InkStrokeView {
  readonly color: string
  readonly width: number
  readonly points: ReadonlyArray<{ x: number; y: number }>
}

/** All strokes of one page (stored as a single `ink` note block). */
interface InkView {
  readonly id: string
  readonly page: number
  readonly strokes: readonly InkStrokeView[]
}

/**
 * 五个高亮色（`#rrggbbaa`，35% 不透明）。
 *
 * 低饱和的暖黄 / 绿 / 蓝 / 紫 / 珊瑚，压在正文上不抢字，灰度下也能彼此区分。
 */
const HIGHLIGHT_COLORS = ['#f5d68a59', '#b8e0c859', '#b8d4f059', '#d4c4e859', '#f0c0b859'] as const

/** Default when a stored block has no colour. */
const HIGHLIGHT_FALLBACK = HIGHLIGHT_COLORS[0]

/** A saved highlight on the current page. */
interface HighlightView {
  readonly id: string
  readonly page: number
  readonly quote: string
  readonly rects: readonly HighlightRectView[]
  readonly color: string
  /** 有值时，选区右侧显示「笔记」入口。 */
  readonly comment?: string
  /** 只保留批注，不绘画色块。 */
  readonly highlightHidden?: boolean
}


/** One page in the continuous reader. Off-screen pages keep a lightweight placeholder. */
function ContinuousPdfPage({ doc, pageNumber, zoom, active, activeSize, estimatedSize, onActivate, onRegister, onText, onMouseDown, onMouseMove, onMouseUp, cropMode, children }: {
  readonly doc: any
  readonly pageNumber: number
  readonly zoom: number
  readonly active: boolean
  readonly activeSize: { w: number; h: number }
  readonly estimatedSize: { w: number; h: number }
  readonly onActivate: (page: number) => void
  readonly onRegister: (page: number, element: HTMLDivElement | null) => void
  readonly onText: (page: number, runs: GlyphItem[], size: { w: number; h: number }) => void
  readonly onMouseDown?: (event: any) => void
  readonly onMouseMove?: (event: any) => void
  readonly onMouseUp?: (event: any) => void
  readonly cropMode: boolean
  readonly children: any
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const textLayerRef = useRef<HTMLDivElement | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

  useEffect(() => {
    if (active) return undefined
    let cancelled = false
    let renderTask: any = null
    const box = boxRef.current
    const paint = async (): Promise<void> => {
      try {
        const pdfPage = await doc.getPage(pageNumber)
        if (cancelled) return
        const canvas = canvasRef.current
        const container = textLayerRef.current
        if (!canvas || !container) return
        const viewport = pdfPage.getViewport({ scale: zoom })
        const ratio = Math.min(window.devicePixelRatio || 1, 2)
        const width = Math.floor(viewport.width)
        const height = Math.floor(viewport.height)
        canvas.width = Math.floor(width * ratio)
        canvas.height = Math.floor(height * ratio)
        canvas.style.width = `${width}px`
        canvas.style.height = `${height}px`
        setSize({ w: width, h: height })
        const context = canvas.getContext('2d')
        if (!context) return
        renderTask = pdfPage.render({
          canvasContext: context,
          viewport,
          ...(ratio === 1 ? {} : { transform: [ratio, 0, 0, ratio, 0, 0] }),
        })
        await renderTask.promise
        if (cancelled) return
        const pdfjs: any = await import('pdfjs-dist')
        container.replaceChildren()
        container.style.setProperty('--total-scale-factor', String(zoom))
        container.style.setProperty('--scale-factor', String(zoom))
        const content = await pdfPage.getTextContent()
        const textLayer = new pdfjs.TextLayer({ textContentSource: content, container, viewport })
        await textLayer.render()
        const runs: GlyphItem[] = []
        for (const item of content.items as any[]) {
          const str = String(item?.str ?? '')
          if (str === '') continue
          const tx = pdfjs.Util.transform(viewport.transform, item.transform)
          const fontHeight = Math.hypot(tx[2], tx[3])
          runs.push({
            str,
            left: tx[4],
            top: tx[5] - fontHeight,
            width: Number(item.width) * viewport.scale,
            height: fontHeight,
            baseline: tx[5],
          })
        }
        for (const span of container.querySelectorAll('span')) {
          const node = span.firstChild
          if (node === null || node.nodeType !== Node.TEXT_NODE) continue
          const trimmed = node.data.replace(/[ \t\u00a0]+$/, '')
          if (trimmed !== node.data) node.data = trimmed
        }
        if (!cancelled) onText(pageNumber, runs, { w: width, h: height })
      } catch { /* 离开视口时取消渲染是正常路径 */ }
    }
    if (!box || typeof IntersectionObserver === 'undefined') {
      void paint()
      return () => { cancelled = true; try { renderTask?.cancel?.() } catch {} }
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some(entry => entry.isIntersecting)) return
      observer.disconnect()
      void paint()
    }, { rootMargin: '700px' })
    observer.observe(box)
    return () => {
      cancelled = true
      observer.disconnect()
      try { renderTask?.cancel?.() } catch {}
    }
  }, [doc, pageNumber, zoom, active])

  const dimensions = active ? activeSize : size.w > 0 ? size : estimatedSize
  return (
    <div
      ref={(element) => { boxRef.current = element; onRegister(pageNumber, element) }}
      className={css.paperReaderPageBox}
      data-page={pageNumber}
      data-crop={cropMode || undefined}
      style={dimensions.w > 0 ? { width: dimensions.w, height: dimensions.h } : { aspectRatio: '0.72' }}
      onMouseDown={(event) => { onActivate(pageNumber); onMouseDown?.(event) }}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    >
      {!active && (
        <>
          <canvas ref={canvasRef} className={css.paperReaderCanvas} />
          <div className={css.paperReaderTextLayer} ref={textLayerRef} />
        </>
      )}
      {children}
    </div>
  )
}

function PaperPdfReader({ paper, url, page, onPageChange, onNotesChanged, onSelectionChange, onStudy, onOpenChat, chatOpen, requestProjectImage, t }: {
  readonly paper: PaperRecord
  readonly url: string
  readonly page: number
  readonly onPageChange: (page: number) => void
  /** A highlight was saved; the notes panel should re-read. */
  readonly onNotesChanged?: () => void
  /** 选中范围变化时上报，右侧栏据此显示一块可发问的引用。 */
  readonly onSelectionChange?: (selection: { text: string; page: number } | null) => void
  /** 选区工具条的「AI 会话」：带着选区展开右侧会话。 */
  readonly onStudy?: () => void
  /** 左侧工具栏的会话入口。 */
  readonly onOpenChat?: () => void
  readonly chatOpen?: boolean
  /** 框选图片投递到当前会话（带图片附件）。 */
  readonly requestProjectImage?: (image: string, prompt: string) => Promise<{ readonly ok: boolean; readonly error?: string }>
  /** 关闭阅读器（左栏全屏按钮与标签栏 × 都用它）。 */
  readonly t: ResearchT
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const docRef = useRef<any>(null)
  const renderTaskRef = useRef<any>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  /** PDF 在 scale=1 时的页面宽度，用来算「适应宽度」。 */
  const baseWidthRef = useRef(0)
  const pageBoxRef = useRef<HTMLDivElement | null>(null)
  const textLayerRef = useRef<HTMLDivElement | null>(null)
  const [pageCount, setPageCount] = useState(0)
  const [zoom, setZoom] = useState(1.15)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [pageSize, setPageSize] = useState({ w: 0, h: 0 })
  const [highlights, setHighlights] = useState<readonly HighlightView[]>([])

  // 手绘：绘制模式、已存笔画（按页）、进行中的那一笔
  const [inkMode, setInkMode] = useState(false)
  /** 高亮层的显示开关（左栏第一个工具）。 */
  const [highlightVisible, setHighlightVisible] = useState(true)
  const [inks, setInks] = useState<readonly InkView[]>([])
  const inkCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const inkDraftRef = useRef<InkStrokeView | null>(null)
  const [inkTick, setInkTick] = useState(0)
  /** 文本层每重绘一次 +1，用来触发引文标记重画。 */
  const [textVersion, setTextVersion] = useState(0)
  const [pending, setPending] = useState<{ text: string; rects: readonly HighlightRectView[]; page: number } | null>(null)
  /** 松手后浏览器选区会被清空，复制时改用这里保存的规范化文本。 */
  const copyTextRef = useRef('')
  const [savingHighlight, setSavingHighlight] = useState(false)
  const [commentOpen, setCommentOpen] = useState(false)
  const [commentDraft, setCommentDraft] = useState('')
  /** 新建笔记时使用的高亮颜色。 */
  const [commentColor, setCommentColor] = useState<string>(HIGHLIGHT_FALLBACK)
  /*
   * captureSelection 是普通函数，读的是「本次渲染时的 commentOpen」。
   * 点「批注」那一刻 React 还没重渲染，闭包里仍是 false，守卫就失效，
   * pending 被清掉、工具条消失。用 ref 同步记录，时序才是可靠的。
   */
  const commentOpenRef = useRef(false)
  /** 点开某条批注时的小浮层，记录被点击标记的位置。 */
  const [notePeek, setNotePeek] = useState<{
    id: string
    quote: string
    comment: string
    color: string
    hidden: boolean
    left: number
    top: number
  } | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  /** PDF 自带的大纲（pdfjs getOutline），扁平化成「标题 + 页码 + 层级」。 */
  const [outline, setOutline] = useState<readonly { title: string; page: number; level: number }[]>([])
  const [outlineOpen, setOutlineOpen] = useState(false)
  /** 划词翻译：原文一次请求、结果只读展示。 */
  const [translating, setTranslating] = useState(false)
  const [translation, setTranslation] = useState('')
  const [translateError, setTranslateError] = useState('')
  /** 整页正文翻译：译文覆盖在阅读区，可切回原文。 */
  const [translatedPage, setTranslatedPage] = useState('')
  const [showTranslated, setShowTranslated] = useState(false)
  const [translatingPage, setTranslatingPage] = useState(false)
  const [translatePageError, setTranslatePageError] = useState('')
  const [matches, setMatches] = useState<readonly { page: number; snippet: string }[]>([])
  const [matchIndex, setMatchIndex] = useState(-1)
  const [searching, setSearching] = useState(false)
  const [searchRects, setSearchRects] = useState<readonly HighlightRectView[]>([])
  // 字形矩形不再存进 state：渲染文本层时直接写进每个 span 的 dataset，选区与
  // 已存高亮都从 DOM 读，翻页/重渲染不会出现索引错位。setGlyphs 仅留给连续滚动
  // 模式的页面缓存回调（它需要一份 runs 以便切页时恢复）。
  const [, setGlyphs] = useState<readonly GlyphItem[]>([])

  // 翻页后旧的选区引用就不成立了，清掉，避免右侧栏指向别的页。
  useEffect(() => { onSelectionChange?.(null) }, [page])
  // 「问这页」：把当前页 canvas 截图交给视觉模型，回答图表类问题。
  const [askOpen, setAskOpen] = useState(false)
  const [askQuestion, setAskQuestion] = useState('')
  const [askRunning, setAskRunning] = useState(false)
  const [askAnswer, setAskAnswer] = useState('')
  const [askError, setAskError] = useState('')
  // 框选一段区域单独截图，避免整页丢给模型
  const [cropMode, setCropMode] = useState(false)
  const [cropRect, setCropRect] = useState<HighlightRectView | null>(null)
  const [cropStart, setCropStart] = useState<{ x: number; y: number } | null>(null)
  // 图表清单：点一条直接跳到图注所在页，并高亮那一行
  const [figures, setFigures] = useState<readonly FigureRefView[]>([])
  const [figuresOpen, setFiguresOpen] = useState(false)
  const [figuresLoading, setFiguresLoading] = useState(false)

  /*
   * 整篇双语翻译：后端用 pdf2zh 生成 <name>-dual.pdf（原排版、原文与译文对照）。
   * 译文的字节直接留在内存里喂给 pdfjs —— 试过改成 blob: URL，但带鉴权头的
   * fetch 请求 blob: 会被拒（Failed to fetch）。`translatedPdf` 为空即原文。
   */
  const [translatedPdf, setTranslatedPdf] = useState<{ variant: PdfVariantView; bytes: Uint8Array } | null>(null)
  const [dualLoading, setDualLoading] = useState(false)
  const [dualError, setDualError] = useState('')
  const [dualCancelled, setDualCancelled] = useState(false)
  const dualAbortRef = useRef<AbortController | null>(null)

  // Load once per url; the bytes go through our own fetch so auth headers apply.
  useEffect(() => {
    let cancelled = false
    /*
     * 换源（原文 ↔ 对比译本）时页宽会翻倍，必须让首次出图重新算适配缩放。
     * 之前沿用上一个文档的 baseWidth，对比页按原文的倍率渲染，
     * 结果整页横向溢出、右边一截被裁掉。
     */
    baseWidthRef.current = 0
    setLoading(true)
    setError('')
    setPageCount(0)
    void (async () => {
      try {
        const pdfjs: any = await import('pdfjs-dist')
        // pdfjs 5.x refuses to run without a worker source. The `?url` import
        // Vite uses for the worker does not survive esbuild's pass over this
        // island, so the file is served from `public/` instead.
        pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'
        let bytes: Uint8Array
        if (translatedPdf !== null) {
          bytes = translatedPdf.bytes
        } else {
          const response = await fetch(url, { headers: researchApiHeaders() })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          bytes = new Uint8Array(await response.arrayBuffer())
        }
        const doc = await pdfjs.getDocument({ data: bytes, disableAutoFetch: true }).promise
        if (cancelled) { void doc.destroy(); return }
        docRef.current = doc
        setPageCount(doc.numPages)

        /*
         * 目录：pdfjs 的 getOutline() 给的是嵌套结构，dest 需要再解析成页码。
         * 有些 dest 指向命名目的地或算不出页码，那些条目直接跳过 —— 目录少一行
         * 不影响阅读，整个失败也只是没有目录。
         */
        void (async () => {
          try {
            const raw = await doc.getOutline()
            if (!raw || raw.length === 0) return
            const flat: Array<{ title: string; page: number; level: number }> = []
            const walk = async (items: any[], level: number): Promise<void> => {
              for (const item of items) {
                let pageNo = 0
                try {
                  const dest = typeof item.dest === 'string' ? await doc.getDestination(item.dest) : item.dest
                  if (Array.isArray(dest) && dest[0]) {
                    const index = await doc.getPageIndex(dest[0])
                    pageNo = index + 1
                  }
                } catch { /* 算不出页码的条目跳过 */ }
                const title = String(item?.title ?? '').replace(/\s+/g, ' ').trim()
                if (pageNo > 0 && title !== '') flat.push({ title, page: pageNo, level })
                if (Array.isArray(item?.items) && item.items.length > 0) await walk(item.items, level + 1)
              }
            }
            await walk(raw, 0)
            if (!cancelled) setOutline(flat.slice(0, 300))
          } catch { /* 没有目录不影响阅读 */ }
        })()
      } catch (loadError: any) {
        if (!cancelled) setError(String(loadError?.message || loadError))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
      try { renderTaskRef.current?.cancel?.() } catch { /* already settled */ }
      void docRef.current?.destroy?.()
      docRef.current = null
    }
  }, [url, translatedPdf])

  // Paint the current page whenever the page, the zoom or the document changes.
  useEffect(() => {
    const doc = docRef.current
    const canvas = canvasRef.current
    if (!doc || !canvas || pageCount === 0) return undefined
    let cancelled = false

    void (async () => {
      try {
        const pdfPage = await doc.getPage(Math.min(Math.max(page, 1), pageCount))
        if (cancelled) return

        // 首次出图时按阅读区宽度定缩放：固定倍率在任何窗口尺寸下都不合适，
        // 要么四周留大片空白，要么要横向滚动。
        if (baseWidthRef.current === 0) {
          baseWidthRef.current = pdfPage.getViewport({ scale: 1 }).width
          const stage = stageRef.current
          if (stage !== null && stage.clientWidth > 0 && baseWidthRef.current > 0) {
            const available = stage.clientWidth - STAGE_SIDE_PADDING
            const fit = Math.min(Math.max(available / baseWidthRef.current, 0.5), 3)
            setZoom(Math.round(fit * 100) / 100)
            return
          }
        }

        const viewport = pdfPage.getViewport({ scale: zoom })
        const ratio = Math.min(window.devicePixelRatio || 1, 2)
        const width = Math.floor(viewport.width)
        const height = Math.floor(viewport.height)
        canvas.width = Math.floor(width * ratio)
        canvas.height = Math.floor(height * ratio)
        canvas.style.width = `${width}px`
        canvas.style.height = `${height}px`
        setPageSize({ w: width, h: height })
        const context = canvas.getContext('2d')
        if (!context) return
        try { renderTaskRef.current?.cancel?.() } catch { /* a newer paint won */ }
        const task = pdfPage.render({
          canvasContext: context,
          viewport,
          ...(ratio === 1 ? {} : { transform: [ratio, 0, 0, ratio, 0, 0] }),
        })
        renderTaskRef.current = task
        await task.promise
        if (cancelled) return

        // 文本层：让页面上的文字能被选中，划词才有坐标可算。
        const container = textLayerRef.current
        if (!container) return
        const pdfjs: any = await import('pdfjs-dist')
        container.replaceChildren()
        container.style.setProperty('--total-scale-factor', String(zoom))
        container.style.setProperty('--scale-factor', String(zoom))
        try {
          // 取一次 textContent，既能喂给 TextLayer，也顺手记下每个词的字形矩形。
          const content = await pdfPage.getTextContent()
          const textLayer = new pdfjs.TextLayer({
            textContentSource: content,
            container,
            viewport,
          })
          await textLayer.render()

          // content.items 与 DOM span 一一对应（pdfjs 跳过空串 item、不 append 到
          // DOM，这里同样跳过空串保持对齐）。把每个 span 的 PDF 字形矩形写进它的
          // dataset，选区定位时从 Range 找到 span 直接读 —— 矩形是 PDF 权威坐标，
          // 不受浏览器字体度量漂移影响，也不需要「span 数 == 字形数」的脆弱假设。
          const runs: GlyphItem[] = []
          const spans = [...container.querySelectorAll('span')]
          let spanIndex = 0
          for (const item of content.items as any[]) {
            const str = String(item?.str ?? '')
            if (str === '') continue
            const tx = pdfjs.Util.transform(viewport.transform, item.transform)
            const fontHeight = Math.hypot(tx[2], tx[3])
            runs.push({
              str,
              left: tx[4],
              top: tx[5] - fontHeight,
              width: Number(item.width) * viewport.scale,
              height: fontHeight,
              baseline: tx[5],
            })
            const span = spans[spanIndex]
            spanIndex += 1
            if (span === undefined) continue
            span.dataset.gLeft = String(tx[4])
            span.dataset.gTop = String(tx[5] - fontHeight)
            span.dataset.gWidth = String(Number(item.width) * viewport.scale)
            span.dataset.gHeight = String(fontHeight)
            span.dataset.gBaseline = String(tx[5])
          }
          setGlyphs(runs)
        } catch { /* 文本层失败不影响阅读 */ }

        /*
         * pdfjs 给每个 span 保留行尾空格（white-space: pre），浏览器画选区时
         * 用的是行盒，会把那段空白一起刷上颜色 —— 就是右侧伸出来的那一截。
         * span 都是绝对定位，尾部空格不参与排版，删掉只有好处：
         * 原生选区和 mark 高亮都会贴合最后一个字形。
         */
        for (const span of container.querySelectorAll('span')) {
          const textNode = span.firstChild
          if (textNode === null || textNode.nodeType !== Node.TEXT_NODE) continue
          const trimmed = textNode.data.replace(/[ \t\u00a0]+$/, '')
          if (trimmed !== textNode.data) textNode.data = trimmed
        }
        // 文本层重绘完成后再量搜索命中，否则拿到的是空布局。
        if (searchQueryRef.current.trim() !== '') {
          window.setTimeout(() => { paintSearchRects(searchQueryRef.current) }, 30)
        }
        if (!cancelled) setTextVersion((value) => value + 1)
      } catch {
        // A cancelled render (page flipped mid-paint) is expected, not an error.
      }
    })()

    return () => {
      cancelled = true
      try { renderTaskRef.current?.cancel?.() } catch { /* already settled */ }
    }
  }, [page, zoom, pageCount])

  /** Saved highlights for this paper (blocks of kind `highlight` carrying rects). */
  const loadHighlights = (): void => {
    void fetchPaperNotes(paper)
      .then((blocks) => {
        const next: HighlightView[] = []
        const nextInk: InkView[] = []
        for (const block of blocks) {
          const anchor = (block as { anchor?: any }).anchor
          if (anchor && Array.isArray(anchor.strokes) && anchor.strokes.length > 0) {
            nextInk.push({
              id: block.id,
              page: Number(anchor.page) || 1,
              strokes: anchor.strokes.map((stroke: any) => ({
                color: String(stroke?.color || '#e11d48'),
                width: Number(stroke?.width) || 2.5,
                points: Array.isArray(stroke?.points) ? stroke.points : [],
              })),
            })
          }
          if (block.kind !== 'highlight' || !anchor || !Array.isArray(anchor.rects)) continue
          next.push({
            id: block.id,
            page: Number(anchor.page) || 1,
            quote: String(anchor.quote || block.content || ''),
            // 批注正文：右侧小标记和点开的浮层都读它；之前映射时丢掉了，
            // 所以保存批注后 highlight.comment 是 undefined，标记永远不显示。
            comment: String((block as { comment?: string }).comment ?? ''),
            highlightHidden: (block as { highlightHidden?: boolean }).highlightHidden === true,
            color: /^#[0-9a-f]{3,8}$/i.test(String((block as { color?: string }).color ?? ''))
              ? String((block as { color?: string }).color)
              : HIGHLIGHT_FALLBACK,
            rects: anchor.rects.map((rect: any) => ({
              x: Number(rect.x) || 0,
              y: Number(rect.y) || 0,
              w: Number(rect.w) || 0,
              h: Number(rect.h) || 0,
            })),
          })
        }
        setHighlights(next)
        setInks(nextInk)
      })
      .catch(() => { /* 高亮读不到不影响阅读 */ })
  }

  useEffect(() => { loadHighlights() /* eslint-disable-line react-hooks/exhaustive-deps */ }, [paper.arxivId])

/** PDF 复制文本：保留段落换行，同时清理不换行空格、零宽字符和断行连字符。 */
function normalizePdfClipboardText(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/([A-Za-z])-\n([A-Za-z])/g, '$1$2')
    .trim()
}

/** 查找时忽略换行、空格差异与 PDF 断行连字符，保证粘贴文本能匹配。 */
function normalizePdfSearchText(raw: string): string {
  return normalizePdfClipboardText(raw)
    .replace(/([A-Za-z])-\s+([A-Za-z])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
}

  /** Turn the browser selection into 0-1 page coordinates, one rect per line. */
  const captureSelection = (finalize: boolean = true): void => {
    /*
     * 批注输入框拿到焦点时，浏览器会清空文字选区，随后 selectionchange 又会
     * 走到这里把 pending 清掉 —— 工具条连同输入框一起消失，表现就是「点批注
     * 什么都不弹、而且之后没法再选文字」。这两种情况都不能重算选区。
     */
    if (commentOpenRef.current) return
    const active = document.activeElement
    if (active instanceof HTMLElement && active.closest('[data-selection-bar]') !== null) return

    const selection = window.getSelection()
    const rawText = selection && !selection.isCollapsed ? selection.toString() : ''
    const text = normalizePdfSearchText(rawText)
    copyTextRef.current = text === '' ? '' : normalizePdfClipboardText(rawText)
    const box = pageBoxRef.current?.getBoundingClientRect()
    if (text === '' || !box || box.width === 0 || box.height === 0) {
      setPending(null)
      return
    }
    /*
     * 选区和保存后的高亮必须共用同一套屏幕坐标。
     * pdf.js 的文本层 span 会被 CSS 重新拉伸（实测同一 span：DOM 1306.86px、
     * PDF 字形 1126.70px）。松手后若突然改用 PDF 坐标，高亮就会缩短并左移。
     * 因此优先按 Range 的 DOM 字形测量；只有 DOM 测不出来时才退回 PDF 坐标。
     */
    const range = selection!.getRangeAt(0)
    let measured = measureSelectionLines(range, box)
    if (measured.length === 0) measured = measureSelectionFromSpans(textLayerRef.current, range, box)
    // 整页选中（Ctrl+A）会量出几百行，封个顶避免一次渲染太多节点。
    const rects = measured.slice(0, 400)
    const selectedPage = activePageRef.current
    setPending(rects.length > 0 ? { text, rects, page: selectedPage } : null)
    // 同步给右侧栏：选区一出现就有一块可发问的引用。
    onSelectionChange?.(rects.length > 0 ? { text, page: selectedPage } : null)
    // 选中只生成引用，不自动发问；是否提问由用户点选区工具条上的「AI 会话」决定。
    /*
     * 清掉浏览器选区。它按行盒刷色，行尾空白会让右侧多出一截，而且不同浏览器
     * /缩放下的行盒算法还会变。松手后只留上面量出来的精确矩形，视觉才稳定。
     */
    // 拖动中保留浏览器选区，反馈即时可见；只有松手后才切换为精确矩形。
    if (finalize) selection!.removeAllRanges()
  }

  const selectionFrameRef = useRef<number | null>(null)
  const selectingRef = useRef(false)
  const previewSelection = (): void => {
    if (!selectingRef.current || selectionFrameRef.current !== null) return
    selectionFrameRef.current = window.requestAnimationFrame(() => {
      selectionFrameRef.current = null
      captureSelection(false)
    })
  }

  /** 复制最近一次 PDF 选区；优先异步剪贴板，失败时退回隐藏 textarea。 */
  const writeSelectionToClipboard = async (): Promise<void> => {
    const text = copyTextRef.current
    if (text === '') return
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.readOnly = true
      textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
      document.body.appendChild(textarea)
      textarea.select()
      try { document.execCommand('copy') } catch { /* 浏览器禁止时保留原选区 */ }
      textarea.remove()
    }
  }

  /** Persist the pending selection as a highlight block (with its colour). */
  const saveHighlight = (color: string = HIGHLIGHT_FALLBACK, comment = ''): void => {
    if (!pending || savingHighlight) return
    setSavingHighlight(true)
    void fetchPaperNotes(paper)
      .then((blocks) => savePaperNotes(paper, [...blocks, {
        id: `hl_${Date.now().toString(36)}`,
        kind: 'highlight',
        content: pending.text,
        color,
        ...(comment.trim() === '' ? {} : { comment: comment.trim() }),
        anchor: { page: pending.page, quote: pending.text, rects: pending.rects },
        createdAt: Date.now(),
      }]))
      .then(() => {
        setPending(null)
        commentOpenRef.current = false
        setCommentOpen(false)
        setCommentDraft('')
        setCommentColor(HIGHLIGHT_FALLBACK)
        window.getSelection()?.removeAllRanges()
        loadHighlights()
        onNotesChanged?.()
      })
      .catch((saveError: Error) => { setError(`${t('papers.highlightFailed')}：${saveError.message}`) })
      .finally(() => { setSavingHighlight(false) })
  }

  /** 在标记附近打开批注，空间不足时自动翻到标记上方。 */
  const openNotePeek = (highlight: HighlightView, event: { currentTarget: EventTarget }): void => {
    const target = event.currentTarget as HTMLElement
    const rect = target.getBoundingClientRect()
    const width = Math.min(340, window.innerWidth - 24)
    const estimatedHeight = 250
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))
    const top = rect.bottom + 8 + estimatedHeight > window.innerHeight
      ? Math.max(12, rect.top - estimatedHeight - 8)
      : rect.bottom + 8
    setNotePeek({
      id: highlight.id,
      quote: highlight.quote,
      comment: highlight.comment ?? '',
      color: highlight.color,
      hidden: highlight.highlightHidden === true,
      left,
      top,
    })
  }

  /** Delete one highlight block; the overlay repaints from the store. */
  const removeHighlight = (blockId: string): void => {
    setHighlights(previous => previous.filter(item => item.id !== blockId))
    setNotePeek(null)
    void fetchPaperNotes(paper)
      .then((blocks) => savePaperNotes(paper, blocks.filter(block => block.id !== blockId)))
      .then(() => {
        loadHighlights()
        onNotesChanged?.()
      })
      .catch((removeError: Error) => { setError(`${t('papers.highlightFailed')}：${removeError.message}`) })
  }

  /** 只切换色块显示，批注内容始终保留。 */
  const setHighlightHidden = (blockId: string, hidden: boolean): void => {
    setHighlights(previous => previous.map(item => item.id === blockId
      ? { ...item, highlightHidden: hidden }
      : item))
    setNotePeek(null)
    void fetchPaperNotes(paper)
      .then((blocks) => savePaperNotes(paper, blocks.map(block => block.id === blockId
        ? { ...block, highlightHidden: hidden }
        : block)))
      .then(() => {
        loadHighlights()
        onNotesChanged?.()
      })
      .catch((removeError: Error) => { setError(`${t('papers.highlightFailed')}：${removeError.message}`) })
  }

  /** 修改已有高亮/笔记的颜色，浮层保持打开。 */
  const setHighlightColor = (blockId: string, color: string): void => {
    setHighlights(previous => previous.map(item => item.id === blockId ? { ...item, color } : item))
    setNotePeek(previous => previous === null || previous.id !== blockId
      ? previous
      : { ...previous, color })
    void fetchPaperNotes(paper)
      .then((blocks) => savePaperNotes(paper, blocks.map(block => block.id === blockId
        ? { ...block, color }
        : block)))
      .then(() => {
        loadHighlights()
        onNotesChanged?.()
      })
      .catch((colorError: Error) => { setError(`${t('papers.highlightFailed')}：${colorError.message}`) })
  }

  /** 「删除笔记」= 删除整条：高亮、标记和批注一起移除。 */
  const deleteNoteAndHighlight = (blockId: string): void => {
    removeHighlight(blockId)
  }

  /** Drop every highlight on this paper (keeps plain notes and comments). */
  const clearHighlights = (): void => {
    void fetchPaperNotes(paper)
      .then((blocks) => savePaperNotes(paper, blocks.filter(block => block.kind !== 'highlight')))
      .then(() => {
        loadHighlights()
        onNotesChanged?.()
      })
      .catch((removeError: Error) => { setError(`${t('papers.highlightFailed')}：${removeError.message}`) })
  }

  /**
   * 划词翻译：走已有的 passage_qa 通道，把选中的原文丢给模型。
   * 结果放在浮层里，不占用会话历史 —— 翻译是一次性阅读辅助。
   */
  const translateSelection = async (): Promise<void> => {
    if (!pending || translating) return
    const source = pending.text.trim()
    if (source === '') return
    setTranslating(true)
    setTranslation('')
    setTranslateError('')
    try {
      const response = await fetch(`/api/studio/research/papers/${encodeURIComponent(paperKey(paper))}/translate`, {
        method: 'POST',
        headers: { ...researchApiHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: source }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`)
      setTranslation(String(body?.output || '').trim())
    } catch (error) {
      setTranslateError((error as Error).message)
    } finally {
      setTranslating(false)
    }
  }

  /**
   * 整页正文翻译：抽取当前页文本层的全部文字，翻译后整页覆盖显示。
   * 与划词翻译共用同一个接口，只是输入是整页正文而不是选中一段。
   */
  const translatePage = async (): Promise<void> => {
    if (translatingPage) return
    const layer = textLayerRef.current
    if (layer === null) return
    const source = [...layer.querySelectorAll('span')]
      .map(span => (span.textContent ?? ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (source === '') return
    setTranslatingPage(true)
    setTranslatePageError('')
    try {
      const response = await fetch(`/api/studio/research/papers/${encodeURIComponent(paperKey(paper))}/translate`, {
        method: 'POST',
        headers: { ...researchApiHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: source }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`)
      setTranslatedPage(String(body?.output || '').trim())
      setShowTranslated(true)
    } catch (error) {
      setTranslatePageError((error as Error).message)
    } finally {
      setTranslatingPage(false)
    }
  }

  /**
   * 整篇双语翻译：交给后端 pdf2zh 生成 `*-dual.pdf`（保持原排版，原文与译文
   * 对照），拿回字节后换成 blob URL 让 pdfjs 重新加载；再点一次切回原文。
   * 后端会缓存译本，同一篇第二次打开不再重跑。
   */
  const translateWholePdf = async (variant: PdfVariantView): Promise<void> => {
    if (dualLoading) return
    // 再点同一个按钮就切回原文。
    if (translatedPdf?.variant === variant) {
      setTranslatedPdf(null)
      return
    }
    const controller = new AbortController()
    dualAbortRef.current = controller
    setDualLoading(true)
    setDualError('')
    setDualCancelled(false)
    try {
      const response = await fetch(
        `/api/studio/research/papers/${encodeURIComponent(paperKey(paper))}/translate-pdf?variant=${variant}&format=base64`,
        { method: 'POST', headers: researchApiHeaders(), signal: controller.signal },
      )
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(body?.error || `HTTP ${response.status}`)
      }
      if (typeof body?.base64 !== 'string') throw new Error('translation_payload_missing')
      const binary = atob(body.base64)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
      setTranslatedPdf({ variant, bytes })
    } catch (error) {
      if (controller.signal.aborted || (error as Error).name === 'AbortError') {
        setDualCancelled(true)
      } else {
        setDualError((error as Error).message)
      }
    } finally {
      if (dualAbortRef.current === controller) dualAbortRef.current = null
      setDualLoading(false)
    }
  }

  const cancelWholePdfTranslation = (): void => {
    dualAbortRef.current?.abort()
  }

  useEffect(() => () => {
    dualAbortRef.current?.abort()
    dualAbortRef.current = null
  }, [])

  const goTo = (next: number): void => {
    const clamped = Math.min(Math.max(next, 1), pageCount || 1)
    const target = continuousPagesRef.current.get(clamped)
    const stage = stageRef.current
    if (target && stage) {
      stage.scrollTo({ top: Math.max(0, target.offsetTop - 12), behavior: 'smooth' })
      activateContinuousPage(clamped)
      return
    }
    if (clamped !== page) onPageChange(clamped)
  }

  const activePageRef = useRef(page)
  const continuousPagesRef = useRef(new Map<number, HTMLDivElement>())
  const continuousTextRef = useRef(new Map<number, { runs: GlyphItem[]; size: { w: number; h: number } }>())
  const scrollFrameRef = useRef<number | null>(null)

  const registerContinuousPage = (pageNumber: number, element: HTMLDivElement | null): void => {
    if (element === null) continuousPagesRef.current.delete(pageNumber)
    else continuousPagesRef.current.set(pageNumber, element)
    if (pageNumber === activePageRef.current) pageBoxRef.current = element
  }

  const cacheContinuousText = (pageNumber: number, runs: GlyphItem[], size: { w: number; h: number }): void => {
    continuousTextRef.current.set(pageNumber, { runs, size })
    if (pageNumber === activePageRef.current) {
      setPageSize(size)
      setGlyphs(runs)
    }
  }

  const activateContinuousPage = (pageNumber: number): void => {
    activePageRef.current = pageNumber
    pageBoxRef.current = continuousPagesRef.current.get(pageNumber) ?? null
    const cached = continuousTextRef.current.get(pageNumber)
    if (cached) {
      setPageSize(cached.size)
      setGlyphs(cached.runs)
    }
    if (pageNumber !== page) onPageChange(pageNumber)
  }

  const handleContinuousScroll = (): void => {
    if (scrollFrameRef.current !== null) return
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null
      const stage = stageRef.current
      if (!stage) return
      const center = stage.getBoundingClientRect().top + stage.clientHeight * 0.42
      let nearest = activePageRef.current
      let distance = Number.POSITIVE_INFINITY
      for (const [pageNumber, element] of continuousPagesRef.current) {
        const rect = element.getBoundingClientRect()
        const value = rect.top <= center && rect.bottom >= center
          ? 0
          : Math.min(Math.abs(rect.top - center), Math.abs(rect.bottom - center))
        if (value < distance) {
          distance = value
          nearest = pageNumber
        }
      }
      if (nearest !== activePageRef.current) activateContinuousPage(nearest)
    })
  }

  // --- 手绘 ---

  /** Redraw the ink layer for the current page; also paints the stroke in flight. */
  useEffect(() => {
    const canvas = inkCanvasRef.current
    if (!canvas || pageSize.w === 0 || pageSize.h === 0) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const width = pageSize.w
    const height = pageSize.h
    if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
    }
    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, width, height)
    context.lineCap = 'round'
    context.lineJoin = 'round'

    const stored = inks.filter(item => item.page === page).flatMap(item => item.strokes)
    const draft = inkDraftRef.current
    const all = draft === null ? stored : [...stored, draft]
    for (const stroke of all) {
      if (stroke.points.length < 2) continue
      context.beginPath()
      context.strokeStyle = stroke.color
      context.lineWidth = stroke.width
      stroke.points.forEach((point, index) => {
        const x = point.x * width
        const y = point.y * height
        if (index === 0) context.moveTo(x, y)
        else context.lineTo(x, y)
      })
      context.stroke()
    }
  }, [inks, page, pageSize, inkTick])

  /** Persist the page's strokes as one `ink` block (replacing the previous one). */
  const saveInk = (strokes: readonly InkStrokeView[]): void => {
    void fetchPaperNotes(paper)
      .then((blocks) => {
        const others = blocks.filter(block => !(block.anchor?.page === page && (block as { kind?: string }).kind === 'ink'))
        return savePaperNotes(paper, [...others, {
          id: `ink_${page}_${Date.now().toString(36)}`,
          kind: 'ink',
          content: t('papers.inkBlockLabel').replace('{page}', String(page)),
          anchor: { page, strokes },
          createdAt: Date.now(),
        }])
      })
      .then(() => {
        loadHighlights()
        onNotesChanged?.()
      })
      .catch((inkError: Error) => { setError(`${t('papers.inkFailed')}：${inkError.message}`) })
  }

  const inkPointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!inkMode) return
    event.preventDefault()
    const point = relativePoint(event)
    if (!point) return
    inkDraftRef.current = { color: '#e11d48', width: 2.5, points: [point] }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setInkTick((value) => value + 1)
  }

  const inkPointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const draft = inkDraftRef.current
    if (draft === null) return
    const point = relativePoint(event)
    if (!point) return
    draft.points.push(point)
    setInkTick((value) => value + 1)
  }

  const inkPointerUp = (): void => {
    const draft = inkDraftRef.current
    inkDraftRef.current = null
    if (draft === null || draft.points.length < 2) {
      setInkTick((value) => value + 1)
      return
    }
    const stored = inks.filter(item => item.page === page).flatMap(item => item.strokes)
    saveInk([...stored, draft])
  }

  /** 当前页的笔画，按保存顺序展开。 */
  const pageInkStrokes = inks
    .filter(item => item.page === page)
    .flatMap(item => item.strokes)

  /** 撤销当前页最后一笔。 */
  const undoInk = (): void => {
    if (pageInkStrokes.length === 0) return
    saveInk(pageInkStrokes.slice(0, -1))
  }

  /** Drop every stroke on this page. */
  const clearInk = (): void => {
    saveInk([])
  }

  // --- 页内搜索 ---

  /** Per-page plain text, cached once so typing does not re-run extraction. */
  const pageTextCache = useRef<Map<number, string>>(new Map())
  /** 粘贴/连续输入时，只允许最后一次搜索更新结果。 */
  const searchSequenceRef = useRef(0)

  const readPageText = async (pageNumber: number): Promise<string> => {
    const cached = pageTextCache.current.get(pageNumber)
    if (cached !== undefined) return cached
    const doc = docRef.current
    if (!doc) return ''
    try {
      const pdfPage = await doc.getPage(pageNumber)
      const content = await pdfPage.getTextContent()
      const text = (content.items as Array<{ str?: string }>)
        .map(item => String(item.str ?? ''))
        .join('')
      pageTextCache.current.set(pageNumber, text)
      return text
    } catch {
      return ''
    }
  }

  const runSearch = (raw: string): void => {
    const sequence = ++searchSequenceRef.current
    const needle = normalizePdfSearchText(raw).toLowerCase().replace(/\s+/g, '')
    if (needle === '' || pageCount === 0) {
      setMatches([])
      setMatchIndex(-1)
      setSearching(false)
      return
    }
    setSearching(true)
    void (async () => {
      const found: Array<{ page: number; snippet: string }> = []
      for (let pageNumber = 1; pageNumber <= pageCount && found.length < SEARCH_MATCH_LIMIT; pageNumber += 1) {
        const text = await readPageText(pageNumber)
        if (text === '') continue
        // 与复制文本使用同一套规范化：跨行、不同空格、PDF 断词都能匹配。
        const lower = normalizePdfSearchText(text).toLowerCase().replace(/\s+/g, '')
        let at = lower.indexOf(needle)
        while (at !== -1 && found.length < SEARCH_MATCH_LIMIT) {
          found.push({
            page: pageNumber,
            snippet: text.slice(Math.max(0, at - 16), at + needle.length + 28),
          })
          at = lower.indexOf(needle, at + needle.length)
        }
      }
      if (sequence !== searchSequenceRef.current) return
      setMatches(found)
      setMatchIndex(found.length > 0 ? 0 : -1)
      if (found.length > 0) goTo(found[0].page)
      setSearching(false)
    })()
  }

  const stepSearch = (direction: 1 | -1): void => {
    if (matches.length === 0) return
    const next = (matchIndex + direction + matches.length) % matches.length
    setMatchIndex(next)
    goTo(matches[next].page)
  }

  const closeSearch = (): void => {
    setSearchOpen(false)
    setSearchQuery('')
    setMatches([])
    setMatchIndex(-1)
  }

  /** Send one image to the vision model and show the answer in the ask bar. */
  const runVision = (image: string, question: string): void => {
    if (question.trim() === '' || askRunning) return
    setAskRunning(true)
    setAskError('')
    setAskAnswer('')
    void fetch(`/api/studio/research/papers/${encodeURIComponent(paperKey(paper))}/vision`, {
      method: 'POST',
      headers: { ...researchApiHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, images: [image] }),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
        setAskAnswer(String(body?.answer || ''))
      })
      .catch((error: Error) => { setAskError(error.message) })
      .finally(() => { setAskRunning(false) })
  }

  /** Send the rendered page to a vision model (the text model cannot see it). */
  const askThisPage = (): void => {
    const canvas = canvasRef.current
    if (!canvas) return
    runVision(canvas.toDataURL('image/jpeg', 0.85), askQuestion)
  }

  /** Crop the dragged region out of the page canvas, at device resolution. */
  const cropRegion = (region: HighlightRectView): string | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const sx = Math.round(region.x * canvas.width)
    const sy = Math.round(region.y * canvas.height)
    const sw = Math.round(region.w * canvas.width)
    const sh = Math.round(region.h * canvas.height)
    if (sw < 12 || sh < 12) return null
    const out = document.createElement('canvas')
    out.width = sw
    out.height = sh
    const context = out.getContext('2d')
    if (!context) return null
    context.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh)
    return out.toDataURL('image/jpeg', 0.9)
  }

  /** 框选区域投递到当前会话；没有会话通道时才退回旧的独立视觉问答。 */
  const askRegion = (): void => {
    if (cropRect === null) return
    const image = cropRegion(cropRect)
    if (image === null) { setAskError(t('papers.cropTooSmall')); return }
    const question = askQuestion.trim() === '' ? t('papers.cropDefaultQuestion') : askQuestion
    setCropRect(null)
    setCropMode(false)

    if (requestProjectImage) {
      const pageNumber = activePageRef.current
      const prompt = `我在读《${paper.title}》第 ${pageNumber} 页，框选了下面这块内容（图片见附件），请直接看图回答：\n${question}`
      if (!chatOpen) onOpenChat?.()
      setAskRunning(true)
      setAskError('')
      void requestProjectImage(image, prompt)
        .then((result) => {
          if (!result.ok) throw new Error(result.error || t('papers.sessionSendFailed'))
        })
        .catch((sendError: Error) => {
          setAskError(sendError.message)
          setAskOpen(true)
        })
        .finally(() => { setAskRunning(false) })
      return
    }

    setAskOpen(true)
    runVision(image, question)
  }

  // --- 框选截图 ---

  /** Pointer position as 0-1 page coordinates. */
  const relativePoint = (event: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const box = pageBoxRef.current?.getBoundingClientRect()
    if (!box || box.width === 0 || box.height === 0) return null
    return {
      x: Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1),
      y: Math.min(Math.max((event.clientY - box.top) / box.height, 0), 1),
    }
  }

  const startCrop = (event: { clientX: number; clientY: number; preventDefault: () => void }): void => {
    if (!cropMode) return
    event.preventDefault()
    const point = relativePoint(event)
    if (!point) return
    setCropStart(point)
    setCropRect(null)
  }

  const moveCrop = (event: { clientX: number; clientY: number }): void => {
    if (!cropMode || cropStart === null) return
    const point = relativePoint(event)
    if (!point) return
    setCropRect({
      x: Math.min(cropStart.x, point.x),
      y: Math.min(cropStart.y, point.y),
      w: Math.abs(point.x - cropStart.x),
      h: Math.abs(point.y - cropStart.y),
    })
  }

  const endCrop = (event: { clientX: number; clientY: number }): void => {
    if (!cropMode) return
    if (cropStart !== null) {
      const point = relativePoint(event)
      if (point) {
        const rect = {
          x: Math.min(cropStart.x, point.x),
          y: Math.min(cropStart.y, point.y),
          w: Math.abs(point.x - cropStart.x),
          h: Math.abs(point.y - cropStart.y),
        }
        // A click without dragging is not a region.
        setCropRect(rect.w < 0.02 || rect.h < 0.02 ? null : rect)
      }
    }
    setCropStart(null)
    setCropMode(false)
  }

  const toggleCropMode = (): void => {
    setCropMode((value) => !value)
    setCropRect(null)
    setCropStart(null)
  }

  /** 把页面宽度拉回阅读区宽度（左栏的「适应宽度」）。 */
  const fitToWidth = (): void => {
    const stage = stageRef.current
    const base = baseWidthRef.current
    if (stage === null || base === 0) return
    const available = stage.clientWidth - STAGE_SIDE_PADDING
    setZoom(Math.round(Math.min(Math.max(available / base, 0.5), 3) * 100) / 100)
  }

  /*
   * 会话栏开合会改变阅读区宽度。等布局完成后再 fit：
   * 直接在同一帧调用拿到的是旧宽度，页面会先被裁一刀再回弹。
   */
  useEffect(() => {
    if (chatOpen === undefined) return undefined
    let second = 0
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => { fitToWidth() })
    })
    return () => {
      window.cancelAnimationFrame(first)
      if (second !== 0) window.cancelAnimationFrame(second)
    }
  }, [chatOpen, pageCount])

  // --- 图表清单 ---

  const loadFigures = (): void => {
    setFiguresLoading(true)
    void fetch(`/api/studio/research/papers/${encodeURIComponent(paperKey(paper))}/figures`, {
      headers: researchApiHeaders(),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
        setFigures(Array.isArray(body?.figures) ? body.figures : [])
      })
      .catch(() => { setFigures([]) })
      .finally(() => { setFiguresLoading(false) })
  }

  useEffect(() => { loadFigures() /* eslint-disable-line react-hooks/exhaustive-deps */ }, [paper.arxivId])

  /** Reuse the search pipeline: jumping to a label highlights it too. */
  const jumpToFigure = (label: string): void => {
    setFiguresOpen(false)
    setSearchOpen(true)
    setSearchQuery(label)
    runSearch(label)
  }

  // Ctrl+C 复制 PDF 选区，Ctrl+F 打开页内查找。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const key = event.key.toLowerCase()
      const target = event.target as HTMLElement | null
      const editing = target?.closest('input, textarea, [contenteditable="true"]') !== null
      if ((event.ctrlKey || event.metaKey) && key === 'c' && !editing && copyTextRef.current !== '') {
        // 松手后原生选区已被清掉，不能依赖浏览器默认复制行为。
        event.preventDefault()
        void writeSelectionToClipboard()
      } else if ((event.ctrlKey || event.metaKey) && key === 'f') {
        event.preventDefault()
        setSearchOpen(true)
      } else if (event.key === 'Escape' && searchOpen) {
        closeSearch()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => { window.removeEventListener('keydown', onKeyDown, true) }
  }, [searchOpen])

  /**
   * Search hits as overlay rects.
   *
   * The Custom Highlight API would avoid touching the DOM, but it re-renders
   * out of step with pdfjs's async text layer; measuring the ranges ourselves
   * and painting rects uses the same coordinate path as saved highlights,
   * which is already proven.
   */
  const paintSearchRects = (needleRaw: string): void => {
    const layer = textLayerRef.current
    const box = pageBoxRef.current?.getBoundingClientRect()
    const needle = normalizePdfSearchText(needleRaw).toLowerCase()
    if (!layer || !box || box.width === 0 || needle === '') {
      setSearchRects([])
      return
    }
    const boxRect = box
    const rects: HighlightRectView[] = []
    for (const span of layer.querySelectorAll('span')) {
      const node = span.firstChild
      if (!node || node.nodeType !== 3) continue
      const text = node.data.toLowerCase()
      let at = text.indexOf(needle)
      while (at !== -1) {
        const range = document.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + needle.length)
        for (const rect of [...range.getClientRects()]) {
          if (rect.width < 1 || rect.height < 1) continue
          const x = Math.min(Math.max((rect.left - boxRect.left) / boxRect.width, 0), 1)
          const y = Math.min(Math.max((rect.top - boxRect.top) / boxRect.height, 0), 1)
          rects.push({
            x,
            y,
            w: Math.max(0, Math.min(rect.width / boxRect.width, 1 - x)),
            h: Math.max(0, Math.min(rect.height / boxRect.height, 1 - y)),
          })
        }
        at = text.indexOf(needle, at + needle.length)
      }
    }
    setSearchRects(rects)
  }

  // Keep the latest query where the text-layer effect can read it after paint.
  const searchQueryRef = useRef('')
  useEffect(() => { searchQueryRef.current = searchQuery }, [searchQuery])

  useEffect(() => {
    if (searchQuery.trim() === '') { setSearchRects([]); return undefined }
    const timer = window.setTimeout(() => { paintSearchRects(searchQuery) }, 260)
    return () => { window.clearTimeout(timer) }
  }, [searchQuery, page, pageCount, zoom])

  /**
   * 本页要画的高亮，矩形在渲染前算好并缓存。
   * 之前是在 JSX 里现算的 —— 每重渲染一次、每条高亮一次，全都要重建索引，
   * 拖选时肉眼可见地卡。
   */
  const paintedHighlights = useMemo(() => {
    // 已存高亮的 rects 在保存时就是精确的 0-1 坐标，直接信任；不再用引文文本
    // 在整页字形里反查（那样会命中重复文本的错误位置）。
    return highlights.filter(item => item.page === page)
  }, [highlights, page])

  return (
    <div
      className={css.paperReader}
      onCopy={(event) => {
        const target = event.target as HTMLElement | null
        if (target?.closest('input, textarea, [contenteditable="true"]')) return
        if (copyTextRef.current === '') return
        event.preventDefault()
        event.clipboardData.setData('text/plain', copyTextRef.current)
      }}
    >
      {/*
       * 顶部不放工具条：翻页、缩放、工具各自贴在阅读区边缘——
       * 竖排工具在左缘、页码在右上、缩放在右下。视觉全部走本项目的 token，
       * 与文献卡片、右侧笔记栏保持同一套圆角/描边/阴影。
       */}
      {/* 区域 2：左侧工具栏，48px 定宽，图标 20px、按钮 36×36。 */}
      <div className={css.paperReaderTools} role="toolbar" aria-orientation="vertical" aria-label={t('papers.readerTools')}>
        <button
          type="button"
          className={css.paperReaderToolBtn}
          data-active={highlightVisible || undefined}
          data-tip={t('papers.highlight')}
          aria-label={t('papers.highlight')}
          aria-pressed={highlightVisible}
          onClick={() => { setHighlightVisible((value) => !value) }}
        >
          <ToolIcon name="highlight" />
        </button>
        <button
          type="button"
          className={css.paperReaderToolBtn}
          data-active={inkMode || undefined}
          data-tip={inkMode ? t('papers.inkExit') : t('papers.ink')}
          aria-label={t('papers.ink')}
          aria-pressed={inkMode}
          onClick={() => {
            const next = !inkMode
            setInkMode(next)
            if (next) setCropMode(false)
          }}
        >
          <ToolIcon name="pen" />
        </button>
        <button
          type="button"
          className={css.paperReaderToolBtn}
          data-active={(!inkMode && !cropMode) || undefined}
          data-tip={t('papers.textMode')}
          aria-label={t('papers.textMode')}
          onClick={() => { setInkMode(false); setCropMode(false) }}
        >
          <ToolIcon name="text" />
        </button>
        <button
          type="button"
          className={css.paperReaderToolBtn}
          data-active={cropMode || undefined}
          data-tip={t('papers.cropHint')}
          aria-label={t('papers.crop')}
          aria-pressed={cropMode}
          onClick={toggleCropMode}
        >
          <ToolIcon name="frame" />
        </button>

        <span className={css.paperReaderToolsDivider} aria-hidden="true" />

        <button
          type="button"
          className={css.paperReaderToolBtn}
          data-active={searchOpen || undefined}
          data-tip={t('papers.searchInPdf')}
          aria-label={t('papers.searchInPdf')}
          onClick={() => { if (searchOpen) closeSearch(); else setSearchOpen(true) }}
        >
          <ToolIcon name="search" />
        </button>
        <button
          type="button"
          className={css.paperReaderToolBtn}
          data-active={chatOpen || undefined}
          data-tip={t('papers.sideChat')}
          aria-label={t('papers.sideChat')}
          aria-pressed={chatOpen === true}
          onClick={() => { onOpenChat?.() }}
        >
          <ToolIcon name="chat" />
        </button>
        <button
          type="button"
          className={css.paperReaderToolBtn}
          data-active={outlineOpen || undefined}
          data-tip={t('papers.outline')}
          aria-label={t('papers.outline')}
          aria-pressed={outlineOpen}
          disabled={outline.length === 0}
          onClick={() => { setOutlineOpen((value) => !value) }}
        >
          <ToolIcon name="outline" />
        </button>
        <button
          type="button"
          className={css.paperReaderToolBtn}
          data-active={figuresOpen || undefined}
          data-tip={t('papers.figuresHint')}
          aria-label={t('papers.figures')}
          disabled={figuresLoading || figures.length === 0}
          onClick={() => { setFiguresOpen((value) => !value) }}
        >
          <ToolIcon name="figures" />
        </button>
        <button
          type="button"
          className={css.paperReaderToolBtn}
          data-tip={t('papers.fitWidth')}
          aria-label={t('papers.fitWidth')}
          onClick={fitToWidth}
        >
          <ToolIcon name="fit" />
        </button>
        <button
          type="button"
          className={css.paperReaderToolBtn}
          data-active={showTranslated || undefined}
          data-tip={showTranslated ? t('papers.showOriginal') : t('papers.translatePage')}
          aria-label={showTranslated ? t('papers.showOriginal') : t('papers.translatePage')}
          aria-pressed={showTranslated}
          disabled={translatingPage}
          onClick={() => {
            if (showTranslated) { setShowTranslated(false); return }
            if (translatedPage !== '') { setShowTranslated(true); return }
            void translatePage()
          }}
        >
          <ToolIcon name="translate" />
        </button>
        <button
          type="button"
          className={css.paperReaderToolBtn}
          data-active={translatedPdf?.variant === 'mono' || undefined}
          data-tip={
            translatedPdf?.variant === 'mono'
              ? t('papers.showOriginalPdf')
              : dualLoading ? t('papers.translatingDual') : t('papers.translateMono')
          }
          aria-label={translatedPdf?.variant === 'mono' ? t('papers.showOriginalPdf') : t('papers.translateMono')}
          aria-pressed={translatedPdf?.variant === 'mono'}
          disabled={dualLoading}
          onClick={() => { void translateWholePdf('mono') }}
        >
          <ToolIcon name="mono" />
        </button>
        <button
          type="button"
          className={css.paperReaderToolBtn}
          data-active={translatedPdf?.variant === 'compare' || undefined}
          data-tip={
            translatedPdf?.variant === 'compare'
              ? t('papers.showOriginalPdf')
              : dualLoading ? t('papers.translatingDual') : t('papers.translateCompare')
          }
          aria-label={translatedPdf?.variant === 'compare' ? t('papers.showOriginalPdf') : t('papers.translateCompare')}
          aria-pressed={translatedPdf?.variant === 'compare'}
          disabled={dualLoading}
          onClick={() => { void translateWholePdf('compare') }}
        >
          <ToolIcon name="dual" />
        </button>
        {dualLoading && (
          <button
            type="button"
            className={css.paperReaderToolBtn}
            data-tip={t('papers.cancelTranslation')}
            aria-label={t('papers.cancelTranslation')}
            onClick={cancelWholePdfTranslation}
          >
            <span className={css.paperReaderToolIcon} aria-hidden="true">×</span>
          </button>
        )}
        {pageInkStrokes.length > 0 && (
          <>
            <span className={css.paperReaderToolsDivider} aria-hidden="true" />
            <button
              type="button"
              className={css.paperReaderToolBtn}
              data-tip={t('papers.inkUndo')}
              aria-label={t('papers.inkUndo')}
              onClick={undoInk}
            >
              <span className={css.paperReaderToolIcon} aria-hidden="true">↶</span>
            </button>
            <button
              type="button"
              className={css.paperReaderToolBtn}
              data-tip={t('papers.inkClear')}
              aria-label={t('papers.inkClear')}
              onClick={clearInk}
            >
              <span className={css.paperReaderToolIcon} aria-hidden="true">⌫</span>
            </button>
          </>
        )}
      </div>

      {/* 区域 4：页码在右上，缩放在右下；滚轮和键盘负责翻页。 */}
      <div className={css.paperReaderPageHud}>
        <input
          className={css.paperReaderPageHudInput}
          value={page}
          inputMode="numeric"
          aria-label={t('papers.pageJump')}
          title={t('papers.pageJump')}
          onChange={(event) => {
            const parsed = Number(event.target.value.replace(/[^0-9]/g, ''))
            if (Number.isFinite(parsed) && parsed > 0) goTo(parsed)
          }}
        />
        <span className={css.paperReaderPageHudTotal}>/ {pageCount || '—'}</span>
      </div>
      <div className={css.paperReaderZoomHud}>
        <button
          type="button"
          className={css.paperReaderZoomHudButton}
          disabled={zoom <= 0.5}
          aria-label={t('papers.zoomOut')}
          title={t('papers.zoomOut')}
          onClick={() => { setZoom((value) => Math.max(0.5, Math.round((value - 0.15) * 100) / 100)) }}
        >
          −
        </button>
        <span className={css.paperReaderZoomHudValue}>{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          className={css.paperReaderZoomHudButton}
          disabled={zoom >= 3}
          aria-label={t('papers.zoomIn')}
          title={t('papers.zoomIn')}
          onClick={() => { setZoom((value) => Math.min(3, Math.round((value + 0.15) * 100) / 100)) }}
        >
          +
        </button>
      </div>

      {figuresOpen && figures.length > 0 && (
        <div className={css.paperReaderFigurePanel}>
          {figures.map(ref => (
            <button
              key={ref.label}
              type="button"
              className={css.paperReaderFigureItem}
              onClick={() => { jumpToFigure(ref.label) }}
            >
              <span className={css.paperReaderFigureLabel} data-kind={ref.kind}>{ref.label}</span>
              <span className={css.paperReaderFigureTitle}>{ref.title}</span>
              <span className={css.paperReaderFigurePage}>p.{ref.page}</span>
            </button>
          ))}
        </div>
      )}

      {askOpen && (
        <div className={css.paperReaderAskBar}>
          <div className={css.paperReaderSearchBar} data-flat>
            <input
              className={css.paperReaderSearchInput}
              value={askQuestion}
              placeholder={t('papers.askThisPagePlaceholder')}
              disabled={askRunning}
              onChange={(event) => { setAskQuestion(event.target.value) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') { event.preventDefault(); askThisPage() }
              }}
            />
            <button
              type="button"
              className={css.btn}
              disabled={askRunning || askQuestion.trim() === ''}
              onClick={askThisPage}
            >
              {askRunning ? t('papers.skillRunning') : t('papers.ask')}
            </button>
          </div>
          {askError !== '' && <p className={css.failure} role="alert">{askError}</p>}
          {askAnswer !== '' && (
            <div className={css.paperReaderAskAnswer}>{askAnswer}</div>
          )}
        </div>
      )}

      {(translation !== '' || translateError !== '') && (
        <div className={css.paperReaderTranslate} role="status" aria-live="polite">
          <div className={css.paperReaderTranslateHead}>
            <span>{t('papers.translate')}</span>
            <button
              type="button"
              className={css.paperReaderTranslateClose}
              aria-label={t('papers.cancel')}
              onClick={() => { setTranslation(''); setTranslateError('') }}
            >
              ×
            </button>
          </div>
          {translateError !== '' ? (
            <p className={css.failure} role="alert">{translateError}</p>
          ) : (
            <div className={css.paperReaderTranslateBody}>{translation}</div>
          )}
        </div>
      )}

      {outlineOpen && outline.length > 0 && (
        <div className={css.paperReaderOutline} role="navigation" aria-label={t('papers.outline')}>
          <div className={css.paperReaderOutlineHead}>{t('papers.outline')}</div>
          <div className={css.paperReaderOutlineList}>
            {outline.map((item, index) => (
              <button
                key={`${item.page}-${index}`}
                type="button"
                className={css.paperReaderOutlineItem}
                // 层级靠左内边距表达，目录本身不需要额外的缩进结构。
                style={{ paddingInlineStart: `${10 + item.level * 12}px` }}
                data-current={item.page === page || undefined}
                title={item.title}
                onClick={() => { goTo(item.page) }}
              >
                <span className={css.paperReaderOutlineText}>{item.title}</span>
                <span className={css.paperReaderOutlinePage}>{item.page}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/*
        查找用真正的弹窗：挂到 body，避免被阅读器外层的 transform 限制
        （position: fixed 在有 transform 的祖先里会相对该祖先定位，弹不出全屏）。
        弹窗里除输入框外还列出「第几页有几处匹配」，点一条直接跳过去。
      */}
      {searchOpen && createPortal((
        <div
          className={css.paperSearchBackdrop}
          role="dialog"
          aria-modal="true"
          aria-label={t('papers.searchInPdf')}
          onClick={closeSearch}
        >
          <div
            className={css.paperSearchDialog}
            onClick={(event) => { event.stopPropagation() }}
            onKeyDown={(event) => {
              if (event.altKey && event.key.toLowerCase() === 'b') {
                event.preventDefault()
                stepSearch(-1)
              } else if (event.altKey && event.key.toLowerCase() === 'f') {
                event.preventDefault()
                stepSearch(1)
              } else if (event.key === 'F3') {
                event.preventDefault()
                stepSearch(event.shiftKey ? -1 : 1)
              }
            }}
          >
            <div className={css.paperSearchHead}>
              <span>{t('papers.searchInPdf')}</span>
              <button
                type="button"
                className={css.paperSearchClose}
                aria-label={t('papers.cancel')}
                onClick={closeSearch}
              >
                ×
              </button>
            </div>
            <div className={css.paperSearchInputRow}>
              <input
                className={css.paperReaderSearchInput}
                value={searchQuery}
                placeholder={t('papers.searchInPdfPlaceholder')}
                autoFocus
                onChange={(event) => {
                  const value = event.target.value
                  setSearchQuery(value)
                  runSearch(value)
                }}
                onPaste={(event) => {
                  const value = normalizePdfSearchText(event.clipboardData.getData('text/plain'))
                  if (value === '') return
                  // 粘贴即搜索，并把换行/空格规范成输入框可展示的单行文本。
                  event.preventDefault()
                  setSearchQuery(value)
                  runSearch(value)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    stepSearch(event.shiftKey ? -1 : 1)
                  }
                }}
              />
              <span className={css.paperReaderSearchCount}>
                {searching
                  ? '…'
                  : matches.length > 0
                    ? `${matchIndex + 1}/${matches.length}${matches.length >= SEARCH_MATCH_LIMIT ? '+' : ''}`
                    : t('papers.searchNoMatch')}
              </span>
            </div>
            {matches.length > 0 && (
              <ul className={css.paperSearchResults}>
                {Array.from(new Set(matches.map(match => match.page))).map(pageNumber => {
                  const pageMatches = matches.filter(match => match.page === pageNumber)
                  return (
                    <li key={pageNumber}>
                      <button
                        type="button"
                        className={css.paperSearchResultItem}
                        onClick={() => {
                          const first = matches.findIndex(match => match.page === pageNumber)
                          if (first >= 0) setMatchIndex(first)
                          // 保持弹窗打开，用户可以继续上一处/下一处。
                          goTo(pageNumber)
                        }}
                      >
                        <span className={css.paperSearchResultMain}>
                          <span className={css.paperSearchResultPage}>
                            {t('papers.searchResultPage', { page: pageNumber })}
                          </span>
                          <span className={css.paperSearchResultSnippet}>{pageMatches[0]?.snippet}</span>
                        </span>
                        <span className={css.paperSearchResultCount}>{pageMatches.length}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
            <div className={css.paperSearchFooter}>
              <button
                type="button"
                className={css.paperSearchNavButton}
                disabled={matches.length === 0}
                title="Alt+B"
                onClick={() => { stepSearch(-1) }}
              >
                <span aria-hidden="true">‹</span>
                {t('papers.searchPrev')}
                <kbd className={css.paperSearchShortcut}>B</kbd>
              </button>
              <button
                type="button"
                className={css.paperSearchNavButton}
                disabled={matches.length === 0}
                title="Alt+F"
                onClick={() => { stepSearch(1) }}
              >
                {t('papers.searchNext')}
                <kbd className={css.paperSearchShortcut}>F</kbd>
                <span aria-hidden="true">›</span>
              </button>
            </div>
          </div>
        </div>
      ), document.body)}

      {/* 批注查看挂到 body：连续阅读的非激活页没有独立浮层容器，
          放在页内会导致「写了笔记但点击看不到」。 */}
      {notePeek !== null && createPortal((
        <div className={css.paperNoteBackdrop} onClick={() => { setNotePeek(null) }}>
          <div
            className={css.paperReaderNotePeek}
            role="dialog"
            aria-label={t('papers.viewComment')}
            style={{ left: notePeek.left, top: notePeek.top, right: 'auto', bottom: 'auto' }}
            onClick={(event) => { event.stopPropagation() }}
          >
            <div className={css.paperReaderNotePeekHead}>
              <span>{t('papers.viewComment')}</span>
              <button
                type="button"
                className={css.paperReaderNotePeekClose}
                aria-label={t('papers.cancel')}
                onClick={() => { setNotePeek(null) }}
              >
                ×
              </button>
            </div>
            <p className={css.paperReaderNotePeekQuote}>{notePeek.quote.slice(0, 140)}</p>
            <div className={css.paperReaderNotePeekColors} role="group" aria-label={t('papers.highlight')}>
              {HIGHLIGHT_COLORS.map(color => (
                <button
                  key={color}
                  type="button"
                  className={css.paperReaderNotePeekSwatch}
                  style={{ background: color }}
                  data-active={notePeek.color === color || undefined}
                  aria-label={t('papers.highlight')}
                  aria-pressed={notePeek.color === color}
                  onClick={() => { setHighlightColor(notePeek.id, color) }}
                />
              ))}
            </div>
            {notePeek.comment !== '' && (
              <p className={css.paperReaderNotePeekBody}>{notePeek.comment}</p>
            )}
            <div className={css.paperReaderNotePeekActions}>
              {notePeek.comment !== '' && (
                <button
                  type="button"
                  className={css.paperReaderNotePeekAction}
                  data-danger
                  onClick={() => { deleteNoteAndHighlight(notePeek.id) }}
                >
                  {t('papers.deleteComment')}
                </button>
              )}
              {notePeek.comment === '' ? (
                <button
                  type="button"
                  className={css.paperReaderNotePeekAction}
                  data-danger
                  onClick={() => { removeHighlight(notePeek.id) }}
                >
                  {t('papers.removeHighlight')}
                </button>
              ) : notePeek.hidden ? (
                <button
                  type="button"
                  className={css.paperReaderNotePeekAction}
                  onClick={() => { setHighlightHidden(notePeek.id, false) }}
                >
                  {t('papers.restoreHighlight')}
                </button>
              ) : (
                <button
                  type="button"
                  className={css.paperReaderNotePeekAction}
                  onClick={() => { setHighlightHidden(notePeek.id, true) }}
                >
                  {t('papers.removeHighlight')}
                </button>
              )}
            </div>
          </div>
        </div>
      ), document.body)}

      {error !== '' ? (
        <p className={css.failure} role="alert">{error}</p>
      ) : (
        <div className={css.paperReaderStage} ref={stageRef} onScroll={handleContinuousScroll}>
          {loading && <p className={css.hint}>{t('papers.pdfLoading')}</p>}
          {showTranslated && translatedPage !== '' && (
            <div className={css.paperReaderTranslatedPage}>
              <div className={css.paperReaderTranslatedHead}>
                <span>{t('papers.translatedPageTitle')}</span>
                <button
                  type="button"
                  className={css.paperReaderTranslatedToggle}
                  onClick={() => { setShowTranslated(false) }}
                >
                  {t('papers.showOriginal')}
                </button>
              </div>
              <div className={css.paperReaderTranslatedBody}>{translatedPage}</div>
            </div>
          )}
          {translatePageError !== '' && showTranslated && (
            <p className={css.failure} role="alert">{translatePageError}</p>
          )}
          {dualError !== '' && (
            <p className={css.failure} role="alert">{t('papers.dualFailed')}：{dualError}</p>
          )}
          {dualCancelled && (
            <p className={css.hint} role="status">{t('papers.translationCancelled')}</p>
          )}
          <div className={css.paperReaderContinuous}>
            {docRef.current && Array.from({ length: pageCount }, (_, index) => index + 1).map(pageNumber => {
              const active = pageNumber === page
              return (
                <ContinuousPdfPage
                  key={pageNumber}
                  doc={docRef.current}
                  pageNumber={pageNumber}
                  zoom={zoom}
                  active={active}
                  activeSize={pageSize}
                  estimatedSize={pageSize}
                  onActivate={activateContinuousPage}
                  onRegister={registerContinuousPage}
                  onText={cacheContinuousText}
                  cropMode={cropMode}
                  onMouseDown={(event) => {
                    selectingRef.current = event.button === 0
                    if (cropMode) { startCrop(event); return }
                    /*
                     * 点在选区工具条上时不能清选区：批注输入框、翻译、学习按钮都在
                     * 这条工具条里，事件会冒泡到页面，之前一律 setPending(null)，
                     * 等于「点批注」先把工具条自己卸载掉。
                     */
                    const target = event.target as HTMLElement | null
                    if (target?.closest('[data-selection-bar]')) return
                    if (event.button === 0) {
                      copyTextRef.current = ''
                      setPending(null)
                    }
                  }}
                  onMouseMove={(event) => {
                    if (cropMode) { moveCrop(event); return }
                    if (selectingRef.current && (event.buttons & 1) === 1) previewSelection()
                  }}
                  onMouseUp={(event) => {
                    selectingRef.current = false
                    if (cropMode) { endCrop(event); return }
                    if (selectionFrameRef.current !== null) {
                      window.cancelAnimationFrame(selectionFrameRef.current)
                      selectionFrameRef.current = null
                    }
                    const target = event.target as HTMLElement | null
                    if (target && target.closest('[data-selection-bar]')) return
                    captureSelection()
                  }}
                >
                  {active ? (
                    <>
            <canvas ref={canvasRef} className={css.paperReaderCanvas} />
            {/* 透明文本层：让页面文字可选，划词才能算坐标 */}
            <div className={css.paperReaderTextLayer} ref={textLayerRef} />

            {paintedHighlights.map((highlight) => {
              const boxes = highlight.highlightHidden ? [] : highlight.rects.map((rect, index) => (
                <span
                  key={`${highlight.id}-${index}`}
                  className={css.paperReaderHighlight}
                  style={{
                    left: `${rect.x * 100}%`,
                    top: `${rect.y * 100}%`,
                    width: `${rect.w * 100}%`,
                    height: `${rect.h * 100}%`,
                    background: highlight.color,
                  }}
                  title={highlight.comment !== undefined && highlight.comment !== ''
                    ? highlight.comment.slice(0, 80)
                    : highlight.quote.slice(0, 60)}
                  onClick={(event) => { openNotePeek(highlight, event) }}
                />
              ))
              const first = highlight.rects[0]
              if (first === undefined) return boxes
              if (highlight.comment === undefined || highlight.comment === '') {
                // 纯色高亮：文字层比色块层级高，直接点色块收不到事件，
                // 所以在右侧提供可见的「×」，点击即可删除。
                return [
                  ...boxes,
                  <button
                    key={`${highlight.id}-options`}
                    type="button"
                    className={css.paperReaderToneMenu}
                    style={{ left: `${(first.x + first.w) * 100}%`, top: `${first.y * 100}%` }}
                    aria-label={t('papers.highlightOptions')}
                    title={t('papers.highlightOptions')}
                    onClick={(event) => {
                      event.stopPropagation()
                      openNotePeek(highlight, event)
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M15 3l6 6-9 9H6v-6z" />
                      <path d="M13 5l6 6" />
                      <path d="M4 21h16" />
                    </svg>
                  </button>,
                ]
              }
              // 有批注的选区：在文字右侧空白处挂一个小标记，点开看批注。
              return [
                ...boxes,
                <button
                  key={`${highlight.id}-mark`}
                  type="button"
                  className={css.paperReaderNoteMark}
                  style={{
                    left: `${(first.x + first.w) * 100}%`,
                    top: `${first.y * 100}%`,
                  }}
                  aria-label={t('papers.viewComment')}
                  title={highlight.comment.slice(0, 80)}
                  onClick={(event) => {
                    event.stopPropagation()
                    openNotePeek(highlight, event)
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7l-5 3.5V17H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
                    <path d="M8 9h8M8 12.5h5" />
                  </svg>
                </button>,
              ]
            })}

            {searchRects.map((rect, index) => (
              <span
                key={`search-${index}`}
                className={css.paperReaderSearchHit}
                style={{
                  left: `${rect.x * 100}%`,
                  top: `${rect.y * 100}%`,
                  width: `${rect.w * 100}%`,
                  height: `${rect.h * 100}%`,
                }}
              />
            ))}

            <canvas
              ref={inkCanvasRef}
              className={css.paperReaderInk}
              data-active={inkMode || undefined}
              onPointerDown={inkPointerDown}
              onPointerMove={inkPointerMove}
              onPointerUp={inkPointerUp}
              onPointerLeave={inkPointerUp}
              onPointerCancel={inkPointerUp}
            />

            {pending !== null && pending.page === pageNumber && pending.rects.map((rect, index) => (
              <span
                key={`pending-${index}`}
                className={css.paperReaderPending}
                style={{
                  left: `${rect.x * 100}%`,
                  top: `${rect.y * 100}%`,
                  width: `${rect.w * 100}%`,
                  height: `${rect.h * 100}%`,
                }}
              />
            ))}

            {cropRect !== null && (
              <>
                <span
                  className={css.paperReaderCropBox}
                  style={{
                    left: `${cropRect.x * 100}%`,
                    top: `${cropRect.y * 100}%`,
                    width: `${cropRect.w * 100}%`,
                    height: `${cropRect.h * 100}%`,
                  }}
                />
                <div
                  className={css.paperReaderSelectionBar}
                  data-selection-bar
                  style={{
                    left: `${Math.min(Math.max(cropRect.x, 0), 0.6) * 100}%`,
                    top: `${Math.max(cropRect.y * 100 - 1, 0)}%`,
                  }}
                >
                  <button
                    type="button"
                    className={css.paperReaderSelectionAction}
                    disabled={askRunning}
                    onClick={askRegion}
                  >
                    {askRunning ? t('papers.skillRunning') : t('papers.cropAsk')}
                  </button>
                  <button
                    type="button"
                    className={css.paperReaderSelectionCancel}
                    aria-label={t('papers.cancel')}
                    onClick={() => { setCropRect(null) }}
                  >
                    ×
                  </button>
                </div>
              </>
            )}

            {pending && pending.page === pageNumber && (
              <div
                className={css.paperReaderSelectionBar}
                data-selection-bar
                style={{
                  // 靠右时留出工具条自身的宽度，否则会被挤成竖排
                  left: '50%',
                  top: `${Math.max(pending.rects[0].y * 100 - 2, 0)}%`,
                }}
              >
                {commentOpen ? (
                  <>
                    <div className={css.paperReaderCommentColors} role="group" aria-label={t('papers.highlight')}>
                      {HIGHLIGHT_COLORS.map(color => (
                        <button
                          key={color}
                          type="button"
                          className={css.paperReaderCommentSwatch}
                          style={{ background: color }}
                          data-active={commentColor === color || undefined}
                          aria-label={t('papers.highlight')}
                          aria-pressed={commentColor === color}
                          disabled={savingHighlight}
                          onMouseDown={(event) => { event.preventDefault() }}
                          onClick={() => { setCommentColor(color) }}
                        />
                      ))}
                    </div>
                    <input
                      className={css.paperReaderCommentInput}
                      value={commentDraft}
                      placeholder={t('papers.commentPlaceholder')}
                      disabled={savingHighlight}
                      autoFocus
                      onChange={(event) => { setCommentDraft(event.target.value) }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          saveHighlight(commentColor, commentDraft)
                        }
                      }}
                    />
                    <button
                      type="button"
                      className={css.paperReaderSelectionAction}
                      disabled={savingHighlight}
                      onMouseDown={(event) => { event.preventDefault() }}
                      onClick={() => { saveHighlight(commentColor, commentDraft) }}
                    >
                      {savingHighlight ? t('papers.highlightSaving') : t('papers.commentSave')}
                    </button>
                  </>
                ) : (
                  <>
                    {/* 一排色点，点哪个就用哪个颜色存下这条高亮。 */}
                    {HIGHLIGHT_COLORS.map(color => (
                      <button
                        key={color}
                        type="button"
                        className={css.paperHighlightSwatch}
                        style={{ background: color }}
                        title={t('papers.highlight')}
                        aria-label={t('papers.highlight')}
                        disabled={savingHighlight}
                        // mousedown + preventDefault：不让浏览器清掉选区
                        onMouseDown={(event) => {
                          event.preventDefault()
                          saveHighlight(color)
                        }}
                      />
                    ))}
                    <span className={css.paperHighlightDivider} aria-hidden="true" />
                    <button
                      type="button"
                      className={css.paperReaderSelectionAction}
                      disabled={translating}
                      onMouseDown={(event) => { event.preventDefault() }}
                      onClick={() => { void translateSelection() }}
                    >
                      {translating ? t('papers.translating') : t('papers.translate')}
                    </button>
                    <button
                      type="button"
                      className={css.paperReaderSelectionAction}
                      disabled={savingHighlight}
                      onMouseDown={(event) => {
                        event.preventDefault()
                        commentOpenRef.current = true
                        setCommentColor(HIGHLIGHT_FALLBACK)
                        setCommentOpen(true)
                      }}
                    >
                      {t('papers.comment')}
                    </button>
                    <button
                      type="button"
                      className={css.paperReaderSelectionAction}
                      data-primary
                      onMouseDown={(event) => { event.preventDefault() }}
                      onClick={() => { onStudy?.() }}
                    >
                      {t('papers.study')}
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className={css.paperReaderSelectionCancel}
                  aria-label={t('papers.cancel')}
                  onMouseDown={(event) => { event.preventDefault() }}
                  onClick={() => {
                    setPending(null)
                    setCommentOpen(false)
                    setCommentDraft('')
                    window.getSelection()?.removeAllRanges()
                  }}
                >
                  ×
                </button>
              </div>
            )}

                    </>
                  ) : (
                    highlightVisible && highlights.filter(item => item.page === pageNumber).map((highlight) => {
                      const boxes = highlight.highlightHidden ? [] : highlight.rects.map((rect, index) => (
                        <span
                          key={`${highlight.id}-${index}`}
                          className={css.paperReaderHighlight}
                          style={{
                            left: `${rect.x * 100}%`,
                            top: `${rect.y * 100}%`,
                            width: `${rect.w * 100}%`,
                            height: `${rect.h * 100}%`,
                            background: highlight.color,
                          }}
                          title={highlight.comment ? highlight.comment.slice(0, 80) : highlight.quote.slice(0, 60)}
                          onClick={(event) => { openNotePeek(highlight, event) }}
                        />
                      ))
                      const first = highlight.rects[0]
                      if (!first) return boxes
                      if (!highlight.comment) {
                        return [
                          ...boxes,
                          <button
                            key={`${highlight.id}-options`}
                            type="button"
                            className={css.paperReaderToneMenu}
                            style={{ left: `${(first.x + first.w) * 100}%`, top: `${first.y * 100}%` }}
                            aria-label={t('papers.highlightOptions')}
                            title={t('papers.highlightOptions')}
                            onClick={(event) => {
                              event.stopPropagation()
                              openNotePeek(highlight, event)
                            }}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M15 3l6 6-9 9H6v-6z" />
                              <path d="M13 5l6 6" />
                              <path d="M4 21h16" />
                            </svg>
                          </button>,
                        ]
                      }
                      // 连续阅读的非激活页同样要有「笔记」入口；之前只渲染色块，无法点击查看。
                      return [
                        ...boxes,
                        <button
                          key={`${highlight.id}-mark`}
                          type="button"
                          className={css.paperReaderNoteMark}
                          style={{ left: `${(first.x + first.w) * 100}%`, top: `${first.y * 100}%` }}
                          aria-label={t('papers.viewComment')}
                          title={highlight.comment.slice(0, 80)}
                          onClick={(event) => {
                            event.stopPropagation()
                            openNotePeek(highlight, event)
                          }}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7l-5 3.5V17H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
                            <path d="M8 9h8M8 12.5h5" />
                          </svg>
                        </button>,
                      ]
                    })
                  )}
                </ContinuousPdfPage>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function PaperPdfSection({ paper, fetchPaperPdf, updatePaper, requestProjectSession, requestProjectImage, prepareSession, sessionTitle, projectSession, onError, onUploaded, onNotesChanged, jumpRequest, openOnMount, onClose, t }: {
  readonly paper: PaperRecord
  readonly fetchPaperPdf: (arxivId: string) => Promise<ResearchFailureView | null>
  readonly updatePaper: (arxivId: string, patch: PaperPatch) => Promise<ResearchFailureView | null>
  /** Reader questions are delivered to the currently selected project session. */
  readonly requestProjectSession: (prompt: string) => Promise<{ readonly ok: boolean; readonly error?: string }>
  /** 框选图片作为附件投递到当前会话。 */
  readonly requestProjectImage?: (image: string, prompt: string) => Promise<{ readonly ok: boolean; readonly error?: string }>
  readonly sessionTitle: string
  readonly projectSession: ProjectSessionSnapshotView
  /** 打开右侧会话前加载当前会话与历史消息。 */
  readonly prepareSession?: () => Promise<void>
  readonly onError: (message: string) => void
  /** The list is owned by the parent; after an upload it must re-read the store. */
  readonly onUploaded?: () => void
  /** A highlight was saved in the reader; the notes panel should re-read. */
  readonly onNotesChanged?: () => void
  /** Set by a citation click: open the reader on this page. */
  readonly jumpRequest?: { page: number } | undefined
  /** Library cards mount this component only to open the reader. */
  readonly openOnMount?: boolean | undefined
  /** Closing the overlay also returns the library card to its idle state. */
  readonly onClose?: (() => void) | undefined
  readonly t: ResearchT
}) {
  const [fetching, setFetching] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [readerPage, setReaderPage] = useState(1)
  const closeReader = (): void => {
    setFullscreen(false)
    onClose?.()
  }
  const [version, setVersion] = useState(() => Date.now())
  // 阅读器里存了高亮后，右侧笔记块要重读一次。
  const [localNotesVersion, setLocalNotesVersion] = useState(0)
  // 当前选区：右侧栏显示成可发问的引用块。
  const [selection, setSelection] = useState<{ text: string; page: number } | null>(null)
  // 右侧只保留完整单聊；默认收起，选中「AI 会话」或点左侧入口后展开。
  const [chatOpen, setChatOpen] = useState(false)
  const openChat = (): void => { setChatOpen(true) }

  // A citation asked to see a page: open the reader there.
  useEffect(() => {
    if (jumpRequest === undefined) return
    setReaderPage(jumpRequest.page)
    setFullscreen(true)
  }, [jumpRequest])

  // Esc has to close the overlay even while focus sits inside the PDF frame:
  // a window-level capture listener is the only place that still sees the key.
  useEffect(() => {
    if (!fullscreen) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      event.preventDefault()
      closeReader()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => { window.removeEventListener('keydown', onKeyDown, true) }
  }, [fullscreen])

  const fetchPdf = (): void => {
    if (fetching) return
    setFetching(true)
    void fetchPaperPdf(paperKey(paper))
      .then((failure) => {
        if (failure === null) {
          setVersion(Date.now())
          onUploaded?.()
          setFullscreen(true)
        } else {
          onError(`${t('papers.fetchPdfFailed')}：${failure.message}`)
          onClose?.()
        }
      })
      .finally(() => { setFetching(false) })
  }

  // 卡片是阅读器入口：已有 PDF 直接打开，没有则走原抓取流程后打开。
  useEffect(() => {
    if (!openOnMount) return
    if (paper.pdfPath !== undefined) setFullscreen(true)
    else fetchPdf()
  }, [])

  const pickFile = (event: { target: HTMLInputElement }): void => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || uploading) return
    setUploading(true)
    void uploadPaperPdfFile(paper, file)
      .then((result) => {
        onUploaded?.()
        setVersion(Date.now())
        // A scanned PDF keeps the upload but has no text layer: say so instead
        // of leaving the AI buttons mysteriously disabled.
        if (result.fulltextError !== '') {
          onError(`${t('papers.uploadPdfNoText')}：${result.fulltextError}`)
        }
      })
      .catch((error: Error) => { onError(`${t('papers.uploadPdfFailed')}：${error.message}`) })
      .finally(() => { setUploading(false) })
  }

  return (
    <div className={css.paperPdf}>
      {fullscreen && createPortal(
        <div
          className={css.paperPdfOverlay}
          role="dialog"
          aria-label={`${t('papers.readPdf')}：${paper.title}`}
          tabIndex={-1}
          // Focus the overlay on open so Esc reaches it; Esc closes only the
          // overlay (stopPropagation keeps the panel's Esc-to-close).
          ref={(element) => { element?.focus() }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.stopPropagation()
            event.preventDefault()
            closeReader()
          }}
        >
          {/* The exit sits LEFT of the title on purpose: the desktop shell puts
              its drag strip and (on Windows) the window buttons over the
              top-right corner, and those swallow every click that lands there. */}
          {/* 区域 1：文档标签栏，40px。左侧是文档标签，右侧是全局图标。 */}
          <div className={css.paperReaderTabBar}>
            <div className={css.paperReaderTabs}>
              <div className={css.paperReaderTab} data-active>
                <span className={css.paperReaderTabTitle} title={paper.title}>{paper.title}</span>
                <button
                  type="button"
                  className={css.paperReaderTabClose}
                  aria-label={t('panel.close')}
                  title={t('panel.close')}
                  // pointerdown 一并处理：面板每次 live-refresh 都会重渲染，
                  // 只挂 click 会被中间那次渲染吞掉。
                  onPointerDown={(event) => { event.preventDefault(); closeReader() }}
                  onClick={() => { closeReader() }}
                >
                  ×
                </button>
              </div>
            </div>
          </div>
          <div className={css.paperPdfOverlayBody}>
            <PaperPdfReader
              paper={paper}
              url={paperPdfUrl(paperKey(paper), version)}
              page={readerPage}
              onPageChange={setReaderPage}
              onNotesChanged={() => {
                setLocalNotesVersion((value) => value + 1)
                onNotesChanged?.()
              }}
              onSelectionChange={(next) => {
                // 只保留选区作为提问引用，不自动展开面板，也不自动发问。
                setSelection(next)
              }}
              onStudy={openChat}
              onOpenChat={() => {
                if (chatOpen) setChatOpen(false)
                else openChat()
              }}
              chatOpen={chatOpen}
              requestProjectImage={requestProjectImage}
              t={t}
            />
            {chatOpen && (
              <div className={css.paperReaderSide}>
                <section className={css.paperReaderPane}>
                  <div className={css.paperReaderPaneHead}>
                    <button
                      type="button"
                      className={css.paperReaderPaneTitle}
                      aria-expanded="true"
                      onClick={() => { setChatOpen(false) }}
                    >
                      {t('papers.sideChat')}
                    </button>
                    <span className={css.paperReaderSessionLabel} title={sessionTitle}>
                      {sessionTitle || t('papers.openSessionHint')}
                    </span>
                    <button
                      type="button"
                      className={css.paperReaderPaneClose}
                      aria-label={t('panel.close')}
                      title={t('panel.close')}
                      onClick={() => { setChatOpen(false) }}
                    >
                      ×
                    </button>
                  </div>
                  <div className={css.paperReaderPaneBody} data-chat-host>
                    <div className={css.paperReaderChat}>
                      <VueChatIsland
                        paperTitle={paper.title}
                        selection={selection}
                        prepareSession={prepareSession}
                      />
                    </div>
                  </div>
                </section>
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

/**
 * The reading-notes side panel next to the open PDF reader: the record's
 * entries (parsed out of `notes`, legacy/agent-written blocks included) as
 * a list, then a quick-add box appending a new `[YYYY-MM-DD HH:mm]` entry
 * through the existing `updatePaper` verb. The entry list re-derives from
 * the refreshed record after every save.
 */
/** 精读模板：空笔记时一键插入，给「不知道记什么」一个起点。 */
const READING_NOTE_TEMPLATE = [
  '【精读模板】',
  '- 研究问题：',
  '- 方法 / 数据：',
  '- 关键结论：',
  '- 与我的课题的关系：',
  '- 待查证 / 疑问：',
].join('\n')

function PaperNotesPanel({ paper, updatePaper, onError, t }: {
  readonly paper: PaperRecord
  readonly updatePaper: (arxivId: string, patch: PaperPatch) => Promise<ResearchFailureView | null>
  readonly onError: (message: string) => void
  readonly t: ResearchT
}) {
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const entries = parseReadingNotes(paper.notes)

  /**
   * 空状态引导：插一段精读模板。
   * 参考项目用「插入精读模板」解决「不知道记什么」的冷启动问题，
   * 比只留一句「还没有笔记」更容易让人开始。
   */
  const insertTemplate = (): void => {
    if (saving) return
    setSaving(true)
    void updatePaper(paper.arxivId, {
      notes: appendReadingNote(paper.notes, READING_NOTE_TEMPLATE, new Date()),
    })
      .then((failure) => {
        if (failure !== null) onError(`${t('papers.addNoteFailed')}：${failure.message}`)
      })
      .finally(() => { setSaving(false) })
  }

  const addNote = (): void => {
    if (saving || draft.trim() === '') return
    setSaving(true)
    void updatePaper(paper.arxivId, { notes: appendReadingNote(paper.notes, draft, new Date()) })
      .then((failure) => {
        if (failure === null) {
          setDraft('')
        } else {
          onError(`${t('papers.addNoteFailed')}：${failure.message}`)
        }
      })
      .finally(() => { setSaving(false) })
  }

  return (
    <aside className={css.paperNotesPanel}>
      <h4 className={css.paperNotesTitle}>{t('papers.readingNotes')}</h4>
      {entries.length === 0 ? (
        <div className={css.paperNotesEmpty}>
          <p className={css.hint}>{t('papers.readingNotesEmpty')}</p>
          <button
            type="button"
            className={css.btn}
            disabled={saving}
            onClick={insertTemplate}
          >
            {t('papers.insertTemplate')}
          </button>
        </div>
      ) : (
        <div className={css.paperNoteList}>
          {entries.map((entry, index) => (
            <div key={`${entry.at}-${index}`} className={css.paperNoteItem}>
              {entry.at !== '' && <span className={css.paperNoteAt}>{entry.at}</span>}
              <p className={css.paperNoteText}>{entry.text}</p>
            </div>
          ))}
        </div>
      )}
      <textarea
        className={css.input}
        rows={3}
        value={draft}
        placeholder={t('papers.noteInputPlaceholder')}
        onChange={event => { setDraft(event.target.value) }}
      />
      <button
        type="button"
        className={css.btnPrimary}
        disabled={saving || draft.trim() === ''}
        onClick={addNote}
      >
        {saving ? t('papers.addingNote') : t('papers.addNote')}
      </button>
    </aside>
  )
}

/**
 * One card's "add to bibliography" button: appends the paper to the selected
 * project's `references.bib` and shows the settled outcome briefly. Disabled
 * until a project is selected.
 */
function AddToBibButton({ paper, projectId, importPapersToBib, onError, t }: {
  readonly paper: PaperRecord
  readonly projectId: string | null
  readonly importPapersToBib: (
    projectId: string,
    arxivIds: string[],
  ) => Promise<ResearchFailureView | ResearchImportCounts>
  readonly onError: (message: string) => void
  readonly t: ResearchT
}) {
  const [state, setState] = useState<AddToBibState>('idle')
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const aliveRef = useRef(true)

  // Cancel a pending feedback reset on unmount.
  useEffect(() => () => {
    aliveRef.current = false
    if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current)
  }, [])

  const add = (): void => {
    if (projectId === null || state === 'adding') return
    setState('adding')
    void importPapersToBib(projectId, [paper.arxivId]).then((outcome) => {
      if (!aliveRef.current) return
      if ('code' in outcome) {
        setState('idle')
        onError(`${t('papers.addToBibFailed')}：${outcome.message}`)
        return
      }
      setState(outcome.added.length > 0 ? 'added' : 'exists')
      resetTimerRef.current = setTimeout(() => { setState('idle') }, ADD_TO_BIB_RESET_MS)
    })
  }

  const copy = state === 'adding'
    ? t('papers.addingToBib')
    : state === 'added'
      ? t('papers.addedToBib')
      : state === 'exists'
        ? t('papers.alreadyInBib')
        : t('papers.addToBib')
  return (
    <button
      type="button"
      className={css.btn}
      disabled={projectId === null || state === 'adding'}
      title={projectId === null ? t('bib.noProject') : undefined}
      onClick={add}
    >
      {copy}
    </button>
  )
}

/**
 * The web search panel (SearXNG results through the sxng CLI): one card per
 * result with the title link, engine/category/date meta, and the snippet.
 * A result whose URL points at an arXiv abstract or PDF gains an import
 * button — the bridge from a generic web hit into the wiki library.
 * @param props - the web search slice, the imported-id set, the in-flight
 * import id, the import verb, the retry verb, and copy.
 */
/** Collapsible editor for sxng-cli's global configuration. */
function SxngConfigPanel({ config, getConfig, saveConfig, t }: {
  readonly config: ResearchSxngConfigView
  readonly getConfig: () => void
  readonly saveConfig: (input: {
    baseUrl?: string; defaultEngine?: string; allowedEngines?: readonly string[]; defaultLimit?: number
    defaultFormat?: 'md' | 'json'; useProxy?: boolean; proxyUrl?: string; timeout?: number
    ollamaApiKey?: string; redundancyThreshold?: number; redundancyBigramThreshold?: number
  }) => Promise<ResearchFailureView | null>
  readonly t: ResearchT
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Partial<{
    baseUrl: string; defaultEngine: string; allowedEngines: string; defaultLimit: string; defaultFormat: 'md' | 'json'
    useProxy: boolean; proxyUrl: string; timeout: string; ollamaApiKey: string; redundancyThreshold: string; redundancyBigramThreshold: string
  }>>({})
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<ResearchFailureView | null>(null)
  useEffect(() => { getConfig() }, [getConfig])
  const toggle = (): void => {
    if (!open) setDraft({ baseUrl: config.baseUrl, defaultEngine: config.defaultEngine, allowedEngines: config.allowedEngines.join(', '), defaultLimit: String(config.defaultLimit), defaultFormat: config.defaultFormat, useProxy: config.useProxy, proxyUrl: config.proxyUrl, timeout: String(config.timeout), ollamaApiKey: '', redundancyThreshold: String(config.redundancyThreshold), redundancyBigramThreshold: String(config.redundancyBigramThreshold) })
    setFailure(null); setOpen(value => !value)
  }
  const save = (): void => {
    if (saving) return
    setSaving(true); setFailure(null)
    void saveConfig({
      ...(draft.baseUrl?.trim() === '' || draft.baseUrl === undefined ? {} : { baseUrl: draft.baseUrl.trim() }),
      ...(draft.defaultEngine === undefined ? {} : { defaultEngine: draft.defaultEngine }),
      ...(draft.allowedEngines === undefined ? {} : { allowedEngines: draft.allowedEngines.split(',').map(value => value.trim()).filter(Boolean) }),
      ...(draft.defaultLimit === undefined ? {} : { defaultLimit: Number(draft.defaultLimit) }),
      ...(draft.defaultFormat === undefined ? {} : { defaultFormat: draft.defaultFormat }),
      ...(draft.useProxy === undefined ? {} : { useProxy: draft.useProxy }),
      ...(draft.proxyUrl === undefined ? {} : { proxyUrl: draft.proxyUrl }),
      ...(draft.timeout === undefined ? {} : { timeout: Number(draft.timeout) }),
      ...(draft.ollamaApiKey === undefined || draft.ollamaApiKey === '' ? {} : { ollamaApiKey: draft.ollamaApiKey }),
      ...(draft.redundancyThreshold === undefined ? {} : { redundancyThreshold: Number(draft.redundancyThreshold) }),
      ...(draft.redundancyBigramThreshold === undefined ? {} : { redundancyBigramThreshold: Number(draft.redundancyBigramThreshold) }),
    }).then(result => { if (result !== null) setFailure(result); else setOpen(false) }).finally(() => { setSaving(false) })
  }
  return <section className={css.imageGenPanel}>
    <button type="button" className={css.imageGenToggle} aria-expanded={open} onClick={toggle}><span aria-hidden>{open ? '▾' : '▸'}</span>{t('papers.sxngConfig')}{config.configured && <span className={css.imageGenBadge}>{t('papers.sxngConfigured')}</span>}</button>
    {open && <div className={css.meetingFormRow}>
      <input className={css.input} value={draft.baseUrl ?? ''} placeholder="baseUrl" aria-label="baseUrl" onChange={e => setDraft({ ...draft, baseUrl: e.target.value })} />
      <input className={css.input} value={draft.defaultEngine ?? ''} placeholder="defaultEngine" aria-label="defaultEngine" onChange={e => setDraft({ ...draft, defaultEngine: e.target.value })} />
      <input className={css.input} value={draft.allowedEngines ?? ''} placeholder="allowedEngines (comma separated)" aria-label="allowedEngines" onChange={e => setDraft({ ...draft, allowedEngines: e.target.value })} />
      <input className={css.input} type="number" value={draft.defaultLimit ?? ''} placeholder="defaultLimit" aria-label="defaultLimit" onChange={e => setDraft({ ...draft, defaultLimit: e.target.value })} />
      <select className={css.input} value={draft.defaultFormat ?? 'md'} aria-label="defaultFormat" onChange={e => setDraft({ ...draft, defaultFormat: e.target.value as 'md' | 'json' })}><option value="md">md</option><option value="json">json</option></select>
      <label><input type="checkbox" checked={draft.useProxy ?? false} onChange={e => setDraft({ ...draft, useProxy: e.target.checked })} /> useProxy</label>
      <input className={css.input} value={draft.proxyUrl ?? ''} placeholder="proxyUrl" aria-label="proxyUrl" onChange={e => setDraft({ ...draft, proxyUrl: e.target.value })} />
      <input className={css.input} type="number" value={draft.timeout ?? ''} placeholder="timeout (ms)" aria-label="timeout" onChange={e => setDraft({ ...draft, timeout: e.target.value })} />
      <input className={css.input} type="password" value={draft.ollamaApiKey ?? ''} placeholder={config.ollamaApiKeyPreview || 'ollamaApiKey'} aria-label="ollamaApiKey" onChange={e => setDraft({ ...draft, ollamaApiKey: e.target.value })} />
      <input className={css.input} type="number" step="0.01" value={draft.redundancyThreshold ?? ''} placeholder="redundancyThreshold" aria-label="redundancyThreshold" onChange={e => setDraft({ ...draft, redundancyThreshold: e.target.value })} />
      <input className={css.input} type="number" step="0.01" value={draft.redundancyBigramThreshold ?? ''} placeholder="redundancyBigramThreshold" aria-label="redundancyBigramThreshold" onChange={e => setDraft({ ...draft, redundancyBigramThreshold: e.target.value })} />
      <button type="button" className={css.btnPrimary} disabled={saving} onClick={save}>{saving ? t('papers.sxngSaving') : t('papers.sxngSave')}</button>
      {failure !== null && <p className={css.failure} role="alert">{failure.message}</p>}
    </div>}
  </section>
}

/** PubMed hits: the medical counterpart of the arXiv result list. */
function PubmedResultsPanel({ pubmedSearch, importedIds, importing, importEntry, t }: {
  readonly pubmedSearch: {
    status: 'idle' | 'loading' | 'ready' | 'error'
    query: string
    entries: readonly PubmedEntryView[]
    error: string
  }
  readonly importedIds: ReadonlySet<string>
  readonly importing: string | null
  readonly importEntry: (entry: PubmedEntryView) => void
  readonly t: ResearchT
}) {
  if (pubmedSearch.status === 'idle') return null
  return (
    <section className={css.papersSearchPanel}>
      <h3 className={css.sectionTitle}>
        {t('papers.pubmedResults')}：{pubmedSearch.query}
      </h3>
      {pubmedSearch.status === 'loading' ? (
        <p className={css.hint}>{t('papers.searching')}</p>
      ) : pubmedSearch.status === 'error' ? (
        <p className={css.failure} role="alert">{pubmedSearch.error}</p>
      ) : pubmedSearch.entries.length === 0 ? (
        <p className={css.hint}>{t('papers.searchEmpty')}</p>
      ) : (
        <div className={css.papersResults}>
          {pubmedSearch.entries.map(entry => (
            <article key={entry.pmid} className={css.paperResult}>
              <div className={css.paperResultHead}>
                <h3 className={css.paperCardTitle}>
                  <a href={entry.url} target="_blank" rel="noreferrer">{entry.title}</a>
                </h3>
                <span className={css.pubmedBadge}>PMID {entry.pmid}</span>
              </div>
              <p className={css.pubmedMeta}>
                {[entry.authors, entry.venue, entry.year].filter(Boolean).join(' · ')}
              </p>
              {entry.abstract !== '' && (
                <p className={css.pubmedAbstract}>{entry.abstract}</p>
              )}
              <div className={css.pubmedActions}>
                {importedIds.has(entry.pmid) ? (
                  <span className={css.hint}>{t('papers.imported')}</span>
                ) : (
                  <button
                    type="button"
                    className={css.btn}
                    disabled={importing !== null}
                    onClick={() => { importEntry(entry) }}
                  >
                    {importing === entry.pmid ? t('papers.importing') : t('papers.import')}
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

function WebSearchPanel({
  webSearch, importedIds, importing, importEntry, searchWeb, t,
}: {
  readonly webSearch: ResearchWebSearchView | null
  readonly importedIds: ReadonlySet<string>
  readonly importing: string | null
  readonly importEntry: (entry: ArxivEntry) => void
  readonly searchWeb: (query: string) => void
  readonly t: ResearchT
}) {
  if (webSearch === null) return null
  return (
    <section className={css.papersSearchPanel}>
      <h3 className={css.sectionTitle}>
        {t('papers.webSearchResults')}：{webSearch.query}
      </h3>
      {webSearch.status === 'loading' ? (
        <p className={css.hint}>{t('papers.searching')}</p>
      ) : webSearch.status === 'error' ? (
        <p className={css.failure} role="alert">
          {t('error.webSearch')}：{failureCopy(t, webSearch.failure)}
          <button type="button" className={css.btn} onClick={() => { searchWeb(webSearch.query) }}>
            {t('error.retry')}
          </button>
        </p>
      ) : webSearch.list.length === 0 ? (
        <p className={css.hint}>{t('papers.webSearchEmpty')}</p>
      ) : (
        <div className={css.papersResults}>
          {webSearch.list.map(entry => (
            <WebResultCard
              key={entry.url}
              entry={entry}
              imported={importedIds.has(arxivIdFromUrl(entry.url) ?? '')}
              importing={importing === arxivIdFromUrl(entry.url)}
              importEntry={importEntry}
              t={t}
            />
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * One web result card. When the URL names an arXiv paper not yet in the
 * library, an import button builds an {@link ArxivEntry} from the row and
 * hands it to the shared import flow.
 */
function WebResultCard({ entry, imported, importing, importEntry, t }: {
  readonly entry: WebSearchEntry
  readonly imported: boolean
  readonly importing: boolean
  readonly importEntry: (entry: ArxivEntry) => void
  readonly t: ResearchT
}) {
  const arxivId = arxivIdFromUrl(entry.url)
  return (
    <article key={entry.url} className={css.paperResult}>
      <div className={css.paperResultHead}>
        <h3 className={css.paperCardTitle}>
          <a href={entry.url} target="_blank" rel="noreferrer">
            {entry.title === '' ? entry.url : entry.title}
          </a>
        </h3>
        {arxivId !== null && (
          imported ? (
            <button type="button" className={css.btn} disabled>{t('papers.imported')}</button>
          ) : (
            <button
              type="button"
              className={css.btnPrimary}
              disabled={importing}
              onClick={() => {
                importEntry({
                  id: arxivId,
                  title: entry.title,
                  authors: [],
                  summary: entry.content,
                  published: entry.publishedDate,
                  url: `https://arxiv.org/abs/${arxivId}`,
                })
              }}
            >
              {importing ? t('papers.importing') : t('papers.import')}
            </button>
          )
        )}
      </div>
      <p className={css.paperCardMeta}>
        {`${t('papers.engine')}：${entry.engine === '' ? '—' : entry.engine}`}
        {entry.category !== '' && ` · ${entry.category}`}
        {entry.publishedDate !== '' && ` · ${entry.publishedDate.slice(0, 10)}`}
      </p>
      {entry.content !== '' && <p className={css.paperSummary} data-static>{entry.content}</p>}
    </article>
  )
}

/**
 * @param props - the literature view, the arXiv search slice, the project
 * list (for link checkboxes and badges), the selected project (the
 * current-project filter), the load/search/import/update/remove verbs, and
 * copy.
 * @returns the search bar and results over the filterable library grid.
 */
export function PapersView({
  papers, arxivSearch, webSearch, sxngConfig, arxivSubscriptions, projects, selectedProjectId, ensurePapers, refreshPapers, searchArxiv, searchWeb,
  getSxngConfig, saveSxngConfig,
  saveArxivSubscription, deleteArxivSubscription, checkArxivSubscriptions,
  importPaper, updatePaper, removePaper, importPapersToBib, fetchPaperPdf, requestProjectSession, requestProjectImage,
  zotero, zoteroSearch, recheckZotero, searchZotero, importZoteroItem, exportZoteroCollectionToBib,
  requestRelatedWork, openSession, prepareSession, sessionTitle, projectSession, t,
}: {
  readonly papers: ResearchPapersView
  readonly arxivSearch: ResearchArxivSearchView | null
  readonly webSearch: ResearchWebSearchView | null
  readonly sxngConfig: ResearchSxngConfigView
  readonly arxivSubscriptions: ResearchSubscriptionsView
  readonly projects: readonly ResearchProjectView[]
  readonly selectedProjectId: string | null
  readonly ensurePapers: () => void
  /** Re-fetch now; resolves once the new list has been published (await it before reporting an import). */
  readonly refreshPapers: () => Promise<void>
  readonly saveArxivSubscription: (query: string) => Promise<ResearchFailureView | null>
  readonly deleteArxivSubscription: (id: string) => Promise<ResearchFailureView | null>
  readonly checkArxivSubscriptions: () => Promise<ResearchFailureView | null>
  readonly searchArxiv: (query: string) => void
  readonly searchWeb: (query: string) => void
  readonly getSxngConfig: () => void
  readonly saveSxngConfig: (input: {
    baseUrl?: string; defaultEngine?: string; allowedEngines?: readonly string[]; defaultLimit?: number
    defaultFormat?: 'md' | 'json'; useProxy?: boolean; proxyUrl?: string; timeout?: number
    ollamaApiKey?: string; redundancyThreshold?: number; redundancyBigramThreshold?: number
  }) => Promise<ResearchFailureView | null>
  readonly importPaper: (entry: ArxivEntry, projectId?: string) => Promise<ResearchFailureView | null>
  readonly updatePaper: (arxivId: string, patch: PaperPatch) => Promise<ResearchFailureView | null>
  readonly removePaper: (arxivId: string) => Promise<ResearchFailureView | null>
  readonly importPapersToBib: (
    projectId: string,
    arxivIds: string[],
  ) => Promise<ResearchFailureView | ResearchImportCounts>
  readonly fetchPaperPdf: (arxivId: string) => Promise<ResearchFailureView | null>
  /** Reader chat goes to the project session currently selected in the host. */
  readonly requestProjectSession: (prompt: string) => Promise<{ readonly ok: boolean; readonly error?: string }>
  /** 框选图片作为附件投递到同一条会话。 */
  readonly requestProjectImage?: (image: string, prompt: string) => Promise<{ readonly ok: boolean; readonly error?: string }>
  readonly sessionTitle: string
  readonly projectSession: ProjectSessionSnapshotView
  /** 跳到聊天页并选中工作台当前会话（阅读器追问后的回跳）。 */
  readonly openSession?: () => void
  /** 打开阅读器右侧会话前，加载当前会话与历史消息。 */
  readonly prepareSession?: () => Promise<void>
  readonly zotero: ResearchZoteroView
  readonly zoteroSearch: ResearchZoteroSearchView | null
  readonly recheckZotero: () => void
  readonly searchZotero: (query: string) => void
  readonly importZoteroItem: (key: string, projectId?: string) => Promise<ResearchFailureView | null>
  readonly exportZoteroCollectionToBib: (
    projectId: string,
    collectionKey: string,
  ) => Promise<ResearchFailureView | ResearchImportCounts>
  readonly requestRelatedWork: (prompt: string) => Promise<void>
  readonly t: ResearchT
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<'arxiv' | 'pubmed' | 'web'>('arxiv')
  const [pubmedSearch, setPubmedSearch] = useState<{
    status: 'idle' | 'loading' | 'ready' | 'error'
    query: string
    entries: readonly PubmedEntryView[]
    error: string
  }>({ status: 'idle', query: '', entries: [], error: '' })
  const [pubmedImported, setPubmedImported] = useState<ReadonlySet<string>>(new Set())
  // A citation click asks one card's reader to open on a page. A fresh object
  // each time, so asking for the same page twice still re-opens the overlay.
  const [readerJump, setReaderJump] = useState<{ key: string; page: number } | null>(null)

  // Research Run evidence rows can ask the library to open a paper at the
  // cited page. The event is used because the runs view and this reader are
  // sibling tabs of the same workbench.
  useEffect(() => {
    const openAtPage = (event: Event): void => {
      const detail = (event as CustomEvent<{ paperId?: string; page?: number }>).detail || {}
      const paperId = String(detail.paperId || '')
      if (paperId === '') return
      const paper = papers.list.find(row => paperKey(row) === paperId)
      if (!paper) return
      const key = paperKey(paper)
      setExpanded(prev => ({ ...prev, [key]: true }))
      setReaderJump({ key, page: Math.max(1, Math.round(Number(detail.page) || 1)) })
    }
    window.addEventListener('mimir:open-paper', openAtPage)
    return () => { window.removeEventListener('mimir:open-paper', openAtPage) }
  }, [papers.list])
  // Bumped when a highlight is saved so the notes panel re-reads the blocks.
  const [notesRefresh, setNotesRefresh] = useState(0)
  const [review, setReview] = useState<{ status: 'idle' | 'loading' | 'ready' | 'error'; text: string; error: string; saved?: boolean }>({
    status: 'idle', text: '', error: '',
  })
  // 知识层：攒下来的结论要能看见，否则「存为知识」等于黑洞。
  const [knowledgeOpen, setKnowledgeOpen] = useState(false)
  const [knowledgeLoading, setKnowledgeLoading] = useState(false)
  const [knowledgeRows, setKnowledgeRows] = useState<readonly KnowledgeRowView[]>([])
  // 「导入 PDF」：一个本地 PDF 直接变成一条文献记录
  const [importingPdf, setImportingPdf] = useState('')
  const [importedPdf, setImportedPdf] = useState<{ title: string; chars: number | null; count: number } | null>(null)
  const [importing, setImporting] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draftTags, setDraftTags] = useState<string[]>([])
  const [draftProjectIds, setDraftProjectIds] = useState<string[]>([])
  const [draftNotes, setDraftNotes] = useState('')
  const [tagInput, setTagInput] = useState('')
  const [saving, setSaving] = useState(false)
  // 文库首页（Gamma 布局）：题名筛选与排序在页头完成；收录面板默认收起。
  const [libFilter, setLibFilter] = useState('')
  const [sortMode, setSortMode] = useState<'added' | 'title'>('added')
  const [collectOpen, setCollectOpen] = useState(false)
  const [collectMenuOpen, setCollectMenuOpen] = useState(false)
  const [collectQuery, setCollectQuery] = useState('')
  const [filterMenuOpen, setFilterMenuOpen] = useState(false)
  /** 顶部工具栏的「AI 工具」下拉（related work / 综述 / 知识库）。 */
  const [aiMenuOpen, setAiMenuOpen] = useState(false)
  /** AI 选择器：点「生成文献综述 / 起草相关工作」先进选择模式，选完再确认。 */
  const [aiPickerMode, setAiPickerMode] = useState<'review' | 'related' | null>(null)
  /** 哪张卡片的「更多」菜单是打开的（存 paperKey）。 */
  const [cardMenuId, setCardMenuId] = useState<string | null>(null)
  /** 正在整篇翻译 / 生成摘要的卡片：徽章据此显示「翻译中」「摘要中」。 */
  const [translatingIds, setTranslatingIds] = useState<ReadonlySet<string>>(new Set())
  const [summarizingIds, setSummarizingIds] = useState<ReadonlySet<string>>(new Set())
  /** One AbortController per running whole-paper translation. */
  const translationControllersRef = useRef(new Map<string, AbortController>())
  const translationProgressTimersRef = useRef(new Map<string, number>())
  const [translationStartedAt, setTranslationStartedAt] = useState<Record<string, number>>({})
  const [translationProgress, setTranslationProgress] = useState<Record<string, {
    phase: string
    current: number | null
    total: number | null
    percent: number | null
  }>>({})
  const [translationNotice, setTranslationNotice] = useState<{
    key: string
    title: string
    status: 'cancelled' | 'cached'
  } | null>(null)
  const [translationClock, setTranslationClock] = useState(Date.now())
  /** 正在查看的已生成摘要（null = 弹窗关闭）。 */
  const [summaryView, setSummaryView] = useState<PaperRecord | null>(null)
  /** 文献文件夹：列表、当前筛选、新建弹窗。 */
  const [folders, setFolders] = useState<readonly ResearchFolder[]>([])
  const [activeFolder, setActiveFolder] = useState<string>('all')
  const [folderDialogOpen, setFolderDialogOpen] = useState(false)
  const [folderDraft, setFolderDraft] = useState('')

  const loadFolders = (): void => {
    void fetchResearchState()
      .then((state) => { setFolders(state.store.folders ?? []) })
      .catch(() => { /* 文件夹只是辅助视图，读不到不影响文献列表 */ })
  }

  useEffect(() => { loadFolders() }, [])

  /** 新建文件夹：走通用条目接口，建完刷新文献与文件夹列表。 */
  const createFolder = (): void => {
    const name = folderDraft.trim()
    if (name === '') return
    setFolderDraft('')
    setFolderDialogOpen(false)
    void fetch('/api/studio/research/items/folders', {
      method: 'POST',
      headers: { ...researchApiHeaders(), 'Content-Type': 'application/json' },
      // 没选项目时落到第一个项目：后端要求 projectId，空值会 400。
      body: JSON.stringify({
        name,
        projectId: selectedProjectId ?? projects[0]?.id ?? '',
        createdAt: Date.now(),
      }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        loadFolders()
        await refreshPapers()
      })
      .catch((error: Error) => { setActionError(`${t('papers.folderCreateFailed')}：${error.message}`) })
  }

  /** 删除文件夹：先把里面的论文移回「未分类」，再删记录。 */
  const deleteFolder = (folder: ResearchFolder): void => {
    if (!window.confirm(t('papers.confirmDeleteFolder'))) return
    setActionError(null)
    void (async () => {
      const inside = papers.list.filter(row => extraOf(row).folderId === folder.id)
      for (const row of inside) {
        await updatePaper(paperKey(row), { folderId: '' })
      }
      const response = await fetch(
        `/api/studio/research/items/folders/${encodeURIComponent(folder.id)}`,
        { method: 'DELETE', headers: researchApiHeaders() },
      )
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (activeFolder === folder.id) setActiveFolder('all')
      loadFolders()
      await refreshPapers()
    })().catch((error: Error) => { setActionError(`${t('papers.folderDeleteFailed')}：${error.message}`) })
  }

  /** 把一篇文献归到某个文件夹；传 null 表示移回「未分类」。 */
  const moveToFolder = (paper: PaperRecord, folderId: string | null): void => {
    setCardMenuId(null)
    setActionError(null)
    void updatePaper(paperKey(paper), { folderId: folderId ?? '' }).then((failure) => {
      setActionError(failure === null ? null : failure.message)
    })
  }
  const [pdfFilter, setPdfFilter] = useState<'all' | 'ready' | 'missing' | 'favorite'>('all')
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const collectMenuRef = useRef<HTMLDivElement | null>(null)
  const filterMenuRef = useRef<HTMLDivElement | null>(null)
  const pdfFileInputRef = useRef<HTMLInputElement | null>(null)
  const importedIds = new Set(papers.list.map(paper => paper.arxivId))
  const visibleBase = filterPapers(papers.list, null, selectedProjectId)
    .filter(paper => pdfFilter === 'all'
      || (pdfFilter === 'favorite' ? paper.favorite === true
        : pdfFilter === 'ready' ? paper.pdfPath !== undefined : paper.pdfPath === undefined))
    // 文件夹筛选：全部 / 未分类 / 指定文件夹。
    .filter(paper => activeFolder === 'all'
      || (activeFolder === 'none'
        ? (extraOf(paper).folderId ?? '') === ''
        : extraOf(paper).folderId === activeFolder))
  const libNeedle = libFilter.trim().toLowerCase()
  const searched = visibleBase.filter(paper => libNeedle === '' || libraryHit(paper, libNeedle))
  const ordered = sortMode === 'title'
    ? searched.slice().sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'))
    : searched
  // 置顶的排在整段最前，其余保持当前排序。
  const visible = [
    ...ordered.filter(paper => extraOf(paper).pinned === true),
    ...ordered.filter(paper => extraOf(paper).pinned !== true),
  ]
  const activeTranslations = papers.list.filter(paper => translatingIds.has(paperKey(paper)))
  const noticePaper = translationNotice === null
    ? undefined
    : papers.list.find(paper => paperKey(paper) === translationNotice.key)
  const selectedProject = projects.find(project => project.id === selectedProjectId) ?? null
  /**
   * AI 的作用范围：勾选过的文献优先（可以只针对一两篇），
   * 一篇都没勾时才用当前筛选结果。
   */
  const aiScope = selectedIds.size > 0
    ? visible.filter(paper => selectedIds.has(paperKey(paper)))
    : visible

  // The related-work button covers exactly the papers on screen (the tag /
  // current-project filter IS the selection), and lands in toasts.
  const draftRelatedWorkOver = (scope: readonly PaperRecord[]): void => {
    if (selectedProject === null || scope.length === 0) return
    setActionError(null)
    void requestRelatedWork(buildRelatedWorkPrompt({
      papers: scope,
      projectTitle: selectedProject.title,
      dir: selectedProject.absDir ?? selectedProject.paperDir,
    }))
  }

  /**
   * 把内置科研 Skill 直接投到当前项目会话。Skill 自己通过
   * ekko_studio_api_request 读写文献、实验、服务器和论文模块。
   */
  const launchResearchSkill = (skill: 'auto-research-in-sleep' | 'academic-research-suite'): void => {
    if (selectedProject === null) {
      setActionError(t('bib.noProject'))
      return
    }
    setAiMenuOpen(false)
    setActionError(null)
    const scope = aiScope.slice(0, 20)
    const papers = scope.length === 0
      ? '(当前没有选中的文献)'
      : scope.map(paper => `- ${paperKey(paper)} | ${paper.title}`).join('\n')
    const prompt = [
      `Use the built-in Skill "${skill}" for this research task.`,
      `Call skill_view for "${skill}" first, then read its references/workbench-api.md.`,
      '',
      `Research Workbench project: ${selectedProject.title} (${selectedProject.id})`,
      `Project directory: ${selectedProject.absDir ?? selectedProject.paperDir ?? ''}`,
      'Papers in scope:',
      papers,
      '',
      'Start by calling ekko_studio_api_request GET /api/studio/research/state.',
      'Use only real workbench records and verified full text; never invent citations, metrics, or claims.',
      'Record plans/results in the matching workbench module and ask before destructive writes.',
      'For this turn, complete the next unfinished stage and leave a short resumable journal entry.',
    ].join('\n')
    void requestProjectSession(prompt).then((result) => {
      if (!result.ok) {
        setActionError(result.error ?? t('papers.relatedWorkFailed'))
        return
      }
      // 启动 Skill 后直接进入聊天页。`openSession` 指向模型设置页，
      // 这里不能复用它；当前会话已经由 requestProjectSession 选中。
      window.location.hash = '#/hermes/chat'
    })
  }

  /** Local PDF files become papers one by one; folder input simply supplies more File objects. */
  const importPdfFiles = (files: readonly File[]): void => {
    const pdfs = files.filter(file => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'))
    if (importingPdf !== '') {
      setActionError(t('papers.importBusy'))
      return
    }
    if (pdfs.length === 0) {
      setActionError(t('papers.pdfOnly'))
      return
    }
    setActionError(null)
    setImportedPdf(null)
    void (async () => {
      let latest: { title: string; chars: number | null } = { title: '', chars: null }
      for (let index = 0; index < pdfs.length; index += 1) {
        const file = pdfs[index]
        setImportingPdf(pdfs.length > 1 ? `${index + 1}/${pdfs.length} · ${file.name}` : file.name)
        const query = [
          selectedProjectId === null ? '' : `projectId=${encodeURIComponent(selectedProjectId)}`,
          `filename=${encodeURIComponent(file.name)}`,
        ].filter(Boolean).join('&')
        const res = await fetch(`/api/studio/research/papers/import-pdf?${query}`, {
          method: 'POST',
          headers: { ...researchApiHeaders(), 'Content-Type': 'application/pdf' },
          body: file,
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(`${file.name}: ${body?.error || `HTTP ${res.status}`}`)
        latest = {
          title: String(body?.paper?.title || file.name),
          chars: typeof body?.fulltextChars === 'number' ? body.fulltextChars : null,
        }
      }
      // 先等列表回读完成再落提示：导入接口返回那一刻，列表切片可能还没发布，
      // 之前 fire-and-forget 的刷新会让卡片"上传完了却没出现"。
      /*
       * 这里不再 await refreshPapers()。
       *
       * 实测那次回读会挂住不返回：于是 setImportedPdf（提示条）和后面的
       * 「重挂面板」都执行不到，表现就是「上传完没提示、卡片也不出现，
       * 必须切模块」。改成发出去就不等它，用重挂面板作为唯一可靠路径 ——
       * 重挂会重新创建 controller 并重新拉一次列表，等价于手动切模块。
       */
      /*
       * 现在 refreshPapers 是真的可用函数了（之前 ResearchPanel 传的是
       * `actions.refreshPapers`，而 actions 里根本没有这个键 —— 一直是
       * undefined，调用即抛错，后面的提示和刷新全都执行不到）。
       */
      await refreshPapers()
      setImportedPdf({ ...latest, count: pdfs.length })
    })()
      .catch((error: Error) => { setActionError(`${t('papers.importPdfFailed')}：${error.message}`) })
      .finally(() => { setImportingPdf('') })
  }

  const pickPdfFiles = (event: { target: HTMLInputElement }): void => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    // 选文件这一步没拿到任何文件时明说一句：之前是静默 return，
    // 用户只看到「点了没反应」。
    if (files.length === 0) {
      setActionError(t('papers.pdfOnly'))
      return
    }
    importPdfFiles(files)
  }

  /** Cross-paper review over exactly the papers currently on screen. */
  const runReviewOver = (scope: readonly PaperRecord[]): void => {
    if (scope.length === 0 || review.status === 'loading') return
    setActionError(null)
    setReview({ status: 'loading', text: '', error: '' })
    const paperIds = scope
      .map(paper => String((paper as { id?: string }).id || paper.arxivId || ''))
      .filter(Boolean)
    void fetch('/api/studio/research/review', {
      method: 'POST',
      headers: { ...researchApiHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(selectedProjectId === null ? {} : { projectId: selectedProjectId }),
        paperIds,
      }),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
        setReview({ status: 'ready', text: String(body?.output || ''), error: '' })
      })
      .catch((error: Error) => { setReview({ status: 'error', text: '', error: error.message }) })
  }

  /** Read the project's knowledge rows; the panel is the only place they surface. */
  const loadKnowledge = (): void => {
    setKnowledgeLoading(true)
    void fetch('/api/studio/research/state', { headers: researchApiHeaders() })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
        const rows: KnowledgeRowView[] = Array.isArray(body?.store?.knowledge) ? body.store.knowledge : []
        const scoped = selectedProjectId === null
          ? rows
          : rows.filter(row => row.projectId === selectedProjectId)
        setKnowledgeRows([...scoped].sort((a, b) => b.createdAt - a.createdAt))
      })
      .catch((error: Error) => { setActionError(`${t('papers.knowledgeLoadFailed')}：${error.message}`) })
      .finally(() => { setKnowledgeLoading(false) })
  }

  const toggleKnowledge = (): void => {
    const next = !knowledgeOpen
    setKnowledgeOpen(next)
    if (next) loadKnowledge()
  }

  const removeKnowledge = (id: string): void => {
    void fetch(`/api/studio/research/items/knowledge/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: researchApiHeaders(),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        setKnowledgeRows(rows => rows.filter(row => row.id !== id))
      })
      .catch((error: Error) => { setActionError(`${t('papers.knowledgeDeleteFailed')}：${error.message}`) })
  }

  /** A knowledge row only stores the paper id; the list view needs the title. */
  const paperTitleOf = (paperId: string): string => {
    const found = papers.list.find(item => {
      const rowId = String((item as { id?: string }).id || '')
      return rowId === paperId || item.arxivId === paperId
    })
    return found ? found.title : ''
  }

  const saveReviewToKnowledge = (): void => {
    if (selectedProjectId === null || review.text.trim() === '') return
    void saveKnowledgeItem({
      projectId: selectedProjectId,
      kind: 'literature_review',
      statement: review.text.trim().slice(0, 4000),
      paperId: '',
    })
      .then(() => { setReview((previous) => ({ ...previous, saved: true })) })
      .catch((error: Error) => { setActionError(`${t('papers.knowledgeFailed')}：${error.message}`) })
  }

  const runPubmedSearch = (value: string): void => {
    setPubmedSearch({ status: 'loading', query: value, entries: [], error: '' })
    void searchPubmedOnline(value, 10)
      .then((result) => {
        setPubmedSearch({
          status: result.error === '' ? 'ready' : 'error',
          query: value,
          entries: result.entries,
          error: result.error,
        })
      })
      .catch((error: Error) => {
        setPubmedSearch({ status: 'error', query: value, entries: [], error: error.message })
      })
  }

  const importPubmed = (entry: PubmedEntryView): void => {
    if (importing !== null) return
    setImporting(entry.pmid)
    setActionError(null)
    void importPubmedEntry(entry, selectedProjectId ?? undefined)
      .then(() => {
        setPubmedImported((previous) => new Set(previous).add(entry.pmid))
        ensurePapers()
      })
      .catch((error: Error) => { setActionError(`${t('papers.importFailed')}：${error.message}`) })
      .finally(() => { setImporting(null) })
  }

  const submitSearch = (): void => {
    const value = query.trim()
    if (value === '') return
    setActionError(null)
    if (source === 'web') { searchWeb(query); return }
    if (source === 'pubmed') { runPubmedSearch(value); return }
    searchArxiv(query)
  }
  const importEntry = (entry: ArxivEntry): void => {
    if (importing !== null) return
    setImporting(entry.id)
    setActionError(null)
    void importPaper(entry, selectedProjectId ?? undefined)
      .then((failure) => {
        setActionError(failure === null ? null : `${t('papers.importFailed')}：${failure.message}`)
      })
      .finally(() => { setImporting(null) })
  }
  const toggleFavorite = (paper: PaperRecord): void => {
    setActionError(null)
    void updatePaper(paperKey(paper), { favorite: paper.favorite !== true }).then((failure) => {
      setActionError(failure === null ? null : `${t('papers.favoriteFailed')}：${failure.message}`)
    })
  }

  /** 置顶切换：置顶的文献排在列表最前。 */
  const togglePin = (paper: PaperRecord): void => {
    setCardMenuId(null)
    setActionError(null)
    void updatePaper(paperKey(paper), { pinned: extraOf(paper).pinned !== true }).then((failure) => {
      setActionError(failure === null ? null : failure.message)
    })
  }

  /**
   * 卡片「未翻译」徽章 / 菜单「一键全本翻译」：整篇翻译（mono，原位替换成中文）。
   * 徽章在请求期间显示「翻译中」，完成后刷新列表变成「已翻译」。
   */
  const startSummarize = (paper: PaperRecord): void => {
    const key = paperKey(paper)
    // 已经有摘要：点徽章就是「查看」，不再重复调用模型。
    if (paper.aiSummary !== undefined) {
      setCardMenuId(null)
      setSummaryView(paper)
      return
    }
    if (summarizingIds.has(key)) return
    setCardMenuId(null)
    setActionError(null)
    setSummarizingIds(prev => new Set(prev).add(key))
    void requestPaperSummary(paper)
      .then(async () => { await refreshPapers() })
      .catch((error: Error) => { setActionError(`${t('papers.summaryFailed')}：${error.message}`) })
      .finally(() => {
        setSummarizingIds(prev => {
          const next = new Set(prev)
          next.delete(key)
          return next
        })
        // 与上传一致：完成后让宿主重挂一次，徽章立即变「已摘要」。
        window.setTimeout(() => { window.dispatchEvent(new CustomEvent('mimir:remount')) }, 400)
      })
  }

  const stopTranslationProgress = (key: string): void => {
    const timer = translationProgressTimersRef.current.get(key)
    if (timer !== undefined) window.clearInterval(timer)
    translationProgressTimersRef.current.delete(key)
    setTranslationProgress(prev => {
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  const pollTranslationProgress = (key: string): void => {
    void fetch(`/api/studio/research/papers/${encodeURIComponent(key)}/translate-status?variant=mono`, {
      headers: researchApiHeaders(),
      cache: 'no-store',
    })
      .then(async response => (response.ok ? response.json() : null))
      .then((body) => {
        const job = body?.job
        if (!job || job.state !== 'running') return
        setTranslationProgress(prev => ({
          ...prev,
          [key]: {
            phase: String(job.phase || ''),
            current: typeof job.current === 'number' ? job.current : null,
            total: typeof job.total === 'number' ? job.total : null,
            percent: typeof job.percent === 'number' ? job.percent : null,
          },
        }))
      })
      .catch(() => { /* progress is best-effort */ })
  }

  const startTranslate = (paper: PaperRecord, force = false): void => {
    const key = paperKey(paper)
    if (translatingIds.has(key) || translationControllersRef.current.has(key)) return
    if (!force && extraOf(paper).translatedAt !== undefined) {
      // 已翻译的文献直接复用缓存，避免无意义地再次跑 pdf2zh。
      setTranslationNotice({ key, title: paper.title, status: 'cached' })
      setCardMenuId(null)
      return
    }
    setCardMenuId(null)
    setActionError(null)
    setTranslationNotice(null)
    const controller = new AbortController()
    translationControllersRef.current.set(key, controller)
    setTranslationStartedAt(prev => ({ ...prev, [key]: Date.now() }))
    setTranslatingIds(prev => new Set(prev).add(key))
    setTranslationProgress(prev => ({
      ...prev,
      [key]: { phase: t('papers.translationRunning'), current: null, total: null, percent: null },
    }))
    pollTranslationProgress(key)
    const progressTimer = window.setInterval(() => { pollTranslationProgress(key) }, 900)
    translationProgressTimersRef.current.set(key, progressTimer)
    let succeeded = false
    void fetch(`/api/studio/research/papers/${encodeURIComponent(key)}/translate-pdf?variant=mono&format=json`, {
      method: 'POST',
      headers: researchApiHeaders(),
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}))
        if (!response.ok || body?.ok !== true) {
          throw new Error(body?.error || `HTTP ${response.status}`)
        }
        // 卡片只需要完成状态；译文 PDF 留在服务端供阅读器按需读取。
        succeeded = true
        await refreshPapers()
      })
      .catch((error: Error) => {
        // 用户主动中止不是失败，也不删除服务端已经写出的译本文件。
        if (controller.signal.aborted || error.name === 'AbortError') {
          setTranslationNotice({ key, title: paper.title, status: 'cancelled' })
          return
        }
        setActionError(`${t('papers.dualFailed')}：${error.message}`)
      })
      .finally(() => {
        translationControllersRef.current.delete(key)
        stopTranslationProgress(key)
        setTranslationStartedAt(prev => {
          const next = { ...prev }
          delete next[key]
          return next
        })
        setTranslatingIds(prev => {
          const next = new Set(prev)
          next.delete(key)
          return next
        })
        if (succeeded) {
          // 与上传一致：完成后让宿主重挂一次，徽章立即变「已翻译」。
          window.setTimeout(() => { window.dispatchEvent(new CustomEvent('mimir:remount')) }, 400)
        }
      })
  }

  /** 中止整篇翻译：先断开浏览器请求，服务端收到 close 后终止 pdf2zh 进程树。 */
  const cancelTranslate = (paper: PaperRecord): void => {
    const key = paperKey(paper)
    const controller = translationControllersRef.current.get(key)
    if (!controller) return
    controller.abort()
    translationControllersRef.current.delete(key)
    stopTranslationProgress(key)
    setTranslationStartedAt(prev => {
      const next = { ...prev }
      delete next[key]
      return next
    })
    setTranslatingIds(prev => {
      const next = new Set(prev)
      next.delete(key)
      return next
    })
    setTranslationNotice({ key, title: paper.title, status: 'cancelled' })
  }

  useEffect(() => {
    if (translatingIds.size === 0) return undefined
    setTranslationClock(Date.now())
    const timer = window.setInterval(() => { setTranslationClock(Date.now()) }, 1000)
    return () => { window.clearInterval(timer) }
  }, [translatingIds.size])

  useEffect(() => () => {
    for (const controller of translationControllersRef.current.values()) controller.abort()
    translationControllersRef.current.clear()
    for (const timer of translationProgressTimersRef.current.values()) window.clearInterval(timer)
    translationProgressTimersRef.current.clear()
  }, [])

  /** 菜单「AI 摘要」与徽章共用同一条链路。 */
  const summarizeFromMenu = (paper: PaperRecord): void => {
    startSummarize(paper)
  }

  /** 菜单「一键全本翻译」/「重新翻译全文」；已翻译时显式重跑才允许绕过缓存。 */
  const translateWholeFromMenu = (paper: PaperRecord): void => {
    startTranslate(paper, extraOf(paper).translatedAt !== undefined)
  }

  const removeEntry = (paper: PaperRecord): void => {
    if (!window.confirm(t('papers.confirmDelete'))) return
    setActionError(null)
    void removePaper(paperKey(paper)).then((failure) => {
      setActionError(failure === null ? null : `${t('papers.deleteFailed')}：${failure.message}`)
    })
  }

  const openEdit = (paper: PaperRecord): void => {
    setEditing(paper.arxivId)
    setDraftTags([...paper.tags])
    setDraftProjectIds([...paper.projectIds])
    setDraftNotes(paper.notes)
    setTagInput('')
    setActionError(null)
  }
  const addTag = (): void => {
    const tag = tagInput.trim()
    if (tag === '') return
    setDraftTags(prev => (prev.includes(tag) ? prev : [...prev, tag]))
    setTagInput('')
  }
  const toggleProject = (projectId: string): void => {
    setDraftProjectIds(prev =>
      prev.includes(projectId) ? prev.filter(id => id !== projectId) : [...prev, projectId])
  }
  const saveEdit = (paper: PaperRecord): void => {
    if (saving) return
    // A tag typed but not yet committed with Enter rides along.
    const pending = tagInput.trim()
    const tags = pending === '' || draftTags.includes(pending) ? draftTags : [...draftTags, pending]
    setSaving(true)
    setActionError(null)
    void updatePaper(paper.arxivId, { tags, projectIds: draftProjectIds, notes: draftNotes })
      .then((failure) => {
        if (failure === null) {
          setEditing(null)
        } else {
          setActionError(`${t('papers.saveFailed')}：${failure.message}`)
        }
      })
      .finally(() => { setSaving(false) })
  }

  /** Project badges of one card: linked project titles, unknown ids shown raw. */
  const projectBadges = (paper: PaperRecord): Array<{ id: string; title: string }> =>
    paper.projectIds.map(id => ({ id, title: projects.find(project => project.id === id)?.title ?? id }))

  const submitCollectQuery = (): void => {
    const raw = collectQuery.trim()
    if (raw === '') return
    const doi = /10\.\d{4,9}\/[^\s]+/i.exec(raw)?.[0]
    const value = (arxivIdFromUrl(raw) ?? doi ?? raw).replace(/^arxiv:\s*/i, '')
    setSource('arxiv')
    setQuery(value)
    setCollectOpen(true)
    setCollectMenuOpen(false)
    searchArxiv(value)
  }

  useEffect(() => {
    if (!collectMenuOpen && !filterMenuOpen && !aiMenuOpen) return undefined
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (collectMenuOpen && !collectMenuRef.current?.contains(target)) setCollectMenuOpen(false)
      if (filterMenuOpen && !filterMenuRef.current?.contains(target)) setFilterMenuOpen(false)
      // AI 下拉没有单独 ref：点在菜单项上时菜单项自己会关，这里只处理「点空白处」。
      if (aiMenuOpen && target instanceof Element && target.closest('[data-ai-menu]') === null) setAiMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setCollectMenuOpen(false)
      setFilterMenuOpen(false)
      setAiMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [collectMenuOpen, filterMenuOpen, aiMenuOpen])

  const startSelectMode = (): void => {
    setExpanded({})
    setSelectedIds(new Set())
    setSelectMode(true)
  }
  const finishSelectMode = (): void => {
    setSelectedIds(new Set())
    setSelectMode(false)
    setAiPickerMode(null)
  }
  const allVisibleSelected = visible.length > 0 && visible.every(paper => selectedIds.has(paperKey(paper)))
  const toggleSelectAll = (): void => {
    // 全选同时也是「进入多选模式」：否则卡片上不显示勾选标记，用户看不出选中了谁。
    if (allVisibleSelected) {
      setSelectedIds(new Set())
      return
    }
    setSelectMode(true)
    setExpanded({})
    setSelectedIds(new Set(visible.map(paper => paperKey(paper))))
  }
  const toggleSelected = (arxivId: string): void => {
    setSelectedIds(previous => {
      const next = new Set(previous)
      if (next.has(arxivId)) next.delete(arxivId)
      else next.add(arxivId)
      return next
    })
  }

  /** 进入 AI 选择模式：顶部出现「已选 N 篇 / 全选当前 / 确认」这一栏。 */
  const startAiPicker = (mode: 'review' | 'related'): void => {
    setCardMenuId(null)
    setAiMenuOpen(false)
    setExpanded({})
    setSelectMode(true)
    setSelectedIds(new Set())
    setAiPickerMode(mode)
  }

  /** 确认：用当前勾选的文献发起请求，然后退出选择模式。 */
  const confirmAiPicker = (): void => {
    if (aiPickerMode === null) return
    const chosen = visible.filter(paper => selectedIds.has(paperKey(paper)))
    if (chosen.length === 0) return
    const mode = aiPickerMode
    setAiPickerMode(null)
    setSelectMode(false)
    setSelectedIds(new Set())
    if (mode === 'review') runReviewOver(chosen)
    else draftRelatedWorkOver(chosen)
  }

  /** 取消：什么都不做，只退出选择模式。 */
  const cancelAiPicker = (): void => {
    setAiPickerMode(null)
    setSelectMode(false)
    setSelectedIds(new Set())
  }
  const deleteSelected = (): void => {
    if (deleting || selectedIds.size === 0) return
    if (!window.confirm(t('papers.confirmDeleteSelected', { count: selectedIds.size }))) return
    setDeleting(true)
    setActionError(null)
    const ids = [...selectedIds]
    void (async () => {
      const failures: string[] = []
      for (const id of ids) {
        const failure = await removePaper(id)
        if (failure !== null) failures.push(`${id}: ${failure.message}`)
      }
      if (failures.length > 0) setActionError(`${t('papers.deleteFailed')}：${failures[0]}`)
      finishSelectMode()
      refreshPapers()
    })()
      .catch((error: Error) => { setActionError(`${t('papers.deleteFailed')}：${error.message}`) })
      .finally(() => { setDeleting(false) })
  }

  return (
    <div className={css.papers}>
<ViewHead title={t('tab.papers')} subtitle={t('view.papers.subtitle')}>
        {selectMode ? (
          <>
            <span className={css.papersSelectionCount}>
              {t('papers.selectedCount', { count: selectedIds.size })}
            </span>
            <button type="button" className={css.btn} onClick={toggleSelectAll}>
              {allVisibleSelected ? t('papers.clearSelection') : t('papers.selectAll')}
            </button>
            {aiPickerMode === null ? (
              <button
                type="button"
                className={css.btn}
                data-danger
                disabled={deleting || selectedIds.size === 0}
                onClick={deleteSelected}
              >
                {deleting ? t('papers.deleting') : t('papers.delete')}
              </button>
            ) : (
              <button
                type="button"
                className={css.btnPrimary}
                disabled={selectedIds.size === 0}
                onClick={confirmAiPicker}
              >
                {aiPickerMode === 'review'
                  ? `${t('papers.review')}（${selectedIds.size}）`
                  : `${t('papers.relwork')}（${selectedIds.size}）`}
              </button>
            )}
            <button
              type="button"
              className={css.btn}
              disabled={deleting}
              onClick={aiPickerMode === null ? finishSelectMode : cancelAiPicker}
            >
              {aiPickerMode === null ? t('papers.done') : t('papers.cancelSelect')}
            </button>
          </>
        ) : (
          <>
            <input
              className={css.papersLibFilter}
              value={libFilter}
              placeholder={t('papers.libFilter')}
              aria-label={t('papers.libFilter')}
              onChange={event => { setLibFilter(event.target.value) }}
            />
            <button type="button" className={css.btn} disabled={visible.length === 0} onClick={startSelectMode}>
              {t('papers.batch')}
            </button>
            <div className={css.papersToolbarMenu} ref={filterMenuRef}>
              <button
                type="button"
                className={css.btn}
                data-active={pdfFilter !== 'all' || undefined}
                aria-expanded={filterMenuOpen}
                onClick={() => { setFilterMenuOpen(prev => !prev); setCollectMenuOpen(false) }}
              >
                {t('papers.filter')}
              </button>
              {filterMenuOpen && (
                <div className={css.papersFilterMenu} aria-label={t('papers.filter')}>
                  {(['all', 'favorite', 'ready', 'missing'] as const).map(mode => (
                    <button
                      key={mode}
                      type="button"
                      className={css.papersMenuItem}
                      data-active={pdfFilter === mode || undefined}
                      aria-pressed={pdfFilter === mode}
                      onClick={() => { setPdfFilter(mode); setFilterMenuOpen(false) }}
                    >
                      <span>{t(mode === 'all' ? 'papers.filterAll' : mode === 'ready' ? 'papers.filterReady' : mode === 'missing' ? 'papers.filterMissing' : 'papers.filterFavorite')}</span>
                      {pdfFilter === mode && <span aria-hidden="true">✓</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <select
              className={css.papersSort}
              value={sortMode}
              aria-label={t('papers.sort')}
              onChange={event => { setSortMode(event.target.value === 'title' ? 'title' : 'added') }}
            >
              <option value="added">{t('papers.sortAdded')}</option>
              <option value="title">{t('papers.sortTitle')}</option>
            </select>
            <div className={css.papersViewToggle} role="group" aria-label={t('papers.viewMode')}>
              <button
                type="button"
                data-active={viewMode === 'grid' || undefined}
                aria-label={t('papers.gridView')}
                title={t('papers.gridView')}
                onClick={() => { setViewMode('grid') }}
              >
                <ToolIcon name="grid" />
              </button>
              <button
                type="button"
                data-active={viewMode === 'list' || undefined}
                aria-label={t('papers.listView')}
                title={t('papers.listView')}
                onClick={() => { setViewMode('list') }}
              >
                <ToolIcon name="list" />
              </button>
            </div>
            <div className={css.papersToolbarMenu} data-ai-menu>
              <button
                type="button"
                className={css.btn}
                data-active={knowledgeOpen || undefined}
                aria-expanded={aiMenuOpen}
                title={t('papers.aiTools')}
                onClick={() => { setAiMenuOpen(prev => !prev); setCollectMenuOpen(false); setFilterMenuOpen(false) }}
              >
                {t('papers.aiTools')}
              </button>
              {aiMenuOpen && (
                <div className={css.papersFilterMenu} aria-label={t('papers.aiTools')}>
                  <button
                    type="button"
                    className={css.papersMenuItem}
                    disabled={selectedProject === null || visible.length === 0}
                    title={selectedProject === null ? t('bib.noProject') : t('papers.relworkScope')}
                    onClick={() => { startAiPicker('related') }}
                  >
                    {t('papers.relwork')}
                  </button>
                  <button
                    type="button"
                    className={css.papersMenuItem}
                    disabled={visible.length === 0 || review.status === 'loading'}
                    title={t('papers.reviewHint')}
                    onClick={() => { startAiPicker('review') }}
                  >
                    {review.status === 'loading' ? t('papers.skillRunning') : t('papers.review')}
                  </button>
                  <button
                    type="button"
                    className={css.papersMenuItem}
                    disabled={selectedProject === null || visible.length === 0}
                    title={selectedProject === null ? t('bib.noProject') : t('papers.autoResearchHint')}
                    onClick={() => { launchResearchSkill('auto-research-in-sleep') }}
                  >
                    {t('papers.autoResearch')}
                  </button>
                  <button
                    type="button"
                    className={css.papersMenuItem}
                    disabled={selectedProject === null || visible.length === 0}
                    title={selectedProject === null ? t('bib.noProject') : t('papers.academicSuiteHint')}
                    onClick={() => { launchResearchSkill('academic-research-suite') }}
                  >
                    {t('papers.academicSuite')}
                  </button>
                  <button
                    type="button"
                    className={css.papersMenuItem}
                    data-active={knowledgeOpen || undefined}
                    title={t('papers.knowledgeHint')}
                    onClick={() => { setAiMenuOpen(false); toggleKnowledge() }}
                  >
                    {t('papers.knowledge')}{knowledgeRows.length > 0 ? ` ${knowledgeRows.length}` : ''}
                  </button>
                </div>
              )}
            </div>
            <div className={css.papersToolbarMenu} ref={collectMenuRef}>
              <button
                type="button"
                className={css.papersAddButton}
                aria-label={t('papers.collect')}
                title={t('papers.collect')}
                aria-expanded={collectMenuOpen}
                onClick={() => { setCollectMenuOpen(prev => !prev); setFilterMenuOpen(false) }}
              >
                <span aria-hidden="true">＋</span>
              </button>
              {collectMenuOpen && (
                <div className={css.papersCollectMenu} aria-label={t('papers.collect')}>
                  <input
                    className={css.papersCollectPaste}
                    value={collectQuery}
                    placeholder={t('papers.collectPaste')}
                    aria-label={t('papers.collectPaste')}
                    onChange={event => { setCollectQuery(event.target.value) }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return
                      event.preventDefault()
                      submitCollectQuery()
                    }}
                  />
                  <button
                    type="button"
                    className={css.papersMenuItem}
                    onClick={() => { setCollectOpen(prev => !prev); setCollectMenuOpen(false) }}
                  >
                    {t('papers.searchSources')}
                  </button>
                  <button
                    type="button"
                    className={css.papersMenuItem}
                    disabled={importingPdf !== ''}
                    onClick={() => { pdfFileInputRef.current?.click(); setCollectMenuOpen(false) }}
                  >
                    {t('papers.uploadFiles')}
                  </button>
                  <button
                    type="button"
                    className={css.papersMenuItem}
                    onClick={() => { setFolderDialogOpen(true); setCollectMenuOpen(false) }}
                  >
                    {t('papers.newFolder')}
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </ViewHead>
      {/*
        已生成摘要的查看弹窗。挂到 body：卡片本身有 z-index / position，
        留在列表里会被卡片盖住（截图里左边被卡片遮了一半）。
      */}
      {summaryView !== null && createPortal((
        <div
          className={css.paperSummaryBackdrop}
          role="dialog"
          aria-modal="true"
          aria-label={t('papers.aiSummary')}
          onClick={() => { setSummaryView(null) }}
        >
          <div className={css.paperSummaryDialog} onClick={(event) => { event.stopPropagation() }}>
            <header className={css.paperSummaryHead}>
              <h4>{t('papers.aiSummary')}</h4>
              <button
                type="button"
                className={css.paperSummaryClose}
                aria-label={t('papers.closeSummary')}
                onClick={() => { setSummaryView(null) }}
              >
                ×
              </button>
            </header>
            <p className={css.paperSummaryTitle}>{summaryView.title}</p>
            <div className={css.paperSummaryBody}>{summaryView.aiSummary}</div>
          </div>
        </div>
      ), document.body)}
      {/* 新建文件夹弹窗 */}
      {folderDialogOpen && createPortal((
        <div
          className={css.paperSummaryBackdrop}
          role="dialog"
          aria-modal="true"
          onClick={() => { setFolderDialogOpen(false) }}
        >
          <form
            className={css.paperFolderDialog}
            onClick={(event) => { event.stopPropagation() }}
            onSubmit={(event) => { event.preventDefault(); createFolder() }}
          >
            <h4>{t('papers.newFolder')}</h4>
            <input
              autoFocus
              className={css.paperFolderInput}
              value={folderDraft}
              placeholder={t('papers.folderPlaceholder')}
              onChange={(event) => { setFolderDraft(event.target.value) }}
            />
            <div className={css.paperFolderActions}>
              <button
                type="submit"
                className={css.paperFolderSubmit}
                disabled={folderDraft.trim() === ''}
              >
                {t('papers.folderCreate')}
              </button>
            </div>
          </form>
        </div>
      ), document.body)}
      <input ref={pdfFileInputRef} data-pdf-upload="files" type="file" accept="application/pdf,.pdf" multiple hidden onChange={pickPdfFiles} />

      {collectOpen && (
        <section className={css.papersCollectPanel} aria-label={t('papers.collectPanel')}>
        <SubscriptionsBar
          subscriptions={arxivSubscriptions}
          importedIds={importedIds}
          importPaper={importPaper}
          saveArxivSubscription={saveArxivSubscription}
          deleteArxivSubscription={deleteArxivSubscription}
          checkArxivSubscriptions={checkArxivSubscriptions}
          t={t}
        />
        <form
          className={css.papersSearchBar}
          onSubmit={(event) => {
            event.preventDefault()
            submitSearch()
          }}
        >
          <div className={css.papersSourceTabs} role="tablist" aria-label={t('papers.search')}>
            {(['arxiv', 'pubmed', 'web'] as const).map(tab => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={source === tab}
                className={css.paperTab}
                data-active={source === tab || undefined}
                onClick={() => { setSource(tab) }}
              >
                {t(tab === 'arxiv' ? 'papers.sourceArxiv' : tab === 'pubmed' ? 'papers.sourcePubmed' : 'papers.sourceWeb')}
              </button>
            ))}
          </div>
          <input
            className={css.input}
            value={query}
            placeholder={t(
              source === 'web' ? 'papers.webSearchPlaceholder'
                : source === 'pubmed' ? 'papers.pubmedSearchPlaceholder'
                  : 'papers.searchPlaceholder',
            )}
            onChange={event => { setQuery(event.target.value) }}
          />
          <button
            type="submit"
            className={css.btnPrimary}
            disabled={query.trim() === '' || arxivSearch?.status === 'loading'
              || webSearch?.status === 'loading' || pubmedSearch.status === 'loading'}
          >
            {(source === 'arxiv' ? arxivSearch?.status
              : source === 'pubmed' ? pubmedSearch.status
                : webSearch?.status) === 'loading' ? t('papers.searching') : t('papers.search')}
          </button>
        </form>
        {source === 'web' && <SxngConfigPanel config={sxngConfig} getConfig={getSxngConfig} saveConfig={saveSxngConfig} t={t} />}
        {actionError !== null && (
          <p className={css.failure} role="alert">{actionError}</p>
        )}
        <ZoteroSection
          zotero={zotero}
          zoteroSearch={zoteroSearch}
          importedIds={importedIds}
          selectedProjectId={selectedProjectId}
          recheckZotero={recheckZotero}
          searchZotero={searchZotero}
          importZoteroItem={importZoteroItem}
          exportZoteroCollectionToBib={exportZoteroCollectionToBib}
          onError={setActionError}
          t={t}
        />
        {source === 'web' ? (
          <WebSearchPanel
            webSearch={webSearch}
            importedIds={importedIds}
            importing={importing}
            importEntry={importEntry}
            searchWeb={searchWeb}
            t={t}
          />
        ) : source === 'pubmed' ? (
          <PubmedResultsPanel
            pubmedSearch={pubmedSearch}
            importedIds={pubmedImported}
            importing={importing}
            importEntry={importPubmed}
            t={t}
          />
        ) : (
          arxivSearch !== null && (
          <section className={css.papersSearchPanel}>
            <h3 className={css.sectionTitle}>
              {t('papers.searchResults')}：{arxivSearch.query}
            </h3>
            {arxivSearch.status === 'loading' ? (
              <p className={css.hint}>{t('papers.searching')}</p>
            ) : arxivSearch.status === 'error' ? (
              <p className={css.failure} role="alert">
                {t('error.arxivSearch')}：{failureCopy(t, arxivSearch.failure)}
                <button type="button" className={css.btn} onClick={() => { searchArxiv(arxivSearch.query) }}>
                  {t('error.retry')}
                </button>
              </p>
            ) : arxivSearch.list.length === 0 ? (
              <p className={css.hint}>{t('papers.searchEmpty')}</p>
            ) : (
              <div className={css.papersResults}>
                {arxivSearch.list.map(entry => (
                  <article key={entry.id} className={css.paperResult}>
                    <div className={css.paperResultHead}>
                      <h3 className={css.paperCardTitle}>
                        <a href={entry.url} target="_blank" rel="noreferrer">
                          {entry.title}
                        </a>
                      </h3>
                      {importedIds.has(entry.id) ? (
                        <button type="button" className={css.btn} disabled>
                          {t('papers.imported')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={css.btnPrimary}
                          disabled={importing !== null}
                          onClick={() => { importEntry(entry) }}
                        >
                          {importing === entry.id ? t('papers.importing') : t('papers.import')}
                        </button>
                      )}
                    </div>
                    <p className={css.paperCardMeta}>
                      {entry.authors.length > 0 && `${entry.authors.join('，')} · `}
                      {entry.published.slice(0, 4)}
                    </p>
                    <p className={css.paperSummary} data-static>{entry.summary}</p>
                  </article>
                ))}
              </div>
            )}
          </section>
          )
        )}
        </section>
      )}
      {papers.status === 'cold' || papers.status === 'loading' ? (
        <p className={css.hint}>{t('papers.loading')}</p>
      ) : papers.status === 'error' ? (
        <p className={css.failure} role="alert">
          {t('error.papers')}：{failureCopy(t, papers.failure)}
          <button type="button" className={css.btn} onClick={ensurePapers}>
            {t('error.retry')}
          </button>
        </p>
      ) : papers.list.length === 0 ? (
        <EmptyState glyph="📚">{t('papers.empty')}</EmptyState>
      ) : (
        <>
          <div className={css.papersFilters}>
            {importingPdf !== '' && (
              <span className={css.papersImportProgress} role="status">
                {t('papers.importingPdf')} {importingPdf}
              </span>
            )}
          </div>
          {importedPdf !== null && (
            <p className={css.importResult} role="status">
              {t('papers.importPdfDone')}：{importedPdf.count > 1
                ? t('papers.importPdfMany', { count: importedPdf.count })
                : importedPdf.title}
              {importedPdf.count === 1 && importedPdf.chars !== null
                ? `（${t('papers.importPdfChars')} ${importedPdf.chars}）` : ''}
            </p>
          )}
          {review.status !== 'idle' && (
            <section className={css.papersSearchPanel}>
              <div className={css.papersPanelHead}>
                <h3 className={css.sectionTitle}>{t('papers.reviewTitle')}</h3>
                <button
                  type="button"
                  className={css.papersPanelClose}
                  aria-label={t('papers.closeReview')}
                  title={t('papers.closeReview')}
                  onClick={() => { setReview({ status: 'idle', text: '', error: '' }) }}
                >
                  ×
                </button>
              </div>
              {review.status === 'loading' ? (
                <p className={css.hint}>{t('papers.reviewRunning')}</p>
              ) : review.status === 'error' ? (
                <p className={css.failure} role="alert">{review.error}</p>
              ) : (
                <>
                  <div className={css.paperAiSummary}>{review.text}</div>
                  <div className={css.paperAiFooter}>
                    <button
                      type="button"
                      className={css.btn}
                      disabled={selectedProjectId === null || review.saved === true}
                      onClick={saveReviewToKnowledge}
                    >
                      {review.saved === true ? t('papers.knowledgeSaved') : t('papers.saveToKnowledge')}
                    </button>
                  </div>
                </>
              )}
            </section>
          )}
          {knowledgeOpen && (
            <section className={css.papersSearchPanel}>
              <div className={css.knowledgeHead}>
                <h3 className={css.sectionTitle}>{t('papers.knowledgeTitle')}</h3>
                <div className={css.papersPanelActions}>
                  <button
                    type="button"
                    className={css.btn}
                    disabled={knowledgeLoading}
                    onClick={loadKnowledge}
                  >
                    {knowledgeLoading ? t('papers.knowledgeLoading') : t('papers.knowledgeReload')}
                  </button>
                  <button
                    type="button"
                    className={css.papersPanelClose}
                    aria-label={t('papers.closeKnowledge')}
                    title={t('papers.closeKnowledge')}
                    onClick={() => { setKnowledgeOpen(false) }}
                  >
                    ×
                  </button>
                </div>
              </div>
              {knowledgeLoading && knowledgeRows.length === 0 ? (
                <p className={css.hint}>{t('papers.knowledgeLoading')}</p>
              ) : knowledgeRows.length === 0 ? (
                <p className={css.hint}>{t('papers.knowledgeEmpty')}</p>
              ) : (
                <ul className={css.knowledgeList}>
                  {knowledgeRows.map(row => (
                    <li key={row.id} className={css.knowledgeItem}>
                      <span className={css.knowledgeKind} data-kind={row.kind}>
                        {t(KNOWLEDGE_KIND_LABEL[row.kind] ?? 'papers.kindClaim')}
                      </span>
                      <span className={css.knowledgeStatement}>{row.statement}</span>
                      {paperTitleOf(row.paperId ?? '') !== '' && (
                        <span className={css.knowledgeSource} title={row.paperId}>
                          {paperTitleOf(row.paperId ?? '')}
                        </span>
                      )}
                      <button
                        type="button"
                        className={css.knowledgeRemove}
                        aria-label={t('papers.knowledgeRemove')}
                        title={t('papers.knowledgeRemove')}
                        onClick={() => { removeKnowledge(row.id) }}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {/* 文件夹筛选：全部 / 未分类 / 用户建的文件夹。 */}
          <div className={css.papersFolders} role="tablist" aria-label={t('papers.newFolder')}>
            {[
              { key: 'all', label: t('papers.folderAll') },
              { key: 'none', label: t('papers.folderNone') },
            ].map(item => (
              <button
                key={item.key}
                type="button"
                role="tab"
                className={css.papersFolderChip}
                data-active={activeFolder === item.key || undefined}
                aria-selected={activeFolder === item.key}
                onClick={() => { setActiveFolder(item.key) }}
              >
                {item.label}
              </button>
            ))}
            {folders.map(folder => (
              <span
                key={folder.id}
                className={css.papersFolderChip}
                data-active={activeFolder === folder.id || undefined}
                role="tab"
                aria-selected={activeFolder === folder.id}
                tabIndex={0}
                onClick={() => { setActiveFolder(folder.id) }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  setActiveFolder(folder.id)
                }}
              >
                {folder.name}
                {/* 删除按钮嵌在胶囊里，用 span + role 避免 button 嵌套 button。 */}
                <span
                  className={css.papersFolderDelete}
                  role="button"
                  tabIndex={0}
                  aria-label={t('papers.deleteFolder')}
                  title={t('papers.deleteFolder')}
                  onClick={(event) => { event.stopPropagation(); deleteFolder(folder) }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    event.stopPropagation()
                    deleteFolder(folder)
                  }}
                >
                  ×
                </span>
              </span>
            ))}
          </div>
          {(activeTranslations.length > 0 || translationNotice !== null) && (
            <section className={css.translationStatusPanel} aria-live="polite">
              {activeTranslations.map((paper) => {
                const key = paperKey(paper)
                const startedAt = translationStartedAt[key] ?? translationClock
                const seconds = Math.max(0, Math.floor((translationClock - startedAt) / 1000))
                const progress = translationProgress[key]
                const percent = progress?.percent ?? null
                const rawPhase = progress?.phase?.trim() || ''
                const phase = rawPhase.startsWith('installing-runtime')
                  ? t('papers.translationInstalling')
                  : rawPhase === '' || rawPhase === 'preparing' || rawPhase === 'translating'
                    ? t('papers.translationRunning')
                    : rawPhase
                return (
                  <div key={key} className={css.translationProgressItem}>
                    <div className={css.translationProgressHead}>
                      <strong title={paper.title}>{paper.title}</strong>
                      <span>
                        {phase}
                        {percent !== null ? ` ${percent}%` : ''}
                        {' · '}
                        {t('papers.translationElapsed', { seconds })}
                      </span>
                    </div>
                    <div className={css.translationProgressTrack} aria-hidden="true">
                      <span
                        className={css.translationProgressBar}
                        data-determinate={percent !== null || undefined}
                        style={percent !== null ? { width: `${percent}%` } : undefined}
                      />
                    </div>
                    <button
                      type="button"
                      className={css.translationCancelButton}
                      onClick={() => { cancelTranslate(paper) }}
                    >
                      {t('papers.cancelTranslation')}
                    </button>
                  </div>
                )
              })}
              {translationNotice !== null && (
                <div className={css.translationNotice} data-status={translationNotice.status}>
                  <div className={css.translationNoticeText}>
                    <strong>{translationNotice.title}</strong>
                    <span>{t(translationNotice.status === 'cached'
                      ? 'papers.translationCached'
                      : 'papers.translationCancelled')}</span>
                  </div>
                  <div className={css.translationNoticeActions}>
                    {noticePaper !== undefined && (
                      <button
                        type="button"
                        className={css.translationCancelButton}
                        onClick={() => { startTranslate(noticePaper, true) }}
                      >
                        {t('papers.restartTranslation')}
                      </button>
                    )}
                    <button
                      type="button"
                      className={css.translationDismissButton}
                      aria-label={t('papers.translationDismiss')}
                      onClick={() => { setTranslationNotice(null) }}
                    >
                      ×
                    </button>
                  </div>
                </div>
              )}
            </section>
          )}
          {visible.length === 0 ? (
            <p className={css.hint}>{t('papers.noMatch')}</p>
          ) : (
            <div className={css.papersGrid} data-view={viewMode}>
              {visible.map((paper) => {
                const open = Boolean(expanded[paperKey(paper)])
                const selected = selectedIds.has(paperKey(paper))
                const openReader = (): void => {
                  if (selectMode) {
                    toggleSelected(paperKey(paper))
                    return
                  }
                  setExpanded(prev => ({ ...prev, [paperKey(paper)]: true }))
                }
                return (
                  <article
                    key={paperKey(paper)}
                    className={css.paperCard}
                    data-library
                    data-open={open || undefined}
                    data-selected={(selectMode && selected) || undefined}
                  >
                    <div
                      className={css.paperCardMain}
                      role="button"
                      tabIndex={0}
                      title={(() => {
                        const authors = paper.authors.length > 0 ? `${paper.authors.join('，')}\n` : ''
                        const status = t(paper.pdfPath === undefined ? 'papers.filterMissing' : 'papers.filterReady')
                        return `${paper.title}\n${authors}${status} · ${relativePaperTime(paper.addedAt, t)}`
                      })()}
                      aria-pressed={selectMode ? selected : undefined}
                      aria-label={selectMode
                        ? `${t(selected ? 'papers.unselect' : 'papers.select')}：${paper.title}`
                        : `${t('papers.readPdf')}：${paper.title}`}
                      onClick={openReader}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return
                        event.preventDefault()
                        openReader()
                      }}
                    >
                      <PaperCardFront
                        paper={paper}
                        busy={!selectMode && open}
                        selecting={selectMode}
                        selected={selected}
                        t={t}
                        translating={translatingIds.has(paperKey(paper))}
                        summarizing={summarizingIds.has(paperKey(paper))}
                        onTranslate={() => { startTranslate(paper) }}
                        onSummarize={() => { startSummarize(paper) }}
                      />
                    </div>
                    {!selectMode && (
                      <div className={css.paperCardActions} data-favorite={paper.favorite === true || undefined}>
                        <button
                          type="button"
                          className={css.paperCardAction}
                          data-active={paper.favorite === true || undefined}
                          aria-label={t(paper.favorite === true ? 'papers.unfavorite' : 'papers.favorite')}
                          title={t(paper.favorite === true ? 'papers.unfavorite' : 'papers.favorite')}
                          onClick={() => { toggleFavorite(paper) }}
                        >
                          <ToolIcon name="bookmark" />
                        </button>
                        <div className={css.paperCardMenuWrap}>
                          <button
                            type="button"
                            className={css.paperCardAction}
                            aria-label={t('papers.cardMenu')}
                            title={t('papers.cardMenu')}
                            aria-expanded={cardMenuId === paperKey(paper)}
                            onClick={() => {
                              setCardMenuId(cardMenuId === paperKey(paper) ? null : paperKey(paper))
                            }}
                          >
                            <span className={css.paperCardMenuDots} aria-hidden="true">⋯</span>
                          </button>
                          {cardMenuId === paperKey(paper) && (
                            <div className={css.paperCardMenu} role="menu">
                              <button
                                type="button"
                                role="menuitem"
                                className={css.papersMenuItem}
                                onClick={() => { togglePin(paper) }}
                              >
                                {t(extraOf(paper).pinned === true ? 'papers.unpin' : 'papers.pin')}
                              </button>
                              {/* 「标记状态」「移动到文件夹」已按需求移除：菜单只留置顶 / AI 摘要 / 一键全本翻译 / 删除。 */}
                              <div className={css.paperCardSubmenuWrap}>
                                <button type="button" role="menuitem" className={css.papersMenuItem}>
                                  {t('papers.moveToFolder')}
                                  <span className={css.paperCardMenuChevron} aria-hidden="true">›</span>
                                </button>
                                <div className={css.paperCardSubmenu} role="menu">
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className={css.paperCardSubmenuItem}
                                    data-active={extraOf(paper).folderId === undefined || undefined}
                                    onClick={() => { moveToFolder(paper, null) }}
                                  >
                                    <span className={css.paperCardSubmenuDot} aria-hidden="true" />
                                    {t('papers.folderNone')}
                                  </button>
                                  {folders.map(folder => (
                                    <button
                                      key={folder.id}
                                      type="button"
                                      role="menuitem"
                                      className={css.paperCardSubmenuItem}
                                      data-active={extraOf(paper).folderId === folder.id || undefined}
                                      onClick={() => { moveToFolder(paper, folder.id) }}
                                    >
                                      <span className={css.paperCardSubmenuDot} aria-hidden="true" />
                                      {folder.name}
                                    </button>
                                  ))}
                                </div>
                              </div>
                              <button
                                type="button"
                                role="menuitem"
                                className={css.papersMenuItem}
                                onClick={() => { summarizeFromMenu(paper) }}
                              >
                                {t('papers.aiSummary')}
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                className={css.papersMenuItem}
                                onClick={() => { translateWholeFromMenu(paper) }}
                              >
                                {t(extraOf(paper).translatedAt === undefined
                                  ? 'papers.translateWhole'
                                  : 'papers.retranslateWhole')}
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                className={css.papersMenuItem}
                                data-danger
                                onClick={() => { setCardMenuId(null); removeEntry(paper) }}
                              >
                                {t('papers.delete')}
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                    {!selectMode && open && (
                      <PaperPdfSection
                        paper={paper}
                        fetchPaperPdf={fetchPaperPdf}
                        updatePaper={updatePaper}
                        requestProjectSession={requestProjectSession ?? NO_SESSION_REQUEST}
                        requestProjectImage={requestProjectImage}
                        prepareSession={prepareSession}
                        sessionTitle={sessionTitle ?? ''}
                        projectSession={projectSession ?? EMPTY_SESSION}
                        onError={setActionError}
                        onUploaded={refreshPapers}
                        onNotesChanged={() => { setNotesRefresh((value) => value + 1) }}
                        jumpRequest={readerJump?.key === paperKey(paper) ? readerJump : undefined}
                        openOnMount
                        onClose={() => {
                          setExpanded(prev => ({ ...prev, [paperKey(paper)]: false }))
                        }}
                        t={t}
                      />
                    )}
                  </article>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}
