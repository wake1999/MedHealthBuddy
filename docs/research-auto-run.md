# Real Auto Run to the Result Gate

`POST /api/studio/research/runs/:id/auto` automates the evidence and setup phase
of an existing Run. It does not fabricate an experiment result.

## Flow

```text
existing Run with paperIds
→ extract evidence from paper full text
→ approve evidence table
→ derive Claims
→ auto-approve Claims with usable source evidence
→ reject Claims without usable evidence
→ save hypothesis (claims linked)
→ save plan placeholders marked 待确认
→ create experiment record
→ stop at experiment stage
```

If a real result already exists, it advances to analysis and generates the Run
report and Results draft.

## Automatic claim review

Approved claims keep `reviewNote`:

```text
Automatic pipeline; source quote retained for final review.
```

Claims with contradictions keep a note requiring human review. Claims without
usable evidence are rejected instead of being approved.

## Placeholders

The generated hypothesis/plan use:

```text
independentVariable: 待确认
dependentVariable: 待确认
baselines: 待确认
metric: 待确认
dataset: 待确认
metrics: 待确认
command: empty
```

The operator must replace these before submitting a real experiment.

## Boundaries

- Evidence extraction requires a configured model and paper full text.
- Claim approval is automatic for this mode, so the operator should review the
  source quotes afterward.
- No real result is invented.
- No SSH job is submitted by this endpoint.
- The result gate remains `experiment` until a real result is recorded.
