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

## Full fixture automation

`POST /flows` accepts `auto: true` for fixture mode. The runner then approves
the claim, plan, and result gates sequentially and stops at `completed`. This is
a deterministic demo of the full state machine; it does not use real papers or
invent a scientific result for a normal Run.

For a real Run, the pipeline still stops at the experiment/result gate until a
real result is recorded.

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
POST   /api/studio/research/flows/:flowId/cancel
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

`tick` acquires a 30-second flow lease (`leaseOwner`, `leaseUntil`); a second
concurrent tick gets `409 research_flow_lease_busy`. The lease is released in a
`finally` block. The authoritative lease is also a filesystem lock at
`.research/.locks/flows/<flowId>.lock`, created with `open(..., 'wx')`, so
separate processes on the same host cannot both tick one flow. Expired lock
files are reclaimed.

A failed job is retried only while `attempt < maxAttempts`. Retry delay is
exponential (`1s`, `2s`, `4s`, capped at `60s`) and stored in `retryAt`; a tick
before the due time returns `backoff` without submitting. Once exhausted the
flow becomes `failed` and stops.

## Cancel and resume

`POST /flows/:flowId/cancel` sends `kill -TERM` to the current remote pid and
marks the flow `cancelled` with a checkpoint. `POST /flows/:flowId/resume`
either continues polling a running SSH job or, for a cancelled flow, submits a
new job while attempts remain.

Both accept an optional `key`. Repeating the same key returns the current flow
without sending a second kill or submitting a second job.

## Remote artifact

The create body accepts `artifactPath`. After the SSH job succeeds, `tick`
downloads that path with base64, writes it under
`projects/<projectId>/flow-artifacts/<flowId>/`, and stores its SHA-256 and size
on the flow. A failed download is recorded in `flow.error` but does not fabricate
a result.

## Current boundary

- Fixture data is synthetic.
- SSH mode uses the existing remote job service, but the local test suite does
  not have a live remote host; only validation and fixture paths were exercised.
- No model call is made for Claim derivation.
- A completed fixture flow proves the state machine, not the scientific result.
- SSH result recording remains an operator action; the runner does not infer
  metric samples from logs.
- Remote artifact download was not exercised against a live host; only the
  validation and fixture paths are covered locally.
- The remote path is operator-supplied; it is shell-quoted but not restricted to
  a fixed directory.
- Download is buffered and capped by the SSH command buffer (64 MiB base64
  output).
