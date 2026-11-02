import { request } from '@/api/client'

/**
 * 用当前会话自己的模型把草稿改写成结构化提示词。
 * 走 Studio 的 provider 配置，不经过任何业务应用。
 */
export async function enhancePromptText(input: {
  text: string
  profile?: string
  provider?: string
  model?: string
}): Promise<string> {
  const res = await request<{ text?: string }>('/api/studio/prompt/enhance', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return String(res?.text ?? '').trim()
}
