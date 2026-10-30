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

  console.log('▸ 渡·资·集 处理待上传文件\n')
  console.log(`  存储模式   ${resolveStoreMode()}`)

  const ai = resolveAIConfig()
  console.log(`  AI 打标    ${opts.useAI
    ? (ai.configured ? `启用 · ${ai.model}` : '未配置密钥，将只用规则分类')
    : '已禁用（--no-ai）'}`)
  console.log(`  Office 转换 ${officeEngineStatus()}\n`)

  const store = await getDocsStore(STORES.INBOX)
  const all = await readPending(store)

  if (all.length === 0) {
    const mode = resolveStoreMode()

    console.log('  暂存区是空的 —— 没有待入库的文件。\n')

    // ★ 最常见的困惑：在**线上站点**上传的文件存在 Netlify Blobs（云端），
    //   而本地脚本默认只读本地目录。不说清楚的话，用户会以为上传丢了。
    if (mode === 'local') {
      console.log('  注意：网页上传的暂存区有两个，取决于你在哪上传的 ——')
      console.log('    · 在线上站点上传 → 存在 Netlify Blobs（云端）')
      console.log('    · 在本地 dev-server 上传 → 存在 .local-data/doc-inbox/')
      console.log('')
      console.log('  本次运行处于 local 模式，只看了本地目录。')
      console.log('  要处理**线上**暂存区，需要在项目根目录建 .env 并填：')
      console.log('')
      console.log('      DOCS_STORE_MODE=remote')
      console.log('      SITE_ID=<你的 Netlify 站点 ID>')
      console.log('      NETLIFY_ACCESS_TOKEN=<你的 Personal Access Token>')
      console.log('')
      console.log('  两者都在 Netlify 后台拿：')
      console.log('    SITE_ID              → 站点 Settings → General → Site ID')
      console.log('    NETLIFY_ACCESS_TOKEN → User settings → Applications → New access token')
      console.log('  （.env 已被 .gitignore 忽略，不会进 Git）')
    } else {
      console.log('  当前是 remote 模式（连的是 Netlify Blobs），线上暂存区确实为空。')
      console.log('  在网页上点「上传」添加文件后再跑本命令。')
    }
    console.log('')
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
        // 复用命令行入库的同一套流水线；override 把真实文件名与来源还原回去。
        // 整目录上传时 relativePath 带着目录结构（`合同/2025/xx.pdf`），
        // 一并写进 sourcePath —— 日后能看出这份文件原本在哪
        const provenance = rec.relativePath || rec.originalName
        const result = await ingestOne(tmpFile, ctx, {
          originalName: rec.originalName,
          sourcePath: `upload://${provenance}`,
        })

        const tags = (result.tags ?? []).slice(0, 4).join(',')
        console.log(`  ${label} ✓ ${rec.relativePath || short}`)
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
