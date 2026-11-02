import Router from '@koa/router'
import * as ctrl from '../controllers/prompt-enhance'

export const promptEnhanceRoutes = new Router()

/** 用当前会话的模型把草稿改写成结构化提示词。 */
promptEnhanceRoutes.post('/api/studio/prompt/enhance', ctrl.enhance)
