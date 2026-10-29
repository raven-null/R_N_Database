/**
 * 虚拟文件夹树测试。
 *
 * 覆盖三件最容易出错的事：
 *   ① **幂等**：同一个目录反复导入不能长出重复文件夹
 *   ② **不销毁数据**：删文件夹只上移子项，不带走文档
 *   ③ **继承**：父文件夹设私有，里面的文档对访客全部不可见
 *
 * ## 为什么要自己起一个实例
 *
 * 主实例（8899）没配密码时匿名就是管理员，那样根本测不出"访客看不见"。
 * 所以这里像 test-access 一样，另起一个**带口令、存储目录隔离**的实例：
 * 写操作用令牌，访客检查不带令牌。
 *
 * @module scripts/test-folders
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = process.cwd()
const PORT = 8902
const BASE = `http://127.0.0.1:${PORT}`
const TOKEN = `rndb-folders-${Date.now()}`
const STORE_DIR = mkdtempSync(join(tmpdir(), 'rndb-folders-'))
const MARK = `FLD${Date.now()}`

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
 * @param {object} [opts] - { method, body, token }
 * @returns {Promise<{status:number, body:object|null}>} 响应
 */
async function api(path, opts = {}) {
  const headers = {}
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  if (opts.token) headers['X-Auth-Token'] = opts.token
  const res = await fetch(BASE + path, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, body }
}

/** 管理员写操作的快捷方式。 */
const admin = (path, opts = {}) => api(path, { ...opts, token: TOKEN })

/**
 * 上传并入库一份文件。
 * @param {string} name - 文件名
 * @param {string} relPath - 相对路径
 * @param {string} content - 内容
 * @returns {Promise<string|null>} 文档 id
 */
async function ingestDoc(name, relPath, content) {
  const q = new URLSearchParams({ name, path: relPath })
  const up = await fetch(`${BASE}/api/v1/inbox?${q}`, {
    method: 'POST',
    headers: { 'X-Auth-Token': TOKEN, 'Content-Type': 'text/markdown' },
    body: content,
  })
  const rec = (await up.json())?.data
  if (!rec?.id) return null
  const res = await admin('/api/v1/inbox/ingest', { method: 'POST', body: { ids: [rec.id] } })
  const r = res.body?.data?.results?.[0]
  return r?.status === 'ingested' ? r.docId : null
}

/**
 * 等实例就绪。
 * @param {number} tries - 最多试几次
 * @returns {Promise<boolean>} 是否就绪
 */
async function waitReady(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${BASE}/api/v1/health?store=0`)
      if (res.status === 200) return true
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

async function main() {
  console.log('▸ 文件夹树测试\n')
  console.log(`【准备】启动隔离实例 ${BASE}`)
  console.log(`        存储目录 ${STORE_DIR}`)

  const child = spawn(process.execPath, [join(ROOT, 'scripts', 'dev-server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      ADMIN_TOKEN: TOKEN,
      DOCS_STORE_MODE: 'local',
      DOCS_LOCAL_DIR: STORE_DIR,
    },
    stdio: 'ignore',
  })

  try {
    if (!await waitReady()) throw new Error('隔离实例未能就绪')
    console.log('  已就绪\n')

    /* ---------- 列表 ---------- */
    console.log('【列表与新建】')
    const list0 = await api('/api/v1/folders')
    check(list0.status === 200, `GET /folders 成功（HTTP ${list0.status}）`)
    check(Array.isArray(list0.body?.data?.folders), '返回 folders 数组')
    check((list0.body?.data?.total ?? -1) === 0, '新库里没有任何文件夹')

    const made = await admin('/api/v1/folders', { method: 'POST', body: { name: `${MARK} 证件` } })
    check(made.status === 200, `新建成功（HTTP ${made.status}）`)
    const fid = made.body?.data?.folder?.fid
    check(Boolean(fid), `拿到 fid（${fid}）`)
    check(made.body?.data?.folder?.path === `${MARK} 证件`, `路径正确（${made.body?.data?.folder?.path}）`)
    check(made.body?.data?.folder?.visibility === 'inherit', '默认可见性是 inherit')

    const dup = await admin('/api/v1/folders', { method: 'POST', body: { name: `${MARK} 证件` } })
    check(dup.body?.data?.folder?.name === `${MARK} 证件 (2)`,
      `同名自动加后缀（${dup.body?.data?.folder?.name}）`)

    const badName = await admin('/api/v1/folders', { method: 'POST', body: { name: '   ' } })
    check(badName.status === 400, `空名字被拒（HTTP ${badName.status}）`)

    const sub = await admin('/api/v1/folders', { method: 'POST', body: { name: '2025', parentFid: fid } })
    check(sub.body?.data?.folder?.path === `${MARK} 证件/2025`,
      `子文件夹路径正确（${sub.body?.data?.folder?.path}）`)

    /* ---------- 权限 ---------- */
    console.log('\n【权限】')
    const anonCreate = await api('/api/v1/folders', { method: 'POST', body: { name: '偷偷建' } })
    check(anonCreate.status === 403, `访客不能建文件夹（HTTP ${anonCreate.status}）`)
    const anonList = await api('/api/v1/folders')
    check(anonList.status === 200, '访客可以读文件夹树（HTTP 200）')

    /* ---------- 上传自动建树 ---------- */
    console.log('\n【上传自动建树】')
    const docId = await ingestDoc(`${MARK}-note.md`, `${MARK}/学习/第1章/${MARK}-note.md`,
      `# ${MARK}\n\n文件夹归位测试。\n`)
    check(Boolean(docId), '文档入库成功')

    const list1 = await admin('/api/v1/folders')
    const paths1 = (list1.body?.data?.folders ?? []).map((f) => f.path)
    check(paths1.includes(`上传/${MARK}`), '自动建出「上传/MARK」')
    check(paths1.includes(`上传/${MARK}/学习/第1章`), '逐级建出子目录')

    const autoCount1 = paths1.filter((p) => p.startsWith(`上传/${MARK}`)).length
    const docId2 = await ingestDoc(`${MARK}-note2.md`, `${MARK}/学习/第1章/${MARK}-note2.md`,
      `# ${MARK} 2\n\n同一目录再入库。\n`)
    check(Boolean(docId2), '第二份同目录文档入库成功')
    const list2 = await admin('/api/v1/folders')
    const autoCount2 = (list2.body?.data?.folders ?? []).filter((f) => f.path.startsWith(`上传/${MARK}`)).length
    check(autoCount2 === autoCount1, `文件夹没有重复长出来（${autoCount1} → ${autoCount2}）`)

    const leaf = (list2.body?.data?.folders ?? []).find((f) => f.path === `上传/${MARK}/学习/第1章`)
    check(leaf?.docCount === 2, `叶子文件夹里有 2 份文档（${leaf?.docCount}）`)
    const top = (list2.body?.data?.folders ?? []).find((f) => f.path === `上传/${MARK}`)
    check(top?.totalDocCount === 2, `父文件夹累计含 2 份（${top?.totalDocCount}）`)

    /* ---------- dir 由树派生 ---------- */
    console.log('\n【dir 跟着文件夹走】')
    const docBefore = await admin(`/api/v1/docs/${docId}`)
    check(docBefore.body?.data?.folderId === leaf?.fid,
      `文档挂了 folderId（${docBefore.body?.data?.folderId}）`)
    const items1 = (await admin('/api/v1/docs?limit=200')).body?.data?.items ?? []
    check(items1.find((d) => d.id === docId)?.dir === `上传/${MARK}/学习/第1章`,
      `列表里的 dir 正确（${items1.find((d) => d.id === docId)?.dir}）`)

    const renamed = await admin(`/api/v1/folders/${top.fid}`, {
      method: 'PATCH', body: { name: `${MARK} 改名后` },
    })
    check(renamed.status === 200, `改名成功（HTTP ${renamed.status}）`)
    const items2 = (await admin('/api/v1/docs?limit=200')).body?.data?.items ?? []
    check(items2.find((d) => d.id === docId)?.dir === `上传/${MARK} 改名后/学习/第1章`,
      `改名后文档的 dir 自动跟着变（${items2.find((d) => d.id === docId)?.dir}）`)

    /* ---------- 移动 ---------- */
    console.log('\n【移动】')
    const subFid = sub.body?.data?.folder?.fid
    const moved = await admin(`/api/v1/folders/${top.fid}`, { method: 'PATCH', body: { parentFid: fid } })
    check(moved.status === 200, `移动成功（HTTP ${moved.status}）`)
    check(moved.body?.data?.folder?.path === `${MARK} 证件/${MARK} 改名后`,
      `路径跟着父级变化（${moved.body?.data?.folder?.path}）`)

    const cyclic = await admin(`/api/v1/folders/${fid}`, { method: 'PATCH', body: { parentFid: subFid } })
    check(cyclic.status === 400, `不能移到自己的子目录里（HTTP ${cyclic.status}）`)
    const self = await admin(`/api/v1/folders/${fid}`, { method: 'PATCH', body: { parentFid: fid } })
    check(self.status === 400, `不能移到自己里面（HTTP ${self.status}）`)

    /* ---------- 把文档移进文件夹 ---------- */
    console.log('\n【文档移到文件夹】')
    const moved2 = await admin('/api/v1/docs/batch', {
      method: 'POST',
      body: { op: 'moveToFolder', ids: [docId], folderId: subFid },
    })
    check(moved2.status === 200, `moveToFolder 成功（HTTP ${moved2.status}）`)
    const dAfterMove = await admin(`/api/v1/docs/${docId}`)
    check(dAfterMove.body?.data?.folderId === subFid,
      `文档的 folderId 已更新（${dAfterMove.body?.data?.folderId}）`)
    const itemsAfterMove = (await admin('/api/v1/docs?limit=200')).body?.data?.items ?? []
    check(itemsAfterMove.find((d) => d.id === docId)?.dir === `${MARK} 证件/2025`,
      `目录跟着变（${itemsAfterMove.find((d) => d.id === docId)?.dir}）`)

    const badMove = await admin('/api/v1/docs/batch', {
      method: 'POST',
      body: { op: 'moveToFolder', ids: [docId], folderId: 'nope-no-such-fid' },
    })
    check(badMove.status === 400, `移到不存在的文件夹被拒（HTTP ${badMove.status}）`)

    // 移回根（folderId: null）→ dir 回落到来源路径；再放回叶子，后面的继承测试要用
    await admin('/api/v1/docs/batch', {
      method: 'POST',
      body: { op: 'moveToFolder', ids: [docId], folderId: null },
    })
    const dRoot = await admin(`/api/v1/docs/${docId}`)
    check(dRoot.body?.data?.folderId === null, 'folderId 清空后回到根目录')
    await admin('/api/v1/docs/batch', {
      method: 'POST',
      body: { op: 'moveToFolder', ids: [docId, docId2], folderId: leaf.fid },
    })

    /* ---------- 可见性继承 ---------- */
    console.log('\n【可见性继承】')
    const docMeta = await admin(`/api/v1/docs/${docId}`)
    check(docMeta.body?.data?.visibility === 'private', '新文档默认私有')

    await admin('/api/v1/docs/batch', {
      method: 'POST',
      body: { op: 'setVisibility', ids: [docId, docId2], visibility: 'public' },
    })
    check((await admin(`/api/v1/docs/${docId}`)).body?.data?.visibility === 'public', '已转公开')
    check((await fetch(`${BASE}/api/v1/docs/${docId}`)).status === 200, '访客现在能看到它')

    const setPriv = await admin(`/api/v1/folders/${fid}`, { method: 'PATCH', body: { visibility: 'private' } })
    check(setPriv.status === 200, '父文件夹设为 private')

    check((await fetch(`${BASE}/api/v1/docs/${docId}`)).status === 403,
      '访客读文档被拒（继承生效）')
    const guestItems = (await api('/api/v1/docs?limit=200')).body?.data?.items ?? []
    check(!guestItems.some((d) => d.id === docId), '访客列表里看不到它')
    const guestFolders = (await api('/api/v1/folders')).body?.data?.folders ?? []
    check(!guestFolders.some((f) => f.fid === fid), '访客连这个文件夹都看不到（不泄露结构）')

    await admin(`/api/v1/folders/${top.fid}`, { method: 'PATCH', body: { visibility: 'public' } })
    check((await fetch(`${BASE}/api/v1/docs/${docId}`)).status === 403,
      '子层 public 不会放宽父层的 private')
    await admin(`/api/v1/folders/${fid}`, { method: 'PATCH', body: { visibility: 'inherit' } })
    check((await fetch(`${BASE}/api/v1/docs/${docId}`)).status === 200, '恢复后访客又能看到')

    /* ---------- 删除不销毁数据 ---------- */
    console.log('\n【删除不销毁数据】')
    const delRes = await admin(`/api/v1/folders/${top.fid}`, { method: 'DELETE' })
    check(delRes.status === 200, `删除成功（HTTP ${delRes.status}）`)
    check((delRes.body?.data?.movedDocs ?? -1) >= 0, `报告上移的文档数（${delRes.body?.data?.movedDocs}）`)

    const after = (await admin('/api/v1/folders')).body?.data?.folders ?? []
    check(!after.some((f) => f.fid === top.fid), '被删的文件夹不在列表里了')
    check(after.some((f) => f.fid === leaf?.fid), '它的子文件夹上移后还在')
    check((await admin(`/api/v1/docs/${docId}`)).status === 200, '文档还在，没有被连带删除')

    /* ---------- 边界 ---------- */
    console.log('\n【边界】')
    const noSuch = await admin('/api/v1/folders/nonexistentfid', { method: 'PATCH', body: { name: 'x' } })
    check(noSuch.status === 404 || noSuch.status === 400, `不存在的 fid 被拒（HTTP ${noSuch.status}）`)
    const nothing = await admin(`/api/v1/folders/${fid}`, { method: 'PATCH', body: {} })
    check(nothing.status === 400, `空补丁被拒（HTTP ${nothing.status}）`)
    const badVis = await admin(`/api/v1/folders/${fid}`, { method: 'PATCH', body: { visibility: 'secret' } })
    check(badVis.status === 400, `非法可见性被拒（HTTP ${badVis.status}）`)
  } finally {
    child.kill()
    await new Promise((r) => setTimeout(r, 300))
    try { rmSync(STORE_DIR, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }

  console.log('\n────────────────────────────────')
  console.log(`  通过 ${passed} / 失败 ${failed}`)
  console.log('')
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n测试自身出错：', err?.message ?? err)
  process.exit(2)
})
