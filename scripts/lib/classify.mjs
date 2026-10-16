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

/** 智谱 OpenAI 兼容端点（与图库 ai-proxy 一致）。 */
const ZHIPU_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
const ZHIPU_MODEL = 'glm-4-flash'

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

/**
 * 按关键词规则分类。
 *
 * 打分模型（第一版设计有缺陷，已重构）：
 *
 * 初版让标题命中与正文命中同权（标题 3 分、正文每次出现 1 分），
 * 结果是**正文噪声淹没标题信号**。实测：一份文件名含「简历」的 PDF
 * 被分到「项目文档」—— 标题给的 3 分被正文里「设计」堆出的 4 分反超，
 * 而「健康医疗」靠「指标」这种泛词也拿到 3 分。
 *
 * 现模型：
 *   1. **标题/文件名命中权重 10 倍于正文** —— 文件名是用户亲手起的，
 *      信噪比远高于正文；正文含「项目」「指标」纯属偶然。
 *   2. **歧义词降权** —— 同时出现在多个分类词表里的词（如「设计」）
 *      区分度低，按 0.4 计。
 *   3. **同名次需接近才并列分类** —— 第二名要到第一名的 80% 才同时归入，
 *      避免把噪声分类一起塞进去。
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

      // 歧义折扣
      const spread = kwSpread.get(k) ?? 1
      const specificity = spread > 1 ? 0.4 : 1

      if (titleLower.includes(k)) score += TITLE_WEIGHT * specificity

      if (headLower.includes(k)) {
        const hits = Math.min(headLower.split(k).length - 1, BODY_MAX_PER_KW)
        score += hits * specificity
      }
    }

    if (score > 0) scores[cat.name] = Math.round(score * 100) / 100
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1])
  const categories = []
  if (ranked.length > 0) {
    categories.push(ranked[0][0])
    // 第二名要接近第一名才并列，否则会把噪声分类一起带上
    if (ranked[1] && ranked[1][1] >= ranked[0][1] * 0.8) categories.push(ranked[1][0])
  } else {
    categories.push('未归类')
  }

  // 标签：词表标签里能直接命中的先收下
  for (const tag of taxonomy.tags) {
    const t = tag.toLowerCase()
    if (t.length < 2) continue
    if (titleLower.includes(t)) matchedTags.add(tag)
  }

  return { categories, scores, tags: [...matchedTags] }
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
  const { title, text, taxonomy, apiKey } = opts
  const fail = (error) => ({ ok: false, summary: '', categories: [], tags: [], newTags: [], error })

  if (!apiKey) return fail('未配置 ZHIPU_API_KEY')

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
    res = await fetch(opts.endpoint || ZHIPU_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model || ZHIPU_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 600,
        stream: false,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60000),
    })
  } catch (err) {
    return fail(`AI 服务不可达：${err?.message ?? err}`)
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

  const useAI = opts.useAI !== false && Boolean(opts.apiKey)
  if (!useAI) {
    return {
      categories: rules.categories,
      tags: rules.tags,
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
      tags: rules.tags,
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

  const tagSet = new Set([...ai.tags, ...rules.tags, ...ai.newTags])
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
