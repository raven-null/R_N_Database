/**
 * 索引重建：从已入库的元数据与正文重新构建检索索引。
 *
 * 为什么需要它：分词策略或打分模型一改，索引格式就得跟着变。
 * 没有这个模块，每次调整都要把全库文档重新抽取一遍 ——
 * 那意味着重新读一遍所有 PDF，几十秒到几分钟不等，
 * 而实际上正文早就存在 `doc-text` 里了，没必要重来。
 *
 * 入库脚本与 `scripts/reindex.mjs` 共用这里的逻辑，
 * 保证「入库时建的索引」和「手动重建的索引」完全一致。
 *
 * @module scripts/lib/rebuild-index
 */

import { buildIndex } from '../../netlify/functions/_lib/tokenize.mjs'
import { writeIndex } from '../../netlify/functions/_lib/index-store.mjs'
import { getDocsStore, STORES } from '../../netlify/functions/_lib/store.mjs'

/**
 * 读出全库元数据。
 * @returns {Promise<object[]>} 元数据列表
 */
async function readAllMeta() {
  const store = await getDocsStore(STORES.META)
  const out = []

  let cursor
  for (let round = 0; round < 200; round++) {
    const page = await store.list({ prefix: '', limit: 500, cursor })
    for (const blob of page.blobs ?? []) {
      const m = await store.get(blob.key, { type: 'json' }).catch(() => null)
      if (m) out.push(m)
    }
    cursor = page.nextCursor ?? page.cursor
    if (!cursor) break
  }
  return out
}

/**
 * 重建并写回索引、词表、文档清单与路径映射。
 *
 * @param {object} opts - { taxonomy, pathIndex, onProgress }
 * @returns {Promise<object>} 索引摘要 { docCount, termCount, version, avgLength }
 */
export async function rebuildStoreIndex(opts = {}) {
  const { taxonomy, pathIndex, onProgress } = opts

  const metaStore = await getDocsStore(STORES.META)
  const textStore = await getDocsStore(STORES.TEXT)
  const indexStore = await getDocsStore(STORES.INDEX)

  const allMeta = await readAllMeta()
  onProgress?.(`读取 ${allMeta.length} 份文档的元数据`)

  // buildIndex 是同步的，所以先把全库正文并行读进内存
  const textCache = new Map()
  let done = 0
  await Promise.all(allMeta.map(async (doc) => {
    try {
      const t = await textStore.get(doc.id, { type: 'json' })
      textCache.set(doc.id, (t?.pages ?? []).join('\n'))
    } catch {
      textCache.set(doc.id, '')
    }
    done += 1
    if (done % 25 === 0) onProgress?.(`已读正文 ${done}/${allMeta.length}`)
  }))

  const withText = allMeta.filter((d) => (textCache.get(d.id) ?? '').length > 0).length
  onProgress?.(`正文就绪：${withText}/${allMeta.length} 份有正文`)

  const index = buildIndex(allMeta, (doc) => textCache.get(doc.id) ?? '')

  // 分片写入（meta + 128 个分片），并清理旧版单文件索引
  const written = await writeIndex(index)
  onProgress?.(`已写入 ${written.shards} 个索引分片`)

  if (taxonomy) {
    await indexStore.set('taxonomy', JSON.stringify(taxonomy))
  }

  await indexStore.set('docs', JSON.stringify(allMeta))

  if (pathIndex) {
    await indexStore.set('paths', JSON.stringify(pathIndex))
  }

  // metaStore 在这里只为保持接口对称（未来可能做清理）；显式 void 掉避免 lint 抱怨
  void metaStore

  return {
    docCount: index.docCount,
    termCount: index.termCount,
    version: index.version,
    avgLength: Math.round(index.avgLength * 10) / 10,
    withText,
  }
}
