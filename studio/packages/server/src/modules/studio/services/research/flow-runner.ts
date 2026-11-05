import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
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
import { newId, readStore, researchRoot, updateStore, type ResearchFlow, type ResearchRun } from './store'
import { cancelJob, downloadRemoteFile } from './ssh'

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
  artifactPath?: string
  auto?: boolean
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
    retryAt: 0,
    leaseOwner: '',
    leaseUntil: 0,
    cancelKey: '',
    resumeKey: '',
    remoteArtifactPath: String(input.artifactPath || '').trim().slice(0, 2000),
    remoteArtifact: null,
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
  if (input.auto && created.mode === 'fixture') {
    const completed = await advanceFlowToCompletion(profile, created.id)
    return { flow: completed, run: await readStore(profile).then(store => store.runs.find(row => row.id === created.runId) || null), reused: false }
  }
  return { flow: created, run, reused: false }
}

export async function advanceFlowToCompletion(profile: string, flowId: string): Promise<ResearchFlow> {
  for (let index = 0; index < 8; index += 1) {
    const { flow } = await getFlow(profile, flowId)
    if (flow.status === 'completed') return flow
    if (flow.status === 'failed' || flow.status === 'cancelled') return flow
    if (flow.mode !== 'fixture') throw new Error('research_flow_not_fixture')
    if (!flow.gate) throw new Error('research_flow_no_runnable_gate')
    await approveFlowGate(profile, flowId, flow.gate, 'Automatic fixture run')
  }
  throw new Error('research_flow_auto_limit')
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

async function collectRemoteArtifact(
  profile: string,
  flow: ResearchFlow,
  projectId: string,
): Promise<{ at: number; path: string; sha256: string; size: number } | null> {
  if (flow.remoteArtifactPath === '') return null
  const store = await readStore(profile)
  const server = store.servers.find(row => row.id === flow.serverId)
  if (!server) throw new Error('research_server_not_found')
  const downloaded = await downloadRemoteFile(
    { host: server.host, user: server.user, port: server.port },
    flow.remoteArtifactPath,
  )
  if (!downloaded.ok) throw new Error(downloaded.detail || 'remote_artifact_download_failed')
  const dir = path.join(researchRoot(profile), 'projects', projectId, 'flow-artifacts', flow.id)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, path.basename(flow.remoteArtifactPath) || 'artifact.bin')
  await fs.writeFile(file, downloaded.data)
  return {
    at: Date.now(),
    path: file,
    sha256: createHash('sha256').update(downloaded.data).digest('hex'),
    size: downloaded.data.length,
  }
}

async function tickFlowUnlocked(
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
    let artifact = flow.remoteArtifact
    let artifactError = ''
    if (!artifact && flow.remoteArtifactPath !== '') {
      try {
        artifact = await collectRemoteArtifact(profile, flow, refreshed.run?.projectId || '')
      } catch (error) {
        artifactError = error instanceof Error ? error.message : 'remote_artifact_download_failed'
      }
    }
    const updated = await updateFlow(profile, flowId, current => {
      current.stage = 'result'
      current.gate = 'result'
      current.status = 'waiting_approval'
      current.remoteArtifact = artifact
      current.error = artifactError
      current.checkpoint = JSON.stringify({ jobId: current.jobId, attempt: current.attempt, state, artifact: artifact?.path || '', at: Date.now() })
      markStep(current, 'experiment', 'done', `SSH job ${current.jobId} succeeded`)
      markStep(current, 'result', 'waiting', artifactError ? `Artifact failed: ${artifactError}` : 'Record result, then approve result gate')
    })
    return { flow: updated, run: refreshed.run, state, detail, exitCode }
  }

  if (flow.attempt < flow.maxAttempts) {
    if (flow.retryAt === 0) {
      const retryAt = Date.now() + Math.min(60000, 1000 * 2 ** Math.max(0, flow.attempt - 1))
      const scheduled = await updateFlow(profile, flowId, current => {
        current.status = 'running'
        current.retryAt = retryAt
        current.error = detail
        current.checkpoint = JSON.stringify({ jobId: current.jobId, attempt: current.attempt, state: 'backoff', retryAt, at: Date.now() })
        markStep(current, 'experiment', 'backoff', `Failed; retry scheduled at ${new Date(retryAt).toISOString()}`)
      })
      return { flow: scheduled, run: refreshed.run, state: 'backoff', detail, exitCode }
    }
    if (flow.retryAt > Date.now()) {
      const updated = await updateFlow(profile, flowId, current => {
        current.status = 'running'
        current.gate = ''
        current.error = detail
        current.checkpoint = JSON.stringify({ jobId: current.jobId, attempt: current.attempt, state: 'backoff', retryAt: current.retryAt, at: Date.now() })
        markStep(current, 'experiment', 'backoff', `Waiting until ${new Date(current.retryAt).toISOString()}`)
      })
      return { flow: updated, run: refreshed.run, state: 'backoff', detail, exitCode }
    }
    const submitted = await submitExperimentJob(profile, flow.runId, flow.serverId)
    const jobId = String(submitted.job.id || '')
    const attempt = flow.attempt + 1
    const updated = await updateFlow(profile, flowId, current => {
      current.jobId = jobId
      current.attempt = attempt
      current.status = 'running'
      current.gate = ''
      current.retryAt = 0
      current.error = detail
      current.checkpoint = JSON.stringify({ jobId, attempt, state: 'retrying', previousState: state, at: Date.now() })
      markStep(current, 'experiment', 'retrying', `Attempt ${attempt}/${current.maxAttempts}; previous job ${state}`)
    })
    return { flow: updated, run: await readStore(profile).then(store => store.runs.find(row => row.id === flow.runId) || null), state: 'retrying', detail, exitCode }
  }

  const failed = await updateFlow(profile, flowId, current => {
    current.status = 'failed'
    current.stage = 'experiment'
    current.gate = ''
    current.retryAt = 0
    current.error = detail || 'ssh_job_failed'
    current.checkpoint = JSON.stringify({ jobId: current.jobId, attempt: current.attempt, state: 'failed', exitCode, at: Date.now() })
    markStep(current, 'experiment', 'failed', `Retry limit reached: ${detail}`)
  })
  return { flow: failed, run: refreshed.run, state: 'failed', detail, exitCode }
}

const LEASE_MS = 30_000

function leaseFilePath(profile: string, flowId: string): string {
  return path.join(researchRoot(profile), '.locks', 'flows', `${flowId}.lock`)
}

async function acquireFileLease(profile: string, flowId: string, owner: string): Promise<void> {
  const file = leaseFilePath(profile, flowId)
  await fs.mkdir(path.dirname(file), { recursive: true })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await fs.open(file, 'wx')
      try {
        await handle.writeFile(JSON.stringify({ owner, until: Date.now() + LEASE_MS }))
      } finally {
        await handle.close()
      }
      return
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error
      try {
        const raw = JSON.parse(await fs.readFile(file, 'utf-8')) as { until?: number }
        if (Number(raw.until) > Date.now()) throw new Error('research_flow_lease_busy')
      } catch (readError: any) {
        if (readError?.message === 'research_flow_lease_busy') throw readError
      }
      await fs.unlink(file).catch(() => undefined)
    }
  }
  throw new Error('research_flow_lease_busy')
}

async function releaseFileLease(profile: string, flowId: string, owner: string): Promise<void> {
  const file = leaseFilePath(profile, flowId)
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf-8')) as { owner?: string }
    if (raw.owner === owner) await fs.unlink(file)
  } catch {
    // Already released or stale; no action.
  }
}

async function acquireFlowLease(profile: string, flowId: string, owner: string): Promise<ResearchFlow> {
  await acquireFileLease(profile, flowId, owner)
  try {
    return await updateStore(profile, 'flow.lease.acquired', draft => {
      const flow = draft.flows.find(row => row.id === flowId)
      if (!flow) throw new Error('research_flow_not_found')
      const now = Date.now()
      if (flow.leaseUntil > now && flow.leaseOwner !== owner) throw new Error('research_flow_lease_busy')
      flow.leaseOwner = owner
      flow.leaseUntil = now + LEASE_MS
      flow.updatedAt = now
      return flow
    }, { actor: { kind: 'system', id: 'flow-runner' }, action: 'flow.lease.acquired' })
  } catch (error) {
    await releaseFileLease(profile, flowId, owner)
    throw error
  }
}

async function releaseFlowLease(profile: string, flowId: string, owner: string): Promise<void> {
  try {
    await updateStore(profile, 'flow.lease.released', draft => {
      const flow = draft.flows.find(row => row.id === flowId)
      if (flow && flow.leaseOwner === owner) {
        flow.leaseOwner = ''
        flow.leaseUntil = 0
        flow.updatedAt = Date.now()
      }
      return null
    }, { actor: { kind: 'system', id: 'flow-runner' }, action: 'flow.lease.released' })
  } finally {
    await releaseFileLease(profile, flowId, owner)
  }
}

export async function tickFlow(
  profile: string,
  flowId: string,
): Promise<{ flow: ResearchFlow; run: ResearchRun | null; state: string; detail: string; exitCode: number | null }> {
  const owner = `tick_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  await acquireFlowLease(profile, flowId, owner)
  try {
    return await tickFlowUnlocked(profile, flowId)
  } finally {
    await releaseFlowLease(profile, flowId, owner).catch(() => undefined)
  }
}

export async function cancelFlow(profile: string, flowId: string, key = ''): Promise<{ flow: ResearchFlow; detail: string }> {
  const { flow } = await getFlow(profile, flowId)
  if (flow.mode !== 'ssh') throw new Error('research_flow_not_ssh')
  if (flow.status === 'cancelled') return { flow, detail: 'already cancelled' }
  if (key !== '' && flow.cancelKey === key) return { flow, detail: 'idempotent cancel' }
  if (!flow.jobId) throw new Error('research_flow_no_running_job')
  const store = await readStore(profile)
  const job = store.jobs.find(row => row.id === flow.jobId)
  const server = job ? store.servers.find(row => row.id === job.serverId) : null
  if (!job || !server) throw new Error('research_job_not_found')
  const cancelled = await cancelJob(
    { host: server.host, user: server.user, port: server.port },
    job.pid || '',
  )
  const updated = await updateStore(profile, 'flow.cancelled', draft => {
    const current = draft.flows.find(row => row.id === flowId)
    if (!current) throw new Error('research_flow_not_found')
    const target = draft.jobs.find(row => row.id === flow.jobId)
    if (target) {
      target.state = 'cancelled'
      target.endedAt = Date.now()
      target.note = cancelled.detail
    }
    current.status = 'cancelled'
    current.error = cancelled.detail || 'cancelled by user'
    current.gate = ''
    current.leaseOwner = ''
    current.leaseUntil = 0
    current.cancelKey = key
    current.checkpoint = JSON.stringify({ jobId: current.jobId, attempt: current.attempt, state: 'cancelled', at: Date.now() })
    markStep(current, 'experiment', 'cancelled', current.error)
    return current
  })
  return { flow: updated, detail: cancelled.detail }
}

export async function resumeFlow(profile: string, flowId: string, key = ''): Promise<{ flow: ResearchFlow; run: ResearchRun | null }> {
  const current = await getFlow(profile, flowId)
  if (key !== '' && current.flow.resumeKey === key) return { flow: current.flow, run: current.run }
  if (current.flow.mode === 'ssh' && current.flow.status === 'running' && current.flow.gate === '' && current.flow.jobId) {
    if (key !== '') {
      await updateFlow(profile, flowId, flow => {
        flow.resumeKey = key
      })
    }
    const ticked = await tickFlow(profile, flowId)
    return { flow: ticked.flow, run: ticked.run }
  }
  if (current.flow.mode === 'ssh' && current.flow.status === 'cancelled') {
    if (current.flow.attempt >= current.flow.maxAttempts) throw new Error('research_flow_retry_exhausted')
    const owner = `resume_${process.pid}_${Date.now()}`
    await acquireFlowLease(profile, flowId, owner)
    try {
      const submitted = await submitExperimentJob(profile, current.flow.runId, current.flow.serverId)
      const jobId = String(submitted.job.id || '')
      const flow = await updateFlow(profile, flowId, row => {
        row.status = 'running'
        row.gate = ''
        row.error = ''
        row.jobId = jobId
        row.attempt += 1
        row.retryAt = 0
        row.leaseOwner = ''
        row.leaseUntil = 0
        row.resumeKey = key
        row.checkpoint = JSON.stringify({ jobId, attempt: row.attempt, state: 'resumed', at: Date.now() })
        markStep(row, 'experiment', 'running', `Resumed with job ${jobId}`)
      })
      return { flow, run: await readStore(profile).then(store => store.runs.find(row => row.id === flow.runId) || null) }
    } finally {
      await releaseFlowLease(profile, flowId, owner).catch(() => undefined)
    }
  }
  return current
}
