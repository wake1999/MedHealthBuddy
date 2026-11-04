import { readStore, type ResearchRun } from './store'

function label(value: string, max = 90): string {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/"/g, "'")
    .trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function paperNodeId(paperId: string, index: number): string {
  return `P${index}_${paperId.replace(/[^a-zA-Z0-9]/g, '_').slice(-12)}`
}

/**
 * Deterministic Claim ↔ Evidence graph. The Mermaid block can be pasted into
 * GitHub/Markdown; this function never invents evidence or paper identities.
 */
export async function generateClaimGraph(
  profile: string,
  runId: string,
): Promise<{ markdown: string; mermaid: string; filename: string }> {
  const store = await readStore(profile)
  const run: ResearchRun | undefined = store.runs.find(row => row.id === runId)
  if (!run) throw new Error('research_run_not_found')
  const paperIds = Array.from(new Set(run.evidence.map(row => row.paperId).filter(Boolean)))
  const paperIndex = new Map(paperIds.map((id, index) => [id, paperNodeId(id, index)]))
  const lines: string[] = ['flowchart LR']
  for (const paperId of paperIds) {
    const evidence = run.evidence.find(row => row.paperId === paperId)
    lines.push(`  ${paperIndex.get(paperId)}["${label(evidence?.paperTitle || paperId)}"]`)
  }
  const evidenceNode = new Map<string, string>()
  run.evidence.forEach((row, index) => {
    const node = `E${index}`
    evidenceNode.set(row.id, node)
    lines.push(`  ${node}["${label(row.claim)}<br/>${row.page ? `p.${row.page}` : 'experiment'}<br/>${row.support}"]`)
    const paper = paperIndex.get(row.paperId)
    if (paper) lines.push(`  ${paper} --> ${node}`)
  })
  run.claims.forEach((claim, index) => {
    const node = `C${index}`
    lines.push(`  ${node}["${label(claim.text)}<br/>${claim.reviewStatus}"]`)
    for (const evidenceId of claim.evidenceIds) {
      const linked = evidenceNode.get(evidenceId)
      if (linked) lines.push(`  ${linked} --> ${node}`)
    }
    if (claim.contradictionIds.length > 0) {
      lines.push(`  style ${node} fill:#fff1f0,stroke:#a64d45`)
    }
  })
  const mermaid = lines.join('\n')
  const rows = run.claims.map(claim => {
    const evidence = claim.evidenceIds
      .map(id => run.evidence.find(row => row.id === id))
      .filter((row): row is NonNullable<typeof row> => row !== undefined)
    const sources = evidence.map(row => `${row.paperTitle || row.paperId}${row.page ? ` p.${row.page}` : ''}`).join('; ')
    return `| ${claim.text.replace(/\|/g, '\\|')} | ${claim.reviewStatus} | ${claim.confidence} | ${sources || '—'} |`
  })
  const markdown = [
    `# Claim–Evidence Graph: ${run.title}`,
    '',
    `- Run: \`${run.id}\``,
    `- Question: ${run.question}`,
    `- Claims: ${run.claims.length}`,
    `- Evidence: ${run.evidence.length}`,
    '',
    '## Graph',
    '',
    '```mermaid',
    mermaid,
    '```',
    '',
    '## Claims',
    '',
    '| Claim | Review | Confidence | Evidence |',
    '|---|---|---:|---|',
    ...(rows.length > 0 ? rows : ['| _No claims_ | — | — | — |']),
    '',
    '_Generated from persisted Research Run artifacts. Unlinked claims are shown without an evidence edge._',
    '',
  ].join('\n')
  return { markdown, mermaid, filename: `CLAIM_GRAPH_${run.id}.md` }
}
