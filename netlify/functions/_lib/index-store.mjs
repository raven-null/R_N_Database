/**
 * 分片索引存储。
 *
 * ## 为什么要分片
 *
 * 第一版把整个倒排索引放在**一个** blob 里。256 份文档时索引已 6.23MB，
 * 推算 1000 份到 24MB。实测每次 `/api/v1/search` 都要读全量索引，
 * 本地文件读取就要 134–149ms；线上走 Blobs 网络会更慢，
 * 而且 `manifest` 只是为了取一个版本号也白读了 6MB。
 *
 * 改为按词条哈希分片后：
 *   - 检索只读**查询词所在的几个分片**（通常 2–6 个），而不是全量
 *   - manifest 只读 `index-meta`（几 KB）
 *   - 改一份文档的元数据只需读改写**一个分片**
 *
 * ## 结构
 *
 *   index-meta        { version, builtAt, docCount, termCount, avgLength, lengths }
 *   shard-000 … shard-127   { 词条: { 文档id: 词频 } }
 *
 * `lengths` 留在 meta 里：BM25 的每个词条都要用文档长度做归一化，
 * 拆开反而要读多份。它是每文档一个整数，体量远小于 postings。
 *
 * @module netlify/functions/_lib/index-store
 */

import { getDocsStore, STORES } from './store.mjs'
import { metaTextOf, termCounts, computeIndexVersion, indexableText } from './tokenize.mjs'

/** 分片数量。取 128：256 份文档时每片约 49KB，一次检索读取量降到约 1/32。 */
export const SHARD_COUNT = 128

/**
 * 空索引的元信息。
 *
 * ★ 别再抛「索引尚未初始化」了。这是一个真实事故的教训：
 * 线上新库从来跑过 reindex，于是服务端入库时的每次增量更新都抛错，
 * 而调用方把错误收进 indexError、仍删掉了暂存记录 ——
 * 结果 META 里躺着 44 份文档，索引是空的，站点上「0 份文档」。
 * 没有索引就从**空索引**开始，增量更新自己会建出需要的分片。
 *
 * @returns {object} 空索引元信息
 */
function EMPTY_INDEX_META() {
  return { version: 'init', builtAt: null, docCount: 0, termCount: 0, avgLength: 0, lengths: {} }
}

/** meta 的 blob key。 */
const META_KEY = 'index-meta'

/**
 * 词条 → 分片号（FNV-1a，快且分布均匀）。
 * @param {string} term - 词条
 * @param {number} [count] - 分片数
 * @returns {number} 分片号
 */
export function shardOf(term, count = SHARD_COUNT) {
  let h = 0x811c9dc5
  const s = String(term)
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h % count
}

/**
 * 分片号 → blob key。
 * @param {number} i - 分片号
 * @returns {string} key
 */
export function shardKey(i) {
  return `shard-${String(i).padStart(3, '0')}`
}

/* ============================================================
   读
   ============================================================ */

/**
 * 读索引元信息（体积小，检索与 manifest 都要用）。
 * @returns {Promise<object|null>} meta
 */
export async function readIndexMeta() {
  const store = await getDocsStore(STORES.INDEX)
  return store.get(META_KEY, { type: 'json' }).catch(() => null)
}

/**
 * 只读查询词所在的分片，拼出局部 postings。
 *
 * @param {string[]} terms - 查询词条
 * @returns {Promise<{postings:Record<string,object>, shardsRead:number}>} 局部 postings
 */
export async function readPostingsForTerms(terms) {
  const store = await getDocsStore(STORES.INDEX)
  const need = [...new Set(terms.map((t) => shardOf(t)))]

  const postings = {}
  const loaded = await Promise.all(need.map(async (i) => {
    const shard = await store.get(shardKey(i), { type: 'json' }).catch(() => null)
    return [i, shard]
  }))

  for (const [, shard] of loaded) {
    if (!shard || typeof shard !== 'object') continue
    for (const [term, inner] of Object.entries(shard)) {
      postings[term] = inner
    }
  }

  return { postings, shardsRead: need.length }
}

/* ============================================================
   写
   ============================================================ */

/**
 * 全量写入分片索引（入库 / 重建 / 重分类用）。
 *
 * @param {object} index - buildIndex 的产物
 * @returns {Promise<{shards:number, termCount:number, version:string}>} 摘要
 */
export async function writeIndex(index) {
  const store = await getDocsStore(STORES.INDEX)

  // 按分片归拢
  const shards = Array.from({ length: SHARD_COUNT }, () => ({}))
  for (const [term, inner] of Object.entries(index.postings ?? {})) {
    shards[shardOf(term)][term] = inner
  }

  // 并行写。空分片也写（值为 {}），保证读取端不会因为缺 key 而误判
  await Promise.all(shards.map((shard, i) => store.set(shardKey(i), JSON.stringify(shard))))

  await store.set(META_KEY, JSON.stringify({
    version: index.version,
    builtAt: index.builtAt,
    docCount: index.docCount,
    termCount: index.termCount,
    avgLength: index.avgLength,
    lengths: index.lengths,
  }))

  // 清掉旧版单文件索引，避免占用空间与造成混淆
  await store.delete('search-index').catch(() => {})

  return {
    shards: SHARD_COUNT,
    termCount: index.termCount,
    version: index.version,
  }
}

/**
 * 批量增量更新：多份文档的元数据同时变化。
 *
 * 与 `applyDocChange` 的区别：那个是「一份文档一次读写」。
 * 批量打标签要改上百份，逐份调用会把同一批分片反复读改写上百次 ——
 * 既慢又可能互相覆盖。这里一次性把受影响分片读进内存、改完再写回一次。
 *
 * @param {Array<{oldMeta:object, newMeta:object|null, oldBody?:string}>} changes
 *   变更列表；newMeta 为 null 表示删除。
 *   oldBody 用于「删除前已经拿不到正文」的场景（删文档时 blob 已先删掉，
 *   调用方必须在删之前把正文读出来传进来，否则正文独有的词条摘不干净）。
 * @returns {Promise<{ok:boolean, version:string, shardsTouched:number, docCount:number, applied:number}>} 结果
 */
export async function applyDocChangesBulk(changes) {
  if (!Array.isArray(changes) || changes.length === 0) {
    return { ok: true, version: null, shardsTouched: 0, docCount: 0, applied: 0 }
  }

  const store = await getDocsStore(STORES.INDEX)
  const textStore = await getDocsStore(STORES.TEXT)

  const meta = await readIndexMeta() ?? EMPTY_INDEX_META()

  const docs = (await store.get('docs', { type: 'json' })) ?? []
  const docById = new Map(docs.map((d) => [d.id, d]))

  // ---- 第 1 遍：算出每份文档的旧/新词频，收集要触碰的分片 ----
  /** @type {Array<{id:string, oldTf:Map<string,number>, newTf:Map<string,number>, newMeta:object|null}>} */
  const work = []
  const touched = new Set()

  for (const { oldMeta, newMeta, oldBody } of changes) {
    const id = (newMeta ?? oldMeta)?.id
    if (!id) continue

    // 正文默认不变（元数据编辑不碰正文），读一次即可；
    // 删除场景由调用方在删 blob 之前读出并通过 oldBody 传入
    let body = oldBody
    if (body === undefined) {
      const text = await textStore.get(id, { type: 'json' }).catch(() => null)
      body = (text?.pages ?? []).join('\n')
    }

    const oldTf = oldMeta ? termCounts(metaTextOf(oldMeta), indexableText(body)) : new Map()
    const newTf = newMeta ? termCounts(metaTextOf(newMeta), indexableText(body)) : new Map()

    for (const t of oldTf.keys()) touched.add(shardOf(t))
    for (const t of newTf.keys()) touched.add(shardOf(t))

    work.push({ id, oldTf, newTf, newMeta })
  }

  // ---- 第 2 遍：一次性读入全部受影响分片 ----
  const shardBuf = new Map()
  await Promise.all([...touched].map(async (i) => {
    const shard = await store.get(shardKey(i), { type: 'json' }).catch(() => null)
    shardBuf.set(i, shard && typeof shard === 'object' ? shard : {})
  }))

  // ---- 第 3 遍：在内存里应用全部变更 ----
  const nextLengths = { ...(meta.lengths ?? {}) }
  const nextDocs = [...docs]
  const indexOf = new Map(nextDocs.map((d, i) => [d.id, i]))

  for (const { id, oldTf, newTf, newMeta } of work) {
    removeDocFromShards(shardBuf, id, oldTf)

    if (newMeta) {
      const docLen = addDocToShards(shardBuf, id, newTf)
      nextLengths[id] = docLen
      const at = indexOf.get(id)
      if (at === undefined) {
        indexOf.set(id, nextDocs.length)
        nextDocs.push(newMeta)
      } else {
        nextDocs[at] = newMeta
      }
    } else {
      delete nextLengths[id]
      const at = indexOf.get(id)
      if (at !== undefined) {
        nextDocs.splice(at, 1)
        // splice 后索引整体前移，重建映射（批量删除不常见，成本可接受）
        indexOf.clear()
        nextDocs.forEach((d, i) => indexOf.set(d.id, i))
      }
    }
  }

  const total = Object.values(nextLengths).reduce((a, b) => a + b, 0)
  const docCount = nextDocs.length

  const nextMeta = {
    ...meta,
    version: computeIndexVersion(nextDocs),
    builtAt: new Date().toISOString(),
    docCount,
    avgLength: docCount > 0 ? total / docCount : 0,
    lengths: nextLengths,
  }

  // ---- 第 4 遍：只写回受影响的分片 ----
  await Promise.all([...shardBuf.entries()].map(([i, shard]) =>
    store.set(shardKey(i), JSON.stringify(shard))))

  await store.set(META_KEY, JSON.stringify(nextMeta))
  await store.set('docs', JSON.stringify(nextDocs))

  void docById

  return {
    ok: true,
    version: nextMeta.version,
    shardsTouched: shardBuf.size,
    docCount,
    applied: work.length,
  }
}

/**
 * 把一份文档加入索引（内部用）。
 * @param {Map<number, object>} shardBuf - 分片缓冲
 * @param {string} id - 文档 id
 * @param {Map<string, number>} tf - 词频表
 * @returns {number} 文档长度
 */
function addDocToShards(shardBuf, id, tf) {
  let docLen = 0
  for (const [term, count] of tf) {
    const i = shardOf(term)
    if (!shardBuf.has(i)) shardBuf.set(i, {})
    const shard = shardBuf.get(i)
    if (!shard[term]) shard[term] = {}
    shard[term][id] = count
    docLen += count
  }
  return docLen
}

/**
 * 把一份文档从索引里移除（内部用）。
 * @param {Map<number, object>} shardBuf - 分片缓冲
 * @param {string} id - 文档 id
 * @param {Map<string, number>} tf - 该文档原先的词频表
 * @returns {void}
 */
function removeDocFromShards(shardBuf, id, tf) {
  for (const term of tf.keys()) {
    const i = shardOf(term)
    if (!shardBuf.has(i)) shardBuf.set(i, {})
    const shard = shardBuf.get(i)
    if (shard[term]) {
      delete shard[term][id]
      if (Object.keys(shard[term]).length === 0) delete shard[term]
    }
  }
}

/**
 * 增量更新：一份文档的元数据变化或被删除。
 *
 * 只读写受影响的分片，不重建全库。
 *
 * 默认假设**正文不变**（改标题/分类/标签都不碰正文），所以只读一次
 * doc-text，同一份正文用于算旧/新词频。
 *
 * ★ 但「网页上直接编辑内容」会改正文 —— 那种情况必须由调用方通过
 * oldBody / newBody 传入两版正文。否则移除旧词条时用的是新正文，
 * 旧内容独有的词会永远留在索引里（搜得到、打开却看不到）。
 *
 * @param {object} opts - { oldMeta, newMeta, oldBody?, newBody? }
 *   newMeta 为 null 表示删除
 * @returns {Promise<{ok:boolean, version:string, shardsTouched:number, docCount:number}>} 结果
 */
export async function applyDocChange(opts) {
  const { oldMeta, newMeta, oldBody, newBody } = opts
  const id = (newMeta ?? oldMeta)?.id
  if (!id) throw new Error('applyDocChange 需要文档 id')

  const store = await getDocsStore(STORES.INDEX)
  const textStore = await getDocsStore(STORES.TEXT)

  const meta = await readIndexMeta() ?? EMPTY_INDEX_META()

  const docs = (await store.get('docs', { type: 'json' })) ?? []

  // 正文：调用方给了就用给的那版；没给说明正文没变，读一次库共用
  let bodyFromStore = ''
  if (oldBody === undefined || newBody === undefined) {
    const t = await textStore.get(id, { type: 'json' }).catch(() => null)
    bodyFromStore = (t?.pages ?? []).join('\n')
  }
  const bodyOld = oldBody ?? bodyFromStore
  const bodyNew = newBody ?? bodyFromStore

  const oldTf = oldMeta ? termCounts(metaTextOf(oldMeta), indexableText(bodyOld)) : new Map()
  const newTf = newMeta ? termCounts(metaTextOf(newMeta), indexableText(bodyNew)) : new Map()

  // 需要触碰的分片 = 旧词典 ∪ 新词典 所在的分片
  const touched = new Set()
  for (const t of oldTf.keys()) touched.add(shardOf(t))
  for (const t of newTf.keys()) touched.add(shardOf(t))

  // 读受影响分片
  const shardBuf = new Map()
  await Promise.all([...touched].map(async (i) => {
    const shard = await store.get(shardKey(i), { type: 'json' }).catch(() => null)
    shardBuf.set(i, shard && typeof shard === 'object' ? shard : {})
  }))

  // 先移旧、再加新
  if (oldMeta) removeDocFromShards(shardBuf, id, oldTf)
  let docLen = 0
  if (newMeta) docLen = addDocToShards(shardBuf, id, newTf)

  // 更新 docs 清单
  const nextDocs = newMeta
    ? (docs.some((d) => d.id === id)
        ? docs.map((d) => (d.id === id ? newMeta : d))
        : [...docs, newMeta])
    : docs.filter((d) => d.id !== id)

  // 更新 lengths 与 avgLength
  const nextLengths = { ...(meta.lengths ?? {}) }
  if (newMeta) nextLengths[id] = docLen
  else delete nextLengths[id]

  const total = Object.values(nextLengths).reduce((a, b) => a + b, 0)
  const docCount = nextDocs.length

  const nextMeta = {
    ...meta,
    version: computeIndexVersion(nextDocs),
    builtAt: new Date().toISOString(),
    docCount,
    avgLength: docCount > 0 ? total / docCount : 0,
    lengths: nextLengths,
  }

  // 只写回受影响的分片
  await Promise.all([...shardBuf.entries()].map(([i, shard]) =>
    store.set(shardKey(i), JSON.stringify(shard))))

  await store.set(META_KEY, JSON.stringify(nextMeta))
  await store.set('docs', JSON.stringify(nextDocs))

  return {
    ok: true,
    version: nextMeta.version,
    shardsTouched: shardBuf.size,
    docCount,
  }
}
