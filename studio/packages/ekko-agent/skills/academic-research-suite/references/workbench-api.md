# MedHealthBuddy research workbench bridge

Use `ekko_studio_api_request` for every workbench mutation. Paths are relative,
authentication/profile headers are handled by the MCP server. Never call a full
URL and never invent a project, paper, experiment, job, or collection id.

## Discover current state first

The workbench routes are documented under the OpenAPI `Research` tag. If an MCP
catalog shows a Studio build without that tag, refresh the MCP/OpenAPI catalog;
do not substitute the generic `/items/evidence` collection for Research Run
evidence.

Never read a paper via an absolute path such as
`C:\Users\...\.hermes\...`. Agent shells may not mount the host filesystem.
Use the API instead:

```text
GET /api/studio/research/papers/:id/fulltext
```

Then:

```text
GET /api/studio/research/state
```

Read `store.projects`, `store.papers`, `store.experiments`, `store.servers`,
`store.jobs`, `store.journal`, and `store.evidence` before planning. If the user
has selected a project/paper in the UI, use that id; otherwise ask one short
question instead of guessing.

## Module map

| Workbench module | Read | Write / action |
|---|---|---|
| Projects | `GET /api/studio/research/state` | `POST /projects`, `PATCH /projects/:id` |
| Literature search | `GET /api/studio/research/library/search?q=...`, `GET /arxiv/search?query=...`, `GET /pubmed/search?q=...` | `POST /projects/:id/papers/import-arxiv`, `POST /papers/import-pdf`, `POST /projects/:id/papers/import-zotero` |
| Paper reading | `GET /papers/:id/fulltext`, `GET /papers/:id/notes`, `GET /papers/:id/figures` | `POST /papers/:id/summary`, `POST /papers/:id/ask`, `POST /papers/:id/skill`, `PUT /papers/:id/notes` |
| Paper translation | `GET /papers/:id/translate-status?variant=mono` | `POST /papers/:id/translate-pdf?variant=mono&format=json` |
| Cross-paper review | — | `POST /review` with `{ "projectId": "...", "topic": "...", "paperIds": [] }` |
| Experiments | `GET /api/studio/research/state` (`store.experiments`) | `POST /api/studio/research/items/experiments` with `{ "projectId": "...", "title": "...", ... }`, then `PATCH /items/experiments/:id` |
| Servers / jobs | state (`store.servers`, `store.jobs`) | `POST /items/servers/:id/check`, `POST /items/servers/:id/jobs`, `POST /items/jobs/:id/refresh` |
| Journal / evidence | `GET /ledger/events`, `GET /ledger/evidence`, `GET /ledger/digest` | `POST /journal`, `POST /evidence/edges`, `POST /evidence/edges/retract` |
| Paper source | `GET /projects/:id/paper`, `GET /projects/:id/bibliography` | `PUT /projects/:id/paper`, `PUT /projects/:id/bibliography` |
| Snapshots | `GET /projects/:id/snapshots` | `POST /projects/:id/snapshots`, `POST /projects/:id/snapshots/:snapshotId/restore` |
| Figures | `GET /projects/:id/figure`, `GET /papers/:id/figures` | `POST /projects/:id/figures/upload`, `rename`, `convert`, `DELETE /projects/:id/figure` |
| Compile / PDF | `GET /projects/:id/compile/status`, `GET /projects/:id/pdf` | `POST /projects/:id/compile` |
| Venue | `GET /venue-templates`, `GET /venues/catalog` | `POST /projects/:id/venue-template`, `DELETE /projects/:id/venue-template` |
| Seminar deck | `GET /projects/:id/decks` | `POST /projects/:id/decks`, `GET /projects/:id/decks/:deckId/preview` |
| Wiki / knowledge | `GET /ledger/digest` | `POST /wiki/import` |
| Research Run | `GET /api/studio/research/runs?projectId=...`, `GET /runs/:id`, `GET /runs/:id/extract-status`, `GET /runs/:id/claim-coverage`, `GET /runs/:id/report` | `POST /runs` (`projectId`, `question`, `paperIds`), `POST /runs/:id/extract-evidence?async=true`, `POST /runs/:id/evidence`, `POST /runs/:id/claims/derive`, `POST /runs/:id/import-workbench-evidence`, `PATCH /runs/:id/claims/:claimId`, `POST /runs/:id/hypothesis`, `POST /runs/:id/experiment-plan`, `POST /runs/:id/create-experiment`, `POST /runs/:id/submit-experiment`, `POST /runs/:id/refresh-experiment`, `POST /runs/:id/result`, `POST /runs/:id/results-draft`, `POST /runs/:id/insert-results`, `POST /runs/:id/approve-evidence`, `POST /runs/:id/advance` |

## Safety rules

- Read before write. Prefer `PATCH` over replacing a whole record.
- Do not delete papers, projects, notes, evidence, or jobs without explicit
  confirmation in the same conversation.
- Distinguish **planned** from **executed** experiments. Never write a result,
  metric, citation, or claim that did not come from a tool/API/file.
- Before changing paper source, create a snapshot or keep the previous text.
- If an API returns 404/409/422, report the exact error and recover with a read;
  do not loop mutations.

The same files are visible to the panel and the agent. A successful API write is
the source of truth; do not claim a UI update until the write response says so.
