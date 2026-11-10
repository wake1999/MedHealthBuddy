import { randomUUID } from 'node:crypto'
import type {
  AgentTaskRequest,
  AgentTool,
  AgentToolContext,
  AgentToolResult,
} from './types'
import {
  getMedHealthSpecialist,
  specialistPreferredModel,
} from '../orchestration/specialists'
import { DEFAULT_CLARIFICATION_TIMEOUT_MS } from '../config'
import { isSpecialistEnabled } from '../orchestration/specialist-settings'

const MAX_TEAM_TASKS = 3

interface TeamTaskInput {
  goal: string
  specialist: string
  context?: string
}

export interface DelegateTeamInput extends Record<string, unknown> {
  tasks: TeamTaskInput[]
}

export class DelegateTeamTool implements AgentTool<DelegateTeamInput> {
  readonly definition = {
    name: 'delegate_team',
    description: [
      'Delegate up to three independent specialist tasks in parallel.',
      'Use this only when the subproblems do not depend on each other and a single confirmation is acceptable.',
      'Every task must name a static MedHealth specialist role; children cannot spawn more agents.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_TEAM_TASKS,
          items: {
            type: 'object',
            properties: {
              goal: { type: 'string', description: 'A self-contained outcome for this specialist.' },
              specialist: { type: 'string', description: 'Static MedHealth specialist role id.' },
              context: { type: 'string', description: 'Optional shared context for this task.' },
            },
            required: ['goal', 'specialist'],
            additionalProperties: false,
          },
        },
      },
      required: ['tasks'],
      additionalProperties: false,
    },
  }

  async execute(input: DelegateTeamInput, context: AgentToolContext = {}): Promise<AgentToolResult> {
    if ((context.delegationDepth || 0) > 0) {
      return failure('A delegated specialist cannot start a parallel team.')
    }
    if (!context.delegateTask) {
      return failure('Parallel delegation is unavailable in this runtime.')
    }
    const tasks = Array.isArray(input.tasks) ? input.tasks : []
    if (tasks.length === 0 || tasks.length > MAX_TEAM_TASKS) {
      return failure(`delegate_team accepts between 1 and ${MAX_TEAM_TASKS} tasks.`)
    }

    const prepared: Array<{ task: TeamTaskInput; definition: NonNullable<ReturnType<typeof getMedHealthSpecialist>> }> = []
    for (const task of tasks) {
      const goal = String(task?.goal || '').trim()
      const specialist = String(task?.specialist || '').trim()
      const definition = getMedHealthSpecialist(specialist)
      if (!goal) return failure('Every delegate_team task needs a non-empty goal.')
      if (!definition) return failure(`Unknown MedHealth specialist role: ${specialist}`)
      if (!isSpecialistEnabled(specialist)) {
        return failure(`MedHealth specialist is disabled: ${specialist}`)
      }
      prepared.push({ task: { ...task, goal }, definition })
    }

    if (!context.requestUserClarification) {
      return failure('Parallel specialist delegation requires user confirmation, but clarification is unavailable.')
    }
    const answer = await context.requestUserClarification({
      clarifyId: randomUUID(),
      question: [
        `建议并行调用 ${prepared.length} 个专家：`,
        ...prepared.map(item => `- ${item.definition.labelZh}：${item.task.goal}`),
        '是否继续？',
      ].join('\n'),
      choices: ['调用专家', '取消'],
      timeoutMs: DEFAULT_CLARIFICATION_TIMEOUT_MS,
    })
    if (String(answer || '').trim() !== '调用专家') {
      return failure('用户取消了本次并行专家调用。')
    }

    const requests: AgentTaskRequest[] = prepared.map(({ task, definition }) => ({
      goal: task.goal,
      mode: 'foreground',
      specialist: definition.id,
      allowedTools: definition.allowedTools,
      ...(typeof task.context === 'string' && task.context.trim()
        ? { context: task.context.trim() }
        : {}),
      ...(specialistPreferredModel(definition.id)
        ? { model: specialistPreferredModel(definition.id) }
        : {}),
    }))
    const results = await Promise.all(requests.map(request => context.delegateTask!(request)))
    const payload = {
      team: prepared.map((item, index) => ({
        specialist: item.definition.id,
        goal: item.task.goal,
        result: results[index],
      })),
      completed: results.filter(result => result.ok).length,
      total: results.length,
    }
    return {
      ok: results.every(result => result.ok),
      content: JSON.stringify(payload, null, 2),
      data: payload,
      ...(results.every(result => result.ok) ? {} : { error: 'One or more team tasks failed.' }),
    }
  }
}

export function createDelegationTeamTool(): AgentTool {
  return new DelegateTeamTool()
}

function failure(message: string): AgentToolResult {
  return { ok: false, content: message, error: message }
}
