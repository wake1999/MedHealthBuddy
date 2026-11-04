import Router from '@koa/router'

import * as ctrl from '../controllers/research'
import * as paperCtrl from '../controllers/research-paper'
import * as runCtrl from '../controllers/research-runs'

export const researchRoutes = new Router()

researchRoutes.get('/api/studio/research/state', ctrl.getState)
researchRoutes.get('/api/studio/research/events', ctrl.events)

// Research Run MVP: explicit, resumable literature → evidence → hypothesis stage.
researchRoutes.get('/api/studio/research/runs', runCtrl.listRunsHandler)
researchRoutes.post('/api/studio/research/runs', runCtrl.createRunHandler)
researchRoutes.get('/api/studio/research/runs/:id', runCtrl.getRunHandler)
researchRoutes.get('/api/studio/research/runs/:id/report', runCtrl.runReportHandler)
researchRoutes.post('/api/studio/research/runs/:id/results-draft', runCtrl.runResultsDraftHandler)
researchRoutes.post('/api/studio/research/runs/:id/insert-results', runCtrl.insertResultsHandler)
researchRoutes.patch('/api/studio/research/runs/:id', runCtrl.updateRunHandler)
researchRoutes.delete('/api/studio/research/runs/:id', runCtrl.deleteRunHandler)
researchRoutes.post('/api/studio/research/runs/:id/advance', runCtrl.advanceRunHandler)
researchRoutes.post('/api/studio/research/runs/:id/approve-evidence', runCtrl.approveEvidenceHandler)
researchRoutes.post('/api/studio/research/runs/:id/evidence', runCtrl.addEvidenceHandler)
researchRoutes.post('/api/studio/research/runs/:id/extract-evidence', runCtrl.extractEvidenceHandler)
researchRoutes.get('/api/studio/research/runs/:id/extract-status', runCtrl.extractEvidenceStatusHandler)
researchRoutes.post('/api/studio/research/runs/:id/claims/derive', runCtrl.deriveClaimsHandler)
researchRoutes.patch('/api/studio/research/runs/:id/claims/:claimId', runCtrl.reviewClaimHandler)
researchRoutes.get('/api/studio/research/runs/:id/claim-coverage', runCtrl.claimCoverageHandler)
researchRoutes.post('/api/studio/research/runs/:id/hypothesis', runCtrl.saveHypothesisHandler)
researchRoutes.post('/api/studio/research/runs/:id/experiment-plan', runCtrl.saveExperimentPlanHandler)
researchRoutes.post('/api/studio/research/runs/:id/create-experiment', runCtrl.createExperimentHandler)
researchRoutes.post('/api/studio/research/runs/:id/submit-experiment', runCtrl.submitExperimentHandler)
researchRoutes.post('/api/studio/research/runs/:id/refresh-experiment', runCtrl.refreshExperimentHandler)
researchRoutes.post('/api/studio/research/runs/:id/result', runCtrl.recordResultHandler)
researchRoutes.post('/api/studio/research/runs/:id/import-workbench-evidence', runCtrl.importWorkbenchEvidenceHandler)
researchRoutes.patch('/api/studio/research/runs/:id/evidence/:evidenceId', runCtrl.updateEvidenceHandler)
researchRoutes.delete('/api/studio/research/runs/:id/evidence/:evidenceId', runCtrl.removeEvidenceHandler)

researchRoutes.post('/api/studio/research/projects', ctrl.createProject)
researchRoutes.post('/api/studio/research/projects/import', ctrl.importProjectHandler)
researchRoutes.patch('/api/studio/research/projects/:id', ctrl.updateProject)
researchRoutes.delete('/api/studio/research/projects/:id', ctrl.deleteProject)

// arXiv retrieval and subscriptions
researchRoutes.get('/api/studio/research/arxiv/search', ctrl.arxivSearch)
researchRoutes.post('/api/studio/research/projects/:id/papers/import-arxiv', ctrl.importArxivPaper)
researchRoutes.post('/api/studio/research/items/subscriptions/:id/check', ctrl.checkSubscription)

// Paper source, snapshots, compile readiness
researchRoutes.get('/api/studio/research/projects/:id/paper', ctrl.getPaper)
researchRoutes.put('/api/studio/research/projects/:id/paper', ctrl.savePaper)
researchRoutes.get('/api/studio/research/projects/:id/bibliography', ctrl.getBibliography)
researchRoutes.put('/api/studio/research/projects/:id/bibliography', ctrl.saveBibliography)
researchRoutes.post('/api/studio/research/projects/:id/papers/import-bib', ctrl.importPapersToBib)
researchRoutes.get('/api/studio/research/projects/:id/snapshots', ctrl.listSnapshots)
researchRoutes.get('/api/studio/research/projects/:id/snapshots/:snapshotId', ctrl.getSnapshotContent)
researchRoutes.post('/api/studio/research/projects/:id/snapshots', ctrl.createSnapshot)
researchRoutes.post('/api/studio/research/projects/:id/snapshots/:snapshotId/restore', ctrl.restoreSnapshot)
// Seminar deck scaffold (structure from real records, script left to the agent)
researchRoutes.post('/api/studio/research/projects/:id/decks', ctrl.createDeck)
researchRoutes.get('/api/studio/research/projects/:id/decks', ctrl.listDecksHandler)
researchRoutes.get('/api/studio/research/projects/:id/decks/:deckId/file', ctrl.downloadDeck)
// Compiled paper, for the editor's preview pane
researchRoutes.get('/api/studio/research/projects/:id/pdf', ctrl.getPaperPdf)
// One paper's fetched PDF bytes, for the reader's iframe（走 query，旧式 id 带斜杠）
researchRoutes.get('/api/studio/research/paper-pdf', ctrl.getPaperFilePdf)
researchRoutes.get('/api/studio/research/projects/:id/figure', ctrl.getProjectFigure)
researchRoutes.post('/api/studio/research/projects/:id/figures/upload', ctrl.uploadFigureHandler)
researchRoutes.post('/api/studio/research/projects/:id/figures/rename', ctrl.renameFigureHandler)
researchRoutes.post('/api/studio/research/projects/:id/figures/convert', ctrl.convertFigureHandler)
researchRoutes.delete('/api/studio/research/projects/:id/figure', ctrl.deleteFigureHandler)
researchRoutes.get('/api/studio/research/projects/:id/decks/:deckId', ctrl.getDeck)
// Deck preview: the pptx flattened into pages of positioned text/rect shapes.
researchRoutes.get('/api/studio/research/projects/:id/decks/:deckId/preview', ctrl.previewDeck)
researchRoutes.get('/api/studio/research/projects/:id/compile/status', ctrl.compileStatus)
researchRoutes.post('/api/studio/research/projects/:id/compile', ctrl.compileProject)

// Zotero connection probe for the literature view
researchRoutes.get('/api/studio/research/zotero/status', ctrl.zoteroStatus)
researchRoutes.get('/api/studio/research/zotero/collections', ctrl.zoteroCollections)
researchRoutes.get('/api/studio/research/zotero/items', ctrl.zoteroItems)
researchRoutes.post('/api/studio/research/projects/:id/papers/import-zotero', ctrl.importZoteroPaper)
researchRoutes.post('/api/studio/research/projects/:id/bibliography/import-zotero', ctrl.importZoteroCollectionBib)

// Ledger-derived views for the record screen (assembled from stored records)
researchRoutes.get('/api/studio/research/ledger/worktree', ctrl.ledgerWorktree)
researchRoutes.get('/api/studio/research/venue-templates', ctrl.venueTemplatesHandler)
researchRoutes.post('/api/studio/research/moments/pin', ctrl.pinMomentHandler)
researchRoutes.post('/api/studio/research/eureka', ctrl.setEurekaHandler)
researchRoutes.get('/api/studio/research/eureka', ctrl.eurekaView)
researchRoutes.post('/api/studio/research/projects/:id/venue-template', ctrl.applyVenueTemplateHandler)
researchRoutes.delete('/api/studio/research/projects/:id/venue-template', ctrl.clearVenueTemplateHandler)
researchRoutes.post('/api/studio/research/wiki/import', ctrl.importWikiHandler)
researchRoutes.post('/api/studio/research/worktree/mainline', ctrl.setMainlineHandler)
researchRoutes.post('/api/studio/research/worktree/idea-parent', ctrl.setIdeaParentHandler)
researchRoutes.post('/api/studio/research/worktree/adopt', ctrl.adoptIdeaHandler)
researchRoutes.post('/api/studio/research/worktree/close', ctrl.closeIdeaHandler)
researchRoutes.get('/api/studio/research/projects/:id/artifact', ctrl.readArtifactHandler)
researchRoutes.get('/api/studio/research/ledger/foraging', ctrl.ledgerForaging)
researchRoutes.get('/api/studio/research/ledger/moments', ctrl.ledgerMoments)
researchRoutes.get('/api/studio/research/ledger/evidence', ctrl.ledgerEvidence)
researchRoutes.get('/api/studio/research/ledger/digest', ctrl.ledgerDigest)
researchRoutes.get('/api/studio/research/ledger/events', ctrl.ledgerEvents)

// Journal lines, declared evidence edges, paper PDF retrieval
researchRoutes.post('/api/studio/research/journal', ctrl.addJournalEntryHandler)
researchRoutes.post('/api/studio/research/evidence/edges', ctrl.addEvidenceEdgeHandler)
researchRoutes.post('/api/studio/research/evidence/edges/retract', ctrl.retractEvidenceEdgeHandler)
researchRoutes.post('/api/studio/research/projects/:id/papers/fetch-pdf', ctrl.fetchPaperPdfHandler)

// Remote machines and jobs
researchRoutes.post('/api/studio/research/items/servers/:id/check', ctrl.checkServer)
researchRoutes.post('/api/studio/research/items/servers/:id/jobs', ctrl.submitServerJob)
researchRoutes.post('/api/studio/research/items/jobs/:id/refresh', ctrl.refreshJob)

// Panel settings: image generation + web search (SearXNG)
researchRoutes.get('/api/studio/research/settings/image-gen', ctrl.imageGenConfigGet)
researchRoutes.post('/api/studio/research/settings/image-gen', ctrl.imageGenConfigSet)
researchRoutes.get('/api/studio/research/settings/sxng', ctrl.sxngConfigGet)
researchRoutes.post('/api/studio/research/settings/sxng', ctrl.sxngConfigSet)
researchRoutes.get('/api/studio/research/web/search', ctrl.webSearchHandler)

// Conference deadlines (ccfddl)
researchRoutes.get('/api/studio/research/venues/catalog', ctrl.venueCatalog)

researchRoutes.post('/api/studio/research/items/:collection', ctrl.createItem)
researchRoutes.patch('/api/studio/research/items/:collection/:id', ctrl.updateItem)
researchRoutes.delete('/api/studio/research/items/:collection/:id', ctrl.deleteItem)

// Paper intake: any PDF becomes a paper (upload → full text), plus metadata lookup
researchRoutes.post('/api/studio/research/papers/resolve', paperCtrl.resolvePaperMetadataHandler)
// Any PDF becomes a paper: record → store → extract, in one call
researchRoutes.post('/api/studio/research/papers/import-pdf', paperCtrl.importPaperPdfHandler)
researchRoutes.post('/api/studio/research/papers/:id/pdf', paperCtrl.uploadPaperPdf)
// One-shot body-text translation (the reader's "translate this page" + passage translate)
researchRoutes.post('/api/studio/research/papers/:id/translate', paperCtrl.translatePaperHandler)
// Whole-document translation that keeps the original layout (pdf2zh → *-dual.pdf)
researchRoutes.post('/api/studio/research/papers/:id/translate-pdf', paperCtrl.translatePaperPdfHandler)
researchRoutes.get('/api/studio/research/papers/:id/translate-status', paperCtrl.translatePaperStatusHandler)
researchRoutes.get('/api/studio/translation/health', paperCtrl.translationRuntimeHealthHandler)
researchRoutes.post('/api/studio/research/papers/:id/fulltext', paperCtrl.extractPaperFulltextHandler)
researchRoutes.get('/api/studio/research/papers/:id/fulltext', paperCtrl.readPaperFulltextHandler)
researchRoutes.post('/api/studio/research/papers/:id/summary', paperCtrl.summarizePaperHandler)
researchRoutes.post('/api/studio/research/papers/:id/ask', paperCtrl.askPaperHandler)
// Paper-level skills: full_read / passage_qa / figure_qa / concept
researchRoutes.post('/api/studio/research/papers/:id/skill', paperCtrl.runPaperSkillHandler)
// Cross-paper review over the current library
researchRoutes.post('/api/studio/research/review', paperCtrl.runLiteratureReviewHandler)
// Vision: look at a rendered page (figures, tables) with a multimodal model
researchRoutes.post('/api/studio/research/papers/:id/vision', paperCtrl.askPaperFigureHandler)
// Caption index parsed from the full text (no model involved)
researchRoutes.get('/api/studio/research/papers/:id/figures', paperCtrl.listPaperFiguresHandler)
// Tag + relevance proposal (read-only; the panel applies it after confirmation)
researchRoutes.post('/api/studio/research/papers/:id/suggest', paperCtrl.suggestPaperTagsHandler)

// Structured notes (blocks, reading template) and local library search
researchRoutes.get('/api/studio/research/papers/:id/notes', paperCtrl.readPaperNotesHandler)
researchRoutes.put('/api/studio/research/papers/:id/notes', paperCtrl.savePaperNotesHandler)
researchRoutes.post('/api/studio/research/papers/:id/notes/template', paperCtrl.applyReadingTemplateHandler)
researchRoutes.get('/api/studio/research/library/search', paperCtrl.searchLibraryHandler)
// Batch update with an undo payload; `items` mode also serves as the revert call.
researchRoutes.post('/api/studio/research/items/:collection/batch', paperCtrl.batchUpdateItemsHandler)

// PubMed search (medical literature; the arXiv feed alone cannot serve this panel)
researchRoutes.get('/api/studio/research/pubmed/search', paperCtrl.searchPubmedHandler)
