import { readStore, type ResearchRunResult } from './store'

export interface FamilyMetricRow {
  runId: string
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
export async function analyzeRunFamily(profile: string, projectId: string): Promise<FamilyAnalysis> {
  const store = await readStore(profile)
  if (!store.projects.some(project => project.id === projectId)) {
    throw new Error('research_project_not_found')
  }
  const runs = store.runs.filter(run => run.projectId === projectId && run.result?.confirmedFinal)
  const rows = runs.flatMap(run => {
    const result = run.result
    if (!hasMetricStats(result)) return []
    return result.metricStats
      .filter(stat => stat.pValue !== null && Number.isFinite(stat.pValue))
      .map(stat => ({
        runId: run.id,
        runTitle: run.title,
        metric: stat.name,
        n: stat.n,
        mean: stat.mean,
        pValue: Number(stat.pValue),
        effectSize: stat.effectSize ?? null,
        effectSizeType: stat.effectSizeType || 'd',
      }))
  })
  return {
    projectId,
    family: 'all_confirmed_runs',
    alpha: 0.05,
    runCount: runs.length,
    testedMetricCount: rows.length,
    rows: holmAdjust(rows),
  }
}
