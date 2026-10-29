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

/* ============================================================
   规则层
   ============================================================ */

// 实现已搬到 netlify/functions/_lib/classify-rules.mjs —— 服务端一键入库
// 也要分类，而函数不能 import 到 scripts/ 里。这里转出，调用点不用改。
export {
  classifyByRules,
  defaultTagsFor,
  mergeTagsFor,
} from '../../netlify/functions/_lib/classify-rules.mjs'

import { classifyByRules, mergeTagsFor } from '../../netlify/functions/_lib/classify-rules.mjs'

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
  const mergeTags = (categories, tags) => mergeTagsFor(categories, tags, opts.taxonomy)

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
