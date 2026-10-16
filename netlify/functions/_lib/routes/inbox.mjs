/**
 * 路由：上传暂存区（inbox）。
 *
 *   POST   /api/v1/inbox            上传原件（原始字节，非 multipart）
 *   GET    /api/v1/inbox            待处理清单
 *   DELETE /api/v1/inbox/{id}       移除某个待处理文件
 *
 * ## 为什么是两阶段
 *
 * 网页上传只负责**把原件存下来**。真正的入库（抽正文、Office 转 PDF、
 * 分类打标）留到本地跑 `node scripts/process-pending.mjs`：
 *   - Netlify 是 Linux，没有 LibreOffice，PPT/Word 转不了 PDF
 *   - 300 页 PDF 抽正文要几秒 + 大量内存，会撞函数的时长/内存上限
 * 所以上传随时随地可用，重活留在能跑桌面软件的机器上。
 *
 * ## 为什么用原始字节而不是 multipart
 *
 * 图库项目评审记录过 base64 上传导致峰值内存放大约 4 倍的问题。
 * 直接把请求体当字节读（`await req.arrayBuffer()`）最省内存，
 * 文件名走 `?name=` 或 `X-File-Name` 头。
 *
 * @module netlify/functions/_lib/routes/inbox
 */

import { createHash, randomUUID } from 'node:crypto'
import { checkAuth } from '../auth.mjs'
import { ok, badRequest, notFound, unauthorized, forbidden, serverError } from '../respond.mjs'
import { getDocsStore, STORES } from '../store.mjs'
import { readAllMeta } from '../repo.mjs'
import { detectType, titleFromFilename, SUPPORTED_EXTENSIONS } from '../file-types.mjs'

/**
 * 单次上传体积上限。
 *
 * 受函数请求体上限约束；更大的文件请走命令行
 * （node scripts/ingest.mjs "<目录>"），那条路是直写 Blobs，没有这个限制。
 */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

/** 待处理清单最多返回多少条。 */
const LIST_LIMIT = 300

/**
 * 鉴权：上传是写操作，要求 admin。
 * @param {Request} req - 请求
 * @param {URL} url - URL
 * @returns {Promise<{auth:object, response:Response|null}>} 结果
 */
async function gate(req, url) {
  const auth = await checkAuth(req, url, 'admin')
  if (auth.ok && auth.role === 'admin') return { auth, response: null }
  return {
    auth,
    // 上传是唯一需要登录的日常操作 —— 未登录访客只会看到明确的登录提示
    response: forbidden('上传需要登录（管理员密码）', { req }),
  }
}

/**
 * 处理 /api/v1/inbox 及其子路径。
 *
 * @param {Request} req - 请求
 * @param {URL} url - URL
 * @param {string[]} seg - 「inbox」之后的路径段
 * @returns {Promise<Response>} 响应
 */
export async function inboxRoute(req, url, seg) {
  const { response } = await gate(req, url)
  if (response) return response

  try {
    // ---- DELETE /api/v1/inbox/{id} ----
    if (seg.length > 0) {
      if (req.method !== 'DELETE') return badRequest(`${req.method} 不支持`, { req })
      return removePending(req, seg[0])
    }

    if (req.method === 'GET') return listPending(req)
    if (req.method === 'POST') return receiveUpload(req, url)

    return badRequest(`${req.method} 不支持`, { req })
  } catch (err) {
    return serverError(err, 'inbox', { req })
  }
}

/**
 * 列待处理清单。
 * @param {Request} req - 请求
 * @returns {Promise<Response>} 响应
 */
async function listPending(req) {
  const store = await getDocsStore(STORES.INBOX)
  const items = await listPendingRecords(store)

  items.sort((a, b) => String(b.uploadedAt ?? '').localeCompare(String(a.uploadedAt ?? '')))

  return ok({
    total: items.length,
    items: items.slice(0, LIST_LIMIT),
    note: items.length
      ? '这些文件还在暂存区，尚未入库。在本地运行 node scripts/process-pending.mjs 完成抽取与打标。'
      : '暂存区为空。',
  }, { req })
}

/**
 * 接收一次上传。
 *
 * @param {Request} req - 请求
 * @param {URL} url - URL
 * @returns {Promise<Response>} 响应
 */
async function receiveUpload(req, url) {
  // 文件名可以走查询参数或请求头
  const rawName = url.searchParams.get('name')
    ?? req.headers.get('x-file-name')
    ?? ''
  const name = decodeURIComponent(String(rawName)).trim()

  if (!name) {
    return badRequest('缺少文件名（?name= 或 X-File-Name 请求头）', { req })
  }
  if (name.length > 200) return badRequest('文件名过长', { req })

  const type = detectType(name)
  if (!type) {
    return badRequest(`不支持的类型：${name.split('.').pop() || '(无扩展名)'}。`
      + `支持 ${SUPPORTED_EXTENSIONS.join(' / ')}`, { req })
  }

  // 体积预检：能拿到 content-length 就先拦，省得把整个 body 读进内存
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    return badRequest(`文件过大（${(declared / 1024 / 1024).toFixed(1)}MB），`
      + `单次上限 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB。`
      + '更大的文件请用命令行入库：node scripts/ingest.mjs "<目录>"', { req })
  }

  let buf
  try {
    buf = Buffer.from(await req.arrayBuffer())
  } catch {
    return badRequest('读取请求体失败', { req })
  }

  if (buf.length === 0) return badRequest('请求体为空', { req })
  if (buf.length > MAX_UPLOAD_BYTES) {
    return badRequest(`文件过大（${(buf.length / 1024 / 1024).toFixed(1)}MB），`
      + `单次上限 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB`, { req })
  }

  const sha256 = createHash('sha256').update(buf).digest('hex')

  const store = await getDocsStore(STORES.INBOX)

  // 已在库里的同一内容不必再传 —— 入库时也会按内容哈希去重
  const existing = (await readAllMeta().catch(() => []))
    .find((d) => d.sha256 === sha256 || d.id === sha256.slice(0, 12))

  // 暂存区里已有同样内容也别再存一份：同一文件重复上传很常见
  const pendingDup = (await listPendingRecords(store))
    .find((m) => m.sha256 === sha256)

  const id = randomUUID().replace(/-/g, '').slice(0, 16)
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : 'bin'
  await store.set(`file/${id}.${ext}`, buf)

  const record = {
    id,
    originalName: name,
    title: titleFromFilename(name),
    type,
    ext,
    size: buf.length,
    sha256,
    uploadedAt: new Date().toISOString(),
    status: 'pending',
  }
  await store.set(`meta/${id}`, JSON.stringify(record))

  return ok({
    ...record,
    alreadyInLibrary: existing
      ? { id: existing.id, title: existing.title }
      : null,
    alreadyPending: pendingDup
      ? { id: pendingDup.id, originalName: pendingDup.originalName }
      : null,
    note: existing
      ? `库里已有同样内容：「${existing.title}」（id ${existing.id}），入库时会按哈希去重。`
      : pendingDup
        ? `暂存区里已有同样内容（${pendingDup.originalName}），这份入库时也会按哈希去重。`
        : '已存入暂存区。在本地运行 node scripts/process-pending.mjs 完成入库。',
  }, { req })
}

/**
 * 读暂存区里的全部记录（内部用）。
 * @param {object} store - inbox store
 * @returns {Promise<object[]>} 记录列表
 */
async function listPendingRecords(store) {
  const items = []
  let cursor
  for (let round = 0; round < 20; round++) {
    const page = await store.list({ prefix: 'meta/', limit: 500, cursor })
    for (const blob of page.blobs ?? []) {
      const m = await store.get(blob.key, { type: 'json' }).catch(() => null)
      if (m) items.push(m)
    }
    cursor = page.nextCursor ?? page.cursor
    if (!cursor) break
  }
  return items
}

/**
 * 移除一个待处理文件。
 *
 * @param {Request} req - 请求
 * @param {string} id - 待处理 id
 * @returns {Promise<Response>} 响应
 */
async function removePending(req, id) {
  const store = await getDocsStore(STORES.INBOX)

  const meta = await store.get(`meta/${id}`, { type: 'json' }).catch(() => null)
  if (!meta) return notFound('待处理项不存在', { req })

  // 原件的 key 带扩展名，按前缀找
  for (const prefix of [`file/${id}.`, `file/${id}`]) {
    const listed = await store.list({ prefix }).catch(() => ({ blobs: [] }))
    for (const blob of listed.blobs ?? []) {
      await store.delete(blob.key).catch(() => {})
    }
  }
  await store.delete(`meta/${id}`).catch(() => {})

  return ok({ removed: id, title: meta.title }, { req })
}
