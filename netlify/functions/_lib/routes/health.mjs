/**
 * 路由：GET /api/v1/health —— 探活与自检。
 *
 * **不需要鉴权**（否则出问题时连诊断都做不了），但只报告状态与布尔信号，
 * 绝不返回任何密钥、路径或文档内容。
 *
 * @module netlify/functions/_lib/routes/health
 */

import { probeStore, runtimeInfo, resolveStoreMode, STORES } from '../store.mjs'
import BUILD_INFO from '../build-info.mjs'
import { authStatus } from '../auth.mjs'
import { allowedOrigins } from '../cors.mjs'
import { ok, serverError } from '../respond.mjs'
import { readAllMeta } from '../repo.mjs'

/**
 * 处理健康检查。
 * @param {Request} req - 请求
 * @param {URL} url - URL
 * @returns {Promise<Response>} 响应
 */
export async function healthRoute(req, url) {
  try {
    const rt = runtimeInfo()
    const skipStore = url.searchParams.get('store') === '0'

    const store = skipStore
      ? { mode: resolveStoreMode(), ready: null, error: null, skipped: true }
      : await probeStore()

    const auth = await authStatus()

    // 文档数量是最有用的"部署是否真的接上数据"的信号
    let docCount = null
    if (store.ready) {
      docCount = (await readAllMeta().catch(() => [])).length
    }

    return ok({
      name: '渡·资·集',
      // slug 给外部调用方做稳定标识（站点改名时它不变）
      slug: 'du-zi-ji',
      version: '0.2.0',
      apiVersion: 'v1',
      time: new Date().toISOString(),
      store: { ...store, stores: Object.values(STORES) },
      auth,
      docCount,
      // 线上跑的到底是哪一版？由构建期生成的 build-info.mjs 如实回报。
      // 曾经因为「改了代码但线上还是旧的」白排查半天，这个字段就是答案。
      build: BUILD_INFO,
      runtime: rt,
      allowedOrigins: allowedOrigins(),
      hints: buildHints(store, auth, rt, docCount),
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
 * @param {number|null} docCount - 文档数
 * @returns {string[]} 提示列表
 */
function buildHints(store, auth, rt, docCount) {
  const hints = []
  if (store.ready === false) {
    hints.push(
      rt.inLambda
        ? '线上 Blobs 不可用：到 Netlify 站点 Settings → Data collection 开启 Netlify Blobs，然后重新部署。'
        : '本地 Blobs 不可用：若在本地开发，把 DOCS_STORE_MODE 设为 local。',
    )
  }
  if (!auth.configured && rt.inLambda) {
    hints.push('线上尚未配置访问密码：未登录访客只能看到标记为「公开」的文档'
      + '（默认全部私有，所以现在什么也看不到），且任何人都无法上传或修改。'
      + '要启用完整功能，请在 Netlify 环境变量里设置 ADMIN_TOKEN 后重新部署。')
  }
  if (store.ready && docCount === 0) {
    hints.push('存储可用但库是空的：运行 node scripts/ingest.mjs "<你的文档目录>" 开始入库。')
  }
  if (rt.inLambda && !rt.hasBlobsContext) {
    hints.push('运行在函数里但没有 Blobs 上下文，说明 Blobs 未启用或无权限。')
  }
  return hints
}
