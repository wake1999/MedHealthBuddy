import Router from '@koa/router'
import * as ctrl from '../controllers/fastgpt-agents'

/**
 * 首页场景下的 FastGPT 智能体卡片（只读）。
 */
export const fastGptAgentRoutes = new Router()

fastGptAgentRoutes.get('/api/studio/fastgpt-agents', ctrl.list)

/** 智能体运行时需要的变量定义（record_id / domain …）。 */
fastGptAgentRoutes.get('/api/studio/fastgpt-agents/config', ctrl.config)

/** 在 Studio 会话里跟智能体对话：SSE 转发 FastGPT 的文本增量。 */
fastGptAgentRoutes.post('/api/studio/fastgpt-agents/chat', ctrl.chat)
