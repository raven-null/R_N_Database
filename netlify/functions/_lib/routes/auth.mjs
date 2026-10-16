/**
 * 路由：/api/v1/auth —— 登录与鉴权状态。
 *
 * 沿用图库的做法：**密码即令牌**，服务端只存 SHA-256 哈希。
 * 因此登录接口的职责是「校验你输入的这个密码属于哪一档」，
 * 校验通过后客户端把同一个串作为 X-Auth-Token 保存即可。
 *
 * @module netlify/functions/_lib/routes/auth
 */

import { checkAuth, authStatus, sha256hex, getAuthConfig, saveAuthConfig } from '../auth.mjs'
import { ok, badRequest, unauthorized, forbidden, serverError } from '../respond.mjs'

/**
 * 处理 /api/v1/auth 及其子路径。
 * @param {Request} req - 请求
 * @param {URL} url - URL
 * @param {string[]} seg - 「auth」之后的路径段
 * @returns {Promise<Response>} 响应
 */
export async function authRoute(req, url, seg) {
  try {
    const action = seg[0] ?? ''

    // ---- GET /api/v1/auth/status ----
    if (action === 'status') {
      const status = await authStatus()
      const auth = await checkAuth(req, url, 'guest')
      return ok({
        ...status,
        // 当前这个请求处于什么角色（前端据此显示编辑入口等）
        role: auth.ok ? auth.role : null,
        authenticated: auth.ok,
      }, { req })
    }

    // ---- POST /api/v1/auth/login ----
    if (action === 'login') {
      if (req.method !== 'POST') return badRequest('登录请用 POST', { req })

      let body
      try {
        body = await req.json()
      } catch {
        return badRequest('请求体不是合法 JSON', { req })
      }

      const token = String(body?.token ?? '').trim()
      if (!token) return badRequest('缺少 token', { req })

      // 用一个带 token 的合成 URL 走统一鉴权逻辑，避免重复实现比对
      const probe = new URL(url.toString())
      probe.searchParams.set('token', token)
      const auth = await checkAuth(new Request(probe, { method: 'GET' }), probe, 'guest')

      if (!auth.ok) {
        if (auth.failClosed) {
          return forbidden('服务端尚未配置访问密码，请先在部署环境设置 ADMIN_TOKEN', { req })
        }
        return unauthorized('密码不正确', { req })
      }

      return ok({
        role: auth.role,
        // 提示客户端：把这个 token 存下来，之后用 X-Auth-Token 发送
        hint: '请将本 token 以 X-Auth-Token 请求头发送',
      }, { req })
    }

    // ---- POST /api/v1/auth/password —— 修改密码（仅 admin）----
    if (action === 'password') {
      const auth = await checkAuth(req, url, 'admin')
      if (!auth.ok) return unauthorized('需要管理员权限', { req })

      let body
      try {
        body = await req.json()
      } catch {
        return badRequest('请求体不是合法 JSON', { req })
      }

      const next = String(body?.token ?? '').trim()
      if (next.length < 6) return badRequest('新密码至少 6 位', { req })

      const cfg = await getAuthConfig()
      if (body?.role === 'read') cfg.readHash = sha256hex(next)
      else if (body?.role === 'guest') cfg.guestHash = sha256hex(next)
      else cfg.adminHash = sha256hex(next)

      await saveAuthConfig(cfg)
      return ok({ updated: true, role: body?.role ?? 'admin' }, { req })
    }

    return badRequest(`未知的 auth 子路径：${action}`, { req })
  } catch (err) {
    return serverError(err, 'auth', { req })
  }
}
