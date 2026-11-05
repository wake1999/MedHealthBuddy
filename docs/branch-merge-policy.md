# Branch Merge Policy

## Purpose

Research Runs can contain independent hypothesis branches. This policy defines
what may be combined and what must remain separate.

## Rules

1. **Never pool raw observations across branches.** Branches may use different
   datasets, baselines, or analysis decisions. A merged number must not imply a
   larger sample.
2. **Freeze before consolidation.** A branch is eligible for a final comparison
   table only after it has a confirmed final result. Freezing records the reason
   and prevents hypothesis, plan, experiment, and result edits.
3. **Primary branch is selected per metric.** `primaryMetricBranches` chooses the
   branch whose metric row appears in the manuscript table. It does not merge
   statistics.
4. **Comparison is not a verdict.** Pairwise branch differences are approximate
   Welch z tests over persisted means/SDs/n and are Holm-adjusted; they do not
   replace re-running the analysis from raw samples.
5. **Source branches remain intact.** Consolidation produces a comparison table
   and Results draft; it does not delete, overwrite, or auto-merge source
   branches.
6. **Narrative still needs human selection.** A primary-branch Results draft
   combines selected metric rows, but the narrative is taken from one branch and
   must be checked for consistency.
7. **Approval gate.** All participating branches must be frozen, every
   consistency conflict must be acknowledged by key, and a written consolidation
   note is required before `usePrimaryBranches:true` is accepted.
8. **Merge records are immutable.** `POST /runs/:id/merges` creates a merge
   record with source branch ids, primary mapping, conflict acknowledgements,
   note, and a scope snapshot. It does not mutate source branches, pool samples,
   or create a synthetic experiment.
9. **No automatic data merge.** A true data merge requires an explicitly designed
   schema (which experiment, result, claims, and approvals survive). Until that
   exists, use the frozen comparison table plus primary-branch Results draft.

## Current workflow

```text
freeze source branches
→ confirm final branch results
→ select primary branch per metric
→ export branch results table
→ generate primary-branch Results draft
→ human review
```

## Audit trail

Freeze/unfreeze operations append to the branch `audit` array with timestamp and
reason. Run reports include the last audit entry.
