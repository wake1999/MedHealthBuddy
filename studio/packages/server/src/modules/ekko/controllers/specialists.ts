import type { Context } from 'koa'
import {
  DEFAULT_MAX_DELEGATION_DEPTH,
  MEDHEALTH_SPECIALISTS,
  canDelegateAtDepth,
} from '../../../../../ekko-agent/src/orchestration/specialists'

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
    })),
  }
}
