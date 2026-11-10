import { describe, expect, it, vi } from 'vitest'
import {
  AgentRuntime,
  AgentToolRegistry,
  DelegateTaskTool,
} from '../../packages/ekko-agent/src/index'
import type { AgentRuntimeEvent, ModelClient, ModelRequest } from '../../packages/ekko-agent/src/index'

describe('semi-automatic specialist delegation', () => {
  it('asks for confirmation before starting the child agent', async () => {
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
      create: async (_request: ModelRequest) => {
        call += 1
        if (call === 1) {
          return {
            content: '',
            toolCalls: [{
              id: 'call-1',
              name: 'delegate_task',
              arguments: {
                goal: 'Review the evidence table',
                mode: 'foreground',
                specialist: 'evidence-reviewer',
              },
            }],
          }
        }
        if (call === 2) return { content: 'child evidence result' }
        return { content: 'final synthesis' }
      },
      stream: async function* stream() { /* unused */ },
    }
    const tools = new AgentToolRegistry()
    tools.register(new DelegateTaskTool())
    const requestUserClarification = vi.fn().mockResolvedValue('调用专家')
    const runtime = new AgentRuntime({
      modelClient,
      tools,
      toolsEnabled: true,
      maxDelegationDepth: 2,
    })

    const result = await runtime.run({
      messages: [{ role: 'user', content: 'Review this evidence' }],
      toolContext: { requestUserClarification },
      onEvent: event => events.push(event),
    })

    expect(requestUserClarification).toHaveBeenCalledOnce()
    expect(requestUserClarification.mock.calls[0][0].choices).toEqual(['调用专家', '取消'])
    expect(result.output.content).toBe('final synthesis')
    expect(events.some(event => event.type === 'subagent.start')).toBe(true)
    expect(events.some(event => event.type === 'subagent.complete')).toBe(true)
  })
})
