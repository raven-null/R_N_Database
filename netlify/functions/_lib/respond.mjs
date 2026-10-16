/**
 * 统一响应封装。
 *
 * 为什么先冻结这一层：要消费这个接口的有三方（网页、工作站、博客）。
 * 你现有两个项目的响应契约并不一致（博客 `{status,message}`、
 * 图库 `{error}`），新项目被多方依赖，必须先统一成一套再往外发，
 * 并且带 /v1 版本号，日后演进才不会把工作站和博客一起打挂。
 *
 * 契约：
 *   成功 → { ok: true,  data: ... }
 *   失败 → { ok: false, error: { code, message } }
 *
 * @module netlify/functions/_lib/respond
 */

import { corsHeaders } from './cors.mjs'

/**
 * 构造 JSON 响应。
 * @param {number} status - HTTP 状态码
 * @param {object} body - 响应体
 * @param {Request} [req] - 原请求（用于 CORS 回显）
 * @param {object} [extra] - 附加响应头
 * @returns {Response} 响应
 */
function json(status, body, req, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  })
}

/**
 * 成功响应。
 * @param {*} data - 业务数据
 * @param {object} [opts] - { status, req, headers }
 * @returns {Response} 响应
 */
export function ok(data, opts = {}) {
  return json(opts.status ?? 200, { ok: true, data }, opts.req, opts.headers)
}

/**
 * 失败响应。
 * @param {string} code - 机器可读错误码（如 UNAUTHORIZED）
 * @param {string} message - 人类可读说明
 * @param {object} [opts] - { status, req, headers }
 * @returns {Response} 响应
 */
export function fail(code, message, opts = {}) {
  return json(
    opts.status ?? 500,
    { ok: false, error: { code, message } },
    opts.req,
    opts.headers,
  )
}

export const badRequest = (msg, opts = {}) => fail('BAD_REQUEST', msg, { status: 400, ...opts })
export const unauthorized = (msg = '需要访问令牌', opts = {}) => fail('UNAUTHORIZED', msg, { status: 401, ...opts })
export const forbidden = (msg = '权限不足', opts = {}) => fail('FORBIDDEN', msg, { status: 403, ...opts })
export const notFound = (msg = '资源不存在', opts = {}) => fail('NOT_FOUND', msg, { status: 404, ...opts })

/**
 * 把异常收敛成 500，同时避免把堆栈泄漏给调用方。
 * @param {Error} err - 异常
 * @param {string} scope - 出错位置（写进日志）
 * @param {object} [opts] - { req }
 * @returns {Response} 响应
 */
export function serverError(err, scope, opts = {}) {
  console.error(`[${scope}]`, err)
  const detail = err?.message ?? String(err)
  return fail('INTERNAL', `服务内部错误：${detail}`, { status: 500, ...opts })
}

/**
 * OPTIONS 预检响应。
 * @param {Request} req - 原请求
 * @returns {Response} 204 响应
 */
export function preflight(req) {
  return new Response(null, { status: 204, headers: corsHeaders(req) })
}

/**
 * 生成符合 RFC 5987 的 Content-Disposition。
 *
 * 中文文件名必须这么编码，否则浏览器下载下来是乱码
 * （只给 filename= 的话非 ASCII 字符会被丢弃或误解码）。
 * 同时保留一个 ASCII 兜底文件名给老客户端。
 *
 * @param {string} filename - 原始文件名（可含中文）
 * @param {boolean} [inline] - true 则浏览器内联预览，false 则触发下载
 * @returns {string} Content-Disposition 头值
 */
export function contentDisposition(filename, inline = false) {
  const fallback = String(filename || 'file')
    .replace(/[^\x20-\x7E]/g, '_')   // 非 ASCII 一律降级为下划线
    .replace(/["\\]/g, '_')          // 引号与反斜杠会破坏头结构
  const encoded = encodeURIComponent(String(filename || 'file'))
  const kind = inline ? 'inline' : 'attachment'
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

/**
 * 二进制/文本内容响应（原件、预览件走这里）。
 *
 * @param {BodyInit} body - 响应体（ArrayBuffer / Buffer / ReadableStream）
 * @param {object} opts - { contentType, filename, inline, req, headers, cacheControl }
 * @returns {Response} 响应
 */
export function content(body, opts = {}) {
  const headers = {
    ...corsHeaders(opts.req),
    'Content-Type': opts.contentType || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': opts.cacheControl || 'private, no-store',
    ...opts.headers,
  }
  if (opts.filename) headers['Content-Disposition'] = contentDisposition(opts.filename, opts.inline)
  return new Response(body, { status: 200, headers })
}
