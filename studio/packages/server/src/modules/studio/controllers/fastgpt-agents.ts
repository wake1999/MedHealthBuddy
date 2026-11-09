import {
  FASTGPT_AGENT_SEEDS,
  FASTGPT_CHAT_APP_ID,
  fastGptAgentView,
  fastGptApiKey,
  fastGptBaseUrl,
  fastGptSceneForName,
  fastGptShortName,
  fetchFastGptAppList,
  type FastGptAgentSeed,
  type FastGptRemoteApp,
} from '../infrastructure/fastgpt/agent-catalog'
import { agentServiceFor, type AgentServiceConfig } from '../infrastructure/fastgpt/agent-services'

/**
 * 首页场景下的 FastGPT 智能体卡片。
 *
 * GET `/api/studio/fastgpt-agents?app=btit` → `{ baseUrl, source, agents[] }`。
 * 读接口不做鉴权、失败也不抛 500：卡片是增量入口，拿不到就少个入口，不该拖垮对话框。
 */

/** 实时列表命中的场景，与内置清单合并成同一形状。 */
function mergeRemote(remote: readonly FastGptRemoteApp[]): FastGptAgentSeed[] {
  const seeds = new Map(FASTGPT_AGENT_SEEDS.map(seed => [seed.appId, seed]))
  const out: FastGptAgentSeed[] = []
  for (const app of remote) {
    const sceneId = fastGptSceneForName(app.name)
    if (!sceneId) continue
    const seed = seeds.get(app.appId)
    const name = app.name.trim() || seed?.name || app.appId
    out.push({
      appId: app.appId,
      sceneId,
      name,
      short: seed?.short ?? fastGptShortName(name),
      desc: app.intro.trim() || seed?.desc || '',
      shareId: seed?.shareId,
    })
  }
  return out
}

export async function list(ctx: any) {
  try {
    const appId = String(ctx.query?.app ?? FASTGPT_CHAT_APP_ID).trim() || FASTGPT_CHAT_APP_ID
    const baseUrl = fastGptBaseUrl()

    let seeds: FastGptAgentSeed[] = [...FASTGPT_AGENT_SEEDS]
    let source = 'builtin'

    if (appId === FASTGPT_CHAT_APP_ID) {
      const remote = await fetchFastGptAppList(baseUrl, fastGptApiKey())
      if (remote.length > 0) {
        const merged = mergeRemote(remote)
        if (merged.length > 0) {
          seeds = merged
          source = 'fastgpt'
        }
      }
    }

    ctx.status = 200
    ctx.body = {
      baseUrl,
      source,
      agents: seeds.map(seed => fastGptAgentView(seed, baseUrl)),
    }
  } catch (error: any) {
    ctx.status = 200
    ctx.body = { baseUrl: fastGptBaseUrl(), source: 'error', agents: [], error: error?.message || 'fastgpt agents unavailable' }
  }
}

/** 变量定义缓存：分享页元数据一天也不会变几次，避免每次点卡片都打一次上游。 */
const agentConfigCache = new Map<string, { at: number; data: any }>()
const AGENT_CONFIG_TTL = 5 * 60 * 1000

/**
 * GET `/api/studio/fastgpt-agents/config?appId=...`
 *
 * 智能体运行时需要哪些变量（record_id / domain …）。走分享页的 `outLink/init`
 * 读 chatConfig，不需要任何凭据；拿不到就回空数组，前端按「无变量」处理。
 */
export async function config(ctx: any) {
  const appId = String(ctx.query?.appId ?? '').trim()
  const cached = agentConfigCache.get(appId)
  if (cached && Date.now() - cached.at < AGENT_CONFIG_TTL) {
    ctx.status = 200
    ctx.body = cached.data
    return
  }

  const seed = FASTGPT_AGENT_SEEDS.find(item => item.appId === appId)
  if (!seed?.shareId) {
    ctx.status = 200
    ctx.body = { variables: [] }
    return
  }

  const authData = JSON.stringify({ shareId: seed.shareId, outLinkUid: 'studio-config-probe' })
  const url = `${fastGptBaseUrl()}/api/core/chat/outLink/init?chatId=cfg-${Date.now()}&outLinkAuthData=${encodeURIComponent(authData)}`
  try {
    const res = await fetch(url)
    const json: any = await res.json()
    const raw = json?.data?.app?.chatConfig?.variables
    const variables = Array.isArray(raw)
      ? raw.map((item: any) => ({
          key: String(item?.key ?? ''),
          label: String(item?.label ?? item?.key ?? ''),
          required: Boolean(item?.required),
          description: String(item?.description ?? ''),
          defaultValue: String(item?.defaultValue ?? ''),
        })).filter((item: any) => item.key)
      : []
    const data = { variables }
    agentConfigCache.set(appId, { at: Date.now(), data })
    ctx.status = 200
    ctx.body = data
  } catch {
    ctx.status = 200
    ctx.body = { variables: [] }
  }
}

/** 一条要发给 FastGPT 的对话消息（只带角色与文本，旧版本也认）。 */
interface ChatTurnInput {
  role: string
  content: string
}

/** Per-session conversation ids returned by the BTIT service gateway. */
const serviceConversationIds = new Map<string, number>()

function serviceReplyText(payload: any): string {
  if (typeof payload?.reply === 'string') return payload.reply
  if (typeof payload?.message?.content === 'string') return payload.message.content
  if (typeof payload?.content === 'string') return payload.content
  return ''
}

async function chatViaAgentService(
  ctx: any,
  service: AgentServiceConfig,
  messages: ChatTurnInput[],
  body: any,
): Promise<void> {
  const message = [...messages].reverse().find(item => item.role === 'user')?.content || messages[messages.length - 1].content
  const conversationKey = String(body.chatId || '').trim() || `studio-${service.appId}-${Date.now()}`
  const conversationId = serviceConversationIds.get(conversationKey)
  const variables = body.variables && typeof body.variables === 'object' ? body.variables : {}

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 180000)
  const res = ctx.res
  ctx.respond = false
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  let closed = false
  res.on('close', () => {
    closed = true
    abort.abort()
  })
  const send = (payload: unknown) => {
    if (!closed) res.write(`data: ${JSON.stringify(payload)}\n\n`)
  }

  try {
    const upstream = await fetch(service.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${service.key}`,
      },
      body: JSON.stringify({
        message,
        ...(conversationId !== undefined ? { conversationId } : {}),
        variables,
        metadata: { source: 'studio', appId: service.appId },
      }),
      signal: abort.signal,
    })
    const raw = await upstream.text()
    if (!upstream.ok) {
      let detail = raw
      try { detail = JSON.parse(raw)?.detail || raw } catch { /* plain text */ }
      send({ error: `${service.slug} error ${upstream.status}: ${String(detail).slice(0, 300)}` })
      return
    }
    let payload: any = null
    try { payload = JSON.parse(raw) } catch { /* keep null */ }
    const reply = serviceReplyText(payload)
    if (!reply.trim()) {
      send({ error: `${service.slug} returned an empty reply` })
      return
    }
    const nextConversation = payload?.conversation?.id ?? payload?.conversationId
    const numericConversation = Number(nextConversation)
    if (Number.isFinite(numericConversation)) {
      serviceConversationIds.set(conversationKey, numericConversation)
    }
    send({ delta: reply })
  } catch (error: any) {
    send({ error: `${service.slug} unreachable: ${error?.message || 'unknown'}` })
  } finally {
    clearTimeout(timer)
    if (!closed) {
      send({ done: true })
      res.end()
    }
  }
}

/**
 * POST `/api/studio/fastgpt-agents/chat`
 *
 * 在 Studio 会话里直接跟某个智能体对话。BTIT 5090 服务返回普通 JSON，
 * 这里统一转换成客户端已有的 SSE `{delta}` 协议；没有配置服务的应用继续
 * 走原来的 FastGPT `/api/v2/chat/completions`。
 *
 * 服务密钥只在服务端读取，浏览器永远拿不到。
 */
export async function chat(ctx: any) {
  const body = ctx.request?.body ?? {}
  const appId = String(body.appId ?? '').trim()
  const messages: ChatTurnInput[] = Array.isArray(body.messages)
    ? body.messages
        .map((item: any) => ({ role: String(item?.role ?? 'user'), content: String(item?.content ?? '') }))
        .filter((item: ChatTurnInput) => item.content.trim().length > 0)
    : []
  if (!appId || messages.length === 0) {
    ctx.status = 400
    ctx.body = { error: 'appId and messages are required' }
    return
  }

  const service = agentServiceFor(appId)
  if (service) {
    await chatViaAgentService(ctx, service, messages, body)
    return
  }

  const apiKey = fastGptApiKey()
  if (!apiKey) {
    ctx.status = 503
    ctx.body = { error: 'FASTGPT_API_KEY is not configured' }
    return
  }

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 180000)
  const chatId = String(body.chatId ?? '').trim() || `studio-${Date.now()}`

  let upstream: any
  try {
    upstream = await fetch(`${fastGptBaseUrl()}/api/v2/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        appId,
        chatId,
        stream: true,
        detail: false,
        variables: body.variables && typeof body.variables === 'object' ? body.variables : {},
        messages: messages.map(item => ({ role: item.role, content: item.content })),
      }),
      signal: abort.signal,
    })
  } catch (error: any) {
    clearTimeout(timer)
    ctx.status = 502
    ctx.body = { error: `fastgpt unreachable: ${error?.message || 'unknown'}` }
    return
  }

  if (!upstream.ok || !upstream.body) {
    clearTimeout(timer)
    const detail = await upstream.text().catch(() => '')
    ctx.status = 502
    ctx.body = { error: `fastgpt error ${upstream.status}: ${String(detail).slice(0, 300)}` }
    return
  }

  const res = ctx.res
  ctx.respond = false
  ctx.status = 200
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  let closed = false
  res.on('close', () => {
    closed = true
    abort.abort()
  })

  const send = (payload: unknown) => {
    if (!closed) res.write(`data: ${JSON.stringify(payload)}\n\n`)
  }

  const decoder = new TextDecoder()
  let buffer = ''
  const handleEvent = (raw: string) => {
    let event = 'message'
    const dataLines: string[] = []
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
    }
    if (dataLines.length === 0) return
    const data = dataLines.join('\n')
    if (!data || data === '[DONE]') return
    let parsed: any
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    // 上游有两种形状：带 `event: answer` 的具名事件，以及不带 event 行的裸
    // `data:`（OpenAI 兼容格式）。两种都按 choices[0].delta.content 取文本。
    const delta = parsed?.choices?.[0]?.delta?.content
    if (typeof delta === 'string' && delta) {
      send({ delta })
      return
    }
    if (event === 'error' || parsed?.error) {
      const detail = parsed?.message ?? parsed?.statusText ?? parsed?.error?.message
      send({ error: String(detail ?? 'fastgpt error') })
    }
  }

  try {
    for await (const chunk of upstream.body as any) {
      if (closed) break
      buffer += decoder.decode(chunk, { stream: true })
      // FastGPT（Node 侧）用 CRLF 分隔事件，先归一成 LF，否则永远找不到帧边界。
      if (buffer.indexOf('\r') >= 0) buffer = buffer.replace(/\r\n/g, '\n')
      let index = buffer.indexOf('\n\n')
      while (index >= 0) {
        handleEvent(buffer.slice(0, index))
        buffer = buffer.slice(index + 2)
        index = buffer.indexOf('\n\n')
      }
    }
  } catch (error: any) {
    send({ error: error?.message || 'fastgpt stream failed' })
  } finally {
    clearTimeout(timer)
    if (!closed) {
      send({ done: true })
      res.end()
    }
  }
}
