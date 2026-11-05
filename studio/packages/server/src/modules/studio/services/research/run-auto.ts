import { generateResultsDraft } from './run-results-draft'
import { generateRunReport } from './run-report'
import { deriveClaimsForRun, extractEvidenceForRun } from './run-evidence'
import {
  advanceRun,
  approveEvidence,
  createExperimentRecord,
  getRun,
  saveExperimentPlan,
  saveHypothesis,
} from './runs'
import { updateStore } from './store'

export interface AutoRunResult {
  run: Awaited<ReturnType<typeof getRun>>
  status: 'awaiting_result' | 'completed'
  evidenceAdded: number
  evidenceSkipped: number
  claimsDerived: number
  claimsApproved: number
  message: string
}

export async function autoRunToResultGate(profile: string, runId: string): Promise<AutoRunResult> {
  let run = await getRun(profile, runId)
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

  if (!run.approvals.some(item => item.stage === 'evidence')) {
    await approveEvidence(profile, runId, 'Automatic pipeline: evidence table locked for generation')
  }

  let claimsDerived = 0
  if (run.claims.length === 0) {
    claimsDerived = await deriveClaimsForRun(profile, runId)
  }
  run = await getRun(profile, runId)
  if (run.claims.length === 0) throw new Error('research_claims_empty')

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

  if (!run.hypothesis) {
    const claimIds = run.claims
      .filter(claim => claim.reviewStatus === 'approved')
      .map(claim => claim.id)
      .slice(0, 12)
    const firstClaim = run.claims.find(claim => claim.reviewStatus === 'approved')
    run = await saveHypothesis(profile, runId, {
      text: run.question || firstClaim?.text || 'Automated research hypothesis',
      independentVariable: '待确认',
      dependentVariable: '待确认',
      baselines: '待确认',
      metric: '待确认',
      expected: '待确认',
      falsification: '待确认',
      claimIds,
    })
  }

  if (!run.experimentPlan) {
    run = await saveExperimentPlan(profile, runId, {
      dataset: '待确认',
      baselines: '待确认',
      metrics: '待确认',
      metricSchema: '',
      family: 'auto',
      seeds: '',
      command: '',
      resources: '',
      stopCondition: '',
      successCriteria: '',
    })
  }

  if (run.experimentId === '') {
    run = await createExperimentRecord(profile, runId)
  }

  if (!run.result) {
    return {
      run,
      status: 'awaiting_result',
      evidenceAdded,
      evidenceSkipped,
      claimsDerived,
      claimsApproved: approved.count,
      message: '自动流程已到实验阶段，等待真实实验结果。',
    }
  }

  run = await advanceRun(profile, runId)
  await generateRunReport(profile, runId)
  await generateResultsDraft(profile, runId)
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
