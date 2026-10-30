/**
 * 备份导出：把整个资料库打成一个 zip。
 *
 * ## 为什么放在函数里而不是脚本里
 *
 * 数据在线上（Netlify Blobs），本机没有 Netlify 令牌就摸不到。
 * 而 admin 密码（`ADMIN_TOKEN`）本来就有 —— 于是「备份」这件事不需要
 * 任何额外的凭据，点一下就能拿到一个自包含的 zip。
 *
 * ## zip 里有什么
 *
 *   manifest.json          全库索引：每份文档的标题/分类/标签/来源/哈希
 *   docs/<id>.json         完整元数据（可直接用于恢复）
 *   text/<id>.json         抽取的正文（分页）
 *   files/<原名>           原件
 *
 * 顺序也是**恢复顺序**：先读 manifest，再按 docs 重建元数据，最后挂原件与正文。
 * 所以这个 zip 既是备份，也是「换一个库再灌回去」的搬运包。
 *
 * ## 限额
 *
 * 同步函数 26 秒 / 内存 1024 MB。纯文本资料库（几十份到几百份、几十 MB）
 * 完全够；超过 `MAX_TOTAL_BYTES` 就明确拒绝并指向本地脚本，
 * 而不是跑到一半被平台掐断。
 *
 * @module netlify/functions/_lib/routes/export
 */

import { ok, badRequest, forbidden, notFound, serverError } from '../respond.mjs'
import { getDocsStore, STORES } from '../store.mjs'
import { checkAuth } from '../auth.mjs'

/** 单次最多打包多少份。 */
const MAX_DOCS = 800
/** 打包内容总量上限（压缩前）。 */
const MAX_TOTAL_BYTES = 60 * 1024 * 1024
/** 导出件保留多久（毫秒）。 */
const EXPORT_TTL_MS = 24 * 60 * 60 * 1000

/** 这些类型本身已是压缩格式，再压一遍只费 CPU。 */
const ALREADY_ZIPPED = new Set(['pdf', 'docx', 'xlsx', 'pptx'])

/**
 * 读出全部元数据（按 id 排序，保证产物稳定可比对）。
 *
 * @returns {Promise<object[]>} 元数据列表
 */
async function readAllMeta() {
  const store = await getDocsStore(STORES.META)
  const out = []
  let cursor
  for (let round = 0; round < 40; round++) {
    const page = await store.list({ prefix: '', limit: 500, cursor })
    for (const blob of page.blobs ?? []) {
      const m = await store.get(blob.key, { type: 'json' }).catch(() => null)
      if (m?.id) out.push(m)
    }
    cursor = page.nextCursor ?? page.cursor
    if (!cursor) break
    if (out.length > MAX_DOCS) break
  }
  return out.sort((a, b) => String(a.id).localeCompare(String(b.id)))
}

/**
 * 打包全库。
 *
 * @param {Request} req - 请求
 * @returns {Promise<Response>} { exportId, downloadUrl, docCount, size }
 */
async function buildExport(req) {
  const metas = await readAllMeta()
  if (metas.length === 0) {
    return ok({ exportId: null, docCount: 0, size: 0, note: '库里没有文档，无需备份。' }, { req })
  }
  if (metas.length > MAX_DOCS) {
    return badRequest(`一次最多备份 ${MAX_DOCS} 份（当前 ${metas.length} 份），请分批或改用本地脚本`, { req })
  }

  const totalBytes = metas.reduce((n, m) => n + (Number(m.size) || 0), 0)
  if (totalBytes > MAX_TOTAL_BYTES) {
    return badRequest(
      `内容总量 ${(totalBytes / 1024 / 1024).toFixed(0)}MB 超过单次上限 `
      + `${MAX_TOTAL_BYTES / 1024 / 1024}MB。请用本地脚本：node scripts/export.mjs`,
      { req },
    )
  }

  const JSZip = (await import('jszip')).default
  const zip = new JSZip()

  const textStore = await getDocsStore(STORES.TEXT)
  const filesStore = await getDocsStore(STORES.FILES)
  const manifestDocs = []
  let included = 0
  let missingFile = 0

  for (const m of metas) {
    // 元数据：整份原样存，恢复时不用再猜字段
    zip.file(`docs/${m.id}.json`, JSON.stringify(m, null, 2))

    const text = await textStore.get(m.id, { type: 'json' }).catch(() => null)
    if (text?.pages?.length) {
      zip.file(`text/${m.id}.json`, JSON.stringify(text), { compression: 'DEFLATE' })
    }

    const fileName = m.originalName || `${m.title}.${m.ext}`
    // 同名原件分目录放，避免两个 x.pdf 互相覆盖
    const fileKey = `${m.id}.${m.ext}`
    const buf = await filesStore.get(fileKey, { type: 'arrayBuffer' }).catch(() => null)
    if (buf) {
      zip.file(`files/${m.id}/${fileName}`, buf, {
        compression: ALREADY_ZIPPED.has(m.type) ? 'STORE' : 'DEFLATE',
        binary: true,
      })
      included += 1
    } else {
      missingFile += 1
    }

    manifestDocs.push({
      id: m.id,
      title: m.title,
      originalName: m.originalName,
      ext: m.ext,
      type: m.type,
      size: m.size,
      sha256: m.sha256,
      categories: m.categories,
      tags: m.tags,
      visibility: m.visibility,
      sourcePath: m.sourcePath,
      ingestedAt: m.ingestedAt,
      updatedAt: m.updatedAt,
      hasFile: Boolean(buf),
    })
  }

  zip.file('manifest.json', JSON.stringify({
    kind: '渡·资·集 备份',
    version: 1,
    exportedAt: new Date().toISOString(),
    docCount: metas.length,
    withFile: included,
    missingFile,
    layout: {
      manifest: 'manifest.json',
      meta: 'docs/<id>.json',
      text: 'text/<id>.json（可选）',
      files: 'files/<id>/<原件名>',
    },
    docs: manifestDocs,
  }, null, 2))

  const zipped = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })

  const exportId = crypto.randomUUID().replace(/-/g, '').slice(0, 20)
  const store = await getDocsStore(STORES.EXPORTS)
  await store.set(`export/${exportId}.zip`, zipped)
  await store.set(`export/${exportId}.json`, JSON.stringify({
    exportId, createdAt: Date.now(), docCount: metas.length, size: zipped.length, missingFile,
  }))

  return ok({
    exportId,
    docCount: metas.length,
    withFile: included,
    missingFile,
    size: zipped.length,
    downloadUrl: `/api/v1/export/${exportId}`,
    expiresInHours: EXPORT_TTL_MS / 3600000,
    note: `已打包 ${metas.length} 份文档（${(zipped.length / 1024 / 1024).toFixed(1)}MB），24 小时内可下载。`,
  }, { req })
}

/**
 * 下载已生成的备份件。
 *
 * @param {Request} req - 请求
 * @param {string} exportId - 导出 id
 * @returns {Promise<Response>} zip 流
 */
async function downloadExport(req, exportId) {
  if (!/^[a-z0-9]{8,32}$/i.test(exportId)) return badRequest('导出 id 不合法', { req })

  const store = await getDocsStore(STORES.EXPORTS)
  const meta = await store.get(`export/${exportId}.json`, { type: 'json' }).catch(() => null)
  if (!meta) return notFound('没有这份备份（可能已过期或已被清理）', { req })

  if (Date.now() - Number(meta.createdAt) > EXPORT_TTL_MS) {
    return notFound('这份备份已过期（超过 24 小时），请重新生成', { req })
  }

  const buf = await store.get(`export/${exportId}.zip`, { type: 'arrayBuffer' }).catch(() => null)
  if (!buf) return notFound('备份文件已丢失，请重新生成', { req })

  const stamp = new Date(meta.createdAt).toISOString().slice(0, 10)
  return new Response(buf, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Length': String(buf.byteLength),
      'Content-Disposition': `attachment; filename="duziji-backup-${stamp}.zip"`,
      // 备份里有全库内容，绝不能被中间缓存留住
      'Cache-Control': 'private, no-store',
    },
  })
}

/**
 * 路由入口：POST /api/v1/export 生成，GET /api/v1/export/{id} 下载。
 *
 * @param {Request} req - 请求
 * @param {URL} url - URL
 * @param {string[]} seg - 路径段（已去掉 /api/v1/export）
 * @returns {Promise<Response>} 响应
 */
export async function exportRoute(req, url, seg) {
  try {
    const auth = await checkAuth(req, url, 'admin')
    if (!auth.ok) {
      return forbidden('备份导出需要管理员权限（它会打包全库内容）', { req })
    }

    if (req.method === 'POST' && seg.length === 0) return await buildExport(req)
    if (req.method === 'GET' && seg.length === 1) return await downloadExport(req, seg[0])
    if (req.method === 'GET' && seg.length === 0) return badRequest('生成备份请用 POST', { req })
    return badRequest(`不支持的请求：${req.method} /export/${seg.join('/')}`, { req })
  } catch (err) {
    return serverError(err, 'export', { req })
  }
}
