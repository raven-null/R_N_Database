/**
 * 批量操作 / 标签管理 / 上传暂存 的回归测试。
 *
 * 三块都在动「很多份文档」，一旦有 bug 影响面很大，必须有回归测试。
 * 全程使用自己造的临时文档，不碰库里已有资料；结束时全部清理。
 *
 * 覆盖：
 *   批量：加标签 / 删标签 / 改分类 / 标为待复查 / 删除
 *   标签：重命名 / 合并多个 / 全库删除 / 统计
 *   上传：传件 → 清单 → 重复识别 → 类型校验 → 体积校验 → 移除
 *   一致性：批量改完**索引要跟着变**（改完能用新标签搜到）
 *
 * 前提：开发服务器在跑。
 *
 * @module scripts/test-batch-tags
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const ROOT = process.cwd()
const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:8899'

/** 本次测试用的独特标记，避免与库里已有内容撞车。 */
const MARK = `RNDBBATCH${Date.now()}`
/**
 * 标签名要**短**：服务端上限 20 字符，过长会被拒绝。
 * （第一版用了带完整 MARK 的标签名，超过 20 字符被静默截断，
 *   导致后续所有比对全错 —— 顺手把静默截断改成了明确报错。）
 */
const SHORT = String(Date.now()).slice(-6)
const TAG_A = `批甲${SHORT}`
const TAG_B = `批乙${SHORT}`
const TAG_MERGED = `合并${SHORT}`

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
 * @param {object} [opts] - { method, body, raw }
 * @returns {Promise<{status:number, body:object}>} 响应
 */
async function api(path, opts = {}) {
  const init = { method: opts.method ?? 'GET' }
  if (opts.body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(opts.body)
  } else if (opts.raw !== undefined) {
    init.headers = { 'Content-Type': 'application/octet-stream' }
    init.body = opts.raw
  }
  const res = await fetch(BASE + path, init)
  let body = null
  try {
    body = await res.json()
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, body }
}

/**
 * 跑一次命令行入库（stdio 用 ignore —— 沙箱下管道捕获会 EPERM）。
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
 * 找一份文档的当前元数据。
 * @param {string} id - 文档 id
 * @returns {Promise<object|null>} 元数据
 */
async function getDoc(id) {
  const { body } = await api(`/api/v1/docs/${id}`)
  return body?.ok ? body.data : null
}

async function main() {
  console.log('▸ R_N_Database 批量 / 标签 / 上传 回归测试')
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

  const workDir = mkdtempSync(join(tmpdir(), 'rndb-batch-'))
  /** 造出来的临时文档 id，收尾时统一清理。 */
  const tempIds = []

  try {
    /* ---------- 造 4 份临时文档 ---------- */
    console.log('【准备：造 4 份临时文档】')
    for (let i = 1; i <= 4; i++) {
      const f = join(workDir, `${MARK}-${i}.md`)
      writeFileSync(f, `# ${MARK} 临时文档 ${i}\n\n用于批量操作回归测试。\n\n需求 设计 评审\n`, 'utf8')
      const code = await ingest(f)
      if (code !== 0) check(false, `第 ${i} 份临时文档入库失败（退出码 ${code}）`)
    }

    const { body: list } = await api(`/api/v1/docs?q=${encodeURIComponent(MARK)}&limit=20`)
    const ids = (list?.data?.items ?? []).map((d) => d.id)
    tempIds.push(...ids)
    check(ids.length === 4, `造出 ${ids.length} 份临时文档（期望 4）`)
    if (ids.length === 0) return

    /* ---------- 批量加标签 ---------- */
    console.log('\n【批量加标签】')
    const add = await api('/api/v1/docs/batch', {
      method: 'POST',
      body: { ids, op: 'addTags', tags: [TAG_A, TAG_B] },
    })
    check(add.status === 200, `HTTP 200（实际 ${add.status}）`, add.body?.error?.message)
    check(add.body?.data?.applied === ids.length, `影响 ${add.body?.data?.applied} 份`)
    check(add.body?.data?.index?.ok === true, '索引已同步')

    const afterAdd = await getDoc(ids[0])
    check(afterAdd?.tags?.includes(TAG_A) && afterAdd?.tags?.includes(TAG_B),
      `标签已写入：${JSON.stringify(afterAdd?.tags)}`)
    check(afterAdd?.needsReview === false, '批量改动后「待复查」被清除')

    // ★ 索引必须跟着变：用新标签全文检索能命中
    const { body: searchTags } = await api(`/api/v1/search?q=${encodeURIComponent(TAG_A)}`)
    check(
      (searchTags?.data?.items ?? []).length >= ids.length,
      `用新标签能搜到（${searchTags?.data?.total} 条）—— 索引确实更新了`,
    )

    /* ---------- 批量删标签 ---------- */
    console.log('\n【批量删标签】')
    const rm = await api('/api/v1/docs/batch', {
      method: 'POST',
      body: { ids, op: 'removeTags', tags: [TAG_B] },
    })
    check(rm.status === 200, `HTTP 200（实际 ${rm.status}）`)
    const afterRm = await getDoc(ids[0])
    check(!afterRm?.tags?.includes(TAG_B), '指定标签已移除')
    check(afterRm?.tags?.includes(TAG_A), '未指定的标签保留')

    /* ---------- 批量改分类 ---------- */
    console.log('\n【批量改分类】')
    const cat = await api('/api/v1/docs/batch', {
      method: 'POST',
      body: { ids, op: 'setCategory', categories: ['合同证照'] },
    })
    check(cat.status === 200, `HTTP 200（实际 ${cat.status}）`)
    const afterCat = await getDoc(ids[0])
    check(JSON.stringify(afterCat?.categories) === JSON.stringify(['合同证照']),
      `分类已整体替换：${JSON.stringify(afterCat?.categories)}`)

    const badCat = await api('/api/v1/docs/batch', {
      method: 'POST',
      body: { ids, op: 'setCategory', categories: ['我编的分类'] },
    })
    check(badCat.status === 400, `词表外的分类被拒（实际 ${badCat.status}）`)

    /* ---------- 标为待复查 ---------- */
    console.log('\n【标为待复查】')
    const rv = await api('/api/v1/docs/batch', {
      method: 'POST',
      body: { ids: [ids[0]], op: 'markReview' },
    })
    check(rv.status === 200, `HTTP 200（实际 ${rv.status}）`)
    check((await getDoc(ids[0]))?.needsReview === true, '已标记为待复查')

    /* ---------- 参数校验 ---------- */
    console.log('\n【批量参数校验】')
    const e1 = await api('/api/v1/docs/batch', { method: 'POST', body: { ids: [], op: 'addTags', tags: ['x'] } })
    check(e1.status === 400, `空 ids 被拒（实际 ${e1.status}）`)
    const e2 = await api('/api/v1/docs/batch', { method: 'POST', body: { ids, op: '乱来' } })
    check(e2.status === 400, `未知操作被拒（实际 ${e2.status}）`, e2.body?.error?.message)
    const e3 = await api('/api/v1/docs/batch', { method: 'POST', body: { ids, op: 'addTags', tags: [] } })
    check(e3.status === 400, `空标签被拒（实际 ${e3.status}）`)
    // 过长标签要明确报错，不能静默截断（截断会让名字与输入对不上）
    const e4 = await api('/api/v1/docs/batch', {
      method: 'POST',
      body: { ids, op: 'addTags', tags: ['这是一个特别特别特别特别长的标签名字超过二十个字符'] },
    })
    check(e4.status === 400, `过长标签被拒（实际 ${e4.status}）`, e4.body?.error?.message)

    /* ---------- 标签重命名 ---------- */
    console.log('\n【标签重命名】')
    const renamed = `改${SHORT}`
    const rn = await api('/api/v1/tags/rename', { method: 'POST', body: { from: TAG_A, to: renamed } })
    check(rn.status === 200, `HTTP 200（实际 ${rn.status}）`, rn.body?.error?.message)
    check(rn.body?.data?.affected === ids.length, `影响 ${rn.body?.data?.affected} 份`)
    const afterRn = await getDoc(ids[0])
    check(afterRn?.tags?.includes(renamed), `新标签名已生效：${JSON.stringify(afterRn?.tags)}`)
    check(!afterRn?.tags?.includes(TAG_A), '旧标签名已消失')

    /* ---------- 标签统计与合并 ---------- */
    console.log('\n【标签统计 / 合并】')
    const { body: stats } = await api('/api/v1/tags')
    const statNames = (stats?.data?.tags ?? []).map((t) => t.name)
    check(statNames.includes(renamed), `统计里有「${renamed}」`)
    check(typeof stats?.data?.total === 'number', `标签总数 ${stats?.data?.total}`)

    // 造第二个标签再合并过去
    await api('/api/v1/docs/batch', { method: 'POST', body: { ids: [ids[1], ids[2]], op: 'addTags', tags: [TAG_MERGED] } })
    const mg = await api('/api/v1/tags/rename', {
      method: 'POST',
      body: { from: [TAG_MERGED], to: renamed },
    })
    check(mg.status === 200, `合并 HTTP 200（实际 ${mg.status}）`)
    const afterMg = await getDoc(ids[1])
    check(afterMg?.tags?.includes(renamed) && !afterMg?.tags?.includes(TAG_MERGED),
      `合并后只剩目标标签：${JSON.stringify(afterMg?.tags)}`)
    const noDup = (afterMg?.tags ?? []).filter((t) => t === renamed).length
    check(noDup === 1, '合并后没有重复标签')

    const self = await api('/api/v1/tags/rename', { method: 'POST', body: { from: renamed, to: renamed } })
    check(self.status === 400, `新旧同名被拒（实际 ${self.status}）`)

    /* ---------- 全库删除标签 ---------- */
    console.log('\n【全库删除标签】')
    const del = await api(`/api/v1/tags/${encodeURIComponent(renamed)}`, { method: 'DELETE' })
    check(del.status === 200, `HTTP 200（实际 ${del.status}）`)
    check(del.body?.data?.affected > 0, `影响 ${del.body?.data?.affected} 份`)
    const afterDel = await getDoc(ids[0])
    check(!afterDel?.tags?.includes(renamed), `标签已从文档上摘掉：${JSON.stringify(afterDel?.tags)}`)
    const delAgain = await api(`/api/v1/tags/${encodeURIComponent(renamed)}`, { method: 'DELETE' })
    check(delAgain.status === 200 && delAgain.body?.data?.affected === 0,
      '重复删除返回影响 0（不报错）')

    /* ---------- 上传暂存 ---------- */
    console.log('\n【上传暂存】')
    const upName = `${MARK}-上传.md`
    const upBytes = new TextEncoder().encode(`# ${MARK} 上传测试\n\n内容\n`)

    const up = await api(`/api/v1/inbox?name=${encodeURIComponent(upName)}`, { method: 'POST', raw: upBytes })
    check(up.status === 200, `上传 HTTP 200（实际 ${up.status}）`, up.body?.error?.message)
    check(up.body?.data?.type === 'md', `类型识别为 ${up.body?.data?.type}`)
    check(up.body?.data?.size === upBytes.length, `大小记录正确（${up.body?.data?.size}）`)
    const pendingId = up.body?.data?.id

    const dup = await api(`/api/v1/inbox?name=${encodeURIComponent(upName)}`, { method: 'POST', raw: upBytes })
    check(Boolean(dup.body?.data?.alreadyPending), '重复上传被识别为暂存区已有')

    const { body: inbox } = await api('/api/v1/inbox')
    check((inbox?.data?.total ?? 0) >= 1, `待处理清单有 ${inbox?.data?.total} 份`)
    check((inbox?.data?.items ?? []).some((i) => i.id === pendingId), '新上传的在清单里')

    const noName = await api('/api/v1/inbox', { method: 'POST', raw: upBytes })
    check(noName.status === 400, `缺文件名被拒（实际 ${noName.status}）`)
    const badType = await api('/api/v1/inbox?name=x.exe', { method: 'POST', raw: upBytes })
    check(badType.status === 400, `不支持的类型被拒（实际 ${badType.status}）`, badType.body?.error?.message)
    const empty = await api('/api/v1/inbox?name=x.md', { method: 'POST', raw: new Uint8Array(0) })
    check(empty.status === 400, `空文件被拒（实际 ${empty.status}）`)

    // 清理暂存区
    for (const id of [pendingId, dup.body?.data?.id].filter(Boolean)) {
      await api(`/api/v1/inbox/${id}`, { method: 'DELETE' })
    }
    const { body: inboxAfter } = await api('/api/v1/inbox')
    check((inboxAfter?.data?.total ?? 0) === 0, '暂存区已清空')

    /* ---------- 批量删除 ---------- */
    console.log('\n【批量删除】')
    const delRes = await api('/api/v1/docs/batch', { method: 'POST', body: { ids, op: 'delete' } })
    check(delRes.status === 200, `HTTP 200（实际 ${delRes.status}）`, delRes.body?.error?.message)
    check(delRes.body?.data?.deleted === ids.length, `删除 ${delRes.body?.data?.deleted} 份`)
    check(delRes.body?.data?.index?.ok === true, '索引已同步')

    const gone = await api(`/api/v1/docs/${ids[0]}`)
    check(gone.status === 404, `详情返回 404（实际 ${gone.status}）`)
    const goneFile = await fetch(`${BASE}/api/v1/docs/${ids[0]}/file`)
    check(goneFile.status === 404, `原件返回 404（实际 ${goneFile.status}）`)
    const { body: searchGone } = await api(`/api/v1/docs?q=${encodeURIComponent(MARK)}&limit=20`)
    check((searchGone?.data?.items ?? []).length === 0, '列表里也查不到了')
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
    // 兜底清理：中途失败时别把临时文档留在库里
    let left = 0
    for (const id of tempIds) {
      const still = await api(`/api/v1/docs/${id}`)
      if (still.status === 200) {
        await api(`/api/v1/docs/${id}`, { method: 'DELETE' })
        left += 1
        await new Promise((r) => setTimeout(r, 120))
      }
    }
    if (left > 0) console.log(`  （已清理 ${left} 份测试残留文档）`)
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
