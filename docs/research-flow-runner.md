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

## Human gates

```text
claims
  approve the fixture claim, save hypothesis and plan
plan
  create experiment and record fixture result
result
  generate report and Results draft
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

## Current boundary

- Fixture data is synthetic.
- No real SSH experiment is submitted.
- No model call is made for Claim derivation.
- A completed flow proves the state machine, not the scientific result.
