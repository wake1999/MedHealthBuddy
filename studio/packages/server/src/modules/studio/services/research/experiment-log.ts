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

function statsForSamples(
  spec: ResearchMetricSpec,
  samples: number[],
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
} {
  const n = samples.length
  const mean = samples.reduce((sum, value) => sum + value, 0) / n
  const variance = n > 1
    ? samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1)
    : 0
  const std = Math.sqrt(Math.max(0, variance))
  const half = n > 1 ? 1.96 * std / Math.sqrt(n) : null
  const baseline = spec.baseline === undefined ? null : spec.baseline
  const delta = baseline === null ? null : spec.direction === 'min' ? baseline - mean : mean - baseline
  const significant = baseline === null || n < 2 || half === null
    ? null
    : spec.direction === 'min'
      ? mean + half < baseline
      : mean - half > baseline
  return {
    name: spec.name,
    n,
    mean,
    std,
    ciLow: half === null ? null : mean - half,
    ciHigh: half === null ? null : mean + half,
    baseline,
    delta,
    significant,
  }
}

/** Compute mean/std/CI/delta for every metric with samples. */
export function summarizeMetricSamples(
  schema: ResearchMetricSpec[],
  samples: Record<string, number[]>,
): ReturnType<typeof statsForSamples>[] {
  return schema
    .filter(spec => Array.isArray(samples[spec.name.toLowerCase()]) && samples[spec.name.toLowerCase()].length > 0)
    .map(spec => statsForSamples(spec, samples[spec.name.toLowerCase()]))
}

/**
 * Compare required metric samples against targets, baseline deltas, and
 * approximate 95% confidence intervals. One sample cannot prove significance;
 * target/delta checks still apply, while the significance check only runs when
 * at least two samples exist.
 */
export function assessMetricOutcome(
  schema: ResearchMetricSpec[],
  samples: Record<string, number[]>,
): MetricVerdict {
  const decisive = schema.filter(spec =>
    spec.required
    && spec.direction !== 'none'
    && (spec.target !== undefined || (spec.baseline !== undefined && spec.minDelta !== undefined)),
  )
  if (decisive.length === 0) return 'inconclusive'
  let pass = 0
  let fail = 0
  for (const spec of decisive) {
    const values = samples[spec.name.toLowerCase()]
    if (!Array.isArray(values) || values.length === 0) return 'inconclusive'
    const stat = statsForSamples(spec, values)
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
