/**
 * 路由：/api/v1/docs —— 列表、详情、原件、预览件、正文。
 *
 * 路径解析放在这里（而不是依赖框架的路由参数），
 * 因此本地 dev-server 与线上 Netlify 的行为完全一致。
 *
 * @module netlify/functions/_lib/routes/docs
 */

import { checkAuth } from '../auth.mjs'
import {
  ok, badRequest, notFound, unauthorized, forbidden, serverError, content,
} from '../respond.mjs'
import {
  readAllMeta, readMeta, readDocFile, readPreview, readDocText, tally,
} from '../repo.mjs'

/** 允许的排序方式。 */
const SORTS = {
  recent: (a, b) => String(b.ingestedAt ?? '').localeCompare(String(a.ingestedAt ?? '')),
  oldest: (a, b) => String(a.ingestedAt ?? '').localeCompare(String(b.ingestedAt ?? '')),
  title: (a, b) => String(a.title ?? '').localeCompare(String(b.title ?? ''), 'zh-CN'),
  size: (a, b) => (b.size ?? 0) - (a.size ?? 0),
  name: (a, b) => String(a.originalName ?? '').localeCompare(String(b.originalName ?? ''), 'zh-CN'),
}

/** 默认每页数量。 */
const DEFAULT_LIMIT = 50
/** 每页上限，防止一次拉爆。 */
const MAX_LIMIT = 200

/**
 * 处理 /api/v1/docs 及其子路径。
 *
 * @param {Request} req - 请求
 * @param {URL} url - URL
 * @param {string[]} seg - 「docs」之后的路径段
 * @returns {Promise<Response>} 响应
 */
export async function docsRoute(req, url, seg) {
  const auth = await checkAuth(req, url, 'read')
  if (!auth.ok) {
    return auth.failClosed
      ? forbidden('服务端尚未配置访问密码，已拒绝所有访问（fail-closed）', { req })
      : unauthorized(describeAuthFailure(auth.reason), { req })
  }

  try {
    // /api/v1/docs
    if (seg.length === 0) return listDocs(req, url, auth)

    const id = seg[0]
    const action = seg[1]

    // /api/v1/docs/{id}
    if (!action) return detail(req, id, auth)
    // /api/v1/docs/{id}/file
    if (action === 'file') return originalFile(req, url, id, auth)
    // /api/v1/docs/{id}/preview
    if (action === 'preview') return preview(req, url, id, auth)
    // /api/v1/docs/{id}/text
    if (action === 'text') return docText(req, url, id, auth)

    return notFound(`未知子路径：${action}`, { req })
  } catch (err) {
    return serverError(err, 'docs', { req })
  }
}

/**
 * 把鉴权失败原因转成给用户看的话。
 * @param {string} reason - 原因码
 * @returns {string} 说明
 */
function describeAuthFailure(reason) {
  if (reason === 'NO_TOKEN') return '需要访问令牌（请求头 X-Auth-Token 或 ?token=）'
  if (reason === 'BAD_TOKEN') return '访问令牌无效'
  if (reason === 'INSUFFICIENT_ROLE') return '当前令牌权限不足'
  return '未通过鉴权'
}

/**
 * guest 角色只能看到显式标记为公开的文档。
 * @param {object[]} docs - 文档列表
 * @param {object} auth - 鉴权结果
 * @returns {object[]} 过滤后的列表
 */
function applyRoleFilter(docs, auth) {
  if (auth.role !== 'guest') return docs
  return docs.filter((d) => d.visibility === 'public')
}

/**
 * GET /api/v1/docs —— 列表 + 筛选。
 * @param {Request} req - 请求
 * @param {URL} url - URL
 * @param {object} auth - 鉴权结果
 * @returns {Promise<Response>} 响应
 */
async function listDocs(req, url, auth) {
  const p = url.searchParams
  let docs = applyRoleFilter(await readAllMeta(), auth)

  // ---- 筛选 ----
  const q = (p.get('q') ?? '').trim().toLowerCase()
  if (q) {
    docs = docs.filter((d) => {
      const hay = [
        d.title, d.originalName, d.summary, d.author,
        ...(d.tags ?? []), ...(d.categories ?? []),
      ].filter(Boolean).join(' ').toLowerCase()
      return hay.includes(q)
    })
  }

  const category = p.get('category')
  if (category) docs = docs.filter((d) => (d.categories ?? []).includes(category))

  const tag = p.get('tag')
  if (tag) docs = docs.filter((d) => (d.tags ?? []).includes(tag))

  const type = p.get('type')
  if (type) docs = docs.filter((d) => d.type === type)

  const review = p.get('review')
  if (review === '1') docs = docs.filter((d) => d.needsReview)

  // ---- 排序 ----
  const sortKey = p.get('sort') ?? 'recent'
  const sorter = SORTS[sortKey] ?? SORTS.recent
  docs = [...docs].sort(sorter)

  // ---- 分页 ----
  const total = docs.length
  const limit = Math.min(Math.max(Number(p.get('limit')) || DEFAULT_LIMIT, 1), MAX_LIMIT)
  const page = Math.max(Number(p.get('page')) || 1, 1)
  const start = (page - 1) * limit
  const items = docs.slice(start, start + limit).map(toListItem)

  return ok({
    total,
    page,
    limit,
    pageCount: Math.max(Math.ceil(total / limit), 1),
    sort: sortKey,
    facets: tally(applyRoleFilter(await readAllMeta(), auth)),
    items,
  }, { req })
}

/**
 * 元数据 → 列表项（去掉不必要的大字段）。
 * @param {object} d - 元数据
 * @returns {object} 列表项
 */
function toListItem(d) {
  return {
    id: d.id,
    title: d.title,
    originalName: d.originalName,
    type: d.type,
    ext: d.ext,
    size: d.size,
    pages: d.pages,
    author: d.author,
    categories: d.categories ?? [],
    tags: d.tags ?? [],
    summary: d.summary ?? '',
    hasText: Boolean(d.hasText),
    needsReview: Boolean(d.needsReview),
    previewKind: d.previewKind,
    ingestedAt: d.ingestedAt,
    docCreatedAt: d.docCreatedAt,
  }
}

/**
 * GET /api/v1/docs/{id} —— 详情。
 * @param {Request} req - 请求
 * @param {string} id - 文档 id
 * @param {object} auth - 鉴权结果
 * @returns {Promise<Response>} 响应
 */
async function detail(req, id, auth) {
  const meta = await readMeta(id)
  if (!meta) return notFound('文档不存在', { req })
  if (auth.role === 'guest' && meta.visibility !== 'public') {
    return forbidden('该文档未公开', { req })
  }
  return ok(meta, { req })
}

/**
 * GET /api/v1/docs/{id}/file —— 原件（下载或内联）。
 *
 * @param {Request} req - 请求
 * @param {URL} url - URL
 * @param {string} id - 文档 id
 * @param {object} auth - 鉴权结果
 * @returns {Promise<Response>} 响应
 */
async function originalFile(req, url, id, auth) {
  const meta = await readMeta(id)
  if (!meta) return notFound('文档不存在', { req })
  if (auth.role === 'guest' && meta.visibility !== 'public') {
    return forbidden('该文档未公开', { req })
  }

  const body = await readDocFile(meta)
  if (!body) return notFound('原件缺失（可能入库时未写入）', { req })

  const inline = url.searchParams.get('inline') === '1'

  return content(body, {
    req,
    contentType: meta.mime || 'application/octet-stream',
    filename: meta.originalName || `${meta.title}.${meta.ext}`,
    inline,
    // 内容寻址（文件名即内容哈希）→ 可以放心让浏览器长期缓存。
    // 但原件是私有的，只允许私有缓存，不给 CDN。
    cacheControl: 'private, max-age=31536000, immutable',
  })
}

/**
 * GET /api/v1/docs/{id}/preview —— 预览件。
 *
 * PDF 直接回原件（浏览器原生渲染器是最好的 PDF 阅读器）；
 * 转换来的 PDF 与 HTML 降级件存在预览 store 里。
 *
 * @param {Request} req - 请求
 * @param {URL} url - URL
 * @param {string} id - 文档 id
 * @param {object} auth - 鉴权结果
 * @returns {Promise<Response>} 响应
 */
async function preview(req, url, id, auth) {
  const meta = await readMeta(id)
  if (!meta) return notFound('文档不存在', { req })
  if (auth.role === 'guest' && meta.visibility !== 'public') {
    return forbidden('该文档未公开', { req })
  }

  // PDF：原件即预览件
  if (meta.type === 'pdf') {
    const body = await readDocFile(meta)
    if (!body) return notFound('原件缺失', { req })
    return content(body, {
      req,
      contentType: 'application/pdf',
      filename: meta.originalName,
      inline: true,
      cacheControl: 'private, max-age=31536000, immutable',
    })
  }

  // 转换得到的 PDF 预览件
  if (meta.previewKind === 'pdf') {
    const p = await readPreview(id, 'pdf')
    if (p) {
      return content(p.body, {
        req,
        contentType: 'application/pdf',
        filename: `${meta.title}.pdf`,
        inline: true,
        cacheControl: 'private, max-age=31536000, immutable',
      })
    }
  }

  // HTML 降级预览件
  if (meta.previewKind === 'html') {
    const p = await readPreview(id, 'html')
    if (p) {
      return content(p.body, {
        req,
        contentType: p.contentType,
        inline: true,
        // HTML 预览页在 iframe 里加载，用 sandbox 隔离更稳妥，
        // 这里通过响应头限制其能力
        headers: { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:;" },
        cacheControl: 'private, max-age=31536000, immutable',
      })
    }
  }

  // 纯文本：直接把抽取的正文包成简单 HTML
  const text = await readDocText(id)
  if (text?.pages?.length) {
    const body = `<pre style="white-space:pre-wrap;word-break:break-word;font:14px/1.7 ui-monospace,Consolas,monospace;margin:0;padding:20px">${
      escapeHtml(text.pages.join('\n\n'))
    }</pre>`
    return content(body, {
      req,
      contentType: 'text/html; charset=utf-8',
      cacheControl: 'private, no-store',
    })
  }

  return notFound('该文档没有可用的预览件（可能是纯图片扫描件或旧版 Office 格式）', { req })
}

/**
 * GET /api/v1/docs/{id}/text —— 抽取的正文（给 AI 与检索用）。
 * @param {Request} req - 请求
 * @param {URL} url - URL
 * @param {string} id - 文档 id
 * @param {object} auth - 鉴权结果
 * @returns {Promise<Response>} 响应
 */
async function docText(req, url, id, auth) {
  const meta = await readMeta(id)
  if (!meta) return notFound('文档不存在', { req })
  if (auth.role === 'guest' && meta.visibility !== 'public') {
    return forbidden('该文档未公开', { req })
  }

  const text = await readDocText(id)
  if (!text) {
    return ok({
      id,
      title: meta.title,
      hasText: false,
      charCount: 0,
      pages: [],
      note: meta.extractError || '该文档没有抽取到正文',
    }, { req })
  }

  const pages = text.pages ?? []
  const maxChars = Number(url.searchParams.get('maxChars')) || 0
  let out = pages
  let truncated = false

  if (maxChars > 0) {
    const joined = pages.join('\n\n')
    if (joined.length > maxChars) {
      out = [joined.slice(0, maxChars)]
      truncated = true
    }
  }

  return ok({
    id,
    title: meta.title,
    hasText: true,
    charCount: pages.join('').length,
    pageCount: pages.length,
    truncated,
    pages: out,
  }, { req })
}

/**
 * HTML 转义。
 * @param {string} s - 原文
 * @returns {string} 转义结果
 */
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
