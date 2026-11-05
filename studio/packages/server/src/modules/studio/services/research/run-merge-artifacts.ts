import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { readStore, researchRoot, updateStore, type ResearchRunArtifact, type ResearchRunMerge } from './store'

interface RawArtifactPayload {
  schema?: string
  metric?: string
  dataset?: string
  split?: string
  rows?: Array<Record<string, unknown>>
  redactedFields?: string[]
}

const ALLOWED_ROW_FIELDS = new Set(['seed', 'value', 'group'])

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function artifactDir(profile: string | undefined, projectId: string, runId: string): string {
  return path.join(researchRoot(profile), 'projects', projectId, 'artifacts', runId)
}

function parsePayload(content: string, fallbackMetric = ''): RawArtifactPayload {
  let payload: RawArtifactPayload
  try {
    payload = JSON.parse(content) as RawArtifactPayload
  } catch {
    throw new Error('research_artifact_invalid_json')
  }
  if (payload.schema !== 'mhb.raw-observations.v1') throw new Error('research_artifact_schema_invalid')
  const metric = String(payload.metric || fallbackMetric).trim()
  if (metric === '') throw new Error('research_artifact_metric_required')
  const rows = Array.isArray(payload.rows) ? payload.rows : []
  if (rows.length === 0 || rows.some(row => typeof row.value !== 'number' || !Number.isFinite(row.value))) {
    throw new Error('research_artifact_rows_invalid')
  }
  const redacted = new Set<string>()
  const sanitized = rows.map(row => {
    for (const key of Object.keys(row)) {
      if (!ALLOWED_ROW_FIELDS.has(key)) redacted.add(key)
    }
    return {
      value: Number(row.value),
      ...(typeof row.seed === 'number' ? { seed: row.seed } : {}),
      ...(typeof row.group === 'string' ? { group: row.group } : {}),
    }
  })
  return {
    ...payload,
    metric,
    dataset: String(payload.dataset || '').trim(),
    split: String(payload.split || '').trim(),
    rows: sanitized,
    redactedFields: Array.from(redacted),
  }
}

export async function uploadRawArtifact(
  profile: string,
  runId: string,
  branchId: string,
  body: { name?: string; content?: string; sha256?: string },
): Promise<{ run: Awaited<ReturnType<typeof readStore>>['runs'][number]; artifact: ResearchRunArtifact }> {
  const store = await readStore(profile)
  const run = store.runs.find(row => row.id === runId)
  if (!run) throw new Error('research_run_not_found')
  const branch = run.branches.find(row => row.id === branchId && row.archivedAt === 0)
  if (!branch) throw new Error('research_branch_not_found')
  if (branch.frozenAt) throw new Error('research_branch_frozen')
  const content = String(body.content || '')
  if (content === '') throw new Error('research_artifact_content_required')
  const payload = parsePayload(content, '')
  const incomingDigest = sha256(content)
  if (body.sha256 && body.sha256.trim() !== '' && body.sha256.trim() !== incomingDigest) {
    throw new Error('research_artifact_hash_mismatch')
  }
  const id = `artifact_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const dir = artifactDir(profile, run.projectId, runId)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${id}.json`)
  const normalized = JSON.stringify(payload, null, 2)
  const storedDigest = sha256(normalized)
  await fs.writeFile(file, normalized, 'utf-8')
  const artifact: ResearchRunArtifact = {
    id,
    branchId,
    name: String(body.name || `${payload.metric}.json`).slice(0, 200),
    kind: 'raw-observations',
    metric: payload.metric!,
    dataset: payload.dataset || '',
    split: payload.split || '',
    sha256: storedDigest,
    size: Buffer.byteLength(normalized),
    file,
    redactedFields: payload.redactedFields || [],
    createdAt: Date.now(),
  }
  const updated = await updateStore(profile, 'run.artifact.uploaded', draft => {
    const target = draft.runs.find(row => row.id === runId)
    if (!target) throw new Error('research_run_not_found')
    target.artifacts.push(artifact)
    target.updatedAt = Date.now()
    return target
  }, { actor: { kind: 'user', id: 'workbench' }, action: 'run.artifact.uploaded' })
  return { run: updated, artifact }
}

export interface ArtifactCleanupPlan {
  keep: ResearchRunArtifact[]
  remove: ResearchRunArtifact[]
  protectedBranchIds: string[]
  reason: string
}

export async function planArtifactCleanup(
  profile: string,
  runId: string,
  options: { keepLatest?: number; olderThanDays?: number } = {},
): Promise<ArtifactCleanupPlan> {
  const store = await readStore(profile)
  const run = store.runs.find(row => row.id === runId)
  if (!run) throw new Error('research_run_not_found')
  const protectedBranchIds = Array.from(new Set(run.merges.flatMap(merge => merge.branchIds)))
  const keepLatest = Math.max(0, Math.floor(options.keepLatest ?? 1))
  const cutoff = Date.now() - Math.max(0, options.olderThanDays ?? 30) * 24 * 60 * 60 * 1000
  const keep: ResearchRunArtifact[] = []
  const remove: ResearchRunArtifact[] = []
  for (const artifact of run.artifacts) {
    const protectedByMerge = protectedBranchIds.includes(artifact.branchId)
    const newerThanCutoff = artifact.createdAt >= cutoff
    const sameBranch = run.artifacts
      .filter(row => row.branchId === artifact.branchId)
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, keepLatest)
    const retainedLatest = sameBranch.some(row => row.id === artifact.id)
    if (protectedByMerge || newerThanCutoff || retainedLatest) keep.push(artifact)
    else remove.push(artifact)
  }
  return {
    keep,
    remove,
    protectedBranchIds,
    reason: 'Artifacts on branches referenced by a merge record are always retained; otherwise keep newest N per branch and anything newer than the cutoff.',
  }
}

export async function cleanupArtifacts(
  profile: string,
  runId: string,
  options: { keepLatest?: number; olderThanDays?: number } = {},
): Promise<{ run: Awaited<ReturnType<typeof readStore>>['runs'][number]; removed: ResearchRunArtifact[]; plan: ArtifactCleanupPlan }> {
  const plan = await planArtifactCleanup(profile, runId, options)
  for (const artifact of plan.remove) {
    try {
      await fs.unlink(artifact.file)
    } catch {
      // The metadata is still removed below; a missing file is already clean.
    }
  }
  const removeIds = new Set(plan.remove.map(artifact => artifact.id))
  const updated = await updateStore(profile, 'run.artifacts.cleaned', draft => {
    const run = draft.runs.find(row => row.id === runId)
    if (!run) throw new Error('research_run_not_found')
    run.artifacts = run.artifacts.filter(artifact => !removeIds.has(artifact.id))
    run.updatedAt = Date.now()
    return run
  }, { actor: { kind: 'system', id: 'artifact-retention' }, action: 'run.artifacts.cleaned' })
  return { run: updated, removed: plan.remove, plan }
}

export function publicArtifact(artifact: ResearchRunArtifact): Omit<ResearchRunArtifact, 'file'> {
  const { file: _file, ...metadata } = artifact
  return metadata
}

export async function executeRawMerge(
  profile: string,
  runId: string,
  mergeId: string,
): Promise<{ run: Awaited<ReturnType<typeof readStore>>['runs'][number]; merge: ResearchRunMerge }> {
  return updateStore(profile, 'run.merge.raw-executed', async draft => {
    const run = draft.runs.find(row => row.id === runId)
    if (!run) throw new Error('research_run_not_found')
    const merge = run.merges.find(row => row.id === mergeId)
    if (!merge) throw new Error('research_merge_not_found')
    if (merge.status !== 'validated') throw new Error('research_merge_validate_first')
    const artifacts = run.artifacts.filter(row => merge.branchIds.includes(row.branchId))
    const metricRows = merge.metricRows
    const combined: Array<{ metric: string; branchId: string; values: number[] }> = []
    for (const row of metricRows) {
      const sources = artifacts.filter(artifact =>
        artifact.branchId === row.branchId
        && artifact.metric.toLowerCase() === row.metric.toLowerCase(),
      )
      if (sources.length === 0) {
        throw new Error(`research_raw_artifact_missing:${row.branchId}/${row.metric}`)
      }
      const values: number[] = []
      for (const artifact of sources) {
        const text = await fs.readFile(artifact.file, 'utf-8')
        if (sha256(text) !== artifact.sha256) throw new Error(`research_raw_artifact_hash_mismatch:${artifact.id}`)
        const payload = parsePayload(text, artifact.metric)
        if ((payload.dataset || '') !== (artifact.dataset || '')) throw new Error(`research_raw_artifact_dataset_mismatch:${artifact.id}`)
        values.push(...(payload.rows || []).map(item => Number(item.value)))
      }
      combined.push({ metric: row.metric, branchId: row.branchId, values })
    }
    const rowCount = combined.reduce((sum, row) => sum + row.values.length, 0)
    const dir = artifactDir(profile, run.projectId, runId)
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, `merged_${merge.id}.json`)
    const raw = JSON.stringify({
      schema: 'mhb.raw-merge.v1',
      runId,
      mergeId,
      branches: merge.branchIds,
      metrics: combined,
    }, null, 2)
    await fs.writeFile(file, raw, 'utf-8')
    merge.rawMerge = {
      at: Date.now(),
      file,
      sha256: sha256(raw),
      rowCount,
      metrics: combined.map(row => row.metric),
    }
    merge.status = 'executed'
    merge.executedAt = Date.now()
    run.updatedAt = Date.now()
    return { run, merge }
  }, { actor: { kind: 'user', id: 'workbench' }, action: 'run.merge.raw-executed' })
}

export async function approveRollback(
  profile: string,
  runId: string,
  mergeId: string,
  note: string,
  approver = 'workbench',
): Promise<{ run: Awaited<ReturnType<typeof readStore>>['runs'][number]; merge: ResearchRunMerge }> {
  return updateStore(profile, 'run.merge.rollback-approved', draft => {
    const run = draft.runs.find(row => row.id === runId)
    if (!run) throw new Error('research_run_not_found')
    const merge = run.merges.find(row => row.id === mergeId)
    if (!merge) throw new Error('research_merge_not_found')
    const clean = note.trim().slice(0, 2000)
    const actor = approver.trim().slice(0, 100) || 'workbench'
    if (clean === '') throw new Error('research_rollback_note_required')
    if (merge.rollbackApprovals.some(row => row.approver === actor)) {
      throw new Error('research_rollback_approver_duplicate')
    }
    const approval = { at: Date.now(), note: clean, approver: actor }
    merge.rollbackApprovals.push(approval)
    merge.rollbackApproval = { at: approval.at, note: approval.note }
    run.updatedAt = Date.now()
    return { run, merge }
  }, { actor: { kind: 'user', id: 'workbench' }, action: 'run.merge.rollback-approved' })
}
