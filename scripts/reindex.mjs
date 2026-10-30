/**
 * 重建检索索引 —— 不重新抽取文档。
 *
 * 什么时候用它：
 *   - 改了分词策略或打分模型（索引格式变了）
 *   - 改了分类词表 config/taxonomy.json
 *   - 索引疑似损坏或与 doc-meta 不同步
 *
 * 什么时候不该用它：文档内容本身变了 —— 那需要重跑 ingest。
 *
 * 用法：
 *   node scripts/reindex.mjs
 *
 * @module scripts/reindex
 */

import { join } from 'node:path'
import { loadEnv } from './env.mjs'
import { loadTaxonomy } from './lib/classify.mjs'
import { rebuildStoreIndex } from './lib/rebuild-index.mjs'
import { resolveStoreMode } from '../netlify/functions/_lib/store.mjs'

const ROOT = process.cwd()

async function main() {
  const env = loadEnv()
  const t0 = Date.now()

  console.log('▸ 渡·资·集 重建索引\n')
  console.log(`  存储模式   ${resolveStoreMode()}`)

  const taxonomy = loadTaxonomy(join(ROOT, 'config', 'taxonomy.json'))
  console.log(`  分类词表   ${taxonomy.categories.length} 类 / ${taxonomy.tags.length} 标签\n`)

  const result = await rebuildStoreIndex({
    taxonomy,
    onProgress: (msg) => console.log(`  · ${msg}`),
  })

  console.log('\n────────────────────────────────')
  console.log(`  索引完成：${result.docCount} 份文档 / ${result.termCount} 个词条`)
  console.log(`  平均文档长度 ${result.avgLength} 词 / 版本 ${result.version}`)
  console.log(`  耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  if (env.loaded) console.log(`  已读取 .env（${env.keys.length} 个键）`)
  console.log('')
}

main().catch((err) => {
  console.error('\n重建失败：', err?.message ?? err)
  process.exit(1)
})
