import { describe, expect, it } from 'vitest'
import {
  AgentRuntime,
  AgentToolRegistry,
  DelegateTaskTool,
} from '../../packages/ekko-agent/src/index'
import type { AgentRuntimeEvent, ModelClient } from '../../packages/ekko-agent/src/index'

describe('specialist delegation budget', () => {
  it('stops a run after the configured number of child agents', async () => {
    let call = 0
    const events: AgentRuntimeEvent[] = []
    const modelClient: ModelClient = {
      provider: 'test',
      requestStyle: 'custom-runtime',
      capabilities: {
        streaming: false,
        tools: true,
        vision: false,
        jsonMode: false,
        systemPrompt: true,
      },
      create: async () => {
        call += 1
        if (call === 1 || call === 3) {
          return {
            content: '',
            toolCalls: [{
              id: `call-${call}`,
              name: 'delegate_task',
              arguments: {
                goal: 'Review evidence',
                mode: 'foreground',
                specialist: 'evidence-reviewer',
              },
            }],
          }
        }
        if (call === 2) return { content: 'first child result' }
        return { content: 'final answer' }
      },
      stream: async function* stream() { /* unused */ },
    }
    const tools = new AgentToolRegistry()
    tools.register(new DelegateTaskTool())
    const runtime = new AgentRuntime({
      modelClient,
      tools,
      toolsEnabled: true,
      maxDelegationDepth: 2,
      maxSpecialistsPerRun: 1,
    })

    const result = await runtime.run({
      messages: [{ role: 'user', content: 'Review evidence twice' }],
      toolContext: { requestUserClarification: async () => '调用专家' },
      onEvent: event => events.push(event),
    })

    expect(result.output.content).toBe('final answer')
    expect(events.filter(event => event.type === 'subagent.start')).toHaveLength(1)
    expect(events.some(event => event.type === 'subagent.complete')).toBe(true)
  })
})
