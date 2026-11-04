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
