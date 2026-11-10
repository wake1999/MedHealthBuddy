import type {
  AgentTaskMode,
  AgentTaskRequest,
  AgentTool,
  AgentToolContext,
  AgentToolResult,
} from './types'
import {
  MEDHEALTH_SPECIALISTS,
  getMedHealthSpecialist,
} from '../orchestration/specialists'

export interface DelegateTaskInput extends Record<string, unknown> {
  goal: string
  context?: string
  mode?: AgentTaskMode
  model?: string
  specialist?: string
}

export class DelegateTaskTool implements AgentTool<DelegateTaskInput> {
  readonly definition = {
    name: 'delegate_task',
    description: [
      'Delegate one self-contained task to an isolated Ekko subagent.',
      'Use foreground when this turn needs the result before continuing.',
      'Use background for independent work that may finish after the parent response; progress remains visible to the user.',
      'The subagent inherits the provider, workspace, and tools, but no parent conversation history and cannot delegate recursively.',
      'Pass model to run the subagent on a different model of the same provider; use it when the parent writes and a separate reviewer model audits.',
      'Pass specialist to apply a static MedHealth research role. Roles are advisory, cannot spawn more agents, and never authorize clinical decisions.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: 'A specific, self-contained outcome for the subagent.',
        },
        context: {
          type: 'string',
          description: 'Optional paths, constraints, errors, or background information required to complete the task.',
        },
        mode: {
          type: 'string',
          enum: ['foreground', 'background'],
          description: 'foreground waits for and returns the result; background starts the task and returns immediately.',
        },
        model: {
          type: 'string',
          description: 'Optional model name the subagent runs on, inside the current provider. Omit to inherit the parent model. A reviewer model different from the writer model keeps the review independent.',
        },
        specialist: {
          type: 'string',
          enum: MEDHEALTH_SPECIALISTS.map(item => item.id),
          description: `Optional static MedHealth specialist role. It scopes the delegated analysis; the parent remains responsible for the final answer. Roles: ${MEDHEALTH_SPECIALISTS.map(item => `${item.id} (${item.description})`).join('; ')}`,
        },
      },
      required: ['goal', 'mode'],
      additionalProperties: false,
    },
  }

  async execute(input: DelegateTaskInput, context: AgentToolContext = {}): Promise<AgentToolResult> {
    const goal = String(input.goal || '').trim()
    if (!goal) return failure('delegate_task requires a non-empty goal.')
    if (context.delegationDepth && context.delegationDepth > 0) {
      return failure('Recursive delegation is disabled for Ekko subagents.')
    }
    if (!context.delegateTask) return failure('Subtask delegation is unavailable in this runtime.')

    const mode = normalizeMode(input.mode)
    if (!mode) return failure('delegate_task mode must be foreground or background.')
    const model = typeof input.model === 'string' ? input.model.trim() : ''
    const specialist = typeof input.specialist === 'string' ? input.specialist.trim() : ''
    if (specialist && !getMedHealthSpecialist(specialist)) {
      return failure(`Unknown MedHealth specialist role: ${specialist}`)
    }
    const request: AgentTaskRequest = {
      goal,
      mode,
      ...(typeof input.context === 'string' && input.context.trim()
        ? { context: input.context.trim() }
        : {}),
      ...(model ? { model } : {}),
      ...(specialist ? { specialist } : {}),
    }
    return context.delegateTask(request)
  }
}

export function createDelegationTools(): AgentTool[] {
  return [new DelegateTaskTool()]
}

function normalizeMode(value: unknown): AgentTaskMode | null {
  return value === 'foreground' || value === 'background' ? value : null
}

function failure(message: string): AgentToolResult {
  return { ok: false, content: message, error: message }
}
