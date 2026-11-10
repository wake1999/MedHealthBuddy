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
        if (call === 2) {
          return {
            content: [
              'Evidence reviewed.',
              '```json',
              JSON.stringify({
                summary: 'One study supports the claim.',
                findings: [{ text: 'Effect observed', source: 'PMID 1' }],
                uncertainties: ['Small sample'],
                sources: ['PMID 1'],
                needsReview: true,
              }),
              '```',
            ].join('\n'),
          }
        }
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
    expect(requestUserClarification.mock.calls[0][0].choices).toEqual(['调用专家', '本次会话允许', '取消'])
    expect(result.output.content).toBe('final synthesis')
    const start = events.find(event => event.type === 'subagent.start')
    expect(start?.type).toBe('subagent.start')
    if (start?.type === 'subagent.start') {
      expect(start.specialist).toBe('evidence-reviewer')
    }
    const complete = events.find(event => event.type === 'subagent.complete')
    expect(complete?.type).toBe('subagent.complete')
    if (complete?.type === 'subagent.complete') {
      expect(complete.structured).toBe(true)
      expect(complete.specialist).toBe('evidence-reviewer')
    }
  })
})
