/**
 * `/gamma-api` —— 转发到本机的 Gamma 后端（FastAPI）。
 *
 * Gamma 的页面已经是工作台自己的静态资源（`public/gamma`），但它仍要调用
 * 自己的 API。前端只认相对路径 `/gamma-api`，由这里转到
 * `127.0.0.1:<port>/api`。端口由桌面端主进程注入（它拉起的子进程），
 * Web 部署时回落到 9001。
 *
 * 用 `node:http` 手写转发而不是引第三方库：需要保留流式响应（PDF 下载）
 * 与 `Set-Cookie`，手写反而更可控，也不给打包增加依赖。
 */
import http from 'node:http'
import type { Context, Next } from 'koa'

const PREFIX = '/gamma-api'

/** hop-by-hop 头不能透传，交给 Koa 自己算。 */
const SKIP_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade'])

function gammaPort(): number {
  const raw = process.env.GAMMA_BACKEND_PORT || '9001'
  const port = Number(raw)
  return Number.isFinite(port) && port > 0 && port < 65536 ? port : 0
}

export function createGammaProxy() {
  return async (ctx: Context, next: Next): Promise<void> => {
    if (!ctx.path.startsWith(PREFIX)) {
      await next()
      return
    }

    const port = gammaPort()
    if (port === 0) {
      ctx.status = 503
      ctx.body = { detail: 'gamma backend is not configured' }
      return
    }

    // /gamma-api/xxx -> /api/xxx
    const rest = ctx.path.slice(PREFIX.length) || '/'
    const path = `/api${rest}${ctx.querystring ? `?${ctx.querystring}` : ''}`

    /*
     * 关键：收到上游响应头就 resolve，不等流结束。
     * 如果在这里等 'end'，流要等中间件返回后才被 Koa 消费，两边互等 —— 死锁。
     */
    await new Promise<void>((resolve) => {
      const upstream = http.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method: ctx.method,
          headers: { ...ctx.headers, host: `127.0.0.1:${port}` },
        },
        (res) => {
          ctx.status = res.statusCode ?? 502
          for (const [key, value] of Object.entries(res.headers)) {
            if (value === undefined || SKIP_HEADERS.has(key.toLowerCase())) continue
            ctx.set(key, value as string | string[])
          }
          // 把上游的流直接交给 Koa，PDF 这类大响应不会被缓冲。
          ctx.body = res
          resolve()
        },
      )
      upstream.on('error', (error: Error) => {
        if (!ctx.body) {
          ctx.status = 502
          ctx.body = { detail: `gamma backend unreachable: ${error.message}` }
        }
        resolve()
      })
      ctx.req.pipe(upstream)
    })
  }
}
