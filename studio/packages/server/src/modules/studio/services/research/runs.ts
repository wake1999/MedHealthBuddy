import { assessMetricOutcome, inspectExperimentLog, parseMetricSchema, parseMetricValues, summarizeMetricSamples } from './experiment-log'
import { jobState, submitJob } from './ssh'
import {
  newId,
  readStore,
  updateStore,
  type ResearchRun,
  type ResearchRunClaim,
  type ResearchRunEvidence,
  type ResearchJob,
  type ResearchRunExperimentPlan,
  type ResearchRunBranch,
  type ResearchRunHypothesis,
  type ResearchRunResult,
  type ResearchRunStage,
} from './store'

const RUN_STAGES: ResearchRunStage[] = ['scope', 'literature', 'evidence', 'hypothesis', 'experiment', 'analysis']
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

export interface ClaimInput {
  text: string
  status?: ResearchRunClaim['status']
  evidenceIds?: string[]
  confidence?: number
  note?: string
}

function emptyBranch(now = Date.now()): ResearchRunBranch {
  return {
    id: newId('branch'),
    hypothesis: null,
    experimentPlan: null,
    experimentId: '',
    experimentJobId: '',
    jobInsight: null,
    result: null,
    stage: 'hypothesis',
    archivedAt: 0,
    frozenAt: 0,
    audit: [],
    createdAt: now,
    updatedAt: now,
  }
}

function ensureActiveBranch(run: ResearchRun): ResearchRunBranch {
  let branch = run.branches.find(row => row.id === run.activeBranchId)
  if (!branch) {
    branch = emptyBranch()
    run.branches.push(branch)
    run.activeBranchId = branch.id
  }
  return branch
}

function assertActiveEditable(run: ResearchRun): void {
  const branch = run.branches.find(row => row.id === run.activeBranchId)
  if (branch?.frozenAt) throw new Error('research_branch_frozen')
}

function mirrorActiveBranch(run: ResearchRun): ResearchRunBranch {
  const branch = ensureActiveBranch(run)
  branch.hypothesis = run.hypothesis
  branch.experimentPlan = run.experimentPlan
  branch.experimentId = run.experimentId
  branch.experimentJobId = run.experimentJobId
  branch.jobInsight = run.jobInsight
  branch.result = run.result
  branch.stage = run.stage
  branch.archivedAt = 0
  branch.updatedAt = Date.now()
  return branch
}

export interface HypothesisInput {
  text?: string
  independentVariable?: string
  dependentVariable?: string
  baselines?: string
  metric?: string
  expected?: string
  falsification?: string
  claimIds?: string[]
}

export interface ExperimentPlanInput {
  dataset?: string
  baselines?: string
  metrics?: string
  metricSchema?: string
  family?: string
  seeds?: string
  command?: string
  resources?: string
  stopCondition?: string
  successCriteria?: string
}

export interface ResultInput {
  outcome?: ResearchRunResult['outcome']
  summary?: string
  metrics?: string
  metricValues?: Record<string, number>
  metricSamples?: Record<string, number[]>
  baselineSamples?: Record<string, number[]>
  confirmedFinal?: boolean
  overrideReason?: string
  confidence?: number
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
    claims: [],
    hypothesis: null,
    experimentPlan: null,
    experimentId: '',
    experimentJobId: '',
    jobInsight: null,
    result: null,
    branches: [],
    activeBranchId: '',
    primaryMetricBranches: {},
    consolidationApproval: null,
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

interface WorkbenchEvidenceRow {
  id: string
  projectId?: string
  src?: string
  dstLabel?: string
  rel?: string
  note?: string
  retractedAt?: number
}

function noteField(note: string, name: string): string {
  const quoted = note.match(new RegExp(`${name}:\\s*"([\\s\\S]*?)"\\s*(?:\\||$)`))
  if (quoted) return quoted[1].trim()
  const plain = note.match(new RegExp(`${name}:\\s*([^|]+)`))
  return plain ? plain[1].trim() : ''
}

/**
 * Older workbench builds exposed only the generic evidence collection. Agents
 * that could not discover the Research API wrote rows there with a serialized
 * note. This converts those rows into first-class Run evidence without
 * inventing any new source text.
 */
export async function importWorkbenchEvidence(
  profile: string,
  runId: string,
  evidenceIds: string[] = [],
): Promise<{ imported: number; skipped: number; run: ResearchRun }> {
  const store = await readStore(profile)
  const run = store.runs.find(row => row.id === runId)
  if (!run) throw new Error('research_run_not_found')
  const wanted = new Set(evidenceIds.filter(Boolean))
  const rows = (store.evidence as WorkbenchEvidenceRow[]).filter(row => {
    if (wanted.size > 0) return wanted.has(row.id)
    return row.projectId === run.projectId
      && row.retractedAt === undefined
      && (!row.src || run.paperIds.length === 0 || run.paperIds.includes(String(row.src)))
  })
  const existing = new Set(run.evidence.map(row => `${row.paperId}|${row.quote}`))
  let imported = 0
  let skipped = 0
  for (const row of rows) {
    const note = String(row.note || '')
    const quote = noteField(note, 'quote')
    const pageText = noteField(note, 'page')
    const section = noteField(note, 'section')
    const supportText = noteField(note, 'support') || row.rel || 'supports'
    const confidenceText = noteField(note, 'confidence')
    const paperId = String(row.src || run.paperIds[0] || '')
    const paper = store.papers.find(item => item.id === paperId)
    const claim = String(row.dstLabel || '').trim()
    if (quote === '' || claim === '') {
      skipped += 1
      continue
    }
    const key = `${paperId}|${quote}`
    if (existing.has(key)) {
      skipped += 1
      continue
    }
    const support = ['supports', 'contradicts', 'mixed', 'context'].includes(supportText)
      ? supportText as ResearchRunEvidence['support']
      : 'supports'
    const confidence = Number(confidenceText)
    const page = Number(pageText)
    await addEvidence(profile, runId, {
      paperId,
      paperTitle: paper?.title || '',
      claim,
      quote,
      page: Number.isFinite(page) && page > 0 ? page : null,
      section,
      support,
      confidence: Number.isFinite(confidence) ? confidence : 0.5,
      note: `Imported from workbench evidence ${row.id}: ${note}`.slice(0, 2000),
    })
    existing.add(key)
    imported += 1
  }
  return { imported, skipped, run: await getRun(profile, runId) }
}

export async function createHypothesisBranch(profile: string, runId: string): Promise<ResearchRun> {
  return updateStore(profile, 'run.branch.created', draft => {
    const run = draft.runs.find(row => row.id === runId)
    if (!run) throw new Error('research_run_not_found')
    const branch = emptyBranch()
    run.branches.push(branch)
    run.activeBranchId = branch.id
    run.hypothesis = null
    run.experimentPlan = null
    run.experimentId = ''
    run.experimentJobId = ''
    run.jobInsight = null
    run.result = null
    run.stage = 'hypothesis'
    run.status = 'running'
    run.updatedAt = Date.now()
    return run
  }, { actor: { kind: 'user', id: 'workbench' }, action: 'run.branch.created' })
}

export async function setBranchFrozen(
  profile: string,
  runId: string,
  branchId: string,
  frozen: boolean,
  reason = '',
): Promise<ResearchRun> {
  return updateStore(profile, 'run.branch.frozen', draft => {
    const run = draft.runs.find(row => row.id === runId)
    if (!run) throw new Error('research_run_not_found')
    const branch = run.branches.find(row => row.id === branchId)
    if (!branch) throw new Error('research_branch_not_found')
    const now = Date.now()
    branch.frozenAt = frozen ? now : 0
    branch.audit.push({
      action: frozen ? 'freeze' : 'unfreeze',
      at: now,
      note: reason.slice(0, 500),
    })
    branch.updatedAt = now
    run.updatedAt = now
    return run
  }, { actor: { kind: 'user', id: 'workbench' }, action: 'run.branch.frozen' })
}

export async function archiveHypothesisBranch(profile: string, runId: string, branchId: string): Promise<ResearchRun> {
  return updateStore(profile, 'run.branch.archived', draft => {
    const run = draft.runs.find(row => row.id === runId)
    if (!run) throw new Error('research_run_not_found')
    const branch = run.branches.find(row => row.id === branchId)
    if (!branch) throw new Error('research_branch_not_found')
    const visible = run.branches.filter(row => row.archivedAt === 0)
    if (visible.length <= 1) throw new Error('research_branch_last')
    branch.archivedAt = Date.now()
    branch.updatedAt = branch.archivedAt
    if (run.activeBranchId === branchId) {
      const next = run.branches.find(row => row.archivedAt === 0)!
      run.activeBranchId = next.id
      run.stage = next.stage
      run.hypothesis = next.hypothesis
      run.experimentPlan = next.experimentPlan
      run.experimentId = next.experimentId
      run.experimentJobId = next.experimentJobId
      run.jobInsight = next.jobInsight
      run.result = next.result
    }
    run.updatedAt = Date.now()
    return run
  }, { actor: { kind: 'user', id: 'workbench' }, action: 'run.branch.archived' })
}

export async function restoreHypothesisBranch(profile: string, runId: string, branchId: string): Promise<ResearchRun> {
  return updateStore(profile, 'run.branch.restored', draft => {
    const run = draft.runs.find(row => row.id === runId)
    if (!run) throw new Error('research_run_not_found')
    const branch = run.branches.find(row => row.id === branchId)
    if (!branch) throw new Error('research_branch_not_found')
    branch.archivedAt = 0
    branch.updatedAt = Date.now()
    run.updatedAt = Date.now()
    return run
  }, { actor: { kind: 'user', id: 'workbench' }, action: 'run.branch.restored' })
}

export async function removeHypothesisBranch(profile: string, runId: string, branchId: string): Promise<ResearchRun> {
  return updateStore(profile, 'run.branch.removed', draft => {
    const run = draft.runs.find(row => row.id === runId)
    if (!run) throw new Error('research_run_not_found')
    const branch = run.branches.find(row => row.id === branchId)
    if (!branch) throw new Error('research_branch_not_found')
    if (branch.archivedAt === 0 && run.branches.filter(row => row.archivedAt === 0).length <= 1) {
      throw new Error('research_branch_last')
    }
    run.branches = run.branches.filter(row => row.id !== branchId)
    if (run.activeBranchId === branchId) {
      const next = run.branches.find(row => row.archivedAt === 0) || run.branches[0]
      run.activeBranchId = next.id
      run.hypothesis = next.hypothesis
      run.experimentPlan = next.experimentPlan
      run.experimentId = next.experimentId
      run.experimentJobId = next.experimentJobId
      run.jobInsight = next.jobInsight
      run.result = next.result
      run.stage = next.stage
      run.status = 'running'
      run.hypothesis = next.hypothesis
      run.experimentPlan = next.experimentPlan
      run.experimentId = next.experimentId
      run.experimentJobId = next.experimentJobId
      run.jobInsight = next.jobInsight
      run.result = next.result
    }
    run.updatedAt = Date.now()
    return run
  }, { actor: { kind: 'user', id: 'workbench' }, action: 'run.branch.removed' })
}

export async function activateHypothesisBranch(profile: string, runId: string, branchId: string): Promise<ResearchRun> {
  return updateStore(profile, 'run.branch.activated', draft => {
    const run = draft.runs.find(row => row.id === runId)
    if (!run) throw new Error('research_run_not_found')
    const branch = run.branches.find(row => row.id === branchId)
    if (!branch) throw new Error('research_branch_not_found')
    run.activeBranchId = branch.id
    run.hypothesis = branch.hypothesis
    run.experimentPlan = branch.experimentPlan
    run.experimentId = branch.experimentId
    run.experimentJobId = branch.experimentJobId
    run.jobInsight = branch.jobInsight
    run.result = branch.result
    run.stage = branch.stage
    run.status = 'running'
    run.updatedAt = Date.now()
    return run
  }, { actor: { kind: 'user', id: 'workbench' }, action: 'run.branch.activated' })
}

export async function saveHypothesis(profile: string, runId: string, input: HypothesisInput): Promise<ResearchRun> {
  return updateStore(profile, 'run.hypothesis.saved', draft => {
    const run = draft.runs.find(row => row.id === runId)
    if (!run) throw new Error('research_run_not_found')
    assertActiveEditable(run)
    const text = clean(input.text, 3000)
    if (text === '') throw new Error('research_hypothesis_required')
    const approved = new Set(run.claims.filter(claim => claim.reviewStatus === 'approved').map(claim => claim.id))
    const claimIds = (Array.isArray(input.claimIds) ? input.claimIds : [])
      .map(String)
      .filter(id => approved.has(id))
    if (claimIds.length === 0) throw new Error('research_hypothesis_claim_required')
    const hypothesis: ResearchRunHypothesis = {
      text,
      independentVariable: clean(input.independentVariable, 1000),
      dependentVariable: clean(input.dependentVariable, 1000),
      baselines: clean(input.baselines, 2000),
      metric: clean(input.metric, 1000),
      expected: clean(input.expected, 2000),
      falsification: clean(input.falsification, 2000),
      claimIds: Array.from(new Set(claimIds)).slice(0, 12),
      at: Date.now(),
    }
    run.hypothesis = hypothesis
    if (run.stage === 'evidence') run.stage = 'hypothesis'
    mirrorActiveBranch(run)
    run.updatedAt = Date.now()
    return run
  }, { actor: { kind: 'user', id: 'workbench' }, action: 'run.hypothesis.saved' })
}

export async function saveExperimentPlan(profile: string, runId: string, input: ExperimentPlanInput): Promise<ResearchRun> {
  return updateStore(profile, 'run.experiment-plan.saved', draft => {
    const run = draft.runs.find(row => row.id === runId)
    if (!run) throw new Error('research_run_not_found')
    assertActiveEditable(run)
    const plan: ResearchRunExperimentPlan = {
      dataset: clean(input.dataset, 2000),
      baselines: clean(input.baselines, 2000),
      metrics: clean(input.metrics, 2000),
      metricSchema: parseMetricSchema(clean(input.metricSchema, 2000)),
      family: clean(input.family, 200),
      seeds: clean(input.seeds, 1000),
      command: clean(input.command, 4000),
      resources: clean(input.resources, 2000),
      stopCondition: clean(input.stopCondition, 2000),
      successCriteria: clean(input.successCriteria, 2000),
      at: Date.now(),
    }
    if (plan.dataset === '' || plan.metrics === '') throw new Error('research_experiment_plan_incomplete')
    run.experimentPlan = plan
    mirrorActiveBranch(run)
    run.updatedAt = Date.now()
    return run
  }, { actor: { kind: 'user', id: 'workbench' }, action: 'run.experiment-plan.saved' })
}

export async function createExperimentRecord(profile: string, runId: string): Promise<ResearchRun> {
  return updateStore(profile, 'run.experiment.created', draft => {
    const run = draft.runs.find(row => row.id === runId)
    if (!run) throw new Error('research_run_not_found')
    assertActiveEditable(run)
    if (!run.hypothesis) throw new Error('research_hypothesis_required')
    if (!run.experimentPlan) throw new Error('research_experiment_plan_required')
    if (run.experimentId !== '') return run
    const plan = run.experimentPlan
    const hypothesis = run.hypothesis
    const linkedClaims = run.claims
      .filter(claim => hypothesis.claimIds.includes(claim.id))
      .map(claim => `${claim.id}: ${claim.text}`)
      .join('\n')
    const experiment = {
      id: newId('exp'),
      projectId: run.projectId,
      name: `${run.title} — ${hypothesis.text.slice(0, 80)}`,
      config: [
        `Hypothesis: ${hypothesis.text}`,
        `Linked claims:\n${linkedClaims || '(none)'}`,
        `Experiment family: ${plan.family || '(none)'}`,
        `Independent variable: ${hypothesis.independentVariable}`,
        `Dependent variable: ${hypothesis.dependentVariable}`,
        `Expected: ${hypothesis.expected}`,
        `Falsification: ${hypothesis.falsification}`,
        `Dataset: ${plan.dataset}`,
        `Baselines: ${plan.baselines}`,
        `Metrics: ${plan.metrics}`,
        `Seeds: ${plan.seeds}`,
        `Command: ${plan.command}`,
        `Resources: ${plan.resources}`,
        `Stop condition: ${plan.stopCondition}`,
        `Success criteria: ${plan.successCriteria}`,
        `Research Run: ${run.id}`,
      ].join('\n'),
      metrics: [],
      conclusion: '',
      status: 'planned' as const,
      at: Date.now(),
    }
    draft.experiments.push(experiment)
    run.experimentId = experiment.id
    run.stage = 'experiment'
    mirrorActiveBranch(run)
    run.updatedAt = Date.now()
    return run
  }, { actor: { kind: 'user', id: 'workbench' }, action: 'run.experiment.created' })
}

export async function submitExperimentJob(
  profile: string,
  runId: string,
  serverId: string,
): Promise<{ run: ResearchRun; job: Record<string, unknown> }> {
  const store = await readStore(profile)
  const run = store.runs.find(row => row.id === runId)
  if (!run) throw new Error('research_run_not_found')
  assertActiveEditable(run)
  if (!run.experimentId || !run.experimentPlan) throw new Error('research_experiment_required')
  const experiment = store.experiments.find(row => row.id === run.experimentId)
  if (!experiment) throw new Error('research_experiment_not_found')
  const server = store.servers.find(row => row.id === serverId)
  if (!server) throw new Error('research_server_not_found')
  const command = run.experimentPlan.command.trim()
  if (command === '') throw new Error('research_experiment_command_required')
  const submitted = await submitJob(
    { host: server.host, user: server.user, port: server.port },
    run.title,
    command,
  )
  const result = await updateStore(profile, 'run.experiment.submitted', draft => {
    const current = draft.runs.find(row => row.id === runId)
    if (!current) throw new Error('research_run_not_found')
    const job = {
      id: newId('job'),
      projectId: server.projectId,
      serverId,
      name: current.title,
      command,
      state: (submitted.ok ? 'running' : 'failed') as 'running' | 'failed',
      submittedAt: Date.now(),
      endedAt: submitted.ok ? 0 : Date.now(),
      logPath: submitted.logPath,
      exitCode: submitted.ok ? null : -1,
      pid: submitted.pid,
      note: submitted.detail,
    }
    draft.jobs.unshift(job)
    const exp = draft.experiments.find(row => row.id === current.experimentId)
    if (exp) {
      exp.status = submitted.ok ? 'running' : 'failed'
      exp.serverId = serverId
      exp.jobId = job.id
    }
    current.experimentJobId = job.id
    current.jobInsight = null
    mirrorActiveBranch(current)
    current.updatedAt = Date.now()
    return { run: current, job }
  }, { actor: { kind: 'user', id: 'workbench' }, action: 'run.experiment.submitted' })
  return result
}

export async function refreshExperimentJob(
  profile: string,
  runId: string,
): Promise<{
  run: ResearchRun
  job: ResearchJob | null
  state: { state: string; detail: string; exitCode: number | null } | null
  insight: { metrics: Array<{ name: string; value: number; raw: string }>; failureClass: string; logTail: string; exitCode: number | null; at: number } | null
}> {
  const store = await readStore(profile)
  const run = store.runs.find(row => row.id === runId)
  if (!run) throw new Error('research_run_not_found')
  if (run.experimentJobId === '') return { run, job: null, state: null, insight: null }
  const job = store.jobs.find(row => row.id === run.experimentJobId)
  if (!job) throw new Error('research_job_not_found')
  const server = store.servers.find(row => row.id === job.serverId)
  if (!server) throw new Error('research_server_not_found')
  const state = await jobState(
    { host: server.host, user: server.user, port: server.port },
    job.pid || '',
    job.logPath,
  )
  const parsed = inspectExperimentLog(state.logTail, state.state, state.exitCode)
  const insight = { ...parsed, at: Date.now() }
  const result = await updateStore(profile, 'run.experiment.refreshed', draft => {
    const current = draft.runs.find(row => row.id === runId)
    if (!current) throw new Error('research_run_not_found')
    const target = draft.jobs.find(row => row.id === current.experimentJobId)
    if (target) {
      target.state = state.state
      target.note = state.detail
      if (state.state !== 'running') {
        target.endedAt = Date.now()
        target.exitCode = state.exitCode
      }
    }
    const exp = draft.experiments.find(row => row.id === current.experimentId)
    if (exp && state.state !== 'running') exp.status = state.state === 'succeeded' ? 'done' : 'failed'
    current.jobInsight = insight
    mirrorActiveBranch(current)
    current.updatedAt = Date.now()
    return { run: current, job: target || null, state, insight }
  }, { actor: { kind: 'system', id: 'research-job' }, action: 'run.experiment.refreshed' })
  return result
}

export async function recordExperimentResult(profile: string, runId: string, input: ResultInput): Promise<ResearchRun> {
  return updateStore(profile, 'run.experiment.result', draft => {
    const run = draft.runs.find(row => row.id === runId)
    if (!run) throw new Error('research_run_not_found')
    assertActiveEditable(run)
    if (!run.hypothesis || run.experimentId === '') throw new Error('research_experiment_required')
    if (input.confirmedFinal !== true) throw new Error('research_result_confirmation_required')
    const summary = clean(input.summary, 4000)
    if (summary === '') throw new Error('research_result_summary_required')
    const metricValues = input.metricValues && typeof input.metricValues === 'object'
      ? input.metricValues
      : parseMetricValues(clean(input.metrics, 4000))
    const rawSamples = input.metricSamples && typeof input.metricSamples === 'object'
      ? input.metricSamples
      : Object.fromEntries(Object.entries(metricValues).map(([name, value]) => [name, [value]]))
    const metricSamples: Record<string, number[]> = {}
    for (const [name, values] of Object.entries(rawSamples)) {
      if (!Array.isArray(values)) continue
      const cleanValues = values.map(Number).filter(value => Number.isFinite(value))
      if (cleanValues.length > 0) metricSamples[name.toLowerCase()] = cleanValues
    }
    const baselineSamples: Record<string, number[]> = {}
    if (input.baselineSamples && typeof input.baselineSamples === 'object') {
      for (const [name, values] of Object.entries(input.baselineSamples)) {
        if (!Array.isArray(values)) continue
        const cleanValues = values.map(Number).filter(value => Number.isFinite(value))
        if (cleanValues.length > 0) baselineSamples[name.toLowerCase()] = cleanValues
      }
    }
    const schema = run.experimentPlan?.metricSchema || []
    const missing = schema
      .filter(spec => spec.required && !(spec.name.toLowerCase() in metricSamples))
      .map(spec => spec.name)
    if (missing.length > 0) throw new Error(`research_result_missing_metrics:${missing.join(',')}`)
    const metricStats = summarizeMetricSamples(schema, metricSamples, baselineSamples)
    const autoOutcome = assessMetricOutcome(schema, metricSamples, baselineSamples)
    const outcome = ['supported', 'contradicted', 'mixed', 'inconclusive'].includes(input.outcome || '')
      ? (input.outcome as ResearchRunResult['outcome'])
      : autoOutcome
    const overrideReason = clean(input.overrideReason, 2000)
    if (autoOutcome !== 'inconclusive' && outcome !== autoOutcome && overrideReason === '') {
      throw new Error('research_result_override_reason_required')
    }
    const now = Date.now()
    const evidenceId = newId('ev')
    const support = outcome === 'supported' ? 'supports' : outcome === 'contradicted' ? 'contradicts' : 'mixed'
    run.evidence.push({
      id: evidenceId,
      paperId: '',
      paperTitle: `Experiment ${run.experimentId}`,
      claim: run.hypothesis.text,
      quote: summary,
      page: null,
      section: 'experiment result',
      support,
      confidence: typeof input.confidence === 'number' && Number.isFinite(input.confidence)
        ? Math.max(0, Math.min(1, input.confidence))
        : outcome === 'inconclusive' ? 0.4 : 0.8,
      note: clean(input.metrics, 3000),
      createdAt: now,
      updatedAt: now,
    })
    run.claims.push({
      id: newId('claim'),
      text: run.hypothesis.text,
      status: outcome === 'supported' ? 'supported' : outcome === 'contradicted' ? 'contradicted' : 'mixed',
      evidenceIds: [evidenceId],
      confidence: outcome === 'inconclusive' ? 0.4 : 0.75,
      note: summary,
      reviewStatus: 'pending',
      reviewNote: '',
      reviewedAt: 0,
      contradictionIds: [],
      createdAt: now,
      updatedAt: now,
    })
    const metricText = metricStats.length > 0
      ? metricStats.map(stat => `${stat.name}=${stat.mean.toFixed(4)}±${stat.std.toFixed(4)} (n=${stat.n})`).join(', ')
      : Object.entries(metricValues).map(([name, value]) => `${name}=${value}`).join(', ')
    run.result = {
      outcome,
      summary,
      metrics: metricText || clean(input.metrics, 3000),
      experimentId: run.experimentId,
      confirmedFinal: true,
      autoOutcome,
      overrideReason,
      metricStats,
      at: now,
    }
    run.stage = 'analysis'
    mirrorActiveBranch(run)
    run.updatedAt = now
    const experiment = draft.experiments.find(row => row.id === run.experimentId)
    if (experiment) {
      experiment.status = outcome === 'inconclusive' ? 'failed' : 'done'
      experiment.conclusion = summary
    }
    return run
  }, { actor: { kind: 'user', id: 'workbench' }, action: 'run.experiment.result' })
}

export async function replaceClaims(profile: string, runId: string, inputs: ClaimInput[]): Promise<ResearchRun> {
  const now = Date.now()
  return updateStore(profile, 'run.claims.replaced', draft => {
    const run = draft.runs.find(row => row.id === runId)
    if (!run) throw new Error('research_run_not_found')
    const validEvidence = new Set(run.evidence.map(row => row.id))
    const claims: ResearchRunClaim[] = []
    for (const input of inputs) {
      const text = clean(input.text, 2000)
      if (text === '') continue
      const evidenceIds = normalizePaperIds(input.evidenceIds).filter(id => validEvidence.has(id))
      if (evidenceIds.length === 0) continue
      claims.push({
        id: newId('claim'),
        text,
        status: ['supported', 'contradicted', 'mixed', 'gap'].includes(input.status || '')
          ? (input.status as ResearchRunClaim['status'])
          : 'supported',
        evidenceIds,
        confidence: typeof input.confidence === 'number' && Number.isFinite(input.confidence)
          ? Math.max(0, Math.min(1, input.confidence))
          : 0.5,
        note: clean(input.note, 2000),
        reviewStatus: 'pending',
        reviewNote: '',
        reviewedAt: 0,
        contradictionIds: evidenceIds.filter((evidenceId) => {
          const row = run.evidence.find(evidence => evidence.id === evidenceId)
          return row?.support === 'contradicts'
        }),
        createdAt: now,
        updatedAt: now,
      })
    }
    run.claims = claims.slice(0, 12)
    run.updatedAt = now
    return run
  }, { actor: { kind: 'agent', id: 'research-run' }, action: 'run.claims.replaced' })
}

export interface ClaimReviewInput {
  reviewStatus?: ResearchRunClaim['reviewStatus']
  reviewNote?: string
}

export interface ClaimCoverage {
  paperCount: number
  coveredPaperCount: number
  papersWithoutEvidence: string[]
  claimCount: number
  pendingCount: number
  approvedCount: number
  rejectedCount: number
  needsEvidenceCount: number
  claimsWithNoEvidence: number
  contradictoryClaimCount: number
  ready: boolean
  blockers: string[]
}

function claimGateBlockers(run: ResearchRun): string[] {
  const blockers: string[] = []
  const approved = run.claims.filter(claim => claim.reviewStatus === 'approved')
  if (approved.length === 0) blockers.push('research_claims_not_approved')
  if (run.claims.some(claim => claim.reviewStatus === 'needs_evidence')) {
    blockers.push('research_claims_needs_evidence')
  }
  if (approved.some(claim => claim.evidenceIds.length === 0)) {
    blockers.push('research_claims_missing_evidence')
  }
  if (approved.some(claim => claim.contradictionIds.length > 0 && claim.reviewNote.trim() === '')) {
    blockers.push('research_claim_contradiction_note_required')
  }
  return blockers
}

export function describeClaimCoverage(run: ResearchRun): ClaimCoverage {
  const evidencePaperIds = new Set(run.evidence.map(row => row.paperId).filter(Boolean))
  const papersWithoutEvidence = run.paperIds.filter(paperId => !evidencePaperIds.has(paperId))
  const blockers = claimGateBlockers(run)
  return {
    paperCount: run.paperIds.length,
    coveredPaperCount: run.paperIds.length - papersWithoutEvidence.length,
    papersWithoutEvidence,
    claimCount: run.claims.length,
    pendingCount: run.claims.filter(claim => claim.reviewStatus === 'pending').length,
    approvedCount: run.claims.filter(claim => claim.reviewStatus === 'approved').length,
    rejectedCount: run.claims.filter(claim => claim.reviewStatus === 'rejected').length,
    needsEvidenceCount: run.claims.filter(claim => claim.reviewStatus === 'needs_evidence').length,
    claimsWithNoEvidence: run.claims.filter(claim => claim.evidenceIds.length === 0).length,
    contradictoryClaimCount: run.claims.filter(claim => claim.contradictionIds.length > 0).length,
    ready: blockers.length === 0,
    blockers,
  }
}

export async function reviewClaim(
  profile: string,
  runId: string,
  claimId: string,
  input: ClaimReviewInput,
): Promise<{ run: ResearchRun; coverage: ClaimCoverage }> {
  return updateStore(profile, 'run.claim.reviewed', draft => {
    const run = draft.runs.find(row => row.id === runId)
    if (!run) throw new Error('research_run_not_found')
    const claim = run.claims.find(row => row.id === claimId)
    if (!claim) throw new Error('research_claim_not_found')
    const reviewStatus = ['pending', 'approved', 'rejected', 'needs_evidence'].includes(input.reviewStatus || '')
      ? (input.reviewStatus as ResearchRunClaim['reviewStatus'])
      : 'pending'
    const reviewNote = clean(input.reviewNote, 2000)
    if (reviewStatus === 'approved' && claim.contradictionIds.length > 0 && reviewNote === '') {
      throw new Error('research_claim_contradiction_note_required')
    }
    claim.reviewStatus = reviewStatus
    claim.reviewNote = reviewNote
    claim.reviewedAt = Date.now()
    claim.updatedAt = claim.reviewedAt
    run.updatedAt = claim.reviewedAt
    return { run, coverage: describeClaimCoverage(run) }
  }, { actor: { kind: 'user', id: 'workbench' }, action: 'run.claim.reviewed' })
}

export async function getClaimCoverage(profile: string, runId: string): Promise<ClaimCoverage> {
  const store = await readStore(profile)
  const run = store.runs.find(row => row.id === runId)
  if (!run) throw new Error('research_run_not_found')
  return describeClaimCoverage(run)
}

export async function approveEvidence(profile: string, runId: string, note = ''): Promise<ResearchRun> {
  return updateStore(profile, 'run.evidence.approved', draft => {
    const run = draft.runs.find(row => row.id === runId)
    if (!run) throw new Error('research_run_not_found')
    if (run.evidence.length === 0) throw new Error('research_evidence_empty')
    const now = Date.now()
    if (!run.approvals.some(item => item.stage === 'evidence')) {
      run.approvals.push({ stage: 'evidence', at: now, note: clean(note, 1000) })
    }
    // The evidence gate locks the table; claim review is a separate gate
    // before hypothesis. Do not skip it by advancing here.
    run.stage = 'evidence'
    run.status = 'waiting_approval'
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
      const blockers = claimGateBlockers(run)
      if (blockers.length > 0) throw new Error(blockers[0])
      run.stage = 'hypothesis'
      run.status = 'running'
    } else if (run.stage === 'hypothesis') {
      if (!run.hypothesis) throw new Error('research_hypothesis_required')
      if (run.experimentId === '') throw new Error('research_experiment_required')
      run.stage = 'experiment'
      run.status = 'running'
    } else if (run.stage === 'experiment') {
      if (!run.result) throw new Error('research_result_required')
      run.stage = 'analysis'
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
    if (run.branches.length > 0) mirrorActiveBranch(run)
    run.updatedAt = Date.now()
    return run
  }, { actor: { kind: 'user', id: 'workbench' }, action: 'run.advanced' })
}

export function researchRunStages(): ResearchRunStage[] {
  return [...RUN_STAGES]
}
