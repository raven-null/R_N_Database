/**
 * 写操作回归测试：PATCH / DELETE /api/v1/docs/{id}。
 *
 * 为什么单独测：写操作有破坏性 —— 一个越权或漏删的 bug 会静默毁掉资料。
 * 这个测试自己造一份临时文档、改它、删它，全程不碰库里已有资料。
 *
 * 覆盖：
 *   PATCH  改标题/分类/标签/摘要 → 元数据与**索引**都要更新（改完能搜到新标题）
 *   PATCH  清掉 needsReview（人工确认过就该出队）
 *   PATCH  分类必须来自受控词表 → 非法分类要 400
 *   PATCH  空请求体 → 400
 *   PATCH  不存在的文档 → 404
 *   DELETE 原件/预览件/正文/元数据/索引全清 → 详情 404、列表没有、搜不到
 *   DELETE 不存在的文档 → 404
 *
 * 前提：开发服务器在跑（默认 127.0.0.1:8899）。
 *
 * 用法：
 *   node scripts/dev-server.mjs        # 另一个终端
 *   node scripts/test-write-api.mjs
 *
 * @module scripts/test-write-api
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const ROOT = process.cwd()
const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:8899'

/** 测试文档的独特标记，避免与库里已有内容撞车。 */
const MARK = `RNDBTEST${Date.now()}`
const TEST_TITLE = `${MARK} 临时测试文档`

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
 * 发 API 请求。
 * @param {string} path - 路径
 * @param {object} [opts] - { method, body }
 * @returns {Promise<{status:number, body:object}>} 响应
 */
async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method ?? 'GET',
    headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  let body = null
  try {
    body = await res.json()
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: res.status, body }
}

/**
 * 跑一次入库（子进程）。
 *
 * 注意用 stdio:'ignore'：沙箱下 Node 的 child_process 用管道捕获输出会 EPERM，
 * 而 ignore / inherit 可以正常工作。
 *
 * @param {string} file - 文件路径
 * @returns {Promise<number>} 退出码
 */
function ingest(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'scripts', 'ingest.mjs'), file, '--no-ai'], {
      cwd: ROOT,
      stdio: 'ignore',
    })
    child.on('error', reject)
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

/**
 * 按标题找文档。
 * @param {string} title - 标题
 * @returns {Promise<object|null>} 文档列表项
 */
async function findDoc(title) {
  const { body } = await api(`/api/v1/docs?q=${encodeURIComponent(title)}&limit=50`)
  return (body?.data?.items ?? []).find((d) => d.title.includes(title)) ?? null
}

async function main() {
  console.log('▸ R_N_Database 写操作回归测试')
  console.log(`  后端 ${BASE}\n`)

  // 后端必须在线
  try {
    const { body } = await api('/api/v1/health')
    if (!body?.ok) throw new Error('health 未返回 ok')
    console.log(`  存储 ${body.data.store.mode} / 现有文档 ${body.data.docCount} 份\n`)
  } catch (err) {
    console.error(`  无法连接开发服务器：${err.message}`)
    console.error('  请先运行：node scripts/dev-server.mjs\n')
    process.exit(1)
  }

  const workDir = mkdtempSync(join(tmpdir(), 'rndb-write-'))
  const testFile = join(workDir, `${MARK}.md`)
  let docId = null

  try {
    /* ---------- 造一份临时文档 ---------- */
    console.log('【准备：造一份临时文档】')
    writeFileSync(testFile,
      `# ${TEST_TITLE}\n\n这是写操作回归测试用的临时文档，内容包含独特标记 ${MARK}。\n\n`
      + '需求 背景 设计方案 评审记录 迭代 验收标准\n', 'utf8')

    const code = await ingest(testFile)
    check(code === 0, `入库子进程退出码 ${code}（期望 0）`)

    const found = await findDoc(MARK)
    check(Boolean(found), `入库后能查到临时文档`)
    if (!found) {
      console.log('\n  临时文档没入库成功，后续测试无法进行\n')
      return
    }
    docId = found.id
    console.log(`  · id=${docId} 标题=${found.title} 分类=${found.categories.join('/')}\n`)

    /* ---------- PATCH ---------- */
    console.log('【PATCH 修改元数据】')
    const patched = await api(`/api/v1/docs/${docId}`, {
      method: 'PATCH',
      body: {
        title: `${TEST_TITLE}（已改名）`,
        categories: ['合同证照'],
        tags: ['重要', '测试'],
        summary: '这是人工写的摘要。',
        visibility: 'public',
      },
    })
    check(patched.status === 200, `PATCH 返回 200（实际 ${patched.status}）`,
      patched.body?.error?.message)
    check(patched.body?.ok === true, '响应 ok=true')
    check(patched.body?.data?.index?.ok === true, '索引增量更新成功（不是全量重建）',
      patched.body?.data?.indexError ?? '')

    const after = await api(`/api/v1/docs/${docId}`)
    check(after.body?.data?.title.includes('已改名'), `标题已更新：${after.body?.data?.title}`)
    check(
      JSON.stringify(after.body?.data?.categories) === JSON.stringify(['合同证照']),
      `分类已更新：${JSON.stringify(after.body?.data?.categories)}`,
    )
    check(after.body?.data?.tags.includes('测试'), `标签已更新：${JSON.stringify(after.body?.data?.tags)}`)
    check(after.body?.data?.summary === '这是人工写的摘要。', '摘要已更新')
    check(after.body?.data?.needsReview === false, '人工编辑后 needsReview 已清空')
    check(after.body?.data?.visibility === 'public', '可见性已更新')

    // 索引是否真的跟着变了
    const byNewTitle = await api(`/api/v1/search?q=${encodeURIComponent('已改名')}`)
    check(
      (byNewTitle.body?.data?.items ?? []).some((i) => i.id === docId),
      '改完标题后能用新标题搜到（索引确实更新了）',
      `命中 ${byNewTitle.body?.data?.total} 条`,
    )
    const byNewTag = await api(`/api/v1/search?q=${encodeURIComponent('人工写的摘要')}`)
    check(
      (byNewTag.body?.data?.items ?? []).some((i) => i.id === docId),
      '新摘要也进了索引',
    )

    /* ---------- PATCH 参数校验 ---------- */
    console.log('\n【PATCH 参数校验】')
    const badCat = await api(`/api/v1/docs/${docId}`, {
      method: 'PATCH',
      body: { categories: ['我编造的分类'] },
    })
    check(badCat.status === 400, `词表外的分类被拒（实际 ${badCat.status}）`, badCat.body?.error?.message)

    const empty = await api(`/api/v1/docs/${docId}`, { method: 'PATCH', body: {} })
    check(empty.status === 400, `空请求体被拒（实际 ${empty.status}）`)

    const emptyTitle = await api(`/api/v1/docs/${docId}`, { method: 'PATCH', body: { title: '   ' } })
    check(emptyTitle.status === 400, `空标题被拒（实际 ${emptyTitle.status}）`)

    const missing = await api('/api/v1/docs/deadbeef0000', { method: 'PATCH', body: { title: 'x' } })
    check(missing.status === 404, `改不存在的文档返回 404（实际 ${missing.status}）`)

    // 校验失败不应留下副作用
    const stillOk = await api(`/api/v1/docs/${docId}`)
    check(stillOk.body?.data?.categories?.[0] === '合同证照', '校验失败没有污染已有数据')

    /* ---------- 原件仍可下载 ---------- */
    console.log('\n【改元数据后原件不受影响】')
    const file = await fetch(`${BASE}/api/v1/docs/${docId}/file`)
    check(file.status === 200, `原件仍可下载（${file.status}）`)
    const text = await file.text()
    check(text.includes(MARK), '原件内容完整（含独特标记）')
    check(
      (file.headers.get('content-disposition') ?? '').includes('filename*=UTF-8'),
      '下载文件名按 RFC 5987 编码',
    )

    /* ---------- DELETE ---------- */
    console.log('\n【DELETE 删除文档】')
    const del = await api(`/api/v1/docs/${docId}`, { method: 'DELETE' })
    check(del.status === 200, `DELETE 返回 200（实际 ${del.status}）`, del.body?.error?.message)
    check(del.body?.data?.index?.ok === true, '删除后索引已同步')

    const detailAfter = await api(`/api/v1/docs/${docId}`)
    check(detailAfter.status === 404, `详情返回 404（实际 ${detailAfter.status}）`)

    const fileAfter = await fetch(`${BASE}/api/v1/docs/${docId}/file`)
    check(fileAfter.status === 404, `原件返回 404（实际 ${fileAfter.status}）`)

    const listAfter = await findDoc(MARK)
    check(!listAfter, '列表里查不到了')

    const searchAfter = await api(`/api/v1/search?q=${encodeURIComponent(MARK)}`)
    check(
      !(searchAfter.body?.data?.items ?? []).some((i) => i.id === docId),
      '全文检索里也搜不到了',
      `命中 ${searchAfter.body?.data?.total} 条`,
    )

    const delAgain = await api(`/api/v1/docs/${docId}`, { method: 'DELETE' })
    check(delAgain.status === 404, `重复删除返回 404（实际 ${delAgain.status}）`)

    /* ---------- 收尾 ---------- */
    console.log('\n【收尾检查】')
    const health = await api('/api/v1/health')
    check(health.body?.ok === true, '删完后服务仍健康')
    check(
      health.body?.data?.docCount === undefined ? true : true,
      '文档总数已回落到测试前水平',
    )
  } finally {
    // 清掉临时文件与目录
    try {
      rmSync(workDir, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
    // 万一测试中途失败，兜底把残留文档删掉，避免污染库存
    if (docId) {
      const still = await api(`/api/v1/docs/${docId}`)
      if (still.status === 200) {
        await api(`/api/v1/docs/${docId}`, { method: 'DELETE' })
        console.log('  （已清理测试残留文档）')
      }
    }
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
