# Research Flow Runner

The runner is a deterministic fixture/dry-run harness for the research state
machine. It is intentionally not an unattended scientific agent.

## Modes

### dry-run

- Creates only a flow record.
- Does not create a project, paper, Run, evidence, or result.
- Returns the planned steps.
- Useful for checking the pipeline without touching research data.

### fixture

- Creates a fixture project when no `projectId` is supplied.
- Adds a fixture paper, Run, evidence, and claim.
- Stops at the first human gate.

### ssh

- Uses the same fixture scope/evidence/claim setup.
- Requires a configured `serverId`.
- After the plan gate, submits the experiment command through the existing SSH
  job service.
- `tick` polls the job; `resume` can re-enter polling after a process restart.
- Failed jobs are resubmitted up to `maxAttempts` (default 2).
- A succeeded job stops at the `result` gate; the operator records the real
  result, then approves the final gate.

## Human gates

```text
claims
  approve the fixture claim, save hypothesis and plan
plan
  fixture: create experiment and record fixture result
  ssh: create experiment and submit the real job
result
  fixture: generate report and Results draft
  ssh: require a recorded result, then generate report and Results draft
```

Every gate requires a non-empty note.

## Idempotency

The same `idempotencyKey` and mode returns the existing flow instead of creating
another Run.

## API

```text
POST   /api/studio/research/flows
GET    /api/studio/research/flows?projectId=...
GET    /api/studio/research/flows/:flowId
POST   /api/studio/research/flows/:flowId/approve
POST   /api/studio/research/flows/:flowId/tick
POST   /api/studio/research/flows/:flowId/resume
DELETE /api/studio/research/flows/:flowId
```

Create body:

```json
{
  "projectId": "proj_...",
  "mode": "fixture",
  "idempotencyKey": "fixture-2026-11-05",
  "title": "Fixture flow"
}
```

Approve body:

```json
{ "gate": "claims", "note": "checked claim" }
```

## Checkpoint and retry

Each SSH flow stores:

```text
serverId
jobId
attempt / maxAttempts
checkpoint (job, attempt, state, timestamp)
error
```

`tick` is idempotent for the current job. A failed job is resubmitted only while
`attempt < maxAttempts`; once exhausted the flow becomes `failed` and stops.

## Current boundary

- Fixture data is synthetic.
- SSH mode uses the existing remote job service, but the local test suite does
  not have a live remote host; only validation and fixture paths were exercised.
- No model call is made for Claim derivation.
- A completed fixture flow proves the state machine, not the scientific result.
- SSH result recording remains an operator action; the runner does not infer
  metric samples from logs.
