/**
 * 访问令牌管理。
 *
 * 沿用项目群的约定：**密码即令牌**，服务端只存 SHA-256 哈希。
 * 前端把令牌存 localStorage，之后以 X-Auth-Token 请求头发送。
 *
 * 注意：iframe 里的 PDF / HTML 预览无法自定义请求头，
 * 因此那些 URL 会附带 ?token= —— 这正是后端同时支持两种通道的原因。
 *
 * @module public/js/auth
 */

const KEY = 'rndb_token'

/**
 * 取当前令牌。
 * @returns {string} 令牌或空串
 */
export function getToken() {
  try {
    return localStorage.getItem(KEY) ?? ''
  } catch {
    return ''
  }
}

/**
 * 保存令牌。
 * @param {string} token - 令牌
 * @returns {void}
 */
export function setToken(token) {
  try {
    localStorage.setItem(KEY, String(token ?? ''))
  } catch {
    /* 隐私模式下 localStorage 可能不可用，忽略即可 */
  }
}

/**
 * 清除令牌（退出登录）。
 * @returns {void}
 */
export function clearToken() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* 忽略 */
  }
}

/**
 * 查询当前鉴权状态与角色。
 * @returns {Promise<object>} { authenticated, role, configured, failClosed, ... }
 */
export async function fetchAuthStatus() {
  const headers = {}
  const token = getToken()
  if (token) headers['X-Auth-Token'] = token

  try {
    const res = await fetch('/api/v1/auth/status', { headers })
    const body = await res.json()
    return body?.ok ? body.data : { authenticated: false, error: body?.error?.message }
  } catch (err) {
    return { authenticated: false, error: String(err?.message ?? err) }
  }
}

/**
 * 用密码换取角色。
 * @param {string} token - 用户输入的密码
 * @returns {Promise<{ok:boolean, role?:string, error?:string}>} 结果
 */
export async function login(token) {
  try {
    const res = await fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    const body = await res.json()
    if (!body?.ok) return { ok: false, error: body?.error?.message ?? `HTTP ${res.status}` }
    return { ok: true, role: body.data.role }
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) }
  }
}
