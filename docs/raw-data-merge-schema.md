# Raw Data Merge Schema (Design Only)

This document defines the schema for a future raw-observation merge. It is not
implemented yet. Current merge records contain only selected summary metric
rows; they never pool raw observations.

## Goals

- Preserve source branch and experiment identity.
- Never imply a larger sample than was actually collected.
- Make every merged row traceable to a source branch, artifact, and checksum.
- Require an explicit approval and a frozen source snapshot before execution.

## Proposed tables

### `merge_jobs`

| Column | Type | Meaning |
|---|---|---|
| `id` | text | Merge job id |
| `run_id` | text | Research Run |
| `source_branch_ids` | json | Frozen source branches |
| `primary_metric_branches` | json | Metric → branch selection |
| `approval_id` | text | Human approval record |
| `status` | text | `draft`, `validated`, `running`, `done`, `failed` |
| `created_at` | integer | Creation timestamp |
| `executed_at` | integer | Execution timestamp |

### `merge_inputs`

| Column | Type | Meaning |
|---|---|---|
| `id` | text | Input id |
| `merge_job_id` | text | Parent merge job |
| `branch_id` | text | Source branch |
| `experiment_id` | text | Source experiment |
| `artifact_uri` | text | Raw predictions/metrics artifact |
| `artifact_sha256` | text | Content hash |
| `dataset_id` | text | Dataset identity |
| `dataset_sha256` | text | Dataset hash |
| `seed` | integer | Seed, when available |
| `split` | text | Train/validation/test split |

### `merge_rows`

| Column | Type | Meaning |
|---|---|---|
| `id` | text | Merged row id |
| `merge_job_id` | text | Parent merge job |
| `metric` | text | Metric name |
| `source_branch_id` | text | Origin branch |
| `source_input_id` | text | Origin artifact |
| `n` | integer | Observations in this row |
| `mean` | real | Mean |
| `std` | real | Standard deviation |
| `ci_low` | real | 95% CI low |
| `ci_high` | real | 95% CI high |
| `p_adjusted` | real | Adjusted p-value |
| `value_hash` | text | Hash of the raw values used |

## Invariants

1. `source_branch_ids` must all be frozen before execution.
2. `source_branch_ids` and `primary_metric_branches` must match the approved
   snapshot.
3. `merge_inputs.artifact_sha256` and `dataset_sha256` are verified before
   reading.
4. No row may mix observations from different datasets, splits, or baselines
   unless the analysis plan explicitly allows it.
5. `merge_rows.n` equals the number of raw observations actually included.
6. A failed or stale job never writes `merge_rows`.
7. Execution is append-only: rolling back creates a new job/version; history is
   never deleted.

## Implemented slice

The current implementation supports `mhb.raw-observations.v1` artifacts:

```json
{
  "schema": "mhb.raw-observations.v1",
  "metric": "F1",
  "dataset": "MHLCP",
  "split": "test",
  "rows": [{ "seed": 1, "value": 0.86 }]
}
```

Artifacts are written outside `state.json`, SHA-256 verified, and merged only
after the merge record is validated. A rollback requires a separate approval
note. This is still an artifact-level merge, not a database-level observation
merge.

## Explicit non-goals

- No imputation of missing seeds.
- No silent concatenation across incompatible datasets.
- No automatic significance test over pooled rows.
- No claim that the merged sample size is valid without a documented design.
