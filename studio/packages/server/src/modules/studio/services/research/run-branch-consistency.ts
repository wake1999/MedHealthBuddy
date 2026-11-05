import { createHash } from 'node:crypto'
import {
  newId,
  readStore,
  updateStore,
  type ResearchRun,
  type ResearchRunConsolidationSnapshot,
  type ResearchRunMerge,
  type ResearchRunMergeMetric,
} from './store'

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function snapshotHash(snapshot: ResearchRunConsolidationSnapshot): string {
  return stableHash({
    branchIds: snapshot.branchIds,
    branches: snapshot.branches,
    primaryMetricBranches: snapshot.primaryMetricBranches,
    warnings: snapshot.warnings,
  })
}

function metricRowsHash(rows: ResearchRunMergeMetric[]): string {
  return stableHash(rows.map(row => ({
    metric: row.metric,
    branchId: row.branchId,
    n: row.n,
    mean: row.mean,
    std: row.std,
    ciLow: row.ciLow,
    ciHigh: row.ciHigh,
    pAdjusted: row.pAdjusted,
    effectSize: row.effectSize,
    effectSizeType: row.effectSizeType,
  })))
}

export interface BranchConflict {
  key: string
  message: string
}

export interface BranchConsistency {
  runId: string
  branchCount: number
  branchIds: string[]
  allFrozen: boolean
  datasetValues: string[]
  baselineValues: string[]
  familyValues: string[]
  datasetConflict: boolean
  baselineConflict: boolean
  familyConflict: boolean
  missingMetrics: string[]
  warnings: string[]
  conflicts: BranchConflict[]
  canApprove: boolean
  approval: ResearchRun['consolidationApproval']
  snapshot: ResearchRunConsolidationSnapshot | null
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map(value => value.trim()).filter(Boolean)))
}

function consistencyOf(run: ResearchRun): BranchConsistency {
  const branches = run.branches.filter(branch => branch.archivedAt === 0 && branch.result)
  const datasetValues = unique(branches.map(branch => branch.experimentPlan?.dataset || ''))
  const baselineValues = unique(branches.map(branch => branch.experimentPlan?.baselines || ''))
  const familyValues = unique(branches.map(branch => branch.experimentPlan?.family || ''))
  const metricSets = branches.map(branch =>
    new Set((branch.result?.metricStats || []).map(stat => stat.name.toLowerCase())),
  )
  const allMetrics = Array.from(new Set(metricSets.flatMap(set => Array.from(set))))
  const missingMetrics = allMetrics.filter(metric => metricSets.some(set => !set.has(metric)))
  const allFrozen = branches.length > 0 && branches.every(branch => branch.frozenAt > 0)
  const conflicts: BranchConflict[] = []
  if (datasetValues.length > 1) {
    conflicts.push({ key: 'dataset', message: '分支使用了不同数据集，合并 Results 前必须人工确认。' })
  }
  if (baselineValues.length > 1) {
    conflicts.push({ key: 'baseline', message: '分支使用了不同基线，主分支指标不能直接视为同一比较。' })
  }
  if (familyValues.length > 1) {
    conflicts.push({ key: 'family', message: '分支属于不同实验族，跨族比较需要单独校正。' })
  }
  if (missingMetrics.length > 0) {
    conflicts.push({ key: 'missing_metrics', message: `部分分支缺少指标：${missingMetrics.join(', ')}` })
  }
  const warnings: string[] = conflicts.map(conflict => conflict.message)
  if (!allFrozen) warnings.push('参与合并的分支必须全部冻结后才能批准。')
  if (branches.length < 2) warnings.push('少于两条带结果的分支，不需要跨分支合并。')
  const snapshot: ResearchRunConsolidationSnapshot = {
    at: Date.now(),
    branchIds: branches.map(branch => branch.id),
    branches: branches.map(branch => ({
      id: branch.id,
      frozenAt: branch.frozenAt,
      dataset: branch.experimentPlan?.dataset || '',
      baselines: branch.experimentPlan?.baselines || '',
      family: branch.experimentPlan?.family || '',
      metrics: (branch.result?.metricStats || []).map(stat => stat.name),
    })),
    primaryMetricBranches: { ...run.primaryMetricBranches },
    warnings,
  }
  return {
    runId: run.id,
    branchCount: branches.length,
    branchIds: branches.map(branch => branch.id),
    allFrozen,
    datasetValues,
    baselineValues,
    familyValues,
    datasetConflict: datasetValues.length > 1,
    baselineConflict: baselineValues.length > 1,
    familyConflict: familyValues.length > 1,
    missingMetrics,
    warnings,
    conflicts,
    canApprove: branches.length > 1 && allFrozen,
    approval: run.consolidationApproval,
    snapshot,
  }
}

export async function getBranchConsistency(profile: string, runId: string): Promise<BranchConsistency> {
  const store = await readStore(profile)
  const run = store.runs.find(row => row.id === runId)
  if (!run) throw new Error('research_run_not_found')
  return consistencyOf(run)
}

export async function approveBranchConsolidation(
  profile: string,
  runId: string,
  note: string,
  acknowledgedConflicts: string[] = [],
): Promise<{ run: ResearchRun; consistency: BranchConsistency }> {
  let result: { run: ResearchRun; consistency: BranchConsistency } | null = null
  const updated = await updateStore(profile, 'run.consolidation.approved', draft => {
    const run = draft.runs.find(row => row.id === runId)
    if (!run) throw new Error('research_run_not_found')
    const consistency = consistencyOf(run)
    if (consistency.branchCount < 2) throw new Error('research_consolidation_branches_required')
    if (!consistency.allFrozen) throw new Error('research_consolidation_freeze_required')
    const cleanNote = note.trim().slice(0, 2000)
    if (cleanNote === '') throw new Error('research_consolidation_note_required')
    const required = new Set(consistency.conflicts.map(conflict => conflict.key))
    const acknowledged = Array.from(new Set(acknowledgedConflicts.map(String)))
    const missing = Array.from(required).filter(key => !acknowledged.includes(key))
    if (missing.length > 0) {
      throw new Error(`research_consolidation_acknowledgements_required:${missing.join(',')}`)
    }
    run.consolidationApproval = {
      at: Date.now(),
      note: cleanNote,
      branchIds: consistency.branchIds,
      acknowledgedConflicts: Array.from(required),
      snapshot: consistency.snapshot!,
    }
    run.updatedAt = Date.now()
    result = { run, consistency: consistencyOf(run) }
    return run
  }, { actor: { kind: 'user', id: 'workbench' }, action: 'run.consolidation.approved' })
  return result || { run: updated, consistency: consistencyOf(updated) }
}

function mergeMetricRows(run: ResearchRun): ResearchRunMergeMetric[] {
  const branches = run.branches.filter(branch => branch.archivedAt === 0 && branch.result)
  const metrics = Array.from(new Set(
    branches.flatMap(branch => (branch.result?.metricStats || []).map(stat => stat.name.toLowerCase())),
  ))
  const rows: ResearchRunMergeMetric[] = []
  for (const metric of metrics) {
    const preferred = run.primaryMetricBranches[metric]
    const branch = branches.find(row => row.id === preferred
      && row.result?.metricStats.some(stat => stat.name.toLowerCase() === metric))
      || branches.find(row => row.result?.metricStats.some(stat => stat.name.toLowerCase() === metric))
    const stat = branch?.result?.metricStats.find(row => row.name.toLowerCase() === metric)
    if (!branch || !stat) continue
    rows.push({
      metric: stat.name,
      branchId: branch.id,
      n: stat.n,
      mean: stat.mean,
      std: stat.std,
      ciLow: stat.ciLow,
      ciHigh: stat.ciHigh,
      pAdjusted: stat.pAdjusted,
      effectSize: stat.effectSize ?? null,
      effectSizeType: stat.effectSizeType || 'd',
    })
  }
  return rows
}

export async function createMergeRecord(
  profile: string,
  runId: string,
): Promise<{ run: ResearchRun; mergeId: string }> {
  return updateStore(profile, 'run.merge.created', draft => {
    const run = draft.runs.find(row => row.id === runId)
    if (!run) throw new Error('research_run_not_found')
    const consistency = consistencyOf(run)
    const approval = run.consolidationApproval
    if (!approval) throw new Error('research_consolidation_approval_required')
    if (approval.branchIds.slice().sort().join(',') !== consistency.branchIds.slice().sort().join(',')) {
      throw new Error('research_consolidation_approval_stale')
    }
    const metricRows = mergeMetricRows(run)
    const previous = run.merges[run.merges.length - 1]
    const merge = {
      id: newId('merge'),
      at: Date.now(),
      branchIds: [...consistency.branchIds],
      primaryMetricBranches: { ...run.primaryMetricBranches },
      acknowledgedConflicts: [...approval.acknowledgedConflicts],
      note: approval.note,
      snapshot: approval.snapshot,
      metricRows,
      status: 'created' as const,
      executedAt: 0,
      version: run.merges.length + 1,
      previousMergeId: previous?.id || '',
      rollbackOf: '',
      snapshotHash: snapshotHash(approval.snapshot),
      metricRowsHash: metricRowsHash(metricRows),
      rollbackApproval: null,
      rollbackApprovals: [],
      rawMerge: null,
    }
    run.merges.push(merge)
    run.updatedAt = Date.now()
    return { run, mergeId: merge.id }
  }, { actor: { kind: 'user', id: 'workbench' }, action: 'run.merge.created' })
}

function snapshotChanges(run: ResearchRun, merge: ResearchRunMerge): string[] {
  const changes: string[] = []
  const current = run.branches.filter(branch => branch.archivedAt === 0 && branch.result)
  const currentIds = current.map(branch => branch.id).sort()
  if (currentIds.join(',') !== merge.branchIds.slice().sort().join(',')) {
    changes.push('branch_set_changed')
  }
  if (JSON.stringify(run.primaryMetricBranches) !== JSON.stringify(merge.primaryMetricBranches)) {
    changes.push('primary_mapping_changed')
  }
  const currentSnapshotHash = snapshotHash(consistencyOf(run).snapshot!)
  if (currentSnapshotHash !== merge.snapshotHash) changes.push('snapshot_hash_changed')
  if (metricRowsHash(mergeMetricRows(run)) !== merge.metricRowsHash) changes.push('metric_rows_hash_changed')
  for (const saved of merge.snapshot.branches) {
    const branch = run.branches.find(row => row.id === saved.id)
    if (!branch) {
      changes.push(`branch_removed:${saved.id}`)
      continue
    }
    if (branch.frozenAt !== saved.frozenAt) changes.push(`freeze_changed:${saved.id}`)
    if ((branch.experimentPlan?.dataset || '') !== saved.dataset) changes.push(`dataset_changed:${saved.id}`)
    if ((branch.experimentPlan?.baselines || '') !== saved.baselines) changes.push(`baseline_changed:${saved.id}`)
    if ((branch.experimentPlan?.family || '') !== saved.family) changes.push(`family_changed:${saved.id}`)
  }
  return changes
}

export async function validateMergeRecord(
  profile: string,
  runId: string,
  mergeId: string,
): Promise<{ run: ResearchRun; merge: ResearchRunMerge; valid: boolean; changes: string[] }> {
  return updateStore(profile, 'run.merge.validated', draft => {
    const run = draft.runs.find(row => row.id === runId)
    if (!run) throw new Error('research_run_not_found')
    const merge = run.merges.find(row => row.id === mergeId)
    if (!merge) throw new Error('research_merge_not_found')
    const changes = snapshotChanges(run, merge)
    merge.status = changes.length === 0 ? 'validated' : 'stale'
    run.updatedAt = Date.now()
    return { run, merge, valid: changes.length === 0, changes }
  }, { actor: { kind: 'user', id: 'workbench' }, action: 'run.merge.validated' })
}

export async function executeMergeRecord(
  profile: string,
  runId: string,
  mergeId: string,
): Promise<{ run: ResearchRun; merge: ResearchRunMerge }> {
  return updateStore(profile, 'run.merge.executed', draft => {
    const run = draft.runs.find(row => row.id === runId)
    if (!run) throw new Error('research_run_not_found')
    const merge = run.merges.find(row => row.id === mergeId)
    if (!merge) throw new Error('research_merge_not_found')
    const changes = snapshotChanges(run, merge)
    if (changes.length > 0) throw new Error(`research_merge_snapshot_stale:${changes.join(',')}`)
    if (merge.status === 'executed') throw new Error('research_merge_already_executed')
    merge.status = 'executed'
    merge.executedAt = Date.now()
    run.updatedAt = Date.now()
    return { run, merge }
  }, { actor: { kind: 'user', id: 'workbench' }, action: 'run.merge.executed' })
}

export async function rollbackMergeRecord(
  profile: string,
  runId: string,
  mergeId: string,
): Promise<{ run: ResearchRun; merge: ResearchRunMerge }> {
  return updateStore(profile, 'run.merge.rolled-back', draft => {
    const run = draft.runs.find(row => row.id === runId)
    if (!run) throw new Error('research_run_not_found')
    const old = run.merges.find(row => row.id === mergeId)
    if (!old) throw new Error('research_merge_not_found')
    if ((old.rollbackApprovals || []).length < 2) throw new Error('research_rollback_approval_required')
    const previous = run.merges[run.merges.length - 1]
    const merge: ResearchRunMerge = {
      ...old,
      id: newId('merge'),
      at: Date.now(),
      version: Math.max(0, ...run.merges.map(row => row.version || 0)) + 1,
      previousMergeId: previous?.id || '',
      rollbackOf: old.id,
      status: 'created',
      executedAt: 0,
    }
    run.merges.push(merge)
    run.updatedAt = Date.now()
    return { run, merge }
  }, { actor: { kind: 'user', id: 'workbench' }, action: 'run.merge.rolled-back' })
}

export function compareMergeRecords(
  left: ResearchRunMerge,
  right: ResearchRunMerge,
): Array<{ field: string; left: string; right: string }> {
  const rows: Array<{ field: string; left: string; right: string }> = []
  const diff = (field: string, a: unknown, b: unknown) => {
    const leftText = JSON.stringify(a)
    const rightText = JSON.stringify(b)
    if (leftText !== rightText) rows.push({ field, left: leftText, right: rightText })
  }
  diff('branchIds', left.branchIds, right.branchIds)
  diff('primaryMetricBranches', left.primaryMetricBranches, right.primaryMetricBranches)
  diff('acknowledgedConflicts', left.acknowledgedConflicts, right.acknowledgedConflicts)
  diff('metricMeans', left.metricRows.map(row => [row.metric, row.branchId, row.mean]), right.metricRows.map(row => [row.metric, row.branchId, row.mean]))
  diff('snapshotHash', left.snapshotHash, right.snapshotHash)
  diff('metricRowsHash', left.metricRowsHash, right.metricRowsHash)
  diff('version', left.version, right.version)
  diff('status', left.status, right.status)
  return rows
}
