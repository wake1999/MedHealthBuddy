---
name: academic-research-suite
description: Academic research and manuscript suite for MedHealthBuddy. Use for deep research, literature/systematic reviews, research questions, paper drafting and revision, citation auditing, peer-review simulation, venue formatting, and research-to-paper workflows. Integrates with the Research Workbench papers, notes, ledger, figures, compile, and deck modules.
metadata:
  keywords:
    - academic research
    - literature review
    - systematic review
    - paper writing
    - manuscript revision
    - peer review
    - citation check
    - ars
---

# Academic Research Suite

This is the MedHealthBuddy integration of the ARS workflow. Use the Research
Workbench as the source of truth and the UI as the place where the user reviews
changes.

Before acting, call `skill_view` for this Skill and read
`references/workbench-api.md`. Then read the current project:

```text
GET /api/studio/research/state
```

The UI entry is **文献 → AI 工具 → 学术研究套件**, which passes the selected
project and paper scope.

## Route by intent

| User intent | First workbench action |
|---|---|
| Deep research / research question | Read project + `GET /library/search`; build an evidence table |
| Literature review / synthesis | `POST /review` over selected paper ids |
| Systematic review / screening | Search PubMed/library, record inclusion/exclusion criteria, never invent PRISMA counts |
| Draft / outline / abstract | Read `GET /projects/:id/paper`; snapshot before writing |
| Revision / reviewer response | Read current source and reviewer comments; preserve a snapshot |
| Citation check | Resolve each citation against library metadata; report missing/ambiguous entries |
| Peer-review simulation | `POST /papers/:id/skill` with `full_read`, then produce independent reviewer reports |
| Venue formatting / compile | Apply venue template, update bibliography, compile, inspect status |
| Slides / seminar | Build a deck from real project records and figures |

## Deep research

1. Restate the question and scope in one paragraph.
2. Search the Project Library, arXiv, and PubMed; import only records the user
   wants to keep.
3. For each key paper, run `full_read` or a targeted `passage_qa`; save structured
   notes with the reading template.
4. Build an evidence table: claim, source, page/section, strength, contradiction.
5. Synthesize only from the table. Mark gaps and disagreements explicitly.
6. Save the synthesis as a note/journal entry and link evidence edges.

Do not treat a title/abstract as full-text evidence when a full text is
available. Do not cite a paper that is not in the library or a verified metadata
response.

## Paper writing and revision

- Read `GET /api/studio/research/projects/:id/paper`.
- Create a snapshot before a large rewrite.
- Preserve the user's claims, numbers, and voice; do not invent citations.
- Write the source with `PUT /api/studio/research/projects/:id/paper`.
- Keep the bibliography in the bibliography endpoint.
- Add real figures from the project; do not reference missing files.
- Apply the venue template, compile, and check `compile/status` plus the PDF.
- For a revision, keep a response matrix: reviewer point → change → location.

## Review and citation audit

For each core paper:

```text
POST /api/studio/research/papers/:id/skill
{ "skill": "full_read" }
```

For a cross-paper synthesis:

```text
POST /api/studio/research/review
{ "projectId": "...", "topic": "...", "paperIds": ["..."] }
```

Produce separate **accept**, **reject**, and **missing-evidence** sections. Each
finding needs a concrete location or artifact. A citation audit must list:
verified citations, unresolved citations, and metadata mismatches.

## Workbench rules

- Read before writing; use PATCH for incremental changes.
- Do not delete papers/projects/evidence/notes without confirmation.
- Mark a record as `planned` until an actual job/experiment returns.
- A successful API response is the source of truth; do not claim a UI change
  from a local draft.
- If a model or external service is unavailable, report the failure and continue
  with the parts that can be verified.

## Attribution

Adapted for MedHealthBuddy from the ARS (Academic Research Skills) workflow
concepts in `Imbad0202/academic-research-skills-codex`, which is distributed
under CC BY-NC 4.0. This integration/router is an original adaptation for the
MedHealthBuddy workbench; upstream prompts, templates, and licenses remain with
their authors.
