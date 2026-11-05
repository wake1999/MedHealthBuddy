import { runCompile } from './compile'
import { newId, readStore, updateStore } from './store'
import {
  readPaperSource,
  writePaperSource,
  writeSnapshotFile,
} from './paper'
import { generateResultsDraft } from './run-results-draft'

function insertionPoint(source: string): number {
  const candidates = [
    source.search(/\\section\*?\{Conclusion\}/i),
    source.search(/\\bibliography\s*\{/i),
    source.search(/\\end\s*\{document\}/i),
  ]
  const found = candidates.find(index => index >= 0)
  return found === undefined ? source.length : found
}

/**
 * Insert a generated Results section into the project's main.tex.
 *
 * A snapshot is written before the edit. The compile result is returned even
 * when compilation fails so the UI can show the log and offer a rollback.
 */
export async function insertResultsIntoPaper(
  profile: string,
  runId: string,
  figureId = '',
  branchId = '',
  usePrimaryBranches = false,
): Promise<{
  draft: { markdown: string; latex: string; warnings: string[]; branchId: string }
  snapshot: { id: string; label: string; at: number; file: string; bytes: number }
  compile: Awaited<ReturnType<typeof runCompile>>
  insertedAt: number
}> {
  const store = await readStore(profile)
  const run = store.runs.find(row => row.id === runId)
  if (!run) throw new Error('research_run_not_found')
  const draft = await generateResultsDraft(profile, runId, figureId, branchId, usePrimaryBranches)
  const paper = await readPaperSource(run.projectId, profile)
  if (!paper.exists || paper.source.trim() === '') throw new Error('paper_not_found')
  if (/\\section\*?\{Results\}/i.test(paper.source)) throw new Error('research_results_already_present')

  const label = `Before Results insert · ${run.title}`.slice(0, 120)
  const file = await writeSnapshotFile(run.projectId, label, paper.source, profile)
  const snapshot = await updateStore(profile, 'paper.snapshot', state => {
    const record = {
      id: newId('snap'),
      projectId: run.projectId,
      label,
      at: Date.now(),
      file: file.file,
      bytes: file.bytes,
    }
    state.snapshots.unshift(record)
    state.snapshots = state.snapshots.slice(0, 200)
    return record
  }, { projectId: run.projectId, actor: { kind: 'user', id: 'workbench' }, action: 'paper.snapshot' })

  const point = insertionPoint(paper.source)
  const before = paper.source.slice(0, point).replace(/\s*$/, '')
  const after = paper.source.slice(point).replace(/^\s*/, '')
  const next = `${before}\n\n${draft.latex.trim()}\n\n${after}`
  await writePaperSource(run.projectId, next, profile)
  const compile = await runCompile(run.projectId, profile)
  return { draft, snapshot, compile, insertedAt: Date.now() }
}
