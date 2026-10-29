/**
 * 文档模型：**唯一的构造函数**与不变式检查。
 *
 * ## 为什么要有这个文件
 *
 * 这个库最贵的一次事故是「站点上 0 份文档，数据全在」：
 * 读接口按 `visibility === 'public'` 过滤访客可见范围，
 * 而入库流程从来没写过这个字段 —— 缺一个字段，行为就静默改变了。
 * 同类隐患还有 `tags` 写成字符串、`size` 变成字符串、`needsReview` 缺失等等，
 * 每处都在各自的地方手写对象，谁都不知道完整形状。
 *
 * 所以规定：**任何写进 doc-meta 的对象都必须先过 `normalizeDoc()`**。
 * 它做三件事：
 *
 *   1. 给每个"行为开关"强制一个明确的值（缺失 → 默认值，不是 undefined）
 *   2. 把标量/数组强制成正确类型（`'a'` → `['a']`，`'12'` → `12`）
 *   3. 打上 `schemaVersion`，让将来迁移有据可依
 *
 * 它**不删除**不认识的字段（`pinyin`、`dir`、`ingestedBy`、`webView` 等），
 * 因为迁移期要保住已有数据；多余字段无害，缺字段才有害。
 *
 * ## 过渡期并存
 *
 * 旧的扁平字段（`textChars` / `previewKind` / `previewNote`）保留，
 * 因为前端与现有测试都在读它们；同时补一份结构化视图
 * （`text` / `preview` / `index`）供新代码使用。v3 再删扁平字段。
 *
 * @module netlify/functions/_lib/doc-model
 */

import { titleFromFilename } from './file-types.mjs'

/** 当前模型版本。字段语义变化时 +1，并写迁移。 */
export const SCHEMA_VERSION = 2

/**
 * 新建文档的默认可见性。
 *
 * ★ 已定的策略：**默认私有**。理由是这个库会放简历、合同、私人笔记这类东西，
 * 公开应该是显式动作，不是默认后果。反过来（默认公开）一旦漏掉，
 * 泄露是不可撤销的；默认私有最多是"忘了点公开"，改一下就好。
 *
 * 历史文档不受影响：迁移只补字段，不改已有的值。
 */
export const DEFAULT_VISIBILITY = 'private'

/** 合法的可见性取值。 */
export const VISIBILITIES = ['public', 'private']

/** 合法的生命周期状态。 */
export const STATUSES = ['active', 'archived', 'deleted']

/**
 * 把任意输入收成字符串数组（去空、去重、保序）。
 * @param {unknown} v - 输入
 * @returns {string[]} 干净数组
 */
function stringList(v) {
  const arr = Array.isArray(v) ? v : (v === undefined || v === null || v === '' ? [] : [v])
  const out = []
  const seen = new Set()
  for (const x of arr) {
    const s = String(x ?? '').trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

/**
 * 非负整数，非法输入回退到给定默认值。
 * @param {unknown} v - 输入
 * @param {number} dft - 默认值
 * @returns {number} 整数
 */
function intOf(v, dft) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dft
}

/**
 * 规范化一份文档。
 *
 * @param {object} raw - 原始对象（来自入库、编辑接口、迁移脚本或旧版数据）
 * @param {object} [ctx] - 上下文
 * @param {string} [ctx.now] - 覆盖"当前时间"（测试用）
 * @returns {object} 规范化后的文档
 */
export function normalizeDoc(raw, ctx = {}) {
  const d = { ...(raw ?? {}) }
  const now = ctx.now ?? new Date().toISOString()

  /* ---- 版本 ---- */
  d.schemaVersion = SCHEMA_VERSION

  /* ---- 身份 ---- */
  d.id = String(d.id ?? '').trim()
  d.originalName = String(d.originalName ?? '')
  d.title = String(d.title ?? '').trim()
    || titleFromFilename(d.originalName)
  d.ext = String(d.ext ?? '').toLowerCase().replace(/^\./, '')
  d.type = String(d.type ?? 'txt')
  d.mime = String(d.mime ?? 'application/octet-stream')
  d.size = intOf(d.size, 0)

  /* ---- 行为开关：缺失就给默认值，非法就回退 ---- */
  d.visibility = VISIBILITIES.includes(d.visibility) ? d.visibility : DEFAULT_VISIBILITY
  d.status = STATUSES.includes(d.status) ? d.status : 'active'
  d.needsReview = Boolean(d.needsReview)
  d.rev = Number.isInteger(d.rev) && d.rev > 0 ? d.rev : 1

  /* ---- 分类与标签 ---- */
  d.categories = stringList(d.categories)
  d.tags = stringList(d.tags)

  /* ---- 正文描述（结构化视图 + 兼容旧扁平字段） ---- */
  const chars = intOf(d.textChars ?? d.text?.chars, 0)
  d.text = {
    chars,
    truncated: Boolean(d.textTruncated ?? d.text?.truncated),
    pagesExtracted: d.pagesExtracted ?? d.text?.pagesExtracted ?? null,
    hasText: Boolean(d.hasText ?? chars > 0),
  }
  d.textChars = chars
  d.hasText = d.text.hasText
  d.textTruncated = d.text.truncated
  if (d.pagesExtracted === undefined) d.pagesExtracted = d.text.pagesExtracted

  /* ---- 预览描述 ---- */
  d.preview = {
    kind: String(d.previewKind ?? d.preview?.kind ?? 'none'),
    note: String(d.previewNote ?? d.preview?.note ?? ''),
  }
  d.previewKind = d.preview.kind
  d.previewNote = d.preview.note

  /* ---- 索引进度（不再是旁路的 indexError 字符串） ---- */
  d.index = {
    rev: intOf(d.index?.rev, 0),
    pending: Boolean(d.index?.pending),
    error: d.index?.error ?? null,
  }

  /* ---- 判定依据（可解释性） ---- */
  d.classify = {
    source: String(d.classifySource ?? d.classify?.source ?? 'rules'),
    confidence: typeof d.classify?.confidence === 'number' ? d.classify.confidence : null,
    evidence: Array.isArray(d.classify?.evidence) ? d.classify.evidence : [],
  }
  d.classifySource = d.classify.source
  d.aiError = d.aiError ?? null

  /* ---- 时间 ---- */
  d.ingestedAt = d.ingestedAt ?? now
  d.createdAt = d.createdAt ?? d.ingestedAt
  d.updatedAt = d.updatedAt ?? d.ingestedAt
  d.docCreatedAt = d.docCreatedAt ?? null
  d.author = String(d.author ?? '')

  return d
}

/**
 * 检查一份文档是否满足不变式（供 doctor 与测试使用）。
 *
 * @param {object} doc - 已规范化的文档
 * @returns {string[]} 违规说明；空数组表示通过
 */
export function checkInvariants(doc) {
  const bad = []
  if (!doc || typeof doc !== 'object') return ['不是对象']
  if (!doc.id) bad.push('缺少 id')
  if (doc.schemaVersion !== SCHEMA_VERSION) bad.push(`schemaVersion=${doc.schemaVersion}（期望 ${SCHEMA_VERSION}）`)
  if (!VISIBILITIES.includes(doc.visibility)) bad.push(`visibility 非法：${doc.visibility}`)
  if (!STATUSES.includes(doc.status)) bad.push(`status 非法：${doc.status}`)
  if (!Array.isArray(doc.categories)) bad.push('categories 不是数组')
  if (!Array.isArray(doc.tags)) bad.push('tags 不是数组')
  if (!Number.isInteger(doc.size) || doc.size < 0) bad.push(`size 非法：${doc.size}`)
  if (!Number.isInteger(doc.rev) || doc.rev < 1) bad.push(`rev 非法：${doc.rev}`)
  if (typeof doc.title !== 'string' || !doc.title) bad.push('缺少 title')
  if (!doc.updatedAt) bad.push('缺少 updatedAt')
  return bad
}

/**
 * 版本升级：把旧文档补到当前模型。
 *
 * 与 `normalizeDoc` 的区别：这里**保留一切已有取值**，只补缺失的字段。
 * 所以 `visibility` 缺失时不会变成默认的 private，而是补成 public ——
 * 因为历史上缺失可见性的文档在修复时已被认定应当公开，
 * 迁移不该顺手改变它们的可见范围。
 *
 * @param {object} raw - 旧文档
 * @param {object} [ctx] - 见 normalizeDoc
 * @returns {{doc:object, changed:boolean}} 结果
 */
export function migrateDoc(raw, ctx = {}) {
  const before = JSON.stringify(raw)
  const filled = { ...raw }

  // 迁移语义：历史文档缺 visibility 视为 public（它们是被公开过的）
  if (!VISIBILITIES.includes(filled.visibility)) filled.visibility = 'public'

  const doc = normalizeDoc(filled, ctx)
  return { doc, changed: JSON.stringify(doc) !== before }
}
