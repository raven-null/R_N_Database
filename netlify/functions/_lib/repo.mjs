/**
 * 数据读取层：把各 store 里的东西读成函数需要的形状。
 *
 * 索引类数据（docs 列表 / 倒排索引 / 词表）由入库脚本整体写入，
 * 读时一次取出即可 —— 个人库规模下（数百份文档）这点数据量
 * 远小于一次函数调用的开销，不必做分页或二次查询。
 *
 * @module netlify/functions/_lib/repo
 */

import { getDocsStore, STORES } from './store.mjs'

/** 读全库元数据列表（按入库时间倒序）。 */
export async function readAllMeta() {
  const store = await getDocsStore(STORES.INDEX)
  const docs = await store.get('docs', { type: 'json' }).catch(() => null)
  if (!Array.isArray(docs)) return []
  return [...docs].sort((a, b) => String(b.ingestedAt ?? '').localeCompare(String(a.ingestedAt ?? '')))
}

/** 读单份文档元数据。 */
export async function readMeta(id) {
  const store = await getDocsStore(STORES.META)
  return store.get(id, { type: 'json' }).catch(() => null)
}

/**
 * 读倒排索引。
 *
 * 注意：索引是**分片**存储的（见 index-store.mjs）。这里不再返回全量
 * postings —— 那样每次检索都要读 6MB+。调用方应先用 `readIndexMeta()`
 * 拿元信息与文档长度表，再用 `readPostingsForTerms(terms)` 只取
 * 查询词所在的分片。
 *
 * @returns {Promise<object|null>} { meta, postings } —— postings 需另行按词条获取
 */
export { readIndexMeta, readPostingsForTerms } from './index-store.mjs'

/** 读分类词表。 */
export async function readTaxonomy() {
  const store = await getDocsStore(STORES.INDEX)
  return store.get('taxonomy', { type: 'json' }).catch(() => null)
}

/**
 * 读文档正文。
 * @param {string} id - 文档 id
 * @returns {Promise<{pages:string[]}|null>} 正文档
 */
export async function readDocText(id) {
  const store = await getDocsStore(STORES.TEXT)
  return store.get(id, { type: 'json' }).catch(() => null)
}

/**
 * 取原件内容。
 * @param {object} meta - 文档元数据
 * @returns {Promise<ArrayBuffer|null>} 内容
 */
export async function readDocFile(meta) {
  const store = await getDocsStore(STORES.FILES)
  const key = `${meta.id}.${meta.ext}`
  const buf = await store.get(key, { type: 'arrayBuffer' }).catch(() => null)
  if (buf) return buf
  // 兜底：早期版本可能没带扩展名
  return store.get(meta.id, { type: 'arrayBuffer' }).catch(() => null)
}

/**
 * 取预览件。
 * @param {string} id - 文档 id
 * @param {'pdf'|'html'} kind - 预览类型
 * @returns {Promise<{body:*, contentType:string}|null>} 预览内容
 */
export async function readPreview(id, kind) {
  const store = await getDocsStore(STORES.PREVIEWS)
  if (kind === 'pdf') {
    const buf = await store.get(`${id}.pdf`, { type: 'arrayBuffer' }).catch(() => null)
    return buf ? { body: buf, contentType: 'application/pdf' } : null
  }
  const html = await store.get(`${id}.html`, { type: 'text' }).catch(() => null)
  return html ? { body: html, contentType: 'text/html; charset=utf-8' } : null
}

/**
 * 统计各分类与标签的文档数（供侧边栏显示计数）。
 * @param {object[]} docs - 元数据列表
 * @returns {{categories:Record<string,number>, tags:Record<string,number>, types:Record<string,number>}} 统计
 */
export function tally(docs) {
  const categories = {}
  const tags = {}
  const types = {}
  for (const d of docs) {
    for (const c of d.categories ?? []) categories[c] = (categories[c] ?? 0) + 1
    for (const t of d.tags ?? []) tags[t] = (tags[t] ?? 0) + 1
    if (d.type) types[d.type] = (types[d.type] ?? 0) + 1
  }
  return { categories, tags, types }
}
