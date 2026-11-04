/**
 * Side-channel progress for Research Run evidence extraction.
 *
 * The extraction request can spend a minute per paper in the model, so the
 * client starts an async job and polls this small in-memory record instead of
 * holding one HTTP request open without feedback.
 */
export type RunExtractionState = 'running' | 'done' | 'error'

export interface RunExtractionJob {
  state: RunExtractionState
  phase: string
  current: number
  total: number
  message: string
  added: number
  skipped: number
  paperErrors: string[]
  startedAt: number
  endedAt: number
  error: string
}

const jobs = new Map<string, RunExtractionJob>()

export function runExtractionKey(profile: string | undefined, runId: string): string {
  return `${profile || 'default'}:${runId}`
}

export function beginRunExtraction(key: string): RunExtractionJob | null {
  const existing = jobs.get(key)
  if (existing?.state === 'running') return null
  const job: RunExtractionJob = {
    state: 'running',
    phase: 'reading',
    current: 0,
    total: 0,
    message: '',
    added: 0,
    skipped: 0,
    paperErrors: [],
    startedAt: Date.now(),
    endedAt: 0,
    error: '',
  }
  jobs.set(key, job)
  return job
}

export function updateRunExtraction(key: string, patch: Partial<RunExtractionJob>): void {
  const current = jobs.get(key)
  if (!current || current.state !== 'running') return
  jobs.set(key, { ...current, ...patch })
}

export function finishRunExtraction(
  key: string,
  result: { added: number; skipped: number; paperErrors: string[] } | { error: string },
): void {
  const current = jobs.get(key)
  if (!current) return
  if ('error' in result) {
    jobs.set(key, { ...current, state: 'error', error: result.error, endedAt: Date.now() })
  } else {
    jobs.set(key, {
      ...current,
      state: 'done',
      phase: 'done',
      current: current.total,
      added: result.added,
      skipped: result.skipped,
      paperErrors: result.paperErrors,
      endedAt: Date.now(),
    })
  }
}

export function getRunExtraction(key: string): RunExtractionJob | null {
  return jobs.get(key) || null
}
