// @ts-nocheck
/**
 * Research Run MVP: one resumable literature → evidence → hypothesis record.
 * The UI owns no hidden state: every mutation goes through the workbench API,
 * and the evidence table is the human approval gate.
 */
import { useEffect, useMemo, useState } from 'react'
import css from './ResearchPanel.module.css'

type Support = 'supports' | 'contradicts' | 'mixed' | 'context'
type Stage = 'scope' | 'literature' | 'evidence' | 'hypothesis' | 'experiment' | 'analysis'

interface RunEvidence {
  id: string
  paperId: string
  paperTitle: string
  claim: string
  quote: string
  page: number | null
  section: string
  support: Support
  confidence: number
  note: string
}

type ClaimReviewStatus = 'pending' | 'approved' | 'rejected' | 'needs_evidence'

interface RunClaim {
  id: string
  text: string
  status: 'supported' | 'contradicted' | 'mixed' | 'gap'
  evidenceIds: string[]
  confidence: number
  note: string
  reviewStatus: ClaimReviewStatus
  reviewNote: string
  reviewedAt: number
  contradictionIds: string[]
}

interface ClaimCoverage {
  paperCount: number
  coveredPaperCount: number
  papersWithoutEvidence: string[]
  claimCount: number
  pendingCount: number
  approvedCount: number
  rejectedCount: number
  needsEvidenceCount: number
  claimsWithNoEvidence: number
  contradictoryClaimCount: number
  ready: boolean
  blockers: string[]
}

interface RunHypothesis {
  text: string
  independentVariable: string
  dependentVariable: string
  baselines: string
  metric: string
  expected: string
  falsification: string
}

interface RunMetricSpec {
  name: string
  direction: 'max' | 'min' | 'none'
  required: boolean
  target?: number
  baseline?: number
  minDelta?: number
}

interface RunMetricStats {
  name: string
  n: number
  mean: number
  std: number
  ciLow: number | null
  ciHigh: number | null
  baseline: number | null
  delta: number | null
  significant: boolean | null
  test?: string
  pValue?: number | null
  pAdjusted?: number | null
  wilcoxonP?: number | null
  wilcoxonExact?: boolean
  effectSize?: number | null
  effectSizeType?: string
}

interface RunExperimentPlan {
  dataset: string
  baselines: string
  metrics: string
  metricSchema?: RunMetricSpec[]
  seeds: string
  command: string
  resources: string
  stopCondition: string
  successCriteria: string
}

interface RunResult {
  outcome: 'supported' | 'contradicted' | 'mixed' | 'inconclusive'
  summary: string
  metrics: string
  experimentId: string
  confirmedFinal?: boolean
  autoOutcome?: RunResult['outcome']
  overrideReason?: string
  metricStats?: RunMetricStats[]
}

interface RunJobInsight {
  metrics: Array<{ name: string; value: number; raw: string }>
  failureClass: string
  logTail: string
  exitCode: number | null
}

interface RunServer {
  id: string
  name: string
  host: string
  status?: string
}

interface RunFigure {
  id: string
  name: string
  path: string
  caption?: string
}

interface RunCompileResult {
  ok: boolean
  engine?: string
  exitCode?: number
  logTail?: string
  durationMs?: number
}

interface ResearchRun {
  id: string
  projectId: string
  title: string
  question: string
  stage: Stage
  status: 'running' | 'waiting_approval' | 'completed' | 'cancelled'
  paperIds: string[]
  evidence: RunEvidence[]
  claims: RunClaim[]
  hypothesis: RunHypothesis | null
  experimentPlan: RunExperimentPlan | null
  experimentId: string
  experimentJobId: string
  jobInsight: RunJobInsight | null
  result: RunResult | null
  approvals: Array<{ stage: Stage; at: number; note: string }>
  createdAt: number
  updatedAt: number
}

interface RunPaper {
  id?: string
  arxivId?: string
  title: string
}

const STAGES: Stage[] = ['scope', 'literature', 'evidence', 'hypothesis', 'experiment', 'analysis']
const SUPPORTS: Support[] = ['supports', 'contradicts', 'mixed', 'context']

function apiHeaders(): Record<string, string> {
  const apiKey = window.localStorage.getItem('hermes_api_key') || ''
  const profile = window.localStorage.getItem('hermes_active_profile_name') || ''
  return {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...(profile ? { 'X-Hermes-Profile': profile } : {}),
  }
}

function paperIdOf(paper: RunPaper): string {
  return String(paper.id || paper.arxivId || '')
}

function formatDate(value: number): string {
  if (!value) return '-'
  return new Date(value).toLocaleString()
}

function parseMetricValuesClient(text: string): Record<string, number> {
  const values: Record<string, number> = {}
  const pattern = /(?:^|[\s,;])([A-Za-z][A-Za-z0-9 _./-]{0,40})\s*[:=]\s*([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?%?)/g
  for (const match of text.matchAll(pattern)) {
    const name = match[1].trim().replace(/\s+/g, ' ').toLowerCase()
    const value = Number(match[2].replace(/%$/, ''))
    if (name !== '' && Number.isFinite(value)) values[name] = value
  }
  return values
}

function parseMetricSamplesClient(text: string): Record<string, number[]> {
  const samples: Record<string, number[]> = {}
  const pattern = /(?:^|[\s,;])([A-Za-z][A-Za-z0-9 _./-]{0,40})\s*[:=]\s*([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?%?)/g
  for (const match of text.matchAll(pattern)) {
    const name = match[1].trim().replace(/\s+/g, ' ').toLowerCase()
    const value = Number(match[2].replace(/%$/, ''))
    if (name === '' || !Number.isFinite(value)) continue
    samples[name] = [...(samples[name] || []), value]
  }
  return samples
}

function normalCdfClient(value: number): number {
  const sign = value < 0 ? -1 : 1
  const x = Math.abs(value) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * x)
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
  const erf = sign * (1 - poly * Math.exp(-x * x))
  return 0.5 * (1 + erf)
}

function twoSidedPClient(value: number): number {
  return Math.max(0, Math.min(1, 2 * (1 - normalCdfClient(Math.abs(value)))))
}

function summarizeMetricSamplesClient(
  schema: RunMetricSpec[],
  samples: Record<string, number[]>,
  baselineSamples: Record<string, number[]> = {},
): RunMetricStats[] {
  const stats = schema
    .filter(spec => Array.isArray(samples[spec.name.toLowerCase()]) && samples[spec.name.toLowerCase()].length > 0)
    .map((spec) => {
      const values = samples[spec.name.toLowerCase()]
      const n = values.length
      const mean = values.reduce((sum, value) => sum + value, 0) / n
      const variance = n > 1 ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1) : 0
      const std = Math.sqrt(Math.max(0, variance))
      const half = n > 1 ? 1.96 * std / Math.sqrt(n) : null
      const baseline = spec.baseline === undefined ? null : spec.baseline
      const delta = baseline === null ? null : spec.direction === 'min' ? baseline - mean : mean - baseline
      const paired = (baselineSamples[spec.name.toLowerCase()] || []).length === n && n > 1
      const reference = paired
        ? baselineSamples[spec.name.toLowerCase()]
        : baseline === null ? [] : Array(n).fill(baseline)
      const differences = reference.length === n
        ? values.map((value, index) => spec.direction === 'min' ? reference[index] - value : value - reference[index])
        : []
      const diffMean = differences.length > 0 ? differences.reduce((sum, value) => sum + value, 0) / differences.length : 0
      const diffStd = differences.length > 1
        ? Math.sqrt(differences.reduce((sum, value) => sum + (value - diffMean) ** 2, 0) / (differences.length - 1))
        : 0
      const t = differences.length > 1
        ? diffStd > 0
          ? diffMean / (diffStd / Math.sqrt(differences.length))
          : diffMean === 0 ? 0 : Number.POSITIVE_INFINITY
        : null
      const pValue = t === null ? null : t === Number.POSITIVE_INFINITY ? 0 : twoSidedPClient(t)
      return {
        name: spec.name,
        n,
        mean,
        std,
        ciLow: half === null ? null : mean - half,
        ciHigh: half === null ? null : mean + half,
        baseline,
        delta,
        significant: null as boolean | null,
        test: paired ? 'paired_t_approx' : differences.length > 0 ? 'one_sample_t_approx' : 'descriptive',
        pValue,
        pAdjusted: null,
        effectSize: differences.length > 1 && diffStd > 0 ? diffMean / diffStd : null,
        effectSizeType: paired ? 'cohen_dz' : 'cohen_d',
      }
    })
  const tested = stats.filter(stat => stat.pValue !== null).sort((left, right) => (left.pValue || 1) - (right.pValue || 1))
  let previous = 0
  for (let index = 0; index < tested.length; index += 1) {
    const stat = tested[index]
    const adjusted = Math.min(1, Math.max(previous, (stat.pValue || 0) * (tested.length - index)))
    stat.pAdjusted = adjusted
    stat.significant = adjusted <= 0.05
    previous = adjusted
  }
  return stats
}

function assessMetricSamplesClient(
  schema: RunMetricSpec[],
  samples: Record<string, number[]>,
  baselineSamples: Record<string, number[]> = {},
): RunResult['outcome'] {
  const decisive = schema.filter(spec =>
    spec.required
    && spec.direction !== 'none'
    && (spec.target !== undefined || (spec.baseline !== undefined && spec.minDelta !== undefined)),
  )
  if (decisive.length === 0) return 'inconclusive'
  const stats = summarizeMetricSamplesClient(schema, samples, baselineSamples)
  const byName = new Map(stats.map(stat => [stat.name.toLowerCase(), stat]))
  let pass = 0
  let fail = 0
  for (const spec of decisive) {
    const values = samples[spec.name.toLowerCase()]
    if (!Array.isArray(values) || values.length === 0) return 'inconclusive'
    const stat = byName.get(spec.name.toLowerCase())
    if (!stat) return 'inconclusive'
    let ok = true
    if (spec.target !== undefined) {
      ok = spec.direction === 'max' ? stat.mean >= spec.target : stat.mean <= spec.target
    }
    if (ok && spec.baseline !== undefined && spec.minDelta !== undefined) {
      ok = (stat.delta ?? -Infinity) >= spec.minDelta
    }
    if (ok && stat.significant === false) ok = false
    if (ok) pass += 1
    else fail += 1
  }
  return fail === 0 ? 'supported' : pass === 0 ? 'contradicted' : 'mixed'
}

export function RunsView({
  projectId,
  projectTitle,
  papers,
  servers,
  figures,
  requestProjectSession,
  openPaperPage,
  t,
}: {
  projectId: string | null
  projectTitle?: string
  papers: readonly RunPaper[]
  servers: readonly RunServer[]
  figures: readonly RunFigure[]
  requestProjectSession?: (prompt: string) => Promise<{ ok: boolean; error?: string }>
  openPaperPage?: (paperId: string, page: number) => void
  t: (key: string, params?: Record<string, unknown>) => string
}) {
  const [runs, setRuns] = useState<ResearchRun[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [loading, setLoading] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [extractionProgress, setExtractionProgress] = useState<{
    phase: string
    current: number
    total: number
    message: string
  } | null>(null)
  const [claimsBusy, setClaimsBusy] = useState(false)
  const [reviewBusy, setReviewBusy] = useState('')
  const [claimFilter, setClaimFilter] = useState<'all' | ClaimReviewStatus | 'contradictions'>('all')
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({})
  const [coverage, setCoverage] = useState<ClaimCoverage | null>(null)
  const [importBusy, setImportBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [question, setQuestion] = useState('')
  const [title, setTitle] = useState('')
  const [paperIds, setPaperIds] = useState<string[]>([])
  const [hypothesis, setHypothesis] = useState<RunHypothesis>({
    text: '',
    independentVariable: '',
    dependentVariable: '',
    baselines: '',
    metric: '',
    expected: '',
    falsification: '',
  })
  const [plan, setPlan] = useState<RunExperimentPlan>({
    dataset: '',
    baselines: '',
    metrics: '',
    seeds: '',
    command: '',
    resources: '',
    stopCondition: '',
    successCriteria: '',
  })
  const [resultDraft, setResultDraft] = useState<RunResult>({
    outcome: 'inconclusive',
    summary: '',
    metrics: '',
    experimentId: '',
    confirmedFinal: false,
    autoOutcome: 'inconclusive',
    overrideReason: '',
  })
  const [metricSchemaText, setMetricSchemaText] = useState('')
  const [baselineSamplesText, setBaselineSamplesText] = useState('')
  const [serverId, setServerId] = useState('')
  const [experimentJob, setExperimentJob] = useState<{ id: string; state: string; note: string } | null>(null)
  const [jobBusy, setJobBusy] = useState(false)
  const [reportBusy, setReportBusy] = useState(false)
  const [report, setReport] = useState<{ markdown: string; filename: string } | null>(null)
  const [resultsBusy, setResultsBusy] = useState(false)
  const [resultsDraft, setResultsDraft] = useState<{ markdown: string; latex: string; warnings: string[] } | null>(null)
  const [figureId, setFigureId] = useState('')
  const [insertBusy, setInsertBusy] = useState(false)
  const [insertResult, setInsertResult] = useState<{
    snapshotId: string
    insertedAt: number
    compile: RunCompileResult
  } | null>(null)
  const [evidence, setEvidence] = useState({
    paperId: '',
    claim: '',
    quote: '',
    page: '',
    section: '',
    support: 'supports' as Support,
    confidence: '0.5',
    note: '',
  })

  const selected = runs.find(run => run.id === selectedId) || null
  const stageIndex = selected ? STAGES.indexOf(selected.stage) : 0
  const availablePapers = useMemo(() => papers.filter(paper => paperIdOf(paper) !== ''), [papers])
  const resultSchema = selected?.experimentPlan?.metricSchema || []
  const resultSamples = parseMetricSamplesClient(resultDraft.metrics)
  const baselineSamples = parseMetricSamplesClient(baselineSamplesText)
  const resultStats = summarizeMetricSamplesClient(resultSchema, resultSamples, baselineSamples)
  const autoVerdict = assessMetricSamplesClient(resultSchema, resultSamples, baselineSamples)
  const outcomeOverridden = autoVerdict !== 'inconclusive' && resultDraft.outcome !== autoVerdict
  const visibleClaims = (selected?.claims || []).filter(claim => {
    if (claimFilter === 'all') return true
    if (claimFilter === 'contradictions') return claim.contradictionIds.length > 0
    return claim.reviewStatus === claimFilter
  })
  const claimGateReady = coverage?.ready !== false
  const gateBlocked = selected?.stage === 'evidence'
    && selected.approvals.some(item => item.stage === 'evidence')
    && !claimGateReady

  useEffect(() => {
    if (serverId === '' && servers.length > 0) setServerId(servers[0].id)
  }, [servers, serverId])

  useEffect(() => {
    if (!selected) {
      setCoverage(null)
      return
    }
    setReviewNotes(Object.fromEntries((selected.claims || []).map(claim => [claim.id, claim.reviewNote || ''])))
    void request<{ coverage: ClaimCoverage }>(
      `/api/studio/research/runs/${encodeURIComponent(selected.id)}/claim-coverage`,
    )
      .then(body => setCoverage(body.coverage))
      .catch(() => setCoverage(null))
  }, [selected?.id, selected?.updatedAt])

  useEffect(() => {
    if (figureId === '' && figures.length > 0) setFigureId(figures[0].id)
  }, [figures, figureId])

  useEffect(() => {
    if (!selected) return
    setHypothesis(selected.hypothesis || {
      text: '', independentVariable: '', dependentVariable: '', baselines: '', metric: '', expected: '', falsification: '',
    })
    setPlan(selected.experimentPlan || {
      dataset: '', baselines: '', metrics: '', seeds: '', command: '', resources: '', stopCondition: '', successCriteria: '',
    })
    setMetricSchemaText((selected.experimentPlan?.metricSchema || [])
      .map(spec => [
        spec.name,
        spec.direction,
        spec.required ? 'required' : 'optional',
        spec.target ?? '',
        spec.baseline ?? '',
        spec.minDelta ?? '',
      ].join(':'))
      .join(', '))
    setBaselineSamplesText('')
    setResultDraft(selected.result
      ? {
        ...selected.result,
        confirmedFinal: Boolean(selected.result.confirmedFinal),
        autoOutcome: selected.result.autoOutcome || 'inconclusive',
        overrideReason: selected.result.overrideReason || '',
      }
      : {
        outcome: 'inconclusive', summary: '', metrics: '', experimentId: selected.experimentId,
        confirmedFinal: false, autoOutcome: 'inconclusive', overrideReason: '',
      })
  }, [selected?.id, selected?.updatedAt])

  async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(path, { ...options, headers: { ...apiHeaders(), ...(options.headers || {}) } })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`)
    return body as T
  }

  async function loadRuns(selectId = '') {
    if (!projectId) {
      setRuns([])
      return
    }
    setLoading(true)
    setError('')
    try {
      const body = await request<{ runs: ResearchRun[] }>(`/api/studio/research/runs?projectId=${encodeURIComponent(projectId)}`)
      setRuns(body.runs || [])
      setSelectedId(selectId || (body.runs?.[0]?.id || ''))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setSelectedId('')
    void loadRuns()
  }, [projectId])

  async function createRun() {
    if (!projectId || question.trim() === '') return
    setLoading(true)
    setError('')
    try {
      const body = await request<{ run: ResearchRun }>('/api/studio/research/runs', {
        method: 'POST',
        body: JSON.stringify({ projectId, title: title.trim(), question: question.trim(), paperIds }),
      })
      setQuestion('')
      setTitle('')
      setPaperIds([])
      await loadRuns(body.run.id)
    } catch (err) {
      setError((err as Error).message)
      setLoading(false)
    }
  }

  async function addEvidence() {
    if (!selected || evidence.claim.trim() === '') return
    setLoading(true)
    setError('')
    try {
      await request(`/api/studio/research/runs/${encodeURIComponent(selected.id)}/evidence`, {
        method: 'POST',
        body: JSON.stringify({
          paperId: evidence.paperId,
          claim: evidence.claim.trim(),
          quote: evidence.quote.trim(),
          page: evidence.page.trim() === '' ? null : Number(evidence.page),
          section: evidence.section.trim(),
          support: evidence.support,
          confidence: Number(evidence.confidence),
          note: evidence.note.trim(),
        }),
      })
      setEvidence(current => ({
        ...current,
        claim: '', quote: '', page: '', section: '', note: '',
      }))
      await loadRuns(selected.id)
    } catch (err) {
      setError((err as Error).message)
      setLoading(false)
    }
  }

  async function removeEvidence(evidenceId: string) {
    if (!selected) return
    setLoading(true)
    try {
      await request(`/api/studio/research/runs/${encodeURIComponent(selected.id)}/evidence/${encodeURIComponent(evidenceId)}`, {
        method: 'DELETE',
      })
      await loadRuns(selected.id)
    } catch (err) {
      setError((err as Error).message)
      setLoading(false)
    }
  }

  function replaceRun(updated: ResearchRun) {
    setRuns(current => {
      const exists = current.some(run => run.id === updated.id)
      return exists
        ? current.map(run => (run.id === updated.id ? updated : run))
        : [updated, ...current]
    })
    setSelectedId(updated.id)
  }

  async function extractEvidence() {
    if (!selected) return
    const runId = selected.id
    setExtracting(true)
    setError('')
    setNotice('')
    setExtractionProgress({ phase: 'reading', current: 0, total: selected.paperIds.length, message: '' })
    try {
      const started = await request<{ job: {
        state: 'running' | 'done' | 'error'
        phase: string
        current: number
        total: number
        message: string
        added: number
        skipped: number
        paperErrors: string[]
        error: string
      } }>(`/api/studio/research/runs/${encodeURIComponent(runId)}/extract-evidence?async=true`, {
        method: 'POST',
        body: JSON.stringify({ maxPerPaper: 4 }),
      })
      let job = started.job
      while (job.state === 'running') {
        setExtractionProgress({
          phase: job.phase,
          current: job.current,
          total: job.total,
          message: job.message,
        })
        await new Promise(resolve => window.setTimeout(resolve, 900))
        const status = await request<{ job: typeof job | null }>(
          `/api/studio/research/runs/${encodeURIComponent(runId)}/extract-status`,
        )
        if (!status.job) throw new Error(t('runs.extractionLost'))
        job = status.job
      }
      setExtractionProgress({
        phase: job.phase,
        current: job.current,
        total: job.total,
        message: job.message,
      })
      if (job.state === 'error') throw new Error(job.error || t('runs.extractionFailed'))
      await loadRuns(runId)
      const skipped = job.skipped > 0 ? `，跳过 ${job.skipped} 条无法在原文中定位的引用` : ''
      const failures = job.paperErrors.length > 0 ? `；${job.paperErrors.length} 篇文献读取失败` : ''
      setNotice(t('runs.extractDone', { added: job.added, skipped, failures }))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setExtracting(false)
      setExtractionProgress(null)
    }
  }

  async function importWorkbenchEvidence() {
    if (!selected) return
    setImportBusy(true)
    setError('')
    setNotice('')
    try {
      const body = await request<{ run: ResearchRun; imported: number; skipped: number }>(
        `/api/studio/research/runs/${encodeURIComponent(selected.id)}/import-workbench-evidence`,
        { method: 'POST', body: JSON.stringify({}) },
      )
      replaceRun(body.run)
      setNotice(t('runs.importDone', { imported: body.imported, skipped: body.skipped }))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setImportBusy(false)
    }
  }

  async function reviewClaim(claimId: string, reviewStatus: ClaimReviewStatus) {
    if (!selected) return
    setReviewBusy(claimId)
    setError('')
    setNotice('')
    try {
      const body = await request<{ run: ResearchRun; coverage: ClaimCoverage }>(
        `/api/studio/research/runs/${encodeURIComponent(selected.id)}/claims/${encodeURIComponent(claimId)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            reviewStatus,
            reviewNote: reviewNotes[claimId] || '',
          }),
        },
      )
      replaceRun(body.run)
      setCoverage(body.coverage)
      setNotice(t('runs.claimReviewed'))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setReviewBusy('')
    }
  }

  async function deriveClaims() {
    if (!selected) return
    setClaimsBusy(true)
    setError('')
    setNotice('')
    try {
      const body = await request<{ run: ResearchRun; count: number }>(
        `/api/studio/research/runs/${encodeURIComponent(selected.id)}/claims/derive`,
        { method: 'POST' },
      )
      replaceRun(body.run)
      setNotice(t('runs.claimsDerived', { count: body.count }))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setClaimsBusy(false)
    }
  }

  async function saveHypothesisForm() {
    if (!selected) return
    setLoading(true)
    setError('')
    setNotice('')
    try {
      const body = await request<{ run: ResearchRun }>(
        `/api/studio/research/runs/${encodeURIComponent(selected.id)}/hypothesis`,
        { method: 'POST', body: JSON.stringify(hypothesis) },
      )
      replaceRun(body.run)
      setNotice(t('runs.hypothesisSaved'))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  async function savePlanForm() {
    if (!selected) return
    setLoading(true)
    setError('')
    setNotice('')
    try {
      const body = await request<{ run: ResearchRun }>(
        `/api/studio/research/runs/${encodeURIComponent(selected.id)}/experiment-plan`,
        { method: 'POST', body: JSON.stringify({ ...plan, metricSchema: metricSchemaText }) },
      )
      replaceRun(body.run)
      setNotice(t('runs.planSaved'))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  async function createExperiment() {
    if (!selected) return
    setLoading(true)
    setError('')
    setNotice('')
    try {
      const body = await request<{ run: ResearchRun }>(
        `/api/studio/research/runs/${encodeURIComponent(selected.id)}/create-experiment`,
        { method: 'POST' },
      )
      replaceRun(body.run)
      setNotice(t('runs.experimentCreated'))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  async function submitExperiment() {
    if (!selected || serverId === '') return
    setJobBusy(true)
    setError('')
    setNotice('')
    try {
      const body = await request<{ run: ResearchRun; job: { id: string; state: string; note: string } }>(
        `/api/studio/research/runs/${encodeURIComponent(selected.id)}/submit-experiment`,
        { method: 'POST', body: JSON.stringify({ serverId }) },
      )
      replaceRun(body.run)
      setExperimentJob({ id: body.job.id, state: body.job.state, note: body.job.note || '' })
      setNotice(t('runs.jobSubmitted'))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setJobBusy(false)
    }
  }

  async function refreshExperiment() {
    if (!selected) return
    setJobBusy(true)
    setError('')
    try {
      const body = await request<{
        run: ResearchRun
        job: { id: string; state: string; note: string } | null
        state: { state: string; detail: string; exitCode: number | null } | null
        insight: RunJobInsight | null
      }>(`/api/studio/research/runs/${encodeURIComponent(selected.id)}/refresh-experiment`, {
        method: 'POST',
      })
      replaceRun(body.run)
      if (body.job) setExperimentJob({ id: body.job.id, state: body.job.state, note: body.job.note || '' })
      if (body.state) setNotice(t('runs.jobState', { state: body.state.state, detail: body.state.detail || '' }))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setJobBusy(false)
    }
  }

  async function recordResult() {
    if (!selected || resultDraft.summary.trim() === '' || !resultDraft.confirmedFinal) return
    const values = parseMetricSamplesClient(resultDraft.metrics)
    const missing = (selected.experimentPlan?.metricSchema || [])
      .filter(spec => spec.required && !(spec.name.toLowerCase() in values))
    if (missing.length > 0) {
      setError(t('runs.missingMetrics', { metrics: missing.map(spec => spec.name).join(', ') }))
      return
    }
    if (outcomeOverridden && (resultDraft.overrideReason || '').trim() === '') {
      setError(t('runs.overrideReasonRequired'))
      return
    }
    setLoading(true)
    setError('')
    setNotice('')
    try {
      const body = await request<{ run: ResearchRun }>(
        `/api/studio/research/runs/${encodeURIComponent(selected.id)}/result`,
        { method: 'POST', body: JSON.stringify({ ...resultDraft, metricSamples: resultSamples, baselineSamples }) },
      )
      replaceRun(body.run)
      setNotice(t('runs.resultSaved'))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  async function approve() {
    if (!selected) return
    setLoading(true)
    setError('')
    try {
      await request(`/api/studio/research/runs/${encodeURIComponent(selected.id)}/approve-evidence`, {
        method: 'POST',
        body: JSON.stringify({ note: 'Evidence table approved from the workbench.' }),
      })
      await loadRuns(selected.id)
      setNotice(t('runs.evidenceApprovedClaimGate'))
    } catch (err) {
      setError((err as Error).message)
      setLoading(false)
    }
  }

  async function advance() {
    if (!selected) return
    setLoading(true)
    setError('')
    try {
      await request(`/api/studio/research/runs/${encodeURIComponent(selected.id)}/advance`, { method: 'POST' })
      await loadRuns(selected.id)
    } catch (err) {
      setError((err as Error).message)
      setLoading(false)
    }
  }

  async function generateReport() {
    if (!selected) return
    setReportBusy(true)
    setError('')
    try {
      const body = await request<{ markdown: string; filename: string }>(
        `/api/studio/research/runs/${encodeURIComponent(selected.id)}/report`,
      )
      setReport({ markdown: body.markdown, filename: body.filename })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setReportBusy(false)
    }
  }

  async function generateResultsDraft() {
    if (!selected) return
    setResultsBusy(true)
    setError('')
    try {
      const body = await request<{ markdown: string; latex: string; warnings: string[] }>(
        `/api/studio/research/runs/${encodeURIComponent(selected.id)}/results-draft`,
        { method: 'POST', body: JSON.stringify({ figureId }) },
      )
      setResultsDraft({ markdown: body.markdown, latex: body.latex, warnings: body.warnings || [] })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setResultsBusy(false)
    }
  }

  async function insertResults() {
    if (!selected) return
    setInsertBusy(true)
    setError('')
    setNotice('')
    try {
      const body = await request<{
        draft: { markdown: string; latex: string; warnings: string[] }
        snapshot: { id: string }
        insertedAt: number
        compile: RunCompileResult
      }>(`/api/studio/research/runs/${encodeURIComponent(selected.id)}/insert-results`, {
        method: 'POST',
        body: JSON.stringify({ figureId }),
      })
      setResultsDraft(body.draft)
      setInsertResult({ snapshotId: body.snapshot.id, insertedAt: body.insertedAt, compile: body.compile })
      setNotice(body.compile.ok ? t('runs.insertCompiled') : t('runs.insertCompileFailed'))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setInsertBusy(false)
    }
  }

  async function copyResults(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setNotice(t('runs.resultsCopied'))
    } catch {
      setError(t('runs.reportCopyFailed'))
    }
  }

  function downloadResults() {
    if (!resultsDraft) return
    const blob = new Blob([resultsDraft.markdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `RESULTS_${(selected?.title || 'run').replace(/[\\/:*?"<>|]+/g, '-')}.md`
    link.click()
    URL.revokeObjectURL(url)
  }

  async function copyReport() {
    if (!report) return
    try {
      await navigator.clipboard.writeText(report.markdown)
      setNotice(t('runs.reportCopied'))
    } catch {
      setError(t('runs.reportCopyFailed'))
    }
  }

  function downloadReport() {
    if (!report) return
    const blob = new Blob([report.markdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = report.filename
    link.click()
    URL.revokeObjectURL(url)
  }

  async function askAgentForEvidence() {
    if (!selected || !requestProjectSession) return
    const prompt = [
      'Use the built-in Skill "auto-research-in-sleep".',
      `Research Run: ${selected.id}`,
      `Project: ${projectTitle || selected.projectId} (${selected.projectId})`,
      'Read the selected papers with the workbench APIs, then add 3–8 source-grounded evidence rows.',
      `Use POST /api/studio/research/runs/${selected.id}/evidence with claim, quote, page, section, support, confidence, paperId.`,
      'Every row must include a real quote and page; do not invent evidence. Do not approve the run; leave approval to the user.',
    ].join('\n')
    const result = await requestProjectSession(prompt)
    if (!result.ok) setError(result.error || t('runs.agentFailed'))
  }

  if (!projectId) {
    return (
      <section className={css.runsView}>
        <p className={css.hint}>{t('runs.noProject')}</p>
      </section>
    )
  }

  return (
    <section className={css.runsView}>
      <header className={css.runsHeader}>
        <div>
          <h2>{t('runs.title')}</h2>
          <p>{t('runs.subtitle')}</p>
        </div>
        <button type="button" className={css.btn} onClick={() => void loadRuns(selectedId)} disabled={loading}>
          {t('runs.refresh')}
        </button>
      </header>

      {error !== '' && <p className={css.failure} role="alert">{error}</p>}
      {notice !== '' && <p className={css.hint} role="status">{notice}</p>}

      <div className={css.runsCreate}>
        <input
          className={css.runsInput}
          value={title}
          onChange={event => setTitle(event.target.value)}
          placeholder={t('runs.titlePlaceholder')}
        />
        <textarea
          className={css.runsTextarea}
          value={question}
          onChange={event => setQuestion(event.target.value)}
          placeholder={t('runs.questionPlaceholder')}
          rows={3}
        />
        <div className={css.runsPaperPicker}>
          <span>{t('runs.papers')}</span>
          {availablePapers.length === 0 && <small>{t('runs.noPapers')}</small>}
          {availablePapers.map(paper => {
            const id = paperIdOf(paper)
            return (
              <label key={id}>
                <input
                  type="checkbox"
                  checked={paperIds.includes(id)}
                  onChange={() => setPaperIds(current => current.includes(id)
                    ? current.filter(value => value !== id)
                    : [...current, id])}
                />
                {paper.title}
              </label>
            )
          })}
        </div>
        <button
          type="button"
          className={css.btnPrimary}
          onClick={() => void createRun()}
          disabled={loading || question.trim() === ''}
        >
          {t('runs.create')}
        </button>
      </div>

      {runs.length === 0 && !loading && <p className={css.hint}>{t('runs.empty')}</p>}

      {runs.length > 0 && (
        <div className={css.runsLayout}>
          <aside className={css.runsList}>
            {runs.map(run => (
              <button
                key={run.id}
                type="button"
                className={css.runsListItem}
                data-active={run.id === selectedId || undefined}
                onClick={() => setSelectedId(run.id)}
              >
                <strong>{run.title}</strong>
                <span>{t(`runs.stage.${run.stage}`)} · {t(`runs.status.${run.status}`)}</span>
                <small>{run.evidence.length} {t('runs.evidenceUnit')}</small>
              </button>
            ))}
          </aside>

          {selected && (
            <div className={css.runsDetail}>
              <div className={css.runsDetailHead}>
                <div>
                  <h3>{selected.title}</h3>
                  <p>{selected.question}</p>
                </div>
                <span className={css.runsStatus}>{t(`runs.status.${selected.status}`)}</span>
              </div>

              {extracting && extractionProgress && (
                <div className={css.runsExtractionProgress} role="status">
                  <div className={css.runsExtractionHead}>
                    <span>
                      {extractionProgress.phase === 'extracting'
                        ? t('runs.extracting')
                        : t('runs.readingPaper')}
                      {' '}
                      {extractionProgress.current}/{extractionProgress.total || '?'}
                    </span>
                    {extractionProgress.message && <small>{extractionProgress.message}</small>}
                  </div>
                  <div className={css.translationProgressTrack} aria-hidden="true">
                    <span
                      className={css.translationProgressBar}
                      data-determinate={extractionProgress.total > 0 || undefined}
                      style={extractionProgress.total > 0
                        ? { width: `${Math.round((extractionProgress.current / extractionProgress.total) * 100)}%` }
                        : undefined}
                    />
                  </div>
                </div>
              )}

              <ol className={css.runsStages}>
                {STAGES.map((stage, index) => (
                  <li key={stage} data-state={index < stageIndex ? 'done' : index === stageIndex ? 'active' : 'todo'}>
                    <span>{index + 1}</span>
                    {t(`runs.stage.${stage}`)}
                  </li>
                ))}
              </ol>

              <div className={css.runsActions}>
                <button
                  type="button"
                  className={css.btnPrimary}
                  disabled={extracting || loading || selected.paperIds.length === 0}
                  onClick={() => void extractEvidence()}
                >
                  {extracting ? t('runs.extracting') : t('runs.autoExtract')}
                </button>
                <button
                  type="button"
                  className={css.btn}
                  disabled={!requestProjectSession || loading || extracting}
                  onClick={() => void askAgentForEvidence()}
                >
                  {t('runs.agentExtract')}
                </button>
                <button
                  type="button"
                  className={css.btn}
                  disabled={importBusy || loading || extracting}
                  onClick={() => void importWorkbenchEvidence()}
                >
                  {importBusy ? t('runs.importBusy') : t('runs.importWorkbench')}
                </button>
                <button
                  type="button"
                  className={css.btnPrimary}
                  disabled={loading || selected.evidence.length === 0 || selected.stage !== 'evidence' || selected.approvals.some(item => item.stage === 'evidence')}
                  onClick={() => void approve()}
                >
                  {t('runs.approveEvidence')}
                </button>
                <button
                  type="button"
                  className={css.btn}
                  disabled={loading || gateBlocked || (selected.stage === 'evidence' && !selected.approvals.some(item => item.stage === 'evidence'))}
                  onClick={() => void advance()}
                >
                  {t('runs.advance')}
                </button>
                <button
                  type="button"
                  className={css.btn}
                  disabled={reportBusy}
                  onClick={() => void generateReport()}
                >
                  {reportBusy ? t('runs.reportBusy') : t('runs.generateReport')}
                </button>
                {figures.length > 0 && (
                  <select
                    className={css.runsInput}
                    value={figureId}
                    onChange={event => setFigureId(event.target.value)}
                    aria-label={t('runs.selectFigure')}
                  >
                    {figures.map(figure => (
                      <option key={figure.id} value={figure.id}>{figure.name || figure.caption || figure.id}</option>
                    ))}
                  </select>
                )}
                <button
                  type="button"
                  className={css.btn}
                  disabled={resultsBusy}
                  onClick={() => void generateResultsDraft()}
                >
                  {resultsBusy ? t('runs.resultsBusy') : t('runs.generateResults')}
                </button>
                <small>{t('runs.updated')}: {formatDate(selected.updatedAt)}</small>
              </div>

              <h4>{t('runs.evidenceTitle')} ({selected.evidence.length})</h4>
              {selected.evidence.length === 0 && <p className={css.hint}>{t('runs.evidenceEmpty')}</p>}
              {selected.evidence.length > 0 && (
                <div className={css.runsEvidenceTableWrap}>
                  <table className={css.runsEvidenceTable}>
                    <thead>
                      <tr>
                        <th>{t('runs.claim')}</th>
                        <th>{t('runs.quote')}</th>
                        <th>{t('runs.source')}</th>
                        <th>{t('runs.support')}</th>
                        <th>{t('runs.confidence')}</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {selected.evidence.map(row => (
                        <tr key={row.id}>
                          <td>{row.claim}</td>
                          <td>{row.quote || '—'}</td>
                          <td>
                            {row.paperId && openPaperPage ? (
                              <button
                                type="button"
                                className={css.runsSourceLink}
                                onClick={() => openPaperPage(row.paperId, row.page || 1)}
                                title={t('runs.openSource')}
                              >
                                {row.paperTitle || '—'}{row.page ? ` · p.${row.page}` : ''}
                              </button>
                            ) : (
                              <span>{row.paperTitle || '—'}{row.page ? ` · p.${row.page}` : ''}</span>
                            )}
                            {row.section ? <small> · {row.section}</small> : null}
                          </td>
                          <td>{t(`runs.supportValue.${row.support}`)}</td>
                          <td>{Math.round(row.confidence * 100)}%</td>
                          <td>
                            <button type="button" className={css.runsIconButton} onClick={() => void removeEvidence(row.id)} title={t('runs.delete')}>
                              ×
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {coverage && (
                <div className={css.runsCoverage}>
                  <div className={css.runsCoverageStats}>
                    <span>{t('runs.coverage.papers', { covered: coverage.coveredPaperCount, total: coverage.paperCount })}</span>
                    <span>{t('runs.coverage.claims', { approved: coverage.approvedCount, total: coverage.claimCount })}</span>
                    <span>{t('runs.coverage.pending', { count: coverage.pendingCount })}</span>
                    <span data-warn={coverage.needsEvidenceCount > 0 || coverage.contradictoryClaimCount > 0 || undefined}>
                      {t('runs.coverage.attention', {
                        needs: coverage.needsEvidenceCount,
                        contradictions: coverage.contradictoryClaimCount,
                      })}
                    </span>
                  </div>
                  {coverage.papersWithoutEvidence.length > 0 && (
                    <p className={css.runsCoverageWarning}>
                      {t('runs.coverage.uncovered')}: {coverage.papersWithoutEvidence.join(', ')}
                    </p>
                  )}
                  {coverage.blockers.length > 0 && (
                    <p className={css.runsCoverageWarning}>
                      {t('runs.coverage.blocked')}: {coverage.blockers.map(code => t(`runs.gate.${code}`)).join(' · ')}
                    </p>
                  )}
                  {coverage.ready && <p className={css.runsCoverageReady}>{t('runs.coverage.ready')}</p>}
                </div>
              )}

              <div className={css.runsClaims}>
                <div className={css.runsClaimsHead}>
                  <h4>{t('runs.claimsTitle')} ({selected.claims?.length || 0})</h4>
                  <div className={css.runsClaimsTools}>
                    <select
                      className={css.runsInput}
                      value={claimFilter}
                      onChange={event => setClaimFilter(event.target.value as typeof claimFilter)}
                    >
                      <option value="all">{t('runs.filter.all')}</option>
                      <option value="pending">{t('runs.reviewStatus.pending')}</option>
                      <option value="approved">{t('runs.reviewStatus.approved')}</option>
                      <option value="needs_evidence">{t('runs.reviewStatus.needs_evidence')}</option>
                      <option value="contradictions">{t('runs.filter.contradictions')}</option>
                    </select>
                    <button
                      type="button"
                      className={css.btn}
                      disabled={claimsBusy || selected.evidence.length === 0}
                      onClick={() => void deriveClaims()}
                    >
                      {claimsBusy ? t('runs.claimsBusy') : t('runs.deriveClaims')}
                    </button>
                  </div>
                </div>
                {(selected.claims?.length || 0) === 0 && <p className={css.hint}>{t('runs.claimsEmpty')}</p>}
                {visibleClaims.map(claim => (
                  <article key={claim.id} className={css.runsClaimCard} data-status={claim.status} data-review={claim.reviewStatus}>
                    <div className={css.runsClaimText}>{claim.text}</div>
                    <div className={css.runsClaimMeta}>
                      <span data-warn={claim.reviewStatus === 'needs_evidence' || claim.contradictionIds.length > 0 || undefined}>
                        {t(`runs.reviewStatus.${claim.reviewStatus}`)}
                      </span>
                      <span>{t(`runs.claimStatus.${claim.status}`)}</span>
                      <span>{Math.round(claim.confidence * 100)}%</span>
                      <span>{claim.evidenceIds.length} {t('runs.evidenceUnit')}</span>
                    </div>
                    <div className={css.runsClaimEvidence}>
                      {claim.evidenceIds.map((evidenceId) => {
                        const evidenceRow = selected.evidence.find(row => row.id === evidenceId)
                        if (!evidenceRow) return null
                        const contradiction = claim.contradictionIds.includes(evidenceId)
                        return (
                          <button
                            key={evidenceId}
                            type="button"
                            data-contradiction={contradiction || undefined}
                            onClick={() => {
                              if (evidenceRow.paperId && openPaperPage) {
                                openPaperPage(evidenceRow.paperId, evidenceRow.page || 1)
                              }
                            }}
                            title={evidenceRow.quote}
                          >
                            {contradiction ? '⚠ ' : ''}{evidenceRow.paperTitle || t('runs.source')}
                            {evidenceRow.page ? ` · p.${evidenceRow.page}` : ''}
                          </button>
                        )
                      })}
                    </div>
                    {claim.note && <p>{claim.note}</p>}
                    {(claim.contradictionIds.length > 0 || claim.reviewStatus === 'needs_evidence') && (
                      <input
                        className={css.runsInput}
                        value={reviewNotes[claim.id] || ''}
                        onChange={event => setReviewNotes(current => ({ ...current, [claim.id]: event.target.value }))}
                        placeholder={t('runs.claimReviewNote')}
                      />
                    )}
                    <div className={css.runsClaimActions}>
                      <button type="button" className={css.btn} disabled={reviewBusy === claim.id} onClick={() => void reviewClaim(claim.id, 'approved')}>
                        {t('runs.claimReview.approve')}
                      </button>
                      <button type="button" className={css.btn} disabled={reviewBusy === claim.id} onClick={() => void reviewClaim(claim.id, 'needs_evidence')}>
                        {t('runs.claimReview.needsEvidence')}
                      </button>
                      <button type="button" className={css.btn} disabled={reviewBusy === claim.id} onClick={() => void reviewClaim(claim.id, 'rejected')}>
                        {t('runs.claimReview.reject')}
                      </button>
                    </div>
                  </article>
                ))}
              </div>

              <div className={css.runsEvidenceForm}>
                <h4>{t('runs.addEvidence')}</h4>
                <select
                  className={css.runsInput}
                  value={evidence.paperId}
                  onChange={event => setEvidence({ ...evidence, paperId: event.target.value })}
                >
                  <option value="">{t('runs.noPaper')}</option>
                  {availablePapers.map(paper => <option key={paperIdOf(paper)} value={paperIdOf(paper)}>{paper.title}</option>)}
                </select>
                <input
                  className={css.runsInput}
                  value={evidence.claim}
                  onChange={event => setEvidence({ ...evidence, claim: event.target.value })}
                  placeholder={t('runs.claimPlaceholder')}
                />
                <textarea
                  className={css.runsTextarea}
                  value={evidence.quote}
                  onChange={event => setEvidence({ ...evidence, quote: event.target.value })}
                  placeholder={t('runs.quotePlaceholder')}
                  rows={2}
                />
                <div className={css.runsEvidenceMeta}>
                  <input
                    className={css.runsInput}
                    value={evidence.page}
                    onChange={event => setEvidence({ ...evidence, page: event.target.value })}
                    placeholder={t('runs.page')}
                    inputMode="numeric"
                  />
                  <input
                    className={css.runsInput}
                    value={evidence.section}
                    onChange={event => setEvidence({ ...evidence, section: event.target.value })}
                    placeholder={t('runs.section')}
                  />
                  <select
                    className={css.runsInput}
                    value={evidence.support}
                    onChange={event => setEvidence({ ...evidence, support: event.target.value as Support })}
                  >
                    {SUPPORTS.map(value => <option key={value} value={value}>{t(`runs.supportValue.${value}`)}</option>)}
                  </select>
                  <input
                    className={css.runsInput}
                    value={evidence.confidence}
                    onChange={event => setEvidence({ ...evidence, confidence: event.target.value })}
                    placeholder={t('runs.confidence')}
                    inputMode="decimal"
                  />
                </div>
                <input
                  className={css.runsInput}
                  value={evidence.note}
                  onChange={event => setEvidence({ ...evidence, note: event.target.value })}
                  placeholder={t('runs.note')}
                />
                <button
                  type="button"
                  className={css.btn}
                  onClick={() => void addEvidence()}
                  disabled={loading || evidence.claim.trim() === ''}
                >
                  {t('runs.addEvidence')}
                </button>
              </div>

              {stageIndex >= 3 && (
                <div className={css.runsExperimentPanel}>
                  <h4>{t('runs.hypothesisTitle')}</h4>
                  <textarea
                    className={css.runsTextarea}
                    value={hypothesis.text}
                    onChange={event => setHypothesis({ ...hypothesis, text: event.target.value })}
                    placeholder={t('runs.hypothesisPlaceholder')}
                    rows={2}
                  />
                  <div className={css.runsFormGrid}>
                    <input className={css.runsInput} value={hypothesis.independentVariable} onChange={event => setHypothesis({ ...hypothesis, independentVariable: event.target.value })} placeholder={t('runs.independentVariable')} />
                    <input className={css.runsInput} value={hypothesis.dependentVariable} onChange={event => setHypothesis({ ...hypothesis, dependentVariable: event.target.value })} placeholder={t('runs.dependentVariable')} />
                    <input className={css.runsInput} value={hypothesis.baselines} onChange={event => setHypothesis({ ...hypothesis, baselines: event.target.value })} placeholder={t('runs.baselines')} />
                    <input className={css.runsInput} value={hypothesis.metric} onChange={event => setHypothesis({ ...hypothesis, metric: event.target.value })} placeholder={t('runs.metric')} />
                  </div>
                  <input className={css.runsInput} value={hypothesis.expected} onChange={event => setHypothesis({ ...hypothesis, expected: event.target.value })} placeholder={t('runs.expected')} />
                  <textarea className={css.runsTextarea} value={hypothesis.falsification} onChange={event => setHypothesis({ ...hypothesis, falsification: event.target.value })} placeholder={t('runs.falsification')} rows={2} />
                  <button type="button" className={css.btn} disabled={loading || hypothesis.text.trim() === ''} onClick={() => void saveHypothesisForm()}>
                    {t('runs.saveHypothesis')}
                  </button>

                  <h4>{t('runs.planTitle')}</h4>
                  <div className={css.runsFormGrid}>
                    <input className={css.runsInput} value={plan.dataset} onChange={event => setPlan({ ...plan, dataset: event.target.value })} placeholder={t('runs.dataset')} />
                    <input className={css.runsInput} value={plan.metrics} onChange={event => setPlan({ ...plan, metrics: event.target.value })} placeholder={t('runs.metrics')} />
                    <input className={css.runsInput} value={plan.baselines} onChange={event => setPlan({ ...plan, baselines: event.target.value })} placeholder={t('runs.baselines')} />
                    <input className={css.runsInput} value={plan.seeds} onChange={event => setPlan({ ...plan, seeds: event.target.value })} placeholder={t('runs.seeds')} />
                    <input className={css.runsInput} value={plan.resources} onChange={event => setPlan({ ...plan, resources: event.target.value })} placeholder={t('runs.resources')} />
                    <input className={css.runsInput} value={plan.successCriteria} onChange={event => setPlan({ ...plan, successCriteria: event.target.value })} placeholder={t('runs.successCriteria')} />
                  </div>
                  <input
                    className={css.runsInput}
                    value={metricSchemaText}
                    onChange={event => setMetricSchemaText(event.target.value)}
                    placeholder={t('runs.metricSchemaPlaceholder')}
                  />
                  <input className={css.runsInput} value={plan.command} onChange={event => setPlan({ ...plan, command: event.target.value })} placeholder={t('runs.command')} />
                  <input className={css.runsInput} value={plan.stopCondition} onChange={event => setPlan({ ...plan, stopCondition: event.target.value })} placeholder={t('runs.stopCondition')} />
                  <button type="button" className={css.btn} disabled={loading || plan.dataset.trim() === '' || plan.metrics.trim() === ''} onClick={() => void savePlanForm()}>
                    {t('runs.savePlan')}
                  </button>

                  {selected.experimentId !== '' ? (
                    <p className={css.runsLinked}>✓ {t('runs.experimentLinked')}: <code>{selected.experimentId}</code></p>
                  ) : (
                    <button type="button" className={css.btnPrimary} disabled={loading || !selected.hypothesis || !selected.experimentPlan} onClick={() => void createExperiment()}>
                      {t('runs.createExperiment')}
                    </button>
                  )}

                  {selected.experimentId !== '' && (
                    <div className={css.runsJobForm}>
                      <h4>{t('runs.jobTitle')}</h4>
                      {servers.length === 0 && <p className={css.hint}>{t('runs.noServers')}</p>}
                      <div className={css.runsJobRow}>
                        <select className={css.runsInput} value={serverId} onChange={event => setServerId(event.target.value)}>
                          <option value="">{t('runs.selectServer')}</option>
                          {servers.map(server => <option key={server.id} value={server.id}>{server.name} · {server.host}</option>)}
                        </select>
                        <button
                          type="button"
                          className={css.btnPrimary}
                          disabled={jobBusy || serverId === '' || selected.experimentJobId !== '' || !selected.experimentPlan?.command}
                          onClick={() => void submitExperiment()}
                        >
                          {jobBusy ? t('runs.jobBusy') : t('runs.submitJob')}
                        </button>
                        {selected.experimentJobId !== '' && (
                          <button type="button" className={css.btn} disabled={jobBusy} onClick={() => void refreshExperiment()}>
                            {t('runs.refreshJob')}
                          </button>
                        )}
                      </div>
                      {selected.experimentJobId !== '' && (
                        <p className={css.runsLinked}>
                          job <code>{selected.experimentJobId}</code>
                          {experimentJob ? ` · ${experimentJob.state}${experimentJob.note ? ` · ${experimentJob.note}` : ''}` : ''}
                        </p>
                      )}
                      {selected.jobInsight && (
                        <div className={css.runsInsight}>
                          {selected.jobInsight.metrics.length > 0 && (
                            <div className={css.runsMetricChips}>
                              {selected.jobInsight.metrics.slice(0, 8).map(metric => (
                                <span key={`${metric.name}:${metric.raw}`}>{metric.name} {metric.value}</span>
                              ))}
                              <button
                                type="button"
                                className={css.btn}
                                onClick={() => setResultDraft(current => ({
                                  ...current,
                                  metrics: selected.jobInsight!.metrics
                                    .map(metric => `${metric.name}=${metric.value}`)
                                    .join(', '),
                                }))}
                              >
                                {t('runs.fillMetrics')}
                              </button>
                            </div>
                          )}
                          {selected.jobInsight.failureClass !== '' && (
                            <p className={css.runsFailureClass} role="status">
                              {t('runs.failureClass')}: {t(`runs.failure.${selected.jobInsight.failureClass}`)}
                            </p>
                          )}
                          {selected.jobInsight.logTail && (
                            <details className={css.runsLogDetails}>
                              <summary>{t('runs.showLog')}</summary>
                              <pre>{selected.jobInsight.logTail.slice(-4000)}</pre>
                            </details>
                          )}
                        </div>
                      )}
                      {selected.experimentPlan?.command && <code className={css.runsCommand}>{selected.experimentPlan.command}</code>}
                    </div>
                  )}

                  {selected.experimentId !== '' && (
                    <div className={css.runsResultForm}>
                      <h4>{t('runs.resultTitle')}</h4>
                      <p className={css.runsAutoVerdict}>
                        {t('runs.autoVerdict')}: {t(`runs.outcome.${autoVerdict}`)}
                      </p>
                      <select className={css.runsInput} value={resultDraft.outcome} onChange={event => setResultDraft({ ...resultDraft, outcome: event.target.value as RunResult['outcome'] })}>
                        <option value="supported">{t('runs.outcome.supported')}</option>
                        <option value="contradicted">{t('runs.outcome.contradicted')}</option>
                        <option value="mixed">{t('runs.outcome.mixed')}</option>
                        <option value="inconclusive">{t('runs.outcome.inconclusive')}</option>
                      </select>
                      {outcomeOverridden && (
                        <input
                          className={css.runsInput}
                          value={resultDraft.overrideReason || ''}
                          onChange={event => setResultDraft({ ...resultDraft, overrideReason: event.target.value })}
                          placeholder={t('runs.overrideReason')}
                        />
                      )}
                      <textarea className={css.runsTextarea} value={resultDraft.summary} onChange={event => setResultDraft({ ...resultDraft, summary: event.target.value })} placeholder={t('runs.resultPlaceholder')} rows={3} />
                      <textarea
                        className={css.runsTextarea}
                        value={resultDraft.metrics}
                        onChange={event => setResultDraft({ ...resultDraft, metrics: event.target.value })}
                        placeholder={t('runs.resultMetricsSamples')}
                        rows={3}
                      />
                      {resultStats.length > 0 && (
                        <div className={css.runsMetricStats}>
                          {resultStats.map(stat => (
                            <span key={stat.name}>
                              {stat.name} μ={stat.mean.toFixed(4)} σ={stat.std.toFixed(4)} n={stat.n}
                              {stat.delta !== null ? ` Δ=${stat.delta.toFixed(4)}` : ''}
                              {stat.pAdjusted !== null && stat.pAdjusted !== undefined ? ` p.adj=${stat.pAdjusted.toFixed(4)}` : ''}
                              {stat.wilcoxonP !== null && stat.wilcoxonP !== undefined ? ` w=${stat.wilcoxonP.toFixed(4)}` : ''}
                              {stat.effectSize !== null && stat.effectSize !== undefined ? ` ${stat.effectSizeType || 'd'}=${stat.effectSize.toFixed(2)}` : ''}
                              {stat.significant === null ? '' : ` ${stat.significant ? '显著' : '不显著'}`}
                            </span>
                          ))}
                        </div>
                      )}
                      <textarea
                        className={css.runsTextarea}
                        value={baselineSamplesText}
                        onChange={event => setBaselineSamplesText(event.target.value)}
                        placeholder={t('runs.baselineSamples')}
                        rows={2}
                      />
                      <label className={css.runsConfirm}>
                        <input
                          type="checkbox"
                          checked={Boolean(resultDraft.confirmedFinal)}
                          onChange={event => setResultDraft({ ...resultDraft, confirmedFinal: event.target.checked })}
                        />
                        {t('runs.confirmFinal')}
                      </label>
                      <button
                        type="button"
                        className={css.btnPrimary}
                        disabled={loading || resultDraft.summary.trim() === '' || !resultDraft.confirmedFinal || (outcomeOverridden && (resultDraft.overrideReason || '').trim() === '')}
                        onClick={() => void recordResult()}
                      >
                        {t('runs.saveResult')}
                      </button>
                      {selected.result && (
                        <p className={css.runsLinked}>
                          {t(`runs.outcome.${selected.result.outcome}`)} · {selected.result.summary.slice(0, 180)}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {resultsDraft && (
                <div className={css.runsReport}>
                  <div className={css.runsReportHead}>
                    <h4>{t('runs.resultsTitle')}</h4>
                    <div>
                      <button type="button" className={css.btn} onClick={() => void copyResults(resultsDraft.markdown)}>{t('runs.copyResults')}</button>
                      <button type="button" className={css.btn} onClick={() => void copyResults(resultsDraft.latex)}>{t('runs.copyLatex')}</button>
                      <button type="button" className={css.btn} onClick={downloadResults}>{t('runs.downloadReport')}</button>
                      <button type="button" className={css.btnPrimary} disabled={insertBusy} onClick={() => void insertResults()}>
                        {insertBusy ? t('runs.inserting') : t('runs.insertResults')}
                      </button>
                      <button type="button" className={css.btn} onClick={() => setResultsDraft(null)}>{t('runs.close')}</button>
                    </div>
                  </div>
                  {resultsDraft.warnings.length > 0 && (
                    <ul className={css.runsWarnings}>
                      {resultsDraft.warnings.map(warning => <li key={warning}>{warning}</li>)}
                    </ul>
                  )}
                  <pre>{resultsDraft.markdown}</pre>
                  <details>
                    <summary>{t('runs.showLatex')}</summary>
                    <pre>{resultsDraft.latex}</pre>
                  </details>
                  {insertResult && (
                    <div className={css.runsCompileResult} data-ok={insertResult.compile.ok || undefined}>
                      <p>
                        {insertResult.compile.ok ? t('runs.compileOk') : t('runs.compileFailed')}
                        {' '}
                        <code>{insertResult.snapshotId}</code>
                      </p>
                      {insertResult.compile.logTail && <pre>{insertResult.compile.logTail.slice(-3000)}</pre>}
                    </div>
                  )}
                </div>
              )}

              {report && (
                <div className={css.runsReport}>
                  <div className={css.runsReportHead}>
                    <h4>{t('runs.reportTitle')}</h4>
                    <div>
                      <button type="button" className={css.btn} onClick={() => void copyReport()}>{t('runs.copyReport')}</button>
                      <button type="button" className={css.btn} onClick={downloadReport}>{t('runs.downloadReport')}</button>
                      <button type="button" className={css.btn} onClick={() => setReport(null)}>{t('runs.close')}</button>
                    </div>
                  </div>
                  <pre>{report.markdown}</pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
