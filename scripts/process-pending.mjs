/**
 * 处理网页上传的待入库文件。
 *
 * ## 两阶段入库的第二阶段
 *
 * 网页上传只把原件存进暂存区（Netlify 上没有 LibreOffice，
 * 也扛不住 300 页 PDF 的抽取）。真正的入库在本脚本里完成：
 * 抽正文 → 分类打标 → 转 PDF 预览 → 写库 → 重建索引。
 *
 * 复用 `ingest.mjs` 的同一套流水线（`ingestOne`），因此
 * 「网页传的」与「命令行扫的」走完全相同的处理，不会出现两套行为。
 *
 * 用法：
 *   node scripts/process-pending.mjs              # 处理全部待上传
 *   node scripts/process-pending.mjs --dry-run    # 只看会处理什么
 *   node scripts/process-pending.mjs --keep       # 处理后保留暂存区原文件
 *   node scripts/process-pending.mjs --no-ai      # 跳过 AI 打标
 *
 * @module scripts/process-pending
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadEnv, loadExtraEnv } from './env.mjs'
import { ingestOne, makeIngestContext } from './ingest.mjs'
import { loadTaxonomy, resolveAIConfig } from './lib/classify.mjs'
import { rebuildStoreIndex } from './lib/rebuild-index.mjs'
import { officeEngineStatus } from './lib/office.mjs'
import { getDocsStore, STORES, resolveStoreMode } from '../netlify/functions/_lib/store.mjs'

const ROOT = process.cwd()

/**
 * 解析参数。
 * @returns {{dryRun:boolean, keep:boolean, useAI:boolean, limit:number}} 选项
 */
function parseArgs() {
  const args = process.argv.slice(2)
  const opts = { dryRun: false, keep: false, useAI: true, limit: 0 }
  for (const a of args) {
    if (a === '--dry-run') opts.dryRun = true
    else if (a === '--keep') opts.keep = true
    else if (a === '--no-ai') opts.useAI = false
    else if (a.startsWith('--limit=')) opts.limit = Number(a.slice(8)) || 0
  }
  return opts
}

/**
 * 读暂存区记录。
 * @param {object} store - inbox store
 * @returns {Promise<object[]>} 记录列表（按上传时间正序，先传先处理）
 */
async function readPending(store) {
  const items = []
  let cursor
  for (let round = 0; round < 20; round++) {
    const page = await store.list({ prefix: 'meta/', limit: 500, cursor })
    for (const blob of page.blobs ?? []) {
      const m = await store.get(blob.key, { type: 'json' }).catch(() => null)
      if (m) items.push(m)
    }
    cursor = page.nextCursor ?? page.cursor
    if (!cursor) break
  }
  items.sort((a, b) => String(a.uploadedAt ?? '').localeCompare(String(b.uploadedAt ?? '')))
  return items
}

/**
 * 取回某个待处理项的原件字节。
 * @param {object} store - inbox store
 * @param {object} rec - 记录
 * @returns {Promise<Buffer|null>} 字节
 */
async function readPendingBytes(store, rec) {
  for (const key of [`file/${rec.id}.${rec.ext}`, `file/${rec.id}`]) {
    const buf = await store.get(key, { type: 'arrayBuffer' }).catch(() => null)
    if (buf) return Buffer.from(buf)
  }
  return null
}

/**
 * 从暂存区移除一个待处理项。
 * @param {object} store - inbox store
 * @param {object} rec - 记录
 * @returns {Promise<void>} 完成
 */
async function dropPending(store, rec) {
  for (const prefix of [`file/${rec.id}.`, `file/${rec.id}`]) {
    const listed = await store.list({ prefix }).catch(() => ({ blobs: [] }))
    for (const blob of listed.blobs ?? []) {
      await store.delete(blob.key).catch(() => {})
    }
  }
  await store.delete(`meta/${rec.id}`).catch(() => {})
}

async function main() {
  const env = loadEnv()
  const extraEnv = loadExtraEnv()
  const opts = parseArgs()

  console.log('▸ R_N_Database 处理待上传文件\n')
  console.log(`  存储模式   ${resolveStoreMode()}`)

  const ai = resolveAIConfig()
  console.log(`  AI 打标    ${opts.useAI
    ? (ai.configured ? `启用 · ${ai.model}` : '未配置密钥，将只用规则分类')
    : '已禁用（--no-ai）'}`)
  console.log(`  Office 转换 ${officeEngineStatus()}\n`)

  const store = await getDocsStore(STORES.INBOX)
  const all = await readPending(store)

  if (all.length === 0) {
    console.log('  暂存区是空的 —— 没有待入库的文件。')
    console.log('  在网页上点「上传」添加文件后再跑本命令。\n')
    return
  }

  const targets = opts.limit > 0 ? all.slice(0, opts.limit) : all
  console.log(`  待处理 ${all.length} 份，本次处理 ${targets.length} 份${opts.dryRun ? '（dry-run）' : ''}\n`)

  const taxonomy = loadTaxonomy(join(ROOT, 'config', 'taxonomy.json'))
  // 用与命令行入库**完全相同**的上下文构造器，
  // 保证「网页传的」与「命令行扫的」走同一套去重与写入逻辑
  const ctx = await makeIngestContext({ taxonomy, useAI: opts.useAI, dryRun: opts.dryRun })

  let ok = 0
  let failed = 0

  for (let i = 0; i < targets.length; i++) {
    const rec = targets[i]
    const label = `[${String(i + 1).padStart(2)}/${targets.length}]`
    const short = rec.originalName.length > 42 ? `${rec.originalName.slice(0, 39)}…` : rec.originalName

    const buf = await readPendingBytes(store, rec)
    if (!buf) {
      failed += 1
      console.log(`  ${label} ✗ ${short}（暂存区里找不到原文件）`)
      continue
    }

    if (opts.dryRun) {
      console.log(`  ${label} ? ${short}（${(buf.length / 1024).toFixed(0)}KB，将入库）`)
      continue
    }

    // id 由内容哈希决定，因此「同一文件重复上传」会自然去重
    try {
      // 落到临时文件：抽取流水线仍需一个真实路径来读签名/属性
      const tmp = mkdtempSync(join(tmpdir(), 'rndb-pending-'))
      const tmpFile = join(tmp, rec.originalName.replace(/[\\/:*?"<>|]/g, '_'))
      try {
        writeFileSync(tmpFile, buf)
        // 复用命令行入库的同一套流水线；override 把真实文件名与来源还原回去
        const result = await ingestOne(tmpFile, ctx, {
          originalName: rec.originalName,
          sourcePath: `upload://${rec.originalName}`,
        })

        const tags = (result.tags ?? []).slice(0, 4).join(',')
        console.log(`  ${label} ✓ ${short}`)
        console.log(`          → ${result.title}`)
        console.log(`            分类 ${(result.categories ?? []).join('/')} | 标签 ${tags || '无'}`
          + ` | 正文 ${result.textChars} 字 | 预览 ${result.previewKind}`)

        if (result.status === 'duplicate' || result.status === 'unchanged') {
          console.log('            （库里已有同样内容，跳过写入）')
        }
        ok += 1
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    } catch (err) {
      failed += 1
      console.log(`  ${label} ✗ ${short}`)
      console.log(`          ${err?.message ?? err}`)
      continue
    }

    if (!opts.keep) await dropPending(store, rec)
  }

  if (!opts.dryRun) {
    console.log('\n  重建检索索引…')
    const idx = await rebuildStoreIndex({
      taxonomy,
      pathIndex: ctx.pathIndex,
      onProgress: (m) => console.log(`  · ${m}`),
    })
    console.log(`  索引完成：${idx.docCount} 份 / ${idx.termCount} 词条`)
  }

  const left = await readPending(store)
  console.log('\n────────────────────────────────')
  if (opts.dryRun) {
    console.log(`  dry-run：${targets.length} 份将入库`)
  } else {
    console.log(`  入库 ${ok} 份 | 失败 ${failed} 份 | 暂存区剩余 ${left.length} 份`)
    if (opts.keep) console.log('  （--keep：暂存区原文件已保留）')
  }
  if (env.loaded) console.log(`  已读取 .env（${env.keys.length} 个键）`)
  if (extraEnv.loaded) console.log(`  已读取 DOCS_AI_ENV 指定的 ${extraEnv.path}`)
  console.log('')
}

main().catch((err) => {
  console.error('\n处理失败：', err?.message ?? err)
  process.exit(1)
})
