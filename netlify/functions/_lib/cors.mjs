/**
 * CORS 白名单。
 *
 * 沿用博客项目 _shared/cors.ts 的 ALLOWED_ORIGIN 模式，保持两个项目一致。
 *
 * 谁需要 CORS：
 *   - 博客（浏览器里跑）→ 需要，且必须在白名单里
 *   - 智能工作站（Tauri 桌面端，从 Node 侧 fetch）→ 不受 CORS 约束
 *
 * @module netlify/functions/_lib/cors
 */

const DEFAULT_ORIGIN = 'https://ravennull.work'

/**
 * 计算允许的来源列表。
 * 本地开发自动补上常见端口，省得每次改 IP/端口都要动环境变量。
 * @returns {string[]} 允许的 Origin 列表
 */
export function allowedOrigins() {
  const list = String(process.env.ALLOWED_ORIGIN || DEFAULT_ORIGIN)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  const isProd = process.env.NETLIFY === 'true' || process.env.AWS_LAMBDA_FUNCTION_NAME
  if (!isProd) {
    list.push(
      'http://localhost:5173', 'http://127.0.0.1:5173',
      'http://localhost:8080', 'http://127.0.0.1:8080',
      'http://localhost:8899', 'http://127.0.0.1:8899',
    )
  }
  return list
}

/**
 * 生成 CORS 响应头。
 *
 * 注意：默认**不回显**未知 Origin，而不是回显任意 Origin —— 回显任意
 * Origin 等于放弃同源策略保护。
 * @param {Request} [req] - 原请求
 * @returns {Record<string,string>} 响应头
 */
export function corsHeaders(req) {
  const origins = allowedOrigins()
  const reqOrigin = req?.headers?.get?.('origin') ?? undefined
  const allow = origins.includes('*')
    ? '*'
    : (reqOrigin && origins.includes(reqOrigin) ? reqOrigin : origins[0])

  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Auth-Token',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}
