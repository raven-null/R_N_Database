/**
 * 访问控制：三档令牌 + 短期签名 URL。
 *
 * 沿用图库项目已验证的做法：密码只存 SHA-256 哈希，配置放 Blobs
 * 的 `doc-auth` / `auth-config`，首次启动用环境变量 ADMIN_TOKEN 初始化。
 *
 * 三档令牌：
 *   admin —— 读写删，只有你自己
 *   read  —— 只读全部，给工作站和博客
 *   guest —— 只读标记公开的文档（日后对外用）
 *
 * 与图库项目的一处**刻意不同**：
 *   图库在「未设访问密码」时是**放行**的（避免把自己锁在外面）。
 *   这对公开站点合理，但对一个私有资料库是危险的默认值 ——
 *   万一忘了配 ADMIN_TOKEN，整库就对全世界敞开了。
 *   这里改为：**线上未配密码 → 一律拒绝访问**，并在 /api/v1/health
 *   里明确报出来告诉你该怎么修。本地开发仍然放行，方便调试。
 *
 * @module netlify/functions/_lib/auth
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { getDocsStore, STORES, runtimeInfo } from './store.mjs'

const KEY_AUTH_CONFIG = 'auth-config'

/** 角色权限等级。数值大者包含小者。 */
const RANK = { guest: 1, read: 2, admin: 3 }

/**
 * 计算 SHA-256 十六进制摘要。
 * @param {string} value - 待摘要字符串
 * @returns {string} 十六进制摘要
 */
export function sha256hex(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

/**
 * 定长安全的字符串比较（避免按字符提前返回导致的时序泄漏）。
 * @param {string} a - 字符串一
 * @param {string} b - 字符串二
 * @returns {boolean} 是否相等
 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8')
  const bb = Buffer.from(String(b ?? ''), 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/**
 * 读取鉴权配置；首次启动时用 ADMIN_TOKEN 初始化 admin 密码。
 * @returns {Promise<object>} 配置对象（可能为空对象）
 */
export async function getAuthConfig() {
  const store = await getDocsStore(STORES.AUTH)
  let cfg = null
  try {
    cfg = await store.get(KEY_AUTH_CONFIG, { type: 'json' })
  } catch {
    cfg = null
  }
  if (!cfg || typeof cfg !== 'object') cfg = {}

  // 首次启动：用环境变量播种 admin 密码
  if (!cfg.adminHash && process.env.ADMIN_TOKEN) {
    cfg.adminHash = sha256hex(process.env.ADMIN_TOKEN)
    cfg.updatedAt = new Date().toISOString()
    try {
      await store.set(KEY_AUTH_CONFIG, JSON.stringify(cfg))
    } catch {
      /* 写失败也继续用内存里的值，不阻塞请求 */
    }
  }
  return cfg
}

/**
 * 保存鉴权配置。
 * @param {object} cfg - 配置对象
 * @returns {Promise<void>} 完成
 */
export async function saveAuthConfig(cfg) {
  const store = await getDocsStore(STORES.AUTH)
  cfg.updatedAt = new Date().toISOString()
  await store.set(KEY_AUTH_CONFIG, JSON.stringify(cfg))
}

/**
 * 提取请求携带的令牌。
 *
 * 三种来源，覆盖不同场景：
 *   1. X-Auth-Token 头 —— API 调用（工作站、博客 fetch）
 *   2. ?token= 查询参数 —— <iframe>/<img> 无法自定义请求头
 *   3. ?exp=&sig= 签名 URL —— 交给第三方（如 Office 在线预览）抓取，
 *      避免把长期令牌暴露在 URL 里
 *
 * @param {Request} req - 请求
 * @param {URL} url - 解析后的 URL
 * @returns {string} 令牌（可能为空串）
 */
export function tokenFrom(req, url) {
  const header = req?.headers?.get?.('X-Auth-Token') || req?.headers?.get?.('x-auth-token') || ''
  const query = url ? (url.searchParams.get('token') || '') : ''
  return String(header || query).trim()
}

/**
 * 取签名密钥。优先专用环境变量，否则从 admin 密码哈希派生 ——
 * 这样不必多配一个必填环境变量，且改密码会自动让旧签名 URL 失效。
 * @param {object} cfg - 鉴权配置
 * @returns {string|null} 密钥，或 null 表示未配置（无法签名）
 */
function signSecret(cfg) {
  return process.env.DOCS_SIGN_SECRET || cfg?.adminHash || null
}

/**
 * 生成短期签名 URL 的签名值。
 * @param {string} pathname - 请求路径
 * @param {string|number} exp - 过期时间戳（秒）
 * @param {string} secret - 密钥
 * @returns {string} 十六进制签名
 */
function sign(pathname, exp, secret) {
  return createHmac('sha256', secret).update(`${pathname}|${exp}`).digest('hex')
}

/**
 * 为一个路径生成带签名的短期 URL 查询串。
 * @param {string} pathname - 请求路径
 * @param {number} [ttlSec] - 有效期秒数
 * @returns {Promise<string|null>} 形如 `exp=...&sig=...`，未配置密钥时返回 null
 */
export async function makeSignatureQuery(pathname, ttlSec = 300) {
  const cfg = await getAuthConfig()
  const secret = signSecret(cfg)
  if (!secret) return null
  const exp = Math.floor(Date.now() / 1000) + ttlSec
  return `exp=${exp}&sig=${sign(pathname, exp, secret)}`
}

/**
 * 校验签名 URL。过期或签名不符都返回 false。
 * @param {URL} url - 解析后的 URL
 * @returns {Promise<boolean>} 是否有效
 */
export async function verifySignature(url) {
  const exp = url.searchParams.get('exp')
  const sig = url.searchParams.get('sig')
  if (!exp || !sig) return false
  const expNum = Number(exp)
  if (!Number.isFinite(expNum)) return false
  if (expNum * 1000 < Date.now()) return false

  const cfg = await getAuthConfig()
  const secret = signSecret(cfg)
  if (!secret) return false
  return safeEqual(sign(url.pathname, exp, secret), sig)
}

/**
 * 鉴权主入口。
 *
 * @param {Request} req - 请求
 * @param {URL} url - 解析后的 URL
 * @param {'guest'|'read'|'admin'} [required] - 所需最低角色
 * @returns {Promise<{ok:boolean, role:string|null, reason:string, failClosed:boolean}>} 鉴权结果
 */
export async function checkAuth(req, url, required = 'guest') {
  const cfg = await getAuthConfig()
  const configured = Boolean(cfg.adminHash || cfg.readHash || cfg.guestHash)
  const isProd = runtimeInfo().inLambda

  // ---- 情形一：根本没配密码 ----
  if (!configured) {
    if (isProd) {
      // 私有资料库的正确默认值是拒绝，而不是放行
      return { ok: false, role: null, reason: 'NO_PASSWORD_CONFIGURED', failClosed: true }
    }
    return { ok: true, role: 'admin', reason: 'DEV_NO_GATE', failClosed: false }
  }

  // ---- 情形二：签名 URL（给第三方抓取用，权限等同 read）----
  if (await verifySignature(url)) {
    return { ok: true, role: 'read', reason: 'SIGNATURE', failClosed: false }
  }

  // ---- 情形三：令牌比对 ----
  const token = tokenFrom(req, url)
  if (!token) return { ok: false, role: null, reason: 'NO_TOKEN', failClosed: false }

  const hash = sha256hex(token)
  let role = null
  if (cfg.adminHash && safeEqual(hash, cfg.adminHash)) role = 'admin'
  else if (cfg.readHash && safeEqual(hash, cfg.readHash)) role = 'read'
  else if (cfg.guestHash && safeEqual(hash, cfg.guestHash)) role = 'guest'

  if (!role) return { ok: false, role: null, reason: 'BAD_TOKEN', failClosed: false }

  if (RANK[role] < RANK[required]) {
    return { ok: false, role, reason: 'INSUFFICIENT_ROLE', failClosed: false }
  }
  return { ok: true, role, reason: 'TOKEN', failClosed: false }
}

/**
 * 鉴权状态摘要（供 /api/v1/health，只报状态不泄密）。
 * @returns {Promise<object>} { configured, hasAdmin, hasRead, hasGuest, failClosed }
 */
export async function authStatus() {
  try {
    const cfg = await getAuthConfig()
    const configured = Boolean(cfg.adminHash || cfg.readHash || cfg.guestHash)
    return {
      configured,
      hasAdmin: Boolean(cfg.adminHash),
      hasRead: Boolean(cfg.readHash),
      hasGuest: Boolean(cfg.guestHash),
      // 线上未配密码时会拒绝所有请求，这里明确标出来
      failClosed: !configured && runtimeInfo().inLambda,
    }
  } catch (err) {
    return { configured: false, error: String(err?.message ?? err) }
  }
}
