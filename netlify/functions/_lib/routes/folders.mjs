/**
 * 路由：/api/v1/folders —— 虚拟文件夹树的增删改查。
 *
 * ## 与文档的关系
 *
 * 文件夹只是**组织方式**，文档才是资产。所以这里的约定是：
 *
 *   · 删文件夹 → 子文件夹与文档**上移到父级**，一份都不销毁
 *   · 改文件夹名 → 文档的 `dir` 自动跟着变（由树派生，不落到文档上）
 *   · 文件夹设 private → 库里所有后代文档对访客不可见（继承）
 *
 * ## 权限
 *
 * 读（GET）guest 即可，但**只回访客能看见的那部分**：
 * 私有文件夹及其子树直接不出现 —— 否则"那里有个叫证件的文件夹"本身就是泄露。
 * 写操作（增删改）要 admin。
 *
 * ## 为什么文档不写回索引
 *
 * 改 `folderId` 不影响倒排索引（`metaTextOf` 只取标题/摘要/标签/分类），
 * 所以这些写操作**不需要**碰索引，只改元数据 —— 快且不会引发索引抖动。
 * 唯一例外是把文件夹改名后 `dir` 变了，但 `dir` 也是读时派生的，同样不落库。
 *
 * @module netlify/functions/_lib/routes/folders
 */

import { ok, badRequest, forbidden, notFound, serverError } from '../respond.mjs'
import { checkAuth } from '../auth.mjs'
import { getDocsStore, STORES } from '../store.mjs'
import {
  loadFolders, createFolder, updateFolder, deleteFolder,
  listFolders, subtreeFids,
} from '../folders.mjs'

/**
 * 读出全部元数据（文件夹计数与"后代可见性"判断都要用）。
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
  }
  return out
}

/**
 * 访客能看见的文件夹：自己与所有祖先都不是 private。
 *
 * @param {object} idx - 文件夹索引
 * @param {Array<object>} list - listFolders 的结果
 * @returns {Array<object>} 过滤后的列表
 */
function visibleFolders(idx, list) {
  return list.filter((f) => idx.effectiveVisibility(f.fid) !== 'private')
}

/**
 * GET /api/v1/folders —— 文件夹树（扁平列表 + 路径 + 计数）。
 *
 * @param {Request} req - 请求
 * @param {URL} url - URL
 * @param {object} auth - 鉴权结果
 * @returns {Promise<Response>} 响应
 */
async function listRoute(req, url, auth) {
  const idx = await loadFolders()
  const all = await readAllMeta()
  const docs = auth.role === 'guest'
    ? all.filter((d) => d.visibility === 'public')
    : all
  void url

  const list = listFolders(idx, docs)
  const shown = auth.role === 'guest' ? visibleFolders(idx, list) : list

  // 访客看不到的文件夹，其计数也不能泄露
  const safe = shown.map((f) => (auth.role === 'guest'
    ? { ...f, docCount: f.docCount, totalDocCount: f.totalDocCount, visibility: undefined }
    : f))

  return ok({ total: safe.length, folders: safe }, { req })
}

/**
 * POST /api/v1/folders —— 新建文件夹。
 *
 * 请求体：`{ name, parentFid?, visibility? }`
 *
 * @param {Request} req - 请求
 * @returns {Promise<Response>} 响应
 */
async function createRoute(req) {
  let body
  try {
    body = await req.json()
  } catch {
    return badRequest('请求体不是合法 JSON', { req })
  }

  const name = String(body?.name ?? '').trim()
  if (!name) return badRequest('缺少文件夹名 name', { req })

  try {
    const idx = await loadFolders()
    const node = await createFolder(idx, {
      name,
      parentFid: body?.parentFid ?? null,
      visibility: body?.visibility,
    })
    return ok({
      folder: { ...node, path: idx.pathOf(node.fid) },
      note: `已新建文件夹「${node.name}」`,
    }, { req })
  } catch (err) {
    return badRequest(`新建失败：${err.message}`, { req })
  }
}

/**
 * PATCH /api/v1/folders/{fid} —— 改名 / 移动 / 改可见性。
 *
 * @param {Request} req - 请求
 * @param {string} fid - 文件夹 id
 * @returns {Promise<Response>} 响应
 */
async function updateRoute(req, fid) {
  let body
  try {
    body = await req.json()
  } catch {
    return badRequest('请求体不是合法 JSON', { req })
  }
  if (body?.name === undefined && body?.parentFid === undefined && body?.visibility === undefined) {
    return badRequest('没有要改的字段（name / parentFid / visibility）', { req })
  }

  try {
    const idx = await loadFolders()
    if (!idx.get(fid)) return notFound('文件夹不存在', { req })
    const node = await updateFolder(idx, fid, body)
    return ok({
      folder: { ...node, path: idx.pathOf(node.fid) },
      note: '文件夹已更新（文档的目录会自动跟着变）',
    }, { req })
  } catch (err) {
    return badRequest(`更新失败：${err.message}`, { req })
  }
}

/**
 * DELETE /api/v1/folders/{fid} —— 删除文件夹。
 *
 * 子文件夹上移到父级；原本落在这个文件夹里的文档也一并上移
 * （只改元数据，不动索引、更不删文件）。
 *
 * @param {Request} req - 请求
 * @param {string} fid - 文件夹 id
 * @returns {Promise<Response>} 响应
 */
async function deleteRoute(req, fid) {
  try {
    const idx = await loadFolders()
    const node = idx.get(fid)
    if (!node) return notFound('文件夹不存在', { req })

    const parentFid = node.parentFid ?? null
    const tree = subtreeFids(idx, fid)

    // 先把落在被删文件夹（及其子树里已上移的层）上的文档重新挂到父级。
    // 注意：子树里的文件夹整体上移后 fid 不变，所以只需处理**被删的这个**。
    let moved = 0
    const all = await readAllMeta()
    const metaStore = await getDocsStore(STORES.META)
    for (const d of all) {
      if (String(d.folderId ?? '') !== String(fid)) continue
      d.folderId = parentFid
      d.updatedAt = new Date().toISOString()
      await metaStore.set(d.id, JSON.stringify(d))
      moved += 1
    }

    const { reparented } = await deleteFolder(idx, fid)
    void tree

    return ok({
      removed: { fid: node.fid, name: node.name },
      movedFolders: reparented,
      movedDocs: moved,
      note: `已删除「${node.name}」：${reparented} 个子文件夹、${moved} 份文档上移到父级（没有删除任何文件）`,
    }, { req })
  } catch (err) {
    return serverError(err, 'folders/delete', { req })
  }
}

/**
 * 路由入口。
 *
 * @param {Request} req - 请求
 * @param {URL} url - URL
 * @param {string[]} seg - 路径段（已去掉 /api/v1/folders）
 * @returns {Promise<Response>} 响应
 */
export async function foldersRoute(req, url, seg) {
  try {
    const write = req.method !== 'GET'
    const auth = await checkAuth(req, url, write ? 'admin' : 'guest')
    if (write && !auth.ok) return forbidden('文件夹的新增/修改/删除需要管理员权限', { req })

    if (req.method === 'GET' && seg.length === 0) return await listRoute(req, url, auth)
    if (req.method === 'POST' && seg.length === 0) return await createRoute(req)
    if (req.method === 'PATCH' && seg.length === 1) return await updateRoute(req, seg[0])
    if (req.method === 'DELETE' && seg.length === 1) return await deleteRoute(req, seg[0])

    return badRequest(`不支持的请求：${req.method} /folders/${seg.join('/')}`, { req })
  } catch (err) {
    return serverError(err, 'folders', { req })
  }
}
