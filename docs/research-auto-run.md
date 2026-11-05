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

## Plan generation

The auto runner infers known metric names (`F1`, `AUC`, `accuracy`, `precision`,
`recall`, `RMSE`, `MAE`, `BLEU`, `ROUGE`) from the question, title, and approved
claims, then builds an executable metric schema such as `F1:max:required`.

It accepts optional inputs:

```json
{
  "serverId": "server_...",
  "command": "python train.py --config experiment.yaml",
  "artifactPath": "~/.ekko/jobs/result.json",
  "metrics": "F1",
  "dataset": "MHLCP",
  "baselines": "reported baseline",
  "timeoutMs": 120000
}
```

Without `command` the plan still contains `待确认` dataset/baseline placeholders
and stops at the experiment gate.

## SSH submit and wait

When both `serverId` and `command` are supplied, the runner:

```text
submit experiment job
→ poll refresh-experiment
→ wait for succeeded
→ download artifactPath
→ upload/verify mhb.raw-observations.v1 artifact
→ record metric samples as the result
→ advance to analysis
→ generate report and Results draft
```

If no artifact is available, it falls back to parsed job metrics only when those
metrics are present. It never invents a result from an empty log.

If the job is still running at timeout, the job id is returned and the Run remains
at the experiment gate.

## Boundaries

- Evidence extraction requires a configured model and paper full text.
- Claim approval is automatic for this mode, so the operator should review the
  source quotes afterward.
- No real result is invented.
- SSH submission only happens when both `serverId` and `command` are supplied.
- The remote command is operator-supplied; this runner does not discover a
  project command from the paper.
- Remote artifact format must be `mhb.raw-observations.v1`.
- If the job is still running at timeout, the HTTP request returns with a job id
  and the Run remains at `experiment`.
- Live SSH execution was not exercised locally; validation and no-server paths
  were tested.
