# Artifact Governance

## Retention

- Artifacts on branches referenced by any merge record are always retained.
- For all other artifacts, the cleanup policy keeps the newest `keepLatest`
  artifacts per branch and anything newer than `olderThanDays`.
- Cleanup is dry-run by default (`dryRun: true`) and returns `keep`/`remove`.
- Actual cleanup removes files and metadata only for the planned set.
- Merge records and raw-merge artifacts are never removed by artifact cleanup.

## De-identification

Only these row fields are stored:

```text
seed
value
group
```

Any other row field is stripped during upload and recorded in
`artifact.redactedFields`. The API never returns a raw artifact file path; the
artifact listing is metadata-only.

## Access

- Artifact upload requires an active, unfrozen branch.
- Artifact metadata is exposed through the authenticated run API.
- Raw artifact content is not served by the current HTTP API.
- The filesystem path is server-generated and never accepted from the client.
