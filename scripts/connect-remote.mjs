/**
 * 把本地脚本接到线上 Netlify 库（一次性配置 + 连通性自检）。
 *
 * ## 为什么需要这一步
 *
 * 入库脚本要从**这台机器**直接写 Netlify Blobs。函数内部读写 Blobs 是
 * Netlify 自动注入凭据的，零配置；但外部脚本不行 —— 必须出示
 * Netlify 的 Personal Access Token（`nfp_...`）。
 *
 * 而且光有令牌还不够，还得知道**写哪个站点**（`SITE_ID`）。
 * 这个脚本把两件事一次做完：
 *   1. 用令牌查 API，找出 `r-database` 的站点 id，写进 `.env`
 *   2. 真的做一次远端读写往返，证明这条路通（而不是"看起来配好了"）
 *
 * ## 注意区分两个令牌（最容易搞混的地方）
 *
 *   ADMIN_TOKEN           我们自己的网站登录密码，Netlify 不认识它
 *   NETLIFY_ACCESS_TOKEN  Netlify 签发的全站钥匙，脚本靠它访问 Blobs
 *
 * 令牌只在本地 `.env`（已被 .gitignore 忽略），**绝不写进 Netlify
 * 的环境变量**，也绝不打进日志。
 *
 * 用法：
 *   node scripts/connect-remote.mjs                    # 自动找 r-database
 *   node scripts/connect-remote.mjs --site=r-database  # 指定站点名
 *   node scripts/connect-remote.mjs --list             # 只列出账号下的站点
 *
 * @module scripts/connect-remote
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { loadEnv } from './env.mjs'
import { probeStore, getDocsStore, STORES, resolveStoreMode } from '../netlify/functions/_lib/store.mjs'

const ROOT = process.cwd()
const ENV_FILE = join(ROOT, '.env')
const API = 'https://api.netlify.com/api/v1'

/**
 * 读令牌（本机环境变量优先，其次 .env）。
 *
 * 两个名字都认：项目自己用 `NETLIFY_ACCESS_TOKEN`，
 * Netlify CLI 用 `NETLIFY_AUTH_TOKEN`，用户可能只知道后者。
 *
 * @returns {string} 令牌
 */
function readToken() {
  return String(
    process.env.NETLIFY_ACCESS_TOKEN
    || process.env.NETLIFY_BLOBS_TOKEN
    || process.env.NETLIFY_AUTH_TOKEN
    || '',
  ).trim()
}

/**
 * 调 Netlify API。
 * @param {string} path - 路径
 * @param {string} token - 令牌
 * @returns {Promise<any>} 结果
 */
async function api(path, token) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status === 401) throw new Error('令牌无效或已过期（Netlify 返回 401）')
  if (!res.ok) throw new Error(`Netlify API HTTP ${res.status}：${(await res.text()).slice(0, 200)}`)
  return res.json()
}

/**
 * 把 SITE_ID 写进 .env（保留原有注释与顺序）。
 * @param {string} siteId - 站点 id
 * @returns {string} 说明
 */
function writeSiteId(siteId) {
  if (!existsSync(ENV_FILE)) {
    writeFileSync(ENV_FILE, `SITE_ID=${siteId}\n`, 'utf8')
    return '新建 .env 并写入'
  }
  const raw = readFileSync(ENV_FILE, 'utf8')
  const next = /^\s*SITE_ID\s*=.*$/m.test(raw)
    ? raw.replace(/^\s*SITE_ID\s*=.*$/m, `SITE_ID=${siteId}`)
    : `${raw.replace(/\s*$/, '')}\nSITE_ID=${siteId}\n`
  writeFileSync(ENV_FILE, next, 'utf8')
  return /^\s*SITE_ID\s*=.*$/m.test(raw) ? '已更新 .env 里的 SITE_ID' : '已追加 SITE_ID 到 .env'
}

async function main() {
  const args = process.argv.slice(2)
  const listOnly = args.includes('--list')
  const siteArg = (args.find((a) => a.startsWith('--site=')) ?? '').slice(7).trim()

  console.log('▸ 渡·资·集 连接线上库\n')

  const env = loadEnv()
  if (env.loaded) console.log(`  已读取 .env（${env.keys.length} 个键）`)

  const token = readToken()
  if (!token) {
    console.log('  ✗ 没有找到 Netlify 令牌\n')
    console.log('  这个脚本需要的是 **Netlify 的 Personal Access Token**，')
    console.log('  不是网站的登录密码 ADMIN_TOKEN —— 两者完全不同：\n')
    console.log('    ADMIN_TOKEN           你自己起的网站密码，Netlify 不认识它')
    console.log('    NETLIFY_ACCESS_TOKEN  Netlify 签发的全站钥匙，脚本靠它访问 Blobs\n')
    console.log('  拿法：https://app.netlify.com/user/applications')
    console.log('        → Personal access tokens → New access token（nfp_ 开头）\n')
    console.log('  然后写进 .env：')
    console.log('    NETLIFY_ACCESS_TOKEN=nfp_...\n')
    process.exit(1)
  }
  // 只说长度，不打印令牌的任何片段 —— 日志里不该出现密钥
  console.log(`  令牌　   已提供（${token.length} 字符）`)

  // ---- 列账号下的站点 ----
  let sites
  try {
    sites = await api('/sites?per_page=100', token)
  } catch (err) {
    console.error(`\n  ✗ 查询站点失败：${err.message}`)
    process.exit(1)
  }
  console.log(`  账号下    ${sites.length} 个站点`)

  const wanted = siteArg || 'r-database'
  const pick = sites.find((s) => s.name === wanted)
    || sites.find((s) => String(s.default_domain ?? '').startsWith(`${wanted}.`))
    || sites.find((s) => String(s.custom_domain ?? '') === wanted)
    || sites.find((s) => String(s.name ?? '').includes(wanted))

  if (listOnly || !pick) {
    console.log('\n  可用站点：')
    for (const s of sites) {
      const mark = pick && s.id === pick.id ? ' ← 匹配' : ''
      console.log(`    ${String(s.name).padEnd(28)} ${s.id}  ${s.default_domain ?? ''}${mark}`)
    }
    if (!pick) {
      console.log(`\n  ✗ 没找到名字里含「${wanted}」的站点。`)
      console.log('    请用 --site=<站点名> 指定，或从上面复制站点 id 填进 .env 的 SITE_ID。\n')
      process.exit(1)
    }
    console.log('')
    return
  }

  console.log(`  匹配到    ${pick.name}（${pick.default_domain ?? '无域名'}）`)
  console.log(`  站点 id   ${pick.id}`)
  console.log(`  ${writeSiteId(pick.id)}\n`)

  // ---- 真的做一次远端读写往返 ----
  process.env.DOCS_STORE_MODE = 'remote'
  process.env.SITE_ID = pick.id
  process.env.NETLIFY_ACCESS_TOKEN = token
  console.log(`  存储模式  ${resolveStoreMode()}`)

  const probe = await probeStore()
  if (!probe.ready) {
    console.log(`\n  ✗ 远端读写不通：${probe.error}`)
    console.log('    常见原因：令牌没有这个站点的权限，或站点未开启 Netlify Blobs。\n')
    process.exit(1)
  }
  console.log('  ✓ 远端读写往返成功（真的写了再读回来，不是"看起来配好了"）')

  // ---- 顺手看一眼暂存区里有没有待处理的文件 ----
  try {
    const inbox = await getDocsStore(STORES.INBOX)
    const listed = await inbox.list({ prefix: 'meta/', limit: 500 })
    const items = []
    for (const blob of listed.blobs ?? []) {
      const m = await inbox.get(blob.key, { type: 'json' }).catch(() => null)
      if (m) items.push(m)
    }
    const files = await inbox.list({ prefix: 'file/', limit: 10 })
    console.log(`\n  线上暂存区：${items.length} 份待入库，${(files.blobs ?? []).length} 个原件`)
    for (const it of items.slice(0, 10)) {
      console.log(`    · ${it.relativePath || it.originalName}  ${(it.size / 1024 / 1024).toFixed(1)}MB`)
    }
    if (items.length === 0) console.log('    （空）')
  } catch (err) {
    console.log(`\n  （读暂存区失败，不影响入库：${err.message}）`)
  }

  console.log('\n────────────────────────────────')
  console.log('  ✓ 已接上线上库。接下来可以：')
  console.log('      $env:DOCS_STORE_MODE=\'remote\'; node scripts/ingest.mjs "目录"')
  console.log('      $env:DOCS_STORE_MODE=\'remote\'; node scripts/process-pending.mjs')
  console.log('')
}

main().catch((err) => {
  console.error('\n连接失败：', err?.message ?? err)
  process.exit(1)
})
