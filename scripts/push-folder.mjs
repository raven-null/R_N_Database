/**
 * 把一个本地目录**推到线上资料库**（不需要 Netlify 令牌）。
 *
 * ## 和 scripts/ingest.mjs 的区别（这是最容易搞混的地方）
 *
 *   ingest.mjs        本地进程直写 Blobs → 需要 Netlify Personal Access Token
 *                     能转 Office→PDF（本地有 LibreOffice）
 *
 *   push-folder.mjs   走网站的 admin API（网页上传接口 + 服务端入库接口）
 *                     只需要**网站自己的登录密码** ADMIN_TOKEN
 *                     不能转 Office→PDF（函数里没有 LibreOffice）
 *
 * 后者适合"手上有个文件夹，想让它出现在线上站点"这种场景，
 * 而不必去 Netlify 后台建令牌、也不必把资料拷到别处。
 *
 * ## 用法
 *
 *   # 密码从环境变量读（推荐，避免出现在命令历史里）
 *   $env:ADMIN_TOKEN='...'; node scripts/push-folder.mjs "E:\学习\Java\学习"
 *
 *   # 或显式指定
 *   node scripts/push-folder.mjs "E:\学习\Java\学习" --token=... --base=https://r-database.netlify.app
 *
 *   # 只看会传什么，不真的传
 *   node scripts/push-folder.mjs "目录" --dry-run
 *
 * @module scripts/push-folder
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'

import { detectType } from '../netlify/functions/_lib/file-types.mjs'

/** 单文件上限（与服务端一致：分片上传时是 100MB，单次请求是 4MB）。 */
const MAX_FILE_BYTES = 100 * 1024 * 1024
/** 分片大小（必须 ≤4MB：Netlify 函数请求体 6MB）。 */
const CHUNK_SIZE = 4 * 1024 * 1024
/** 扫描时跳过的目录。 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv',
  '.idea', '.vscode', '.cache', '.npm', '.pnpm-store', 'dist', 'build',
  'target-build', 'dist-desktop', '$RECYCLE.BIN', 'System Volume Information',
])
/** 每次入库调用处理几份（服务端上限 10）。 */
const INGEST_BATCH = 5

/**
 * 解析参数。
 * @returns {object} 选项
 */
function parseArgs() {
  const args = process.argv.slice(2)
  const opts = {
    dir: '', token: '', base: 'https://r-database.netlify.app', root: '',
    dryRun: false, noIngest: false, limit: 0,
  }
  for (const a of args) {
    if (a === '--dry-run') opts.dryRun = true
    else if (a === '--no-ingest') opts.noIngest = true
    else if (a.startsWith('--token=')) opts.token = a.slice(8)
    else if (a.startsWith('--base=')) opts.base = a.slice(7).replace(/\/+$/, '')
    else if (a.startsWith('--root=')) opts.root = a.slice(7)
    else if (a.startsWith('--limit=')) opts.limit = Number(a.slice(8)) || 0
    else if (a.startsWith('-')) throw new Error(`未知参数：${a}`)
    else opts.dir = a
  }
  opts.token = (opts.token || process.env.ADMIN_TOKEN || '').trim()
  return opts
}

/**
 * 递归收集可入库的文件。
 *
 * @param {string} dir - 目录
 * @param {string} rootName - 相对路径的根名
 * @returns {Array<{abs:string, rel:string, name:string, size:number, type:string}>} 文件
 */
function collect(dir, rootName) {
  const out = []
  const skipped = { unsupported: 0, oversize: 0, noise: 0 }

  const walk = (cur) => {
    let entries
    try {
      entries = readdirSync(cur, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(cur, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full)
        continue
      }
      if (!e.isFile()) continue

      const lower = e.name.toLowerCase()
      if (lower === 'thumbs.db' || lower === 'desktop.ini' || lower === '.ds_store'
        || lower.startsWith('~$') || lower.endsWith('.tmp')) {
        skipped.noise += 1
        continue
      }

      const type = detectType(e.name)
      if (!type) {
        skipped.unsupported += 1
        continue
      }

      let size = 0
      try {
        size = statSync(full).size
      } catch {
        continue
      }
      if (size > MAX_FILE_BYTES) {
        skipped.oversize += 1
        continue
      }

      // 相对路径以目录名为根，与浏览器拖文件夹得到的一致
      const rel = `${rootName}/${relative(dir, full).replace(/\\/g, '/')}`
      out.push({ abs: full, rel, name: e.name, size, type })
    }
  }

  walk(dir)
  return { files: out, skipped }
}

/**
 * 上传一个文件（大文件自动分片）。
 *
 * @param {string} base - 站点地址
 * @param {string} token - ADMIN_TOKEN
 * @param {object} f - 文件描述
 * @returns {Promise<{status:number, data:object|null, error:string|null}>} 结果
 */
async function uploadOne(base, token, f) {
  const buf = readFileSync(f.abs)
  const headers = { 'X-Auth-Token': token, 'Content-Type': 'application/octet-stream' }

  // 小文件一次传完
  if (buf.length <= CHUNK_SIZE) {
    const q = new URLSearchParams({ name: f.name, path: f.rel })
    const res = await fetch(`${base}/api/v1/inbox?${q}`, { method: 'POST', headers, body: buf })
    return readResult(res)
  }

  // 大文件分片
  const uploadId = `push${Date.now()}${Math.floor(Math.random() * 1e6)}`
  const total = Math.ceil(buf.length / CHUNK_SIZE)
  for (let i = 0; i < total; i++) {
    const part = buf.subarray(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, buf.length))
    const q = new URLSearchParams({ uploadId, index: String(i), total: String(total), size: String(buf.length) })
    if (i === 0) {
      q.set('name', f.name)
      q.set('path', f.rel)
    }
    const res = await fetch(`${base}/api/v1/inbox/chunk?${q}`, { method: 'POST', headers, body: part })
    const r = await readResult(res)
    if (r.error) return r
  }
  const done = await fetch(`${base}/api/v1/inbox/chunk/complete?uploadId=${uploadId}`, {
    method: 'POST', headers: { 'X-Auth-Token': token },
  })
  return readResult(done)
}

/**
 * 读响应并归一化。
 * @param {Response} res - 响应
 * @returns {Promise<object>} 结果
 */
async function readResult(res) {
  let body = null
  const text = await res.text()
  try {
    body = JSON.parse(text)
  } catch {
    return { status: res.status, data: null, error: `HTTP ${res.status}（响应不是 JSON）` }
  }
  if (!body?.ok) {
    return { status: res.status, data: null, error: body?.error?.message ?? `HTTP ${res.status}` }
  }
  return { status: res.status, data: body.data, error: null }
}

/**
 * 触发服务端入库，直到暂存区清空。
 * @param {string} base - 站点
 * @param {string} token - ADMIN_TOKEN
 * @param {Function} log - 输出
 * @returns {Promise<object>} 统计
 */
async function runIngest(base, token, log) {
  const stats = { ingested: 0, duplicate: 0, failed: 0, rounds: 0 }

  for (let round = 0; round < 40; round++) {
    const res = await fetch(`${base}/api/v1/inbox/ingest`, {
      method: 'POST',
      headers: { 'X-Auth-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: INGEST_BATCH }),
    })
    const r = await readResult(res)
    if (r.error) {
      log(`  ✗ 入库接口报错：${r.error}`)
      break
    }
    stats.rounds += 1
    for (const x of r.data.results ?? []) {
      if (x.status === 'ingested') stats.ingested += 1
      else if (x.status === 'duplicate') stats.duplicate += 1
      else if (x.status !== 'missing') stats.failed += 1
    }
    log(`  · 第 ${round + 1} 轮：处理 ${r.data.processed} 份，剩余 ${r.data.remaining} 份`)
    if (r.data.total === 0 || r.data.remaining <= 0) break
  }
  return stats
}

async function main() {
  const opts = parseArgs()
  if (!opts.dir) {
    console.error('用法：node scripts/push-folder.mjs "目录" [--token=...] [--base=...] [--dry-run]')
    process.exit(1)
  }

  console.log('▸ 把本地目录推到线上资料库\n')
  console.log(`  目录      ${opts.dir}`)
  console.log(`  站点      ${opts.base}`)

  const rootName = opts.root || basename(opts.dir.replace(/[\\/]+$/, ''))
  const { files, skipped } = collect(opts.dir, rootName)
  const totalBytes = files.reduce((a, f) => a + f.size, 0)
  console.log(`  相对根    ${rootName}/`)
  console.log(`  可入库    ${files.length} 个 / ${(totalBytes / 1024 / 1024).toFixed(2)} MB`)
  console.log(`  跳过      不支持 ${skipped.unsupported} · 超限 ${skipped.oversize} · 系统文件 ${skipped.noise}\n`)

  if (files.length === 0) {
    console.log('  没有可上传的文件。\n')
    return
  }

  const byType = {}
  for (const f of files) byType[f.type] = (byType[f.type] ?? 0) + 1
  console.log('  类型分布  ' + Object.entries(byType).map(([t, n]) => `${t}×${n}`).join('  '))
  for (const f of files.slice(0, 5)) console.log(`    · ${f.rel}（${(f.size / 1024).toFixed(0)}KB）`)
  if (files.length > 5) console.log(`    … 另有 ${files.length - 5} 个`)
  console.log('')

  if (opts.dryRun) {
    console.log('  （--dry-run：只报告，不上传）\n')
    return
  }

  if (!opts.token) {
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(opts.base)
    if (!isLocal) {
      console.log('  ✗ 缺少 ADMIN_TOKEN（网站登录密码）\n')
      console.log('  这个脚本走的是网站的 admin 接口，只需要你自己的网站密码，')
      console.log('  不是 Netlify 的 Personal Access Token。两种给法：\n')
      console.log('    $env:ADMIN_TOKEN=\'你的密码\'; node scripts/push-folder.mjs "目录"')
      console.log('    node scripts/push-folder.mjs "目录" --token=你的密码\n')
      process.exit(1)
    }
    // 本地 dev-server 在未配置密码时直接给 admin，不必填令牌
    console.log('  （本地站点：dev 模式直接是 admin，不需要密码）\n')
  }

  const list = opts.limit > 0 ? files.slice(0, opts.limit) : files

  // ---- 上传 ----
  console.log(`【上传】${list.length} 个文件`)
  let okCount = 0
  let failCount = 0
  const failures = []
  const startedAt = Date.now()

  for (let i = 0; i < list.length; i++) {
    const f = list[i]
    try {
      const r = await uploadOne(opts.base, opts.token, f)
      if (r.error) {
        failCount += 1
        failures.push(`${f.rel}：${r.error}`)
      } else {
        okCount += 1
      }
    } catch (err) {
      failCount += 1
      failures.push(`${f.rel}：${err.message}`)
    }
    if ((i + 1) % 10 === 0 || i + 1 === list.length) {
      const pct = Math.round(((i + 1) / list.length) * 100)
      process.stdout.write(`\r  已上传 ${i + 1}/${list.length}（${pct}%）`)
    }
  }
  process.stdout.write('\n')
  const upMs = Date.now() - startedAt
  console.log(`  成功 ${okCount} · 失败 ${failCount}　耗时 ${(upMs / 1000).toFixed(1)}s`)
  for (const f of failures.slice(0, 8)) console.log(`  ✗ ${f}`)
  if (failures.length > 8) console.log(`  ✗ 另有 ${failures.length - 8} 个失败`)

  if (okCount === 0) {
    console.log('\n  一个都没传上去，先别急着入库。\n')
    process.exit(1)
  }

  // ---- 服务端入库 ----
  if (opts.noIngest) {
    console.log('\n  （--no-ingest：文件已进暂存区，没有入库）\n')
    return
  }

  console.log('\n【入库】由服务端抽取正文、分类打标、生成预览、更新索引')
  const ingestStarted = Date.now()
  const stats = await runIngest(opts.base, opts.token, (m) => console.log(m))
  const ingestMs = Date.now() - ingestStarted

  console.log(`\n  入库 ${stats.ingested} 份 · 重复跳过 ${stats.duplicate} 份 · 失败 ${stats.failed} 份`
    + `　耗时 ${(ingestMs / 1000).toFixed(1)}s`)

  // ---- 核对 ----
  try {
    const h = await (await fetch(`${opts.base}/api/v1/health`)).json()
    console.log(`  线上库现有 ${h.data.docCount} 份文档`)
  } catch {
    /* 核对失败不影响结论 */
  }

  console.log('\n────────────────────────────────')
  console.log(failCount === 0 && stats.failed === 0
    ? '  ✓ 全部完成。打开站点即可看到文档与「来源目录」'
    : '  ⚠ 有失败项，见上面列出的原因')
  console.log('')
  process.exit(failCount === 0 && stats.failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n出错：', err?.message ?? err)
  process.exit(1)
})
