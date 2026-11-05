---
name: auto-research-in-sleep
description: Autonomous research loop for MedHealthBuddy. Use for end-to-end or overnight research: literature discovery, idea generation, experiment planning, server jobs, result analysis, evidence/claims, paper drafting, and cross-model review. Bridges every stage to the Research Workbench (papers, experiments, servers, ledger, compile).
metadata:
  keywords:
    - autonomous research
    - research pipeline
    - overnight research
    - idea discovery
    - experiment planning
    - result to claim
    - auto review
    - aris
---

# Auto Research in Sleep

Use the Research Workbench as the persistent state store, not a private scratch
directory. Every stage must leave a record the UI can display.

Before acting, call `skill_view` for this Skill and read
`references/workbench-api.md`. Then discover the current project and records:

```text
GET /api/studio/research/state
```

The user may start this Skill from **文献 → AI 工具 → 自主研究**, which passes the
selected project and paper scope in the prompt.

For multi-step work, prefer a persisted **Research Run** over a long chat:

```text
POST /api/studio/research/runs
{ "projectId": "...", "question": "...", "paperIds": ["..."] }
```

Ask the server to extract source-grounded rows directly:

```text
POST /api/studio/research/runs/:id/extract-evidence?async=true
{ "maxPerPaper": 4 }
GET  /api/studio/research/runs/:id/extract-status
```

The server verifies each quote against the paper's page-delimited full text and
drops paraphrases. The async form returns a job; poll its status and show
`phase`, `current`, `total`, and `message` instead of holding one silent request.
Then derive a claim mapping:

```text
POST /api/studio/research/runs/:id/claims/derive
```

Every returned claim must cite at least one real evidence id. A manual row can
also be added with:

```text
POST /api/studio/research/runs/:id/evidence
{ "paperId": "...", "claim": "...", "quote": "...", "page": 3, "section": "...", "support": "supports", "confidence": 0.8 }
```

Then stop and let the human approve the evidence table and review claims:

```text
POST  /api/studio/research/runs/:id/approve-evidence
GET   /api/studio/research/runs/:id/claim-coverage
PATCH /api/studio/research/runs/:id/claims/:claimId
POST  /api/studio/research/runs/:id/hypothesis
POST  /api/studio/research/runs/:id/experiment-plan
GET   /api/studio/research/runs/:id/claim-graph
GET   /api/studio/research/projects/:id/family-analysis
POST  /api/studio/research/runs/:id/create-experiment
POST  /api/studio/research/runs/:id/submit-experiment
POST  /api/studio/research/runs/:id/refresh-experiment
POST  /api/studio/research/runs/:id/result
POST  /api/studio/research/runs/:id/advance
GET   /api/studio/research/runs/:id/report
POST  /api/studio/research/runs/:id/results-draft
POST  /api/studio/research/runs/:id/insert-results
```

`approve-evidence` only locks the table. Hypothesis requires at least one
approved claim, no `needs_evidence` claim, and a review note for an approved
contradictory claim. A hypothesis must send `claimIds` containing only approved
claim ids. `claim-graph` exports a deterministic Mermaid Claim–Evidence graph
and Markdown table. `family-analysis` applies Holm correction to every
confirmed Run result p-value in the project; it is a project-level family, not a
replacement for a pre-registered analysis plan. Never approve evidence or
claims yourself.

`report` is a deterministic Markdown export of persisted evidence, claims,
hypothesis, plan, job insight, and statistics. `results-draft` returns a Results
section plus a LaTeX version with a generated table and real figure references
when figures exist, or explicit placeholders/warnings when they do not.
`insert-results` creates a `main.tex` snapshot first, inserts the LaTeX before
Conclusion, then compiles and returns the compile log. It refuses to insert a
second Results section. None of these endpoints calls a model; verify every
number and reference before using text in a manuscript.

Hypothesis and plan are artifacts, not free-form chat. Define a metric contract
in `experiment-plan`, for example:

```text
metricSchema: "F1:max:required:0.85:0.83:0.01, Loss:min:optional:0.2"
```

Fields are `name:direction:required:target:baseline:minDelta`; later fields are
optional. A result write-back must include the outcome
(`supported|contradicted|mixed|inconclusive`), summary, required metric samples,
and `confirmedFinal: true`. The server computes mean/std/95% CI/delta, rejects
missing required metrics, and suggests an outcome from targets and baselines;
overriding that outcome requires `overrideReason`. Send `baselineSamples` with
one value per seed for a paired t approximation; the result also carries a
Wilcoxon p-value (`wilcoxonP`, exact for up to 16 non-zero pairs), Holm-adjusted
p-values (`pAdjusted`), and a paired Cohen's dz (`effectSize`/`effectSizeType`).
A single sample cannot prove significance; provide multiple seeds when making a
significance claim. These are approximations, not a replacement for a full
statistical analysis. `refresh-experiment` also returns
`insight.metrics` and `insight.failureClass` parsed from the job log; treat them
as a preview, not as a verdict. Never approve the evidence gate or invent a
result yourself.

## Operating contract

- One active research run per project unless the user explicitly asks for
  parallel branches.
- Keep a run log in the project journal via `POST /api/studio/research/journal`.
- Distinguish `planned`, `running`, `completed`, and `failed` experiments.
- Never fabricate a metric, citation, figure, or paper claim. Read the actual
  paper/experiment/job response first.
- Destructive actions require explicit confirmation.
- For long work, checkpoint after each phase so a later turn can resume from
  `store.experiments`, `store.jobs`, `store.journal`, and `store.evidence`.

## Pipeline

### 1. Frame the question

Read the project and its papers. If the goal is ambiguous, ask one focused
question about the target venue, compute budget, or success metric.

Write a short research brief into the journal:

```text
POST /api/studio/research/journal
{ "projectId": "<id>", "kind": "plan", "text": "<question, scope, metric, constraints>" }
```

### 2. Literature and novelty

Use the workbench, not ad-hoc web scraping:

- `GET /api/studio/research/library/search?q=...`
- `GET /api/studio/research/arxiv/search?query=...`
- `GET /api/studio/research/pubmed/search?q=...`
- `POST /api/studio/research/projects/:id/papers/import-arxiv`
- `POST /api/studio/research/papers/:id/summary`
- `POST /api/studio/research/papers/:id/skill` with
  `{ "skill": "full_read" }` or `{ "skill": "passage_qa", "question": "..." }`
- `POST /api/studio/research/review` for a cross-paper synthesis.

Create candidate directions with `POST /api/studio/research/items/ideas`
(`projectId`, `title`, `text`, optional `score`, `tags`). Record the novelty
argument and the closest prior papers. Do not call an idea novel unless the
searched records support it.

### 3. Experiment plan

Create the plan as an experiment record:

```text
POST /api/studio/research/items/experiments
{ "projectId": "<id>", "title": "...", "status": "planned", "notes": "<hypothesis, variables, baselines, metric, stop condition>" }
```

Then use `PATCH /api/studio/research/items/experiments/:id` to move through
`planned → running → completed/failed`. Attach the exact command, dataset,
seed, and expected cost. Prefer a small pilot before a full run.

### 4. Run and monitor

Use the Servers module:

- `POST /api/studio/research/items/servers/:id/check`
- `POST /api/studio/research/items/servers/:id/jobs`
- `POST /api/studio/research/items/jobs/:id/refresh`

After each refresh, copy the job id and status into the experiment record and
journal. If a job fails, preserve stderr and mark the experiment `failed`; do
not silently retry without a changed hypothesis.

### 5. Analysis and claims

Only after a job returns results:

1. Write the observed result to the journal.
2. Add evidence with `POST /api/studio/research/evidence/edges`.
3. Link claim ↔ evidence; retract weak edges with
   `POST /api/studio/research/evidence/edges/retract`.
4. Update the experiment with the measured value and conclusion.
5. Produce a **result-to-claim** table: claim, evidence id, confidence,
   alternative explanation, missing experiment.

If the result is negative, record it. Do not rewrite the result to fit the
hypothesis.

### 6. Paper and figures

- Read the current source with `GET /api/studio/research/projects/:id/paper`.
- Create a snapshot before substantive edits.
- Write the manuscript with `PUT /api/studio/research/projects/:id/paper`.
- Keep bibliography in the bibliography endpoint.
- Put figures in the Figures module and reference actual files.
- Apply the venue template, compile, and inspect compile status/PDF.
- Generate a seminar deck only from real project records.

### 7. Review loop

Run independent checks before declaring the paper ready:

- `POST /api/studio/research/papers/:id/skill` with `full_read` for each core
  paper.
- `POST /api/studio/research/review` for cross-paper synthesis.
- Citation audit: verify every citation against the library/actual metadata.
- Reviewer simulation: separate "accept", "reject", and "missing evidence"
  findings; require a concrete fix for each.
- A review is not a quality verdict unless it identifies the checked artifacts.

## Overnight mode

If the host provides scheduled/background runs, use them to wake the pipeline,
detect a stalled job, and continue the next unfinished phase. A wake-up may
only advance work or report a stall; it must not declare the science good.
Always leave a resumable journal entry before stopping.

## Workbench entry

The UI entry is **文献 → AI 工具 → 自主研究**. It sends the selected project and
paper ids. Start by reading `/api/studio/research/state`, not by searching the
filesystem blindly.

## Attribution

Adapted for MedHealthBuddy from the workflow ideas in
`wanshuiyin/auto-claude-code-research-in-sleep` (ARIS). This file is an original
integration/router summary; upstream workflows, scripts, and licenses remain
with their authors. See `references/workbench-api.md` for the concrete bridge.
