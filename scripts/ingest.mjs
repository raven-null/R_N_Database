/**
 * 入库流水线 —— 整个项目的主体。
 *
 * 库是空的，所以「怎么把文件变成可检索的资料」才是核心，
 * 网页只是这条流水线的显示器。
 *
 * 流程：
 *   扫描 → SHA-256 去重 → 抽正文与元数据 → 分类打标
 *        → 生成预览件 → 写 Blobs/本地存储 → 重建索引
 *
 * 上传方式：**本地直写存储，不走 HTTP 上传接口。**
 * 图库项目评审记录过 base64 上传导致峰值内存放大到约 55MB（15MB 文件）
 * 的问题；直写绕开函数体积限制与 base64 放大，且能批量跑。
 * 因此本脚本在 remote 模式缺少凭据时**直接报错，不静默退回本地**。
 *
 * 用法：
 *   node scripts/ingest.mjs                       # 扫描默认 inbox/
 *   node scripts/ingest.mjs "E:\学习"             # 扫描指定目录
 *   node scripts/ingest.mjs "E:\学习" --force      # 忽略去重，强制重入
 *   node scripts/ingest.mjs --no-ai               # 跳过 AI，只用规则分类
 *   node scripts/ingest.mjs --dry-run             # 只报告，不写入
 *
 * @module scripts/ingest
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadEnv, loadExtraEnv, requireEnv } from './env.mjs'
import { detectType, extractFile, canExtractText, titleFromFilename, pickTitle, isJunkTitle, mimeOf } from './lib/extract.mjs'
import { classify, loadTaxonomy, resolveAIConfig } from './lib/classify.mjs'
import { pinyinForms } from './lib/pinyin.mjs'
import { renderMarkdownPage } from './lib/markdown.mjs'
import { renderCodePage } from '../netlify/functions/_lib/code-view.mjs'
import { convertToPdfDetailed, findLibreOffice as findSoffice, officeEngineStatus } from './lib/office.mjs'
// 索引重建与 scripts/reindex.mjs 共用同一实现，避免两条路径产物不一致
import { rebuildStoreIndex } from './lib/rebuild-index.mjs'
import { getDocsStore, STORES, resolveStoreMode } from '../netlify/functions/_lib/store.mjs'

const ROOT = process.cwd()
const TAXONOMY_FILE = join(ROOT, 'config', 'taxonomy.json')

/** 单次入库处理的文件体积上限（300MB），防止误扫到大文件把内存打爆。 */
const MAX_FILE_BYTES = 300 * 1024 * 1024

/** 目录扫描时跳过的目录名。 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.local-data', '.netlify', '.pnpm-store', '.npm-cache',
  'dist', 'build', 'target-build', 'dist-desktop', '$RECYCLE.BIN', 'System Volume Information',
])

/* ============================================================
   参数解析
   ============================================================ */

/**
 * 解析命令行参数。
 * @returns {object} 选项
 */
function parseArgs() {
  const args = process.argv.slice(2)
  const paths = []
  const opts = { force: false, useAI: true, dryRun: false, limit: 0 }

  for (const arg of args) {
    if (arg === '--force') opts.force = true
    else if (arg === '--no-ai') opts.useAI = false
    else if (arg === '--dry-run') opts.dryRun = true
    else if (arg.startsWith('--limit=')) opts.limit = Number(arg.slice(8)) || 0
    else if (arg.startsWith('-')) throw new Error(`未知参数：${arg}`)
    else paths.push(arg)
  }

  if (paths.length === 0) paths.push(join(ROOT, 'inbox'))
  return { paths, ...opts }
}

/* ============================================================
   文件扫描
   ============================================================ */

/**
 * 递归扫描目录，收集支持的文件。
 * @param {string} dir - 目录或文件路径
 * @param {number} [depth] - 当前深度
 * @returns {string[]} 文件路径列表
 */
function scanFiles(dir, depth = 0) {
  if (depth > 12) return []

  let st
  try {
    st = statSync(dir)
  } catch {
    return []
  }

  if (st.isFile()) return detectType(dir) ? [dir] : []

  const out = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }

  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      out.push(...scanFiles(full, depth + 1))
    } else if (entry.isFile()) {
      if (detectType(full)) out.push(full)
    }
  }
  return out
}

/* ============================================================
   存储读写
   ============================================================ */

/** 各 store 句柄缓存。 */
const storeCache = new Map()

/**
 * 取 store 句柄（带缓存）。
 * @param {string} name - store 名
 * @returns {Promise<object>} store
 */
async function store(name) {
  if (!storeCache.has(name)) storeCache.set(name, await getDocsStore(name))
  return storeCache.get(name)
}

/**
 * 读取源路径 → 文档 id 的映射，用于识别「同一文件的新版本」。
 * 写回由 rebuildStoreIndex 统一负责（它拿 pathIndex 一并落盘）。
 * @returns {Promise<Record<string, {id:string, ingestedAt:string}>>} 映射
 */
async function readPathIndex() {
  const s = await store(STORES.INDEX)
  try {
    return (await s.get('paths', { type: 'json' })) ?? {}
  } catch {
    return {}
  }
}

/**
 * 删除一份文档在所有 store 里的痕迹。
 * @param {string} id - 文档 id
 * @returns {Promise<void>} 完成
 */
async function deleteDoc(id) {
  const [files, previews, text, meta] = await Promise.all([
    store(STORES.FILES), store(STORES.PREVIEWS), store(STORES.TEXT), store(STORES.META),
  ])
  // 原件 key 带扩展名，需按前缀找
  const listed = await files.list({ prefix: `${id}.` }).catch(() => ({ blobs: [] }))
  for (const blob of listed.blobs ?? []) {
    await files.delete(blob.key).catch(() => {})
  }
  await Promise.all([
    files.delete(id).catch(() => {}),
    previews.delete(`${id}.html`).catch(() => {}),
    previews.delete(`${id}.pdf`).catch(() => {}),
    text.delete(id).catch(() => {}),
    meta.delete(id).catch(() => {}),
  ])
}

/* ============================================================
   预览件生成
   ============================================================ */

/**
 * 探测 LibreOffice（转 Office 文档用），委托给共享模块。
 * @returns {string|null} 路径或 null
 */
function findLibreOffice() {
  return findSoffice()
}

/* ============================================================
   单文件处理
   ============================================================ */

/**
 * 处理单个文件：抽取 → 分类 → 写入。
 *
 * 导出给 `scripts/process-pending.mjs` 复用 —— 网页上传的文件最终也走
 * 这同一条流水线，避免「命令行入库」与「网页上传入库」两套行为不一致。
 *
 * @param {string} filePath - 文件路径（真实磁盘路径，抽取器需要读它）
 * @param {object} ctx - { taxonomy, useAI, apiKey, force, dryRun, pathIndex }
 * @param {object} [override] - { originalName, sourcePath }
 *   网页上传时文件先落在临时目录、名字被清洗过，
 *   用这两个字段把**真实文件名**与**来源标识**还原回元数据里
 * @returns {Promise<object>} 处理结果
 */
export async function ingestOne(filePath, ctx, override = {}) {
  const abs = resolve(filePath)
  const type = detectType(override.originalName ?? abs)
  const name = override.originalName ?? basename(abs)
  const title = titleFromFilename(name)

  if (!type) return { status: 'skip', name, reason: '不支持的类型' }

  const size = statSync(abs).size
  if (size > MAX_FILE_BYTES) {
    return { status: 'skip', name, reason: `文件过大（${(size / 1024 / 1024).toFixed(1)}MB）` }
  }

  const buf = readFileSync(abs)
  const id = createHash('sha256').update(buf).digest('hex').slice(0, 12)

  // 路径索引的键：上传来的文件用逻辑来源（upload://xxx），
  // 这样同一份上传重复处理时能正确识别为「未变」而不是每次新增
  const pathKey = override.sourcePath ?? abs

  // ---- 去重：同路径同内容 → 跳过；同路径不同内容 → 删旧迎新 ----
  const prior = ctx.pathIndex[pathKey]
  if (prior && prior.id === id && !ctx.force) {
    return { status: 'unchanged', name, id }
  }
  if (prior && prior.id !== id && !ctx.dryRun) {
    await deleteDoc(prior.id)
  }

  // ---- 已经存在同样内容（换了个路径）→ 直接复用，不重复占用 ----
  if (!ctx.force) {
    const metaStore = await store(STORES.META)
    const existing = await metaStore.get(id, { type: 'json' }).catch(() => null)
    if (existing) {
      if (!ctx.dryRun) {
        ctx.pathIndex[pathKey] = { id, ingestedAt: existing.ingestedAt }
      }
      return { status: 'duplicate', name, id, title: existing.title }
    }
  }

  if (ctx.dryRun) {
    return { status: 'would-ingest', name, id, type, size }
  }

  // ---- 抽取 ----
  const extracted = await extractFile(abs, type)
  // 标题提前算好：预览件渲染与分类都要用
  const finalTitle = pickTitle(extracted.title, title)

  // ---- 分类打标 ----
  // 关键：把**文件名**与内嵌标题一起送进分类器。
  // 文件名往往含最有价值的线索（「简历」「发票」「合同」），
  // 而内嵌标题常是垃圾值。只取内嵌标题会让分类失准
  // （实测：一份简历因内嵌标题 about:blank 被误分到「项目文档」）。
  const titleHints = [
    title,                                                     // 来自文件名
    isJunkTitle(extracted.title) ? '' : extracted.title,        // 内嵌标题（非垃圾才用）
  ].filter(Boolean).join(' ')

  const cls = await classify({
    title: titleHints,
    text: extracted.text,
    taxonomy: ctx.taxonomy,
    apiKey: ctx.useAI ? ctx.apiKey : '',
    useAI: ctx.useAI,
  })

  // ---- 预览件 ----
  let previewKind = 'none'
  let previewNote = ''
  const previewStore = await store(STORES.PREVIEWS)

  if (type === 'pdf') {
    // PDF 本身就是最好的预览件，不必再存一份副本
    previewKind = 'pdf'
  } else if (['docx', 'xlsx', 'pptx'].includes(type)) {
    // 优先用 Office 桌面应用自己的引擎导出 PDF（与桌面所见完全一致），
    // 不可用时退回 LibreOffice。
    // 先前实测：一份 21 页 PPT 走降级后只剩一堆 <li>，图片与排版全丢；
    // 而 LibreOffice 与 PowerPoint 的排版引擎不同，密集排版会文字溢出。
    const { pdf, engine } = await convertToPdfDetailed(abs)
    if (pdf) {
      await previewStore.set(`${id}.pdf`, pdf)
      previewKind = 'pdf'
      previewNote = engine === 'office' ? 'Office 桌面引擎转换' : 'LibreOffice 转换'
    } else if (extracted.html) {
      await previewStore.set(`${id}.html`, wrapPreviewHtml(extracted.html, finalTitle))
      previewKind = 'html'
      previewNote = 'HTML 降级（无可用转换器，版式会丢失）'
    }
  } else if (type === 'code') {
    // 代码：带行号 + 语法高亮的只读预览。
    // 与 md 同理用**原件字节**渲染 —— 抽取只统一换行，
    // 但缩进与行尾空白必须原样保留，否则代码就失真了。
    const { html } = renderCodePage(buf.toString('utf8'), {
      title: finalTitle,
      ext: extname(abs),
    })
    await previewStore.set(`${id}.html`, html)
    previewKind = 'code'
  } else if (type === 'md') {
    // Markdown 双视图：渲染件在入库时生成并缓存；
    // 源码视图（代码格式）由函数按需即时生成，不占存储。
    //
    // ★ 用**原件字节**渲染，而不是 extracted.text。
    // 抽取时 cleanText 会压缩连续空格、去掉行首缩进、合并多个空行 ——
    // 那对检索无害，但会让围栏代码块和列表层级在渲染视图里失真。
    const rendered = renderMarkdownPage(buf.toString('utf8'), finalTitle)
    await previewStore.set(`${id}.html`, rendered.html)
    previewKind = 'markdown'
    previewNote = rendered.ok ? '' : `渲染失败，已回退为纯文本：${rendered.error}`
  } else if (type === 'txt' || type === 'csv') {
    if (extracted.html) {
      await previewStore.set(`${id}.html`, wrapPreviewHtml(extracted.html, finalTitle))
      previewKind = 'html'
    } else {
      previewKind = 'text'
    }
  }

  // ---- 写入 ----
  const now = new Date().toISOString()
  const meta = {
    id,
    sha256: createHash('sha256').update(buf).digest('hex'),
    title: finalTitle,
    // 拼音在入库时算好：前端就不必加载 315KB 的 pinyin-pro
    pinyin: pinyinForms(`${finalTitle} ${name}`) ?? undefined,
    embeddedTitle: extracted.title || '',
    originalName: name,
    ext: extname(abs).toLowerCase().replace('.', ''),
    type,
    mime: mimeOf(type),
    size,
    pages: extracted.pages ?? null,
    author: extracted.author || '',
    docCreatedAt: extracted.docCreatedAt ?? null,
    // 来源：网页上传的文件用 upload://<原名>（覆盖传入），
    // 命令行扫描的用真实路径
    sourcePath: override.sourcePath ?? abs,
    sourceDir: override.sourcePath ?? (relative(ROOT, abs).startsWith('..') ? resolve(abs, '..') : relative(ROOT, abs)),
    fileModifiedAt: statSync(abs).mtime.toISOString(),
    ingestedAt: now,
    updatedAt: now,
    categories: cls.categories,
    tags: cls.tags,
    summary: cls.summary,
    classifySource: cls.source,
    needsReview: cls.needsReview,
    aiError: cls.aiError,
    hasText: Boolean(extracted.text),
    textChars: extracted.text?.length ?? 0,
    extractError: extracted.error,
    previewKind,
    previewNote,
  }

  const filesStore = await store(STORES.FILES)
  const textStore = await store(STORES.TEXT)
  const metaStore = await store(STORES.META)

  await filesStore.set(`${id}.${meta.ext}`, buf)
  await metaStore.set(id, JSON.stringify(meta))

  if (extracted.text) {
    // PDF 按页存，便于将来做「跳到命中页」；其他类型整篇存
    const pages = extracted.pageTexts ?? [extracted.text]
    await textStore.set(id, JSON.stringify({ pages }))
  }

  ctx.pathIndex[pathKey] = { id, ingestedAt: now }
  ctx.ingested.push(meta)

  return {
    status: 'ingested',
    name,
    id,
    title: meta.title,
    categories: meta.categories,
    tags: meta.tags,
    previewKind,
    previewNote,
    textChars: meta.textChars,
    needsReview: meta.needsReview,
  }
}

/**
 * 把抽取出的 HTML 片段包成完整预览页。
 * @param {string} body - 正文 HTML
 * @param {string} title - 标题
 * @returns {string} 完整 HTML
 */
function wrapPreviewHtml(body, title) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
  body { margin:0; padding:28px 32px; font:15px/1.75 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;
         color:#1a1d23; background:#fff; max-width:900px; }
  h1,h2,h3 { line-height:1.35; }
  .sheet-name { margin-top:28px; padding-bottom:6px; border-bottom:2px solid #e2e5ea; }
  .sheet-table { border-collapse:collapse; width:100%; font-size:13.5px; margin:10px 0 24px; }
  .sheet-table td { border:1px solid #e2e5ea; padding:5px 9px; vertical-align:top; }
  .sheet-table tr:nth-child(even) td { background:#fafbfc; }
  .slide { border:1px solid #e2e5ea; border-radius:10px; padding:16px 22px; margin:16px 0; }
  .slide h3 { margin:0 0 10px; font-size:13px; color:#667085; font-weight:600; }
  .slide ul { margin:0; padding-left:22px; }
  .slide li { margin:4px 0; }
  .empty-slide { color:#98a2b3; font-style:italic; margin:0; }
  img { max-width:100%; height:auto; }
  table { border-collapse:collapse; }
  td,th { border:1px solid #e2e5ea; padding:5px 9px; }
</style></head>
<body>${body}</body></html>`
}

/**
 * HTML 转义。
 * @param {string} s - 原文
 * @returns {string} 转义结果
 */
function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/* ============================================================
   主流程
   ============================================================ */

async function main() {
  const env = loadEnv()
  // 显式指定的额外 .env（如复用工作站的 LLM 配置），不指定就不读
  const extraEnv = loadExtraEnv()
  const opts = parseArgs()

  console.log('▸ R_N_Database 入库\n')
  console.log(`  存储模式   ${resolveStoreMode()}`)

  const ai = resolveAIConfig()
  console.log(`  AI 打标    ${opts.useAI
    ? (ai.configured
        ? `启用 · ${ai.model} · ${ai.endpoint}\n             密钥来源 ${ai.source}`
        : '未配置密钥，将只用规则分类（可设 AI_API_KEY / ZHIPU_API_KEY）')
    : '已禁用（--no-ai）'}`)
  console.log(`  Office 转换 ${officeEngineStatus()}`)

  // remote 模式必须凭据齐备，绝不静默退回本地
  if (resolveStoreMode() === 'remote' && !opts.dryRun) {
    requireEnv(['SITE_ID', 'NETLIFY_ACCESS_TOKEN'], '向线上 Blobs 入库')
  }

  const taxonomy = loadTaxonomy(TAXONOMY_FILE)
  console.log(`  分类词表   ${taxonomy.categories.length} 类 / ${taxonomy.tags.length} 标签`)

  // ---- 扫描 ----
  const files = []
  for (const p of opts.paths) {
    const abs = resolve(p)

    // 默认的 inbox/ 不存在时自动建，省得用户先手动 mkdir 再回来
    if (!existsSync(abs) && abs === join(ROOT, 'inbox')) {
      const { mkdirSync, writeFileSync } = await import('node:fs')
      mkdirSync(abs, { recursive: true })
      writeFileSync(join(abs, '把文档放进这个文件夹.txt'),
        '把要入库的文档放进本文件夹，然后运行：\n\n'
        + '    node scripts/ingest.mjs\n\n'
        + '支持 PDF / DOCX / XLSX / PPTX / MD / TXT / CSV。\n'
        + '本文件夹已在 .gitignore 中忽略，文档不会进 Git。\n', 'utf8')
      console.log(`\n  已创建 ${abs}（把文档放进去后重跑本命令）`)
    }

    if (!existsSync(abs)) {
      console.log(`\n  ⚠ 路径不存在，已跳过：${abs}`)
      continue
    }
    const found = scanFiles(abs)
    console.log(`\n  扫描 ${abs} → ${found.length} 个可入库文件`)
    files.push(...found)
  }

  if (files.length === 0) {
    console.log('\n  没有可入库的文件。')
    console.log('  把文档放进 inbox/ 目录后重跑，或指定目录：')
    console.log('    node scripts/ingest.mjs "D:\\我的文档"')
    return
  }

  const target = opts.limit > 0 ? files.slice(0, opts.limit) : files

  // ---- 逐份处理 ----
  const ctx = {
    taxonomy,
    useAI: opts.useAI,
    // 具体用哪把 key / 哪个端点由 classify 里的 resolveAIConfig 决定，
    // 不在这里写死，以便复用工作站已有的 STATION_LLM_* 配置
    apiKey: '',
    force: opts.force,
    dryRun: opts.dryRun,
    pathIndex: await readPathIndex(),
    ingested: [],
  }

  const tally = { ingested: 0, unchanged: 0, duplicate: 0, skip: 0, would: 0, failed: 0 }

  console.log(`\n  开始处理 ${target.length} 个文件${opts.dryRun ? '（dry-run，不写入）' : ''}\n`)

  for (let i = 0; i < target.length; i++) {
    const file = target[i]
    const label = `[${String(i + 1).padStart(3)}/${target.length}]`
    try {
      const r = await ingestOne(file, ctx)
      const short = r.name.length > 44 ? r.name.slice(0, 41) + '…' : r.name

      if (r.status === 'ingested') {
        tally.ingested++
        const tags = (r.tags ?? []).slice(0, 4).join(',')
        console.log(`  ${label} ✓ ${short}`)
        console.log(`          → ${r.title}`)
        console.log(`            分类 ${(r.categories ?? []).join('/')} | 标签 ${tags || '无'} | 正文 ${r.textChars} 字 | 预览 ${r.previewKind}${r.needsReview ? ' | ⚠待复查' : ''}`)
      } else if (r.status === 'unchanged') {
        tally.unchanged++
        console.log(`  ${label} = ${short}（内容未变，跳过）`)
      } else if (r.status === 'duplicate') {
        tally.duplicate++
        console.log(`  ${label} ⧉ ${short}（同样内容已存在：${r.id}）`)
      } else if (r.status === 'would-ingest') {
        tally.would++
        console.log(`  ${label} ? ${short}（将入库，${(r.size / 1024).toFixed(0)}KB）`)
      } else {
        tally.skip++
        console.log(`  ${label} − ${short}（${r.reason}）`)
      }
    } catch (err) {
      tally.failed++
      console.log(`  ${label} ✗ ${basename(file)}`)
      console.log(`          ${err?.message ?? err}`)
    }
  }

  // ---- 重建索引 ----
  // 索引面向全库重建（而不是只针对本次入库的几份），
  // 逻辑与 scripts/reindex.mjs 共用，保证两条路径产物一致。
  if (!opts.dryRun) {
    console.log('\n  重建检索索引…')
    const result = await rebuildStoreIndex({
      taxonomy,
      pathIndex: ctx.pathIndex,
      onProgress: (msg) => console.log(`  · ${msg}`),
    })
    console.log(`  索引完成：${result.docCount} 份文档 / ${result.termCount} 个词条 / 版本 ${result.version}`)
  }

  // ---- 汇总 ----
  console.log('\n────────────────────────────────')
  if (opts.dryRun) {
    console.log(`  dry-run：${tally.would} 份将入库，${tally.unchanged} 份未变，${tally.duplicate} 份重复，${tally.skip} 份跳过`)
  } else {
    console.log(`  新入库 ${tally.ingested} | 未变 ${tally.unchanged} | 重复 ${tally.duplicate} | 跳过 ${tally.skip} | 失败 ${tally.failed}`)
  }

  if (env.loaded) console.log(`  已读取 .env（${env.keys.length} 个键）`)
  if (extraEnv.loaded) {
    console.log(`  已读取 DOCS_AI_ENV 指定的 ${extraEnv.path}（${extraEnv.keys.length} 个键，只报键名不报值）`)
  }
  console.log('')
}

/**
 * 构造一份入库上下文（供其他脚本复用）。
 *
 * 关键点：`pathIndex` 必须是**真实的**路径索引，
 * 否则上传件重复处理时会被当成新文件反复入库。
 *
 * @param {object} opts - { taxonomy, useAI, force, dryRun }
 * @returns {Promise<object>} ctx
 */
export async function makeIngestContext(opts) {
  return {
    taxonomy: opts.taxonomy,
    useAI: opts.useAI !== false,
    apiKey: '',
    force: Boolean(opts.force),
    dryRun: Boolean(opts.dryRun),
    pathIndex: await readPathIndex(),
    ingested: [],
  }
}

/* ============================================================
   作为 CLI 运行
   ============================================================
   本文件既是被 process-pending.mjs 导入的模块，也是独立命令。
   加这道守卫，被 import 时不会误跑 main()。
   ============================================================ */

const isEntryPoint = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return resolve(entry) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
})()

if (isEntryPoint) {
  main().catch((err) => {
    console.error('\n入库失败：', err?.message ?? err)
    if (err?.code === 'BLOBS_UNAVAILABLE' || err?.code === 'MISSING_ENV') {
      console.error('\n提示：remote 模式需要 SITE_ID + NETLIFY_ACCESS_TOKEN。')
      console.error('     若只想在本地试用，把 DOCS_STORE_MODE 设为 local（或不设，默认就是 local）。')
    }
    process.exit(1)
  })
}
