import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  canDelegateAtDepth,
  getMedHealthSpecialist,
  isToolAllowedForRun,
} from '../../packages/ekko-agent/src/orchestration/specialists'

interface SpecialistEvalCase {
  id: string
  role: string
  tool?: string
  depth: number
  expectedAllowed?: boolean
  expectedCanDelegate?: boolean
}

const cases = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/specialist-evals.json'), 'utf-8'),
) as SpecialistEvalCase[]

describe('specialist policy eval fixtures', () => {
  for (const item of cases) {
    it(item.id, () => {
      const role = getMedHealthSpecialist(item.role)
      expect(role).toBeTruthy()
      if (!role) return
      if (item.expectedCanDelegate !== undefined) {
        expect(canDelegateAtDepth(item.depth, 2, role.allowedTools)).toBe(item.expectedCanDelegate)
      }
      if (item.tool && item.expectedAllowed !== undefined) {
        expect(isToolAllowedForRun(item.tool, item.depth, 2, role.allowedTools))
          .toBe(item.expectedAllowed)
      }
    })
  }
})
