/**
 * 分类与打标。
 *
 * 两层策略：
 *   1. **规则层**（始终运行）—— 拿词表里的 keywords 做加权命中。
 *      它保证「没配 AI Key 也有可用分类」，也保证 AI 给出的结果
 *      可以被规则交叉验证。
 *   2. **AI 层**（配了 ZHIPU_API_KEY 才跑）—— 让模型从受控词表里选，
 *      并生成摘要。沿用图库 ai-proxy 的智谱 glm-4-flash 配置。
 *
 * **核心约束：AI 只能从词表里选，不能自由造分类。**
 * 标签允许新建，但会自动追加「待整理」提醒人工复查 ——
 * 不加这条约束，三个月后分类会腐烂成一堆同义词。
 *
 * @module scripts/lib/classify
 */

import { readFileSync } from 'node:fs'

/** 智谱 OpenAI 兼容端点（默认，沿用图库 ai-proxy 的配置）。 */
const ZHIPU_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
const ZHIPU_MODEL = 'glm-4-flash'

/**
 * 解析 AI 配置。
 *
 * 刻意**不写死智谱**：工作站的 `.env` 里已有小米 MiMo 的
 * OpenAI 兼容端点（`STATION_LLM_BASE_URL` / `STATION_LLM_API_KEY` /
 * `STATION_LLM_MODEL`），资料库没必要逼用户再申请一个 key。
 * 任何 OpenAI 兼容端点都能用。
 *
 * 优先级（越靠前越优先）：
 *   显式入参 → AI_* → ZHIPU_API_KEY → STATION_LLM_*
 *
 * @param {object} [overrides] - { baseUrl, apiKey, model, endpoint }
 * @returns {{endpoint:string, apiKey:string, model:string, configured:boolean, source:string}} 配置
 */
export function resolveAIConfig(overrides = {}) {
  const pick = (...vals) => vals.find((v) => typeof v === 'string' && v.trim().length > 0) ?? ''

  const baseUrl = pick(overrides.baseUrl, process.env.AI_BASE_URL, process.env.STATION_LLM_BASE_URL)
  const apiKey = pick(
    overrides.apiKey,
    process.env.AI_API_KEY,
    process.env.ZHIPU_API_KEY,
    process.env.STATION_LLM_API_KEY,
  )
  const model = pick(overrides.model, process.env.AI_MODEL, process.env.STATION_LLM_MODEL) || ZHIPU_MODEL

  // baseUrl 形如 https://host/v1 —— 拼上 OpenAI 兼容的 /chat/completions
  const endpoint = pick(
    overrides.endpoint,
    baseUrl ? `${baseUrl.replace(/\/+$/, '')}/chat/completions` : '',
    ZHIPU_ENDPOINT,
  )

  let source = 'none'
  if (overrides.apiKey || process.env.AI_API_KEY) source = 'AI_API_KEY'
  else if (process.env.ZHIPU_API_KEY) source = 'ZHIPU_API_KEY'
  else if (process.env.STATION_LLM_API_KEY) source = 'STATION_LLM_API_KEY（复用工作站配置）'

  return { endpoint, apiKey, model, configured: Boolean(apiKey), source }
}

/** 送进 AI 的正文长度上限（字符）。太长既费钱又无必要。 */
const AI_TEXT_LIMIT = 3000

/**
 * 读取分类词表。
 * @param {string} file - 词表路径
 * @returns {object} 词表对象
 */
export function loadTaxonomy(file) {
  const raw = readFileSync(file, 'utf8')
  const tax = JSON.parse(raw)
  if (!Array.isArray(tax.categories)) throw new Error('分类词表缺少 categories 数组')
  tax.tags = Array.isArray(tax.tags) ? tax.tags : []
  return tax
}

/* ============================================================
   规则层
   ============================================================ */

/** CJK 字符集（用于判断关键词该按子串还是按词边界匹配）。 */
const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/

/**
 * 统计关键词在文本里出现的次数。
 *
 * ★ ASCII 词必须按**词边界**匹配，不能按子串。
 * 踩过的坑：标签「AI」按子串匹配时，`email`、`available`、`explain`、
 * `detail` 全部算命中 —— 实测 256 份文档里 243 份被打上「AI」标签。
 * 关键词层同理，「api」会匹配 `rapid`、`capital`。
 * 中文没有词边界概念，仍按子串匹配。
 *
 * @param {string} textLower - 已转小写的文本
 * @param {string} termLower - 已转小写的词
 * @returns {number} 出现次数
 */
function countOccurrences(textLower, termLower) {
  if (!termLower) return 0
  if (CJK_RE.test(termLower)) {
    return Math.min(textLower.split(termLower).length - 1, 50)
  }
  // ASCII：要求前后不是字母或数字
  const escaped = termLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'g')
  let n = 0
  while (re.exec(textLower) !== null && n < 50) n += 1
  return n
}

/**
 * 判断文本是否包含某个词（ASCII 按词边界）。
 * @param {string} textLower - 已转小写的文本
 * @param {string} termLower - 已转小写的词
 * @returns {boolean} 是否包含
 */
function containsTerm(textLower, termLower) {
  return countOccurrences(textLower, termLower) > 0
}

/**
 * 按关键词规则分类。
 *
 * 打分模型经过两轮返工，每一轮都由实测数据驱动：
 *
 * **第一轮**：标题与正文同权 → 一份文件名含「简历」的 PDF 被正文里的
 * 「设计」「指标」反超，分到「项目文档」。改为标题权重 10 倍 + 歧义词降权。
 *
 * **第二轮**（256 份文档语料实测）：出现 5 例同形词误判 ——
 * 「协议」把交互协议打成合同证照、「诊断」把 diagnostics 打成健康医疗、
 * 「流水」把事件流打成票据财务。
 *
 * 关键判断：这些词在**真实语料里（合同/票据）恰恰是最强信号**，
 * 粗暴降权会把「租房协议」也打错。区别在于**出现在标题还是正文**：
 * 合同会被命名为「XX协议」，而正文里提「协议」多半是技术含义。
 * 因此 `_ambiguousKeywords` 的折扣**只作用于正文命中**，标题命中保持满分。
 *
 * 曾尝试的第三条路（已否决）：用 `Intl.Segmenter` 判断关键词是否作为
 * 独立词出现。实测分词器把「流水线」切成 `["流水","线"]`、
 * 「诊断信息」切成 `["诊断","信息"]` —— 同形词在两种语义下都是独立词，
 * 分词无法消歧。词义消歧只能靠策展词表或 LLM。
 *
 * @param {string} title - 标题（文件名 + 非垃圾内嵌标题）
 * @param {string} text - 正文
 * @param {object} taxonomy - 词表
 * @returns {{categories:string[], scores:Record<string,number>, tags:string[]}} 结果
 */
export function classifyByRules(title, text, taxonomy) {
  const head = String(text ?? '').slice(0, 20000)
  const titleLower = String(title ?? '').toLowerCase()
  const headLower = head.toLowerCase()

  // 同形词表：强同形词重折，弱同形词轻折。
  // 注意区分「同形词」与「泛词」—— 泛词（配置/参数/架构/接口）是技术文档的
  // 正确信号，把它们当同形词打折会让「技术参考」整类失效（实测过，是回退）。
  const amb = taxonomy._ambiguousKeywords ?? {}
  const strongWords = new Set((amb.strongWords ?? amb.words ?? []).map((w) => String(w).toLowerCase()))
  const mildWords = new Set((amb.mildWords ?? []).map((w) => String(w).toLowerCase()))
  const strongWeight = Number(amb.bodyWeight) || 0.25
  const mildWeight = Number(amb.mildWeight) || 0.6

  // 统计每个关键词横跨几个分类 —— 跨得越多越没区分度
  const kwSpread = new Map()
  for (const cat of taxonomy.categories) {
    for (const kw of cat.keywords ?? []) {
      const k = String(kw).toLowerCase()
      if (!k) continue
      kwSpread.set(k, (kwSpread.get(k) ?? 0) + 1)
    }
  }

  const scores = {}
  const matchedTags = new Set()

  const TITLE_WEIGHT = 10
  const BODY_MAX_PER_KW = 5

  for (const cat of taxonomy.categories) {
    if (cat.id === 'other') continue   // 「未归类」不参与竞争
    let score = 0

    for (const kw of cat.keywords ?? []) {
      const k = String(kw).toLowerCase()
      if (!k) continue

      const spread = kwSpread.get(k) ?? 1
      const specificity = spread > 1 ? 0.4 : 1

      let contribution = 0

      // 标题命中：即使是同形词也保持满分（标题是命名，不是随口提及）
      if (containsTerm(titleLower, k)) contribution += TITLE_WEIGHT

      // 正文命中：同形词按歧义强度降权
      const bodyHits = countOccurrences(headLower, k)
      if (bodyHits > 0) {
        let w = 1
        if (strongWords.has(k)) w = strongWeight
        else if (mildWords.has(k)) w = mildWeight
        contribution += Math.min(bodyHits, BODY_MAX_PER_KW) * w
      }

      score += contribution * specificity
    }

    if (score > 0) scores[cat.name] = Math.round(score * 100) / 100
  }

  // 证据不足就不硬给分类：宁可为「未归类」进待复查队列，也不要一个自信的错误分类
  const MIN_EVIDENCE = 2

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1])
  const categories = []
  if (ranked.length > 0 && ranked[0][1] >= MIN_EVIDENCE) {
    categories.push(ranked[0][0])
    // 第二名要接近第一名才并列，否则会把噪声分类一起带上
    if (ranked[1] && ranked[1][1] >= ranked[0][1] * 0.8 && ranked[1][1] >= MIN_EVIDENCE) {
      categories.push(ranked[1][0])
    }
  } else {
    categories.push('未归类')
  }

  // 标签：词表标签在标题或正文里命中即可（只匹配标题时 89.5% 的文档拿不到标签）。
  // ASCII 标签同样按词边界匹配，否则「AI」会把 email / available 也吃掉。
  for (const tag of taxonomy.tags) {
    const t = tag.toLowerCase()
    if (t.length < 2) continue
    if (containsTerm(titleLower, t) || containsTerm(headLower, t)) matchedTags.add(tag)
  }

  return { categories, scores, tags: [...matchedTags] }
}

/**
 * 按分类补默认标签。
 *
 * 没有这一步时，纯规则模式实测 256 份文档里 229 份（89.5%）拿不到任何标签 ——
 * 因为词表标签很少恰好出现在标题里。分类本身是可靠信号，据此补一个
 * 粗粒度标签（如 票据财务 → 财务），能让「按标签浏览」这条路径真正可用。
 *
 * @param {string[]} categories - 最终分类
 * @param {object} taxonomy - 词表
 * @returns {string[]} 默认标签
 */
export function defaultTagsFor(categories, taxonomy) {
  const map = taxonomy._categoryDefaultTags ?? {}
  const out = new Set()
  for (const c of categories ?? []) {
    for (const t of map[c] ?? []) out.add(t)
  }
  return [...out]
}

/* ============================================================
   AI 层
   ============================================================ */

/**
 * 用 AI 生成摘要并从受控词表里选分类与标签。
 *
 * @param {object} opts - { title, text, taxonomy, apiKey, model, timeoutMs }
 * @returns {Promise<{ok:boolean, summary:string, categories:string[], tags:string[], newTags:string[], error:string|null}>} 结果
 */
export async function classifyWithAI(opts) {
  const { title, text, taxonomy } = opts
  const fail = (error) => ({ ok: false, summary: '', categories: [], tags: [], newTags: [], error })

  const cfg = resolveAIConfig({
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
    endpoint: opts.endpoint,
  })
  if (!cfg.configured) {
    return fail('未配置 AI Key（可设 AI_API_KEY / ZHIPU_API_KEY，或复用工作站的 STATION_LLM_API_KEY）')
  }

  const catList = taxonomy.categories.map((c) => `${c.name}（${c.desc}）`).join('\n')
  const tagList = taxonomy.tags.join('、')

  const prompt = `你在给一个个人文档资料库做归档。请阅读文档内容，输出严格 JSON。

【可选分类】只能从下面选，最多选 2 个，必须原样使用名称：
${catList}

【已有标签】优先从中选择，最多 6 个：
${tagList}

【文档标题】${title || '(无)'}

【文档内容】
${String(text ?? '').slice(0, AI_TEXT_LIMIT) || '(无正文，请仅依据标题判断)'}

输出 JSON（不要 markdown 代码块，不要任何解释）：
{"summary":"两到三句话的中文摘要，说明这份文档讲什么、是否重要","categories":["分类名"],"tags":["标签"],"newTags":["确实没有合适标签时最多2个新词"]}`

  let res
  try {
    res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 600,
        stream: false,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60000),
    })
  } catch (err) {
    return fail(`AI 服务不可达（${cfg.endpoint}）：${err?.message ?? err}`)
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    return fail(`AI 服务返回 HTTP ${res.status}：${detail.slice(0, 200)}`)
  }

  let data
  try {
    data = await res.json()
  } catch (err) {
    return fail(`AI 响应不是 JSON：${err?.message ?? err}`)
  }

  const content = data?.choices?.[0]?.message?.content ?? ''
  const parsed = parseLooseJson(content)
  if (!parsed) return fail(`AI 返回内容无法解析为 JSON：${String(content).slice(0, 200)}`)

  // 受控词表校验：不在词表里的分类一律丢弃，「未归类」兜底
  const validNames = new Set(taxonomy.categories.map((c) => c.name))
  const categories = (Array.isArray(parsed.categories) ? parsed.categories : [])
    .map((s) => String(s).trim())
    .filter((s) => validNames.has(s))
    .slice(0, 2)

  const existingTags = new Set(taxonomy.tags)
  const tags = (Array.isArray(parsed.tags) ? parsed.tags : [])
    .map((s) => String(s).trim())
    .filter((s) => s && existingTags.has(s))
    .slice(0, 6)

  const newTags = (Array.isArray(parsed.newTags) ? parsed.newTags : [])
    .map((s) => String(s).trim())
    .filter((s) => s && !existingTags.has(s) && s.length <= 12)
    .slice(0, 2)

  return {
    ok: true,
    summary: String(parsed.summary ?? '').trim().slice(0, 500),
    categories: categories.length ? categories : ['未归类'],
    tags,
    newTags,
    error: null,
  }
}

/**
 * 宽松解析 JSON：模型常把结果包在 ```json 代码块里，或前后带解释文字。
 * @param {string} content - 模型输出
 * @returns {object|null} 解析结果
 */
function parseLooseJson(content) {
  const raw = String(content ?? '').trim()
  const candidates = [
    raw,
    raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''),
  ]
  const braced = raw.match(/\{[\s\S]*\}/)
  if (braced) candidates.push(braced[0])

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c)
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      /* 试下一个候选 */
    }
  }
  return null
}

/* ============================================================
   编排
   ============================================================ */

/**
 * 综合分类：规则与 AI 合并。
 *
 * @param {object} opts - { title, text, taxonomy, apiKey, model, useAI, log }
 * @returns {Promise<object>} 最终分类结果
 */
export async function classify(opts) {
  const rules = classifyByRules(opts.title, opts.text, opts.taxonomy)

  /**
   * 合并标签并补齐默认标签。
   * @param {string[]} categories - 最终分类
   * @param {string[]} tags - 已命中标签
   * @returns {string[]} 最终标签
   */
  const mergeTags = (categories, tags) => {
    const set = new Set([...tags, ...defaultTagsFor(categories, opts.taxonomy)])
    return [...set].slice(0, 8)
  }

  const useAI = opts.useAI !== false && resolveAIConfig({ apiKey: opts.apiKey }).configured
  if (!useAI) {
    return {
      categories: rules.categories,
      tags: mergeTags(rules.categories, rules.tags),
      summary: '',
      source: 'rules',
      needsReview: rules.categories.includes('未归类'),
      aiError: null,
    }
  }

  const ai = await classifyWithAI(opts)
  if (!ai.ok) {
    return {
      categories: rules.categories,
      tags: mergeTags(rules.categories, rules.tags),
      summary: '',
      source: 'rules',
      needsReview: rules.categories.includes('未归类'),
      aiError: ai.error,
    }
  }

  // 合并：AI 分类优先，但若 AI 给了「未归类」而规则有明确答案，采用规则的
  let categories = ai.categories
  if (categories.length === 1 && categories[0] === '未归类' && !rules.categories.includes('未归类')) {
    categories = rules.categories
  }

  const tagSet = new Set([
    ...mergeTags(categories, []),
    ...ai.tags,
    ...rules.tags,
    ...ai.newTags,
  ])
  // 新建了标签 → 提醒人工复查
  const needsReview = ai.newTags.length > 0 || categories.includes('未归类')
  if (needsReview) tagSet.add('待整理')

  return {
    categories,
    tags: [...tagSet].slice(0, 8),
    summary: ai.summary,
    source: 'ai',
    needsReview,
    aiError: null,
  }
}
