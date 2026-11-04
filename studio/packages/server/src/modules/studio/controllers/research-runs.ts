import {
  addEvidence,
  advanceRun,
  approveEvidence,
  createRun,
  getRun,
  listRuns,
  removeEvidence,
  removeRun,
  updateEvidence,
  updateRun,
} from '../services/research/runs'

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
  if (message === 'research_run_not_found' || message === 'research_evidence_not_found') {
    return fail(ctx, 404, message, message)
  }
  if (message === 'research_evidence_empty' || message === 'research_evidence_not_approved') {
    return fail(ctx, 422, message, message)
  }
  if (/required|project_not_found/.test(message)) {
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
