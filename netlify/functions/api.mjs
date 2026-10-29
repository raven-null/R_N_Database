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

// 必须排在最前：线上 Functions 是 Node 20，pdfjs 等库要 Node 22+ 的 API
import './_lib/polyfills.mjs'

import { healthRoute } from './_lib/routes/health.mjs'
import { docsRoute } from './_lib/routes/docs.mjs'
import { searchRoute } from './_lib/routes/search.mjs'
import { taxonomyRoute, manifestRoute } from './_lib/routes/meta.mjs'
import { authRoute } from './_lib/routes/auth.mjs'
import { batchRoute, tagRenameRoute, tagDeleteRoute, tagStatsRoute } from './_lib/routes/docs-batch.mjs'
import { inboxRoute } from './_lib/routes/inbox.mjs'
import { exportRoute } from './_lib/routes/export.mjs'
import { foldersRoute } from './_lib/routes/folders.mjs'
import { repairIndex } from './_lib/index-repair.mjs'
import { checkAuth } from './_lib/auth.mjs'
import { badRequest, forbidden, notFound, preflight, serverError } from './_lib/respond.mjs'

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
        // /docs/batch 是集合级操作，必须抢在 /docs/{id} 之前判断，
        // 否则「batch」会被当成文档 id
        if (seg[1] === 'batch') return await batchRoute(req, url)
        return await docsRoute(req, url, seg.slice(1))

      case 'tags':
        // /tags            标签统计
        // /tags/rename     重命名 / 合并
        // /tags/{name}     全库删除
        if (seg.length === 1) return await tagStatsRoute(req, url)
        if (seg[1] === 'rename') return await tagRenameRoute(req, url)
        return await tagDeleteRoute(req, url, seg[1])

      case 'inbox':
        return await inboxRoute(req, url, seg.slice(1))

      case 'folders':
        // GET    /folders          文件夹树
        // POST   /folders          新建（admin）
        // PATCH  /folders/{fid}    改名 / 移动 / 改可见性（admin）
        // DELETE /folders/{fid}    删除（子项上移，不销毁数据）
        return await foldersRoute(req, url, seg.slice(1))

      case 'search':
        return await searchRoute(req, url)

      case 'export':
        // POST /export          生成全库备份 zip（admin）
        // GET  /export/{id}     下载备份件
        return await exportRoute(req, url, seg.slice(1))
      case 'taxonomy':
        return await taxonomyRoute(req, url)
      case 'manifest':
        return await manifestRoute(req, url)
      case 'auth':
        return await authRoute(req, url, seg.slice(1))

      case 'index':
        // POST /index/repair —— 从 META 重建索引（admin）。
        // 线上新库从没跑过 reindex 时需要它；本地等价物是 scripts/reindex.mjs。
        if (seg[1] === 'repair') {
          if (req.method !== 'POST') return badRequest('重建索引请用 POST', { req })
          const a = await checkAuth(req, url, 'admin')
          if (!a.ok) return forbidden('重建索引需要登录（管理员密码）', { req })
          return await repairIndex(req, url)
        }
        return notFound(`未知子路径：${seg.join('/')}`, { req })

      default:
        return notFound(`未知接口：${seg[0]}`, { req })
    }
  } catch (err) {
    return serverError(err, 'api', { req })
  }
}

export const config = { path: '/api/v1/*' }
