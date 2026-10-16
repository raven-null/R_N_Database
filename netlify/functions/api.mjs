/**
 * API 路由器：统一挂载 /api/v1/*。
 *
 * 为什么用**一个路由器函数**而不是每个端点一个函数：
 *
 * 1. **路径解析完全可控**。Netlify Functions v2 的 config.path 支持
 *    `:param` 与通配符，但各版本行为有差异；自己解析 pathname 就没有
 *    这个不确定性，本地 dev-server 也能做到与线上一模一样。
 * 2. **本地与线上一致**。dev-server 按 config.path 挂载，通配符语义
 *    两边都得实现一遍，反而容易不一致。
 * 3. 路径参数（如 `/docs/{id}/preview`）用字符串拆分即可，不需要框架。
 *
 * 代价是单函数承载全部路由，改一处会重新部署所有接口 ——
 * 对个人项目这个代价可以忽略。
 *
 * @module netlify/functions/api
 */

import { healthRoute } from './_lib/routes/health.mjs'
import { docsRoute } from './_lib/routes/docs.mjs'
import { searchRoute } from './_lib/routes/search.mjs'
import { taxonomyRoute, manifestRoute } from './_lib/routes/meta.mjs'
import { authRoute } from './_lib/routes/auth.mjs'
import { notFound, preflight, serverError } from './_lib/respond.mjs'

/** API 前缀。 */
const PREFIX = '/api/v1'

export default async (req) => {
  let url
  try {
    url = new URL(req.url)
  } catch {
    return notFound('无法解析请求 URL', { req })
  }

  // CORS 预检统一在这里回，避免每个端点各写一遍
  if (req.method === 'OPTIONS') return preflight(req)

  const seg = url.pathname
    .replace(/^\/api\/v1\/?/, '')
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s)
      } catch {
        return s
      }
    })

  try {
    if (seg.length === 0) {
      return notFound(`未知接口。可用接口见 ${PREFIX}/health`, { req })
    }

    switch (seg[0]) {
      case 'health':
        return await healthRoute(req, url)
      case 'docs':
        return await docsRoute(req, url, seg.slice(1))
      case 'search':
        return await searchRoute(req, url)
      case 'taxonomy':
        return await taxonomyRoute(req, url)
      case 'manifest':
        return await manifestRoute(req, url)
      case 'auth':
        return await authRoute(req, url, seg.slice(1))
      default:
        return notFound(`未知接口：${seg[0]}`, { req })
    }
  } catch (err) {
    return serverError(err, 'api', { req })
  }
}

export const config = { path: '/api/v1/*' }
