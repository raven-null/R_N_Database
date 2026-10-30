/**
 * 增量索引的单元测试（直接调模块，不起服务器）。
 *
 * ## 为什么这个测试必须存在
 *
 * 倒排索引是本项目的核心，而它的增量维护有一个**静默**的失败模式：
 * 摘掉一份文档的词条时，要用它的**旧正文**算旧词频。
 * 如果调用方在删正文 blob 之后才更新索引，算出来的旧词频只剩元数据部分，
 * 正文独有的词就永远留在分片里 ——
 *   · 搜索时因为文档已不在 docs 列表而被过滤，表面上"看起来没问题"
 *   · 实际上分片越删越大、avgLength 越来越偏，且没有任何报错
 *
 * 这个隐患曾经真实存在（单删与批量删两条路径都中招）。
 * 所以这里把「正确顺序 → 分片干净」和「错误顺序 → 留下垃圾」都写成断言，
 * 让后来改这段代码的人立刻看到原因。
 *
 * 全程用临时目录（DOCS_LOCAL_DIR），不碰 .local-data 也不碰线上。
 *
 * 用法：
 *   node scripts/test-index-delta.mjs
 *
 * @module scripts/test-index-delta
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let passed = 0
let failed = 0

/**
 * 断言。
 * @param {boolean} cond - 条件
 * @param {string} label - 描述
 * @param {string} [detail] - 详情
 */
function check(cond, label, detail = '') {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`)
  }
}

/** 临时存储目录（必须在 import store.mjs 之前设好环境变量）。 */
const STORE_DIR = mkdtempSync(join(tmpdir(), 'rndb-idx-'))
process.env.DOCS_LOCAL_DIR = STORE_DIR
process.env.DOCS_STORE_MODE = 'local'

// ★ 动态 import：store.mjs 在模块加载时就读 DOCS_LOCAL_DIR，
// 静态 import 会先执行，导致写到真正的 .local-data 里去
const { getDocsStore, STORES } = await import('../netlify/functions/_lib/store.mjs')
const {
  writeIndex, applyDocChange, applyDocChangesBulk, readIndexMeta,
  readPostingsForTerms, SHARD_COUNT, shardKey,
} = await import('../netlify/functions/_lib/index-store.mjs')

/**
 * 清空索引（等价于「全库重建后没有任何文档」）。
 *
 * ★ docs 清单要显式清掉：`writeIndex` 只写分片与 index-meta，
 * 而 `docs` 由 rebuild-index.mjs 单独写入。只重置一半的话，
 * 后续断言会读到上一节遗留的文档。
 * @returns {Promise<void>} 完成
 */
async function resetIndex() {
  const store = await getDocsStore(STORES.INDEX)
  await writeIndex({
    postings: {},
    version: 'empty',
    builtAt: new Date().toISOString(),
    docCount: 0,
    termCount: 0,
    avgLength: 0,
    lengths: {},
  })
  await store.set('docs', '[]')
}

/**
 * 数出分片里所有词条（用于判断"有没有留下垃圾"）。
 * @returns {Promise<{terms:number, entries:number}>} 统计
 */
async function shardStats() {
  const store = await getDocsStore(STORES.INDEX)
  let terms = 0
  let entries = 0
  for (let i = 0; i < SHARD_COUNT; i++) {
    const shard = await store.get(shardKey(i), { type: 'json' }).catch(() => null)
    if (!shard || typeof shard !== 'object') continue
    for (const inner of Object.values(shard)) {
      terms += 1
      entries += Object.keys(inner ?? {}).length
    }
  }
  return { terms, entries }
}

/**
 * 造一份文档的元数据与正文。
 * @param {string} id - 文档 id
 * @param {string} token - 正文里的独特词
 * @returns {{tokens:string[], meta:object, body:string}} 文档
 */
function makeDoc(id, token) {
  const meta = {
    id,
    title: `索引测试 ${id}`,
    type: 'code',
    ext: 'ts',
    categories: ['未归类'],
    tags: ['索引测试'],
    summary: '',
    ingestedAt: new Date().toISOString(),
  }
  const body = `export function demo() {\n  return "${token}"\n}\n`
  return { meta, body }
}

/**
 * 把文档写进各 store（模拟入库与"删之前已有正文"两种状态）。
 * @param {object} doc - makeDoc 的产物
 * @param {boolean} withText - 是否写正文 blob
 * @returns {Promise<void>} 完成
 */
async function putDoc(doc, withText = true) {
  const metaStore = await getDocsStore(STORES.META)
  await metaStore.set(doc.meta.id, JSON.stringify(doc.meta))
  if (withText) {
    const textStore = await getDocsStore(STORES.TEXT)
    await textStore.set(doc.meta.id, JSON.stringify({ pages: [doc.body] }))
  }
}

/**
 * 删掉正文 blob（模拟 DELETE 里的第一步）。
 * @param {string} id - 文档 id
 * @returns {Promise<void>} 完成
 */
async function dropText(id) {
  const textStore = await getDocsStore(STORES.TEXT)
  await textStore.delete(id)
}

async function main() {
  console.log('▸ 渡·资·集 增量索引单元测试')
  console.log(`  存储目录 ${STORE_DIR}\n`)

  try {
    /* ---------- 1. 新增一份文档 ---------- */
    console.log('【新增：applyDocChange(oldMeta=null)】')
    await resetIndex()
    const d1 = makeDoc('doc100000001', 'zzalphaunique')
    await putDoc(d1)
    const add = await applyDocChange({ oldMeta: null, newMeta: d1.meta })
    check(add.ok === true, '新增返回 ok')
    check(add.docCount === 1, `索引文档数 1（实际 ${add.docCount}）`)

    const found = await readPostingsForTerms(['zzalphaunique'])
    check(
      Boolean(found.postings.zzalphaunique?.[d1.meta.id]),
      '正文里的词已进索引',
      JSON.stringify(found.postings).slice(0, 120),
    )
    const stats1 = await shardStats()
    check(stats1.terms > 0, `分片里有 ${stats1.terms} 个词条 / ${stats1.entries} 条倒排记录`)

    /* ---------- 2. 错误顺序：先删正文，再更新索引 ---------- */
    console.log('\n【反例：先删正文再更新索引（正是曾经的 bug）】')
    await dropText(d1.meta.id)
    await applyDocChange({ oldMeta: d1.meta, newMeta: null })
    const statsAfterWrong = await shardStats()
    check(
      statsAfterWrong.terms > 0,
      `不传 oldBody 时正文词条**残留**在分片里（${statsAfterWrong.terms} 个）—— 这就是必须传 oldBody 的原因`,
    )
    const metaAfterWrong = await readIndexMeta()
    check(
      (metaAfterWrong.lengths ?? {})[d1.meta.id] === undefined,
      'lengths 里已经没有这份文档（所以只有翻分片才能发现残留）',
    )

    /* ---------- 3. 正确顺序 ---------- */
    console.log('\n【正例：删正文前先读出来（修复后的顺序）】')
    await resetIndex()
    const d2 = makeDoc('doc200000002', 'zzbetaunique')
    await putDoc(d2)
    await applyDocChange({ oldMeta: null, newMeta: d2.meta })

    // 调用方：先把正文读出来，再删 blob，最后带着 oldBody 更新索引
    const readBack = await (await getDocsStore(STORES.TEXT)).get(d2.meta.id, { type: 'json' })
    const oldBody = (readBack?.pages ?? []).join('\n')
    check(oldBody.includes('zzbetaunique'), '删之前读到了完整正文')

    await dropText(d2.meta.id)
    const del = await applyDocChange({ oldMeta: d2.meta, newMeta: null, oldBody, newBody: '' })
    check(del.ok === true, '删除返回 ok')
    check(del.docCount === 0, `索引文档数归零（实际 ${del.docCount}）`)

    const stats2 = await shardStats()
    check(stats2.terms === 0, `分片已彻底清空（剩 ${stats2.terms} 个词条）`,
      `倒排记录 ${stats2.entries} 条`)
    const meta2 = await readIndexMeta()
    check(Object.keys(meta2.lengths ?? {}).length === 0, 'lengths 已清空')

    /* ---------- 4. 改正文：新旧两版都要参与 ---------- */
    console.log('\n【改正文：oldBody/newBody 各算一次词频】')
    await resetIndex()
    const d3 = makeDoc('doc300000003', 'zzgammaold')
    await putDoc(d3)
    await applyDocChange({ oldMeta: null, newMeta: d3.meta })

    const newBody = 'export function demo() {\n  return "zzgammanew"\n}\n'
    const newMeta = { ...d3.meta, updatedAt: new Date().toISOString() }
    await applyDocChange({ oldMeta: d3.meta, newMeta, oldBody: d3.body, newBody })

    const afterEdit = await readPostingsForTerms(['zzgammaold', 'zzgammanew'])
    check(
      !afterEdit.postings.zzgammaold?.[d3.meta.id],
      '旧正文里的词已摘除（传对了 oldBody 才不会残留）',
    )
    check(
      Boolean(afterEdit.postings.zzgammanew?.[d3.meta.id]),
      '新正文里的词已进索引',
    )

    // 真正的验证：把改过正文的文档删掉，分片必须一干二净 ——
    // 若旧正文的词条没摘干净，这里就会剩下来
    await dropText(d3.meta.id)
    await applyDocChange({ oldMeta: newMeta, newMeta: null, oldBody: newBody, newBody: '' })
    const stats3 = await shardStats()
    check(stats3.terms === 0, `改过正文再删除后分片彻底清空（剩 ${stats3.terms} 个词条）`,
      `倒排记录 ${stats3.entries} 条`)

    /* ---------- 5. 批量删除也要传 oldBody ---------- */
    console.log('\n【批量删除：applyDocChangesBulk 支持逐条 oldBody】')
    await resetIndex()
    const d4 = makeDoc('doc400000004', 'zzdeltaone')
    const d5 = makeDoc('doc500000005', 'zzepsilontwo')
    await putDoc(d4)
    await putDoc(d5)
    await applyDocChange({ oldMeta: null, newMeta: d4.meta })
    await applyDocChange({ oldMeta: null, newMeta: d5.meta })

    await dropText(d4.meta.id)
    await dropText(d5.meta.id)
    const bulk = await applyDocChangesBulk([
      { oldMeta: d4.meta, newMeta: null, oldBody: d4.body },
      { oldMeta: d5.meta, newMeta: null, oldBody: d5.body },
    ])
    check(bulk.ok === true, '批量删除返回 ok')
    check(bulk.docCount === 0, `索引文档数归零（实际 ${bulk.docCount}）`)

    const stats5 = await shardStats()
    check(stats5.terms === 0, `批量删除后分片也已清空（剩 ${stats5.terms} 个词条）`,
      `倒排记录 ${stats5.entries} 条`)

    /* ---------- 6. 索引元信息一致性 ---------- */
    console.log('\n【索引元信息一致性】')
    const finalMeta = await readIndexMeta()
    check(finalMeta.docCount === 0, `docCount=0（实际 ${finalMeta.docCount}）`)
    check(finalMeta.avgLength === 0, `avgLength=0（实际 ${finalMeta.avgLength}）`)
    check(Array.isArray(finalMeta.lengths) === false, 'lengths 是对象而不是数组')
  } finally {
    try {
      rmSync(STORE_DIR, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
  }

  console.log('\n────────────────────────────────')
  console.log(`  通过 ${passed} / 失败 ${failed}`)
  console.log('')
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n测试自身出错：', err)
  try {
    rmSync(STORE_DIR, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
  process.exit(1)
})
