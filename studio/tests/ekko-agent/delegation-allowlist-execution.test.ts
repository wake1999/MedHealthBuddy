import { describe, expect, it } from 'vitest'
import { AgentRuntime, AgentToolRegistry } from '../../packages/ekko-agent/src/index'
import type { AgentRuntimeEvent, ModelClient } from '../../packages/ekko-agent/src/index'

describe('specialist tool allowlist execution guard', () => {
  it('rejects a hidden tool even when the model calls it directly', async () => {
    let calls = 0
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
        calls += 1
        if (calls === 1) {
          return {
            content: '',
            toolCalls: [
              { id: 'call-1', name: 'terminal_exec', arguments: { command: 'echo forbidden' } },
            ],
          }
        }
        return { content: 'done' }
      },
      stream: async function* stream() { /* unused */ },
    }
    const tools = new AgentToolRegistry()
    tools.register({
      definition: { name: 'read_file', description: 'read', parameters: { type: 'object' } },
      execute: async () => ({ ok: true, content: 'read' }),
    })
    tools.register({
      definition: { name: 'terminal_exec', description: 'terminal', parameters: { type: 'object' } },
      execute: async () => ({ ok: true, content: 'executed' }),
    })
    const runtime = new AgentRuntime({
      modelClient,
      tools,
      toolsEnabled: true,
      maxDelegationDepth: 2,
    })

    await runtime.run({
      messages: [{ role: 'user', content: 'review' }],
      toolContext: { delegationDepth: 1, allowedToolNames: ['read_file'] },
      onEvent: event => events.push(event),
    })

    const failure = events.find(
      event => event.type === 'tool.failed' && event.toolName === 'terminal_exec',
    )
    expect(failure).toBeTruthy()
    if (failure?.type === 'tool.failed') {
      expect(failure.result.error).toMatch(/not allowed/)
    }
  })
})
