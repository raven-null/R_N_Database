/**
 * doctor：检查「真相层 / 派生层 / 索引层」是否自洽，并给出可直接执行的修复建议。
 *
 * ## 为什么需要它
 *
 * 这个库这三个月的事故有一个共同形状：**某一步悄悄失败了，但没有任何地方
 * 会告诉你**。入库时索引写失败 → 文档躺在 META 里而列表上没有；删文档时
 * 正文先删了 → 索引里留下摘不掉的词条；并发删除 → 丢一次更新。
 * 每次都要靠人肉翻 API 才发现。
 *
 * doctor 把这些不变式写成机器检查：
 *
 *   ① 每份 META 都在 manifest 里（否则"文档存在但列表看不到"）
 *   ② manifest 里的每份都还有 META（否则"列表里的文档点开 404"）
 *   ③ 每份都有 visibility（否则线上对访客隐身）
 *   ④ 抓到的正文与 index-meta 的 docCount 对得上
 *   ⑤ 暂存区没有积压（有积压说明入库中断过）
 *
 * ## 两种模式
 *
 *   node scripts/doctor.mjs                      直接读本机 .local-data
 *   node scripts/doctor.mjs --base=<站点> --token=密码   读线上（只走 API）
 *
 * `--fix` 会调用 `/api/v1/index/repair` 重建索引与清单；其余问题只报告，
 * 因为「自动删数据」比「留着一个不一致」更危险。
 *
 * @module scripts/doctor
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()

/* ============================================================
   参数
   ============================================================ */
/**
 * 解析命令行参数。
 * @returns {object} { base, token, fix, json }
 */
function parseArgs() {
  const opts = { base: '', token: '', fix: false, json: false }
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--base=')) opts.base = a.slice(7).replace(/\/+$/, '')
    else if (a.startsWith('--token=')) opts.token = a.slice(8)
    else if (a === '--fix') opts.fix = true
    else if (a === '--json') opts.json = true
  }
  // 从 .env 兜底读，免得每次手打令牌
  if (!opts.token && existsSync(join(ROOT, '.env'))) {
    const m = readFileSync(join(ROOT, '.env'), 'utf8').match(/^ADMIN_TOKEN\s*=\s*(.+)$/m)
    if (m) opts.token = m[1].trim().replace(/^["']|["']$/g, '')
  }
  return opts
}

/* ============================================================
   本地模式
   ============================================================ */
/**
 * 直接读本地存储做检查。
 * @returns {Promise<object[]>} 检查项列表
 */
async function runLocal() {
  const { getDocsStore, STORES } = await import('../netlify/functions/_lib/store.mjs')

  const metaStore = await getDocsStore(STORES.META)
  const indexStore = await getDocsStore(STORES.INDEX)
  const inboxStore = await getDocsStore(STORES.INBOX)

  /** 翻页读全部 key。 */
  const listAll = async (store, prefix = '') => {
    const keys = []
    let cursor
    for (let i = 0; i < 40; i++) {
      const page = await store.list({ prefix, limit: 500, cursor })
      for (const b of page.blobs ?? []) keys.push(b.key)
      cursor = page.nextCursor ?? page.cursor
      if (!cursor) break
    }
    return keys
  }

  const metaKeys = await listAll(metaStore)
  const metas = []
  for (const k of metaKeys) {
    const m = await metaStore.get(k, { type: 'json' }).catch(() => null)
    if (m?.id) metas.push(m)
  }

  const manifest = (await indexStore.get('docs', { type: 'json' }).catch(() => null)) ?? []
  const indexMeta = await indexStore.get('index-meta', { type: 'json' }).catch(() => null)
  const inboxCount = (await listAll(inboxStore)).length

  const metaIds = new Set(metas.map((m) => m.id))
  const manifestIds = new Set(manifest.map((d) => d.id))

  const missingFromManifest = metas.filter((m) => !manifestIds.has(m.id))
  const orphanInManifest = manifest.filter((d) => !metaIds.has(d.id))
  const noVisibility = metas.filter((m) => m.visibility !== 'public' && m.visibility !== 'private')
  const privateCount = metas.filter((m) => m.visibility === 'private').length

  return [
    {
      id: 'meta',
      label: '真相层（元数据）',
      ok: true,
      detail: `${metas.length} 份`,
    },
    {
      id: 'manifest',
      label: '清单与元数据一致',
      ok: missingFromManifest.length === 0 && orphanInManifest.length === 0,
      detail: missingFromManifest.length === 0 && orphanInManifest.length === 0
        ? `清单 ${manifest.length} 份，与元数据一一对应`
        : `清单 ${manifest.length} / 元数据 ${metas.length}`
        + (missingFromManifest.length ? `；只在元数据里：${missingFromManifest.slice(0, 5).map((m) => m.id).join(' ')}` : '')
        + (orphanInManifest.length ? `；只在清单里：${orphanInManifest.slice(0, 5).map((m) => m.id).join(' ')}` : ''),
      fixable: 'POST /api/v1/index/repair（重建清单与索引）',
    },
    {
      id: 'visibility',
      label: '可见性字段齐全（缺了访客看不见）',
      ok: noVisibility.length === 0,
      detail: noVisibility.length === 0
        ? `公开 ${metas.length - privateCount} / 私有 ${privateCount}`
        : `${noVisibility.length} 份没有 visibility：${noVisibility.slice(0, 5).map((m) => m.id).join(' ')}`,
      fixable: 'POST /api/v1/index/repair（会补写为 public）',
    },
    {
      id: 'index',
      label: '索引元信息',
      ok: Boolean(indexMeta) && Number(indexMeta.docCount) === metas.length,
      detail: indexMeta
        ? `index-meta.docCount=${indexMeta.docCount}，实际 ${metas.length}`
        : '没有 index-meta（索引从未初始化）',
      fixable: 'POST /api/v1/index/repair',
    },
    {
      id: 'inbox',
      label: '暂存区无积压',
      ok: inboxCount === 0,
      detail: inboxCount === 0 ? '空' : `${inboxCount} 份未入库（入库中途失败过）`,
      fixable: '在网页里点「立即入库」',
    },
  ]
}

/* ============================================================
   线上模式（只走 HTTP API）
   ============================================================ */
/**
 * 通过 API 检查线上库。
 * @param {object} opts - 参数
 * @returns {Promise<object[]>} 检查项列表
 */
async function runRemote(opts) {
  const headers = opts.token ? { 'X-Auth-Token': opts.token } : {}
  const get = async (path) => {
    const res = await fetch(opts.base + path, { headers })
    const text = await res.text()
    let body = null
    try { body = JSON.parse(text) } catch { /* 非 JSON */ }
    return { status: res.status, body }
  }

  const health = await get('/api/v1/health')
  if (health.status !== 200) {
    return [{ id: 'health', label: '站点可达', ok: false, detail: `HTTP ${health.status}` }]
  }
  const h = health.body?.data ?? {}

  const manifest = await get('/api/v1/manifest')
  const docCount = manifest.body?.data?.docCount ?? null
  const taxonomy = await get('/api/v1/taxonomy')
  const hasTaxonomy = Array.isArray(taxonomy.body?.data?.categories) && taxonomy.body.data.categories.length > 0

  const inbox = await get('/api/v1/inbox?limit=1')
  const inboxTotal = inbox.status === 200 ? (inbox.body?.data?.total ?? 0) : null

  return [
    {
      id: 'health',
      label: '站点可达',
      ok: true,
      detail: `store=${h.store?.mode} ready=${h.store?.ready} build=${h.build?.commit?.slice(0, 7) ?? '?'}`,
    },
    {
      id: 'build',
      label: '构建信息可读（能确认线上版本）',
      ok: Boolean(h.build?.commit),
      detail: h.build
        ? `${h.build.commit.slice(0, 7)} @ ${h.build.builtAt}（Node ${h.build.node}）`
        : 'health 里没有 build 字段 —— 函数是旧的',
    },
    {
      id: 'count',
      label: '健康检查与清单一致',
      ok: h.docCount === docCount,
      detail: `health.docCount=${h.docCount} / manifest=${docCount}`,
      fixable: 'POST /api/v1/index/repair',
    },
    {
      id: 'taxonomy',
      label: '分类词表可用',
      ok: hasTaxonomy,
      detail: hasTaxonomy ? `${taxonomy.body.data.categories.length} 类` : '词表为空',
      fixable: 'POST /api/v1/index/repair（会写回内置词表）',
    },
    {
      id: 'inbox',
      label: '暂存区无积压',
      ok: inboxTotal === 0,
      detail: inboxTotal === null ? '无法读取（需要 admin 令牌）' : `${inboxTotal} 份未入库`,
      fixable: '在网页里点「立即入库」',
    },
  ]
}

/* ============================================================
   主流程
   ============================================================ */
async function main() {
  const opts = parseArgs()
  const remote = Boolean(opts.base)

  if (!opts.json) {
    console.log('▸ 资料库体检\n')
    console.log(`  模式      ${remote ? `线上 ${opts.base}` : '本地 .local-data'}`)
    console.log(`  权限      ${opts.token ? '已带 admin 令牌' : '未带令牌（部分检查可能失败）'}\n`)
  }

  const checks = remote ? await runRemote(opts) : await runLocal()
  const bad = checks.filter((c) => !c.ok)

  if (opts.json) {
    console.log(JSON.stringify({ mode: remote ? 'remote' : 'local', checks, ok: bad.length === 0 }, null, 2))
  } else {
    for (const c of checks) {
      console.log(`  ${c.ok ? '✓' : '✗'} ${c.label}`)
      console.log(`      ${c.detail}`)
    }
  }

  if (bad.length > 0 && !opts.json) {
    console.log('\n  建议的修复：')
    for (const c of bad) {
      if (c.fixable) console.log(`    · ${c.label} → ${c.fixable}`)
    }
  }

  // --fix：只做一件事 —— 重建清单与索引（幂等，且不会删任何数据）
  if (opts.fix && bad.length > 0) {
    if (remote || opts.token) {
      const url = (opts.base || 'http://127.0.0.1:8899') + '/api/v1/index/repair'
      if (!opts.json) console.log(`\n▸ 正在重建索引：POST ${url}`)
      const res = await fetch(url, { method: 'POST', headers: { 'X-Auth-Token': opts.token } })
      const text = await res.text()
      if (!opts.json) console.log(`  HTTP ${res.status}  ${text.slice(0, 300)}`)
    } else if (!opts.json) {
      console.log('\n  ⚠ 本地模式没有 HTTP 端口，重建请用：npm run reindex')
    }
  }

  if (!opts.json) {
    console.log('')
    console.log(bad.length === 0 ? '  ✓ 全部自洽' : `  ✗ ${bad.length} 项不一致`)
    console.log('')
  }

  process.exit(bad.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n体检脚本自身出错：', err?.message ?? err)
  process.exit(2)
})
