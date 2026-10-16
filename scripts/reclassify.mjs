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
 *
 * @module scripts/reclassify
 */

import { join } from 'node:path'
import { loadEnv } from './env.mjs'
import { loadTaxonomy, classify, resolveAIConfig } from './lib/classify.mjs'
import { rebuildStoreIndex } from './lib/rebuild-index.mjs'
import { getDocsStore, STORES, resolveStoreMode } from '../netlify/functions/_lib/store.mjs'

const ROOT = process.cwd()

/**
 * 解析命令行参数。
 * @returns {{dryRun:boolean, useAI:boolean, limit:number, only:boolean}} 选项
 */
function parseArgs() {
  const args = process.argv.slice(2)
  const opts = { dryRun: false, useAI: false, limit: 0, onlyReview: false }
  for (const a of args) {
    if (a === '--dry-run') opts.dryRun = true
    else if (a === '--ai') opts.useAI = true
    else if (a === '--only-review') opts.onlyReview = true
    else if (a.startsWith('--limit=')) opts.limit = Number(a.slice(8)) || 0
  }
  return opts
}

async function main() {
  const env = loadEnv()
  const opts = parseArgs()

  console.log('▸ R_N_Database 重新分类\n')
  console.log(`  存储模式   ${resolveStoreMode()}`)

  const ai = resolveAIConfig()
  console.log(`  AI         ${opts.useAI
    ? (ai.configured ? `启用 · ${ai.model} · 密钥来源 ${ai.source}` : '已请求但未配置密钥，将只用规则')
    : '关闭（仅规则）'}`)

  const taxonomy = loadTaxonomy(join(ROOT, 'config', 'taxonomy.json'))
  console.log(`  分类词表   ${taxonomy.categories.length} 类 / ${taxonomy.tags.length} 标签`)
  console.log(`  同形词     ${(taxonomy._ambiguousKeywords?.words ?? []).length} 个（正文折扣 ${taxonomy._ambiguousKeywords?.bodyWeight}）\n`)

  const metaStore = await getDocsStore(STORES.META)
  const textStore = await getDocsStore(STORES.TEXT)

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

  const targets = opts.onlyReview ? all.filter((d) => d.needsReview) : all
  const limited = opts.limit > 0 ? targets.slice(0, opts.limit) : targets

  console.log(`  ${all.length} 份文档，本次处理 ${limited.length} 份${opts.dryRun ? '（dry-run）' : ''}\n`)

  const changes = []
  const catCount = {}
  let processed = 0

  for (const doc of limited) {
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
