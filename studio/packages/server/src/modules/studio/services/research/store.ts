/**
 * Research workspace store.
 *
 * One JSON document per profile at `<profile home>/.research/state.json`, plus an
 * append-only `events.jsonl` so the ledger view and the agent share one history.
 *
 * Deliberately files, not sqlite: the agent works with ordinary file tools, so
 * anything it writes is visible to the panel and vice versa. Every write is
 * serialised per profile and lands via tmp+rename so a crash cannot leave a
 * half-written document behind.
 */
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { resolveProfileFilePath } from '../files/file-provider'
import { withFileLock } from './lock'

export const RESEARCH_COLLECTIONS = [
  'papers',
  'experiments',
  'figures',
  'ideas',
  'servers',
  'jobs',
  'venues',
  'subscriptions',
  'snapshots',
  'decks',
  'journal',
  'evidence',
  'knowledge',
  'folders',
  'runs',
] as const

export type ResearchCollection = typeof RESEARCH_COLLECTIONS[number]

/** The project's target venue (会议/期刊), set from the panel's venue picker. */
export interface ResearchVenueRef {
  id: string
  name: string
  series: string
  url: string
}

export interface ResearchProject {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  venue?: ResearchVenueRef | null
}

/** 文献库里的一个文件夹（用户自建的分类，论文通过 folderId 归属）。 */
export interface ResearchFolder {
  id: string
  projectId: string
  name: string
  createdAt: number
}

export interface ResearchPaper {
  id: string
  projectId: string
  /** 所属文件夹；未分类时缺省。 */
  folderId?: string
  title: string
  authors: string
  year: string
  venue: string
  doi: string
  url: string
  arxivId: string
  /** PubMed id, when the record came from or resolves to PubMed. */
  pmid?: string
  score: number
  status: 'new' | 'reading' | 'read'
  notes: string
  /** Labels edited from the panel; absent on records that never had them. */
  tags?: string[]
  addedAt: number
  /** Absolute path of the downloaded PDF, absent until it is fetched. */
  pdfPath?: string
  /** Absolute path of the extracted full text (markdown, page-delimited). */
  fulltextPath?: string
  /** Character count of the extracted text, so the panel can show a size hint. */
  fulltextChars?: number
  /** Structured AI summary produced from the full text. */
  aiSummary?: string
  /** 卡片上的收藏（书签）标记。 */
  favorite?: boolean
  /** 置顶：列表里排在其它文献前面。 */
  pinned?: boolean
  /** 整篇翻译完成的时间戳；有值说明已经有译本。 */
  translatedAt?: number
  /** Structured notes; `notes` stays as the legacy free-text field. */
  noteBlocks?: PaperNoteBlock[]
}

/** One line of a highlight, in 0-1 page coordinates so zoom never breaks it. */
export interface PaperHighlightRect {
  x: number
  y: number
  w: number
  h: number
}

/** One freehand stroke, points in 0-1 page coordinates. */
export interface PaperInkStroke {
  color: string
  width: number
  points: Array<{ x: number; y: number }>
}

/** Where a note block points inside the paper. */
export interface PaperNoteAnchor {
  /** 1-based page number, when the block came from a highlight. */
  page?: number
  /** The sentence a highlight was taken from. */
  quote?: string
  /** One rect per visual line the selection covered. */
  rects?: PaperHighlightRect[]
  /** Freehand strokes, for blocks of kind `ink`. */
  strokes?: PaperInkStroke[]
}

/**
 * One note block. `notes` remains the legacy free-text blob so older records
 * keep rendering; new writes go here, which is what makes a note able to point
 * at a page and be lifted into the knowledge layer later.
 */
export interface PaperNoteBlock {
  id: string
  kind: 'note' | 'highlight' | 'question' | 'claim' | 'gap' | 'ink'
  content: string
  /** 高亮颜色，`#rrggbbaa`；缺省时前端用默认黄。 */
  color?: string
  /** 读者对这条高亮/笔记写的一句话批注。 */
  comment?: string
  /** 只隐藏色块，保留批注与「笔记」标记。 */
  highlightHidden?: boolean
  anchor?: PaperNoteAnchor
  createdAt: number
}

/**
 * What a knowledge row is. The first five are analysis *outputs* (one per skill,
 * following the structure obsidian-vault-mcp uses); the last two are the claims
 * and gaps a reader distils by hand.
 */
export type ResearchKnowledgeKind =
  | 'full_read'
  | 'literature_review'
  | 'passage_qa'
  | 'figure_qa'
  | 'concept'
  | 'claim'
  | 'gap'

/** A claim, gap or analysis output distilled out of a paper, carrying its source. */
export interface ResearchKnowledge {
  id: string
  projectId: string
  kind: ResearchKnowledgeKind
  statement: string
  /** The paper this came from. */
  paperId?: string
  /** The note block inside that paper. */
  blockId?: string
  /** 0-10, how confident the user is. */
  confidence?: number
  tags?: string[]
  createdAt: number
}

export interface ResearchMetric {
  name: string
  value: string
  unit: string
  better: 'max' | 'min'
}

export interface ResearchExperiment {
  id: string
  projectId: string
  name: string
  config: string
  metrics: ResearchMetric[]
  conclusion: string
  status: 'planned' | 'running' | 'done' | 'failed'
  at: number
}

export interface ResearchFigure {
  id: string
  projectId: string
  name: string
  path: string
  caption: string
  insertedInto: string
  origin: 'agent' | 'manual'
  at: number
}

export interface ResearchIdea {
  id: string
  projectId: string
  kind: 'idea' | 'decision' | 'result'
  text: string
  at: number
  parentId: string
  /** Set when the user closed this lane with a reason (a "documented No"). */
  closedAt?: number
  closeReason?: string
}

/** A pin/decline mark on one change-log moment (`targetEventId` = revision). */
export interface ResearchMomentMark {
  targetEventId: string
  pinned: boolean
  note: string
  at: number
}

/** One user-declared eureka (顿悟): the moment they decided a road was it. */
export interface ResearchEurekaDeclaration {
  id: string
  title: string
  ideaId: string | null
  projectId: string | null
  at: number
}

/** One declared mainline ref (`project:<id>` or `idea:<id>`). */
export interface ResearchMainlineRef {
  lineId: string
  declaredAt: number
}

export interface ResearchServer {
  id: string
  projectId: string
  host: string
  user: string
  port: number
  status: 'unknown' | 'online' | 'offline'
  lastCheckedAt: number
  note: string
}

/** The observable contract from job-lifecycle: no silent truncation. */
export type ResearchJobState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'unknown'

export interface ResearchJob {
  id: string
  projectId: string
  serverId: string
  name: string
  command: string
  state: ResearchJobState
  submittedAt: number
  endedAt: number
  logPath: string
  exitCode: number | null
  /** Remote pid, used to tell running from exited on refresh. */
  pid?: string
  /** Human-readable last observation from the host. */
  note?: string
}

export interface ResearchVenue {
  id: string
  projectId: string
  name: string
  ccf: 'A' | 'B' | 'C' | ''
  deadline: string
  starred: boolean
}

export interface ResearchSubscription {
  id: string
  projectId: string
  query: string
  lastCheckedAt: number
  seenIds: string[]
}

/** A copy of `main.tex` kept on disk so a bad edit can be rolled back. */
export interface ResearchSnapshot {
  id: string
  projectId: string
  label: string
  at: number
  file: string
  bytes: number
}

/** A seminar deck generated from the project's papers and ledger. */
export interface ResearchDeck {
  id: string
  projectId: string
  title: string
  path: string
  at: number
  paperIds: string[]
  pages: number
}

/**
 * One hand-written journal line (the researcher's own L2 note). Kept flat so
 * the generic item endpoints can read and delete it.
 */
export interface ResearchJournalEntry {
  id: string
  projectId: string
  /** Owning idea lane, '' when the line is not tied to one. */
  ideaId: string
  text: string
  /** Self-reported valence / arousal (-2..2, 0 = 未填). */
  valence: number
  arousal: number
  /** The brief's boundary question this line answers, '' when none. */
  questionKind: string
  questionLineId: string
  at: number
}

/**
 * One declared evidence edge. Reads are folded from these rows (see
 * `evidenceGraphView`); the retraction is a flag, not a delete, so the
 * declaration history survives a retraction.
 */
export interface ResearchEvidenceEdge {
  id: string
  projectId: string
  ideaId: string
  claimId: string
  /** Stable identity of the assertion: `<rel>|<src>|<dst>`. */
  dedupKey: string
  rel: string
  src: string
  dst: string
  srcLabel: string
  dstLabel: string
  note: string
  at: number
  /** Set when the edge was retracted (the row stays). */
  retractedAt?: number
  retractReason?: string
}

/** Stages of the first Research Run MVP. */
export type ResearchRunStage = 'scope' | 'literature' | 'evidence' | 'hypothesis'

/**
 * One row in a Research Run's evidence table. The quote and page are kept
 * separate so the UI can send the reader back to the source instead of showing
 * an unsourced model claim.
 */
export interface ResearchRunEvidence {
  id: string
  paperId: string
  paperTitle: string
  claim: string
  quote: string
  page: number | null
  section: string
  support: 'supports' | 'contradicts' | 'mixed' | 'context'
  confidence: number
  note: string
  createdAt: number
  updatedAt: number
}

export interface ResearchRunClaim {
  id: string
  text: string
  status: 'supported' | 'contradicted' | 'mixed' | 'gap'
  evidenceIds: string[]
  confidence: number
  note: string
  createdAt: number
  updatedAt: number
}

export interface ResearchRunApproval {
  stage: ResearchRunStage
  at: number
  note: string
}

export type ResearchRunStatus = 'running' | 'waiting_approval' | 'completed' | 'cancelled'

/** A resumable literature -> evidence -> hypothesis run for one project. */
export interface ResearchRun {
  id: string
  projectId: string
  title: string
  question: string
  stage: ResearchRunStage
  status: ResearchRunStatus
  paperIds: string[]
  evidence: ResearchRunEvidence[]
  claims: ResearchRunClaim[]
  approvals: ResearchRunApproval[]
  createdAt: number
  updatedAt: number
}

export interface ResearchCollections {
  papers: ResearchPaper[]
  folders: ResearchFolder[]
  experiments: ResearchExperiment[]
  figures: ResearchFigure[]
  ideas: ResearchIdea[]
  servers: ResearchServer[]
  jobs: ResearchJob[]
  venues: ResearchVenue[]
  subscriptions: ResearchSubscription[]
  snapshots: ResearchSnapshot[]
  decks: ResearchDeck[]
  journal: ResearchJournalEntry[]
  evidence: ResearchEvidenceEdge[]
  knowledge: ResearchKnowledge[]
  runs: ResearchRun[]
}

export interface ResearchStore extends ResearchCollections {
  version: number
  projects: ResearchProject[]
  updatedAt: number
  /** The lane the user declared as the mainline; null/absent until declared. */
  mainline?: ResearchMainlineRef | null
  /** Reflog of mainline declarations, newest first (capped). */
  mainlineHistory?: ResearchMainlineRef[]
  /** Pin/decline marks on change-log moments. */
  momentMarks?: ResearchMomentMark[]
  /** User-declared eurekas, newest first. */
  eurekas?: ResearchEurekaDeclaration[]
}

/** Who wrote a change-log line. Mirrors the panel's actor badges. */
export type ResearchActorKind = 'user' | 'agent' | 'subagent' | 'module' | 'system'

export interface ResearchActor {
  kind: ResearchActorKind
  id: string
}

/**
 * One change-log line. It doubles as the panel's ledger `EventRecord`, so the
 * ledger view prints it without inventing an actor or a timestamp: `action`,
 * `actor`, `refs` and `payload` are written at append time. A line from an
 * older build may carry only `at`/`revision`/`reason`; {@link readChangeLog}
 * fills the rest in on read.
 */
export interface ResearchChange {
  /** Row identity, stable once written. */
  id: string
  /** `at` as ISO, which is what the timeline prints. */
  ts: string
  at: number
  revision: number
  /** The internal reason this write used (`project.updated`, …). */
  reason: string
  /** What the timeline shows as the action: the reason unless overridden. */
  action: string
  actor: ResearchActor
  refs: Record<string, string>
  payload: Record<string, unknown>
  /** The project this write was scoped to, when one applies. */
  projectId?: string
}

/** What a caller may add to the change-log line of one write. */
export interface ResearchWriteMeta {
  /** The project the write belongs to; derived from the mutator's result otherwise. */
  projectId?: string
  action?: string
  actor?: ResearchActor
  refs?: Record<string, string>
  payload?: Record<string, unknown>
}

const STORE_VERSION = 2
const EVENTS_LIMIT = 4000
const emitter = new EventEmitter()
const locks = new Map<string, Promise<unknown>>()

export function isResearchCollection(value: string): value is ResearchCollection {
  return (RESEARCH_COLLECTIONS as readonly string[]).includes(value)
}

export function emptyStore(): ResearchStore {
  return {
    version: STORE_VERSION,
    projects: [],
    papers: [],
    folders: [],
    experiments: [],
    figures: [],
    ideas: [],
    servers: [],
    jobs: [],
    venues: [],
    subscriptions: [],
    snapshots: [],
    decks: [],
    journal: [],
    evidence: [],
    knowledge: [],
    runs: [],
    updatedAt: 0,
  }
}

export function researchRoot(profile?: string): string {
  return resolveProfileFilePath('.research', profile)
}

function statePath(profile?: string): string {
  return path.join(researchRoot(profile), 'state.json')
}

export function eventsPath(profile?: string): string {
  return path.join(researchRoot(profile), 'events.jsonl')
}

/** Fill in anything an older or hand-edited document may be missing. */
function normalizeStore(input: unknown): ResearchStore {
  const base = emptyStore()
  if (!input || typeof input !== 'object') return base
  const raw = input as Record<string, unknown>
  const store: ResearchStore = {
    ...base,
    version: typeof raw.version === 'number' ? raw.version : STORE_VERSION,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    projects: Array.isArray(raw.projects) ? (raw.projects as ResearchProject[]) : [],
  }
  for (const collection of RESEARCH_COLLECTIONS) {
    const value = raw[collection]
    store[collection] = Array.isArray(value) ? (value as never) : ([] as never)
  }
  store.runs = store.runs.map(run => ({
    ...run,
    evidence: Array.isArray(run.evidence) ? run.evidence : [],
    claims: Array.isArray(run.claims) ? run.claims : [],
    approvals: Array.isArray(run.approvals) ? run.approvals : [],
  }))
  const asRef = (value: unknown): ResearchMainlineRef | null => {
    if (!value || typeof value !== 'object') return null
    const row = value as Record<string, unknown>
    if (typeof row.lineId !== 'string' || typeof row.declaredAt !== 'number') return null
    return { lineId: row.lineId, declaredAt: row.declaredAt }
  }
  store.momentMarks = Array.isArray(raw.momentMarks)
    ? (raw.momentMarks as ResearchMomentMark[]).filter(item => item && typeof item.targetEventId === 'string')
    : []
  store.eurekas = Array.isArray(raw.eurekas)
    ? (raw.eurekas as ResearchEurekaDeclaration[]).filter(item => item && typeof item.id === 'string' && typeof item.title === 'string')
    : []
  store.mainline = asRef(raw.mainline)
  store.mainlineHistory = Array.isArray(raw.mainlineHistory)
    ? (raw.mainlineHistory.map(asRef).filter((item): item is ResearchMainlineRef => item !== null))
    : []
  return store
}

export async function readStore(profile?: string): Promise<ResearchStore> {
  try {
    const text = await fs.readFile(statePath(profile), 'utf-8')
    return normalizeStore(JSON.parse(text))
  } catch {
    return emptyStore()
  }
}

function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  const next = previous.then(task, task)
  locks.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  )
  return next
}

/** Stable pointer so the agent can find the active research root without guessing. */
export const RESEARCH_ROOT_POINTER = path.join(os.homedir(), '.ekko', 'research-root')

async function writeRootPointer(profile?: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(RESEARCH_ROOT_POINTER), { recursive: true })
    await fs.writeFile(RESEARCH_ROOT_POINTER, `${researchRoot(profile)}\n`, 'utf-8')
  } catch {
    // A missing pointer only affects the agent tools' default guess.
  }
}

async function writeStoreFile(profile: string | undefined, store: ResearchStore): Promise<void> {
  const dir = researchRoot(profile)
  await fs.mkdir(dir, { recursive: true })
  const target = statePath(profile)
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf-8')
  await fs.rename(tmp, target)
  await writeRootPointer(profile)
}

async function appendEventRecord(profile: string | undefined, change: ResearchChange): Promise<void> {
  const dir = researchRoot(profile)
  await fs.mkdir(dir, { recursive: true })
  const file = eventsPath(profile)
  await fs.appendFile(file, `${JSON.stringify(change)}\n`, 'utf-8')
  try {
    const stat = await fs.stat(file)
    if (stat.size > 2 * 1024 * 1024) {
      const text = await fs.readFile(file, 'utf-8')
      const lines = text.trimEnd().split('\n').slice(-EVENTS_LIMIT)
      await fs.writeFile(file, `${lines.join('\n')}\n`, 'utf-8')
    }
  } catch {
    // Trimming is best effort; a large ledger must never break a write.
  }
}

/** Reasons whose write takes something away: the timeline marks them. */
function isDestructiveReason(reason: string): boolean {
  return reason.endsWith('.deleted') || reason.endsWith('.retracted')
}

function textField(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * The change-log line of one write. The project scope comes from the caller
 * when it named one, otherwise from the mutator's own result: a row carries its
 * `projectId`, and a freshly created thing is its own project.
 */
function changeOf(at: number, reason: string, result: unknown, meta?: ResearchWriteMeta): ResearchChange {
  const record: Record<string, unknown> = result !== null && typeof result === 'object' && !Array.isArray(result)
    ? result as Record<string, unknown>
    : {}
  const id = textField(record, 'id')
  const projectId = (meta?.projectId ?? '').trim()
    || textField(record, 'projectId')
    || (reason.endsWith('.created') ? id : '')
  const refs: Record<string, string> = { ...(meta?.refs ?? {}) }
  if (projectId !== '' && refs.projectId === undefined) refs.projectId = projectId
  if (id !== '' && refs.id === undefined) refs.id = id
  const payload: Record<string, unknown> = { ...(meta?.payload ?? {}) }
  const title = textField(record, 'title') || textField(record, 'name')
  if (title !== '' && payload.title === undefined) payload.title = title.slice(0, 120)
  if (isDestructiveReason(reason) && payload.destructive === undefined) payload.destructive = true
  if (typeof result === 'number' && payload.count === undefined) payload.count = result
  return {
    id: newId('evt'),
    ts: new Date(at).toISOString(),
    at,
    revision: at,
    reason,
    action: meta?.action ?? reason,
    actor: meta?.actor ?? { kind: 'user', id: '' },
    refs,
    payload,
    ...(projectId === '' ? {} : { projectId }),
  }
}

/**
 * Read-modify-write under a per-profile lock. The mutator may be async and its
 * return value is handed back so callers can report what changed.
 */
export async function updateStore<T>(
  profile: string | undefined,
  reason: string,
  mutate: (store: ResearchStore) => T | Promise<T>,
  meta?: ResearchWriteMeta,
): Promise<T> {
  const key = profile || 'default'
  const dir = researchRoot(profile)
  return withLock(key, () => withFileLock(dir, async () => {
    const store = await readStore(profile)
    const result = await mutate(store)
    store.updatedAt = Date.now()
    await writeStoreFile(profile, store)
    const change = changeOf(store.updatedAt, reason, result, meta)
    await appendEventRecord(profile, change)
    emitter.emit('change', change)
    return result
  }))
}

export function subscribeResearchEvents(listener: (change: ResearchChange) => void): () => void {
  emitter.on('change', listener)
  return () => {
    emitter.off('change', listener)
  }
}

/** Fill in whatever an older or hand-edited line does not carry. */
function normalizeChange(parsed: Partial<ResearchChange> & { at: number }): ResearchChange {
  const at = parsed.at
  const reason = typeof parsed.reason === 'string' && parsed.reason !== '' ? parsed.reason : 'research.updated'
  const actor = parsed.actor !== undefined && parsed.actor !== null && typeof parsed.actor === 'object'
    && typeof (parsed.actor as ResearchActor).kind === 'string'
    ? parsed.actor as ResearchActor
    : { kind: 'system' as const, id: '' }
  return {
    id: typeof parsed.id === 'string' && parsed.id !== '' ? parsed.id : `evt_${at.toString(36)}`,
    ts: typeof parsed.ts === 'string' && !Number.isNaN(Date.parse(parsed.ts)) ? parsed.ts : new Date(at).toISOString(),
    at,
    revision: typeof parsed.revision === 'number' ? parsed.revision : at,
    reason,
    action: typeof parsed.action === 'string' && parsed.action !== '' ? parsed.action : reason,
    actor,
    refs: parsed.refs !== undefined && parsed.refs !== null && typeof parsed.refs === 'object' ? parsed.refs : {},
    payload: parsed.payload !== undefined && parsed.payload !== null && typeof parsed.payload === 'object' ? parsed.payload : {},
    ...(typeof parsed.projectId === 'string' && parsed.projectId !== '' ? { projectId: parsed.projectId } : {}),
  }
}

/**
 * Read the tail of the change log. `projectId` keeps only the lines a write
 * declared itself scoped to, which is what the ledger's "current project"
 * range asks for.
 */
export async function readChangeLog(profile?: string, limit = 200, projectId = ''): Promise<ResearchChange[]> {
  try {
    const text = await fs.readFile(eventsPath(profile), 'utf-8')
    const scope = projectId.trim()
    // A scoped read cannot stop at `limit` lines: other projects' lines would
    // eat the window before the filter ever runs.
    const window = scope === '' ? limit : Math.min(limit * 8, EVENTS_LIMIT)
    const lines = text.trimEnd().split('\n').slice(-window)
    const out: ResearchChange[] = []
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Partial<ResearchChange> & { at?: unknown }
        if (typeof parsed?.at !== 'number') continue
        const row = normalizeChange(parsed as Partial<ResearchChange> & { at: number })
        if (scope !== '' && row.projectId !== scope) continue
        out.push(row)
      } catch {
        // Skip a torn line rather than failing the whole ledger.
      }
    }
    return scope === '' ? out : out.slice(-limit)
  } catch {
    return []
  }
}

let counter = 0

export function newId(prefix: string): string {
  counter = (counter + 1) % 1_000_000
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** Typed access to a collection for the generic item endpoints. */
export function collectionItems(
  store: ResearchStore,
  collection: ResearchCollection,
): Array<Record<string, unknown> & { id: string }> {
  return store[collection] as unknown as Array<Record<string, unknown> & { id: string }>
}

export function projectScoped(collection: ResearchCollection): boolean {
  return collection !== 'venues'
}
