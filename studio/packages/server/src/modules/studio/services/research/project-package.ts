import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import AdmZip from 'adm-zip'
import {
  readStore,
  researchRoot,
  updateStore,
  type ResearchStore,
} from './store'

const PACKAGE_SCHEMA = 'mhb.project-package.v1'
const PROJECT_ID = /^[A-Za-z0-9_-]{1,80}$/

interface PackageFile {
  path: string
  sha256: string
  size: number
}

interface ProjectPackageManifest {
  schema: string
  createdAt: string
  projectId: string
  title: string
  app: string
  files: PackageFile[]
  counts: Record<string, number>
  warnings: string[]
}

interface ProjectPackageState {
  schema: string
  project: unknown
  collections: Record<string, unknown[]>
  artifactFiles: Record<string, string>
  rawMergeFiles: Record<string, string>
}

const PROJECT_COLLECTIONS = [
  'papers',
  'folders',
  'experiments',
  'figures',
  'ideas',
  'decks',
  'journal',
  'evidence',
  'runs',
  'flows',
] as const

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

function projectDir(profile: string | undefined, projectId: string): string {
  return path.join(researchRoot(profile), 'projects', projectId)
}

async function listFiles(root: string, current = ''): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, current), { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const relative = current === '' ? entry.name : `${current}/${entry.name}`
    if (entry.isDirectory()) files.push(...await listFiles(root, relative))
    else if (entry.isFile()) files.push(relative)
  }
  return files
}

function portableRun(run: any): any {
  const next = JSON.parse(JSON.stringify(run))
  next.artifacts = (next.artifacts || []).map((artifact: any) => ({
    ...artifact,
    file: '',
  }))
  next.merges = (next.merges || []).map((merge: any) => ({
    ...merge,
    rawMerge: merge.rawMerge ? { ...merge.rawMerge, file: '' } : null,
  }))
  return next
}

function projectCollection(store: ResearchStore, projectId: string): Record<string, unknown[]> {
  const collections: Record<string, unknown[]> = {}
  for (const key of PROJECT_COLLECTIONS) {
    collections[key] = (store[key] as unknown[])
      .filter(row => (row as { projectId?: string }).projectId === projectId)
  }
  return collections
}

export async function exportProjectPackage(
  profile: string,
  projectId: string,
): Promise<{ buffer: Buffer; filename: string; manifest: ProjectPackageManifest }> {
  if (!PROJECT_ID.test(projectId)) throw new Error('invalid_project_id')
  const store = await readStore(profile)
  const project = store.projects.find(row => row.id === projectId)
  if (!project) throw new Error('research_project_not_found')
  const root = projectDir(profile, projectId)
  const warnings: string[] = []
  const files: string[] = []
  try {
    files.push(...await listFiles(root))
  } catch {
    warnings.push('Project directory does not exist; exporting metadata only.')
  }

  const collections = projectCollection(store, projectId)
  const runs = (collections.runs || []) as any[]
  const portableRuns = runs.map(portableRun)
  const artifactFiles: Record<string, string> = {}
  const rawMergeFiles: Record<string, string> = {}
  for (const run of runs) {
    for (const artifact of run.artifacts || []) {
      const relative = path.relative(root, artifact.file)
      if (relative && !relative.startsWith('..') && path.isAbsolute(artifact.file)) {
        artifactFiles[artifact.id] = relative.replaceAll('\\', '/')
      } else {
        warnings.push(`Artifact ${artifact.id} is outside the project directory and was not portable.`)
      }
    }
    for (const merge of run.merges || []) {
      if (merge.rawMerge?.file) {
        const relative = path.relative(root, merge.rawMerge.file)
        if (relative && !relative.startsWith('..') && path.isAbsolute(merge.rawMerge.file)) {
          rawMergeFiles[merge.id] = relative.replaceAll('\\', '/')
        }
      }
    }
  }

  const packageFiles: PackageFile[] = []
  const zip = new AdmZip()
  for (const relative of files) {
    const absolute = path.join(root, relative)
    const content = await fs.readFile(absolute)
    packageFiles.push({ path: relative, sha256: sha256(content), size: content.length })
    zip.addFile(`files/${relative}`, content)
  }
  const state: ProjectPackageState = {
    schema: PACKAGE_SCHEMA,
    project,
    collections: { ...collections, runs: portableRuns },
    artifactFiles,
    rawMergeFiles,
  }
  const manifest: ProjectPackageManifest = {
    schema: PACKAGE_SCHEMA,
    createdAt: new Date().toISOString(),
    projectId,
    title: project.title,
    app: 'medhealthbuddy-research',
    files: packageFiles,
    counts: Object.fromEntries(Object.entries(collections).map(([key, rows]) => [key, rows.length])),
    warnings,
  }
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)))
  zip.addFile('state.json', Buffer.from(JSON.stringify(state, null, 2)))
  const safeTitle = project.title.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80) || projectId
  return { buffer: zip.toBuffer(), filename: `${safeTitle}-${projectId}.mhb.zip`, manifest }
}

function safeArchivePath(value: string): string {
  const normalized = value.replaceAll('\\', '/')
  if (normalized.startsWith('/') || normalized.includes('../') || normalized.includes('..\\')) {
    throw new Error('research_package_unsafe_path')
  }
  return normalized
}

export async function importProjectPackage(
  profile: string,
  buffer: Buffer,
): Promise<{ projectId: string; title: string; files: number; counts: Record<string, number>; warnings: string[] }> {
  let zip: AdmZip
  try {
    zip = new AdmZip(buffer)
  } catch {
    throw new Error('research_package_invalid_zip')
  }
  const manifestEntry = zip.getEntry('manifest.json')
  const stateEntry = zip.getEntry('state.json')
  if (!manifestEntry || !stateEntry) throw new Error('research_package_missing_manifest')
  let manifest: ProjectPackageManifest
  let state: ProjectPackageState
  try {
    manifest = JSON.parse(manifestEntry.getData().toString('utf-8')) as ProjectPackageManifest
    state = JSON.parse(stateEntry.getData().toString('utf-8')) as ProjectPackageState
  } catch {
    throw new Error('research_package_invalid_json')
  }
  if (manifest.schema !== PACKAGE_SCHEMA || state.schema !== PACKAGE_SCHEMA) {
    throw new Error('research_package_schema_mismatch')
  }
  if (!PROJECT_ID.test(manifest.projectId)) throw new Error('invalid_project_id')
  if (!state.project || (state.project as { id?: string }).id !== manifest.projectId) {
    throw new Error('research_package_project_mismatch')
  }
  const store = await readStore(profile)
  if (store.projects.some(project => project.id === manifest.projectId)) {
    throw new Error('research_package_project_exists')
  }
  const fileEntries = new Map(zip.getEntries().map(entry => [entry.entryName.replaceAll('\\', '/'), entry]))
  for (const file of manifest.files) {
    const safe = safeArchivePath(file.path)
    const entry = fileEntries.get(`files/${safe}`)
    if (!entry) throw new Error(`research_package_file_missing:${safe}`)
    const content = entry.getData()
    if (content.length !== file.size || sha256(content) !== file.sha256) {
      throw new Error(`research_package_hash_mismatch:${safe}`)
    }
  }
  for (const key of Object.keys(state.collections)) {
    if (!PROJECT_COLLECTIONS.includes(key as typeof PROJECT_COLLECTIONS[number])) {
      throw new Error(`research_package_unknown_collection:${key}`)
    }
  }

  const root = projectDir(profile, manifest.projectId)
  await fs.mkdir(root, { recursive: true })
  let written = 0
  for (const file of manifest.files) {
    const safe = safeArchivePath(file.path)
    const entry = fileEntries.get(`files/${safe}`)
    if (!entry) continue
    const target = path.join(root, safe)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, entry.getData())
    written += 1
  }

  const collections = state.collections
  for (const key of Object.keys(collections)) {
    const incoming = collections[key] as Array<{ id?: string; projectId?: string }>
    if (incoming.some(row => row.projectId !== undefined && row.projectId !== manifest.projectId)) {
      throw new Error(`research_package_collection_project_mismatch:${key}`)
    }
    const current = store[key as keyof ResearchStore] as unknown as Array<{ id?: string }>
    const ids = new Set(current.map(row => row.id))
    for (const row of incoming) {
      if (row.id && ids.has(row.id)) throw new Error(`research_package_id_collision:${key}:${row.id}`)
    }
  }

  const restoredRuns = (collections.runs || []) as any[]
  for (const run of restoredRuns) {
    for (const artifact of run.artifacts || []) {
      const relative = state.artifactFiles[artifact.id]
      if (relative) artifact.file = path.join(root, safeArchivePath(relative))
    }
    for (const merge of run.merges || []) {
      const relative = state.rawMergeFiles[merge.id]
      if (relative && merge.rawMerge) merge.rawMerge.file = path.join(root, safeArchivePath(relative))
    }
  }

  const restored = await updateStore(profile, 'research.project.imported', draft => {
    if (draft.projects.some(project => project.id === manifest.projectId)) {
      throw new Error('research_package_project_exists')
    }
    draft.projects.push(state.project as ResearchStore['projects'][number])
    for (const key of Object.keys(collections)) {
      const target = draft[key as keyof ResearchStore] as unknown as unknown[]
      target.push(...(collections[key] as unknown[]))
    }
    return draft
  }, { actor: { kind: 'user', id: 'workbench' }, action: 'research.project.imported' })
  return {
    projectId: manifest.projectId,
    title: manifest.title,
    files: written,
    counts: manifest.counts,
    warnings: manifest.warnings,
  }
}

export async function getProjectExportInfo(profile: string, projectId: string): Promise<{
  projectId: string
  title: string
  runs: number
  artifacts: number
  files: number
}> {
  const store = await readStore(profile)
  const project = store.projects.find(row => row.id === projectId)
  if (!project) throw new Error('research_project_not_found')
  const runs = store.runs.filter(row => row.projectId === projectId)
  let files = 0
  try {
    files = (await listFiles(projectDir(profile, projectId))).length
  } catch {
    files = 0
  }
  return {
    projectId,
    title: project.title,
    runs: runs.length,
    artifacts: runs.reduce((sum, run) => sum + run.artifacts.length, 0),
    files,
  }
}
