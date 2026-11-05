import { normalCdf } from './experiment-log'
import { readStore, type ResearchMetricStats, type ResearchRun } from './store'

export interface BranchPairComparison {
  metric: string
  branchAId: string
  branchALabel: string
  branchBId: string
  branchBLabel: string
  meanA: number
  meanB: number
  delta: number
  pValue: number
  pAdjusted: number
  significant: boolean
  effectSize: number | null
  effectSizeType: 'cohen_d'
  test: 'welch_z_approx'
}

function branchLabel(run: ResearchRun, branchId: string): string {
  const index = run.branches.findIndex(branch => branch.id === branchId)
  const branch = run.branches[index]
  return `B${index + 1} · ${branch?.hypothesis?.text?.slice(0, 48) || branchId.slice(-6)}`
}

function statsByName(branch: { result: ResearchRun['result'] }): Map<string, ResearchMetricStats> {
  return new Map((branch.result?.metricStats || []).map(stat => [stat.name.toLowerCase(), stat]))
}

function pairPValue(a: ResearchMetricStats, b: ResearchMetricStats): number {
  if (a.n < 2 || b.n < 2) return 1
  const variance = (a.std ** 2) / a.n + (b.std ** 2) / b.n
  const diff = Math.abs(a.mean - b.mean)
  if (variance <= 0) return diff === 0 ? 1 : 0
  return Math.max(0, Math.min(1, 2 * (1 - normalCdf(diff / Math.sqrt(variance)))))
}

function pooledEffect(a: ResearchMetricStats, b: ResearchMetricStats): number | null {
  if (a.n + b.n <= 2) return null
  const pooled = Math.sqrt(
    ((a.n - 1) * a.std ** 2 + (b.n - 1) * b.std ** 2) / (a.n + b.n - 2),
  )
  if (pooled <= 0) return a.mean === b.mean ? 0 : null
  return (a.mean - b.mean) / pooled
}

function holm(rows: BranchPairComparison[]): BranchPairComparison[] {
  const ordered = rows.slice().sort((left, right) => left.pValue - right.pValue)
  let previous = 0
  return ordered.map((row, index) => {
    const adjusted = Math.min(1, Math.max(previous, row.pValue * (ordered.length - index)))
    previous = adjusted
    return { ...row, pAdjusted: adjusted, significant: adjusted <= 0.05 }
  })
}

/**
 * Pairwise branch comparison from persisted summary statistics.
 *
 * Raw per-seed arrays are not persisted after a Run result is recorded, so this
 * is an approximate Welch z test over means/SDs/n, not a replacement for
 * re-running the paired analysis. Branch labels are stable within the result.
 */
export async function compareRunBranches(profile: string, runId: string): Promise<{
  runId: string
  alpha: number
  rows: BranchPairComparison[]
}> {
  const store = await readStore(profile)
  const run = store.runs.find(row => row.id === runId)
  if (!run) throw new Error('research_run_not_found')
  const branches = run.branches.filter(branch => branch.archivedAt === 0 && branch.result)
  const rows: BranchPairComparison[] = []
  for (let left = 0; left < branches.length; left += 1) {
    for (let right = left + 1; right < branches.length; right += 1) {
      const a = branches[left]
      const b = branches[right]
      const aStats = statsByName(a)
      const bStats = statsByName(b)
      for (const [metric, statA] of aStats) {
        const statB = bStats.get(metric)
        if (!statB) continue
        const pValue = pairPValue(statA, statB)
        const effectSize = pooledEffect(statA, statB)
        rows.push({
          metric: statA.name,
          branchAId: a.id,
          branchALabel: branchLabel(run, a.id),
          branchBId: b.id,
          branchBLabel: branchLabel(run, b.id),
          meanA: statA.mean,
          meanB: statB.mean,
          delta: statA.mean - statB.mean,
          pValue,
          pAdjusted: pValue,
          significant: false,
          effectSize,
          effectSizeType: 'cohen_d',
          test: 'welch_z_approx',
        })
      }
    }
  }
  return { runId, alpha: 0.05, rows: holm(rows) }
}
