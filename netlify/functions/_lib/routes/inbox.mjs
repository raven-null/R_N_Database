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
 * 单次 **HTTP 请求**的请求体上限。
 *
 * ★ Netlify Functions 的请求体上限是 **6 MB**（平台限制，超了直接返回
 * HTTP 413，请求根本进不到这段代码里）。这里取 4 MB 留余量。
 *
 * 这个数字曾经写错成 20MB —— 本地 dev-server 没有平台限制，
 * 一切都好；一上线，凡是超过 6MB 的文件全部 413，
 * 而我们的检查又"通过"了，用户只看到"响应不是 JSON（HTTP 413）"。
 * 现在：超过这个数的走**分片上传**（见下方 CHUNK_SIZE）。
 */
const MAX_SINGLE_BYTES = 4 * 1024 * 1024

/** 分片大小。客户端与服务端必须一致。 */
const CHUNK_SIZE = 4 * 1024 * 1024

/**
 * 单个文件的上限（走分片）。
 *
 * Blobs 单对象上限是 5 GB，所以卡的是函数内存与体验：100MB 已经是
 * 个人资料里很大的文件了，再大就该用命令行直写（没有这个限制）。
 */
const MAX_FILE_BYTES = 100 * 1024 * 1024

/** 最多多少个分片（防止用无限 uploadId 灌垃圾）。 */
const MAX_CHUNKS = Math.ceil(MAX_FILE_BYTES / CHUNK_SIZE)

/** 分片多久没齐就作废（毫秒）。 */
const CHUNK_TTL_MS = 6 * 60 * 60 * 1000

/** 待处理清单最多返回多少条。 */
const LIST_LIMIT = 300

/** 相对路径（整目录上传时保留目录结构）的长度与层数上限。 */
const MAX_PATH_LEN = 400
const MAX_PATH_DEPTH = 12

/**
 * 规整客户端传来的相对路径。
 *
 * 整个文件夹上传时，浏览器会给每个文件一个 `webkitRelativePath`
 * （形如 `合同/2025/xx.pdf`）。保留这层信息有两个用处：
 *   1. 暂存区里能看清这份文件原本在哪个目录（同名文件不再混淆）
 *   2. 入库时写进 `sourcePath`，日后能追溯来源
 *
 * 但它是**客户端提供的字符串**，必须当作不可信输入：
 * 去掉 `\`、`.`, 拒绝 `..`（防路径穿越），限制长度与层数。
 * 任何不合规的段直接丢弃该文件而不是默默改写路径 —— 改写会让人
 * 以为传的是 A 目录，实际进库记成了 B。
 *
 * @param {string} raw - 原始相对路径
 * @returns {string|null} 规整后的路径；非法时返回 null
 */
function normalizeRelPath(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return ''

  let decoded
  try {
    decoded = decodeURIComponent(s)
  } catch {
    return null   // 非法百分号编码
  }

  if (decoded.length > MAX_PATH_LEN) return null
  if (decoded.includes('\0')) return null

  const parts = decoded.replace(/\\/g, '/').split('/').filter((p) => p && p !== '.')
  if (parts.length > MAX_PATH_DEPTH) return null
  // `..` 一律拒绝：宁可报错，也不要把用户的文件记到一个越界的路径上
  if (parts.some((p) => p === '..')) return null
  // 去掉控制字符（换行、制表符在路径里只会是脏数据）
  if (parts.some((p) => /[\u0000-\u001F\u007F]/.test(p))) return null

  return parts.join('/')
}

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
    // ---- POST /api/v1/inbox/check ----
    // 整目录「增量同步」用：客户端先算出每个文件的 SHA-256，来这里比对，
    // 只有没见过的内容才需要真的上传。
    if (seg.length === 1 && seg[0] === 'check') {
      if (req.method !== 'POST') return badRequest('比对接口只接受 POST', { req })
      return checkBatch(req)
    }

    // ---- 分片上传（大文件绕开 6MB 请求体上限）----
    //   POST   /api/v1/inbox/chunk             传一个分片
    //   POST   /api/v1/inbox/chunk/complete    合流成整份文件
    //   DELETE /api/v1/inbox/chunk?uploadId=   放弃这次上传
    if (seg[0] === 'chunk') {
      if (seg.length === 2 && seg[1] === 'complete') {
        if (req.method !== 'POST') return badRequest('合流接口只接受 POST', { req })
        return completeChunks(req, url)
      }
      if (seg.length === 1) {
        if (req.method === 'POST') return receiveChunk(req, url)
        if (req.method === 'DELETE') return abortChunks(req, url)
        return badRequest(`${req.method} 不支持`, { req })
      }
      return notFound(`未知子路径：${seg.join('/')}`, { req })
    }

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

/** 一次比对最多接受多少个文件。 */
const MAX_CHECK_FILES = 2000

/**
 * 批量比对：这些文件里哪些需要真的上传。
 *
 * ## 为什么需要这个接口
 *
 * 整个文件夹重传一遍是浪费：几百份文件里可能只改了两个。
 * 但「有没有变」只有**内容哈希**说了算。于是让浏览器先在本地算
 * SHA-256（原生 `crypto.subtle`，一个字节都不传），再来这里问：
 *   - 库里已经有这个内容        → 不用传（`unchanged`）
 *   - 暂存区已经有这个内容      → 不用传（`pending`）
 *   - 同一路径在库里、内容变了  → 要传，入库时会**替换**（`replace`）
 *   - 路径也没见过              → 要传，是新增（`new`）
 *
 * 顺带回答一个用户迟早会问的问题：**删掉的文件怎么办**。
 * 传了 `root` 就返回「库里在这个根目录下、但这次没出现的文档」，
 * 只报告不动手 —— 自动删除是危险动作，得由人来决定。
 *
 * @param {Request} req - 请求
 * @returns {Promise<Response>} 响应
 */
async function checkBatch(req) {
  let body
  try {
    body = await req.json()
  } catch {
    return badRequest('请求体不是合法 JSON（应为 { files: [{hash, path}], root? }）', { req })
  }

  const files = Array.isArray(body?.files) ? body.files : null
  if (!files) return badRequest('缺少 files 数组', { req })
  if (files.length > MAX_CHECK_FILES) {
    return badRequest(`一次最多比对 ${MAX_CHECK_FILES} 个文件（收到 ${files.length} 个）`, { req })
  }

  const store = await getDocsStore(STORES.INBOX)
  const [allMeta, pendingRecords] = await Promise.all([
    readAllMeta().catch(() => []),
    listPendingRecords(store),
  ])

  /** 内容哈希 → 库里的文档 */
  const byHash = new Map()
  /** 来源路径 → 库里的文档（用于区分「替换」与「新增」） */
  const byPath = new Map()
  for (const d of allMeta) {
    if (d.sha256) byHash.set(d.sha256, d)
    if (d.sourcePath) byPath.set(String(d.sourcePath), d)
  }

  /** 内容哈希 → 暂存区记录 */
  const pendingByHash = new Map()
  for (const r of pendingRecords) {
    if (r.sha256) pendingByHash.set(r.sha256, r)
  }

  const seenPaths = new Set()
  const items = files.map((f) => {
    const hash = String(f?.hash ?? '').toLowerCase()
    const relPath = normalizeRelPath(f?.path) || ''
    const uploadPath = relPath ? `upload://${relPath}` : ''
    if (uploadPath) seenPaths.add(uploadPath)

    const doc = byHash.get(hash)
    if (doc) {
      const samePath = uploadPath && doc.sourcePath === uploadPath
      return {
        hash,
        path: relPath,
        status: 'unchanged',
        docId: doc.id,
        title: doc.title,
        // 内容一样但路径不同：入库时会复用同一个文档，只是补一条路径映射
        movedFrom: samePath ? undefined : (doc.sourcePath || undefined),
      }
    }

    const pending = pendingByHash.get(hash)
    if (pending) return { hash, path: relPath, status: 'pending', pendingId: pending.id }

    const samePath = uploadPath ? byPath.get(uploadPath) : null
    if (samePath) {
      return { hash, path: relPath, status: 'replace', docId: samePath.id, title: samePath.title }
    }
    return { hash, path: relPath, status: 'new' }
  })

  // 可选：这个根目录下、库里存在但这次没出现的文档（可能被删或改名）
  const root = normalizeRelPath(body?.root) || ''
  let missing = []
  if (root) {
    const prefix = `upload://${root}/`
    missing = allMeta
      .filter((d) => String(d.sourcePath ?? '').startsWith(prefix))
      .filter((d) => !seenPaths.has(String(d.sourcePath)))
      .map((d) => ({
        id: d.id,
        path: String(d.sourcePath).slice('upload://'.length),
        title: d.title,
      }))
  }

  const stats = items.reduce((acc, it) => {
    acc[it.status] = (acc[it.status] ?? 0) + 1
    return acc
  }, {})

  return ok({
    total: items.length,
    stats,
    toUpload: items.filter((it) => it.status === 'new' || it.status === 'replace').length,
    items,
    missing,
    note: 'status: unchanged=库里已有同内容 / pending=暂存区已有 / replace=同路径内容变了 / new=新增',
  }, { req })
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
 * 解析并校验文件名与相对路径。
 *
 * @param {Request} req - 请求
 * @param {URL} url - URL
 * @returns {{name:string, relPath:string, error:Response|null}} 结果
 */
function parseNameAndPath(req, url) {
  // 文件名可以走查询参数或请求头
  const rawName = url.searchParams.get('name')
    ?? req.headers.get('x-file-name')
    ?? ''
  const decodedName = decodeURIComponent(String(rawName)).trim()

  // ★ 只取最后一段。浏览器总是只发文件名，但这是个**不可信输入**：
  // 允许 `..` 或分隔符进来，它会一路流到 originalName、下载文件名
  // 与本地临时文件路径上。取末段最省事也最安全。
  const name = decodedName.split(/[\\/]/).pop().trim()

  if (!name) {
    return { name: '', relPath: '', error: badRequest('缺少文件名（?name= 或 X-File-Name 请求头）', { req }) }
  }
  if (name.length > 200) {
    return { name, relPath: '', error: badRequest('文件名过长', { req }) }
  }

  const type = detectType(name)
  if (!type) {
    return {
      name,
      relPath: '',
      error: badRequest(`不支持的类型：${name.split('.').pop() || '(无扩展名)'}。`
        + `支持 ${SUPPORTED_EXTENSIONS.join(' / ')}`, { req }),
    }
  }

  // 整目录上传时带上相对路径（`合同/2025/xx.pdf`）。可选：单文件上传没有。
  const pathRaw = url.searchParams.get('path')
  const relPath = normalizeRelPath(pathRaw)
  if (relPath === null) {
    return {
      name,
      relPath: '',
      error: badRequest(`相对路径不合法：${String(pathRaw).slice(0, 80)}`, { req }),
    }
  }
  if (relPath && !relPath.endsWith(name)) {
    return {
      name,
      relPath,
      error: badRequest(`相对路径与文件名对不上（路径「${relPath}」，文件名「${name}」）`, { req }),
    }
  }

  return { name, relPath, error: null }
}

/**
 * 把一份完整的原件写进暂存区（单次上传与分片合流共用）。
 *
 * @param {Request} req - 请求
 * @param {string} name - 文件名
 * @param {string} relPath - 相对路径（可为空）
 * @param {Buffer} buf - 完整内容
 * @returns {Promise<Response>} 响应
 */
async function saveUpload(req, name, relPath, buf) {
  const sha256 = createHash('sha256').update(buf).digest('hex')

  const store = await getDocsStore(STORES.INBOX)

  // 已在库里的同一内容不必再存 —— 入库时也会按内容哈希去重
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
    // 目录结构（整目录上传才有）；单文件上传时不存在
    relativePath: relPath && relPath !== name ? relPath : undefined,
    title: titleFromFilename(name),
    type: detectType(name),
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
 * 接收一次上传（整份文件一次传完）。
 *
 * 只适用于 ≤ MAX_SINGLE_BYTES 的文件 —— 再大就撞 Netlify 的 6MB
 * 请求体上限了，必须走分片（见 receiveChunk / completeChunks）。
 *
 * @param {Request} req - 请求
 * @param {URL} url - URL
 * @returns {Promise<Response>} 响应
 */
async function receiveUpload(req, url) {
  const { name, relPath, error } = parseNameAndPath(req, url)
  if (error) return error

  // 体积预检：能拿到 content-length 就先拦，省得把整个 body 读进内存
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_SINGLE_BYTES) {
    return badRequest(`单个请求最多 ${MAX_SINGLE_BYTES / 1024 / 1024}MB`
      + `（本次 ${(declared / 1024 / 1024).toFixed(1)}MB）。`
      + '大文件请走分片上传（客户端会自动处理）；'
      + '超过 100MB 请用命令行：node scripts/ingest.mjs "<目录>"', { req })
  }

  let buf
  try {
    buf = Buffer.from(await req.arrayBuffer())
  } catch {
    return badRequest('读取请求体失败', { req })
  }

  if (buf.length === 0) return badRequest('请求体为空', { req })
  if (buf.length > MAX_SINGLE_BYTES) {
    return badRequest(`单个请求最多 ${MAX_SINGLE_BYTES / 1024 / 1024}MB`
      + `（本次 ${(buf.length / 1024 / 1024).toFixed(1)}MB），大文件请走分片上传`, { req })
  }

  return saveUpload(req, name, relPath, buf)
}

/* ============================================================
   分片上传
   ============================================================ */

/**
 * 接收一个分片。
 *
 * ## 为什么要分片
 *
 * Netlify Functions 的请求体上限是 6MB，这是**平台限制**，超了直接 413，
 * 代码根本跑不到。而个人资料里 10–30MB 的 PDF / PPT 很常见。
 * 于是把文件切成 4MB 一片分多次传，服务端按 uploadId 攒起来再合流 ——
 * 每个请求都在限额内，总大小只受 100MB 上限约束。
 *
 * ## 分片怎么存
 *
 *   chunk/<uploadId>/<index 补零>   分片内容
 *   chunk-meta/<uploadId>            { name, path, total, size, received[], createdAt }
 *
 * 补零是为了让 list() 的顺序稳定（012 不被排到 12 后面）。
 * 超过 CHUNK_TTL_MS 没合流的会被当作垃圾清理掉。
 *
 * @param {Request} req - 请求
 * @param {URL} url - URL
 * @returns {Promise<Response>} 响应
 */
async function receiveChunk(req, url) {
  const p = url.searchParams
  const uploadId = String(p.get('uploadId') ?? '').replace(/[^A-Za-z0-9]/g, '')
  if (!uploadId || uploadId.length < 8 || uploadId.length > 64) {
    return badRequest('uploadId 不合法', { req })
  }

  const index = Number(p.get('index'))
  const total = Number(p.get('total'))
  const size = Number(p.get('size'))
  if (!Number.isInteger(index) || index < 0) return badRequest('index 不合法', { req })
  if (!Number.isInteger(total) || total < 1 || total > MAX_CHUNKS) {
    return badRequest(`分片数不合法（1–${MAX_CHUNKS}）`, { req })
  }
  if (index >= total) return badRequest('index 超出分片数', { req })
  if (!Number.isFinite(size) || size <= 0 || size > MAX_FILE_BYTES) {
    return badRequest(`文件过大（上限 ${MAX_FILE_BYTES / 1024 / 1024}MB）。`
      + '更大的文件请用命令行入库：node scripts/ingest.mjs "<目录>"', { req })
  }

  // 第一个分片带文件名与路径；后续分片沿用存档的元数据
  const { name, relPath, error } = parseNameAndPath(req, url)
  const store = await getDocsStore(STORES.INBOX)

  let meta = await store.get(`chunk-meta/${uploadId}`, { type: 'json' }).catch(() => null)

  if (!meta) {
    if (error) return error
    meta = {
      uploadId,
      name,
      relPath,
      total,
      size,
      received: [],
      createdAt: new Date().toISOString(),
    }
  } else {
    // 后续分片：元数据以第一次为准，不一致说明客户端搞混了两批
    if (meta.total !== total || meta.size !== size) {
      return badRequest('分片参数与首次不一致（total/size 变了）', { req })
    }
  }

  let buf
  try {
    buf = Buffer.from(await req.arrayBuffer())
  } catch {
    return badRequest('读取分片失败', { req })
  }
  if (buf.length === 0) return badRequest('分片内容为空', { req })
  if (buf.length > MAX_SINGLE_BYTES) {
    return badRequest(`分片过大（${(buf.length / 1024 / 1024).toFixed(1)}MB > `
      + `${MAX_SINGLE_BYTES / 1024 / 1024}MB）`, { req })
  }

  await store.set(`chunk/${uploadId}/${String(index).padStart(3, '0')}`, buf)
  if (!meta.received.includes(index)) meta.received.push(index)
  meta.updatedAt = new Date().toISOString()
  await store.set(`chunk-meta/${uploadId}`, JSON.stringify(meta))

  return ok({
    uploadId,
    received: meta.received.length,
    total,
    complete: meta.received.length === total,
  }, { req })
}

/**
 * 合流：把分片拼回整份文件，走与单次上传完全相同的入库前处理。
 *
 * @param {Request} req - 请求
 * @param {URL} url - URL
 * @returns {Promise<Response>} 响应
 */
async function completeChunks(req, url) {
  const uploadId = String(url.searchParams.get('uploadId') ?? '').replace(/[^A-Za-z0-9]/g, '')
  if (!uploadId) return badRequest('缺少 uploadId', { req })

  const store = await getDocsStore(STORES.INBOX)
  const meta = await store.get(`chunk-meta/${uploadId}`, { type: 'json' }).catch(() => null)
  if (!meta) return notFound('没有这个上传任务（可能已过期或已合流）', { req })

  const age = Date.now() - Date.parse(meta.createdAt)
  if (!Number.isFinite(age) || age > CHUNK_TTL_MS) {
    await dropChunks(store, uploadId).catch(() => {})
    return badRequest('这个上传任务已过期，请重新上传该文件', { req })
  }

  const missing = []
  for (let i = 0; i < meta.total; i++) {
    if (!meta.received.includes(i)) missing.push(i)
  }
  if (missing.length > 0) {
    return badRequest(`还有 ${missing.length} 个分片没到（缺第 ${missing.slice(0, 10).join(',')} 片），`
      + '请重新上传该文件', { req })
  }

  // 按序号读回来拼装
  const parts = []
  for (let i = 0; i < meta.total; i++) {
    const key = `chunk/${uploadId}/${String(i).padStart(3, '0')}`
    const part = await store.get(key, { type: 'arrayBuffer' }).catch(() => null)
    if (!part) return badRequest(`第 ${i} 片读不出来，请重新上传该文件`, { req })
    parts.push(Buffer.from(part))
  }

  const buf = Buffer.concat(parts)
  if (buf.length !== meta.size) {
    return badRequest(`拼接后大小不符（${buf.length} ≠ ${meta.size}），请重新上传该文件`, { req })
  }

  const res = await saveUpload(req, meta.name, meta.relPath ?? '', buf)
  await dropChunks(store, uploadId).catch(() => {})
  return res
}

/**
 * 丢弃一次上传任务的分片（完成后清理，或用户取消）。
 *
 * @param {Request} req - 请求
 * @param {URL} url - URL
 * @returns {Promise<Response>} 响应
 */
async function abortChunks(req, url) {
  const uploadId = String(url.searchParams.get('uploadId') ?? '').replace(/[^A-Za-z0-9]/g, '')
  if (!uploadId) return badRequest('缺少 uploadId', { req })
  const store = await getDocsStore(STORES.INBOX)
  const n = await dropChunks(store, uploadId)
  return ok({ uploadId, removed: n }, { req })
}

/**
 * 删除某个上传任务的全部分片与元数据。
 * @param {object} store - inbox store
 * @param {string} uploadId - 上传任务 id
 * @returns {Promise<number>} 删掉的 blob 数
 */
async function dropChunks(store, uploadId) {
  let n = 0
  const listed = await store.list({ prefix: `chunk/${uploadId}/`, limit: 1000 }).catch(() => ({ blobs: [] }))
  for (const blob of listed.blobs ?? []) {
    await store.delete(blob.key).catch(() => {})
    n += 1
  }
  await store.delete(`chunk-meta/${uploadId}`).catch(() => {})
  return n
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
