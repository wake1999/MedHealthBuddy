import { readStore, type ResearchRunResult } from './store'

export interface FamilyMetricRow {
  runId: string
  branchId: string
  runTitle: string
  metric: string
  n: number
  mean: number
  pValue: number
  pAdjusted: number
  significant: boolean
  effectSize: number | null
  effectSizeType: string
}

export interface FamilyAnalysis {
  projectId: string
  family: string
  alpha: number
  runCount: number
  testedMetricCount: number
  rows: FamilyMetricRow[]
}

/**
 * Holm step-down correction over independent run/metric tests.
 * Input p-values stay untouched; the returned rows carry family-adjusted values.
 */
export function holmAdjust(rows: Omit<FamilyMetricRow, 'pAdjusted' | 'significant'>[]): FamilyMetricRow[] {
  const ordered = rows
    .slice()
    .sort((left, right) => left.pValue - right.pValue)
  const total = ordered.length
  let previous = 0
  return ordered.map((row, index) => {
    const adjusted = Math.min(1, Math.max(previous, row.pValue * (total - index)))
    previous = adjusted
    return { ...row, pAdjusted: adjusted, significant: adjusted <= 0.05 }
  })
}

function hasMetricStats(result: ResearchRunResult | null): result is ResearchRunResult {
  return result !== null && Array.isArray(result.metricStats) && result.metricStats.length > 0
}

/**
 * Project-level family analysis: all confirmed Run results are treated as one
 * testing family. This is deliberately conservative and does not merge
 * unconfirmed/intermediate results.
 */
export async function analyzeRunFamily(
  profile: string,
  projectId: string,
  family = '',
): Promise<FamilyAnalysis> {
  const store = await readStore(profile)
  if (!store.projects.some(project => project.id === projectId)) {
    throw new Error('research_project_not_found')
  }
  const selectedFamily = family.trim()
  const runIds = new Set<string>()
  const rows = store.runs
    .filter(run => run.projectId === projectId)
    .flatMap(run => {
      const branches = run.branches.length > 0
        ? run.branches
        : [{
          id: '',
          hypothesis: run.hypothesis,
          experimentPlan: run.experimentPlan,
          experimentId: run.experimentId,
          experimentJobId: run.experimentJobId,
          jobInsight: run.jobInsight,
          result: run.result,
          stage: run.stage,
          archivedAt: 0,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
        }]
      return branches.flatMap(branch => {
        if (branch.archivedAt !== 0) return []
        if (!branch.result?.confirmedFinal) return []
        if (selectedFamily !== '' && branch.experimentPlan?.family !== selectedFamily) return []
        if (!hasMetricStats(branch.result)) return []
        runIds.add(run.id)
        return branch.result.metricStats
          .filter(stat => stat.pValue !== null && Number.isFinite(stat.pValue))
          .map(stat => ({
            runId: run.id,
            branchId: branch.id,
            runTitle: branch.id === '' ? run.title : `${run.title} · ${branch.id.slice(-6)}`,
            metric: stat.name,
            n: stat.n,
            mean: stat.mean,
            pValue: Number(stat.pValue),
            effectSize: stat.effectSize ?? null,
            effectSizeType: stat.effectSizeType || 'd',
          }))
      })
    })
  return {
    projectId,
    family: selectedFamily || 'all_confirmed_runs',
    alpha: 0.05,
    runCount: runIds.size,
    testedMetricCount: rows.length,
    rows: holmAdjust(rows),
  }
}
