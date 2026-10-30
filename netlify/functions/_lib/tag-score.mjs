/**
 * 标签打分：把"关键词撞上就算标签"换成"有证据、有上限、能解释"。
 *
 * ## 现在的毛病
 *
 * 老实现（`classify-rules.mjs` 的 `mergeTagsFor`）把正文里出现的关键词
 * 直接当标签，于是 60 份资料里那份 39 页的《阿里巴巴编码规范》拿到了
 * 8 个标签，其中「物理」「英语」跟它毫无关系 —— 因为它们只是正文里
 * 出现过几次的词汇。标签一多一杂，人就不会看标签了，等于白打。
 *
 * ## 新规则
 *
 * 每个候选标签按**证据来源**加权，过阈值、按分数取前 5：
 *
 *     文件夹/目录名命中     +10   ← 确定性最强：`继承测试/` 里的东西就是讲继承的
 *     标题/文件名命中        +8
 *     正文出现 n 次          +min(6, 1.5·log2(n))，n ≥ 3 才计
 *
 * 三条硬约束：
 *   1. **标签不许重复分类名**（分类是分类，标签是标签；「学习资料 + #学习」就是这么坏掉的）
 *   2. **停用词不进自动打标**（设计/工作/模板/测试 这类词在任何文档里都出现，没有区分度）
 *   3. **最多 5 个**（超过 5 个的标签集合，人根本不会读）
 *
 * 每个标签都带上 `from`（证据来源），UI 可以解释「为什么有这个标签」。
 *
 * @module netlify/functions/_lib/tag-score
 */

/** 文件夹名命中的权重。 */
const W_DIR = 10
/** 标题命中的权重。 */
const W_TITLE = 8
/**
 * 正文命中的权重上限。
 *
 * 定得比阈值高，是有意的：**光靠正文不够**。一个词在正文里出现很多次，
 * 往往只是因为文体（一份编码规范里「测试」「安全」会反复出现），
 * 不代表这份文档"讲这个"。所以正文单独命中要 40 次以上才够得着阈值，
 * 而目录/标题命中一次就够 —— 那才是人给这份文档起的名字。
 */
const W_BODY_MAX = 10
/** 正文至少要出现几次才算数（撞一次不算）。 */
const BODY_MIN_HITS = 3
/** 过阈值才留下。 */
const MIN_SCORE = 8
/** 最多保留几个标签。 */
const MAX_TAGS = 5

/**
 * 统计一个词在文本里出现的次数（拉丁词按词边界，中文按子串）。
 *
 * @param {string} text - 文本
 * @param {string} term - 词
 * @returns {number} 次数
 */
function countHits(text, term) {
  const t = String(text ?? '')
  const w = String(term ?? '')
  if (!t || !w) return 0

  // 纯 ASCII 的词（java / api / sdk）必须按词边界数，否则 `java` 会命中 `javascript`
  if (/^[A-Za-z0-9+#.-]+$/.test(w)) {
    const re = new RegExp(`(?<![A-Za-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'gi')
    return (t.match(re) ?? []).length
  }
  let n = 0
  let at = t.indexOf(w)
  while (at !== -1) {
    n += 1
    at = t.indexOf(w, at + w.length)
  }
  return n
}

/**
 * 把标签词表整理成「词 → 归一化名称」的查找表。
 *
 * 词表既支持字符串数组（老格式），也支持 `{ name, aliases }` 对象。
 *
 * @param {object} taxonomy - 词表
 * @returns {Array<{name:string, keys:string[]}>} 候选表
 */
function tagVocabulary(taxonomy) {
  const raw = taxonomy?.tags ?? []
  const out = []
  for (const item of raw) {
    if (typeof item === 'string') {
      out.push({ name: item, keys: [item] })
      continue
    }
    if (item && typeof item === 'object' && item.name) {
      const keys = [item.name, ...(Array.isArray(item.aliases) ? item.aliases : [])].filter(Boolean)
      out.push({ name: String(item.name), keys: keys.map(String) })
    }
  }
  return out
}

/**
 * 给一份文档算标签。
 *
 * @param {object} input - 输入
 * @param {string} input.title - 标题
 * @param {string} input.fileName - 原文件名（可选）
 * @param {string[]} input.dirNames - 来源目录的各级名字（可选，越靠后越具体）
 * @param {string} input.body - 正文（可选）
 * @param {string[]} input.categories - 已判定的分类
 * @param {object} input.taxonomy - 词表
 * @returns {Array<{name:string, score:number, from:string[]}>} 标签（按分数降序，最多 5 个）
 */
export function scoreTags(input) {
  const {
    title = '', fileName = '', dirNames = [], body = '', categories = [], taxonomy = null,
  } = input

  const vocab = tagVocabulary(taxonomy)
  // 停用词：词表里按惯例用 `_` 前缀放元信息，两种写法都认
  const stop = new Set(
    (taxonomy?.tagStoplist ?? taxonomy?._tagStoplist?.words ?? []).map(String),
  )
  const catNames = new Set([
    ...categories.map(String),
    ...(taxonomy?.categories ?? []).map((c) => String(c?.name ?? '')).filter(Boolean),
  ])

  const titleText = `${title} ${fileName}`.toLowerCase()
  const dirText = dirNames.join(' ').toLowerCase()
  const bodyText = String(body ?? '')

  /**
   * 文本里是否出现某个词（拉丁词按词边界）。
   *
   * ★ 不能简单用 includes：`javascript` 里含 `java`、`design-pattern` 里含 `design`，
   * 于是目录叫「JavaScript 教程」的文档会被打上 `Java` 标签。
   *
   * @param {string} text - 待查文本
   * @param {string} key - 词
   * @returns {boolean} 是否命中
   */
  const has = (text, key) => countHits(text, key) > 0

  const scored = []
  for (const tag of vocab) {
    if (stop.has(tag.name) || catNames.has(tag.name)) continue

    const from = []
    let score = 0

    // 目录命中：最强证据
    if (tag.keys.some((k) => has(dirText, k))) {
      score += W_DIR
      from.push('dir')
    }

    // 标题/文件名命中
    if (tag.keys.some((k) => has(titleText, k))) {
      score += W_TITLE
      from.push('title')
    }

    // 正文命中：按次数对数加权，撞一两次不算
    const hits = tag.keys.reduce((n, k) => Math.max(n, countHits(bodyText, k)), 0)
    if (hits >= BODY_MIN_HITS) {
      const bonus = Math.min(W_BODY_MAX, 1.5 * Math.log2(hits))
      score += bonus
      from.push(`body:${hits}`)
    }

    if (score >= MIN_SCORE && from.length > 0) {
      scored.push({ name: tag.name, score: Math.round(score * 10) / 10, from })
    }
  }

  // 分数高的在前；同分按出现顺序稳定排序，保证两次结果一致
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'zh-CN'))
  return scored.slice(0, MAX_TAGS)
}

/**
 * 只取标签名（入库写库用）。
 * @param {Array<{name:string}>} scored - scoreTags 的结果
 * @returns {string[]} 标签名
 */
export function tagNames(scored) {
  return (scored ?? []).map((t) => t.name)
}

/** 导出常量供测试与文档引用。 */
export const TAG_RULES = { W_DIR, W_TITLE, W_BODY_MAX, BODY_MIN_HITS, MIN_SCORE, MAX_TAGS }
