/**
 * 访问控制回归测试。
 *
 * 验证「未登录只能看已标记公开的文档，上传需登录」这套模型。
 *
 * ## 为什么要自己起一个服务器
 *
 * 本地开发默认是无密码的 `DEV_NO_GATE`（直接给 admin），
 * 这个状态下**根本测不到 guest 分支** —— 而那正是刚改的核心逻辑。
 * 所以本脚本额外起一个带 `ADMIN_TOKEN` 的服务器实例（另一个端口），
 * 模拟线上有密码的状态，测完自动关掉。
 *
 * 覆盖：
 *   未登录 → guest：能读、但只看到标记为 public 的文档
 *   未登录 → 不能上传 / 不能改元数据 / 不能批量操作 / 不能删标签
 *   带 admin 令牌 → 能看全部、能写
 *   未配密码时 → 不是全站拒绝，而是「只看公开 + 谁都不能写」
 *
 * 用法：
 *   node scripts/dev-server.mjs          # 常规开发服务器（另开一个终端）
 *   node scripts/test-access.mjs
 *
 * @module scripts/test-access
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = process.cwd()
/** 常规服务器（无密码，DEV_NO_GATE）—— 只用来造测试数据。 */
const MAIN = process.env.SMOKE_BASE ?? 'http://127.0.0.1:8899'
/** 带密码的独立实例，本脚本自己起。 */
const PORT = 8901
const GUARDED = `http://127.0.0.1:${PORT}`
const ADMIN_TOKEN = `rndb-access-test-${Date.now()}`

/**
 * 带密码实例专用的存储目录。
 *
 * ★ 必须与主实例隔离。第一版让两个实例共用 .local-data/，
 * 结果带密码的实例把 auth-config 写进去，主实例也变成「已配密码」，
 * 未带令牌就成了 guest、只返回公开文档 —— 测试数据凭空消失，
 * 排查了半天才发现是测试自己污染的。
 */
const GUARDED_DIR = mkdtempSync(join(tmpdir(), 'rndb-access-store-'))

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
 * 发请求。
 * @param {string} base - 基址
 * @param {string} path - 路径
 * @param {object} [opts] - { method, body, token, raw }
 * @returns {Promise<{status:number, body:object}>} 响应
 */
async function api(base, path, opts = {}) {
  const headers = {}
  if (opts.token) headers['X-Auth-Token'] = opts.token

  let body
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  } else if (opts.raw !== undefined) {
    headers['Content-Type'] = 'application/octet-stream'
    body = opts.raw
  }

  const res = await fetch(base + path, { method: opts.method ?? 'GET', headers, body })
  let parsed = null
  try {
    parsed = await res.json()
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, body: parsed }
}

/**
 * 等服务器就绪。
 * @param {string} base - 基址
 * @param {number} [timeoutMs] - 超时
 * @returns {Promise<boolean>} 是否就绪
 */
async function waitReady(base, timeoutMs = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${base}/api/v1/health`)
      if (r.ok) return true
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

async function main() {
  console.log('▸ R_N_Database 访问控制回归测试\n')

  // 常规服务器必须在线（用它造数据、并对比 DEV_NO_GATE 行为）
  try {
    const r = await fetch(`${MAIN}/api/v1/health`)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
  } catch (err) {
    console.error(`  无法连接 ${MAIN}：${err.message}`)
    console.error('  请先运行：node scripts/dev-server.mjs\n')
    process.exit(1)
  }

  /* ---------- 起一个带密码的实例（独立存储目录） ---------- */
  console.log(`【准备】启动带密码的实例 ${GUARDED}`)
  console.log(`        存储目录 ${GUARDED_DIR}（与主实例隔离）`)
  const child = spawn(process.execPath, [join(ROOT, 'scripts', 'dev-server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      ADMIN_TOKEN,
      DOCS_STORE_MODE: 'local',
      DOCS_LOCAL_DIR: GUARDED_DIR,
    },
    stdio: 'ignore',
  })

  try {
    if (!await waitReady(GUARDED)) throw new Error('带密码的实例未能就绪')
    console.log('  已就绪\n')

    /* ---------- 造一份文档（入到隔离目录里） ---------- */
    const dir = mkdtempSync(join(tmpdir(), 'rndb-access-'))
    const mark = `RNDBACCESS${Date.now()}`
    const file = join(dir, `${mark}.md`)
    writeFileSync(file, `# ${mark}\n\n访问控制测试文档。\n`, 'utf8')

    const code = await new Promise((resolve) => {
      const c = spawn(process.execPath, [join(ROOT, 'scripts', 'ingest.mjs'), file, '--no-ai'], {
        cwd: ROOT,
        // ★ 必须指向隔离目录，否则文档会入到主实例的库里
        env: { ...process.env, DOCS_STORE_MODE: 'local', DOCS_LOCAL_DIR: GUARDED_DIR },
        stdio: 'ignore',
      })
      c.on('exit', (n) => resolve(n ?? 1))
    })
    check(code === 0, '测试文档入库成功')

    const { body: found } = await api(GUARDED, `/api/v1/docs?q=${encodeURIComponent(mark)}&limit=5`, {
      token: ADMIN_TOKEN,
    })
    const doc = (found?.data?.items ?? [])[0]
    check(Boolean(doc), '能查到测试文档（用管理员令牌）')
    if (!doc) throw new Error('测试文档不存在，后续无法进行')
    rmSync(dir, { recursive: true, force: true })
    console.log(`  文档 id ${doc.id}（默认私有）\n`)

    /* ---------- 1. 未登录 = guest ---------- */
    console.log('【1. 未登录访客】')
    const anon = await api(GUARDED, '/api/v1/auth/status')
    check(anon.status === 200, `auth/status 可访问（${anon.status}）`)
    check(anon.body?.data?.role === 'guest', `角色是 guest（实际 ${anon.body?.data?.role}）`)
    check(anon.body?.data?.authenticated === false, '未标记为已登录')
    check(anon.body?.data?.configured === true, '服务端已配置密码')

    const anonList = await api(GUARDED, '/api/v1/docs?limit=200')
    check(anonList.status === 200, `能读文档列表（${anonList.status}）`)
    check((anonList.body?.data?.total ?? -1) === 0,
      `默认私有 → 未登录看不到任何文档（实际 ${anonList.body?.data?.total} 份）`)

    const anonDetail = await api(GUARDED, `/api/v1/docs/${doc.id}`)
    check(anonDetail.status === 403, `读私有文档详情被拒（${anonDetail.status}）`)

    const anonFile = await fetch(`${GUARDED}/api/v1/docs/${doc.id}/file`)
    check(anonFile.status === 403, `下载私有原件被拒（${anonFile.status}）`)

    /* ---------- 2. 未登录不能写 ---------- */
    console.log('\n【2. 未登录不能写】')
    const upName = `${mark}-上传.md`
    const anonUp = await api(GUARDED, `/api/v1/inbox?name=${encodeURIComponent(upName)}`, {
      method: 'POST', raw: new TextEncoder().encode('# x\n'),
    })
    check(anonUp.status === 403, `上传被拒（${anonUp.status}）`)
    check(/登录/.test(anonUp.body?.error?.message ?? ''),
      `错误提示说清了要登录：${anonUp.body?.error?.message}`)

    const anonPatch = await api(GUARDED, `/api/v1/docs/${doc.id}`, {
      method: 'PATCH', body: { title: '改个名' },
    })
    check(anonPatch.status === 403, `改元数据被拒（${anonPatch.status}）`)

    const anonBatch = await api(GUARDED, '/api/v1/docs/batch', {
      method: 'POST', body: { ids: [doc.id], op: 'addTags', tags: ['x'] },
    })
    check(anonBatch.status === 403, `批量操作被拒（${anonBatch.status}）`)

    const anonDel = await api(GUARDED, `/api/v1/docs/${doc.id}`, { method: 'DELETE' })
    check(anonDel.status === 403, `删除被拒（${anonDel.status}）`)

    const anonTagDel = await api(GUARDED, '/api/v1/tags/随便', { method: 'DELETE' })
    check(anonTagDel.status === 403, `删标签被拒（${anonTagDel.status}）`)

    const anonInbox = await api(GUARDED, '/api/v1/inbox')
    check(anonInbox.status === 403, `读暂存区被拒（${anonInbox.status}）`)

    /* ---------- 3. 登录后能看全部、能写 ---------- */
    console.log('\n【3. 带管理员密码】')
    const login = await api(GUARDED, '/api/v1/auth/login', {
      method: 'POST', body: { token: ADMIN_TOKEN },
    })
    check(login.status === 200, `登录成功（${login.status}）`, login.body?.error?.message)
    check(login.body?.data?.role === 'admin', `角色是 admin（${login.body?.data?.role}）`)

    const wrongPw = await api(GUARDED, '/api/v1/auth/login', {
      method: 'POST', body: { token: '肯定不对的密码' },
    })
    check(wrongPw.status === 401, `密码错误被拒（${wrongPw.status}）`)

    const adminList = await api(GUARDED, '/api/v1/docs?limit=200', { token: ADMIN_TOKEN })
    check((adminList.body?.data?.total ?? 0) > 0,
      `管理员能看到文档（${adminList.body?.data?.total} 份）`)

    const adminUp = await api(GUARDED, `/api/v1/inbox?name=${encodeURIComponent(upName)}`, {
      method: 'POST', token: ADMIN_TOKEN, raw: new TextEncoder().encode('# 上传测试\n'),
    })
    check(adminUp.status === 200, `管理员能上传（${adminUp.status}）`, adminUp.body?.error?.message)
    const pendingId = adminUp.body?.data?.id

    /* ---------- 4. 标记为公开后，未登录能看 ---------- */
    console.log('\n【4. 标记为公开后】')
    const makePublic = await api(GUARDED, `/api/v1/docs/${doc.id}`, {
      method: 'PATCH', token: ADMIN_TOKEN, body: { visibility: 'public' },
    })
    check(makePublic.status === 200, `管理员可设为公开（${makePublic.status}）`)

    const pubList = await api(GUARDED, '/api/v1/docs?limit=200')
    const ids = (pubList.body?.data?.items ?? []).map((d) => d.id)
    check(ids.length === 1 && ids[0] === doc.id,
      `未登录现在能看到这 1 份公开文档（${ids.length} 份）`)

    const pubDetail = await api(GUARDED, `/api/v1/docs/${doc.id}`)
    check(pubDetail.status === 200, `未登录能读公开文档详情（${pubDetail.status}）`)

    const pubFile = await fetch(`${GUARDED}/api/v1/docs/${doc.id}/file`)
    check(pubFile.status === 200, `未登录能下载公开原件（${pubFile.status}）`)
    const pubText = await pubFile.text()
    check(pubText.includes(mark), '下载到的内容正确')

    const pubManifest = await api(GUARDED, '/api/v1/manifest')
    check((pubManifest.body?.data?.docs ?? []).length === 1,
      `公开清单只含公开文档（${(pubManifest.body?.data?.docs ?? []).length} 份）`)

    const pubSearch = await api(GUARDED, `/api/v1/search?q=${encodeURIComponent(mark)}`)
    check((pubSearch.body?.data?.items ?? []).length === 1,
      `未登录检索只命中公开文档（${(pubSearch.body?.data?.items ?? []).length} 条）`)

    /* ---------- 5. 改回私有 ---------- */
    console.log('\n【5. 改回私有】')
    await api(GUARDED, `/api/v1/docs/${doc.id}`, {
      method: 'PATCH', token: ADMIN_TOKEN, body: { visibility: 'private' },
    })
    const backList = await api(GUARDED, '/api/v1/docs?limit=200')
    check((backList.body?.data?.total ?? -1) === 0, '改回私有后未登录又看不到了')

    /* ---------- 6. 无密码实例仍是 DEV_NO_GATE ---------- */
    console.log('\n【6. 本地无密码实例（DEV_NO_GATE）】')
    const devStatus = await api(MAIN, '/api/v1/auth/status')
    check(devStatus.body?.data?.role === 'admin', `无密码时为 admin（${devStatus.body?.data?.role}）`)
    check(devStatus.body?.data?.configured === false, 'configured = false')

    /* ---------- 7. ADMIN_TOKEN 优先级与空白容错 ---------- */
    // 这两条是从「线上设了密码却登不进」的故障里补的回归
    console.log('\n【7. ADMIN_TOKEN 优先级与空白容错】')
    const st = await api(GUARDED, '/api/v1/auth/status')
    check(st.body?.data?.envTokenPresent === true,
      `envTokenPresent = true（环境变量已传到函数）`)
    check(st.body?.data?.seedSource === 'ADMIN_TOKEN',
      `密码来源是 ADMIN_TOKEN 而不是存储里的旧哈希（${st.body?.data?.seedSource}）`)

    // 换一个带尾随空白与换行的令牌再起实例 —— 网页表单粘贴时极常见，
    // 客户端提交前会 trim，若服务端不 trim 就会「密码正确却说密码不正确」
    const WS_PORT = 8902
    const WS_BASE = `http://127.0.0.1:${WS_PORT}`
    const wsChild = spawn(process.execPath, [join(ROOT, 'scripts', 'dev-server.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(WS_PORT),
        ADMIN_TOKEN: `  ${ADMIN_TOKEN}-ws  \n`,
        DOCS_STORE_MODE: 'local',
        DOCS_LOCAL_DIR: GUARDED_DIR,
      },
      stdio: 'ignore',
    })
    try {
      if (!await waitReady(WS_BASE)) throw new Error('带空白令牌的实例未就绪')
      const wsLogin = await api(WS_BASE, '/api/v1/auth/login', {
        method: 'POST',
        body: { token: `${ADMIN_TOKEN}-ws` },
      })
      check(wsLogin.status === 200,
        `环境变量带尾随空白，登录仍然成功（${wsLogin.status}）`,
        wsLogin.body?.error?.message)
      check(wsLogin.body?.data?.role === 'admin', `角色 admin（${wsLogin.body?.data?.role}）`)

      // 新令牌生效后，**旧令牌必须失效**（早期版本被旧哈希永久压住）
      const oldToken = await api(WS_BASE, '/api/v1/auth/login', {
        method: 'POST', body: { token: ADMIN_TOKEN },
      })
      check(oldToken.status === 401,
        `换令牌后旧密码已失效（${oldToken.status}）`)
    } finally {
      wsChild.kill()
      await new Promise((r) => setTimeout(r, 300))
    }

    // 清理上传的待处理项（在隔离实例里）
    if (pendingId) {
      await api(GUARDED, `/api/v1/inbox/${pendingId}`, { method: 'DELETE', token: ADMIN_TOKEN })
    }
  } finally {
    child.kill()
    // 隔离目录整份删掉即可 —— 测试数据从未进过主库
    try {
      rmSync(GUARDED_DIR, { recursive: true, force: true })
    } catch {
      /* 被占用时忽略 */
    }
    await new Promise((r) => setTimeout(r, 400))
  }

  console.log('\n────────────────────────────────')
  console.log(`  通过 ${passed} / 失败 ${failed}`)
  console.log('')
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n测试自身出错：', err?.message ?? err)
  process.exit(1)
})
