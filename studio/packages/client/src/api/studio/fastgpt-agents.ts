import { request, requestStream } from '@/api/client'

/**
 * 内嵌地址：FastGPT 本体对页面发 `X-Frame-Options: DENY`，宿主机上跑了一个只去掉
 * 该响应头的小反代（3010，同域不同端口，登录态自动共享），Studio 的 iframe 走它。
 */
export const FASTGPT_EMBED_BASE = 'http://146.56.201.241:3010'

/**
 * 首页场景下的 FastGPT 智能体卡片。
 *
 * 数据源 `/api/studio/fastgpt-agents`（服务端内置目录，配了 FASTGPT_API_KEY 时实时
 * 刷新名称/简介）。拿不到就回空数组 —— 卡片是增量入口，缺了不影响对话。
 */
export interface FastGptAgent {
  readonly appId: string
  /** 挂在哪个场景（chat app 的 scene.id）。 */
  readonly sceneId: string
  /** 场景显示名，面板按它分组。 */
  readonly sceneLabel: string
  readonly name: string
  /** 卡片封面上的短名。 */
  readonly short: string
  readonly desc: string
  /** 封面渐变。 */
  readonly tint: string
  /** FastGPT 对话页。 */
  readonly chatUrl: string
  /** FastGPT 编排页。 */
  readonly manageUrl: string
  /** 免登录分享链接；空串表示这个智能体还没建分享渠道。 */
  readonly shareUrl: string
  /** 该智能体自带的预设提示词；空数组时回落到场景级提示词。 */
  readonly prompts?: readonly { label: string; text: string }[]
}

export interface FastGptAgentList {
  readonly baseUrl: string
  readonly source: string
  readonly agents: readonly FastGptAgent[]
}

export async function fetchFastGptAgents(appId = 'btit'): Promise<FastGptAgent[]> {
  try {
    const res = await request<{ agents?: FastGptAgent[] }>(
      `/api/studio/fastgpt-agents?app=${encodeURIComponent(appId)}`,
    )
    return Array.isArray(res?.agents) ? res.agents : []
  } catch {
    return []
  }
}

export interface FastGptAgentVariable {
  readonly key: string
  readonly label: string
  readonly required: boolean
  readonly description: string
  readonly defaultValue: string
}

/** 智能体运行时需要的变量（record_id / domain …）；拿不到回空数组。 */
export async function fetchFastGptAgentVariables(appId: string): Promise<FastGptAgentVariable[]> {
  try {
    const res = await request<{ variables?: FastGptAgentVariable[] }>(
      `/api/studio/fastgpt-agents/config?appId=${encodeURIComponent(appId)}`,
    )
    return Array.isArray(res?.variables) ? res.variables : []
  } catch {
    return []
  }
}

export interface FastGptChatTurn {
  readonly role: 'user' | 'assistant'
  readonly content: string
}

/**
 * 在 Studio 会话里跟某个智能体对话：服务端代理 FastGPT 的 SSE，这里只处理
 * `{delta}` 增量与 `{done}` 结束标记。`chatId` 按 Studio 会话复用，多轮上下文
 * 留在 FastGPT 侧；不传就是一次性的新会话。
 */
export async function streamFastGptAgentChat(input: {
  appId: string
  messages: FastGptChatTurn[]
  chatId?: string
  variables?: Record<string, string>
  signal?: AbortSignal
  onDelta: (delta: string) => void
}): Promise<void> {
  const res = await requestStream('/api/studio/fastgpt-agents/chat', {
    method: 'POST',
    body: JSON.stringify({
      appId: input.appId,
      messages: input.messages,
      chatId: input.chatId,
      variables: input.variables,
    }),
    signal: input.signal,
  })
  if (!res.body) throw new Error('stream unavailable')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const consume = (raw: string): boolean => {
    const dataLine = raw.split('\n').find(line => line.startsWith('data:'))
    if (!dataLine) return false
    let payload: any
    try {
      payload = JSON.parse(dataLine.slice(5).trim())
    } catch {
      return false
    }
    if (payload?.delta) input.onDelta(String(payload.delta))
    else if (payload?.error) throw new Error(String(payload.error))
    else if (payload?.done) return true
    return false
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      if (buffer.indexOf('\r') >= 0) buffer = buffer.replace(/\r\n/g, '\n')
      let index = buffer.indexOf('\n\n')
      while (index >= 0) {
        const raw = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        index = buffer.indexOf('\n\n')
        if (consume(raw)) return
      }
    }
  } finally {
    reader.releaseLock()
  }
}
