import { newId, readStore, updateStore, type ResearchRun, type ResearchRunEvidence, type ResearchRunStage } from './store'

const RUN_STAGES: ResearchRunStage[] = ['scope', 'literature', 'evidence', 'hypothesis']
const SUPPORT_VALUES = new Set<ResearchRunEvidence['support']>(['supports', 'contradicts', 'mixed', 'context'])

export interface CreateRunInput {
  projectId: string
  title?: string
  question: string
  paperIds?: string[]
}

export interface EvidenceInput {
  paperId?: string
  paperTitle?: string
  claim: string
  quote?: string
  page?: number | null
  section?: string
  support?: ResearchRunEvidence['support']
  confidence?: number
  note?: string
}

function clean(value: unknown, max = 4000): string {
  return String(value ?? '').trim().slice(0, max)
}

function normalizePaperIds(input: unknown): string[] {
  return Array.isArray(input)
    ? [...new Set(input.map(value => clean(value, 120)).filter(Boolean))]
    : []
}

function nextStage(stage: ResearchRunStage): ResearchRunStage | null {
  const index = RUN_STAGES.indexOf(stage)
  return index >= 0 && index < RUN_STAGES.length - 1 ? RUN_STAGES[index + 1] : null
}

async function runFor(profile: string, id: string): Promise<{ store: Awaited<ReturnType<typeof readStore>>; run: ResearchRun }> {
  const store = await readStore(profile)
  const run = store.runs.find(row => row.id === id)
  if (!run) throw new Error('research_run_not_found')
  return { store, run }
}

export async function listRuns(profile: string, projectId = ''): Promise<ResearchRun[]> {
  const store = await readStore(profile)
  const rows = Array.isArray(store.runs) ? store.runs : []
  return rows
    .filter(run => projectId === '' || run.projectId === projectId)
    .slice()
    .sort((left, right) => right.updatedAt - left.updatedAt)
}

export async function getRun(profile: string, id: string): Promise<ResearchRun> {
  return (await runFor(profile, id)).run
}

export async function createRun(profile: string, input: CreateRunInput): Promise<ResearchRun> {
  const projectId = clean(input.projectId, 120)
  const question = clean(input.question, 2000)
  if (projectId === '') throw new Error('projectId is required')
  if (question === '') throw new Error('research question is required')

  const store = await readStore(profile)
  if (!store.projects.some(project => project.id === projectId)) throw new Error('research_project_not_found')
  const requested = normalizePaperIds(input.paperIds)
  const paperIds = requested.filter(id => store.papers.some(paper => paper.id === id))
  const now = Date.now()
  const run: ResearchRun = {
    id: newId('run'),
    projectId,
    title: clean(input.title, 160) || question.slice(0, 80),
    question,
    stage: 'evidence',
    status: 'running',
    paperIds,
    evidence: [],
    approvals: [],
    createdAt: now,
    updatedAt: now,
  }
  await updateStore(profile, 'run.created', draft => {
    draft.runs.push(run)
    draft.journal.push({
      id: newId('journal'),
      projectId,
      ideaId: '',
      text: `Research Run created: ${run.title}\nQuestion: ${question}`,
      valence: 0,
      arousal: 0,
      questionKind: '',
      questionLineId: '',
      at: now,
    })
    return run
  }, { projectId, actor: { kind: 'user', id: 'workbench' }, action: 'run.created' })
  return run
}

export async function removeRun(profile: string, id: string): Promise<void> {
  await updateStore(profile, 'run.deleted', draft => {
    const before = draft.runs.length
    draft.runs = draft.runs.filter(row => row.id !== id)
    if (draft.runs.length === before) throw new Error('research_run_not_found')
  }, { actor: { kind: 'user', id: 'workbench' }, action: 'run.deleted' })
}

export async function updateRun(
  profile: string,
  id: string,
  patch: { title?: string; question?: string; stage?: ResearchRunStage; status?: ResearchRun['status']; paperIds?: unknown },
): Promise<ResearchRun> {
  const now = Date.now()
  return updateStore(profile, 'run.updated', draft => {
    const run = draft.runs.find(row => row.id === id)
    if (!run) throw new Error('research_run_not_found')
    if (patch.title !== undefined) run.title = clean(patch.title, 160) || run.title
    if (patch.question !== undefined && clean(patch.question, 2000) !== '') run.question = clean(patch.question, 2000)
    if (patch.stage !== undefined && RUN_STAGES.includes(patch.stage)) run.stage = patch.stage
    if (patch.status !== undefined) run.status = patch.status
    if (patch.paperIds !== undefined) {
      run.paperIds = normalizePaperIds(patch.paperIds).filter(paperId => draft.papers.some(paper => paper.id === paperId))
    }
    run.updatedAt = now
    return run
  }, { actor: { kind: 'user', id: 'workbench' }, action: 'run.updated' })
}

export async function addEvidence(profile: string, runId: string, input: EvidenceInput): Promise<ResearchRunEvidence> {
  const claim = clean(input.claim, 2000)
  if (claim === '') throw new Error('claim is required')
  const now = Date.now()
  return updateStore(profile, 'run.evidence.added', draft => {
    const run = draft.runs.find(row => row.id === runId)
    if (!run) throw new Error('research_run_not_found')
    const paperId = clean(input.paperId, 120)
    const paper = draft.papers.find(row => row.id === paperId)
    const evidence: ResearchRunEvidence = {
      id: newId('ev'),
      paperId,
      paperTitle: clean(input.paperTitle, 500) || paper?.title || '',
      claim,
      quote: clean(input.quote, 4000),
      page: typeof input.page === 'number' && Number.isFinite(input.page) ? Math.max(1, Math.round(input.page)) : null,
      section: clean(input.section, 300),
      support: SUPPORT_VALUES.has(input.support || 'supports') ? (input.support || 'supports') : 'supports',
      confidence: typeof input.confidence === 'number' && Number.isFinite(input.confidence)
        ? Math.max(0, Math.min(1, input.confidence))
        : 0.5,
      note: clean(input.note, 2000),
      createdAt: now,
      updatedAt: now,
    }
    run.evidence.push(evidence)
    if (paperId !== '' && !run.paperIds.includes(paperId)) run.paperIds.push(paperId)
    run.updatedAt = now
    return evidence
  }, { projectId: input.paperId ? undefined : undefined, actor: { kind: 'agent', id: 'research-run' }, action: 'run.evidence.added' })
}

export async function updateEvidence(
  profile: string,
  runId: string,
  evidenceId: string,
  input: EvidenceInput,
): Promise<ResearchRunEvidence> {
  const now = Date.now()
  return updateStore(profile, 'run.evidence.updated', draft => {
    const run = draft.runs.find(row => row.id === runId)
    if (!run) throw new Error('research_run_not_found')
    const evidence = run.evidence.find(row => row.id === evidenceId)
    if (!evidence) throw new Error('research_evidence_not_found')
    if (input.claim !== undefined && clean(input.claim, 2000) !== '') evidence.claim = clean(input.claim, 2000)
    if (input.quote !== undefined) evidence.quote = clean(input.quote, 4000)
    if (input.page !== undefined) {
      evidence.page = typeof input.page === 'number' && Number.isFinite(input.page) ? Math.max(1, Math.round(input.page)) : null
    }
    if (input.section !== undefined) evidence.section = clean(input.section, 300)
    if (input.support !== undefined && SUPPORT_VALUES.has(input.support)) evidence.support = input.support
    if (typeof input.confidence === 'number' && Number.isFinite(input.confidence)) {
      evidence.confidence = Math.max(0, Math.min(1, input.confidence))
    }
    if (input.note !== undefined) evidence.note = clean(input.note, 2000)
    if (input.paperId !== undefined) {
      evidence.paperId = clean(input.paperId, 120)
      evidence.paperTitle = draft.papers.find(row => row.id === evidence.paperId)?.title || evidence.paperTitle
    }
    evidence.updatedAt = now
    run.updatedAt = now
    return evidence
  }, { actor: { kind: 'user', id: 'workbench' }, action: 'run.evidence.updated' })
}

export async function removeEvidence(profile: string, runId: string, evidenceId: string): Promise<void> {
  await updateStore(profile, 'run.evidence.removed', draft => {
    const run = draft.runs.find(row => row.id === runId)
    if (!run) throw new Error('research_run_not_found')
    const before = run.evidence.length
    run.evidence = run.evidence.filter(row => row.id !== evidenceId)
    if (run.evidence.length === before) throw new Error('research_evidence_not_found')
    run.updatedAt = Date.now()
  }, { actor: { kind: 'user', id: 'workbench' }, action: 'run.evidence.removed' })
}

export async function approveEvidence(profile: string, runId: string, note = ''): Promise<ResearchRun> {
  return updateStore(profile, 'run.evidence.approved', draft => {
    const run = draft.runs.find(row => row.id === runId)
    if (!run) throw new Error('research_run_not_found')
    if (run.evidence.length === 0) throw new Error('research_evidence_empty')
    const now = Date.now()
    run.approvals.push({ stage: 'evidence', at: now, note: clean(note, 1000) })
    run.stage = 'hypothesis'
    run.status = 'running'
    run.updatedAt = now
    return run
  }, { actor: { kind: 'user', id: 'workbench' }, action: 'run.evidence.approved' })
}

export async function advanceRun(profile: string, runId: string): Promise<ResearchRun> {
  return updateStore(profile, 'run.advanced', draft => {
    const run = draft.runs.find(row => row.id === runId)
    if (!run) throw new Error('research_run_not_found')
    if (run.stage === 'evidence') {
      if (!run.approvals.some(item => item.stage === 'evidence')) throw new Error('research_evidence_not_approved')
      run.stage = 'hypothesis'
      run.status = 'running'
    } else {
      const next = nextStage(run.stage)
      if (next === null) {
        run.status = 'completed'
      } else {
        run.stage = next
        run.status = 'running'
      }
    }
    run.updatedAt = Date.now()
    return run
  }, { actor: { kind: 'user', id: 'workbench' }, action: 'run.advanced' })
}

export function researchRunStages(): ResearchRunStage[] {
  return [...RUN_STAGES]
}
