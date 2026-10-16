/**
 * API 客户端。
 *
 * 统一处理三件事：带令牌、解析统一响应契约、把错误转成可展示的消息。
 * 响应契约：成功 `{ ok:true, data }`，失败 `{ ok:false, error:{code,message} }`。
 *
 * @module public/js/api
 */

import { getToken } from './auth.js'

const MANIFEST_KEY = 'rndb_manifest'
const ETAG_KEY = 'rndb_manifest_etag'

/** API 错误。 */
export class ApiError extends Error {
  /**
   * @param {string} message - 消息
   * @param {string} code - 错误码
   * @param {number} status - HTTP 状态
   */
  constructor(message, code, status) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

/**
 * 组装带令牌的请求头。
 * @returns {Record<string,string>} 请求头
 */
export function authHeaders() {
  const token = getToken()
  return token ? { 'X-Auth-Token': token } : {}
}

/**
 * 带令牌的 URL（供 iframe / 下载链接使用 —— 它们无法自定义请求头）。
 * @param {string} path - API 路径
 * @returns {string} 带令牌的 URL
 */
export function authedUrl(path) {
  const token = getToken()
  if (!token) return path
  return `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
}

/**
 * 发起一次 API 请求。
 * @param {string} path - 路径
 * @param {object} [opts] - { method, body, headers, raw }
 * @returns {Promise<*>} data 字段（raw=true 时返回 Response）
 */
export async function apiFetch(path, opts = {}) {
  const headers = { ...authHeaders(), ...(opts.headers ?? {}) }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'

  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })

  if (opts.raw) return res

  let body = null
  try {
    body = await res.json()
  } catch {
    throw new ApiError(`响应不是 JSON（HTTP ${res.status}）`, 'BAD_RESPONSE', res.status)
  }

  if (!body?.ok) {
    const code = body?.error?.code ?? 'UNKNOWN'
    const message = body?.error?.message ?? `HTTP ${res.status}`
    throw new ApiError(message, code, res.status)
  }
  return body.data
}

/**
 * 全量文档清单（带 ETag 缓存）。
 *
 * 一次拉全库元数据，之后所有的筛选与即时搜索都在本地做 ——
 * 个人库规模下这比每次输入都打接口快得多，也省函数调用。
 *
 * @param {object} [opts] - { force: 忽略缓存强制刷新 }
 * @returns {Promise<object>} manifest 数据
 */
export async function loadManifest(opts = {}) {
  const headers = authHeaders()

  if (!opts.force) {
    try {
      const etag = localStorage.getItem(ETAG_KEY)
      if (etag) headers['If-None-Match'] = etag
    } catch {
      /* localStorage 不可用则跳过条件请求 */
    }
  }

  const res = await fetch('/api/v1/manifest', { headers })

  // 304：内容没变，直接用本地缓存
  if (res.status === 304) {
    try {
      const cached = localStorage.getItem(MANIFEST_KEY)
      if (cached) return JSON.parse(cached)
    } catch {
      /* 缓存坏了就往下走，重新拉一次 */
    }
  }

  let body = null
  try {
    body = await res.json()
  } catch {
    throw new ApiError(`清单响应不是 JSON（HTTP ${res.status}）`, 'BAD_RESPONSE', res.status)
  }

  if (!body?.ok) {
    throw new ApiError(
      body?.error?.message ?? `HTTP ${res.status}`,
      body?.error?.code ?? 'UNKNOWN',
      res.status,
    )
  }

  try {
    localStorage.setItem(MANIFEST_KEY, JSON.stringify(body.data))
    localStorage.setItem(ETAG_KEY, res.headers.get('etag') ?? '')
  } catch {
    /* 缓存写不进去不影响本次使用 */
  }

  return body.data
}

/**
 * 清除本地清单缓存（退出登录或换令牌后必须清）。
 * @returns {void}
 */
export function clearManifestCache() {
  try {
    localStorage.removeItem(MANIFEST_KEY)
    localStorage.removeItem(ETAG_KEY)
  } catch {
    /* 忽略 */
  }
}

/**
 * 服务端全文检索（走倒排索引，能查正文并返回命中片段）。
 * @param {string} q - 查询串
 * @param {object} [opts] - { limit }
 * @returns {Promise<object>} 检索结果
 */
export function searchDocs(q, opts = {}) {
  const params = new URLSearchParams({ q })
  if (opts.limit) params.set('limit', String(opts.limit))
  return apiFetch(`/api/v1/search?${params}`)
}

/**
 * 取单份文档的元数据。
 * @param {string} id - 文档 id
 * @returns {Promise<object>} 元数据
 */
export function fetchDoc(id) {
  return apiFetch(`/api/v1/docs/${encodeURIComponent(id)}`)
}

/**
 * 取分类与标签。
 * @returns {Promise<object>} 词表
 */
export function fetchTaxonomy() {
  return apiFetch('/api/v1/taxonomy')
}
