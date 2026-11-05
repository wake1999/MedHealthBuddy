import { generateResultsDraft } from './run-results-draft'
import { generateRunReport } from './run-report'
import {
  addEvidence,
  approveEvidence,
  createExperimentRecord,
  createRun,
  recordExperimentResult,
  refreshExperimentJob,
  saveExperimentPlan,
  saveHypothesis,
  submitExperimentJob,
} from './runs'
import { newId, readStore, updateStore, type ResearchFlow, type ResearchRun } from './store'

export const FLOW_FIXTURE = {
  id: 'fixture-milcaf1-v1',
  paperTitle: 'MILCAnet fixture paper',
  quote: 'This method extracts long-temporal features based on a dominant feature attention framework.',
  claim: 'MIL improves F1 on the fixture dataset.',
  hypothesis: 'MIL improves F1 on the fixture dataset.',
  question: 'Does MIL improve F1 on the fixture dataset?',
  plan: {
    dataset: 'fixture-D1',
    baselines: 'fixture-baseline',
    metrics: 'F1',
    metricSchema: 'F1:max:required:0.85:0.83:0.01',
    family: 'fixture-family',
    command: 'echo fixture',
    seeds: '1-3',
  },
  samples: [0.86, 0.87, 0.88],
} as const

export interface CreateFlowInput {
  projectId?: string
  mode?: 'dry-run' | 'fixture' | 'ssh'
  idempotencyKey?: string
  title?: string
  serverId?: string
  maxAttempts?: number
}

function flowSteps(): ResearchFlow['steps'] {
  return [
    { key: 'scope', status: 'planned', note: 'Fixture scope', at: Date.now() },
    { key: 'evidence', status: 'planned', note: 'Fixture evidence', at: Date.now() },
    { key: 'claims', status: 'planned', note: 'Human gate', at: Date.now() },
    { key: 'hypothesis', status: 'planned', note: 'Fixture hypothesis', at: Date.now() },
    { key: 'plan', status: 'planned', note: 'Human gate', at: Date.now() },
    { key: 'experiment', status: 'planned', note: 'SSH job execution', at: Date.now() },
    { key: 'result', status: 'planned', note: 'Human gate', at: Date.now() },
    { key: 'analysis', status: 'planned', note: 'Report and Results draft', at: Date.now() },
  ]
}

function markStep(flow: ResearchFlow, key: string, status: string, note: string): void {
  const step = flow.steps.find(row => row.key === key)
  if (step) {
    step.status = status
    step.note = note
    step.at = Date.now()
  }
  flow.updatedAt = Date.now()
}

async function createFixtureProject(profile: string, title: string): Promise<{ projectId: string; paperId: string }> {
  return updateStore(profile, 'flow.fixture.project', draft => {
    const projectId = newId('proj')
    const paperId = newId('paper')
    const now = Date.now()
    draft.projects.push({ id: projectId, title, createdAt: now, updatedAt: now })
    draft.papers.push({
      id: paperId,
      projectId,
      title: FLOW_FIXTURE.paperTitle,
      authors: 'Fixture',
      year: '2025',
      venue: 'Fixture',
      doi: '',
      url: '',
      arxivId: '',
      score: 0,
      status: 'read',
      notes: 'Fixture paper created by ResearchFlowRunner',
      tags: ['fixture'],
      addedAt: now,
    } as never)
    return { projectId, paperId }
  }, { actor: { kind: 'system', id: 'flow-runner' }, action: 'flow.fixture.project' })
}

async function seedClaim(profile: string, runId: string, evidenceId: string): Promise<string> {
  return updateStore(profile, 'flow.fixture.claim', draft => {
    const run = draft.runs.find(row => row.id === runId)
    if (!run) throw new Error('research_run_not_found')
    const claimId = newId('claim')
    const now = Date.now()
    run.claims.push({
      id: claimId,
      text: FLOW_FIXTURE.claim,
      status: 'supported',
      evidenceIds: [evidenceId],
      confidence: 0.9,
      note: 'Fixture claim',
      reviewStatus: 'pending',
      reviewNote: '',
      reviewedAt: 0,
      contradictionIds: [],
      createdAt: now,
      updatedAt: now,
    })
    run.updatedAt = now
    return claimId
  }, { actor: { kind: 'system', id: 'flow-runner' }, action: 'flow.fixture.claim' })
}

async function updateFlow(profile: string, flowId: string, mutate: (flow: ResearchFlow) => void): Promise<ResearchFlow> {
  return updateStore(profile, 'flow.updated', draft => {
    const flow = draft.flows.find(row => row.id === flowId)
    if (!flow) throw new Error('research_flow_not_found')
    mutate(flow)
    flow.updatedAt = Date.now()
    return flow
  }, { actor: { kind: 'system', id: 'flow-runner' }, action: 'flow.updated' })
}

export async function createFlow(
  profile: string,
  input: CreateFlowInput,
): Promise<{ flow: ResearchFlow; run: ResearchRun | null; reused: boolean }> {
  const mode = input.mode === 'ssh' ? 'ssh' : input.mode === 'fixture' ? 'fixture' : 'dry-run'
  const idempotencyKey = (input.idempotencyKey || `flow-${Date.now()}`).trim()
  const store = await readStore(profile)
  const existing = store.flows.find(flow => flow.mode === mode && flow.idempotencyKey === idempotencyKey)
  if (existing) {
    const run = existing.runId ? store.runs.find(row => row.id === existing.runId) || null : null
    return { flow: existing, run, reused: true }
  }
  if (mode === 'ssh') {
    const server = store.servers.find(row => row.id === String(input.serverId || ''))
    if (!server || !server.host || !server.user) throw new Error('research_server_not_found')
  }

  const title = (input.title || 'Fixture Research Flow').trim()
  const flow: ResearchFlow = {
    id: newId('flow'),
    projectId: '',
    runId: '',
    mode,
    status: mode === 'dry-run' ? 'completed' : 'running',
    stage: 'scope',
    gate: '',
    fixtureId: FLOW_FIXTURE.id,
    idempotencyKey,
    title,
    question: FLOW_FIXTURE.question,
    steps: flowSteps(),
    error: '',
    serverId: String(input.serverId || ''),
    jobId: '',
    attempt: 0,
    maxAttempts: Math.max(1, Math.min(5, Math.floor(input.maxAttempts || 2))),
    checkpoint: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  if (mode === 'dry-run') {
    markStep(flow, 'scope', 'done', 'Dry-run only; no project or run created')
    markStep(flow, 'evidence', 'planned', 'Would add fixture evidence')
    markStep(flow, 'claims', 'planned', 'Human gate required in fixture mode')
    const created = await updateStore(profile, 'flow.created', draft => {
      draft.flows.push(flow)
      return flow
    }, { actor: { kind: 'system', id: 'flow-runner' }, action: 'flow.created' })
    return { flow: created, run: null, reused: false }
  }

  let projectId = String(input.projectId || '').trim()
  let paperId = ''
  if (projectId === '') {
    const created = await createFixtureProject(profile, `${title} fixture`)
    projectId = created.projectId
    paperId = created.paperId
  } else {
    const current = await readStore(profile)
    if (!current.projects.some(project => project.id === projectId)) {
      throw new Error('research_project_not_found')
    }
    const paper = await updateStore(profile, 'flow.fixture.paper', draft => {
      const currentPaper = {
        id: newId('paper'),
        projectId,
        title: FLOW_FIXTURE.paperTitle,
        authors: 'Fixture',
        year: '2025',
        venue: 'Fixture',
        doi: '',
        url: '',
        arxivId: '',
        score: 0,
        status: 'read' as const,
        notes: 'Fixture paper created by ResearchFlowRunner',
        tags: ['fixture'],
        addedAt: Date.now(),
      }
      draft.papers.push(currentPaper as never)
      return currentPaper
    }, { actor: { kind: 'system', id: 'flow-runner' }, action: 'flow.fixture.paper' })
    paperId = paper.id
  }

  const run = await createRun(profile, {
    projectId,
    title,
    question: FLOW_FIXTURE.question,
    paperIds: [paperId],
  })
  flow.projectId = projectId
  flow.runId = run.id
  const evidence = await addEvidence(profile, run.id, {
    paperId,
    claim: FLOW_FIXTURE.claim,
    quote: FLOW_FIXTURE.quote,
    page: 1,
    section: 'Fixture',
    support: 'supports',
    confidence: 0.9,
    note: 'Fixture evidence',
  })
  await approveEvidence(profile, run.id)
  const claimId = await seedClaim(profile, run.id, evidence.id)
  flow.stage = 'claims'
  flow.gate = 'claims'
  flow.status = 'waiting_approval'
  markStep(flow, 'scope', 'done', 'Fixture project and Run created')
  markStep(flow, 'evidence', 'done', 'Fixture evidence added and approved')
  markStep(flow, 'claims', 'waiting', `Awaiting approval for ${claimId}`)
  const created = await updateStore(profile, 'flow.created', draft => {
    draft.flows.push(flow)
    return flow
  }, { actor: { kind: 'system', id: 'flow-runner' }, action: 'flow.created' })
  return { flow: created, run, reused: false }
}

export async function getFlow(profile: string, flowId: string): Promise<{ flow: ResearchFlow; run: ResearchRun | null }> {
  const store = await readStore(profile)
  const flow = store.flows.find(row => row.id === flowId)
  if (!flow) throw new Error('research_flow_not_found')
  return { flow, run: flow.runId ? store.runs.find(row => row.id === flow.runId) || null : null }
}

export async function listFlows(profile: string, projectId = ''): Promise<ResearchFlow[]> {
  const store = await readStore(profile)
  return store.flows.filter(flow => projectId === '' || flow.projectId === projectId)
}

export async function removeFlow(profile: string, flowId: string): Promise<void> {
  await updateStore(profile, 'flow.removed', draft => {
    const index = draft.flows.findIndex(flow => flow.id === flowId)
    if (index >= 0) draft.flows.splice(index, 1)
    return null
  }, { actor: { kind: 'system', id: 'flow-runner' }, action: 'flow.removed' })
}

export async function approveFlowGate(
  profile: string,
  flowId: string,
  gate: string,
  note: string,
): Promise<{ flow: ResearchFlow; run: ResearchRun | null }> {
  if (note.trim() === '') throw new Error('research_flow_approval_note_required')
  const { flow } = await getFlow(profile, flowId)
  if (flow.mode === 'dry-run') throw new Error('research_flow_not_fixture')
  if (flow.status === 'completed') return getFlow(profile, flowId)
  if (flow.gate !== gate) throw new Error('research_flow_gate_mismatch')
  const run = await readStore(profile).then(store => store.runs.find(row => row.id === flow.runId))
  if (!run) throw new Error('research_run_not_found')

  if (gate === 'claims') {
    const claim = run.claims[0]
    if (!claim) throw new Error('research_flow_fixture_claim_missing')
    await updateStore(profile, 'flow.claims.approved', draft => {
      const current = draft.runs.find(row => row.id === run.id)
      const target = current?.claims.find(row => row.id === claim.id)
      if (target) {
        target.reviewStatus = 'approved'
        target.reviewNote = note.trim().slice(0, 500)
        target.reviewedAt = Date.now()
      }
      return current || null
    }, { actor: { kind: 'user', id: 'workbench' }, action: 'flow.claims.approved' })
    await saveHypothesis(profile, run.id, {
      text: FLOW_FIXTURE.hypothesis,
      independentVariable: 'MIL',
      dependentVariable: 'F1',
      baselines: FLOW_FIXTURE.plan.baselines,
      metric: 'F1',
      expected: 'F1 increases',
      falsification: 'F1 does not increase',
      claimIds: [claim.id],
    })
    await saveExperimentPlan(profile, run.id, FLOW_FIXTURE.plan)
    const updated = await updateFlow(profile, flowId, current => {
      current.stage = 'plan'
      current.gate = 'plan'
      current.status = 'waiting_approval'
      markStep(current, 'claims', 'done', note.trim())
      markStep(current, 'hypothesis', 'done', 'Fixture hypothesis saved')
      markStep(current, 'plan', 'waiting', 'Awaiting plan approval')
    })
    return { flow: updated, run: await readStore(profile).then(store => store.runs.find(row => row.id === run.id) || null) }
  }

  if (gate === 'plan') {
    await createExperimentRecord(profile, run.id)
    if (flow.mode === 'ssh') {
      try {
        const submitted = await submitExperimentJob(profile, run.id, flow.serverId)
        const jobId = String(submitted.job.id || '')
        const updated = await updateFlow(profile, flowId, current => {
          current.stage = 'experiment'
          current.gate = ''
          current.status = 'running'
          current.jobId = jobId
          current.attempt = 1
          current.checkpoint = JSON.stringify({ jobId, attempt: 1, state: 'running', at: Date.now() })
          markStep(current, 'plan', 'done', note.trim())
          markStep(current, 'experiment', 'running', `SSH job ${jobId} submitted`)
        })
        return { flow: updated, run: await readStore(profile).then(store => store.runs.find(row => row.id === run.id) || null) }
      } catch (error) {
        await updateFlow(profile, flowId, current => {
          current.status = 'failed'
          current.error = error instanceof Error ? error.message : 'ssh_submit_failed'
          markStep(current, 'experiment', 'failed', current.error)
        })
        throw error
      }
    }
    await recordExperimentResult(profile, run.id, {
      outcome: 'supported',
      summary: 'Fixture result: MIL improves F1.',
      metrics: FLOW_FIXTURE.samples.map(value => `F1=${value}`).join('\n'),
      confirmedFinal: true,
      metricSamples: { f1: [...FLOW_FIXTURE.samples] },
    })
    const updated = await updateFlow(profile, flowId, current => {
      current.stage = 'result'
      current.gate = 'result'
      current.status = 'waiting_approval'
      markStep(current, 'plan', 'done', note.trim())
      markStep(current, 'result', 'waiting', 'Awaiting result approval')
    })
    return { flow: updated, run: await readStore(profile).then(store => store.runs.find(row => row.id === run.id) || null) }
  }

  if (gate === 'result') {
    if (flow.mode === 'ssh') {
      const current = await readStore(profile).then(store => store.runs.find(row => row.id === run.id) || null)
      if (!current?.result) throw new Error('research_flow_result_required')
    }
    await generateRunReport(profile, run.id)
    await generateResultsDraft(profile, run.id)
    const updated = await updateFlow(profile, flowId, current => {
      current.stage = 'completed'
      current.gate = ''
      current.status = 'completed'
      markStep(current, 'result', 'done', note.trim())
      markStep(current, 'analysis', 'done', 'Report and Results draft generated')
    })
    return { flow: updated, run: await readStore(profile).then(store => store.runs.find(row => row.id === run.id) || null) }
  }

  throw new Error('research_flow_unknown_gate')
}

export async function tickFlow(
  profile: string,
  flowId: string,
): Promise<{ flow: ResearchFlow; run: ResearchRun | null; state: string; detail: string; exitCode: number | null }> {
  const { flow } = await getFlow(profile, flowId)
  if (flow.mode !== 'ssh') throw new Error('research_flow_not_ssh')
  if (flow.status === 'completed' || flow.status === 'failed') {
    return { flow, run: flow.runId ? await readStore(profile).then(store => store.runs.find(row => row.id === flow.runId) || null) : null, state: flow.status, detail: flow.error, exitCode: null }
  }
  if (flow.gate !== '' || !flow.jobId) throw new Error('research_flow_no_running_job')

  let refreshed: Awaited<ReturnType<typeof refreshExperimentJob>>
  try {
    refreshed = await refreshExperimentJob(profile, flow.runId)
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'ssh_refresh_failed'
    const updated = await updateFlow(profile, flowId, current => {
      current.error = detail
      current.checkpoint = JSON.stringify({ jobId: current.jobId, attempt: current.attempt, state: 'refresh_error', detail, at: Date.now() })
    })
    return { flow: updated, run: null, state: 'unknown', detail, exitCode: null }
  }
  const state = refreshed.state?.state || 'unknown'
  const detail = refreshed.state?.detail || ''
  const exitCode = refreshed.state?.exitCode ?? null

  if (state === 'running' || state === 'unknown') {
    const updated = await updateFlow(profile, flowId, current => {
      current.checkpoint = JSON.stringify({ jobId: current.jobId, attempt: current.attempt, state, at: Date.now() })
      current.error = state === 'unknown' ? detail : ''
    })
    return { flow: updated, run: refreshed.run, state, detail, exitCode }
  }

  if (state === 'succeeded') {
    const updated = await updateFlow(profile, flowId, current => {
      current.stage = 'result'
      current.gate = 'result'
      current.status = 'waiting_approval'
      current.checkpoint = JSON.stringify({ jobId: current.jobId, attempt: current.attempt, state, at: Date.now() })
      markStep(current, 'experiment', 'done', `SSH job ${current.jobId} succeeded`)
      markStep(current, 'result', 'waiting', 'Record result, then approve result gate')
    })
    return { flow: updated, run: refreshed.run, state, detail, exitCode }
  }

  if (flow.attempt < flow.maxAttempts) {
    const submitted = await submitExperimentJob(profile, flow.runId, flow.serverId)
    const jobId = String(submitted.job.id || '')
    const attempt = flow.attempt + 1
    const updated = await updateFlow(profile, flowId, current => {
      current.jobId = jobId
      current.attempt = attempt
      current.status = 'running'
      current.gate = ''
      current.error = detail
      current.checkpoint = JSON.stringify({ jobId, attempt, state: 'retrying', previousState: state, at: Date.now() })
      markStep(current, 'experiment', 'retrying', `Attempt ${attempt}/${current.maxAttempts}; previous job ${state}`)
    })
    return { flow: updated, run: await readStore(profile).then(store => store.runs.find(row => row.id === flow.runId) || null), state: 'retrying', detail, exitCode }
  }

  const updated = await updateFlow(profile, flowId, current => {
    current.status = 'failed'
    current.stage = 'experiment'
    current.gate = ''
    current.error = detail || 'ssh_job_failed'
    current.checkpoint = JSON.stringify({ jobId: current.jobId, attempt: current.attempt, state: 'failed', exitCode, at: Date.now() })
    markStep(current, 'experiment', 'failed', `Retry limit reached: ${detail}`)
  })
  return { flow: updated, run: refreshed.run, state: 'failed', detail, exitCode }
}

export async function resumeFlow(profile: string, flowId: string): Promise<{ flow: ResearchFlow; run: ResearchRun | null }> {
  const current = await getFlow(profile, flowId)
  if (current.flow.mode === 'ssh' && current.flow.status === 'running' && current.flow.gate === '' && current.flow.jobId) {
    const ticked = await tickFlow(profile, flowId)
    return { flow: ticked.flow, run: ticked.run }
  }
  return current
}
