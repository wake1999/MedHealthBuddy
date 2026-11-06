import { generateResultsDraft } from './run-results-draft'
import { generateRunReport } from './run-report'
import { deriveClaimsForRun, extractEvidenceForRun } from './run-evidence'
import {
  advanceRun,
  approveEvidence,
  createExperimentRecord,
  getRun,
  recordExperimentResult,
  refreshExperimentJob,
  requestRunApproval,
  saveExperimentPlan,
  saveHypothesis,
  submitExperimentJob,
} from './runs'
import { uploadRawArtifact } from './run-merge-artifacts'
import { downloadRemoteFile } from './ssh'
import { fetchPaperPdf } from './pdf'
import { searchArxiv, type ArxivEntry } from './arxiv'
import { newId, readStore, updateStore } from './store'

export interface AutoRunOptions {
  serverId?: string
  command?: string
  artifactPath?: string
  dataset?: string
  baselines?: string
  metrics?: string
  timeoutMs?: number
  query?: string
  maxPapers?: number
}

export interface AutoRunResult {
  run: Awaited<ReturnType<typeof getRun>>
  status: 'awaiting_approval' | 'awaiting_result' | 'completed'
  evidenceAdded: number
  evidenceSkipped: number
  claimsDerived: number
  claimsApproved: number
  message: string
  jobId?: string
  approvalId?: string
}

function hasApproval(run: Awaited<ReturnType<typeof getRun>>, type: 'evidence' | 'claims' | 'experiment' | 'result' | 'final'): boolean {
  return run.approvals.some(item => item.type === type
    || (type === 'evidence' && item.stage === 'evidence' && item.type === undefined))
}

function approvalResult(
  run: Awaited<ReturnType<typeof getRun>>,
  message: string,
  counts: Pick<AutoRunResult, 'evidenceAdded' | 'evidenceSkipped' | 'claimsDerived' | 'claimsApproved'>,
): AutoRunResult {
  return {
    run,
    status: 'awaiting_approval',
    ...counts,
    message,
    approvalId: run.approvalRequest?.id,
  }
}

const KNOWN_METRICS = ['F1', 'AUC', 'accuracy', 'precision', 'recall', 'RMSE', 'MAE', 'BLEU', 'ROUGE']

function deriveMetrics(run: Awaited<ReturnType<typeof getRun>>, requested: string): string {
  if (requested.trim() !== '') return requested.trim()
  const haystack = [run.question, run.title, ...run.claims.map(claim => claim.text)].join(' ')
  const found = KNOWN_METRICS.filter(metric => new RegExp(`\\b${metric}\\b`, 'i').test(haystack))
  return found.length > 0 ? found.join(', ') : 'score'
}

function metricSchemaFor(metrics: string): string {
  return metrics
    .split(/[,;]+/)
    .map(metric => metric.trim())
    .filter(Boolean)
    .map(metric => `${metric}:${/rmse|mae/i.test(metric) ? 'min' : 'max'}:required`)
    .join(', ')
}

function artifactSamples(content: string): { samples: Record<string, number[]>; metric: string } {
  const parsed = JSON.parse(content) as {
    schema?: string
    metric?: string
    rows?: Array<{ value?: unknown }>
  }
  if (parsed.schema !== 'mhb.raw-observations.v1') throw new Error('research_artifact_schema_invalid')
  const metric = String(parsed.metric || 'score').trim()
  const values = (parsed.rows || [])
    .map(row => Number(row.value))
    .filter(value => Number.isFinite(value))
  if (values.length === 0) throw new Error('research_artifact_rows_invalid')
  return { samples: { [metric.toLowerCase()]: values }, metric }
}

async function configureAutomation(
  profile: string,
  runId: string,
  options: AutoRunOptions,
): Promise<void> {
  await updateStore(profile, 'run.automation.configured', draft => {
    const run = draft.runs.find(row => row.id === runId)
    if (!run) throw new Error('research_run_not_found')
    const previous = run.automation
    run.automation = {
      enabled: true,
      serverId: options.serverId ?? previous?.serverId ?? '',
      command: options.command ?? previous?.command ?? '',
      artifactPath: options.artifactPath ?? previous?.artifactPath ?? '',
      query: options.query ?? previous?.query ?? '',
      dataset: options.dataset ?? previous?.dataset ?? '',
      baselines: options.baselines ?? previous?.baselines ?? '',
      metrics: options.metrics ?? previous?.metrics ?? '',
      timeoutMs: Number(options.timeoutMs ?? previous?.timeoutMs ?? 120_000),
      nextRunAt: 0,
      lastError: '',
    }
    run.updatedAt = Date.now()
    return run
  }, { actor: { kind: 'system', id: 'run-orchestrator' }, action: 'run.automation.configured' })
}

async function importArxivForRun(
  profile: string,
  runId: string,
  entries: ArxivEntry[],
): Promise<string[]> {
  const selected = entries.slice(0, 3)
  if (selected.length === 0) return []
  return updateStore(profile, 'run.literature.imported', draft => {
    const run = draft.runs.find(row => row.id === runId)
    if (!run) throw new Error('research_run_not_found')
    const ids: string[] = []
    for (const entry of selected) {
      const existing = draft.papers.find(paper => paper.projectId === run.projectId
        && paper.arxivId === entry.arxivId)
      if (existing) {
        ids.push(existing.id)
        continue
      }
      const paperId = newId('paper')
      draft.papers.unshift({
        id: paperId,
        projectId: run.projectId,
        title: entry.title,
        authors: entry.authors,
        year: entry.year,
        venue: entry.venue || 'arXiv',
        doi: entry.doi,
        url: entry.url || `https://arxiv.org/abs/${entry.arxivId}`,
        arxivId: entry.arxivId,
        score: 0,
        status: 'new',
        notes: entry.summary,
        tags: ['auto-selected'],
        addedAt: Date.now(),
      })
      ids.push(paperId)
    }
    run.paperIds = [...new Set(ids)]
    run.updatedAt = Date.now()
    return run.paperIds
  }, { actor: { kind: 'system', id: 'run-orchestrator' }, action: 'run.literature.imported' })
}

async function autoSelectLiterature(profile: string, runId: string, query: string): Promise<string[]> {
  const result = await searchArxiv(query, 5)
  if (result.error) throw new Error(`research_literature_search_failed: ${result.error}`)
  const imported = await importArxivForRun(profile, runId, result.entries)
  if (imported.length === 0) throw new Error('research_literature_search_empty')
  const ready: string[] = []
  const store = await readStore(profile)
  const run = store.runs.find(row => row.id === runId)
  if (!run) throw new Error('research_run_not_found')
  for (const paperId of imported) {
    const paper = store.papers.find(row => row.id === paperId)
    if (!paper?.arxivId) continue
    try {
      await fetchPaperPdf(profile, run.projectId, paper.arxivId)
      ready.push(paperId)
    } catch {
      // Keep metadata; evidence extraction will skip papers without a PDF.
    }
  }
  if (ready.length === 0) throw new Error('research_literature_pdf_unavailable')
  await updateStore(profile, 'run.literature.ready', draft => {
    const current = draft.runs.find(row => row.id === runId)
    if (current) {
      current.paperIds = ready
      current.updatedAt = Date.now()
    }
  }, { actor: { kind: 'system', id: 'run-orchestrator' }, action: 'run.literature.ready' })
  return ready
}

async function finalizeJobResult(
  profile: string,
  runId: string,
  serverId: string,
  artifactPath: string,
  jobId: string,
  insight: Awaited<ReturnType<typeof refreshExperimentJob>>['insight'],
): Promise<Awaited<ReturnType<typeof getRun>>> {
  let run = await getRun(profile, runId)
  let samples: Record<string, number[]> | null = null
  let artifactName = ''
  if (artifactPath !== '') {
    const store = await readStore(profile)
    const server = store.servers.find(row => row.id === serverId)
    if (!server) throw new Error('research_server_not_found')
    const downloaded = await downloadRemoteFile(
      { host: server.host, user: server.user, port: server.port },
      artifactPath,
    )
    if (!downloaded.ok) throw new Error(downloaded.detail || 'remote_artifact_download_failed')
    const content = downloaded.data.toString('utf-8')
    const parsed = artifactSamples(content)
    samples = parsed.samples
    artifactName = artifactPath.split('/').pop() || 'remote-artifact.json'
    if (run.activeBranchId) {
      await uploadRawArtifact(profile, runId, run.activeBranchId, {
        name: artifactName,
        content,
      })
    }
    run = await getRun(profile, runId)
  }
  if (!samples && insight?.metrics?.length) {
    samples = Object.fromEntries(insight.metrics.map(metric => [metric.name.toLowerCase(), [metric.value]]))
  }
  if (!samples) return run
  const metricText = Object.entries(samples)
    .flatMap(([metric, values]) => values.map(value => `${metric}=${value}`))
    .join('\n')
  return recordExperimentResult(profile, runId, {
    summary: `SSH job ${jobId} completed${artifactName ? `; artifact ${artifactName}` : ''}.`,
    metrics: metricText,
    metricSamples: samples,
    confirmedFinal: true,
  })
}

/** Poll an already-submitted job; only records a result once it finished successfully. */
export async function refreshAutomationJob(
  profile: string,
  runId: string,
  serverId: string,
  artifactPath: string,
): Promise<{ run: Awaited<ReturnType<typeof getRun>>; state: string }> {
  const refreshed = await refreshExperimentJob(profile, runId)
  const state = refreshed.state?.state || 'unknown'
  if (state !== 'succeeded') {
    return { run: refreshed.run, state }
  }
  const run = await finalizeJobResult(
    profile,
    runId,
    serverId,
    artifactPath,
    String(refreshed.job?.id || ''),
    refreshed.insight,
  )
  return { run, state }
}

async function submitAndWait(
  profile: string,
  runId: string,
  serverId: string,
  command: string,
  artifactPath: string,
  timeoutMs: number,
): Promise<{ run: Awaited<ReturnType<typeof getRun>>; message: string; jobId: string }> {
  const submitted = await submitExperimentJob(profile, runId, serverId)
  const jobId = String(submitted.job.id || '')
  const deadline = Date.now() + Math.max(10_000, Math.min(timeoutMs, 300_000))
  let insight: Awaited<ReturnType<typeof refreshExperimentJob>>['insight'] = null
  let state = 'running'
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1500))
    const refreshed = await refreshExperimentJob(profile, runId)
    insight = refreshed.insight
    state = refreshed.state?.state || 'unknown'
    if (state === 'succeeded' || state === 'failed') break
  }
  if (state !== 'succeeded') {
    return {
      run: await getRun(profile, runId),
      jobId,
      message: state === 'failed' ? 'SSH 任务失败，未生成结果。' : 'SSH 任务仍在运行，已保留 job id。',
    }
  }

  let run = await getRun(profile, runId)
  let samples: Record<string, number[]> | null = null
  let artifactName = ''
  if (artifactPath !== '') {
    const store = await readStore(profile)
    const server = store.servers.find(row => row.id === serverId)
    if (!server) throw new Error('research_server_not_found')
    const downloaded = await downloadRemoteFile(
      { host: server.host, user: server.user, port: server.port },
      artifactPath,
    )
    if (!downloaded.ok) throw new Error(downloaded.detail || 'remote_artifact_download_failed')
    const content = downloaded.data.toString('utf-8')
    const parsed = artifactSamples(content)
    samples = parsed.samples
    artifactName = artifactPath.split('/').pop() || 'remote-artifact.json'
    if (run.activeBranchId) {
      await uploadRawArtifact(profile, runId, run.activeBranchId, {
        name: artifactName,
        content,
      })
    }
    run = await getRun(profile, runId)
  }

  if (!samples && insight?.metrics?.length) {
    samples = Object.fromEntries(insight.metrics.map(metric => [metric.name.toLowerCase(), [metric.value]]))
  }
  if (!samples) {
    return {
      run,
      jobId,
      message: 'SSH 任务成功，但未找到可解析的真实产物；等待人工录入结果。',
    }
  }
  const metricText = Object.entries(samples)
    .flatMap(([metric, values]) => values.map(value => `${metric}=${value}`))
    .join('\n')
  const result = await recordExperimentResult(profile, runId, {
    summary: `SSH job ${jobId} completed${artifactName ? `; artifact ${artifactName}` : ''}.`,
    metrics: metricText,
    metricSamples: samples,
    confirmedFinal: true,
  })
  return {
    run: result,
    jobId,
    message: 'SSH 任务完成，真实产物已回传并记录结果。',
  }
}

export async function autoRunToResultGate(
  profile: string,
  runId: string,
  options: AutoRunOptions = {},
): Promise<AutoRunResult> {
  await configureAutomation(profile, runId, options)
  let run = await getRun(profile, runId)
  if (run.paperIds.length === 0) {
    await autoSelectLiterature(profile, runId, String(options.query || run.question || '').trim())
    run = await getRun(profile, runId)
  }
  if (run.paperIds.length === 0) throw new Error('research_run_no_papers')

  let evidenceAdded = 0
  let evidenceSkipped = 0
  if (run.evidence.length === 0) {
    const extracted = await extractEvidenceForRun(profile, runId, { maxPerPaper: 4 })
    evidenceAdded = extracted.added
    evidenceSkipped = extracted.skipped
    run = await getRun(profile, runId)
  }
  if (run.evidence.length === 0) throw new Error('research_evidence_empty')

  const evidenceNeedsReview = run.evidence.some(item =>
    item.support !== 'supports' || item.confidence < 0.8)
  if (evidenceNeedsReview && !hasApproval(run, 'evidence')) {
    run = await requestRunApproval(profile, runId, {
      type: 'evidence',
      stage: 'evidence',
      reason: '部分证据置信度较低或包含矛盾/混合结论，需要人工确认后锁定证据表。',
      payload: {
        evidenceCount: String(run.evidence.length),
        lowConfidence: String(run.evidence.filter(item => item.confidence < 0.8).length),
      },
    })
    return approvalResult(run, '证据表需要人工审核；批准后自动继续生成 Claim。', {
      evidenceAdded,
      evidenceSkipped,
      claimsDerived: 0,
      claimsApproved: 0,
    })
  }
  if (!hasApproval(run, 'evidence')) {
    await approveEvidence(profile, runId, 'Automatic pipeline: evidence table locked for generation')
    run = await getRun(profile, runId)
  }

  let claimsDerived = 0
  if (run.claims.length === 0) {
    claimsDerived = await deriveClaimsForRun(profile, runId)
  }
  run = await getRun(profile, runId)
  if (run.claims.length === 0) throw new Error('research_claims_empty')

  const claimsNeedReview = run.claims.some(claim => claim.reviewStatus !== 'approved'
    && (claim.contradictionIds.length > 0 || claim.confidence < 0.8 || claim.evidenceIds.length === 0))
  if (claimsNeedReview && !hasApproval(run, 'claims')) {
    run = await requestRunApproval(profile, runId, {
      type: 'claims',
      stage: 'evidence',
      reason: '存在矛盾、低置信度或缺少证据的 Claim，需要人工审核后再进入假设阶段。',
      payload: {
        claimCount: String(run.claims.length),
        contradictionCount: String(run.claims.filter(claim => claim.contradictionIds.length > 0).length),
        missingEvidence: String(run.claims.filter(claim => claim.evidenceIds.length === 0).length),
      },
    })
    return approvalResult(run, 'Claim 需要人工审核；批准后自动继续生成假设和实验计划。', {
      evidenceAdded,
      evidenceSkipped,
      claimsDerived,
      claimsApproved: 0,
    })
  }

  const approved = await updateStore(profile, 'run.auto.claims-approved', draft => {
    const current = draft.runs.find(row => row.id === runId)
    if (!current) throw new Error('research_run_not_found')
    let count = 0
    for (const claim of current.claims) {
      if (claim.reviewStatus === 'approved') {
        count += 1
        continue
      }
      if (claim.evidenceIds.length > 0 && claim.status !== 'gap') {
        claim.reviewStatus = 'approved'
        claim.reviewNote = claim.contradictionIds.length > 0
          ? 'Automatic pipeline; contradiction retained for human review.'
          : 'Automatic pipeline; source quote retained for final review.'
        claim.reviewedAt = Date.now()
        claim.updatedAt = claim.reviewedAt
        count += 1
      } else {
        claim.reviewStatus = 'rejected'
        claim.reviewNote = 'Automatic pipeline: no usable source evidence.'
        claim.reviewedAt = Date.now()
        claim.updatedAt = claim.reviewedAt
      }
    }
    current.updatedAt = Date.now()
    return { run: current, count }
  }, { actor: { kind: 'system', id: 'auto-run' }, action: 'run.auto.claims-approved' })
  run = approved.run
  if (approved.count === 0) throw new Error('research_claims_not_approved')

  const metrics = deriveMetrics(run, String(options.metrics || run.experimentPlan?.metrics || ''))
  const command = String(options.command || run.experimentPlan?.command || '').trim()

  if (!run.hypothesis) {
    const claimIds = run.claims
      .filter(claim => claim.reviewStatus === 'approved')
      .map(claim => claim.id)
      .slice(0, 12)
    const firstClaim = run.claims.find(claim => claim.reviewStatus === 'approved')
    run = await saveHypothesis(profile, runId, {
      text: run.question || firstClaim?.text || 'Automated research hypothesis',
      independentVariable: '待确认',
      dependentVariable: metrics,
      baselines: String(options.baselines || run.experimentPlan?.baselines || '待确认'),
      metric: metrics,
      expected: '待确认',
      falsification: '待确认',
      claimIds,
    })
  }

  if (!run.experimentPlan || run.experimentPlan.command.trim() === '') {
    run = await saveExperimentPlan(profile, runId, {
      dataset: String(options.dataset || run.experimentPlan?.dataset || '待确认'),
      baselines: String(options.baselines || run.experimentPlan?.baselines || '待确认'),
      metrics,
      metricSchema: run.experimentPlan?.metricSchema?.length
        ? run.experimentPlan.metricSchema.map(spec => `${spec.name}:${spec.direction}:${spec.required ? 'required' : 'optional'}`).join(', ')
        : metricSchemaFor(metrics),
      family: run.experimentPlan?.family || 'auto',
      seeds: run.experimentPlan?.seeds || '1-3',
      command,
      resources: run.experimentPlan?.resources || '',
      stopCondition: run.experimentPlan?.stopCondition || '',
      successCriteria: run.experimentPlan?.successCriteria || `Improve ${metrics} over the baseline.`,
    })
  }

  if (run.experimentId === '') {
    run = await createExperimentRecord(profile, runId)
  }

  if (!run.result && options.serverId && command) {
    const effectiveCommand = String(run.experimentPlan?.command || command).trim()
    if (!hasApproval(run, 'experiment')) {
      run = await requestRunApproval(profile, runId, {
        type: 'experiment',
        stage: 'experiment',
        reason: '即将在远程服务器执行实验命令，需要确认服务器、命令和产物路径。',
        payload: {
          serverId: String(options.serverId),
          command: effectiveCommand,
          artifactPath: String(options.artifactPath || ''),
        },
      })
      return approvalResult(run, '实验执行需要人工批准；批准后自动提交并等待结果。', {
        evidenceAdded,
        evidenceSkipped,
        claimsDerived,
        claimsApproved: approved.count,
      })
    }
    if (run.experimentJobId !== '') {
      const refreshed = await refreshAutomationJob(
        profile,
        runId,
        String(options.serverId),
        String(options.artifactPath || ''),
      )
      run = refreshed.run
      if (!run.result) {
        return {
          run,
          status: 'awaiting_result',
          evidenceAdded,
          evidenceSkipped,
          claimsDerived,
          claimsApproved: approved.count,
          message: refreshed.state === 'failed'
            ? 'SSH 任务失败，未生成结果。'
            : 'SSH 任务仍在运行，后台编排器会继续等待结果。',
          jobId: run.experimentJobId,
        }
      }
    } else {
      const submitted = await submitExperimentJob(profile, runId, String(options.serverId))
      run = await getRun(profile, runId)
      return {
        run,
        status: 'awaiting_result',
        evidenceAdded,
        evidenceSkipped,
        claimsDerived,
        claimsApproved: approved.count,
        message: 'SSH 任务已提交，后台编排器会等待任务完成并回传结果。',
        jobId: String(submitted.job.id || ''),
      }
    }
  }

  if (!run.result) {
    return {
      run,
      status: 'awaiting_result',
      evidenceAdded,
      evidenceSkipped,
      claimsDerived,
      claimsApproved: approved.count,
      message: command === ''
        ? '计划已自动填写，但还没有可执行命令；填写命令并选择 SSH 服务器后可自动提交。'
        : '自动流程已到实验阶段，等待真实实验结果。',
    }
  }

  if (run.fixtureOwnerUserId === undefined && !hasApproval(run, 'result')) {
    run = await requestRunApproval(profile, runId, {
      type: 'result',
      stage: 'analysis',
      reason: '实验结果已回传，需要人工确认结果和指标是否可信，再生成最终报告。',
      payload: {
        resultSummary: String(run.result.summary || ''),
        metrics: String(run.result.metrics || ''),
      },
    })
    return approvalResult(run, '实验结果需要人工确认；批准后自动生成报告和 Results 草稿。', {
      evidenceAdded,
      evidenceSkipped,
      claimsDerived,
      claimsApproved: approved.count,
    })
  }

  run = await advanceRun(profile, runId)
  await generateRunReport(profile, runId)
  await generateResultsDraft(profile, runId)
  run = await getRun(profile, runId)

  if (run.fixtureOwnerUserId === undefined && !hasApproval(run, 'final')) {
    run = await requestRunApproval(profile, runId, {
      type: 'final',
      stage: 'analysis',
      reason: '报告和 Results 草稿已生成，需要人工确认后才能结束研究运行。',
      payload: {
        stage: run.stage,
        report: 'generated',
        resultsDraft: 'generated',
      },
    })
    return approvalResult(run, '最终报告需要人工确认；批准后将结束本次研究运行。', {
      evidenceAdded,
      evidenceSkipped,
      claimsDerived,
      claimsApproved: approved.count,
    })
  }

  return {
    run,
    status: 'completed',
    evidenceAdded,
    evidenceSkipped,
    claimsDerived,
    claimsApproved: approved.count,
    message: '自动流程已生成报告和 Results 草稿。',
  }
}
