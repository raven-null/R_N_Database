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
import TAXONOMY_DEFAULT from './taxonomy-default.mjs'

/** 单次重建最多处理多少份文档（再多会撞函数时限）。 */
const MAX_DOCS = 2000

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

    const after = await readIndexMeta()
    return ok({
      docCount: meta.length,
      termCount: index.termCount,
      avgLength: Math.round(index.avgLength * 10) / 10,
      shards: written.shards,
      version: after?.version ?? index.version,
      note: `已从 ${meta.length} 份元数据重建索引（${texts.size} 份有正文）。`,
    }, { req })
  } catch (err) {
    return serverError(err, 'index/repair', { req })
  }
}
