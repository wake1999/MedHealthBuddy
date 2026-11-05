import { newId, readStore, updateStore, type ResearchRun, type ResearchRunConsolidationSnapshot } from './store'

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
    const merge = {
      id: newId('merge'),
      at: Date.now(),
      branchIds: [...consistency.branchIds],
      primaryMetricBranches: { ...run.primaryMetricBranches },
      acknowledgedConflicts: [...approval.acknowledgedConflicts],
      note: approval.note,
      snapshot: approval.snapshot,
    }
    run.merges.push(merge)
    run.updatedAt = Date.now()
    return { run, mergeId: merge.id }
  }, { actor: { kind: 'user', id: 'workbench' }, action: 'run.merge.created' })
}
