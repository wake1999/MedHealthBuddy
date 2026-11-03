/**
 * In-memory progress for whole-paper translations.
 *
 * The translation endpoint stays synchronous (the reader needs the finished
 * bytes), so the client polls this side-channel while the request is running.
 * Entries are intentionally small and expire after an hour.
 */
export type TranslationJobState = 'running' | 'done' | 'error' | 'cancelled'

export interface TranslationJobStatus {
  state: TranslationJobState
  phase: string
  current: number | null
  total: number | null
  percent: number | null
  startedAt: number
  updatedAt: number
  error?: string
}

const jobs = new Map<string, TranslationJobStatus>()
const HOUR = 60 * 60 * 1000

function prune(): void {
  const cutoff = Date.now() - HOUR
  for (const [key, job] of jobs) {
    if (job.updatedAt < cutoff) jobs.delete(key)
  }
}

export function translationJobKey(profile: string, paperId: string, variant: string): string {
  return `${profile}\u0000${paperId}\u0000${variant}`
}

export function beginTranslationJob(key: string): TranslationJobStatus | null {
  prune()
  const current = jobs.get(key)
  if (current?.state === 'running') return null
  const now = Date.now()
  const job: TranslationJobStatus = {
    state: 'running',
    phase: 'preparing',
    current: null,
    total: null,
    percent: null,
    startedAt: now,
    updatedAt: now,
  }
  jobs.set(key, job)
  return job
}

export function updateTranslationJob(
  key: string,
  patch: Partial<Pick<TranslationJobStatus, 'phase' | 'current' | 'total' | 'percent'>>,
): void {
  const current = jobs.get(key)
  if (!current || current.state !== 'running') return
  const percent = typeof patch.percent === 'number'
    ? Math.max(0, Math.min(100, patch.percent))
    : current.percent
  jobs.set(key, { ...current, ...patch, percent, updatedAt: Date.now() })
}

export function finishTranslationJob(
  key: string,
  state: Exclude<TranslationJobState, 'running'>,
  error?: string,
): void {
  const current = jobs.get(key)
  if (!current) return
  jobs.set(key, { ...current, state, error, updatedAt: Date.now() })
}

export function getTranslationJob(key: string): TranslationJobStatus | null {
  prune()
  return jobs.get(key) ?? null
}
