/**
 * 从 META 重建索引（服务端）。
 *
 * ## 为什么需要它
 *
 * 线上新库从没跑过 `reindex`。服务端入库时如果索引写失败（哪怕是
 * 历史 bug 造成的），META 里躺着文档、索引却是空的 —— 站点上显示
 * 「0 份文档」，而数据其实都在。本地有 `node scripts/reindex.mjs`，
 * 但那条路要 Netlify 令牌；这里提供一条**只靠 admin 密码**就能重建的路。
 *
 * 做法与本地 reindex 一致：读全部 META + TEXT → buildIndex → writeIndex，
 * 再把 `docs` 清单与词表写回去。区别只是运行在函数里。
 *
 * ## 什么时候该跑
 *
 *   · 站点上文档数明显少于实际
 *   · 改了分类词表之后想全量刷一遍
 *   · 怀疑索引与元数据不同步
 *
 * 60 份文档量级下几秒内完成；上千份会撞 60 秒同步上限，那种规模请用本地脚本。
 *
 * @module netlify/functions/_lib/index-repair
 */

import { ok, serverError } from './respond.mjs'
import { getDocsStore, STORES } from './store.mjs'
import { buildIndex } from './tokenize.mjs'
import { writeIndex, readIndexMeta } from './index-store.mjs'
import { SCHEMA_VERSION, migrateDoc } from './doc-model.mjs'
import { loadFolders, ensurePath } from './folders.mjs'
import { dirOf } from './source-dir.mjs'
import TAXONOMY_DEFAULT from './taxonomy-default.mjs'

/** 单次重建最多处理多少份文档（再多会撞函数时限）。 */
const MAX_DOCS = 2000

/** 补写可见性时用的默认值。
 *
 * ★ 注意这里是 `public` 而不是模型里的 `DEFAULT_VISIBILITY`（private）：
 * 补写面对的是**历史文档**，它们本来就该是公开的，修数据不该改可见范围。
 * 新建文档的默认值在 doc-model 里，是 private。
 */
const DEFAULT_VISIBILITY_BACKFILL = 'public'

/**
 * 把旧文档补到当前模型（保留一切已有取值）。
 *
 * 迁移语义：历史文档缺 `visibility` 视为 public —— 它们本来就是公开的，
 * 迁移只补字段、不改可见范围。新建文档才吃 `DEFAULT_VISIBILITY`（private）。
 *
 * @param {object[]} metas - 全部元数据（会被就地修改）
 * @returns {Promise<number>} 升级了多少份
 */
async function migrateAll(metas) {
  const todo = metas.filter((m) => m.schemaVersion !== SCHEMA_VERSION)
  if (todo.length === 0) return 0

  const store = await getDocsStore(STORES.META)
  for (const m of todo) {
    const { doc } = migrateDoc(m)
    // 就地替换（后续 buildIndex 用的是同一批对象）
    for (const k of Object.keys(m)) delete m[k]
    Object.assign(m, doc)
    await store.set(m.id, JSON.stringify(doc))
  }
  return todo.length
}

/**
 * 把还没有归属的文档挂到文件夹树上。
 *
 * 文件夹树是后来才有的：老数据只有 `sourcePath`（字符串路径），没有 `folderId`。
 * 这里按它们**已经显示的目录**逐级建节点 —— 所以升级完看到的样子和升级前一致，
 * 只是从此以后可以改名、移动、建空文件夹了。
 *
 * `folderId` 不参与倒排索引（`metaTextOf` 只取标题/摘要/标签/分类），
 * 所以这一步只写元数据，不动索引。
 *
 * @param {object[]} metas - 全部元数据（会被就地修改）
 * @returns {Promise<{linked:number, folders:number}>} 结果
 */
async function linkFolders(metas) {
  const todo = metas.filter((m) => !m.folderId)
  if (todo.length === 0) {
    const idx = await loadFolders()
    return { linked: 0, folders: idx.nodes.size }
  }

  const idx = await loadFolders()
  const store = await getDocsStore(STORES.META)
  let linked = 0
  for (const m of todo) {
    const dir = dirOf(m.sourcePath)
    const parts = dir ? dir.split('/').filter(Boolean) : []
    const fid = await ensurePath(idx, parts)
    m.folderId = fid ?? null
    await store.set(m.id, JSON.stringify(m))
    linked += 1
  }
  return { linked, folders: idx.nodes.size }
}

/**
 * 补写缺失的 `visibility` 字段。
 *
 * 为什么单独做一件「补数据」的事：读接口按 `visibility === 'public'`
 * 过滤访客可见范围，而早期的入库流程没写这个字段 —— 结果就是元数据
 * 齐全、索引也在，站点上却一份文档都不显示。
 *
 * @param {object[]} metas - 全部元数据（会被就地修改）
 * @returns {Promise<number>} 补写了多少份
 */
async function backfillVisibility(metas) {
  const todo = metas.filter((m) => m.visibility !== 'public' && m.visibility !== 'private')
  if (todo.length === 0) return 0

  const store = await getDocsStore(STORES.META)
  for (const m of todo) {
    m.visibility = DEFAULT_VISIBILITY_BACKFILL
    await store.set(m.id, JSON.stringify(m))
  }
  return todo.length
}

/**
 * 读出全部 META（不走索引的 docs 清单 —— 那份可能正是坏的）。
 *
 * @returns {Promise<object[]>} 元数据
 */
async function readAllMetaFromStore() {
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
  return out
}

/**
 * 从 META + TEXT 重建索引与清单（不含 HTTP 包装，供 repair / reclassify 共用）。
 *
 * @param {object[]} meta - 全部元数据（会被就地修正：可见性、模型版本、文件夹归位）
 * @returns {Promise<{index:object, written:object, texts:Map<string,string>}>} 结果
 */
export async function rebuildFromMetas(meta) {
  const textStore = await getDocsStore(STORES.TEXT)
  const texts = new Map()
  for (const d of meta) {
    const t = await textStore.get(d.id, { type: 'json' }).catch(() => null)
    texts.set(d.id, (t?.pages ?? []).join('\n'))
  }

  const index = buildIndex(meta, (d) => texts.get(d.id) ?? '')
  const written = await writeIndex(index)

  // 索引的 docs 清单与词表也要写（列表页与 /taxonomy 都读它们）
  const indexStore = await getDocsStore(STORES.INDEX)
  await indexStore.set('docs', JSON.stringify(meta))
  const storedTax = await indexStore.get('taxonomy', { type: 'json' }).catch(() => null)
  if (!storedTax?.categories?.length && TAXONOMY_DEFAULT?.categories?.length) {
    await indexStore.set('taxonomy', JSON.stringify(TAXONOMY_DEFAULT))
  }

  return { index, written, texts }
}

/**
 * 读出全部元数据（不看索引里的 docs 清单 —— 那份可能正是坏的）。
 * @returns {Promise<object[]>} 元数据
 */
export async function readAllMetaForMaintenance() {
  return await readAllMetaFromStore()
}

/**
 * POST /api/v1/index/repair（admin）
 *
 * @param {Request} req - 请求
 * @param {URL} url - URL
 * @returns {Promise<Response>} 响应
 */
export async function repairIndex(req, url) {
  void url
  try {
    const meta = await readAllMetaFromStore()
    if (meta.length === 0) {
      return ok({ docCount: 0, note: '没有任何元数据，无需重建。' }, { req })
    }
    if (meta.length > MAX_DOCS) {
      return ok({
        docCount: meta.length,
        note: `元数据有 ${meta.length} 份，超过单次上限 ${MAX_DOCS}，请用本地脚本 node scripts/reindex.mjs`,
      }, { req })
    }

    const visibilityFixed = await backfillVisibility(meta)
    const migrated = await migrateAll(meta)
    const folderLink = await linkFolders(meta)

    const { index, written, texts } = await rebuildFromMetas(meta)

    const after = await readIndexMeta()
    return ok({
      docCount: meta.length,
      termCount: index.termCount,
      avgLength: Math.round(index.avgLength * 10) / 10,
      shards: written.shards,
      visibilityFixed,
      migrated,
      foldersLinked: folderLink.linked,
      folders: folderLink.folders,
      schemaVersion: SCHEMA_VERSION,
      version: after?.version ?? index.version,
      note: `已从 ${meta.length} 份元数据重建索引（${texts.size} 份有正文）`
        + (visibilityFixed > 0 ? `，补写可见性 ${visibilityFixed} 份` : '')
        + (migrated > 0 ? `，升级模型 ${migrated} 份` : '')
        + (folderLink.linked > 0 ? `，归位文件夹 ${folderLink.linked} 份` : '')
        + '。',
    }, { req })
  } catch (err) {
    return serverError(err, 'index/repair', { req })
  }
}
