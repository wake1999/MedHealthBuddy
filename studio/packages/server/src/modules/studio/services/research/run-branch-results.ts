import { readStore, updateStore, type ResearchRun } from './store'

export interface BranchResultRow {
  branchId: string
  branchLabel: string
  metric: string
  n: number
  mean: number
  std: number
  ciLow: number | null
  ciHigh: number | null
  pAdjusted: number | null
  effectSize: number | null
  effectSizeType: string
  primary: boolean
}

function branchLabel(run: ResearchRun, branchId: string): string {
  const index = run.branches.findIndex(branch => branch.id === branchId)
  const branch = run.branches[index]
  return `B${index + 1} · ${branch?.hypothesis?.text?.slice(0, 56) || branchId.slice(-6)}`
}

function num(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(4) : '—'
}

function escapeCell(value: string): string {
  return String(value || '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
}

export async function generateBranchResultsTable(
  profile: string,
  runId: string,
): Promise<{ rows: BranchResultRow[]; markdown: string; latex: string; filename: string }> {
  const store = await readStore(profile)
  const run = store.runs.find(row => row.id === runId)
  if (!run) throw new Error('research_run_not_found')
  const rows: BranchResultRow[] = []
  for (const branch of run.branches.filter(row => row.archivedAt === 0)) {
    for (const stat of branch.result?.metricStats || []) {
      rows.push({
        branchId: branch.id,
        branchLabel: branchLabel(run, branch.id),
        metric: stat.name,
        n: stat.n,
        mean: stat.mean,
        std: stat.std,
        ciLow: stat.ciLow,
        ciHigh: stat.ciHigh,
        pAdjusted: stat.pAdjusted,
        effectSize: stat.effectSize ?? null,
        effectSizeType: stat.effectSizeType || 'd',
        primary: run.primaryMetricBranches[stat.name.toLowerCase()] === branch.id,
      })
    }
  }
  const markdown = [
    `# Branch Results Comparison: ${run.title}`,
    '',
    '| Branch | Metric | n | Mean | SD | 95% CI | p adj. | Effect | Primary |',
    '|---|---|---:|---:|---:|---|---:|---:|---|',
    ...(rows.length > 0
      ? rows.map(row => `| ${escapeCell(row.branchLabel)} | ${escapeCell(row.metric)} | ${row.n} | ${num(row.mean)} | ${num(row.std)} | ${row.ciLow === null || row.ciHigh === null ? '—' : `${num(row.ciLow)}–${num(row.ciHigh)}`} | ${num(row.pAdjusted)} | ${row.effectSize === null ? '—' : `${row.effectSizeType}=${num(row.effectSize)}`} | ${row.primary ? 'yes' : '—'} |`)
      : ['| _No branch results_ | — | — | — | — | — | — | — | — |']),
    '',
    '_Primary branches are selected per metric. Branch comparisons are not pooled into a single sample._',
    '',
  ].join('\n')
  const latexRows = rows.map(row =>
    `${row.branchLabel.replace(/[%&_#]/g, '\\$&')} & ${row.metric.replace(/[%&_#]/g, '\\$&')} & ${row.n} & ${num(row.mean)} & ${num(row.std)} & ${row.ciLow === null || row.ciHigh === null ? '--' : `${num(row.ciLow)}--${num(row.ciHigh)}`} & ${num(row.pAdjusted)} & ${row.primary ? 'yes' : '--'} \\\\`,
  )
  const latex = [
    '\\begin{table}[t]',
    '\\centering',
    '\\caption{Branch-level results comparison. Primary marks the selected branch per metric.}',
    `\\label{tab:branches_${run.id.replace(/[^a-zA-Z0-9]+/g, '_')}}`,
    '\\begin{tabular}{llrrrrr}',
    '\\hline',
    'Branch & Metric & n & Mean & SD & $p_{adj}$ & Primary \\\\',
    '\\hline',
    ...latexRows,
    '\\hline',
    '\\end{tabular}',
    '\\end{table}',
  ].join('\n')
  return {
    rows,
    markdown,
    latex,
    filename: `BRANCH_RESULTS_${run.id}.md`,
  }
}

export async function setPrimaryBranch(
  profile: string,
  runId: string,
  metric: string,
  branchId: string,
): Promise<ResearchRun> {
  const store = await readStore(profile)
  const run = store.runs.find(row => row.id === runId)
  if (!run) throw new Error('research_run_not_found')
  const branch = run.branches.find(row => row.id === branchId && row.archivedAt === 0)
  if (!branch) throw new Error('research_branch_not_found')
  const hasMetric = (branch.result?.metricStats || []).some(stat => stat.name.toLowerCase() === metric.toLowerCase())
  if (!hasMetric) throw new Error('research_metric_not_found')
  const next = {
    ...run,
    primaryMetricBranches: {
      ...run.primaryMetricBranches,
      [metric.toLowerCase()]: branchId,
    },
    updatedAt: Date.now(),
  }
  await storeWrite(profile, next)
  return next
}

async function storeWrite(profile: string, run: ResearchRun): Promise<void> {
  await updateStore(profile, 'run.primary-branch.set', draft => {
    const target = draft.runs.find(row => row.id === run.id)
    if (!target) throw new Error('research_run_not_found')
    target.primaryMetricBranches = run.primaryMetricBranches
    target.updatedAt = run.updatedAt
    return target
  }, { actor: { kind: 'user', id: 'workbench' }, action: 'run.primary-branch.set' })
}
