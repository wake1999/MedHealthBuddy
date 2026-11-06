/**
 * Background runner for research automation. It only touches runs that were
 * explicitly started in auto mode, so manual runs keep their existing behavior.
 * The state is persisted on the Run, which makes the loop restart-safe.
 */
import { logger } from '../../public/logging'
import { listProfileNamesFromDisk } from '../../public/profile-config'
import { autoRunToResultGate } from './run-auto'
import { readStore, updateStore } from './store'

const TICK_MS = 20_000
let timer: NodeJS.Timeout | null = null
const inFlight = new Set<string>()

async function markAutomation(
  profile: string,
  runId: string,
  patch: { nextRunAt?: number; lastError?: string },
): Promise<void> {
  await updateStore(profile, 'run.automation.tick', draft => {
    const run = draft.runs.find(row => row.id === runId)
    if (!run?.automation) return
    if (patch.nextRunAt !== undefined) run.automation.nextRunAt = patch.nextRunAt
    if (patch.lastError !== undefined) run.automation.lastError = patch.lastError
    run.updatedAt = Date.now()
  }, { actor: { kind: 'system', id: 'run-orchestrator' }, action: 'run.automation.tick' })
}

async function tick(): Promise<void> {
  let profiles: string[] = []
  try {
    profiles = listProfileNamesFromDisk()
  } catch (error) {
    logger.warn(error, '[research-orchestrator] profile list unavailable')
    return
  }

  for (const profile of profiles) {
    let store
    try {
      store = await readStore(profile)
    } catch (error) {
      logger.warn(error, '[research-orchestrator] cannot read profile %s', profile)
      continue
    }
    for (const run of store.runs) {
      const automation = run.automation
      if (!automation?.enabled) continue
      if (run.status === 'completed' || run.status === 'cancelled') continue
      if (run.approvalRequest?.status === 'pending') continue
      if (automation.nextRunAt > Date.now()) continue
      const key = `${profile}:${run.id}`
      if (inFlight.has(key)) continue
      inFlight.add(key)
      try {
        const result = await autoRunToResultGate(profile, run.id, {
          serverId: automation.serverId,
          command: automation.command,
          artifactPath: automation.artifactPath,
          query: automation.query,
          dataset: automation.dataset,
          baselines: automation.baselines,
          metrics: automation.metrics,
          timeoutMs: automation.timeoutMs,
        })
        const waitingForCommand = !automation.serverId || !automation.command
        const nextRunAt = Date.now() + (waitingForCommand
          ? 5 * 60_000
          : result.status === 'awaiting_result' ? 30_000 : 5_000)
        await markAutomation(profile, run.id, { nextRunAt, lastError: '' })
      } catch (error: any) {
        const message = error?.message || String(error)
        logger.warn(error, '[research-orchestrator] run %s failed to advance', run.id)
        await markAutomation(profile, run.id, {
          nextRunAt: Date.now() + 60_000,
          lastError: message,
        }).catch(() => undefined)
      } finally {
        inFlight.delete(key)
      }
    }
  }
}

export function startResearchOrchestrator(): void {
  if (timer) return
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) return
  timer = setInterval(() => { void tick() }, TICK_MS)
  timer.unref?.()
  logger.info('[research-orchestrator] started (interval %sms)', TICK_MS)
  void tick()
}
