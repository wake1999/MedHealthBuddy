// @ts-nocheck
/**
 * Research Run MVP: one resumable literature → evidence → hypothesis record.
 * The UI owns no hidden state: every mutation goes through the workbench API,
 * and the evidence table is the human approval gate.
 */
import { useEffect, useMemo, useState } from 'react'
import css from './ResearchPanel.module.css'

type Support = 'supports' | 'contradicts' | 'mixed' | 'context'
type Stage = 'scope' | 'literature' | 'evidence' | 'hypothesis'

interface RunEvidence {
  id: string
  paperId: string
  paperTitle: string
  claim: string
  quote: string
  page: number | null
  section: string
  support: Support
  confidence: number
  note: string
}

interface RunClaim {
  id: string
  text: string
  status: 'supported' | 'contradicted' | 'mixed' | 'gap'
  evidenceIds: string[]
  confidence: number
  note: string
}

interface ResearchRun {
  id: string
  projectId: string
  title: string
  question: string
  stage: Stage
  status: 'running' | 'waiting_approval' | 'completed' | 'cancelled'
  paperIds: string[]
  evidence: RunEvidence[]
  claims: RunClaim[]
  approvals: Array<{ stage: Stage; at: number; note: string }>
  createdAt: number
  updatedAt: number
}

interface RunPaper {
  id?: string
  arxivId?: string
  title: string
}

const STAGES: Stage[] = ['scope', 'literature', 'evidence', 'hypothesis']
const SUPPORTS: Support[] = ['supports', 'contradicts', 'mixed', 'context']

function apiHeaders(): Record<string, string> {
  const apiKey = window.localStorage.getItem('hermes_api_key') || ''
  const profile = window.localStorage.getItem('hermes_active_profile_name') || ''
  return {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...(profile ? { 'X-Hermes-Profile': profile } : {}),
  }
}

function paperIdOf(paper: RunPaper): string {
  return String(paper.id || paper.arxivId || '')
}

function formatDate(value: number): string {
  if (!value) return '-'
  return new Date(value).toLocaleString()
}

export function RunsView({
  projectId,
  projectTitle,
  papers,
  requestProjectSession,
  openPaperPage,
  t,
}: {
  projectId: string | null
  projectTitle?: string
  papers: readonly RunPaper[]
  requestProjectSession?: (prompt: string) => Promise<{ ok: boolean; error?: string }>
  openPaperPage?: (paperId: string, page: number) => void
  t: (key: string, params?: Record<string, unknown>) => string
}) {
  const [runs, setRuns] = useState<ResearchRun[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [loading, setLoading] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [extractionProgress, setExtractionProgress] = useState<{
    phase: string
    current: number
    total: number
    message: string
  } | null>(null)
  const [claimsBusy, setClaimsBusy] = useState(false)
  const [importBusy, setImportBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [question, setQuestion] = useState('')
  const [title, setTitle] = useState('')
  const [paperIds, setPaperIds] = useState<string[]>([])
  const [evidence, setEvidence] = useState({
    paperId: '',
    claim: '',
    quote: '',
    page: '',
    section: '',
    support: 'supports' as Support,
    confidence: '0.5',
    note: '',
  })

  const selected = runs.find(run => run.id === selectedId) || null
  const stageIndex = selected ? STAGES.indexOf(selected.stage) : 0
  const availablePapers = useMemo(() => papers.filter(paper => paperIdOf(paper) !== ''), [papers])

  async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(path, { ...options, headers: { ...apiHeaders(), ...(options.headers || {}) } })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`)
    return body as T
  }

  async function loadRuns(selectId = '') {
    if (!projectId) {
      setRuns([])
      return
    }
    setLoading(true)
    setError('')
    try {
      const body = await request<{ runs: ResearchRun[] }>(`/api/studio/research/runs?projectId=${encodeURIComponent(projectId)}`)
      setRuns(body.runs || [])
      setSelectedId(selectId || (body.runs?.[0]?.id || ''))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setSelectedId('')
    void loadRuns()
  }, [projectId])

  async function createRun() {
    if (!projectId || question.trim() === '') return
    setLoading(true)
    setError('')
    try {
      const body = await request<{ run: ResearchRun }>('/api/studio/research/runs', {
        method: 'POST',
        body: JSON.stringify({ projectId, title: title.trim(), question: question.trim(), paperIds }),
      })
      setQuestion('')
      setTitle('')
      setPaperIds([])
      await loadRuns(body.run.id)
    } catch (err) {
      setError((err as Error).message)
      setLoading(false)
    }
  }

  async function addEvidence() {
    if (!selected || evidence.claim.trim() === '') return
    setLoading(true)
    setError('')
    try {
      await request(`/api/studio/research/runs/${encodeURIComponent(selected.id)}/evidence`, {
        method: 'POST',
        body: JSON.stringify({
          paperId: evidence.paperId,
          claim: evidence.claim.trim(),
          quote: evidence.quote.trim(),
          page: evidence.page.trim() === '' ? null : Number(evidence.page),
          section: evidence.section.trim(),
          support: evidence.support,
          confidence: Number(evidence.confidence),
          note: evidence.note.trim(),
        }),
      })
      setEvidence(current => ({
        ...current,
        claim: '', quote: '', page: '', section: '', note: '',
      }))
      await loadRuns(selected.id)
    } catch (err) {
      setError((err as Error).message)
      setLoading(false)
    }
  }

  async function removeEvidence(evidenceId: string) {
    if (!selected) return
    setLoading(true)
    try {
      await request(`/api/studio/research/runs/${encodeURIComponent(selected.id)}/evidence/${encodeURIComponent(evidenceId)}`, {
        method: 'DELETE',
      })
      await loadRuns(selected.id)
    } catch (err) {
      setError((err as Error).message)
      setLoading(false)
    }
  }

  function replaceRun(updated: ResearchRun) {
    setRuns(current => {
      const exists = current.some(run => run.id === updated.id)
      return exists
        ? current.map(run => (run.id === updated.id ? updated : run))
        : [updated, ...current]
    })
    setSelectedId(updated.id)
  }

  async function extractEvidence() {
    if (!selected) return
    const runId = selected.id
    setExtracting(true)
    setError('')
    setNotice('')
    setExtractionProgress({ phase: 'reading', current: 0, total: selected.paperIds.length, message: '' })
    try {
      const started = await request<{ job: {
        state: 'running' | 'done' | 'error'
        phase: string
        current: number
        total: number
        message: string
        added: number
        skipped: number
        paperErrors: string[]
        error: string
      } }>(`/api/studio/research/runs/${encodeURIComponent(runId)}/extract-evidence?async=true`, {
        method: 'POST',
        body: JSON.stringify({ maxPerPaper: 4 }),
      })
      let job = started.job
      while (job.state === 'running') {
        setExtractionProgress({
          phase: job.phase,
          current: job.current,
          total: job.total,
          message: job.message,
        })
        await new Promise(resolve => window.setTimeout(resolve, 900))
        const status = await request<{ job: typeof job | null }>(
          `/api/studio/research/runs/${encodeURIComponent(runId)}/extract-status`,
        )
        if (!status.job) throw new Error(t('runs.extractionLost'))
        job = status.job
      }
      setExtractionProgress({
        phase: job.phase,
        current: job.current,
        total: job.total,
        message: job.message,
      })
      if (job.state === 'error') throw new Error(job.error || t('runs.extractionFailed'))
      await loadRuns(runId)
      const skipped = job.skipped > 0 ? `，跳过 ${job.skipped} 条无法在原文中定位的引用` : ''
      const failures = job.paperErrors.length > 0 ? `；${job.paperErrors.length} 篇文献读取失败` : ''
      setNotice(t('runs.extractDone', { added: job.added, skipped, failures }))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setExtracting(false)
      setExtractionProgress(null)
    }
  }

  async function importWorkbenchEvidence() {
    if (!selected) return
    setImportBusy(true)
    setError('')
    setNotice('')
    try {
      const body = await request<{ run: ResearchRun; imported: number; skipped: number }>(
        `/api/studio/research/runs/${encodeURIComponent(selected.id)}/import-workbench-evidence`,
        { method: 'POST', body: JSON.stringify({}) },
      )
      replaceRun(body.run)
      setNotice(t('runs.importDone', { imported: body.imported, skipped: body.skipped }))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setImportBusy(false)
    }
  }

  async function deriveClaims() {
    if (!selected) return
    setClaimsBusy(true)
    setError('')
    setNotice('')
    try {
      const body = await request<{ run: ResearchRun; count: number }>(
        `/api/studio/research/runs/${encodeURIComponent(selected.id)}/claims/derive`,
        { method: 'POST' },
      )
      replaceRun(body.run)
      setNotice(t('runs.claimsDerived', { count: body.count }))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setClaimsBusy(false)
    }
  }

  async function approve() {
    if (!selected) return
    setLoading(true)
    setError('')
    try {
      await request(`/api/studio/research/runs/${encodeURIComponent(selected.id)}/approve-evidence`, {
        method: 'POST',
        body: JSON.stringify({ note: 'Evidence table approved from the workbench.' }),
      })
      await loadRuns(selected.id)
    } catch (err) {
      setError((err as Error).message)
      setLoading(false)
    }
  }

  async function advance() {
    if (!selected) return
    setLoading(true)
    setError('')
    try {
      await request(`/api/studio/research/runs/${encodeURIComponent(selected.id)}/advance`, { method: 'POST' })
      await loadRuns(selected.id)
    } catch (err) {
      setError((err as Error).message)
      setLoading(false)
    }
  }

  async function askAgentForEvidence() {
    if (!selected || !requestProjectSession) return
    const prompt = [
      'Use the built-in Skill "auto-research-in-sleep".',
      `Research Run: ${selected.id}`,
      `Project: ${projectTitle || selected.projectId} (${selected.projectId})`,
      'Read the selected papers with the workbench APIs, then add 3–8 source-grounded evidence rows.',
      `Use POST /api/studio/research/runs/${selected.id}/evidence with claim, quote, page, section, support, confidence, paperId.`,
      'Every row must include a real quote and page; do not invent evidence. Do not approve the run; leave approval to the user.',
    ].join('\n')
    const result = await requestProjectSession(prompt)
    if (!result.ok) setError(result.error || t('runs.agentFailed'))
  }

  if (!projectId) {
    return (
      <section className={css.runsView}>
        <p className={css.hint}>{t('runs.noProject')}</p>
      </section>
    )
  }

  return (
    <section className={css.runsView}>
      <header className={css.runsHeader}>
        <div>
          <h2>{t('runs.title')}</h2>
          <p>{t('runs.subtitle')}</p>
        </div>
        <button type="button" className={css.btn} onClick={() => void loadRuns(selectedId)} disabled={loading}>
          {t('runs.refresh')}
        </button>
      </header>

      {error !== '' && <p className={css.failure} role="alert">{error}</p>}
      {notice !== '' && <p className={css.hint} role="status">{notice}</p>}

      <div className={css.runsCreate}>
        <input
          className={css.runsInput}
          value={title}
          onChange={event => setTitle(event.target.value)}
          placeholder={t('runs.titlePlaceholder')}
        />
        <textarea
          className={css.runsTextarea}
          value={question}
          onChange={event => setQuestion(event.target.value)}
          placeholder={t('runs.questionPlaceholder')}
          rows={3}
        />
        <div className={css.runsPaperPicker}>
          <span>{t('runs.papers')}</span>
          {availablePapers.length === 0 && <small>{t('runs.noPapers')}</small>}
          {availablePapers.map(paper => {
            const id = paperIdOf(paper)
            return (
              <label key={id}>
                <input
                  type="checkbox"
                  checked={paperIds.includes(id)}
                  onChange={() => setPaperIds(current => current.includes(id)
                    ? current.filter(value => value !== id)
                    : [...current, id])}
                />
                {paper.title}
              </label>
            )
          })}
        </div>
        <button
          type="button"
          className={css.btnPrimary}
          onClick={() => void createRun()}
          disabled={loading || question.trim() === ''}
        >
          {t('runs.create')}
        </button>
      </div>

      {runs.length === 0 && !loading && <p className={css.hint}>{t('runs.empty')}</p>}

      {runs.length > 0 && (
        <div className={css.runsLayout}>
          <aside className={css.runsList}>
            {runs.map(run => (
              <button
                key={run.id}
                type="button"
                className={css.runsListItem}
                data-active={run.id === selectedId || undefined}
                onClick={() => setSelectedId(run.id)}
              >
                <strong>{run.title}</strong>
                <span>{t(`runs.stage.${run.stage}`)} · {t(`runs.status.${run.status}`)}</span>
                <small>{run.evidence.length} {t('runs.evidenceUnit')}</small>
              </button>
            ))}
          </aside>

          {selected && (
            <div className={css.runsDetail}>
              <div className={css.runsDetailHead}>
                <div>
                  <h3>{selected.title}</h3>
                  <p>{selected.question}</p>
                </div>
                <span className={css.runsStatus}>{t(`runs.status.${selected.status}`)}</span>
              </div>

              {extracting && extractionProgress && (
                <div className={css.runsExtractionProgress} role="status">
                  <div className={css.runsExtractionHead}>
                    <span>
                      {extractionProgress.phase === 'extracting'
                        ? t('runs.extracting')
                        : t('runs.readingPaper')}
                      {' '}
                      {extractionProgress.current}/{extractionProgress.total || '?'}
                    </span>
                    {extractionProgress.message && <small>{extractionProgress.message}</small>}
                  </div>
                  <div className={css.translationProgressTrack} aria-hidden="true">
                    <span
                      className={css.translationProgressBar}
                      data-determinate={extractionProgress.total > 0 || undefined}
                      style={extractionProgress.total > 0
                        ? { width: `${Math.round((extractionProgress.current / extractionProgress.total) * 100)}%` }
                        : undefined}
                    />
                  </div>
                </div>
              )}

              <ol className={css.runsStages}>
                {STAGES.map((stage, index) => (
                  <li key={stage} data-state={index < stageIndex ? 'done' : index === stageIndex ? 'active' : 'todo'}>
                    <span>{index + 1}</span>
                    {t(`runs.stage.${stage}`)}
                  </li>
                ))}
              </ol>

              <div className={css.runsActions}>
                <button
                  type="button"
                  className={css.btnPrimary}
                  disabled={extracting || loading || selected.paperIds.length === 0}
                  onClick={() => void extractEvidence()}
                >
                  {extracting ? t('runs.extracting') : t('runs.autoExtract')}
                </button>
                <button
                  type="button"
                  className={css.btn}
                  disabled={!requestProjectSession || loading || extracting}
                  onClick={() => void askAgentForEvidence()}
                >
                  {t('runs.agentExtract')}
                </button>
                <button
                  type="button"
                  className={css.btn}
                  disabled={importBusy || loading || extracting}
                  onClick={() => void importWorkbenchEvidence()}
                >
                  {importBusy ? t('runs.importBusy') : t('runs.importWorkbench')}
                </button>
                <button
                  type="button"
                  className={css.btnPrimary}
                  disabled={loading || selected.evidence.length === 0 || selected.stage !== 'evidence'}
                  onClick={() => void approve()}
                >
                  {t('runs.approveEvidence')}
                </button>
                <button
                  type="button"
                  className={css.btn}
                  disabled={loading || (selected.stage === 'evidence' && !selected.approvals.some(item => item.stage === 'evidence'))}
                  onClick={() => void advance()}
                >
                  {t('runs.advance')}
                </button>
                <small>{t('runs.updated')}: {formatDate(selected.updatedAt)}</small>
              </div>

              <h4>{t('runs.evidenceTitle')} ({selected.evidence.length})</h4>
              {selected.evidence.length === 0 && <p className={css.hint}>{t('runs.evidenceEmpty')}</p>}
              {selected.evidence.length > 0 && (
                <div className={css.runsEvidenceTableWrap}>
                  <table className={css.runsEvidenceTable}>
                    <thead>
                      <tr>
                        <th>{t('runs.claim')}</th>
                        <th>{t('runs.quote')}</th>
                        <th>{t('runs.source')}</th>
                        <th>{t('runs.support')}</th>
                        <th>{t('runs.confidence')}</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {selected.evidence.map(row => (
                        <tr key={row.id}>
                          <td>{row.claim}</td>
                          <td>{row.quote || '—'}</td>
                          <td>
                            {row.paperId && openPaperPage ? (
                              <button
                                type="button"
                                className={css.runsSourceLink}
                                onClick={() => openPaperPage(row.paperId, row.page || 1)}
                                title={t('runs.openSource')}
                              >
                                {row.paperTitle || '—'}{row.page ? ` · p.${row.page}` : ''}
                              </button>
                            ) : (
                              <span>{row.paperTitle || '—'}{row.page ? ` · p.${row.page}` : ''}</span>
                            )}
                            {row.section ? <small> · {row.section}</small> : null}
                          </td>
                          <td>{t(`runs.supportValue.${row.support}`)}</td>
                          <td>{Math.round(row.confidence * 100)}%</td>
                          <td>
                            <button type="button" className={css.runsIconButton} onClick={() => void removeEvidence(row.id)} title={t('runs.delete')}>
                              ×
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className={css.runsClaims}>
                <div className={css.runsClaimsHead}>
                  <h4>{t('runs.claimsTitle')} ({selected.claims?.length || 0})</h4>
                  <button
                    type="button"
                    className={css.btn}
                    disabled={claimsBusy || selected.evidence.length === 0}
                    onClick={() => void deriveClaims()}
                  >
                    {claimsBusy ? t('runs.claimsBusy') : t('runs.deriveClaims')}
                  </button>
                </div>
                {(selected.claims?.length || 0) === 0 && <p className={css.hint}>{t('runs.claimsEmpty')}</p>}
                {(selected.claims || []).map(claim => (
                  <article key={claim.id} className={css.runsClaimCard} data-status={claim.status}>
                    <div className={css.runsClaimText}>{claim.text}</div>
                    <div className={css.runsClaimMeta}>
                      <span>{t(`runs.claimStatus.${claim.status}`)}</span>
                      <span>{Math.round(claim.confidence * 100)}%</span>
                      <span>{claim.evidenceIds.length} {t('runs.evidenceUnit')}</span>
                    </div>
                    <div className={css.runsClaimEvidence}>
                      {claim.evidenceIds.map((evidenceId) => {
                        const evidenceRow = selected.evidence.find(row => row.id === evidenceId)
                        if (!evidenceRow) return null
                        return (
                          <button
                            key={evidenceId}
                            type="button"
                            onClick={() => {
                              if (evidenceRow.paperId && openPaperPage) {
                                openPaperPage(evidenceRow.paperId, evidenceRow.page || 1)
                              }
                            }}
                            title={evidenceRow.quote}
                          >
                            {evidenceRow.paperTitle || t('runs.source')}
                            {evidenceRow.page ? ` · p.${evidenceRow.page}` : ''}
                          </button>
                        )
                      })}
                    </div>
                    {claim.note && <p>{claim.note}</p>}
                  </article>
                ))}
              </div>

              <div className={css.runsEvidenceForm}>
                <h4>{t('runs.addEvidence')}</h4>
                <select
                  className={css.runsInput}
                  value={evidence.paperId}
                  onChange={event => setEvidence({ ...evidence, paperId: event.target.value })}
                >
                  <option value="">{t('runs.noPaper')}</option>
                  {availablePapers.map(paper => <option key={paperIdOf(paper)} value={paperIdOf(paper)}>{paper.title}</option>)}
                </select>
                <input
                  className={css.runsInput}
                  value={evidence.claim}
                  onChange={event => setEvidence({ ...evidence, claim: event.target.value })}
                  placeholder={t('runs.claimPlaceholder')}
                />
                <textarea
                  className={css.runsTextarea}
                  value={evidence.quote}
                  onChange={event => setEvidence({ ...evidence, quote: event.target.value })}
                  placeholder={t('runs.quotePlaceholder')}
                  rows={2}
                />
                <div className={css.runsEvidenceMeta}>
                  <input
                    className={css.runsInput}
                    value={evidence.page}
                    onChange={event => setEvidence({ ...evidence, page: event.target.value })}
                    placeholder={t('runs.page')}
                    inputMode="numeric"
                  />
                  <input
                    className={css.runsInput}
                    value={evidence.section}
                    onChange={event => setEvidence({ ...evidence, section: event.target.value })}
                    placeholder={t('runs.section')}
                  />
                  <select
                    className={css.runsInput}
                    value={evidence.support}
                    onChange={event => setEvidence({ ...evidence, support: event.target.value as Support })}
                  >
                    {SUPPORTS.map(value => <option key={value} value={value}>{t(`runs.supportValue.${value}`)}</option>)}
                  </select>
                  <input
                    className={css.runsInput}
                    value={evidence.confidence}
                    onChange={event => setEvidence({ ...evidence, confidence: event.target.value })}
                    placeholder={t('runs.confidence')}
                    inputMode="decimal"
                  />
                </div>
                <input
                  className={css.runsInput}
                  value={evidence.note}
                  onChange={event => setEvidence({ ...evidence, note: event.target.value })}
                  placeholder={t('runs.note')}
                />
                <button
                  type="button"
                  className={css.btn}
                  onClick={() => void addEvidence()}
                  disabled={loading || evidence.claim.trim() === ''}
                >
                  {t('runs.addEvidence')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
