import type { ResearchRun } from './store'

/**
 * Return a read-only Run view backed by one branch. The persisted Run is not
 * mutated; this is used by report/Results exporters so they never silently
 * export a different branch than the one selected by the caller.
 */
export function selectRunBranch(run: ResearchRun, branchId = ''): ResearchRun {
  const id = branchId || run.activeBranchId
  if (id === '') return run
  const branch = run.branches.find(row => row.id === id)
  if (!branch) throw new Error('research_branch_not_found')
  return {
    ...run,
    activeBranchId: branch.id,
    hypothesis: branch.hypothesis,
    experimentPlan: branch.experimentPlan,
    experimentId: branch.experimentId,
    experimentJobId: branch.experimentJobId,
    jobInsight: branch.jobInsight,
    result: branch.result,
    stage: branch.stage,
    updatedAt: branch.updatedAt,
  }
}
