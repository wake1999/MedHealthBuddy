import { describe, expect, it, vi } from 'vitest'
import { DelegateTaskTool } from '../../packages/ekko-agent/src/tools/delegation'
import {
  MEDHEALTH_SPECIALISTS,
  canDelegateAtDepth,
  extractSpecialistReport,
  getMedHealthSpecialist,
  isToolAllowedForRun,
  medHealthSpecialistPrompt,
  withinSpecialistBudget,
} from '../../packages/ekko-agent/src/orchestration/specialists'

describe('MedHealth specialist delegation', () => {
  it('exposes a static role catalog in the delegate_task schema', () => {
    const tool = new DelegateTaskTool()
    const properties = tool.definition.parameters.properties as Record<string, any>
    expect(properties.specialist.enum).toEqual(MEDHEALTH_SPECIALISTS.map(item => item.id))
    expect(properties.specialist.enum).toContain('evidence-reviewer')
    expect(properties.specialist.enum).toContain('data-steward')
  })

  it('passes a valid specialist role to the runtime delegate after confirmation', async () => {
    const delegateTask = vi.fn().mockResolvedValue({ ok: true, content: 'reviewed' })
    const requestUserClarification = vi.fn().mockResolvedValue('调用专家')
    const tool = new DelegateTaskTool()
    const result = await tool.execute(
      {
        goal: 'Audit the evidence table',
        mode: 'foreground',
        specialist: 'evidence-reviewer',
      },
      { delegateTask, requestUserClarification },
    )

    expect(requestUserClarification).toHaveBeenCalledOnce()

    expect(result).toEqual({ ok: true, content: 'reviewed' })
    expect(delegateTask).toHaveBeenCalledWith({
      goal: 'Audit the evidence table',
      mode: 'foreground',
      specialist: 'evidence-reviewer',
      allowedTools: getMedHealthSpecialist('evidence-reviewer')?.allowedTools,
    })
  })

  it('cancels delegation when the user declines the confirmation', async () => {
    const delegateTask = vi.fn()
    const tool = new DelegateTaskTool()
    const result = await tool.execute(
      { goal: 'Audit', mode: 'foreground', specialist: 'evidence-reviewer' },
      { delegateTask, requestUserClarification: async () => '取消' },
    )

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/取消了本次专家委派/)
    expect(delegateTask).not.toHaveBeenCalled()
  })

  it('reuses a session-scoped approval without prompting again', async () => {
    const delegateTask = vi.fn().mockResolvedValue({ ok: true, content: 'reviewed' })
    const requestUserClarification = vi.fn().mockResolvedValue('本次会话允许')
    const tool = new DelegateTaskTool()
    const context = {
      sessionId: 'session-approval-test',
      delegateTask,
      requestUserClarification,
    }
    await tool.execute(
      { goal: 'Audit once', mode: 'foreground', specialist: 'evidence-reviewer' },
      context,
    )
    await tool.execute(
      { goal: 'Audit twice', mode: 'foreground', specialist: 'evidence-reviewer' },
      context,
    )

    expect(requestUserClarification).toHaveBeenCalledOnce()
    expect(delegateTask).toHaveBeenCalledTimes(2)
  })

  it('fails closed when a top-level specialist has no confirmation channel', async () => {
    const delegateTask = vi.fn()
    const tool = new DelegateTaskTool()
    const result = await tool.execute(
      { goal: 'Audit', mode: 'foreground', specialist: 'evidence-reviewer' },
      { delegateTask },
    )

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/requires user confirmation/)
    expect(delegateTask).not.toHaveBeenCalled()
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

  it('allows only the research lead to delegate at the second level', () => {
    const lead = getMedHealthSpecialist('research-lead')
    const reviewer = getMedHealthSpecialist('evidence-reviewer')
    expect(canDelegateAtDepth(0, 2, undefined)).toBe(true)
    expect(canDelegateAtDepth(1, 2, lead?.allowedTools)).toBe(true)
    expect(canDelegateAtDepth(1, 2, reviewer?.allowedTools)).toBe(false)
    expect(canDelegateAtDepth(2, 2, lead?.allowedTools)).toBe(false)
  })

  it('enforces the per-run specialist budget', () => {
    expect(withinSpecialistBudget(1, 3)).toBe(true)
    expect(withinSpecialistBudget(3, 3)).toBe(true)
    expect(withinSpecialistBudget(4, 3)).toBe(false)
    expect(withinSpecialistBudget(0, 0)).toBe(false)
  })

  it('extracts a structured specialist report without inventing one', () => {
    const report = extractSpecialistReport(
      [
        'Prose summary.',
        '```json',
        JSON.stringify({
          summary: 'Two studies support the claim.',
          findings: [{ text: 'Effect observed', evidence: 'Table 2', source: 'PMID 1' }],
          uncertainties: ['Small sample'],
          sources: ['PMID 1'],
          needsReview: true,
        }),
        '```',
      ].join('\n'),
      'evidence-reviewer',
    )
    expect(report).toMatchObject({
      role: 'evidence-reviewer',
      summary: 'Two studies support the claim.',
      uncertainties: ['Small sample'],
      sources: ['PMID 1'],
      needsReview: true,
    })
    expect(report?.findings[0]).toEqual({
      text: 'Effect observed',
      evidence: 'Table 2',
      source: 'PMID 1',
    })
    expect(extractSpecialistReport('Plain prose only.', 'evidence-reviewer')).toBeNull()
    expect(extractSpecialistReport('```json\n{bad json}\n```', 'evidence-reviewer')).toBeNull()
  })

  it('rejects a disabled specialist before delegation', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { setSpecialistEnabled } = await import('../../packages/ekko-agent/src/orchestration/specialist-settings')
    const dir = await mkdtemp(join(tmpdir(), 'medhealth-specialists-'))
    const previous = process.env.HERMES_WEBUI_STATE_DIR
    process.env.HERMES_WEBUI_STATE_DIR = dir
    try {
      setSpecialistEnabled('evidence-reviewer', false)
      const delegateTask = vi.fn()
      const result = await new DelegateTaskTool().execute(
        { goal: 'Audit', mode: 'foreground', specialist: 'evidence-reviewer' },
        {
          sessionId: 'disabled-specialist-test',
          delegateTask,
          requestUserClarification: async () => '调用专家',
        },
      )
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/disabled/)
      expect(delegateTask).not.toHaveBeenCalled()
    } finally {
      if (previous === undefined) delete process.env.HERMES_WEBUI_STATE_DIR
      else process.env.HERMES_WEBUI_STATE_DIR = previous
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('enforces the specialist tool allowlist', () => {
    const reviewer = getMedHealthSpecialist('evidence-reviewer')
    const steward = getMedHealthSpecialist('data-steward')
    expect(isToolAllowedForRun('terminal_exec', 1, 2, reviewer?.allowedTools)).toBe(false)
    expect(isToolAllowedForRun('terminal_exec', 1, 2, steward?.allowedTools)).toBe(true)
    expect(isToolAllowedForRun('delegate_task', 1, 2, reviewer?.allowedTools)).toBe(false)
  })
})
