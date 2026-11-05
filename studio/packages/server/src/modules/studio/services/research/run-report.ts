import { selectRunBranch } from './run-branch'
import { readStore, type ResearchRun } from './store'

function cell(value: unknown): string {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>')
    .trim()
}

function list(value: string): string {
  return value.trim() === '' ? '_未填写_' : value
}

function percent(value: number | null | undefined): string {
  return typeof value === 'number' ? `${Math.round(value * 100)}%` : '—'
}

function number(value: number | null | undefined, digits = 4): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—'
}

function stageLabel(stage: string): string {
  const labels: Record<string, string> = {
    scope: '界定问题',
    literature: '文献',
    evidence: '证据表',
    hypothesis: '研究假设',
    experiment: '实验',
    analysis: '结果分析',
  }
  return labels[stage] || stage
}

/**
 * Deterministic Markdown report for one Research Run.
 *
 * Every line comes from persisted artifacts; this function never calls a model
 * and never fills missing facts with prose. That makes the report safe to paste
 * into a lab notebook before a human edits it into manuscript form.
 */
export async function generateRunReport(
  profile: string,
  runId: string,
  branchId = '',
): Promise<{ markdown: string; filename: string; branchId: string }> {
  const store = await readStore(profile)
  const source: ResearchRun | undefined = store.runs.find(row => row.id === runId)
  if (!source) throw new Error('research_run_not_found')
  const run = selectRunBranch(source, branchId)
  const project = store.projects.find(row => row.id === run.projectId)
  const experiment = store.experiments.find(row => row.id === run.experimentId)
  const job = store.jobs.find(row => row.id === run.experimentJobId)
  const safeTitle = (run.title || 'research-run').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80)
  const lines: string[] = []

  lines.push(`# ${run.title}`, '')
  lines.push(`- Project: ${project?.title || run.projectId}`, `- Run: \`${run.id}\``, `- Stage: ${stageLabel(run.stage)}`)
  lines.push(`- Status: ${run.status}`, `- Generated: ${new Date().toISOString()}`, '')
  lines.push('## Research question', '', run.question, '')

  lines.push('## Evidence table', '')
  if (run.evidence.length === 0) {
    lines.push('_No evidence rows._', '')
  } else {
    lines.push('| # | Claim | Quote | Source | Page | Support | Confidence |', '|---:|---|---|---|---:|---|---:|')
    run.evidence.forEach((row, index) => {
      lines.push(`| ${index + 1} | ${cell(row.claim)} | ${cell(row.quote)} | ${cell(row.paperTitle)} | ${row.page ?? '—'} | ${cell(row.support)} | ${percent(row.confidence)} |`)
    })
    lines.push('')
  }

  lines.push('## Claim mapping', '')
  if (run.claims.length === 0) {
    lines.push('_No claim mapping._', '')
  } else {
    for (const claim of run.claims) {
      lines.push(`### ${claim.text}`, '')
      lines.push(`- Status: ${claim.status}`, `- Confidence: ${percent(claim.confidence)}`, `- Evidence: ${claim.evidenceIds.join(', ') || '—'}`)
      if (claim.note) lines.push(`- Note: ${claim.note}`)
      lines.push('')
    }
  }

  lines.push('## Hypothesis', '')
  if (!run.hypothesis) {
    lines.push('_Not recorded._', '')
  } else {
    const h = run.hypothesis
    const linkedClaims = run.claims
      .filter(claim => h.claimIds.includes(claim.id))
      .map(claim => `${claim.id}: ${claim.text}`)
    lines.push(
      h.text,
      '',
      `- Independent variable: ${list(h.independentVariable)}`,
      `- Dependent variable: ${list(h.dependentVariable)}`,
      `- Baselines: ${list(h.baselines)}`,
      `- Metric: ${list(h.metric)}`,
      `- Expected: ${list(h.expected)}`,
      `- Falsification: ${list(h.falsification)}`,
      `- Approved claims: ${list(linkedClaims.join('\n'))}`,
      '',
    )
  }

  lines.push('## Experiment plan', '')
  if (!run.experimentPlan) {
    lines.push('_Not recorded._', '')
  } else {
    const p = run.experimentPlan
    lines.push(`- Dataset: ${list(p.dataset)}`, `- Experiment family: ${list(p.family)}`, `- Baselines: ${list(p.baselines)}`, `- Metrics: ${list(p.metrics)}`, `- Seeds: ${list(p.seeds)}`, `- Resources: ${list(p.resources)}`, `- Stop condition: ${list(p.stopCondition)}`, `- Success criteria: ${list(p.successCriteria)}`, '')
    if (p.metricSchema.length > 0) {
      lines.push('| Metric | Direction | Required | Target | Baseline | Min delta |', '|---|---|---:|---:|---:|---:|')
      for (const spec of p.metricSchema) {
        lines.push(`| ${cell(spec.name)} | ${spec.direction} | ${spec.required ? 'yes' : 'no'} | ${spec.target ?? '—'} | ${spec.baseline ?? '—'} | ${spec.minDelta ?? '—'} |`)
      }
      lines.push('')
    }
    if (p.command) lines.push('```bash', p.command, '```', '')
  }

  lines.push('## Execution', '')
  lines.push(`- Experiment: \`${run.experimentId || '—'}\``, `- Job: \`${run.experimentJobId || '—'}\``)
  if (experiment) lines.push(`- Experiment status: ${experiment.status}`, `- Experiment record: ${experiment.name}`)
  if (job) lines.push(`- Job state: ${job.state}`, `- Exit code: ${job.exitCode ?? '—'}`)
  if (run.jobInsight) {
    lines.push(`- Failure class: ${run.jobInsight.failureClass || '—'}`)
    if (run.jobInsight.metrics.length > 0) {
      lines.push('', '### Log metrics preview', '', '| Metric | Value |', '|---|---:|')
      for (const metric of run.jobInsight.metrics) lines.push(`| ${cell(metric.name)} | ${metric.value} |`)
    }
    lines.push('')
  }

  lines.push('## Result', '')
  if (!run.result) {
    lines.push('_No result recorded._', '')
  } else {
    const r = run.result
    lines.push(`- Final outcome: **${r.outcome}**`, `- Automatic outcome: ${r.autoOutcome}`, `- Final confirmed: ${r.confirmedFinal ? 'yes' : 'no'}`)
    if (r.overrideReason) lines.push(`- Override reason: ${r.overrideReason}`)
    lines.push('', r.summary, '')
    if (r.metricStats.length > 0) {
      lines.push('| Metric | n | Mean | SD | 95% CI | Baseline | Delta | Test | p adj. | Effect |', '|---|---:|---:|---:|---|---:|---:|---|---:|---:|')
      for (const stat of r.metricStats) {
        const ci = stat.ciLow === null || stat.ciHigh === null ? '—' : `${number(stat.ciLow)}–${number(stat.ciHigh)}`
        const effect = stat.effectSize === null || stat.effectSize === undefined ? '—' : `${stat.effectSizeType || 'd'}=${number(stat.effectSize, 2)}`
        lines.push(`| ${cell(stat.name)} | ${stat.n} | ${number(stat.mean)} | ${number(stat.std)} | ${ci} | ${stat.baseline ?? '—'} | ${stat.delta === null ? '—' : number(stat.delta)} | ${cell(stat.test)} | ${stat.pAdjusted === null || stat.pAdjusted === undefined ? '—' : number(stat.pAdjusted)} | ${effect} |`)
      }
      lines.push('')
    }
  }

  if (run.branches.length > 0) {
    lines.push('## Hypothesis branches', '')
    for (const branch of run.branches) {
      lines.push(`### ${branch.hypothesis?.text || branch.id}`, '')
      lines.push(`- Branch: \`${branch.id}\``, `- Stage: ${branch.stage}`)
      if (branch.archivedAt) lines.push('- Archived: yes')
      if (branch.experimentPlan?.family) lines.push(`- Family: ${branch.experimentPlan.family}`)
      lines.push(`- Experiment: \`${branch.experimentId || '—'}\``)
      if (branch.result) {
        lines.push(`- Outcome: ${branch.result.outcome}`, `- Result: ${branch.result.summary}`)
      } else {
        lines.push('- Result: _not recorded_')
      }
      lines.push('')
    }
  }

  lines.push('## Approvals', '')
  if (run.approvals.length === 0) {
    lines.push('_No human approvals recorded._', '')
  } else {
    for (const approval of run.approvals) {
      lines.push(`- ${approval.stage} approved at ${new Date(approval.at).toISOString()}${approval.note ? `: ${approval.note}` : ''}`)
    }
    lines.push('')
  }

  lines.push('---', '', '_Generated deterministically from workbench records. Verify citations, metrics, and statistical claims before manuscript submission._', '')
  const branchSuffix = branchId !== '' ? `-${branchId.slice(-6)}` : ''
  return {
    markdown: lines.join('\n'),
    filename: `RUN_REPORT_${safeTitle}${branchSuffix}.md`,
    branchId: run.activeBranchId,
  }
}
