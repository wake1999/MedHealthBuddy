import { describe, expect, it } from 'vitest'
import {
  AgentRuntime,
  AgentToolRegistry,
  DelegateTaskTool,
  getMedHealthSpecialist,
} from '../../packages/ekko-agent/src/index'
import type { ModelClient, ModelRequest } from '../../packages/ekko-agent/src/index'

function recordingClient(seen: ModelRequest[]): ModelClient {
  return {
    provider: 'test',
    requestStyle: 'custom-runtime',
    capabilities: {
      streaming: false,
      tools: true,
      vision: false,
      jsonMode: false,
      systemPrompt: true,
    },
    create: async (request: ModelRequest) => {
      seen.push(request)
      return { content: 'done' }
    },
    stream: async function* stream() { /* unused */ },
  }
}

describe('delegation hierarchy and tool allowlist', () => {
  it('exposes delegate_task only to a lead allowed at the first level', async () => {
    const seen: ModelRequest[] = []
    const tools = new AgentToolRegistry()
    tools.register(new DelegateTaskTool())
    const runtime = new AgentRuntime({
      modelClient: recordingClient(seen),
      tools,
      toolsEnabled: true,
      maxDelegationDepth: 2,
    })
    const lead = getMedHealthSpecialist('research-lead')
    await runtime.run({
      messages: [{ role: 'user', content: 'plan a review' }],
      toolContext: { delegationDepth: 1, allowedToolNames: lead?.allowedTools },
    })

    const names = seen[0].tools?.map(tool => tool.name) ?? []
    expect(names).toContain('delegate_task')
  })

  it('removes delegate_task at the configured depth limit', async () => {
    const seen: ModelRequest[] = []
    const tools = new AgentToolRegistry()
    tools.register(new DelegateTaskTool())
    const runtime = new AgentRuntime({
      modelClient: recordingClient(seen),
      tools,
      toolsEnabled: true,
      maxDelegationDepth: 2,
    })
    const lead = getMedHealthSpecialist('research-lead')
    await runtime.run({
      messages: [{ role: 'user', content: 'write the final review' }],
      toolContext: { delegationDepth: 2, allowedToolNames: lead?.allowedTools },
    })

    const names = seen[0].tools?.map(tool => tool.name) ?? []
    expect(names).not.toContain('delegate_task')
  })

  it('filters the model tool list to the specialist allowlist', async () => {
    const seen: ModelRequest[] = []
    const tools = new AgentToolRegistry()
    tools.register(new DelegateTaskTool())
    tools.register({
      definition: { name: 'read_file', description: 'read', parameters: { type: 'object' } },
      execute: async () => ({ ok: true, content: 'read' }),
    })
    tools.register({
      definition: { name: 'terminal_exec', description: 'terminal', parameters: { type: 'object' } },
      execute: async () => ({ ok: true, content: 'terminal' }),
    })
    const runtime = new AgentRuntime({
      modelClient: recordingClient(seen),
      tools,
      toolsEnabled: true,
    })
    const reviewer = getMedHealthSpecialist('evidence-reviewer')
    await runtime.run({
      messages: [{ role: 'user', content: 'review evidence' }],
      toolContext: { delegationDepth: 1, allowedToolNames: reviewer?.allowedTools },
    })

    const names = seen[0].tools?.map(tool => tool.name) ?? []
    expect(names).toContain('read_file')
    expect(names).not.toContain('terminal_exec')
    expect(names).not.toContain('delegate_task')
  })
})
