/**
 * GET /api/v1/health —— 探活与自检。
 *
 * 这个端点**不需要鉴权**（否则出问题时你连诊断都做不了），
 * 但它只报告状态与布尔信号，绝不返回任何密钥、路径或文档内容。
 *
 * 阶段 0 的核心用途：部署到 Netlify 后访问一次，就能确认
 *   ① Blobs 是否真的可用（避免"入库成功但数据蒸发"）
 *   ② 线上到底注入了哪些环境信号（用来钉死生产环境判定逻辑）
 *   ③ 访问密码是否已生效（未配则线上会拒绝所有请求）
 *
 * @module netlify/functions/health
 */

import { probeStore, runtimeInfo, resolveStoreMode, STORES } from './_lib/store.mjs'
import { authStatus } from './_lib/auth.mjs'
import { allowedOrigins } from './_lib/cors.mjs'
import { ok, serverError } from './_lib/respond.mjs'

export default async (req) => {
  try {
    const url = new URL(req.url)
    const rt = runtimeInfo()
    const skipStore = url.searchParams.get('store') === '0'

    const store = skipStore
      ? { mode: resolveStoreMode(), ready: null, error: null, skipped: true }
      : await probeStore()

    const auth = await authStatus()

    return ok({
      name: 'R_N_Database',
      version: '0.1.0',
      apiVersion: 'v1',
      time: new Date().toISOString(),

      // 存储层：ready=false 说明线上 Blobs 没开或凭据不对
      store: { ...store, stores: Object.values(STORES) },

      // 鉴权层：failClosed=true 说明线上没配 ADMIN_TOKEN，此时一切请求都会被拒
      auth,

      // 运行环境信号（只有布尔量与版本号）—— 用于钉死生产判定逻辑
      runtime: rt,

      // CORS 白名单里是否包含你期望的来源
      allowedOrigins: allowedOrigins(),

      // 给调用方的提示，直接可执行
      hints: buildHints(store, auth, rt),
    }, { req })
  } catch (err) {
    return serverError(err, 'health', { req })
  }
}

/**
 * 根据自检结果给出直接可执行的修复提示。
 * @param {object} store - probeStore 结果
 * @param {object} auth - authStatus 结果
 * @param {object} rt - runtimeInfo 结果
 * @returns {string[]} 提示列表
 */
function buildHints(store, auth, rt) {
  const hints = []
  if (store.ready === false) {
    hints.push(
      rt.inLambda
        ? '线上 Blobs 不可用：到 Netlify 站点 Settings → Data collection 开启 Netlify Blobs，然后重新部署。'
        : '本地 Blobs 不可用：若在本地开发，把 DOCS_STORE_MODE 设为 local。',
    )
  }
  if (auth.failClosed) {
    hints.push('线上尚未配置访问密码：请在 Netlify 环境变量里设置 ADMIN_TOKEN，否则所有请求都会被拒绝（这是刻意的 fail-closed 设计）。')
  }
  if (!auth.configured && !rt.inLambda && auth.hasAdmin === false) {
    hints.push('本地尚未配置 ADMIN_TOKEN，开发模式已放行；这仅限本地。')
  }
  if (rt.inLambda && !rt.hasBlobsContext) {
    hints.push('运行在函数里但没有 Blobs 上下文，说明 Blobs 未启用或无权限。')
  }
  return hints
}

/** Netlify Functions v2 路由声明：无需在 netlify.toml 写 redirects。 */
export const config = { path: '/api/v1/health' }
