import { describe, expect, it, vi } from 'vitest'
import { DelegateTaskTool } from '../../packages/ekko-agent/src/tools/delegation'
import {
  MEDHEALTH_SPECIALISTS,
  getMedHealthSpecialist,
  medHealthSpecialistPrompt,
} from '../../packages/ekko-agent/src/orchestration/specialists'

describe('MedHealth specialist delegation', () => {
  it('exposes a static role catalog in the delegate_task schema', () => {
    const tool = new DelegateTaskTool()
    const properties = tool.definition.parameters.properties as Record<string, any>
    expect(properties.specialist.enum).toEqual(MEDHEALTH_SPECIALISTS.map(item => item.id))
    expect(properties.specialist.enum).toContain('evidence-reviewer')
    expect(properties.specialist.enum).toContain('data-steward')
  })

  it('passes a valid specialist role to the runtime delegate', async () => {
    const delegateTask = vi.fn().mockResolvedValue({ ok: true, content: 'reviewed' })
    const tool = new DelegateTaskTool()
    const result = await tool.execute(
      {
        goal: 'Audit the evidence table',
        mode: 'foreground',
        specialist: 'evidence-reviewer',
      },
      { delegateTask },
    )

    expect(result).toEqual({ ok: true, content: 'reviewed' })
    expect(delegateTask).toHaveBeenCalledWith({
      goal: 'Audit the evidence table',
      mode: 'foreground',
      specialist: 'evidence-reviewer',
    })
  })

  it('rejects an unknown specialist role before calling the runtime', async () => {
    const delegateTask = vi.fn()
    const tool = new DelegateTaskTool()
    const result = await tool.execute(
      { goal: 'Audit', mode: 'foreground', specialist: 'imaginary-role' },
      { delegateTask },
    )

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Unknown MedHealth specialist role/)
    expect(delegateTask).not.toHaveBeenCalled()
  })

  it('keeps specialist instructions evidence-first and prevents clinical decisions', () => {
    const prompt = medHealthSpecialistPrompt('evidence-reviewer')
    expect(prompt).toContain('Specialist role: Evidence reviewer')
    expect(prompt).toContain('Do not make clinical recommendations')
    expect(prompt).toContain('do not make final clinical decisions')
    expect(getMedHealthSpecialist('missing-role')).toBeNull()
  })
})
