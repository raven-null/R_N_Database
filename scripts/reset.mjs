/**
 * 清库 / 清索引。
 *
 * 为什么需要它：入库不可逆 —— 一旦把某个目录扫进来，几百份文档就躺在库里了。
 * 试用、换语料、误扫目录都需要一条干净的退路。没有它，用户只能手动去
 * `.local-data/` 里删文件（线上是 Blobs，更没法手动）。
 *
 * **本脚本只删资料库里的副本，绝不碰你的源文件。**
 *
 * 用法：
 *   node scripts/reset.mjs                # 只报告将删除什么，不动手
 *   node scripts/reset.mjs --yes          # 真删
 *   node scripts/reset.mjs --yes --keep-auth   # 保留访问密码配置
 *
 * @module scripts/reset
 */

import { loadEnv } from './env.mjs'
import { getDocsStore, STORES, resolveStoreMode } from '../netlify/functions/_lib/store.mjs'

/**
 * 解析参数。
 * @returns {{yes:boolean, keepAuth:boolean}} 选项
 */
function parseArgs() {
  const args = process.argv.slice(2)
  return {
    yes: args.includes('--yes'),
    keepAuth: args.includes('--keep-auth'),
  }
}

/**
 * 列出并（可选）删除一个 store 的全部内容。
 * @param {string} label - 显示名
 * @param {string} storeName - store 名
 * @param {object} opts - { yes }
 * @returns {Promise<number>} 删除/统计的条数
 */
async function wipe(label, storeName, opts) {
  const store = await getDocsStore(storeName)

  // 逐页列举（Blobs 的 list 单次有上限）
  const keys = []
  let cursor
  for (let round = 0; round < 500; round++) {
    const page = await store.list({ prefix: '', limit: 500, cursor })
    for (const blob of page.blobs ?? []) keys.push(blob.key)
    cursor = page.nextCursor ?? page.cursor
    if (!cursor) break
  }

  if (keys.length === 0) {
    console.log(`  · ${label.padEnd(14)} 空`)
    return 0
  }

  if (!opts.yes) {
    console.log(`  · ${label.padEnd(14)} ${keys.length} 个对象`)
    return keys.length
  }

  let done = 0
  for (const key of keys) {
    await store.delete(key).catch(() => {})
    done += 1
    if (done % 100 === 0) process.stdout.write(`\r  · ${label.padEnd(14)} 已删 ${done}/${keys.length}`)
  }
  process.stdout.write(`\r  · ${label.padEnd(14)} 已删 ${done} 个对象\n`)
  return done
}

async function main() {
  const env = loadEnv()
  const opts = parseArgs()

  console.log('▸ R_N_Database 清库\n')
  console.log(`  存储模式   ${resolveStoreMode()}`)
  console.log(`  位置       ${resolveStoreMode() === 'local' ? '.local-data/' : 'Netlify Blobs'}`)
  console.log('')

  if (!opts.yes) {
    console.log('  以下是**将要删除**的内容（当前是预演，没有真删）：\n')
  } else {
    console.log('  正在删除：\n')
  }

  // 先取文档数，给用户一个"要删多少"的直观概念
  try {
    const indexStore = await getDocsStore(STORES.INDEX)
    if (!opts.yes) {
      try {
        const docs = await indexStore.get('docs', { type: 'json' })
        if (Array.isArray(docs) && docs.length) {
          console.log(`  ⚠ 库中有 ${docs.length} 份文档将被一并清除：`)
          for (const d of docs.slice(0, 6)) console.log(`      · ${String(d.title).slice(0, 52)}`)
          if (docs.length > 6) console.log(`      … 另有 ${docs.length - 6} 份`)
          console.log('')
        }
      } catch {
        /* 索引缺失不影响清库 */
      }
    }
  } catch {
    /* 忽略 */
  }

  let total = 0
  // 待上传暂存区也要清 —— 它是后来才加的 store，
  // 早期版本的 reset 会漏掉它，留下孤儿原件
  total += await wipe('待上传暂存', STORES.INBOX, opts)
  total += await wipe('原件', STORES.FILES, opts)
  total += await wipe('预览件', STORES.PREVIEWS, opts)
  total += await wipe('正文', STORES.TEXT, opts)
  total += await wipe('元数据', STORES.META, opts)
  total += await wipe('索引', STORES.INDEX, opts)

  if (opts.keepAuth) {
    console.log(`  · ${'访问密码'.padEnd(12)} 已保留（--keep-auth）`)
  } else {
    total += await wipe('访问密码', STORES.AUTH, opts)
  }

  console.log('')
  if (!opts.yes) {
    console.log(`  共 ${total} 个对象。确认要清空请加 --yes：`)
    console.log('')
    console.log('      node scripts/reset.mjs --yes')
    console.log('')
    console.log('  说明：只删资料库里的副本，你的源文件（E:\\学习 等）不受任何影响。')
  } else {
    console.log(`  ✓ 已清空 ${total} 个对象。`)
    console.log('')
    console.log('  下一步：')
    console.log('    node scripts/ingest.mjs "<你的文档目录>"     重新入库')
  }

  if (env.loaded) console.log(`\n  已读取 .env（${env.keys.length} 个键）`)
  console.log('')
}

main().catch((err) => {
  console.error('\n清库失败：', err?.message ?? err)
  process.exit(1)
})
