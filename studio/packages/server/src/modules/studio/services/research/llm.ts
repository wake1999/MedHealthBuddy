/**
 * One-shot text completion for research features (summary, paper Q&A).
 *
 * The research panel never carries provider credentials: the server resolves
 * the profile's default model plus its upstream URL and key, then makes a
 * single non-streaming call. Everything here is read-only against the profile
 * config; nothing is persisted.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { getActiveProfileName, getProfileDir } from '../../../hermes/services/profiles/profile'
import { buildModelGroups, PROVIDER_ENV_MAP, readConfigYamlForProfile, resolveModelBaseUrl } from '../../public/profile-config'
import { getCompatibleCustomProviders } from '../../contracts/provider-compat'

const TIMEOUT_MS = 120_000

export interface LlmTarget {
  baseUrl: string
  apiKey: string
  model: string
  provider: string
}

function parseEnv(raw: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (value) values.set(match[1], value)
  }
  return values
}

/** Find which provider owns the profile's default model. */
async function defaultProviderOf(profile: string): Promise<{ provider: string; model: string } | null> {
  let config: Record<string, any>
  try {
    config = await readConfigYamlForProfile(profile)
  } catch {
    return null
  }

  // `model.default` + `model.provider` is what the panel writes; prefer it.
  const directModel = String(config?.model?.default || '').trim()
  const directProvider = String(config?.model?.provider || '').trim()
  if (directModel && directProvider) return { provider: directProvider, model: directModel }

  // Fall back to the assembled groups for configs that only carry a model list.
  const groups = buildModelGroups(config)
  const model = String(groups?.default || directModel || '').trim()
  if (model === '') return null
  const owner = (groups.groups || []).find(group => (group.models || []).some(item => item.id === model))
  if (owner) return { provider: owner.provider, model }
  const only = (groups.groups || [])[0]
  return only ? { provider: only.provider, model } : null
}

/**
 * Resolve the upstream URL and credential for a model.
 * @param profile - research profile (defaults to the active one).
 * @param provider - explicit provider; omitted means "the default model's owner".
 * @param model - explicit model; omitted means the profile default.
 */
export async function resolveLlmTarget(
  profile?: string,
  provider?: string,
  model?: string,
): Promise<LlmTarget | null> {
  const name = (profile || getActiveProfileName() || 'default').trim()
  let providerKey = String(provider || '').trim()
  let modelId = String(model || '').trim()
  if (providerKey === '' || modelId === '') {
    const fallback = await defaultProviderOf(name)
    if (!fallback) return null
    providerKey = providerKey || fallback.provider
    modelId = modelId || fallback.model
  }

  let env: Map<string, string>
  try {
    env = parseEnv(await readFile(path.join(getProfileDir(name), '.env'), 'utf-8'))
  } catch {
    env = new Map()
  }

  const envMapping = PROVIDER_ENV_MAP[providerKey]
  if (envMapping) {
    const baseUrl = (resolveModelBaseUrl(name, providerKey, modelId) || '').trim().replace(/\/+$/, '')
    const apiKey = envMapping.api_key_env ? env.get(envMapping.api_key_env) || '' : ''
    return baseUrl && apiKey ? { baseUrl, apiKey, model: modelId, provider: providerKey } : null
  }

  let config: Record<string, any>
  try {
    config = await readConfigYamlForProfile(name)
  } catch {
    return null
  }
  const custom = getCompatibleCustomProviders(config).find(entry =>
    entry.provider_key === providerKey || entry.name === providerKey)
  if (!custom) return null
  const apiKey = custom.key_env ? env.get(custom.key_env) || '' : String((custom as any).api_key || '')
  const baseUrl = String(custom.base_url || '').trim().replace(/\/+$/, '')
  return baseUrl && apiKey ? { baseUrl, apiKey, model: modelId, provider: providerKey } : null
}

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant'
  /** A plain string for text-only turns; parts when images ride along. */
  content: string | ChatContentPart[]
}

/**
 * Pick a model that can actually see images.
 *
 * The panel's default model is text-only (deepseek-flash answers a vision
 * request with an empty body), so `figure_qa` cannot use it. Resolution order:
 * an explicit `vision:` block in config.yaml, then the first custom model whose
 * name looks multimodal.
 * @param profile - research profile.
 */
export async function resolveVisionTarget(profile?: string): Promise<LlmTarget | null> {
  const name = (profile || getActiveProfileName() || 'default').trim()
  let config: Record<string, any>
  try {
    config = await readConfigYamlForProfile(name)
  } catch {
    return null
  }

  const explicitProvider = String(config?.vision?.provider || '').trim()
  const explicitModel = String(config?.vision?.model || '').trim()
  if (explicitProvider !== '') {
    return resolveLlmTarget(profile, explicitProvider, explicitModel || undefined)
  }

  // The profile default is tried first: the panel's own model (deepseek-flash)
  // accepts image parts, so a normal setup needs no extra configuration. If it
  // turns out to be text-only the call comes back empty and the caller reports
  // it, which is clearer than silently switching models behind the user's back.
  const fallback = await defaultProviderOf(name)
  if (fallback) {
    const direct = await resolveLlmTarget(profile, fallback.provider, fallback.model)
    if (direct) return direct
  }

  /** `models` may be a list, a map keyed by model id, or absent with `model` set. */
  const modelsOf = (entry: any): string[] => {
    const out: string[] = []
    const push = (value: unknown): void => {
      const id = String(
        typeof value === 'string' ? value : (value as any)?.id || (value as any)?.name || '',
      ).trim()
      if (id !== '' && !out.includes(id)) out.push(id)
    }
    const models = entry?.models
    if (Array.isArray(models)) models.forEach(push)
    else if (models && typeof models === 'object') Object.keys(models).forEach(push)
    push(entry?.model)
    return out
  }

  const candidates: Array<{ provider: string; model: string; score: number }> = []
  for (const entry of getCompatibleCustomProviders(config) as any[]) {
    const providerKey = String(entry.provider_key || entry.name || '').trim()
    if (providerKey === '') continue
    for (const id of modelsOf(entry)) {
      const score = /(^|[-_/])vl([-_/. ]|$)/i.test(id) ? 3
        : /vision|omni|4v/i.test(id) ? 3
          : /qwen|glm|gpt-4/i.test(id) ? 2
            : 0
      if (score > 0) candidates.push({ provider: providerKey, model: id, score })
    }
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.score - a.score)
  return resolveLlmTarget(profile, candidates[0].provider, candidates[0].model)
}

/** A reasoning model spends `max_tokens` on thinking first, so leave headroom. */
const DEFAULT_MAX_TOKENS = 2400
/** One retry at this ceiling when the first attempt ran out of budget. */
const RETRY_MAX_TOKENS = 8000

interface ChatAttempt {
  content: string
  finishReason: string
}

/** One non-streaming POST, keeping the finish reason so callers can retry. */
async function requestOnce(
  target: LlmTarget,
  messages: ChatTurn[],
  options: { temperature?: number; maxTokens?: number } = {},
): Promise<ChatAttempt> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(`${target.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.apiKey}` },
      body: JSON.stringify({
        model: target.model,
        temperature: options.temperature ?? 0.3,
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        stream: false,
        messages,
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`upstream_${response.status}: ${detail.slice(0, 200)}`)
    }
    const payload: any = await response.json()
    const choice = payload?.choices?.[0] ?? {}
    return {
      content: String(choice?.message?.content ?? '').trim(),
      finishReason: String(choice?.finish_reason ?? ''),
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One non-streaming POST, retried once when the budget ran out mid-thought.
 *
 * `deepseek-flash` is a reasoning model: with a small `max_tokens` it spends the
 * whole budget on `reasoning_tokens` and returns `finish_reason: "length"` with
 * an empty `content`. Doubling the ceiling once turns those empty answers into
 * real ones instead of surfacing "模型没有返回回答".
 */
async function postChat(
  target: LlmTarget,
  messages: ChatTurn[],
  options: { temperature?: number; maxTokens?: number } = {},
): Promise<string> {
  const first = await requestOnce(target, messages, options)
  if (first.content !== '' || first.finishReason !== 'length') return first.content

  const used = options.maxTokens ?? DEFAULT_MAX_TOKENS
  if (used >= RETRY_MAX_TOKENS) return first.content
  const retried = await requestOnce(target, messages, {
    ...options,
    maxTokens: Math.min(used * 2, RETRY_MAX_TOKENS),
  })
  return retried.content
}

/**
 * Single non-streaming completion.
 * @param target - resolved upstream + credential.
 * @param messages - conversation to send.
 * @param options - temperature and output cap.
 */
export async function completeText(
  target: LlmTarget,
  messages: ChatTurn[],
  options: { temperature?: number; maxTokens?: number } = {},
): Promise<string> {
  return postChat(target, messages, options)
}

/**
 * Ask about one or more images (a rendered PDF page, a cropped figure).
 * @param target - a vision-capable target from {@link resolveVisionTarget}.
 * @param prompt - what to answer about the images.
 * @param imagesBase64 - PNG payloads, with or without the `data:` prefix.
 * @param options - temperature and output cap.
 */
export async function completeVision(
  target: LlmTarget,
  prompt: string,
  imagesBase64: readonly string[],
  options: { temperature?: number; maxTokens?: number } = {},
): Promise<string> {
  const parts: ChatContentPart[] = [{ type: 'text', text: prompt }]
  for (const image of imagesBase64) {
    const url = image.startsWith('data:') ? image : `data:image/png;base64,${image}`
    parts.push({ type: 'image_url', image_url: { url } })
  }
  return postChat(target, [{ role: 'user', content: parts }], options)
}
