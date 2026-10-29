/**
 * 服务端一键入库回归测试（`POST /api/v1/inbox/ingest`）。
 *
 * ## 它守的是什么
 *
 * 这个接口让「在网站上把文件放进去」这件事**不需要 Netlify 令牌**：
 * 网页上传 → 点「立即入库」→ 函数自己抽正文、分类、生成预览、更新索引。
 *
 * 它替代的是本地 `process-pending.mjs` 那条路，所以两边产物必须一致 ——
 * 这正是最容易悄悄分叉的地方（同一个 PDF 在本地入库与服务端入库
 * 得到不同的正文/页数/分类）。所以这里逐项验：
 *
 *   · 各类型的正文抽取（PDF / Markdown / 代码 / Office）
 *   · 预览件的形态（PDF 用原件、md/code 渲染、Office 走 HTML 降级）
 *   · 规则分类与标签
 *   · 检索索引真的更新了（搜新内容能命中）
 *   · 暂存区被清干净（不留垃圾）
 *   · 重复内容不重复入库
 *   · 幂等：再点一次什么都不做
 *
 * 用法：
 *   node scripts/dev-server.mjs
 *   node scripts/test-server-ingest.mjs
 *
 * @module scripts/test-server-ingest
 */

import { join } from 'node:path'
import { createHash } from 'node:crypto'

import {
  buildPdf, buildDocxFixture, buildXlsxFixture, buildPptxFixture,
} from './lib/fixtures.mjs'

const ROOT = process.cwd()
const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:8899'
const nodeFetch = globalThis.fetch.bind(globalThis)

/** 本轮标记：写进文件内容，保证每次运行都是新内容而不是被去重。 */
const MARK = `SRVINGEST${Date.now()}`

/** 上传后记录 id，收尾精确清理。 */
const stagedIds = new Set()
/** 入库后产生的文档 id，收尾删除。 */
const createdDocIds = new Set()

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

/**
 * 发 JSON 请求。
 * @param {string} path - 路径
 * @param {object} [opts] - { method, body, raw }
 * @returns {Promise<{status:number, body:object|null, text:string}>} 响应
 */
async function api(path, opts = {}) {
  const res = await nodeFetch(BASE + path, {
    method: opts.method ?? 'GET',
    headers: opts.body !== undefined && !opts.raw ? { 'Content-Type': 'application/json' } : opts.headers,
    body: opts.body === undefined
      ? undefined
      : (opts.raw ? opts.body : JSON.stringify(opts.body)),
  })
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, body, text }
}

/**
 * 把一份内容传到暂存区。
 * @param {string} name - 文件名
 * @param {Buffer|string} content - 内容
 * @param {string} relPath - 相对路径
 * @returns {Promise<object>} 上传记录
 */
async function stage(name, content, relPath) {
  const q = new URLSearchParams({ name, path: relPath })
  const res = await nodeFetch(`${BASE}/api/v1/inbox?${q}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: content,
  })
  const body = await res.json()
  if (!body?.ok) throw new Error(`上传失败：${body?.error?.message ?? res.status}`)
  stagedIds.add(body.data.id)
  return body.data
}

/**
 * 触发服务端入库。
 * @param {number} [limit] - 本次处理几份
 * @returns {Promise<object>} 接口数据
 */
async function ingest(limit = 10) {
  const r = await api('/api/v1/inbox/ingest', { method: 'POST', body: { limit } })
  if (r.status !== 200 || !r.body?.ok) {
    throw new Error(`入库接口失败：${r.body?.error?.message ?? r.status}`)
  }
  for (const x of r.body.data.results ?? []) {
    if (x.docId) createdDocIds.add(x.docId)
  }
  return r.body.data
}

/**
 * 按原始文件名找文档。
 * @param {string} originalName - 文件名
 * @returns {Promise<object|null>} 文档
 */
async function findDoc(originalName) {
  const { body } = await api('/api/v1/docs?limit=200')
  return (body?.data?.items ?? []).find((d) => d.originalName === originalName) ?? null
}

async function main() {
  console.log('▸ R_N_Database 服务端一键入库 · 回归测试')
  console.log(`  后端 ${BASE}\n`)

  try {
    const { body } = await api('/api/v1/health')
    if (!body?.ok) throw new Error('health 未返回 ok')
    console.log(`  存储 ${body.data.store.mode} / 现有文档 ${body.data.docCount} 份\n`)
  } catch (err) {
    console.error(`  无法连接开发服务器：${err.message}`)
    console.error('  请先运行：node scripts/dev-server.mjs\n')
    process.exit(1)
  }

  try {
    /* ---------- 准备六种类型的文件 ---------- */
    console.log('【准备：上传 6 份不同形态的文件】')
    const root = MARK

    // PDF：真·PDF，验证 pdfjs 在函数里能抽正文。
    // ★ 文字要短：夹具页面只有 300pt 宽，16pt 的长行会超出页宽，
    // pdfjs 抽取时会把超出的部分截掉 —— 那样断言的不是"能不能抽"，而是"页面够不够宽"。
    const pdfBuf = buildPdf(MARK)
    // Markdown：带体裁信号，验证分类走到「学习资料」
    const mdText = `# ${MARK} 学习笔记\n\n摘要 引言 本章 参考文献 练习题\n\n操作系统 进程调度 内存管理\n`
    // 代码：验证语法高亮预览件
    const codeText = `// ${MARK}\nexport function add(a: number, b: number) {\n  return a + b\n}\n`
    // Office 三件套：验证 HTML 降级预览（函数里没有 LibreOffice）
    const docx = await buildDocxFixture(MARK)
    const xlsx = await buildXlsxFixture(MARK)
    const pptx = await buildPptxFixture(MARK)

    await stage(`${MARK}-probe.pdf`, pdfBuf, `${root}/${MARK}-probe.pdf`)
    await stage(`${MARK}-note.md`, mdText, `${root}/${MARK}-note.md`)
    await stage(`${MARK}-code.ts`, codeText, `${root}/${MARK}-code.ts`)
    await stage(`${MARK}-word.docx`, docx, `${root}/${MARK}-word.docx`)
    await stage(`${MARK}-sheet.xlsx`, xlsx, `${root}/${MARK}-sheet.xlsx`)
    await stage(`${MARK}-deck.pptx`, pptx, `${root}/${MARK}-deck.pptx`)

    const staged = await api('/api/v1/inbox')
    check(staged.body?.data?.total >= 6, `暂存区里有 ${staged.body?.data?.total} 份待处理`)

    /* ---------- 触发入库 ---------- */
    console.log('\n【服务端入库】')
    const t0 = Date.now()
    const res = await ingest(10)
    const ms = Date.now() - t0
    console.log(`  耗时 ${ms}ms　处理 ${res.processed} 份，入库 ${res.ingested} 份，剩余 ${res.remaining} 份`)

    const byStatus = (s) => res.results.filter((r) => r.status === s)
    check(byStatus('ingested').length >= 6, `6 份都入库成功（实际 ${byStatus('ingested').length}）`,
      JSON.stringify(res.results.map((r) => `${r.status}:${r.name}`)))
    check(byStatus('error').length === 0, '没有失败项', JSON.stringify(byStatus('error')))
    check(res.remaining === 0, `暂存区已处理完（剩余 ${res.remaining}）`)

    const after = await api('/api/v1/inbox')
    check((after.body?.data?.total ?? 0) === 0, `暂存区被清干净（剩 ${after.body?.data?.total}）`)

    /* ---------- 逐类型核对产物 ---------- */
    console.log('\n【产物核对：正文与预览件】')

    const pdf = await findDoc(`${MARK}-probe.pdf`)
    check(Boolean(pdf), 'PDF 入库了')
    check(pdf?.previewKind === 'pdf', `PDF 预览件用原件（previewKind=${pdf?.previewKind}）`)
    check(Boolean(pdf?.hasText), 'PDF 抽到了正文（pdfjs 在函数里可用）')
    const pdfText = await api(`/api/v1/docs/${pdf.id}/text`)
    check(
      String((pdfText.body?.data?.pages ?? []).join('')).includes(MARK),
      'PDF 正文里能找到夹具标记',
      String((pdfText.body?.data?.pages ?? []).join('')).slice(0, 120),
    )

    const md = await findDoc(`${MARK}-note.md`)
    check(md?.previewKind === 'markdown', `Markdown 预览件是渲染版（${md?.previewKind}）`)
    check(md?.categories?.includes('学习资料'), `Markdown 分类到学习资料（${md?.categories?.join('/')}）`)
    const mdHtml = await api(`/api/v1/docs/${md.id}/preview?mode=render`)
    check(/<h1/.test(mdHtml.text), 'Markdown 渲染件里有一级标题')
    const mdSrc = await api(`/api/v1/docs/${md.id}/preview?mode=source`)
    check(/class="ln"/.test(mdSrc.text), 'Markdown 源码视图有行号')

    const code = await findDoc(`${MARK}-code.ts`)
    check(code?.previewKind === 'code', `代码预览件带高亮（${code?.previewKind}）`)
    const codeHtml = await api(`/api/v1/docs/${code.id}/preview`)
    check(/hljs/.test(codeHtml.text) && /class="gutter"/.test(codeHtml.text), '代码预览有高亮与行号')

    for (const [name, kind] of [[`${MARK}-word.docx`, 'docx'], [`${MARK}-sheet.xlsx`, 'xlsx'], [`${MARK}-deck.pptx`, 'pptx']]) {
      const d = await findDoc(name)
      check(Boolean(d), `${kind} 入库了`)
      if (!d) continue
      check(d.previewKind === 'html', `${kind} 用 HTML 降级预览（${d.previewKind}）`)
      const detail = await api(`/api/v1/docs/${d.id}`)
      check(
        /本地跑 node scripts\/ingest\.mjs/.test(detail.body?.data?.previewNote ?? ''),
        `${kind} 的 previewNote 如实说明了"要 PDF 保真版请走本地命令"`,
        detail.body?.data?.previewNote,
      )
      check(Boolean(d.hasText), `${kind} 抽到了正文`)
    }

    /* ---------- 检索索引真的更新了 ---------- */
    console.log('\n【索引】')
    const hit = await api(`/api/v1/search?q=${encodeURIComponent(`${MARK} 学习笔记`)}`)
    check((hit.body?.data?.items ?? []).length > 0, `新内容能被全文检索搜到（命中 ${hit.body?.data?.total}）`)
    const hitPdf = await api(`/api/v1/search?q=${encodeURIComponent(MARK)}`)
    check(
      (hitPdf.body?.data?.items ?? []).some((i) => i.id === pdf.id),
      'PDF 正文进了索引',
    )

    /* ---------- 来源目录 ---------- */
    console.log('\n【来源目录】')
    check(md?.dir === `上传/${MARK}`, `dir 归到「上传」下（${md?.dir}）`)

    /* ---------- 元数据标记 ---------- */
    const mdDetail = await api(`/api/v1/docs/${md.id}`)
    check(mdDetail.body?.data?.ingestedBy === 'server', '元数据标了 ingestedBy=server（能区分入库途径）')
    check(
      String(mdDetail.body?.data?.sourcePath ?? '').startsWith('upload://'),
      `sourcePath 记成 upload://（${mdDetail.body?.data?.sourcePath}）`,
    )
    // 默认私有（DEFAULT_VISIBILITY）：公开必须是明确动作，不能是入库的副作用
    check(mdDetail.body?.data?.visibility === 'private',
      `入库默认私有（visibility=${mdDetail.body?.data?.visibility}）`)
    check(mdDetail.body?.data?.schemaVersion === 2,
      `元数据已带 schemaVersion（${mdDetail.body?.data?.schemaVersion}）`)

    /* ---------- 目录名参与分类（深层子目录也要生效）---------- */
    console.log('\n【目录名当命名提示】')
    // 深层子目录：只取最近一级或两级都拿不到「学习」，必须取全上级目录。
    // ★ 内容里必须带 MARK：id 是内容哈希，两次运行内容一模一样就会被判为
    // "库里已有同样内容"（duplicate）而不会新建文档 —— 那样测试就测不到本次的分类。
    await stage(`${MARK}-deep.java`, `public class Deep${MARK.replace(/\D/g, '')} {\n  int x = 1;\n}\n`,
      `${root}/学习/L30_面向对象进阶/多态测试/${MARK}-deep.java`)
    const deepRes = await ingest(10)
    const deepDoc = await findDoc(`${MARK}-deep.java`)
    check(Boolean(deepDoc), '深层子目录里的文件入库了')
    check(deepDoc?.categories?.includes('学习资料'),
      `深层子目录也认出了「学习」（${deepDoc?.categories?.join('/')}）`,
      `分类：${deepDoc?.categories?.join('/')}`)
    check(deepDoc?.tags?.includes('学习'), `拿到「学习」标签（${(deepDoc?.tags ?? []).join(' ')}）`)
    void deepRes

    /* ---------- 幂等：再点一次 ---------- */
    console.log('\n【幂等】')
    const again = await ingest(10)
    check(again.total === 0, `暂存区空时再点一次什么都不做（total=${again.total}）`)
    check(again.results.length === 0, '没有产生新的处理结果')

    /* ---------- 重复内容不重复入库 ---------- */
    console.log('\n【重复内容】')
    await stage(`${MARK}-note-copy.md`, mdText, `${root}/${MARK}-note-copy.md`)
    const dupRes = await ingest(10)
    const dup = (dupRes.results ?? []).find((r) => r.status === 'duplicate')
    check(Boolean(dup), `同样内容被判为重复（${dupRes.results?.[0]?.status}）`)
    check(dupRes.ingested === 0, '重复内容没有新建文档')
    const dupAfter = await api('/api/v1/inbox')
    check((dupAfter.body?.data?.total ?? 0) === 0, '重复内容的暂存记录也被清掉了（不留垃圾）')

    /* ---------- 参数上限 ---------- */
    console.log('\n【参数】')
    const over = await api('/api/v1/inbox/ingest', { method: 'POST', body: { limit: 999 } })
    check(over.status === 200, `limit 超上限被收敛而不是报错（HTTP ${over.status}）`)
    const wrongMethod = await api('/api/v1/inbox/ingest')
    check(wrongMethod.status === 400, `GET 被拒（HTTP ${wrongMethod.status}）`)

    /* ---------- 批量转公开 ---------- */
    console.log('\n【批量转公开】')
    const pub = await api('/api/v1/docs/batch', {
      method: 'POST',
      body: { op: 'setVisibility', ids: [md.id], visibility: 'public' },
    })
    check(pub.status === 200, `setVisibility 成功（HTTP ${pub.status}）`)
    const afterPub = await api(`/api/v1/docs/${md.id}`)
    check(afterPub.body?.data?.visibility === 'public',
      `可见性已变公开（${afterPub.body?.data?.visibility}）`)
    const badVis = await api('/api/v1/docs/batch', {
      method: 'POST',
      body: { op: 'setVisibility', ids: [md.id], visibility: 'secret' },
    })
    check(badVis.status === 400, `非法 visibility 被拒（HTTP ${badVis.status}）`)

    /* ---------- 重建索引 ---------- */
    // 线上从没跑过 reindex 时，入库要能自己把索引建起来；万一索引已坏，
    // 这个端点要从 META 全量修回来。两条路径都别依赖「先跑脚本」。
    console.log('\n【重建索引】')
    const repair = await api('/api/v1/index/repair', { method: 'POST' })
    check(repair.status === 200, `POST 重建索引成功（HTTP ${repair.status}）`)
    check((repair.body?.data?.docCount ?? 0) >= createdDocIds.size,
      `重建覆盖了库里全部文档（docCount=${repair.body?.data?.docCount}）`)
    check(repair.body?.data?.shards === 128, `写满 128 个分片（${repair.body?.data?.shards}）`)
    check(typeof repair.body?.data?.version === 'string' && repair.body.data.version.length > 0,
      '返回了索引版本号')
    const afterRepair = await api(`/api/v1/search?q=${encodeURIComponent(MARK)}`)
    check((afterRepair.body?.data?.items ?? []).some((i) => i.id === pdf.id),
      '重建之后仍然搜得到'
      + `（total=${afterRepair.body?.data?.total}）`)
    const listed = await api('/api/v1/docs?limit=1')
    check((listed.body?.data?.total ?? 0) >= createdDocIds.size, '重建之后列表读得出文档')
    const repairedWrong = await api('/api/v1/index/repair')
    check(repairedWrong.status === 400, `GET 被拒（HTTP ${repairedWrong.status}）`)
  } finally {
    // 删掉本轮入库的文档
    let removed = 0
    for (const name of [`${MARK}-probe.pdf`, `${MARK}-note.md`, `${MARK}-code.ts`,
      `${MARK}-word.docx`, `${MARK}-sheet.xlsx`, `${MARK}-deck.pptx`]) {
      const d = await findDoc(name)
      if (!d) continue
      const r = await api(`/api/v1/docs/${d.id}`, { method: 'DELETE' })
      if (r.status === 200) removed += 1
    }
    // 清掉残留的暂存记录
    for (const id of stagedIds) {
      await api(`/api/v1/inbox/${id}`, { method: 'DELETE' }).catch(() => {})
    }
    if (removed) console.log(`\n  已清理 ${removed} 份测试文档`)
  }

  console.log('\n────────────────────────────────')
  console.log(`  通过 ${passed} / 失败 ${failed}`)
  console.log('')
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n测试自身出错：', err)
  process.exit(1)
})
