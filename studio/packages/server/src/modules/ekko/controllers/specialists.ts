import type { Context } from 'koa'
import {
  DEFAULT_MAX_DELEGATION_DEPTH,
  MEDHEALTH_SPECIALISTS,
  canDelegateAtDepth,
  getMedHealthSpecialist,
  specialistPreferredModel,
} from '../../../../../ekko-agent/src/orchestration/specialists'
import {
  isSpecialistEnabled,
  setSpecialistEnabled,
} from '../../../../../ekko-agent/src/orchestration/specialist-settings'

/**
 * Read-only catalog for the agent management UI.
 * No API keys, prompts, or filesystem paths are exposed here.
 */
export async function list(ctx: Context): Promise<void> {
  ctx.body = {
    maxDelegationDepth: DEFAULT_MAX_DELEGATION_DEPTH,
    specialists: MEDHEALTH_SPECIALISTS.map(item => ({
      id: item.id,
      label: item.label,
      labelZh: item.labelZh,
      description: item.description,
      descriptionZh: item.descriptionZh,
      allowedTools: [...item.allowedTools],
      canDelegate: canDelegateAtDepth(1, DEFAULT_MAX_DELEGATION_DEPTH, item.allowedTools),
      preferredModel: specialistPreferredModel(item.id),
      enabled: isSpecialistEnabled(item.id),
    })),
  }
}

export async function update(ctx: Context): Promise<void> {
  const id = String(ctx.params.id || '').trim()
  if (!getMedHealthSpecialist(id)) {
    ctx.status = 404
    ctx.body = { error: 'Unknown MedHealth specialist role' }
    return
  }
  const enabled = (ctx.request as { body?: { enabled?: unknown } }).body?.enabled
  if (typeof enabled !== 'boolean') {
    ctx.status = 400
    ctx.body = { error: 'enabled must be a boolean' }
    return
  }
  setSpecialistEnabled(id, enabled)
  ctx.body = { ok: true, id, enabled }
}
