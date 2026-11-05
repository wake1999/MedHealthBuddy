# Project Package

A project package is a portable `.mhb.zip` containing one project and its
project-scoped records.

## Layout

```text
manifest.json
state.json
files/<project-relative-path>
```

## Manifest

```json
{
  "schema": "mhb.project-package.v1",
  "projectId": "proj_...",
  "title": "Project title",
  "files": [
    { "path": "main.tex", "sha256": "...", "size": 1234 }
  ],
  "counts": {
    "papers": 10,
    "runs": 3,
    "experiments": 2
  },
  "warnings": []
}
```

`state.json` contains only project-scoped collections:

```text
papers, folders, experiments, figures, ideas, decks, journal, evidence, runs
```

Global data is not exported:

- servers
- SSH jobs
- venue catalog
- subscriptions
- change ledger

## Restore rules

1. The package project ID must not already exist.
2. Every file is checked against its SHA-256 and size before extraction.
3. Archive paths must stay inside the project directory.
4. Incoming collection rows must belong to the package project.
5. Incoming IDs must not collide with existing records.
6. Artifact and raw-merge file paths are rewritten to the restored project
   directory.

## API

```text
GET  /api/studio/research/projects/:id/package
GET  /api/studio/research/projects/:id/package-info
POST /api/studio/research/projects/package/import
```

The import body is:

```json
{ "content": "<base64 zip>" }
```

A project ID collision returns `409`, not a silent overwrite.
