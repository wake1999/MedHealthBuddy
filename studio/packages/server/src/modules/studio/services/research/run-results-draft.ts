import { selectRunBranch } from './run-branch'
import { readStore, type ResearchFigure, type ResearchRun } from './store'

function num(value: number | null | undefined, digits = 4): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—'
}

function pct(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—'
}

function tex(value: string): string {
  return String(value || '')
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([%&_#])/g, '\\$1')
    .replace(/\^/g, '\\textasciicircum{}')
}

function tableRef(run: ResearchRun): string {
  const branch = run.activeBranchId ? `_${run.activeBranchId.slice(-6)}` : ''
  return `tab:run_${run.id.replace(/[^a-zA-Z0-9]+/g, '_')}${branch}`
}

function figureRef(figure: ResearchFigure): string {
  const raw = figure.insertedInto || figure.name || figure.id
  return `fig:${raw.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase()}`
}

function figureLabel(figure: ResearchFigure): string {
  const raw = figure.insertedInto || figure.name || figure.id
  return raw.replace(/[_-]+/g, ' ').trim()
}

function metricTableMarkdown(run: ResearchRun): string {
  const result = run.result
  if (!result || result.metricStats.length === 0) return '_No metric statistics recorded._'
  const lines = [
    '| Metric | n | Mean | SD | 95% CI | Baseline | Δ | p adj. | Effect |',
    '|---|---:|---:|---:|---|---:|---:|---:|---:|',
  ]
  for (const stat of result.metricStats) {
    const ci = stat.ciLow === null || stat.ciHigh === null ? '—' : `${num(stat.ciLow)}–${num(stat.ciHigh)}`
    const effect = stat.effectSize === null || stat.effectSize === undefined ? '—' : `${stat.effectSizeType || 'd'}=${num(stat.effectSize, 2)}`
    lines.push(`| ${stat.name} | ${stat.n} | ${num(stat.mean)} | ${num(stat.std)} | ${ci} | ${stat.baseline ?? '—'} | ${stat.delta === null ? '—' : num(stat.delta)} | ${stat.pAdjusted === null || stat.pAdjusted === undefined ? '—' : num(stat.pAdjusted)} | ${effect} |`)
  }
  return lines.join('\n')
}

function metricTableLatex(run: ResearchRun): string {
  const result = run.result
  if (!result || result.metricStats.length === 0) return '% No metric statistics recorded.\n'
  const rows = result.metricStats.map((stat) => {
    const ci = stat.ciLow === null || stat.ciHigh === null ? '--' : `${num(stat.ciLow)}--${num(stat.ciHigh)}`
    const effect = stat.effectSize === null || stat.effectSize === undefined ? '--' : `${num(stat.effectSize, 2)}`
    return `${tex(stat.name)} & ${stat.n} & ${num(stat.mean)} & ${num(stat.std)} & ${ci} & ${stat.baseline ?? '--'} & ${stat.delta === null ? '--' : num(stat.delta)} & ${stat.pAdjusted === null || stat.pAdjusted === undefined ? '--' : num(stat.pAdjusted)} & ${effect} \\\\`
  })
  return [
    '\\begin{table}[t]',
    '\\centering',
    '\\caption{Main results. Mean, standard deviation, 95\\% confidence interval, and baseline difference are reported.}',
    `\\label{${tableRef(run)}}`,
    '\\begin{tabular}{lrrrrrrrr}',
    '\\hline',
    'Metric & n & Mean & SD & 95\\% CI & Baseline & $\\Delta$ & $p_{adj}$ & Effect \\\\',
    '\\hline',
    ...rows,
    '\\hline',
    '\\end{tabular}',
    '\\end{table}',
  ].join('\n')
}

/**
 * Build a Results section from one persisted Run.
 *
 * The output is a draft: it uses only recorded values, inserts explicit
 * placeholders where a figure is missing, and reports warnings instead of
 * silently inventing a table/figure number.
 */
export async function generateResultsDraft(
  profile: string,
  runId: string,
  figureId = '',
  branchId = '',
): Promise<{ markdown: string; latex: string; warnings: string[]; branchId: string }> {
  const store = await readStore(profile)
  const source = store.runs.find(row => row.id === runId)
  if (!source) throw new Error('research_run_not_found')
  const run = selectRunBranch(source, branchId)
  if (!run.result) throw new Error('research_result_required')
  const figures = store.figures.filter(figure => figure.projectId === run.projectId)
  const selectedFigure = figureId !== ''
    ? figures.find(figure => figure.id === figureId)
    : figures[0]
  const result = run.result
  const hypothesis = run.hypothesis?.text || run.question
  const plan = run.experimentPlan
  const dataset = plan?.dataset || 'the reported dataset'
  const baselines = plan?.baselines || 'the recorded baselines'
  const metrics = plan?.metrics || result.metricStats.map(stat => stat.name).join(', ')
  const labels = [`Table 1 (Table~\\ref{${tableRef(run)}})`]
  const warnings: string[] = []
  if (selectedFigure) {
    labels.push(`Figure 1 (Figure~\\ref{${figureRef(selectedFigure)}})`)
  } else {
    warnings.push('No figure is registered for this project. A placeholder is included instead of a real figure reference.')
  }
  if (result.metricStats.some(stat => stat.n === 1)) {
    warnings.push('At least one metric has only one seed; no significance conclusion should be drawn from it.')
  }
  if (result.metricStats.some(stat => stat.pAdjusted === null || stat.pAdjusted === undefined)) {
    warnings.push('Some metrics have no adjusted p-value; the statistical paragraph marks them as descriptive only.')
  }
  if (result.overrideReason !== '') {
    warnings.push(`The final outcome overrides the automatic target verdict: ${result.overrideReason}`)
  }
  if (plan && !plan.baselines) warnings.push('No baseline is recorded in the experiment plan.')

  const metricSummary = result.metricStats.length > 0
    ? result.metricStats.map(stat => `${stat.name} ${num(stat.mean)} (SD ${num(stat.std)}, n=${stat.n})`).join('; ')
    : 'No metric statistics were recorded'
  const sigSummary = result.metricStats.length > 0
    ? result.metricStats.map(stat => {
      if (stat.pAdjusted === null || stat.pAdjusted === undefined) return `${stat.name}: descriptive only`
      return `${stat.name}: adjusted p=${num(stat.pAdjusted)}${stat.significant ? ' (significant at 0.05)' : ' (not significant at 0.05)'}`
    }).join('; ')
    : 'No inferential statistics were computed'
  const outcomeSentence = result.outcome === 'supported'
    ? 'The pre-specified decision rule supported the hypothesis.'
    : result.outcome === 'contradicted'
      ? 'The pre-specified decision rule did not support the hypothesis.'
      : result.outcome === 'mixed'
        ? 'The results were mixed across the pre-specified criteria.'
        : 'The result was inconclusive under the pre-specified criteria.'

  const setup = `We evaluated the hypothesis on ${dataset} using ${baselines} as baselines and ${metrics} as evaluation metrics. ${plan?.seeds ? `Each configuration was repeated across seeds: ${plan.seeds}.` : 'The number of seeds was not recorded in the plan.'}`
  const main = `Table 1 reports the main results. ${metricSummary}. ${outcomeSentence}`
  const stats = `${sigSummary}. ${result.metricStats.length > 0 && result.metricStats[0].effectSize !== null ? `The reported effect size for ${result.metricStats[0].name} is ${num(result.metricStats[0].effectSize, 2)} (${result.metricStats[0].effectSizeType || 'd'}).` : ''} Statistical tests are approximate and should be checked against the final analysis script.`
  const limitations = `This draft is limited to the recorded run. ${plan?.stopCondition ? `The pre-specified stop condition was: ${plan.stopCondition}.` : ''} ${warnings.length > 0 ? warnings.join(' ') : 'No additional data-quality warning was recorded.'}`

  const markdown = [
    '## Results',
    '',
    '### Experimental setup',
    '',
    setup,
    '',
    '### Main results',
    '',
    `${main} The relevant table and figure references are ${labels.join(' and ')}.`,
    '',
    '**Table 1. Main results.**',
    '',
    metricTableMarkdown(run),
    '',
    selectedFigure
      ? `**Figure 1. ${selectedFigure.caption || figureLabel(selectedFigure)}.**\n\n![Figure 1](${selectedFigure.path})`
      : '**Figure 1 placeholder.** No registered figure exists yet; add a figure before submission.',
    '',
    '### Statistical analysis',
    '',
    stats,
    '',
    '### Limitations',
    '',
    limitations,
    '',
    '_Draft generated from persisted Research Run artifacts. Verify all numbers and references before manuscript submission._',
  ].join('\n')

  const latex = [
    '\\section{Results}',
    '',
    '\\subsection{Experimental setup}',
    tex(setup),
    '',
    '\\subsection{Main results}',
    `${tex(main)} Table~\\ref{${tableRef(run)}} reports the main results.${selectedFigure ? ` Figure~\\ref{${figureRef(selectedFigure)}} shows the corresponding figure.` : ' % TODO: insert a figure and a real figure reference.'}`,
    '',
    metricTableLatex(run),
    '',
    selectedFigure
      ? [
        '\\begin{figure}[t]',
        '\\centering',
        `\\includegraphics[width=\\linewidth]{figures/${selectedFigure.path.split(/[\\\\/]/).pop() || ''}}`,
        `\\caption{${tex(selectedFigure.caption || figureLabel(selectedFigure))}}`,
        `\\label{${figureRef(selectedFigure)}}`,
        '\\end{figure}',
      ].join('\n')
      : '% TODO: add a figure and replace this placeholder with a real figure reference.',
    '',
    '\\subsection{Statistical analysis}',
    tex(stats),
    '',
    '\\subsection{Limitations}',
    tex(limitations),
    '',
  ].join('\n')

  return { markdown, latex, warnings, branchId: run.activeBranchId }
}
