import {
  addEvidence,
  advanceRun,
  activateHypothesisBranch,
  approveEvidence,
  archiveHypothesisBranch,
  restoreHypothesisBranch,
  createExperimentRecord,
  createHypothesisBranch,
  createRun,
  removeHypothesisBranch,
  setBranchFrozen,
  getClaimCoverage,
  getRun,
  importWorkbenchEvidence,
  listRuns,
  reviewClaim,
  recordExperimentResult,
  refreshExperimentJob,
  submitExperimentJob,
  removeEvidence,
  removeRun,
  saveExperimentPlan,
  saveHypothesis,
  updateEvidence,
  updateRun,
} from '../services/research/runs'
import { deriveClaimsForRun, extractEvidenceForRun } from '../services/research/run-evidence'
import { generateRunReport } from '../services/research/run-report'
import { generateClaimGraph } from '../services/research/run-claim-graph'
import { analyzeRunFamily } from '../services/research/run-family'
import { compareRunBranches } from '../services/research/run-branch-compare'
import { generateBranchResultsTable, setPrimaryBranch } from '../services/research/run-branch-results'
import { generateResultsDraft } from '../services/research/run-results-draft'
import { insertResultsIntoPaper } from '../services/research/run-results-insert'
import {
  beginRunExtraction,
  finishRunExtraction,
  getRunExtraction,
  runExtractionKey,
  updateRunExtraction,
} from '../services/research/run-extraction-progress'

function profileOf(ctx: any): string | undefined {
  return ctx.state?.profile?.name
}

function fail(ctx: any, status: number, error: string, code = 'invalid_request') {
  ctx.status = status
  ctx.body = { error, code }
}

function readBody(ctx: any): Record<string, unknown> | null {
  const body = ctx.request?.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  return body as Record<string, unknown>
}

function failRun(ctx: any, error: unknown) {
  const message = String((error as Error)?.message || error)
  if (/not_found$/.test(message)) {
    return fail(ctx, 404, message, message)
  }
  if (
    message === 'research_evidence_empty'
    || message === 'research_evidence_not_approved'
    || message === 'research_claims_empty'
    || message === 'research_result_confirmation_required'
    || message === 'research_result_override_reason_required'
    || message === 'research_claims_not_approved'
    || message === 'research_claims_needs_evidence'
    || message === 'research_claims_missing_evidence'
    || message === 'research_claim_contradiction_note_required'
    || message === 'research_hypothesis_claim_required'
    || message === 'research_branch_last'
    || message === 'research_branch_frozen'
    || message.startsWith('research_result_missing_metrics')
  ) {
    return fail(ctx, 422, message, message)
  }
  if (/required|incomplete|project_not_found/.test(message)) {
    return fail(ctx, 400, message, message)
  }
  return fail(ctx, 500, message || 'research run operation failed')
}

export async function listRunsHandler(ctx: any) {
  try {
    const projectId = String(ctx.query?.projectId || '').trim()
    ctx.body = { ok: true, runs: await listRuns(profileOf(ctx) || 'default', projectId) }
  } catch (error) {
    failRun(ctx, error)
  }
}

export async function getRunHandler(ctx: any) {
  try {
    ctx.body = { ok: true, run: await getRun(profileOf(ctx) || 'default', String(ctx.params.id || '')) }
  } catch (error) {
    failRun(ctx, error)
  }
}

export async function deleteRunHandler(ctx: any) {
  try {
    await removeRun(profileOf(ctx) || 'default', String(ctx.params.id || ''))
    ctx.body = { ok: true }
  } catch (error) {
    failRun(ctx, error)
  }
}

export async function createRunHandler(ctx: any) {
  const body = readBody(ctx)
  if (!body) return fail(ctx, 400, 'Invalid body')
  try {
    const run = await createRun(profileOf(ctx) || 'default', {
      projectId: String(body.projectId || ''),
      title: String(body.title || ''),
      question: String(body.question || ''),
      paperIds: Array.isArray(body.paperIds) ? body.paperIds.map(String) : undefined,
    })
    ctx.status = 201
    ctx.body = { ok: true, run }
  } catch (error) {
    failRun(ctx, error)
  }
}

export async function updateRunHandler(ctx: any) {
  const body = readBody(ctx)
  if (!body) return fail(ctx, 400, 'Invalid body')
  try {
    ctx.body = {
      ok: true,
      run: await updateRun(profileOf(ctx) || 'default', String(ctx.params.id || ''), body as never),
    }
  } catch (error) {
    failRun(ctx, error)
  }
}

export async function addEvidenceHandler(ctx: any) {
  const body = readBody(ctx)
  if (!body) return fail(ctx, 400, 'Invalid body')
  try {
    ctx.status = 201
    ctx.body = {
      ok: true,
      evidence: await addEvidence(profileOf(ctx) || 'default', String(ctx.params.id || ''), body as never),
    }
  } catch (error) {
    failRun(ctx, error)
  }
}

export async function updateEvidenceHandler(ctx: any) {
  const body = readBody(ctx)
  if (!body) return fail(ctx, 400, 'Invalid body')
  try {
    ctx.body = {
      ok: true,
      evidence: await updateEvidence(
        profileOf(ctx) || 'default',
        String(ctx.params.id || ''),
        String(ctx.params.evidenceId || ''),
        body as never,
      ),
    }
  } catch (error) {
    failRun(ctx, error)
  }
}

export async function removeEvidenceHandler(ctx: any) {
  try {
    await removeEvidence(
      profileOf(ctx) || 'default',
      String(ctx.params.id || ''),
      String(ctx.params.evidenceId || ''),
    )
    ctx.body = { ok: true }
  } catch (error) {
    failRun(ctx, error)
  }
}

export async function extractEvidenceHandler(ctx: any) {
  const body = readBody(ctx) || {}
  const profile = profileOf(ctx) || 'default'
  const runId = String(ctx.params.id || '')
  const asyncMode = String(ctx.query?.async || body.async || '') === 'true'
  const options = {
    paperIds: Array.isArray(body.paperIds) ? body.paperIds.map(String) : undefined,
    maxPerPaper: typeof body.maxPerPaper === 'number' ? body.maxPerPaper : undefined,
  }
  if (asyncMode) {
    const key = runExtractionKey(profile, runId)
    const job = beginRunExtraction(key)
    if (job === null) return fail(ctx, 409, 'evidence extraction already running', 'extraction_in_progress')
    ctx.status = 202
    ctx.body = { ok: true, job }
    void extractEvidenceForRun(profile, runId, {
      ...options,
      onProgress: progress => {
        updateRunExtraction(key, {
          phase: progress.phase,
          current: progress.current,
          total: progress.total,
          message: progress.message,
        })
      },
    })
      .then(result => finishRunExtraction(key, result))
      .catch(error => finishRunExtraction(key, { error: String((error as Error)?.message || error) }))
    return
  }
  try {
    const result = await extractEvidenceForRun(profile, runId, options)
    ctx.body = {
      ok: true,
      ...result,
      run: await getRun(profile, runId),
    }
  } catch (error) {
    failRun(ctx, error)
  }
}

export async function extractEvidenceStatusHandler(ctx: any) {
  const key = runExtractionKey(profileOf(ctx) || 'default', String(ctx.params.id || ''))
  ctx.set('Cache-Control', 'no-store')
  ctx.body = { ok: true, job: getRunExtraction(key) }
}

export async function createBranchHandler(ctx: any) {
  try {
    ctx.body = {
      ok: true,
      run: await createHypothesisBranch(profileOf(ctx) || 'default', String(ctx.params.id || '')),
    }
  } catch (error) {
    failRun(ctx, error)
  }
}

export async function archiveBranchHandler(ctx: any) {
  try {
    ctx.body = {
      ok: true,
      run: await archiveHypothesisBranch(
        profileOf(ctx) || 'default',
        String(ctx.params.id || ''),
        String(ctx.params.branchId || ''),
      ),
    }
  } catch (error) {
    failRun(ctx, error)
  }
}

export async function restoreBranchHandler(ctx: any) {
  try {
    ctx.body = {
      ok: true,
      run: await restoreHypothesisBranch(
        profileOf(ctx) || 'default',
        String(ctx.params.id || ''),
        String(ctx.params.branchId || ''),
      ),
    }
  } catch (error) {
    failRun(ctx, error)
  }
}

export async function removeBranchHandler(ctx: any) {
  try {
    ctx.body = {
      ok: true,
      run: await removeHypothesisBranch(
        profileOf(ctx) || 'default',
        String(ctx.params.id || ''),
        String(ctx.params.branchId || ''),
      ),
    }
  } catch (error) {
    failRun(ctx, error)
  }
}

export async function activateBranchHandler(ctx: any) {
  try {
    ctx.body = {
      ok: true,
      run: await activateHypothesisBranch(
        profileOf(ctx) || 'default',
        String(ctx.params.id || ''),
        String(ctx.params.branchId || ''),
      ),
    }
  } catch (error) {
    failRun(ctx, error)
  }
}

export async function saveHypothesisHandler(ctx: any) {
  const body = readBody(ctx)
  if (!body) return fail(ctx, 400, 'Invalid body')
  try {
    ctx.body = {
      ok: true,
      run: await saveHypothesis(profileOf(ctx) || 'default', String(ctx.params.id || ''), body as never),
    }
  } catch (error) {
    failRun(ctx, error)
  }
}

export async function saveExperimentPlanHandler(ctx: any) {
  const body = readBody(ctx)
  if (!body) return fail(ctx, 400, 'Invalid body')
  try {
    ctx.body = {
      ok: true,
      run: await saveExperimentPlan(profileOf(ctx) || 'default', String(ctx.params.id || ''), body as never),
    }
  } catch (error) {
    failRun(ctx, error)
  }
}

export async function createExperimentHandler(ctx: any) {
  try {
    ctx.body = {
      ok: true,
      run: await createExperimentRecord(profileOf(ctx) || 'default', String(ctx.params.id || '')),
    }
  } catch (error) {
    failRun(ctx, error)
  }
}

export async function submitExperimentHandler(ctx: any) {
  const body = readBody(ctx) || {}
  try {
    ctx.body = {
      ok: true,
      ...(await submitExperimentJob(
        profileOf(ctx) || 'default',
        String(ctx.params.id || ''),
        String(body.serverId || ''),
      )),
    }
  } catch (error) {
    failRun(ctx, error)
  }
}

export async function refreshExperimentHandler(ctx: any) {
  try {
    ctx.body = {
      ok: true,
      ...(await refreshExperimentJob(
        profileOf(ctx) || 'default',
        String(ctx.params.id || ''),
      )),
    }
  } catch (error) {
    failRun(ctx, error)
  }
}

export async function recordResultHandler(ctx: any) {
  const body = readBody(ctx)
  if (!body) return fail(ctx, 400, 'Invalid body')
  try {
    ctx.body = {
      ok: true,
      run: await recordExperimentResult(profileOf(ctx) || 'default', String(ctx.params.id || ''), body as never),
    }
  } catch (error) {
    failRun(ctx, error)
  }
}

export async function runResultsDraftHandler(ctx: any) {
  try {
    ctx.body = {
      ok: true,
      ...(await generateResultsDraft(
        profileOf(ctx) || 'default',
        String(ctx.params.id || ''),
        '',
        String(ctx.query?.branchId || ''),
      )),
    }
  } catch (error) {
    failRun(ctx, error)
  }
}

export async function insertResultsHandler(ctx: any) {
  const body = readBody(ctx) || {}
  try {
    ctx.body = {
      ok: true,
      ...(await insertResultsIntoPaper(
        profileOf(ctx) || 'default',
        String(ctx.params.id || ''),
        String(body.figureId || ''),
        String(body.branchId || ''),
      )),
    }
  } catch (error) {
    failRun(ctx, error)
  }
}

export async function branchResultsTableHandler(ctx: any) {
  try {
    ctx.body = {
      ok: true,
      ...(await generateBranchResultsTable(profileOf(ctx) || 'default', String(ctx.params.id || ''))),
    }
  } catch (error) {
    failRun(ctx, error)
  }
}

export async function primaryBranchHandler(ctx: any) {
  const body = readBody(ctx) || {}
  try {
    ctx.body = {
      ok: true,
      run: await setPrimaryBranch(
        profileOf(ctx) || 'default',
        String(ctx.params.id || ''),
        String(body.metric || ''),
        String(body.branchId || ''),
      ),
    }
  } catch (error) {
    failRun(ctx, error)
  }
}

export async function freezeBranchHandler(ctx: any) {
  const body = readBody(ctx) || {}
  try {
    ctx.body = {
      ok: true,
      run: await setBranchFrozen(
        profileOf(ctx) || 'default',
        String(ctx.params.id || ''),
        String(ctx.params.branchId || ''),
        body.frozen === true,
      ),
    }
  } catch (error) {
    failRun(ctx, error)
  }
}

export async function branchCompareHandler(ctx: any) {
  try {
    ctx.body = {
      ok: true,
      ...(await compareRunBranches(profileOf(ctx) || 'default', String(ctx.params.id || ''))),
    }
  } catch (error) {
    failRun(ctx, error)
  }
}

export async function familyAnalysisHandler(ctx: any) {
  try {
    ctx.body = {
      ok: true,
      analysis: await analyzeRunFamily(
        profileOf(ctx) || 'default',
        String(ctx.params.id || ''),
        String(ctx.query?.family || ''),
      ),
    }
  } catch (error) {
    failRun(ctx, error)
  }
}

export async function claimGraphHandler(ctx: any) {
  try {
    ctx.body = {
      ok: true,
      ...(await generateClaimGraph(profileOf(ctx) || 'default', String(ctx.params.id || ''))),
    }
  } catch (error) {
    failRun(ctx, error)
  }
}

export async function runReportHandler(ctx: any) {
  try {
    ctx.body = {
      ok: true,
      ...(await generateRunReport(
        profileOf(ctx) || 'default',
        String(ctx.params.id || ''),
        String(ctx.query?.branchId || ''),
      )),
    }
  } catch (error) {
    failRun(ctx, error)
  }
}

export async function importWorkbenchEvidenceHandler(ctx: any) {
  const body = readBody(ctx) || {}
  try {
    const result = await importWorkbenchEvidence(
      profileOf(ctx) || 'default',
      String(ctx.params.id || ''),
      Array.isArray(body.evidenceIds) ? body.evidenceIds.map(String) : [],
    )
    ctx.body = { ok: true, ...result }
  } catch (error) {
    failRun(ctx, error)
  }
}

export async function deriveClaimsHandler(ctx: any) {
  try {
    const count = await deriveClaimsForRun(
      profileOf(ctx) || 'default',
      String(ctx.params.id || ''),
    )
    ctx.body = {
      ok: true,
      count,
      run: await getRun(profileOf(ctx) || 'default', String(ctx.params.id || '')),
    }
  } catch (error) {
    failRun(ctx, error)
  }
}

export async function reviewClaimHandler(ctx: any) {
  const body = readBody(ctx) || {}
  try {
    ctx.body = {
      ok: true,
      ...(await reviewClaim(
        profileOf(ctx) || 'default',
        String(ctx.params.id || ''),
        String(ctx.params.claimId || ''),
        {
          reviewStatus: String(body.reviewStatus || '') as never,
          reviewNote: String(body.reviewNote || ''),
        },
      )),
    }
  } catch (error) {
    failRun(ctx, error)
  }
}

export async function claimCoverageHandler(ctx: any) {
  try {
    ctx.body = {
      ok: true,
      coverage: await getClaimCoverage(
        profileOf(ctx) || 'default',
        String(ctx.params.id || ''),
      ),
    }
  } catch (error) {
    failRun(ctx, error)
  }
}

export async function approveEvidenceHandler(ctx: any) {
  const body = readBody(ctx) || {}
  try {
    ctx.body = {
      ok: true,
      run: await approveEvidence(profileOf(ctx) || 'default', String(ctx.params.id || ''), String(body.note || '')),
    }
  } catch (error) {
    failRun(ctx, error)
  }
}

export async function advanceRunHandler(ctx: any) {
  try {
    ctx.body = { ok: true, run: await advanceRun(profileOf(ctx) || 'default', String(ctx.params.id || '')) }
  } catch (error) {
    failRun(ctx, error)
  }
}
