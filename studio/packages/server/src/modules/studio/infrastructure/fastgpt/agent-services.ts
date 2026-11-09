import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * BTIT agents that expose their own HTTP chat service.
 *
 * Endpoints are public routing data. Service keys are read at runtime from a
 * locally managed JSON file (or STUDIO_AGENT_SERVICE_KEYS_FILE) so they never
 * enter the client bundle or Git history.
 */
export interface AgentServiceConfig {
  appId: string
  slug: string
  endpoint: string
  key: string
}

const AGENT_SERVICE_SLUGS: Record<string, string> = {
  '6a9fcb10346bb4e43a8de666': 'file-download',
  '6a9f890d4462925b788de668': 'collect-file',
  '6a9f890d4462925b788de667': 'collect-record',
  '6a9fcb10346bb4e43a8de667': 'signal-parse',
  '6aa0c9714949d182eb8de667': 'ontology-compose',
  '6aa0c9714949d182eb8de666': 'metadata-compose',
  '6a9fbda643ba3da4fa8de667': 'file-algorithm-link',
  '6a9fcb10346bb4e43a8de668': 'quality-check',
  '6aa0dc9b91b8c1cf048de667': 'metric-report',
  '6a9fbda643ba3da4fa8de666': 'pipeline-schedule',
  '6a9f890d4462925b788de666': 'auth-token',
  '6aa3a50056f8e51cf88de666': 'llm-assistant',
  '69b7587d330e92f004b3f7b5': 'subject-mining',
  '69a987978b217b5660504fee': 'plan-generate',
}

const SERVICE_BASE_URL = 'http://36.140.151.191:5090/api/services'

function serviceKeysFile(): string {
  const configured = String(process.env.STUDIO_AGENT_SERVICE_KEYS_FILE || '').trim()
  if (configured) return configured
  const stateDir = String(
    process.env.HERMES_WEBUI_STATE_DIR
      || process.env.HERMES_WEB_UI_HOME
      || join(process.cwd(), 'data', 'hermes-web-ui'),
  ).trim()
  return join(stateDir, 'agent-service-keys.json')
}

function readServiceKeys(): Record<string, string> {
  const path = serviceKeysFile()
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter(([key, value]) => Boolean(key.trim()) && typeof value === 'string' && value.trim())
        .map(([key, value]) => [key.trim(), String(value).trim()]),
    )
  } catch {
    return {}
  }
}

export function agentServiceSlug(appId: string): string | null {
  return AGENT_SERVICE_SLUGS[appId] ?? null
}

export function agentServiceChatPageUrl(appId: string): string | null {
  const slug = agentServiceSlug(appId)
  if (!slug) return null
  const webBase = SERVICE_BASE_URL.replace(/\/api\/services\/?$/, '')
  return `${webBase}/chat.html?agent=${encodeURIComponent(slug)}`
}

export function agentServiceFor(appId: string): AgentServiceConfig | null {
  const slug = AGENT_SERVICE_SLUGS[appId]
  if (!slug) return null
  const key = readServiceKeys()[appId]
  if (!key) return null
  return {
    appId,
    slug,
    endpoint: `${SERVICE_BASE_URL}/${slug}/chat`,
    key,
  }
}

export function isAgentServiceConfigured(appId: string): boolean {
  return Boolean(agentServiceFor(appId))
}
