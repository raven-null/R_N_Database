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
  readAllMeta, readMeta, readDocFile, readPreview, readDocText, readTaxonomy, tally,
} from '../repo.mjs'
import { applyDocChange } from '../index-store.mjs'
import { getDocsStore, STORES } from '../store.mjs'
import { looksLikePinyin, matchesPinyin } from '../pinyin-match.mjs'
import { renderSourcePage } from '../source-view.mjs'

/**
 * HTML 预览件的 CSP。
 *
 * 预览页是**用户文档内容**渲染出来的，必须当作不可信内容对待：
 * 禁掉脚本与外部资源，只放行内联样式与 data: 图片。
 * （iframe 上还有 sandbox，两层防护。）
 */
const HTML_PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:;"

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
  // 读只要 guest（未登录访客即可，但只会看到标记为 public 的文档）；
  // 写必须是 admin —— read 令牌是给工作站和博客的，不该能改资料
  const isWrite = req.method === 'PATCH' || req.method === 'DELETE' || req.method === 'POST'
  const auth = await checkAuth(req, url, isWrite ? 'admin' : 'guest')

  if (!auth.ok) {
    return isWrite
      ? forbidden('上传与修改需要登录（管理员密码）', { req })
      : unauthorized(describeAuthFailure(auth.reason), { req })
  }

  try {
    // /api/v1/docs
    if (seg.length === 0) {
      if (req.method !== 'GET') return badRequest('列表接口只接受 GET', { req })
      return listDocs(req, url, auth)
    }

    const id = seg[0]
    const action = seg[1]

    // /api/v1/docs/{id}
    if (!action) {
      if (req.method === 'PATCH') return updateDoc(req, id, auth)
      if (req.method === 'DELETE') return removeDoc(req, id, auth)
      if (req.method !== 'GET') return badRequest(`${req.method} 不支持`, { req })
      return detail(req, id, auth)
    }

    if (req.method !== 'GET') return badRequest(`${req.method} 不支持`, { req })

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

/* ============================================================
   写操作
   ============================================================ */

/** 允许通过 API 修改的字段白名单。 */
const EDITABLE = ['title', 'categories', 'tags', 'summary', 'visibility', 'author', 'docCreatedAt']

/** 标签长度与数量上限（与批量接口保持一致）。 */
const MAX_TAG_LEN = 20
const MAX_TAGS_PER_DOC = 12

/**
 * PATCH /api/v1/docs/{id} —— 修改元数据。
 *
 * 只改元数据，不动原件与正文。索引走增量更新（只读改写受影响的分片），
 * 不重建全库 —— 全量索引 256 份文档已 6.23MB，每次都重建不可接受。
 *
 * 人工编辑过的文档会清掉 needsReview：「待复查」的意思是"机器没把握，
 * 等人确认"，人确认过了就该出队。
 *
 * @param {Request} req - 请求
 * @param {string} id - 文档 id
 * @param {object} auth - 鉴权结果
 * @returns {Promise<Response>} 响应
 */
async function updateDoc(req, id, auth) {
  const oldMeta = await readMeta(id)
  if (!oldMeta) return notFound('文档不存在', { req })

  let body
  try {
    body = await req.json()
  } catch {
    return badRequest('请求体不是合法 JSON', { req })
  }

  const patch = {}
  for (const key of EDITABLE) {
    if (body?.[key] !== undefined) patch[key] = body[key]
  }
  if (Object.keys(patch).length === 0) {
    return badRequest(`没有可修改的字段。允许的字段：${EDITABLE.join(', ')}`, { req })
  }

  // 校验
  const taxonomy = await readTaxonomy()
  const validCats = new Set((taxonomy?.categories ?? []).map((c) => c.name))

  if (patch.title !== undefined) {
    const t = String(patch.title).trim()
    if (!t) return badRequest('标题不能为空', { req })
    patch.title = t.slice(0, 200)
  }
  if (patch.categories !== undefined) {
    if (!Array.isArray(patch.categories)) return badRequest('categories 必须是数组', { req })
    const cats = patch.categories.map((c) => String(c).trim()).filter(Boolean)
    const bad = cats.filter((c) => !validCats.has(c))
    if (bad.length) {
      return badRequest(`分类必须来自词表，不认识：${bad.join('、')}`, { req })
    }
    patch.categories = [...new Set(cats)].slice(0, 3)
    if (patch.categories.length === 0) patch.categories = ['未归类']
  }
  if (patch.tags !== undefined) {
    if (!Array.isArray(patch.tags)) return badRequest('tags 必须是数组', { req })
    const tags = [...new Set(patch.tags.map((t) => String(t).trim()).filter(Boolean))]
    // 过长报错而不是静默截断：截断会让用户看到的标签名和输入的对不上
    const tooLong = tags.filter((t) => [...t].length > MAX_TAG_LEN)
    if (tooLong.length) {
      return badRequest(`标签过长（上限 ${MAX_TAG_LEN} 个字符）：${tooLong.join('、')}`, { req })
    }
    if (tags.length > MAX_TAGS_PER_DOC) {
      return badRequest(`标签最多 ${MAX_TAGS_PER_DOC} 个（当前 ${tags.length} 个）`, { req })
    }
    patch.tags = tags
  }
  if (patch.summary !== undefined) patch.summary = String(patch.summary).slice(0, 600)
  if (patch.visibility !== undefined) {
    patch.visibility = patch.visibility === 'public' ? 'public' : 'private'
  }

  const now = new Date().toISOString()
  const newMeta = {
    ...oldMeta,
    ...patch,
    // 人工编辑过就不再是"待复查"
    needsReview: false,
    classifySource: oldMeta.classifySource === 'ai' || oldMeta.classifySource === 'rules'
      ? `${oldMeta.classifySource}+manual`
      : 'manual',
    editedAt: now,
    updatedAt: now,
  }

  const metaStore = await getDocsStore(STORES.META)
  await metaStore.set(id, JSON.stringify(newMeta))

  // 增量更新索引（标题/标签/分类/摘要都参与索引）
  let indexResult = null
  let indexError = null
  try {
    indexResult = await applyDocChange({ oldMeta, newMeta })
  } catch (err) {
    indexError = String(err?.message ?? err)
  }

  return ok({
    doc: newMeta,
    index: indexResult,
    indexError,
    note: indexError
      ? '元数据已保存，但索引更新失败 —— 检索结果可能暂时不准，可在本地运行 node scripts/reindex.mjs 修复。'
      : '元数据与索引均已更新。',
  }, { req })
}

/**
 * DELETE /api/v1/docs/{id} —— 删除文档（原件、预览件、正文、元数据、索引）。
 *
 * @param {Request} req - 请求
 * @param {string} id - 文档 id
 * @param {object} auth - 鉴权结果
 * @returns {Promise<Response>} 响应
 */
async function removeDoc(req, id, auth) {
  const meta = await readMeta(id)
  if (!meta) return notFound('文档不存在', { req })

  const filesStore = await getDocsStore(STORES.FILES)
  const previewStore = await getDocsStore(STORES.PREVIEWS)
  const textStore = await getDocsStore(STORES.TEXT)
  const metaStore = await getDocsStore(STORES.META)

  // 原件 key 带扩展名，按前缀找更稳妥
  const listed = await filesStore.list({ prefix: `${id}.` }).catch(() => ({ blobs: [] }))
  for (const blob of listed.blobs ?? []) {
    await filesStore.delete(blob.key).catch(() => {})
  }

  await Promise.all([
    filesStore.delete(id).catch(() => {}),
    previewStore.delete(`${id}.html`).catch(() => {}),
    previewStore.delete(`${id}.pdf`).catch(() => {}),
    textStore.delete(id).catch(() => {}),
    metaStore.delete(id).catch(() => {}),
  ])

  let indexResult = null
  let indexError = null
  try {
    indexResult = await applyDocChange({ oldMeta: meta, newMeta: null })
  } catch (err) {
    indexError = String(err?.message ?? err)
  }

  return ok({
    deleted: id,
    title: meta.title,
    index: indexResult,
    indexError,
  }, { req })
}

/**
 * 把鉴权失败原因转成给用户看的话。
 * @param {string} reason - 原因码
 * @returns {string} 说明
 */
function describeAuthFailure(reason) {
  if (reason === 'NO_TOKEN' || reason === 'ANONYMOUS') return '需要访问令牌'
  if (reason === 'BAD_TOKEN') return '访问令牌无效'
  if (reason === 'INSUFFICIENT_ROLE') return '当前身份权限不足（未登录只能看已标记公开的文档）'
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
    // 拼音：纯 ASCII 查询额外匹配预算好的拼音串（jlxz → 简历第一版）
    const pinyin = looksLikePinyin(q)
    docs = docs.filter((d) => {
      if (pinyin && matchesPinyin(d, q)) return true
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
    pinyin: d.pinyin ?? null,
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
 * 转换来的 PDF、Markdown 渲染件与 HTML 降级件存在预览 store 里。
 *
 * ★ 缓存策略按「URL 是否带版本号」分档：
 * 预览件是**派生**产物，会被重新生成，而 URL 里的 id 是**原件**的内容哈希
 * —— 预览件换了它不变。早期版本在这条路径上无脑标 immutable，
 * 结果浏览器把旧的 HTML 降级版本缓存一年：装好 LibreOffice 重新生成
 * PDF 预览后，用户看到的还是旧文字版，以为"和以前没区别"。
 *
 * 因此：带 ?v=（URL 已随预览件版本变化）→ 可长缓存；
 *       不带 → 必须回源校验，避免旧书签永久卡在旧内容上。
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

  const VERSIONED_CACHE = url.searchParams.has('v')
    ? 'private, max-age=31536000, immutable'
    : 'private, no-cache'

  // PDF：原件即预览件
  if (meta.type === 'pdf') {
    const body = await readDocFile(meta)
    if (!body) return notFound('原件缺失', { req })
    return content(body, {
      req,
      contentType: 'application/pdf',
      filename: meta.originalName,
      inline: true,
      cacheControl: VERSIONED_CACHE,
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
        cacheControl: VERSIONED_CACHE,
      })
    }
  }

  // Markdown：双视图（渲染 / 源码）
  if (meta.previewKind === 'markdown') {
    const mode = url.searchParams.get('mode') === 'source' ? 'source' : 'render'

    if (mode === 'source') {
      // ★ 源码视图读**原件**，而不是抽取出来的正文。
      // 抽取时 cleanText 会压缩连续空格、去掉行首缩进、把多个空行并成一个 ——
      // 那对检索无害，但会把代码缩进和列表层级毁掉，看源码就失真了。
      // 原件本来就存在 doc-files 里，直接取原始字节最忠实。
      const buf = await readDocFile(meta)
      if (!buf) return notFound('原件缺失，无法显示源码', { req })
      const source = Buffer.from(buf).toString('utf8')

      return content(renderSourcePage(source, meta.title), {
        req,
        contentType: 'text/html; charset=utf-8',
        headers: { 'Content-Security-Policy': HTML_PREVIEW_CSP },
        // 按需生成、成本低，不做长期缓存，避免与原件更新脱节
        cacheControl: 'private, no-cache',
      })
    }

    const p = await readPreview(id, 'html')
    if (p) {
      return content(p.body, {
        req,
        contentType: p.contentType,
        inline: true,
        headers: { 'Content-Security-Policy': HTML_PREVIEW_CSP },
        cacheControl: VERSIONED_CACHE,
      })
    }
    return notFound('渲染件缺失，请重新入库该文档', { req })
  }

  // HTML 降级预览件
  if (meta.previewKind === 'html') {
    const p = await readPreview(id, 'html')
    if (p) {
      return content(p.body, {
        req,
        contentType: p.contentType,
        inline: true,
        headers: { 'Content-Security-Policy': HTML_PREVIEW_CSP },
        cacheControl: VERSIONED_CACHE,
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
