/**
 * 服务端一键入库：把暂存区的文件**直接在函数里**变成可检索的文档。
 *
 * ## 为什么需要它
 *
 * 原本入库只有一条路：在本地跑 `node scripts/process-pending.mjs`。
 * 但本地脚本要直写 Netlify Blobs，必须自带 Netlify 的 Personal Access
 * Token —— 这对"我只想在网站上把文件放进去"的人是纯粹的负担
 * （而且很容易和网站的登录密码 `ADMIN_TOKEN` 搞混）。
 *
 * 这个接口用 **admin 权限 + 函数自身的 Blobs 凭据**完成同样的事：
 * 网页上传完，点一下「立即入库」，文档就出现在库里，全程不需要令牌。
 *
 * ## 如实说明能力边界（不假装全能）
 *
 * | 能力 | 服务端 | 本地脚本 |
 * |---|---|---|
 * | 抽正文（PDF/Office/Markdown/代码） | ✅ | ✅ |
 * | 规则分类 + 打标 | ✅ | ✅ |
 * | 预览件（PDF 直接用原件、Markdown/代码渲染） | ✅ | ✅ |
 * | Office → PDF 高保真预览 | ❌ 函数里没有 LibreOffice | ✅ |
 * | docx/pptx 网页视图 | ❌ 需要 jsdom/pagus（体积大） | ✅ |
 * | AI 打标 | ❌ 不联网、不花钱 | ✅（配了密钥时） |
 * | 拼音索引 | ❌（可用 reclassify --pinyin-only 补） | ✅ |
 *
 * Office 文件在这里拿到的是**抽取出来的 HTML 版式预览**，够看内容；
 * 要 PDF 保真版就走本地命令。这一点会写进该文档的 `previewNote`，
 * 用户点开就能看到，不会以为是程序坏了。
 *
 * ## 为什么要顺序处理、还要限时
 *
 * 增量索引更新是"读分片 → 改 → 写回"，并发处理同一批分片会互相覆盖。
 * 所以顺序执行。函数同步上限 60 秒，这里设 45 秒预算：超了就停下来
 * 如实告诉用户"还剩几个，再点一次"。
 *
 * @module netlify/functions/_lib/server-ingest
 */

import { createHash } from 'node:crypto'

import { ok, badRequest, serverError } from './respond.mjs'
import { getDocsStore, STORES } from './store.mjs'
import { readAllMeta, readTaxonomy } from './repo.mjs'
import {
  detectType, mimeOf, titleFromFilename, pickTitle, extractBytes,
} from './extract-text.mjs'
import { classifyByRules, mergeTagsFor } from './classify-rules.mjs'
import { renderCodePage } from './code-view.mjs'
import { renderMarkdownPage } from './markdown-view.mjs'
import { applyDocChange } from './index-store.mjs'
import { escHtml } from './source-view.mjs'
import TAXONOMY_DEFAULT from './taxonomy-default.mjs'

/** 单次最多处理多少份（再多会顶到函数时限）。 */
const MAX_PER_CALL = 10
/** 默认处理几份。 */
const DEFAULT_PER_CALL = 3
/** 时间预算：留 15 秒给响应与冷启动。 */
const TIME_BUDGET_MS = 45_000

/**
 * 取分类词表。
 *
 * ★ 优先用**随构建生成的那份**（`taxonomy-default.mjs`，每次构建都从
 * `config/taxonomy.json` 重新生成），而不是 Blobs 里存的那份。
 *
 * 踩过的坑：起初优先读 Blobs，结果给「学习资料」加上关键词「学习」
 * 并重新部署之后，线上分类**毫无变化** —— 因为 Blobs 里那份是旧运行
 * 写进去的，一直没被覆盖。这种"改了但没生效"不报任何错，最难查。
 *
 * 构建产物永远比运行期缓存新，所以顺序是：
 *   构建产物 → Blobs（万一构建产物缺失）
 * 然后把构建产物写回 Blobs，让 /api/v1/taxonomy 与 reclassify 看到同一份。
 *
 * @returns {Promise<object>} 词表
 */
async function loadTaxonomyForIngest() {
  if (!TAXONOMY_DEFAULT?.categories?.length) {
    const stored = await readTaxonomy().catch(() => null)
    return stored ?? TAXONOMY_DEFAULT
  }

  // 顺手把 Blobs 里的那份刷成构建产物（几 KB，一次调用一次写）
  try {
    const stored = await readTaxonomy().catch(() => null)
    if (JSON.stringify(stored ?? {}) !== JSON.stringify(TAXONOMY_DEFAULT)) {
      const store = await getDocsStore(STORES.INDEX)
      await store.set('taxonomy', JSON.stringify(TAXONOMY_DEFAULT))
    }
  } catch {
    /* 写不进去不影响本次分类 */
  }
  return TAXONOMY_DEFAULT
}

/**
 * 把 HTML 片段包成完整预览页（Office 降级件用）。
 * @param {string} body - 正文 HTML
 * @param {string} title - 标题
 * @returns {string} 完整 HTML
 */
function wrapHtml(body, title) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(title)}</title>
<style>
  body { margin:0; padding:26px 30px; max-width:900px;
         font:15px/1.75 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;
         color:#1a1d23; background:#fff; }
  h1,h2,h3 { line-height:1.35; }
  table { border-collapse:collapse; width:100%; font-size:13.5px; margin:10px 0 20px; }
  td, th { border:1px solid #e2e5ea; padding:5px 9px; vertical-align:top; }
  .sheet-name { margin-top:26px; padding-bottom:6px; border-bottom:2px solid #e2e5ea; }
</style>
</head>
<body>${body}</body></html>`
}

/**
 * 处理一个待入库文件。
 *
 * @param {object} ctx - { rec, buf, inbox, metaStore, filesStore, textStore, previewStore, taxonomy, existingByHash }
 * @returns {Promise<object>} 结果摘要
 */
async function ingestOne(ctx) {
  const { rec, buf, taxonomy, existingByHash } = ctx

  const type = detectType(rec.originalName)
  if (!type) return { status: 'skip', name: rec.originalName, reason: '不支持的类型' }

  const sha256 = createHash('sha256').update(buf).digest('hex')
  const id = sha256.slice(0, 12)

  // 内容已在库里 → 不重复占空间，只把暂存记录删掉
  const dup = existingByHash.get(sha256)
  if (dup) return { status: 'duplicate', name: rec.originalName, docId: dup.id, title: dup.title, sha256, id }

  const extracted = await extractBytes(buf, type)
  const title = pickTitle(extracted.title, titleFromFilename(rec.originalName))
  const ext = rec.ext || (rec.originalName.split('.').pop() ?? '').toLowerCase()

  // ---- 分类（只用规则层：函数里不联网、不花钱）----
  //
  // 提示 = 标题 + 文件名 + **来源目录名**。目录名和文件名一样是人起的名字：
  // `学习/L03_变量.java` 里的「学习」足以说明这是课件。
  // 不加这一条时，整个 Java 课件目录会全部落到「未归类」——
  // 正文是纯代码，词表里的分类关键词一个都不沾。
  //
  // 取**所有上级目录**（最多 4 级）。relativePath 是相对此次导入根目录的，
  // 所以每一级都是人起的、有意义的：`学习/L30_面向对象进阶/多态测试/x.java`
  // 里的「学习」才是关键信号，只取最近一级或两级都会漏掉深层文件。
  // 实测：只取两级时，两级子目录里的那份会掉回「未归类」。
  const relParts = String(rec.relativePath ?? '').split('/').filter(Boolean)
  const dirHint = relParts.slice(0, -1).slice(-4).join(' ')
  const classifyTitle = dirHint ? `${title} ${dirHint}` : title

  const cls = classifyByRules(classifyTitle, extracted.text, taxonomy)
  const tags = mergeTagsFor(cls.categories, cls.tags, taxonomy)

  // ---- 预览件 ----
  let previewKind = 'none'
  let previewNote = ''
  const { previewStore } = ctx

  if (type === 'pdf') {
    previewKind = 'pdf'                       // 原件即最佳预览
  } else if (type === 'md') {
    const r = renderMarkdownPage(buf.toString('utf8'), title)
    await previewStore.set(`${id}.html`, r.html)
    previewKind = 'markdown'
    previewNote = r.ok ? '' : `渲染失败，已回退为纯文本：${r.error}`
  } else if (type === 'code') {
    const r = renderCodePage(buf.toString('utf8'), { title, ext })
    await previewStore.set(`${id}.html`, r.html)
    previewKind = 'code'
    previewNote = r.highlighted ? '' : '未识别语言或文件过大，按纯文本显示'
  } else if (extracted.html) {
    await previewStore.set(`${id}.html`, wrapHtml(extracted.html, title))
    previewKind = 'html'
    previewNote = ['docx', 'xlsx', 'pptx'].includes(type)
      ? '服务端入库：文字版预览（要 PDF 保真版请在本地跑 node scripts/ingest.mjs）'
      : ''
  } else if (extracted.text) {
    previewKind = 'text'
  }

  // ---- 写入 ----
  const now = new Date().toISOString()
  const newMeta = {
    id,
    sha256,
    title,
    embeddedTitle: extracted.title || '',
    originalName: rec.originalName,
    relativePath: rec.relativePath,
    ext,
    type,
    mime: mimeOf(type),
    size: buf.length,
    pages: extracted.pages ?? null,
    author: extracted.author || '',
    docCreatedAt: extracted.docCreatedAt ?? null,
    sourcePath: `upload://${rec.relativePath || rec.originalName}`,
    ingestedAt: now,
    updatedAt: now,
    categories: cls.categories,
    tags,
    summary: '',
    classifySource: 'rules',
    needsReview: cls.categories.includes('未归类') || Boolean(extracted.error),
    aiError: null,
    hasText: Boolean(extracted.text),
    textChars: extracted.text?.length ?? 0,
    extractError: extracted.error,
    previewKind,
    previewNote,
    // 服务端入库没有 webView（需要 jsdom/pagus）
    webView: null,
    ingestedBy: 'server',
  }

  await ctx.filesStore.set(`${id}.${ext}`, buf)
  await ctx.metaStore.set(id, JSON.stringify(newMeta))
  if (extracted.text) {
    const pages = extracted.pageTexts ?? [extracted.text]
    await ctx.textStore.set(id, JSON.stringify({ pages }))
  }

  // 增量更新索引：只读写受影响的分片，不重建全库
  let indexError = null
  try {
    await applyDocChange({ oldMeta: null, newMeta })
  } catch (err) {
    indexError = String(err?.message ?? err)
  }

  return {
    status: 'ingested',
    name: rec.originalName,
    docId: id,
    title,
    categories: newMeta.categories,
    tags,
    previewKind,
    textChars: newMeta.textChars,
    needsReview: newMeta.needsReview,
    indexError,
  }
}

/**
 * 处理入口：POST /api/v1/inbox/ingest（admin）
 *
 * @param {Request} req - 请求
 * @param {URL} url - URL
 * @returns {Promise<Response>} 响应
 */
export async function ingestPending(req, url) {
  let body = {}
  try {
    body = (await req.json()) ?? {}
  } catch {
    /* 允许空 body */
  }

  const asked = Number(body?.limit ?? url.searchParams.get('limit'))
  const limit = Math.min(
    Math.max(Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : DEFAULT_PER_CALL, 1),
    MAX_PER_CALL,
  )

  try {
    const inbox = await getDocsStore(STORES.INBOX)
    const records = await listRecords(inbox)
    if (records.length === 0) {
      return ok({ total: 0, processed: 0, remaining: 0, results: [], note: '暂存区是空的。' }, { req })
    }

    // 先传的先处理
    records.sort((a, b) => String(a.uploadedAt ?? '').localeCompare(String(b.uploadedAt ?? '')))
    const targets = records.slice(0, limit)

    const taxonomy = await loadTaxonomyForIngest()
    if (!taxonomy?.categories?.length) {
      return badRequest('分类词表不可用，无法入库（这是配置问题，请检查 config/taxonomy.json）', { req })
    }

    // 一次性读全库元数据：去重与索引都要用
    const allMeta = await readAllMeta().catch(() => [])
    const existingByHash = new Map()
    for (const d of allMeta) {
      if (d.sha256) existingByHash.set(d.sha256, d)
    }

    const ctx = {
      inbox,
      taxonomy,
      existingByHash,
      filesStore: await getDocsStore(STORES.FILES),
      textStore: await getDocsStore(STORES.TEXT),
      previewStore: await getDocsStore(STORES.PREVIEWS),
      metaStore: await getDocsStore(STORES.META),
    }

    const started = Date.now()
    const results = []
    let done = 0

    for (const rec of targets) {
      if (Date.now() - started > TIME_BUDGET_MS) break

      const buf = await readFileBytes(inbox, rec)
      if (!buf) {
        results.push({ status: 'missing', name: rec.originalName, reason: '暂存区里找不到原文件' })
        await dropRecord(inbox, rec)
        continue
      }

      try {
        const r = await ingestOne({ ...ctx, rec, buf })
        results.push(r)
        // 处理成功后清掉暂存记录（含重复/跳过：它们不会再变）
        await dropRecord(inbox, rec)
        if (r.status === 'ingested') done += 1
      } catch (err) {
        results.push({ status: 'error', name: rec.originalName, reason: String(err?.message ?? err) })
      }
    }

    const remaining = records.length - results.length
    const indexErrors = results.filter((r) => r.indexError)

    return ok({
      total: records.length,
      processed: results.length,
      ingested: done,
      remaining: Math.max(remaining, 0),
      results,
      indexError: indexErrors.length ? `${indexErrors.length} 份的索引更新失败：${indexErrors[0].indexError}` : null,
      note: remaining > 0
        ? `本次处理了 ${results.length} 份，还剩 ${remaining} 份 —— 再点一次继续。`
        : '暂存区已清空。',
    }, { req })
  } catch (err) {
    return serverError(err, 'inbox/ingest', { req })
  }
}

/**
 * 读暂存区里所有待处理记录。
 * @param {object} store - inbox store
 * @returns {Promise<object[]>} 记录
 */
async function listRecords(store) {
  const out = []
  let cursor
  for (let round = 0; round < 20; round++) {
    const page = await store.list({ prefix: 'meta/', limit: 500, cursor })
    for (const blob of page.blobs ?? []) {
      const m = await store.get(blob.key, { type: 'json' }).catch(() => null)
      if (m && m.status !== 'done') out.push(m)
    }
    cursor = page.nextCursor ?? page.cursor
    if (!cursor) break
  }
  return out
}

/**
 * 读暂存区里某个记录的原件字节。
 * @param {object} store - inbox store
 * @param {object} rec - 记录
 * @returns {Promise<Buffer|null>} 内容
 */
async function readFileBytes(store, rec) {
  const key = `file/${rec.id}.${rec.ext}`
  const buf = await store.get(key, { type: 'arrayBuffer' }).catch(() => null)
  if (buf) return Buffer.from(buf)
  // 兜底：早期记录可能没带扩展名
  const alt = await store.get(`file/${rec.id}`, { type: 'arrayBuffer' }).catch(() => null)
  return alt ? Buffer.from(alt) : null
}

/**
 * 清掉一条暂存记录（原件 + 元数据）。
 * @param {object} store - inbox store
 * @param {object} rec - 记录
 * @returns {Promise<void>} 完成
 */
async function dropRecord(store, rec) {
  await store.delete(`file/${rec.id}.${rec.ext}`).catch(() => {})
  await store.delete(`file/${rec.id}`).catch(() => {})
  await store.delete(`meta/${rec.id}`).catch(() => {})
}
