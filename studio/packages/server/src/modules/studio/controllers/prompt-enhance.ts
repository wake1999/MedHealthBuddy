import { readFile } from 'fs/promises'
import { join } from 'path'
import { getActiveProfileName, getProfileDir } from '../../hermes/services/profiles/profile'
import { PROVIDER_ENV_MAP, readConfigYamlForProfile, resolveModelBaseUrl } from '../public/profile-config'
import { getCompatibleCustomProviders } from '../contracts/provider-compat'

/** 改写用的系统提示词：只做结构补全，不引入任何业务上下文。 */
const SYSTEM_PROMPT = [
  '你是提示词优化助手。用户给一句口语化需求，你把它改写成一条结构化、可直接执行的中文提示词。',
  '',
  '步骤：',
  '1. 先判断主题属于哪个领域（母婴食品、消费电子、软件工具、医疗健康、日常生活等）。',
  '2. 只使用该领域真正相关的分析维度；禁止把其他领域的参数硬套进来（例如奶粉没有「容量 / 续航 / 充电速度」）。',
  '3. 用户没提到的信息不要编造，不确定的点不要写成确定值。',
  '',
  '输出：只输出改写后的提示词正文，中文，一段话 2-4 句；不解释、不加引号、不寒暄。',
  '',
  '示例：',
  '用户：帮我对比启赋未来pro和至熠',
  '输出：请对比启赋未来pro与至熠两款奶粉，从配方成分、核心营养特点、适用月龄段、奶源与产地、价格区间、优缺点及适用人群等维度横向分析，并针对不同需求给出选购建议与总结。',
].join('\n')

interface EnhanceTarget {
  baseUrl: string
  apiKey: string
  model: string
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

function trimBase(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

/**
 * 按 profile + provider + model 找到「上游地址 + 密钥」。
 * 内置 provider 从 .env 里读 `*_API_KEY`，自定义 provider 从 config.yaml 里读。
 */
async function resolveTarget(profile: string, provider: string, model: string): Promise<EnhanceTarget | null> {
  const dir = getProfileDir(profile)
  let env: Map<string, string>
  try {
    env = parseEnv(await readFile(join(dir, '.env'), 'utf-8'))
  } catch {
    env = new Map()
  }

  const envMapping = PROVIDER_ENV_MAP[provider]
  if (envMapping) {
    const baseUrl = resolveModelBaseUrl(profile, provider, model) || ''
    const apiKey = envMapping.api_key_env ? env.get(envMapping.api_key_env) || '' : ''
    return baseUrl && apiKey ? { baseUrl: trimBase(baseUrl), apiKey, model } : null
  }

  let config: Record<string, any>
  try {
    config = await readConfigYamlForProfile(profile)
  } catch {
    return null
  }
  const custom = getCompatibleCustomProviders(config).find(entry =>
    entry.provider_key === provider || entry.name === provider)
  if (!custom) return null
  const apiKey = custom.key_env ? env.get(custom.key_env) || '' : String((custom as any).api_key || '')
  const baseUrl = trimBase(String(custom.base_url || ''))
  return baseUrl && apiKey ? { baseUrl, apiKey, model } : null
}

/**
 * POST `/api/studio/prompt/enhance`
 *
 * 用当前会话自己的模型把草稿改写成结构化提示词。走 Studio 的 provider 配置，
 * 不经过任何业务应用，避免把行业上下文混进通用改写。
 */
export async function enhance(ctx: any) {
  const body = ctx.request?.body ?? {}
  const text = String(body.text ?? '').trim()
  const provider = String(body.provider ?? '').trim()
  const model = String(body.model ?? '').trim()
  const profile = String(body.profile ?? '').trim() || getActiveProfileName()

  if (!text) {
    ctx.status = 400
    ctx.body = { error: 'text is required' }
    return
  }
  if (!provider || !model) {
    ctx.status = 400
    ctx.body = { error: 'provider and model are required' }
    return
  }

  let target: EnhanceTarget | null
  try {
    target = await resolveTarget(profile, provider, model)
  } catch (error: any) {
    ctx.status = 502
    ctx.body = { error: error?.message || 'failed to resolve provider' }
    return
  }
  if (!target) {
    ctx.status = 422
    ctx.body = { error: `provider "${provider}" has no usable base url or credential` }
    return
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60000)
  try {
    const res = await fetch(`${target.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.apiKey}` },
      body: JSON.stringify({
        model: target.model,
        temperature: 0.4,
        stream: false,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      ctx.status = 502
      ctx.body = { error: `upstream ${res.status}: ${detail.slice(0, 300)}` }
      return
    }
    const payload: any = await res.json()
    const content = String(payload?.choices?.[0]?.message?.content ?? '').trim()
    if (!content) {
      ctx.status = 502
      ctx.body = { error: 'empty completion' }
      return
    }
    ctx.status = 200
    ctx.body = { text: content }
  } catch (error: any) {
    ctx.status = 502
    ctx.body = { error: error?.name === 'AbortError' ? 'timeout' : (error?.message || 'request failed') }
  } finally {
    clearTimeout(timer)
  }
}
