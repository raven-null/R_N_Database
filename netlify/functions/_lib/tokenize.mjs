/**
 * 中文分词与倒排索引构建。
 *
 * 分词用 **`Intl.Segmenter`**（Node 20+ 与所有现代浏览器原生支持），
 * 因此整个检索链路零依赖，不必引入 jieba 之类的重库。
 *
 * ## 索引策略
 *
 * 索引里同时写两类词条：
 *   - **分词结果**（`Intl.Segmenter` 的词）
 *   - **CJK 二元组**（bigram）
 *
 * 二元组是为了召回 —— 分词会把「操作系统」切成「操作」+「系统」，
 * 若用户搜「作系统」或文档里写法略有差异，纯分词索引会漏。
 *
 * ## 打分模型（经过一次返工）
 *
 * 第一版只按「命中词条数 × idf」打分，实测有严重缺陷：
 * 搜「操作系统」时，一份**只在技能栏提了一次**「操作系统」的简历，
 * 与整篇讲操作系统的课件拿到完全相同的 2.30 分。
 * 原因是打分里没有**词频**，也没有**文档长度归一化** ——
 * 「提一次」和「通篇都是」在数学上没有区别。
 *
 * 现模型用 BM25（k1=1.2, b=0.75）：
 *   - **TF 饱和**：词频越高分越高，但边际递减，避免堆砌刷分
 *   - **长度归一化**：长文档里的偶发命中自动降权
 *   - **查询词条分级**：分词词权重 1.0，二元组只作召回兜底、权重 0.35
 *     （二元组是「操作」这类碎片，本身区分度低）
 *
 * @module netlify/functions/_lib/tokenize
 */

import { createHash } from 'node:crypto'

/** 中日韩统一表意文字 + 扩展 A + 兼容表意文字。 */
const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/

/** 连续 CJK 串（用于切二元组）。 */
const CJK_RUN_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]{2,}/g

/** 常见中文停用词（保留会造成大量无意义 postings）。 */
const STOPWORDS = new Set([
  '的', '了', '和', '是', '在', '有', '我', '也', '就', '不', '人', '都', '一', '上', '到',
  '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这', '那', '这些', '那些',
  '一个', '可以', '这个', '那个', '我们', '他们', '以及', '或者', '但是', '因为', '所以',
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'has', 'have',
  'not', 'but', 'you', 'all', 'can', 'her', 'his', 'one', 'our', 'out', 'they', 'what',
])

/** BM25 词频饱和参数。 */
const BM25_K1 = 1.2
/** BM25 长度归一化强度。 */
const BM25_B = 0.75

/** 二元组在查询里的权重（仅作召回兜底，不主导排序）。 */
const BIGRAM_QUERY_WEIGHT = 0.35

let segmenter = null

/**
 * 惰性创建分词器（创建有一定开销，进程内复用）。
 * @returns {Intl.Segmenter} 分词器
 */
function getSegmenter() {
  if (!segmenter) {
    segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
  }
  return segmenter
}

/**
 * 取分词器切出的实词（不含二元组）。
 * @param {string} text - 原始文本
 * @returns {string[]} 词数组
 */
function segmentWords(text) {
  const out = []
  for (const part of getSegmenter().segment(String(text ?? ''))) {
    if (!part.isWordLike) continue
    const raw = part.segment
    const term = raw.toLowerCase()
    if (STOPWORDS.has(term)) continue

    if (CJK_RE.test(raw)) {
      // CJK：单字丢弃（噪声远大于价值），二字以上收
      if ([...raw].length >= 2) out.push(term)
    } else if (term.length >= 2) {
      out.push(term)
    }
  }
  return out
}

/**
 * 取文本里的 CJK 二元组。
 * @param {string} text - 原始文本
 * @returns {string[]} 二元组数组
 */
function cjkBigrams(text) {
  const out = []
  for (const run of String(text ?? '').match(CJK_RUN_RE) ?? []) {
    const chars = [...run]
    if (chars.length === 2) {
      out.push(run)
      continue
    }
    for (let i = 0; i + 1 < chars.length; i++) {
      out.push(chars[i] + chars[i + 1])
    }
  }
  return out
}

/**
 * 把一段文本切成检索词（分词结果 + 二元组，含重复）。
 *
 * 用于**建立索引**：索引里同时收两类词条以保证召回。
 * 查询侧请用 `queryTerms`，它带权重分级。
 *
 * @param {string} text - 原始文本
 * @returns {string[]} 词条数组
 */
export function tokenize(text) {
  return [...segmentWords(text), ...cjkBigrams(text)]
}

/**
 * 把文本切成去重词条集合（索引写入用）。
 * @param {string} text - 原始文本
 * @returns {Set<string>} 词条集合
 */
export function uniqueTerms(text) {
  return new Set(tokenize(text))
}

/**
 * 解析查询串，返回带权重的词条。
 *
 * 分词词权重 1.0；二元组权重 0.35 —— 二元组存在的意义是召回兜底，
 * 若与分词词等权，搜「操作系统」时「作系」这种跨界碎片会贡献
 * 近三分之一的分数，把排序搅乱。
 *
 * @param {string} query - 查询串
 * @returns {Array<{term:string, weight:number}>} 词条及权重
 */
export function queryTerms(query) {
  const primary = new Set(segmentWords(query))
  const bigrams = new Set(cjkBigrams(query))

  const out = []
  for (const term of primary) out.push({ term, weight: 1 })
  for (const term of bigrams) {
    if (primary.has(term)) continue   // 已被分词词覆盖，不重复计分
    out.push({ term, weight: BIGRAM_QUERY_WEIGHT })
  }
  return out
}

/**
 * 计算索引版本号。
 *
 * 只依赖「文档 id + 元数据更新时间」，因此：
 *   - 内容没变 → 版本号不变 → 前端命中缓存，不发请求
 *   - 新增/修改/删除文档 → 版本号必变 → 前端自动拉新
 *
 * @param {Array<{id:string, updatedAt?:string}>} docs - 文档元数据列表
 * @returns {string} 版本号（16 位十六进制）
 */
export function computeIndexVersion(docs) {
  const material = docs
    .map((d) => `${d.id}:${d.updatedAt ?? ''}`)
    .sort()
    .join('|')
  return createHash('sha256').update(material).digest('hex').slice(0, 16)
}

/**
 * 取一份文档的元数据文本（标题/文件名/摘要/标签/分类）。
 *
 * 与正文分开是为了让调用方能明确控制两部分如何拼接 ——
 * 全量建索引与增量更新都必须用同一份逻辑，否则两条路径产物会不一致。
 *
 * @param {object} doc - 文档元数据
 * @returns {string} 元数据文本
 */
export function metaTextOf(doc) {
  return [
    doc.title, doc.originalName, doc.summary,
    ...(doc.tags ?? []), ...(doc.categories ?? []),
  ].filter(Boolean).join(' ')
}

/**
 * 统计一份文档的词频。
 *
 * @param {string} metaText - 元数据文本
 * @param {string} bodyText - 正文
 * @returns {Map<string, number>} 词条 → 词频
 */
export function termCounts(metaText, bodyText) {
  const tf = new Map()
  for (const term of tokenize(`${metaText}\n${bodyText}`)) {
    tf.set(term, (tf.get(term) ?? 0) + 1)
  }
  return tf
}

/**
 * 构建倒排索引（带词频）。
 *
 * postings 结构：`{ 词条: { 文档id: 词频 } }`
 *
 * 第一版只存 `{ 词条: [文档id] }`，丢掉词频导致无法区分
 * 「提一次」与「通篇都是」，是排序失准的直接原因。
 *
 * @param {Array<object>} docs - 文档元数据列表
 * @param {(doc:object) => string} [textOf] - 取正文的函数
 * @returns {object} 索引对象
 */
export function buildIndex(docs, textOf) {
  /** @type {Map<string, Map<string, number>>} 词条 → (文档 id → 词频) */
  const postings = new Map()
  /** @type {Record<string, number>} 文档 id → 文档长度（词条总数） */
  const lengths = {}
  let totalLength = 0

  for (const doc of docs) {
    const bodyText = textOf ? String(textOf(doc) ?? '') : ''
    const tf = termCounts(metaTextOf(doc), bodyText)

    let docLen = 0
    for (const [term, count] of tf) {
      let inner = postings.get(term)
      if (!inner) {
        inner = new Map()
        postings.set(term, inner)
      }
      inner.set(doc.id, count)
      docLen += count
    }

    lengths[doc.id] = docLen
    totalLength += docLen
  }

  // Map → 普通对象（JSON 友好），词条排序保证产物稳定可比对
  const plain = {}
  for (const term of [...postings.keys()].sort()) {
    plain[term] = Object.fromEntries(postings.get(term))
  }

  return {
    version: computeIndexVersion(docs),
    builtAt: new Date().toISOString(),
    docCount: docs.length,
    termCount: Object.keys(plain).length,
    avgLength: docs.length > 0 ? totalLength / docs.length : 0,
    postings: plain,
    lengths,
  }
}

/**
 * 在索引上执行检索（BM25）。
 *
 * @param {object} index - buildIndex 的产物
 * @param {string} query - 查询串
 * @param {object} [opts] - { limit, docs }
 * @returns {Array<{id:string, score:number, matched:string[]}>} 结果（按分数降序）
 */
export function searchIndex(index, query, opts = {}) {
  const limit = opts.limit ?? 50
  const docs = opts.docs ?? []
  const byId = new Map(docs.map((d) => [d.id, d]))

  const terms = queryTerms(query)
  if (terms.length === 0 || !index?.postings) return []

  const N = index.docCount || 1
  const avgLen = index.avgLength || 1
  const lengths = index.lengths ?? {}

  const scores = new Map()
  const matched = new Map()

  for (const { term, weight } of terms) {
    const inner = index.postings[term]
    if (!inner) continue

    const df = Object.keys(inner).length
    // BM25 的 idf（带 +0.5 平滑，避免极端值）
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))

    for (const [id, tf] of Object.entries(inner)) {
      if (!byId.has(id)) continue
      const docLen = lengths[id] || 1
      // TF 饱和 + 长度归一化
      const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / avgLen))
      const tfNorm = (tf * (BM25_K1 + 1)) / denom

      const contribution = idf * tfNorm * weight
      scores.set(id, (scores.get(id) ?? 0) + contribution)
      if (!matched.has(id)) matched.set(id, [])
      matched.get(id).push(term)
    }
  }

  const results = []
  for (const [id, score] of scores) {
    const doc = byId.get(id)
    if (!doc) continue

    // 元数据命中加权：标题/标签命中比正文里偶发命中更可能是用户想要的
    let boost = 1
    const haystack = [doc.title, ...(doc.tags ?? []), ...(doc.categories ?? [])]
      .filter(Boolean).join(' ').toLowerCase()
    const phrase = String(query ?? '').trim().toLowerCase()
    if (phrase.length >= 2 && haystack.includes(phrase)) boost += 1.5
    else if (terms.some((t) => haystack.includes(t.term))) boost += 0.4

    results.push({ id, score: score * boost, matched: matched.get(id) ?? [] })
  }

  results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  return results.slice(0, limit)
}

/**
 * 从正文中截取命中片段（供搜索结果展示）。
 *
 * @param {string} text - 正文
 * @param {string[]} terms - 命中词
 * @param {number} [window] - 片段半宽（字符）
 * @returns {string} 片段（含省略号）
 */
export function makeSnippet(text, terms, window = 60) {
  const src = String(text ?? '').replace(/\s+/g, ' ')
  if (!src) return ''

  const lower = src.toLowerCase()
  let bestAt = -1
  for (const term of terms) {
    const at = lower.indexOf(String(term).toLowerCase())
    if (at !== -1 && (bestAt === -1 || at < bestAt)) bestAt = at
  }
  if (bestAt === -1) return src.slice(0, window * 2) + (src.length > window * 2 ? '…' : '')

  const start = Math.max(0, bestAt - window)
  const end = Math.min(src.length, bestAt + window)
  return (start > 0 ? '…' : '') + src.slice(start, end) + (end < src.length ? '…' : '')
}
