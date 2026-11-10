import { describe, expect, it, vi } from 'vitest'
import { DelegateTeamTool } from '../../packages/ekko-agent/src/tools/delegation-team'

describe('parallel specialist team', () => {
  it('confirms once and delegates independent tasks in parallel', async () => {
    const delegateTask = vi.fn(async (request: any) => ({
      ok: true,
      content: `${request.specialist} done`,
    }))
    const requestUserClarification = vi.fn().mockResolvedValue('调用专家')
    const tool = new DelegateTeamTool()

    const result = await tool.execute({
      tasks: [
        { goal: 'Screen literature', specialist: 'literature-scout' },
        { goal: 'Review evidence', specialist: 'evidence-reviewer' },
      ],
    }, { delegateTask, requestUserClarification })

    expect(result.ok).toBe(true)
    expect(requestUserClarification).toHaveBeenCalledOnce()
    expect(delegateTask).toHaveBeenCalledTimes(2)
    expect(delegateTask.mock.calls.map(call => call[0].specialist).sort())
      .toEqual(['evidence-reviewer', 'literature-scout'])
  })

  it('rejects a team that contains an unknown role', async () => {
    const tool = new DelegateTeamTool()
    const result = await tool.execute({
      tasks: [{ goal: 'Do work', specialist: 'not-a-role' }],
    }, {
      delegateTask: vi.fn(),
      requestUserClarification: vi.fn(),
    })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Unknown MedHealth specialist role/)
  })

  it('does not let a delegated specialist start another team', async () => {
    const tool = new DelegateTeamTool()
    const result = await tool.execute({
      tasks: [{ goal: 'Do work', specialist: 'evidence-reviewer' }],
    }, {
      delegationDepth: 1,
      delegateTask: vi.fn(),
    })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/cannot start a parallel team/)
  })
})
