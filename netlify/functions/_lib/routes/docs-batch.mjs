/**
 * 路由：批量操作与标签管理。
 *
 *   POST   /api/v1/docs/batch     多选后批量加/删标签、改分类
 *   POST   /api/v1/tags/rename    重命名标签（from 传数组即为合并）
 *   DELETE /api/v1/tags/{name}    全库删除某标签
 *
 * ## 为什么单独一个模块
 *
 * 这些操作都要「改很多份文档的元数据 + 更新索引」。
 * 逐份调用 PATCH 会把同一批索引分片反复读改写上百次，既慢又可能互相覆盖。
 * 这里统一走 `applyDocChangesBulk`：受影响分片只读一次、只写一次。
 *
 * 全部要求 admin 令牌；read 令牌（工作站/博客）不能改资料。
 *
 * @module netlify/functions/_lib/routes/docs-batch
 */

import { checkAuth } from '../auth.mjs'
import { ok, badRequest, notFound, unauthorized, forbidden, serverError } from '../respond.mjs'
import { readAllMeta, readMeta, readTaxonomy } from '../repo.mjs'
import { getDocsStore, STORES } from '../store.mjs'
import { applyDocChangesBulk } from '../index-store.mjs'

/** 单次批量操作的文档数上限，防止一次改爆。 */
const MAX_BATCH = 500

/** 标签长度与数量上限（与单份编辑保持一致）。 */
const MAX_TAG_LEN = 20
const MAX_TAGS_PER_DOC = 12

/**
 * 统一鉴权：写操作必须 admin。
 * @param {Request} req - 请求
 * @param {URL} url - URL
 * @returns {Promise<{auth:object, response:Response|null}>} 鉴权结果
 */
async function gate(req, url) {
  const auth = await checkAuth(req, url, 'admin')
  if (auth.ok && auth.role === 'admin') return { auth, response: null }
  return {
    auth,
    response: auth.failClosed
      ? forbidden('服务端尚未配置访问密码，已拒绝所有访问（fail-closed）', { req })
      : auth.role
        ? forbidden('修改资料需要管理员令牌', { req })
        : unauthorized(auth.reason === 'BAD_TOKEN' ? '访问令牌无效' : '需要访问令牌', { req }),
  }
}

/**
 * 规整标签数组：去空白、去重。**不做截断**。
 *
 * 截断是刻意的：早期版本会把过长的标签悄悄切到 20 字符，
 * 用户看到的标签名和输入的**不是一回事**，批量比对时也对不上
 * （实测被这个坑过）。现在改为由调用方校验并明确报错。
 *
 * @param {*} tags - 原始标签
 * @returns {string[]} 规整后的标签
 */
function normalizeTags(tags) {
  if (!Array.isArray(tags)) return []
  return [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))]
}

/**
 * 找出超出长度限制的标签。
 * @param {string[]} tags - 标签
 * @returns {string[]} 超长的标签
 */
function oversizeTags(tags) {
  return tags.filter((t) => [...t].length > MAX_TAG_LEN)
}

/**
 * 对一批文档应用元数据补丁，并做一次批量索引更新。
 *
 * @param {Array<{oldMeta:object, newMeta:object}>} updates - 变更列表
 * @returns {Promise<object>} 结果摘要
 */
async function commitUpdates(updates) {
  if (updates.length === 0) {
    return { applied: 0, index: null, indexError: null }
  }

  const metaStore = await getDocsStore(STORES.META)

  // 先落元数据（并行写，互不依赖）
  await Promise.all(updates.map(({ newMeta }) =>
    metaStore.set(newMeta.id, JSON.stringify(newMeta))))

  let index = null
  let indexError = null
  try {
    index = await applyDocChangesBulk(updates)
  } catch (err) {
    indexError = String(err?.message ?? err)
  }

  return { applied: updates.length, index, indexError }
}

/**
 * 构造一份文档的新元数据（打补丁 + 标记来源 + 时间戳）。
 * @param {object} oldMeta - 原元数据
 * @param {object} patch - 要改的字段
 * @param {string} source - 来源标记（记录到 classifySource）
 * @returns {object} 新元数据
 */
function patchMeta(oldMeta, patch, source) {
  const now = new Date().toISOString()
  const src = String(oldMeta.classifySource ?? '')
  return {
    ...oldMeta,
    ...patch,
    // 人工动过就不再是「待复查」—— 除非本次操作就是要标它。
    // （早期版本无条件写 false，写在 ...patch 之后，把 markReview 的
    //   true 直接覆盖掉，导致「标为待复查」完全失效。实测发现。）
    needsReview: patch.needsReview !== undefined ? patch.needsReview : false,
    classifySource: src.includes('manual') ? src : `${src ? `${src}+` : ''}${source}`,
    editedAt: now,
    updatedAt: now,
  }
}

/* ============================================================
   POST /api/v1/docs/batch
   ============================================================ */

/**
 * 批量操作：加标签 / 删标签 / 改分类 / 标为待复查。
 *
 * @param {Request} req - 请求
 * @param {URL} url - URL
 * @returns {Promise<Response>} 响应
 */
export async function batchRoute(req, url) {
  const { response } = await gate(req, url)
  if (response) return response
  if (req.method !== 'POST') return badRequest('批量操作请用 POST', { req })

  let body
  try {
    body = await req.json()
  } catch {
    return badRequest('请求体不是合法 JSON', { req })
  }

  const ids = Array.isArray(body?.ids) ? [...new Set(body.ids.map(String))] : []
  if (ids.length === 0) return badRequest('缺少 ids', { req })
  if (ids.length > MAX_BATCH) return badRequest(`一次最多处理 ${MAX_BATCH} 份文档`, { req })

  const op = String(body?.op ?? '')
  const taxonomy = await readTaxonomy()
  const validCats = new Set((taxonomy?.categories ?? []).map((c) => c.name))

  try {
    // ---- 批量删除：走单独路径 ----
    // 它要连带清掉原件/预览件/正文，且只需要**一次**索引更新
    // （applyDocChangesBulk 支持 newMeta=null 表示删除），
    // 逐份调 DELETE 会把同一批分片反复读写上百次。
    if (op === 'delete') {
      return await batchDelete(req, ids)
    }

    const updates = []
    const skipped = []

    for (const id of ids) {
      const oldMeta = await readMeta(id)
      if (!oldMeta) {
        skipped.push({ id, reason: '文档不存在' })
        continue
      }

      let next = null

      if (op === 'addTags') {
        const add = normalizeTags(body?.tags)
        if (add.length === 0) return badRequest('缺少 tags', { req })
        const tooLong = oversizeTags(add)
        if (tooLong.length) {
          return badRequest(`标签过长（上限 ${MAX_TAG_LEN} 个字符）：${tooLong.join('、')}`, { req })
        }
        next = patchMeta(oldMeta, {
          tags: [...new Set([...(oldMeta.tags ?? []), ...add])].slice(0, MAX_TAGS_PER_DOC),
        }, 'batch')
      } else if (op === 'removeTags') {
        const del = new Set(normalizeTags(body?.tags))
        if (del.size === 0) return badRequest('缺少 tags', { req })
        next = patchMeta(oldMeta, {
          tags: (oldMeta.tags ?? []).filter((t) => !del.has(t)),
        }, 'batch')
      } else if (op === 'setCategory') {
        const cats = Array.isArray(body?.categories) ? body.categories.map(String) : []
        const bad = cats.filter((c) => !validCats.has(c))
        if (bad.length) return badRequest(`分类必须来自词表，不认识：${bad.join('、')}`, { req })
        next = patchMeta(oldMeta, { categories: cats.length ? [...new Set(cats)].slice(0, 3) : ['未归类'] }, 'batch')
      } else if (op === 'markReview') {
        next = patchMeta(oldMeta, { needsReview: true }, 'batch')
      } else {
        return badRequest(`未知操作：${op}`
          + '（支持 addTags / removeTags / setCategory / markReview / delete）', { req })
      }

      updates.push({ oldMeta, newMeta: next })
    }

    const result = await commitUpdates(updates)

    return ok({
      op,
      requested: ids.length,
      applied: result.applied,
      skipped,
      index: result.index,
      indexError: result.indexError,
      note: result.indexError
        ? '元数据已保存，但索引更新失败 —— 检索可能暂时不准，可运行 node scripts/reindex.mjs 修复。'
        : '元数据与索引均已更新。',
    }, { req })
  } catch (err) {
    return serverError(err, 'docs-batch', { req })
  }
}

/**
 * 批量删除文档：原件、预览件、正文、元数据一次清干净，索引只更新一次。
 *
 * @param {Request} req - 请求
 * @param {string[]} ids - 文档 id
 * @returns {Promise<Response>} 响应
 */
async function batchDelete(req, ids) {
  const filesStore = await getDocsStore(STORES.FILES)
  const previewStore = await getDocsStore(STORES.PREVIEWS)
  const textStore = await getDocsStore(STORES.TEXT)
  const metaStore = await getDocsStore(STORES.META)

  const changes = []
  const skipped = []

  for (const id of ids) {
    const meta = await readMeta(id)
    if (!meta) {
      skipped.push({ id, reason: '文档不存在' })
      continue
    }

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

    changes.push({ oldMeta: meta, newMeta: null })
  }

  let index = null
  let indexError = null
  try {
    index = await applyDocChangesBulk(changes)
  } catch (err) {
    indexError = String(err?.message ?? err)
  }

  return ok({
    op: 'delete',
    requested: ids.length,
    deleted: changes.length,
    skipped,
    index,
    indexError,
    note: indexError
      ? '文档已删除，但索引更新失败 —— 检索可能暂时不准，可运行 node scripts/reindex.mjs 修复。'
      : '文档与索引均已删除。',
  }, { req })
}

/* ============================================================
   POST /api/v1/tags/rename   重命名 / 合并
   DELETE /api/v1/tags/{name} 全库删除
   ============================================================ */
/**
 * 标签重命名（`from` 传数组即为合并多个标签到一个）。
 *
 * @param {Request} req - 请求
 * @param {URL} url - URL
 * @returns {Promise<Response>} 响应
 */
export async function tagRenameRoute(req, url) {
  const { response } = await gate(req, url)
  if (response) return response
  if (req.method !== 'POST') return badRequest('重命名请用 POST', { req })

  let body
  try {
    body = await req.json()
  } catch {
    return badRequest('请求体不是合法 JSON', { req })
  }

  const from = (Array.isArray(body?.from) ? body.from : [body?.from])
    .map((s) => String(s ?? '').trim()).filter(Boolean)
  const to = String(body?.to ?? '').trim()

  if (from.length === 0) return badRequest('缺少 from', { req })
  if (!to) return badRequest('缺少 to（新标签名不能为空）', { req })
  // 与批量加标签一致：过长就报错，不静默截断（截断会让新旧名字对不上）
  if ([...to].length > MAX_TAG_LEN) {
    return badRequest(`新标签名过长（上限 ${MAX_TAG_LEN} 个字符）：${to}`, { req })
  }
  const tooLongFrom = oversizeTags(from)
  if (tooLongFrom.length) {
    return badRequest(`标签过长（上限 ${MAX_TAG_LEN} 个字符）：${tooLongFrom.join('、')}`, { req })
  }
  if (from.length === 1 && from[0] === to) return badRequest('新旧标签名相同', { req })

  try {
    const fromSet = new Set(from)
    const all = await readAllMeta()
    const affected = all.filter((d) => (d.tags ?? []).some((t) => fromSet.has(t)))

    if (affected.length === 0) {
      return ok({ from, to, affected: 0, note: '没有文档使用这些标签。' }, { req })
    }

    const updates = affected.map((oldMeta) => {
      const kept = (oldMeta.tags ?? []).filter((t) => !fromSet.has(t))
      // 合并时新名字可能已在别的文档里存在 → 去重
      const merged = [...new Set([...kept, to])].slice(0, MAX_TAGS_PER_DOC)
      return { oldMeta, newMeta: patchMeta(oldMeta, { tags: merged }, 'tag-rename') }
    })

    const result = await commitUpdates(updates)

    return ok({
      from,
      to,
      merge: from.length > 1,
      affected: result.applied,
      index: result.index,
      indexError: result.indexError,
    }, { req })
  } catch (err) {
    return serverError(err, 'tags-rename', { req })
  }
}

/**
 * 全库删除某个标签。
 *
 * @param {Request} req - 请求
 * @param {URL} url - URL
 * @param {string} name - 标签名（已解码）
 * @returns {Promise<Response>} 响应
 */
export async function tagDeleteRoute(req, url, name) {
  const { response } = await gate(req, url)
  if (response) return response
  if (req.method !== 'DELETE') return badRequest('删除标签请用 DELETE', { req })

  const tag = String(name ?? '').trim()
  if (!tag) return badRequest('缺少标签名', { req })

  try {
    const all = await readAllMeta()
    const affected = all.filter((d) => (d.tags ?? []).includes(tag))

    if (affected.length === 0) {
      return ok({ tag, affected: 0, note: '没有文档使用该标签。' }, { req })
    }

    const updates = affected.map((oldMeta) => ({
      oldMeta,
      newMeta: patchMeta(oldMeta, {
        tags: (oldMeta.tags ?? []).filter((t) => t !== tag),
      }, 'tag-delete'),
    }))

    const result = await commitUpdates(updates)

    return ok({
      tag,
      affected: result.applied,
      index: result.index,
      indexError: result.indexError,
    }, { req })
  } catch (err) {
    return serverError(err, 'tags-delete', { req })
  }
}

/**
 * 标签使用情况统计（供管理面板）。
 *
 * @param {Request} req - 请求
 * @param {URL} url - URL
 * @returns {Promise<Response>} 响应
 */
export async function tagStatsRoute(req, url) {
  const { response } = await gate(req, url)
  if (response) return response

  try {
    const all = await readAllMeta()
    const counts = {}
    for (const d of all) {
      for (const t of d.tags ?? []) counts[t] = (counts[t] ?? 0) + 1
    }
    const tags = Object.entries(counts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'))

    const taxonomy = await readTaxonomy()
    const known = new Set(taxonomy?.tags ?? [])

    return ok({
      total: tags.length,
      tags,
      // 词表里定义但没人用的标签（供清理参考）
      unused: [...known].filter((t) => !counts[t]),
      docCount: all.length,
    }, { req })
  } catch (err) {
    return serverError(err, 'tags-stats', { req })
  }
}
