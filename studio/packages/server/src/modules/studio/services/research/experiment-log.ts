/**
 * Best-effort parsing of a remote experiment log.
 *
 * This is deliberately read-only: it proposes metrics and a failure class, but
 * it never decides whether a hypothesis was supported. The human still records
 * the outcome through the Research Run result form.
 */
export interface ParsedMetric {
  name: string
  value: number
  raw: string
}

import type { ResearchMetricSpec } from './store'

export interface ExperimentLogInsight {
  metrics: ParsedMetric[]
  failureClass: string
  logTail: string
  exitCode: number | null
}

const KNOWN_METRICS = [
  'f1', 'f1-score', 'f1_score', 'accuracy', 'acc', 'precision', 'recall',
  'auc', 'auroc', 'auprc', 'loss', 'val_loss', 'mse', 'mae', 'rmse',
  'bleu', 'rouge', 'map',
]

function metricName(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').slice(0, 64)
}

function pushMetric(out: Map<string, ParsedMetric>, name: string, valueText: string, raw: string): void {
  const value = Number(valueText.replace(/%$/, ''))
  if (!Number.isFinite(value)) return
  const label = metricName(name)
  if (label === '') return
  const key = label.toLowerCase()
  // Later log lines usually carry the final eval value; overwrite earlier ones.
  out.set(key, { name: label, value, raw: raw.trim().slice(0, 120) })
}

/**
 * Extract common `name: value` / `name=value` pairs plus known metric names.
 * @param logTail - the last few KB of the remote job log.
 */
export function parseExperimentMetrics(logTail: string): ParsedMetric[] {
  const out = new Map<string, ParsedMetric>()
  const generic = /(?:^|[\s,{;])(["']?)([A-Za-z][A-Za-z0-9 _./-]{1,40})\1\s*[:=]\s*([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?%?)/g
  for (const match of logTail.matchAll(generic)) {
    const name = metricName(match[2])
    if (name === '' || /^(http|https|file|path|pid|time|date|version)$/i.test(name)) continue
    pushMetric(out, name, match[3], match[0])
  }

  const known = new RegExp(
    `\\b(${KNOWN_METRICS.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b\\s*[:=]?\\s*([-+]?\\d+(?:\\.\\d+)?(?:[eE][-+]?\\d+)?%?)`,
    'gi',
  )
  for (const match of logTail.matchAll(known)) {
    pushMetric(out, match[1], match[2], match[0])
  }

  return [...out.values()]
    .sort((left, right) => {
      const leftKnown = KNOWN_METRICS.includes(left.name.toLowerCase()) ? 0 : 1
      const rightKnown = KNOWN_METRICS.includes(right.name.toLowerCase()) ? 0 : 1
      return leftKnown - rightKnown
    })
    .slice(0, 20)
}

/** Classify the most actionable failure reason from a failed job log. */
export function classifyExperimentFailure(logTail: string, state: string, exitCode: number | null): string {
  if (state !== 'failed' && state !== 'unknown') return ''
  if (/out of memory|cuda out of memory|cublas_status_alloc_failed|oomkill/i.test(logTail)) return 'oom'
  if (/timed out|timeout|deadline exceeded/i.test(logTail)) return 'timeout'
  if (/permission denied|access denied|read-only file system/i.test(logTail)) return 'permission'
  if (/\bnan\b|loss.*nan|not a number/i.test(logTail)) return 'nan'
  if (/no such file|not found|missing.*(data|file|dataset)/i.test(logTail)) return 'missing_input'
  if (/traceback|exception|error:|failed|assertionerror/i.test(logTail)) return 'runtime_error'
  if (exitCode !== null && exitCode !== 0) return 'nonzero_exit'
  return 'unknown'
}

/**
 * Parse `F1:max:required, Loss:min:optional` into a metric contract.
 * A bare `F1` means maximize and required, which is the safe default for a
 * research result gate.
 */
export function parseMetricSchema(text: string): ResearchMetricSpec[] {
  const out: ResearchMetricSpec[] = []
  const seen = new Set<string>()
  for (const token of String(text || '').split(/[,\n;]+/)) {
    const parts = token.trim().split(':').map(value => value.trim())
    const name = parts[0] || ''
    if (name === '') continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const direction = parts[1] === 'min' || parts[1] === 'none' ? parts[1] : 'max'
    const required = parts[2] === 'optional' ? false : true
    const target = parts[3] !== undefined && Number.isFinite(Number(parts[3])) ? Number(parts[3]) : undefined
    const baseline = parts[4] !== undefined && Number.isFinite(Number(parts[4])) ? Number(parts[4]) : undefined
    const minDelta = parts[5] !== undefined && Number.isFinite(Number(parts[5])) ? Number(parts[5]) : undefined
    out.push({
      name,
      direction,
      required,
      ...(target === undefined ? {} : { target }),
      ...(baseline === undefined ? {} : { baseline }),
      ...(minDelta === undefined ? {} : { minDelta }),
    })
  }
  return out.slice(0, 24)
}

export type MetricVerdict = 'supported' | 'contradicted' | 'mixed' | 'inconclusive'

export function normalCdf(value: number): number {
  // Abramowitz-Stegun erf approximation; enough for an approximate p-value.
  const sign = value < 0 ? -1 : 1
  const x = Math.abs(value) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * x)
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
  const erf = sign * (1 - poly * Math.exp(-x * x))
  return 0.5 * (1 + erf)
}

function twoSidedP(z: number): number {
  return Math.max(0, Math.min(1, 2 * (1 - normalCdf(Math.abs(z)))))
}

function meanOf(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function sampleStd(values: number[], mean = meanOf(values)): number {
  if (values.length < 2) return 0
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1))
}

function exactWilcoxonP(differences: number[]): number | null {
  const nonzero = differences.filter(value => value !== 0)
  const n = nonzero.length
  if (n < 2 || n > 16) return null
  const ranked = nonzero
    .map((value, index) => ({ abs: Math.abs(value), sign: Math.sign(value), index }))
    .sort((left, right) => left.abs - right.abs)
  const ranks = Array(n).fill(0)
  for (let index = 0; index < n; index += 1) {
    let end = index
    while (end + 1 < n && ranked[end + 1].abs === ranked[index].abs) end += 1
    const rank = (index + end + 2) / 2
    for (let cursor = index; cursor <= end; cursor += 1) ranks[ranked[cursor].index] = rank
    index = end
  }
  const observed = ranks.reduce((sum, rank, index) => sum + (nonzero[index] > 0 ? rank : 0), 0)
  const expected = ranks.reduce((sum, rank) => sum + rank, 0) / 2
  const distance = Math.abs(observed - expected)
  const total = 2 ** n
  let extreme = 0
  for (let mask = 0; mask < total; mask += 1) {
    let positive = 0
    for (let index = 0; index < n; index += 1) {
      if ((mask & (1 << index)) !== 0) positive += ranks[index]
    }
    if (Math.abs(positive - expected) >= distance) extreme += 1
  }
  return extreme / total
}

function wilcoxonP(differences: number[]): { p: number | null; exact: boolean } {
  const nonzero = differences.filter(value => value !== 0)
  if (nonzero.length < 2) return { p: null, exact: false }
  const exact = exactWilcoxonP(differences)
  if (exact !== null) return { p: exact, exact: true }
  const ranked = nonzero
    .map(value => ({ abs: Math.abs(value), sign: Math.sign(value) }))
    .sort((left, right) => left.abs - right.abs)
  let positiveRank = 0
  for (let index = 0; index < ranked.length; index += 1) {
    if (ranked[index].sign > 0) positiveRank += index + 1
  }
  const n = ranked.length
  const expected = n * (n + 1) / 4
  const sd = Math.sqrt(n * (n + 1) * (2 * n + 1) / 24)
  if (sd === 0) return { p: null, exact: false }
  return { p: twoSidedP((positiveRank - expected) / sd), exact: false }
}

function statsForSamples(
  spec: ResearchMetricSpec,
  samples: number[],
  baselineSamples: number[] = [],
): {
  name: string
  n: number
  mean: number
  std: number
  ciLow: number | null
  ciHigh: number | null
  baseline: number | null
  delta: number | null
  significant: boolean | null
  test: string
  pValue: number | null
  pAdjusted: number | null
  wilcoxonP: number | null
  wilcoxonExact: boolean
  effectSize: number | null
  effectSizeType: string
} {
  const n = samples.length
  const mean = meanOf(samples)
  const std = sampleStd(samples, mean)
  const half = n > 1 ? 1.96 * std / Math.sqrt(n) : null
  const baseline = spec.baseline === undefined ? null : spec.baseline
  const delta = baseline === null ? null : spec.direction === 'min' ? baseline - mean : mean - baseline
  const paired = baselineSamples.length === n && n > 1
  const reference = paired
    ? baselineSamples
    : baseline === null ? [] : Array(n).fill(baseline)
  const differences = reference.length === n
    ? samples.map((value, index) => spec.direction === 'min' ? reference[index] - value : value - reference[index])
    : []
  const diffMean = differences.length > 0 ? meanOf(differences) : 0
  const diffStd = differences.length > 1 ? sampleStd(differences, diffMean) : 0
  const t = differences.length > 1
    ? diffStd > 0
      ? diffMean / (diffStd / Math.sqrt(differences.length))
      : diffMean === 0 ? 0 : Number.POSITIVE_INFINITY
    : null
  const pValue = t === null ? null : t === Number.POSITIVE_INFINITY ? 0 : twoSidedP(t)
  const wilcoxon = wilcoxonP(differences)
  return {
    name: spec.name,
    n,
    mean,
    std,
    ciLow: half === null ? null : mean - half,
    ciHigh: half === null ? null : mean + half,
    baseline,
    delta,
    significant: null,
    test: paired ? 'paired_t_approx' : differences.length > 0 ? 'one_sample_t_approx' : 'descriptive',
    pValue,
    pAdjusted: null,
    wilcoxonP: wilcoxon.p,
    wilcoxonExact: wilcoxon.exact,
    effectSize: differences.length > 1 && diffStd > 0 ? diffMean / diffStd : null,
    effectSizeType: paired ? 'cohen_dz' : 'cohen_d',
  }
}

/** Compute mean/std/CI/delta, paired tests, and Holm-adjusted p-values. */
export function summarizeMetricSamples(
  schema: ResearchMetricSpec[],
  samples: Record<string, number[]>,
  baselineSamples: Record<string, number[]> = {},
): ReturnType<typeof statsForSamples>[] {
  const stats = schema
    .filter(spec => Array.isArray(samples[spec.name.toLowerCase()]) && samples[spec.name.toLowerCase()].length > 0)
    .map(spec => statsForSamples(
      spec,
      samples[spec.name.toLowerCase()],
      baselineSamples[spec.name.toLowerCase()] || [],
    ))
  const tested = stats.filter(stat => stat.pValue !== null)
  const ordered = tested
    .slice()
    .sort((left, right) => (left.pValue || 1) - (right.pValue || 1))
  const count = ordered.length
  let previous = 0
  for (let index = 0; index < ordered.length; index += 1) {
    const stat = ordered[index]
    const adjusted = Math.min(1, Math.max(previous, (stat.pValue || 0) * (count - index)))
    stat.pAdjusted = adjusted
    previous = adjusted
    stat.significant = adjusted <= 0.05
  }
  return stats
}

/**
 * Compare required metric samples against targets, baseline deltas, and
 * Holm-adjusted approximate p-values. One sample cannot prove significance;
 * target/delta checks still apply, while the significance check only runs when
 * a test exists.
 */
export function assessMetricOutcome(
  schema: ResearchMetricSpec[],
  samples: Record<string, number[]>,
  baselineSamples: Record<string, number[]> = {},
): MetricVerdict {
  const decisive = schema.filter(spec =>
    spec.required
    && spec.direction !== 'none'
    && (spec.target !== undefined || (spec.baseline !== undefined && spec.minDelta !== undefined)),
  )
  if (decisive.length === 0) return 'inconclusive'
  const stats = summarizeMetricSamples(schema, samples, baselineSamples)
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
      const delta = spec.direction === 'max' ? stat.mean - spec.baseline : spec.baseline - stat.mean
      ok = delta >= spec.minDelta
    }
    if (ok && stat.significant === false) ok = false
    if (ok) pass += 1
    else fail += 1
  }
  if (fail === 0) return 'supported'
  if (pass === 0) return 'contradicted'
  return 'mixed'
}

/** Parse human-entered result metrics into a case-insensitive value map. */
export function parseMetricValues(text: string): Record<string, number> {
  const values: Record<string, number> = {}
  const pattern = /(?:^|[\s,;])([A-Za-z][A-Za-z0-9 _./-]{0,40})\s*[:=]\s*([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?%?)/g
  for (const match of String(text || '').matchAll(pattern)) {
    const name = match[1].trim().replace(/\s+/g, ' ').toLowerCase()
    const value = Number(match[2].replace(/%$/, ''))
    if (name !== '' && Number.isFinite(value)) values[name] = value
  }
  return values
}

/** Build the persisted preview shown in the Research Run experiment panel. */
export function inspectExperimentLog(logTail: string, state: string, exitCode: number | null): ExperimentLogInsight {
  const tail = String(logTail || '').slice(-12_000)
  return {
    metrics: parseExperimentMetrics(tail),
    failureClass: classifyExperimentFailure(tail, state, exitCode),
    logTail: tail,
    exitCode,
  }
}
