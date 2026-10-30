/**
 * 重新分类 —— 不重新抽取文档。
 *
 * 什么时候用它：
 *   - 改了 config/taxonomy.json（增删分类、调整关键词、改同形词表）
 *   - 改了 scripts/lib/classify.mjs 的打分模型
 *   - 旧文档是早期版本分的类，想用新规则刷新
 *
 * 什么时候不该用它：文档内容本身变了 —— 那要重跑 ingest。
 *
 * 默认只重跑**规则层**。加 --ai 才调 AI（会产生 API 费用），
 * 且只处理缺失摘要或待复查的文档。
 *
 * 用法：
 *   node scripts/reclassify.mjs              # 全库按规则重分
 *   node scripts/reclassify.mjs --dry-run    # 只报告变化，不写入
 *   node scripts/reclassify.mjs --ai         # 顺带用 AI 补摘要与分类
 *   node scripts/reclassify.mjs --pinyin-only    # 只补拼音（派生字段）
 *   node scripts/reclassify.mjs --previews-only  # 只重建预览件（Markdown 渲染件 / 代码高亮件 / Office→PDF）
 *
 * @module scripts/reclassify
 */

import { join } from 'node:path'
import { loadEnv } from './env.mjs'
import { loadTaxonomy, classify, resolveAIConfig } from './lib/classify.mjs'
import { pinyinForms } from './lib/pinyin.mjs'
import { renderMarkdownPage } from './lib/markdown.mjs'
import { renderCodePage } from '../netlify/functions/_lib/code-view.mjs'
import { convertBytesToPdfDetailed, OFFICE_TYPES, officeEngineStatus } from './lib/office.mjs'
import { rebuildStoreIndex } from './lib/rebuild-index.mjs'
import { getDocsStore, STORES, resolveStoreMode } from '../netlify/functions/_lib/store.mjs'

const ROOT = process.cwd()

/**
 * 解析命令行参数。
 * @returns {{dryRun:boolean, useAI:boolean, limit:number, onlyReview:boolean, force:boolean}} 选项
 */
function parseArgs() {
  const args = process.argv.slice(2)
  const opts = {
    dryRun: false, useAI: false, limit: 0,
    onlyReview: false, force: false, pinyinOnly: false, previewsOnly: false,
  }
  for (const a of args) {
    if (a === '--dry-run') opts.dryRun = true
    else if (a === '--ai') opts.useAI = true
    else if (a === '--only-review') opts.onlyReview = true
    else if (a === '--force') opts.force = true
    else if (a === '--pinyin-only') opts.pinyinOnly = true
    else if (a === '--previews-only') opts.previewsOnly = true
    else if (a.startsWith('--limit=')) opts.limit = Number(a.slice(8)) || 0
  }
  return opts
}

function pinyinSourceOf(doc) {
  // 标题通常就是从文件名推出来的，直接拼会把同一串算两遍
  // （实测得到 alibababianmaguifan alibababianmaguifan）
  const base = String(doc?.originalName ?? '').replace(/\.[^.]+$/, '')
  return [...new Set([doc?.title, base].filter(Boolean))].join(' ')
}

/**
 * 判断这份文档是否被人工改过。
 *
 * ★ 批量任务绝不能覆盖人工策展。你在网页上把一份文档的分类改对、
 * 把「待复查」清掉，一次 reclassify 就把成果冲掉，那编辑面板就白做了。
 * 标了 manual 的文档默认跳过，要覆盖得显式加 --force。
 *
 * @param {object} doc - 文档元数据
 * @returns {boolean} 是否人工编辑过
 */
function isManuallyEdited(doc) {
  return String(doc?.classifySource ?? '').includes('manual')
}

async function main() {
  const env = loadEnv()
  const opts = parseArgs()

  console.log('▸ 渡·资·集 重新分类\n')
  console.log(`  存储模式   ${resolveStoreMode()}`)

  const ai = resolveAIConfig()
  console.log(`  AI         ${opts.useAI
    ? (ai.configured ? `启用 · ${ai.model} · 密钥来源 ${ai.source}` : '已请求但未配置密钥，将只用规则')
    : '关闭（仅规则）'}`)

  const taxonomy = loadTaxonomy(join(ROOT, 'config', 'taxonomy.json'))
  const strong = taxonomy._ambiguousKeywords?.strongWords ?? []
  const mild = taxonomy._ambiguousKeywords?.mildWords ?? []
  console.log(`  分类词表   ${taxonomy.categories.length} 类 / ${taxonomy.tags.length} 标签`)
  console.log(`  同形词     ${strong.length} 强 + ${mild.length} 弱\n`)

  const metaStore = await getDocsStore(STORES.META)
  const textStore = await getDocsStore(STORES.TEXT)
  const filesStore = await getDocsStore(STORES.FILES)
  const previewStore = await getDocsStore(STORES.PREVIEWS)

  // 读全库
  const all = []
  let cursor
  for (let round = 0; round < 200; round++) {
    const page = await metaStore.list({ prefix: '', limit: 500, cursor })
    for (const blob of page.blobs ?? []) {
      const m = await metaStore.get(blob.key, { type: 'json' }).catch(() => null)
      if (m) all.push(m)
    }
    cursor = page.nextCursor ?? page.cursor
    if (!cursor) break
  }

  const manualCount = all.filter(isManuallyEdited).length
  const base = opts.onlyReview ? all.filter((d) => d.needsReview) : all

  // 人工改过的默认跳过，除非 --force。
  // --pinyin-only / --previews-only 例外：它们只刷新派生字段，
  // 不会覆盖任何人工判断。
  const candidates = (opts.force || opts.pinyinOnly || opts.previewsOnly)
    ? base
    : base.filter((d) => !isManuallyEdited(d))
  const skippedManual = base.length - candidates.length
  const limited = opts.limit > 0 ? candidates.slice(0, opts.limit) : candidates

  if (opts.pinyinOnly) {
    console.log(`  模式       仅补拼音（不改分类、不调 AI）`)
  } else if (opts.previewsOnly) {
    console.log(`  模式       仅重建预览件（Markdown 渲染件 / Office 转 PDF）`)
    console.log(`  Office 转换 ${officeEngineStatus()}`)
  }
  console.log(`  ${all.length} 份文档，本次处理 ${limited.length} 份${opts.dryRun ? '（dry-run）' : ''}`)
  if (manualCount > 0 && !opts.pinyinOnly) {
    console.log(`  ⚠ 其中 ${manualCount} 份是人工编辑过的${opts.force
      ? '（已用 --force 强制覆盖）'
      : `，本次跳过 ${skippedManual} 份以免冲掉你的修改（要覆盖加 --force）`}`)
  }
  console.log('')

  const changes = []
  const catCount = {}
  let processed = 0
  let added = 0
  let rebuilt = 0
  let missing = 0
  let failed = 0
  /** 各转换引擎实际处理了多少份（Office 桌面引擎 vs LibreOffice）。 */
  const engines = {}

  for (const doc of limited) {
    // ---- 仅补拼音模式：只更新派生字段，完全不碰分类与标签 ----
    if (opts.pinyinOnly) {
      const py = pinyinForms(pinyinSourceOf(doc)) ?? undefined
      const hadPinyin = Boolean(doc.pinyin)
      if (!opts.dryRun && (!hadPinyin || doc.pinyin?.full !== py?.full)) {
        await metaStore.set(doc.id, JSON.stringify({
          ...doc,
          pinyin: py,
          updatedAt: new Date().toISOString(),
        }))
        if (!hadPinyin) added += 1
      }
      processed += 1
      if (processed % 50 === 0) console.log(`  · 已处理 ${processed}/${limited.length}`)
      continue
    }

    // ---- 仅重建预览件模式 ----
    if (opts.previewsOnly) {
      const buf = await filesStore.get(`${doc.id}.${doc.ext}`, { type: 'arrayBuffer' }).catch(() => null)

      if (!buf) {
        missing += 1
      } else if (doc.type === 'code') {
        // 代码：重渲染带行号 + 语法高亮的只读预览。
        // 这条分支是「渲染器本身改了」时的升级路径 —— 例如行数算法修正
        // （文件末尾的换行曾多算一行，导致行号列比代码块高一个行高）。
        // 用原件字节渲染，不碰抽取的正文。
        const rendered = renderCodePage(Buffer.from(buf).toString('utf8'), {
          title: doc.title,
          ext: doc.ext,
        })
        await previewStore.set(`${doc.id}.html`, rendered.html)
        await metaStore.set(doc.id, JSON.stringify({
          ...doc,
          previewKind: 'code',
          previewNote: rendered.highlighted ? '' : '未识别语言或文件过大，按纯文本显示',
          updatedAt: new Date().toISOString(),
        }))
        rebuilt += 1
      } else if (doc.type === 'md') {
        // ★ 用**原件字节**渲染，而不是抽取的正文：
        // 抽取时 cleanText 会压缩空格、去掉行首缩进、合并空行，
        // 那会让围栏代码块与列表层级在渲染视图里失真。
        const rendered = renderMarkdownPage(Buffer.from(buf).toString('utf8'), doc.title)
        await previewStore.set(`${doc.id}.html`, rendered.html)
        await metaStore.set(doc.id, JSON.stringify({
          ...doc,
          previewKind: 'markdown',
          previewNote: rendered.ok ? '' : `渲染失败，已回退为纯文本：${rendered.error}`,
          updatedAt: new Date().toISOString(),
        }))
        rebuilt += 1
      } else if (OFFICE_TYPES.has(doc.type)) {
        // Office 文档转 PDF（版式/图片/图表全保留）。
        // 这是装好转换引擎后把已有文档升级为高保真预览的路径，
        // 不必重新抽取正文 —— 正文本来就没变。
        //
        // ★ 用 convertToPdfDetailed 而不是 convertBytesToPdf：
        // 前者会告诉你**实际用了哪个引擎**（Office 桌面引擎 or LibreOffice），
        // 两者保真度差异明显（LibreOffice 与 PowerPoint 排版引擎不同，
        // 密集排版会文字溢出），把引擎记进元数据才能在网页上如实告知。
        const { pdf, engine } = await convertBytesToPdfDetailed(buf, doc.ext)
        if (pdf) {
          await previewStore.set(`${doc.id}.pdf`, pdf)
          await metaStore.set(doc.id, JSON.stringify({
            ...doc,
            previewKind: 'pdf',
            previewNote: engine === 'office' ? 'Office 桌面引擎转换' : 'LibreOffice 转换',
            updatedAt: new Date().toISOString(),
          }))
          rebuilt += 1
          engines[engine] = (engines[engine] ?? 0) + 1
        } else {
          failed += 1
        }
      }

      processed += 1
      if (processed % 10 === 0) console.log(`  · 已处理 ${processed}/${limited.length}`)
      continue
    }

    const text = await textStore.get(doc.id, { type: 'json' }).catch(() => null)
    const body = (text?.pages ?? []).join('\n')

    const result = await classify({
      title: [doc.title, doc.originalName].filter(Boolean).join(' '),
      text: body,
      taxonomy,
      apiKey: '',
      useAI: opts.useAI,
    })

    const before = (doc.categories ?? []).join('/')
    const after = result.categories.join('/')
    const changed = before !== after

    if (changed) changes.push({ title: doc.title, before, after })

    for (const c of result.categories) catCount[c] = (catCount[c] ?? 0) + 1

    if (!opts.dryRun) {
      const next = {
        ...doc,
        categories: result.categories,
        tags: result.tags,
        needsReview: result.needsReview,
        classifySource: result.source,
        aiError: result.aiError,
        // 顺带刷新拼音（早期入库的文档没有这个字段）
        pinyin: pinyinForms(pinyinSourceOf(doc)) ?? undefined,
        updatedAt: new Date().toISOString(),
      }
      if (result.summary) next.summary = result.summary
      // AI 摘要没变时不要用空串覆盖原有摘要
      if (!result.summary && !doc.summary) next.summary = ''
      await metaStore.set(doc.id, JSON.stringify(next))
    }

    processed += 1
    if (processed % 50 === 0) console.log(`  · 已处理 ${processed}/${limited.length}`)
  }

  // ---- 派生字段刷新模式的收尾（不改分类，索引也只需轻量重建） ----
  if (opts.pinyinOnly || opts.previewsOnly) {
    if (opts.pinyinOnly) {
      console.log(`\n  处理完成：${processed} 份，其中 ${added} 份补上了拼音\n`)
    } else {
      const engineNote = Object.entries(engines).length
        ? `（引擎：${Object.entries(engines).map(([k, v]) => `${k === 'office' ? 'Office 桌面' : k}=${v}`).join('，')}）`
        : ''
      console.log(`\n  处理完成：${processed} 份，重建预览件 ${rebuilt} 份${engineNote}`
        + `${failed ? `，失败 ${failed} 份` : ''}`
        + `${missing ? `，${missing} 份原件缺失已跳过` : ''}\n`)
    }
    if (!opts.dryRun) {
      console.log('  重建索引…')
      const idx = await rebuildStoreIndex({
        taxonomy,
        onProgress: (m) => console.log(`  · ${m}`),
      })
      console.log(`  索引完成：${idx.docCount} 份 / ${idx.termCount} 词条`)
    }
    if (env.loaded) console.log(`\n  已读取 .env（${env.keys.length} 个键）`)
    console.log('')
    return
  }

  console.log(`\n  处理完成：${processed} 份，其中 ${changes.length} 份分类发生变化\n`)

  if (changes.length) {
    console.log('=== 变化明细（最多显示 40 条）===')
    for (const c of changes.slice(0, 40)) {
      console.log(`  ${String(c.title).slice(0, 40).padEnd(42)} ${c.before}  →  ${c.after}`)
    }
    if (changes.length > 40) console.log(`  … 另有 ${changes.length - 40} 条`)
    console.log('')
  }

  console.log('=== 重新分类后的分布 ===')
  Object.entries(catCount).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
    const pct = ((v / Math.max(processed, 1)) * 100).toFixed(1)
    console.log(`  ${k.padEnd(12)} ${String(v).padStart(4)}  ${pct}%  ${'#'.repeat(Math.round(v / Math.max(processed, 1) * 40))}`)
  })

  if (!opts.dryRun) {
    console.log('\n  重建索引…')
    const idx = await rebuildStoreIndex({
      taxonomy,
      onProgress: (m) => console.log(`  · ${m}`),
    })
    console.log(`  索引完成：${idx.docCount} 份 / ${idx.termCount} 词条 / 版本 ${idx.version}`)
  }

  if (env.loaded) console.log(`\n  已读取 .env（${env.keys.length} 个键）`)
  console.log('')
}

main().catch((err) => {
  console.error('\n重新分类失败：', err?.message ?? err)
  process.exit(1)
})
