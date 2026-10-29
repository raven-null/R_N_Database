/**
 * 备份导出测试：确认「一整个 zip 拿得到、解得开、内容对得上」。
 *
 * 备份是最不能出错的功能 —— 它出错的时候往往正是你要用它的时候。
 * 所以这里不测实现细节，只测**约定**：
 *
 *   · POST /api/v1/export 能生成，返回 exportId 与大小
 *   · GET  /api/v1/export/{id} 拿到的是合法 zip
 *   · zip 里有 manifest.json，且 docCount 与库里一致
 *   · 每份文档都有 docs/<id>.json，有原件的还有 files/<id>/<原名>
 *   · manifest 里记录的 sha256 与原件对得上（备份没串味）
 *
 * 需要先起开发服务器：npm run dev（端口 8899）。
 *
 * @module scripts/test-export
 */

import JSZip from 'jszip'
import { getDocsStore, STORES } from '../netlify/functions/_lib/store.mjs'

const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:8899'
const MARK = `EXPORT${Date.now()}`

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
 * @param {string} path - 路径
 * @param {object} [opts] - { method, body, headers }
 * @returns {Promise<Response>} 原始响应
 */
async function api(path, opts = {}) {
  return fetch(BASE + path, {
    method: opts.method ?? 'GET',
    headers: opts.headers,
    body: opts.body,
  })
}

/** 造一份文档，保证库里有东西可备份。 */
async function ensureOneDoc(ctx) {
  const list = await (await api('/api/v1/docs?limit=1')).json()
  if ((list?.data?.total ?? 0) > 0) return false

  const name = `${MARK}-note.md`
  const content = `# ${MARK}\n\n用于验证备份导出的临时文档。\n`
  const q = new URLSearchParams({ name, path: `备份测试/${name}` })
  const up = await api(`/api/v1/inbox?${q}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/markdown' },
    body: content,
  })
  const rec = (await up.json())?.data
  if (rec?.id) ctx.staged.push(rec.id)

  await api('/api/v1/inbox/ingest', { method: 'POST', body: JSON.stringify({ ids: [rec?.id] }) })
  const after = await (await api('/api/v1/docs?limit=5')).json()
  const doc = (after?.data?.items ?? []).find((d) => d.originalName === name)
  if (doc) ctx.created.push(doc.id)
  return true
}

async function main() {
  console.log('▸ 备份导出测试\n')

  const ctx = { staged: [], created: [], exports: [] }

  try {
    /* ---------- 前置 ---------- */
    const health = await api('/api/v1/health')
    if (health.status !== 200) {
      console.error(`  开发服务器没起来（${BASE}）。先跑 npm run dev\n`)
      process.exit(2)
    }
    const madeDoc = await ensureOneDoc(ctx)
    if (madeDoc) console.log('  （库里原本是空的，已临时造了一份文档）\n')

    /* ---------- 生成备份 ---------- */
    console.log('【生成】')
    const created = await api('/api/v1/export', { method: 'POST' })
    const createdBody = await created.json()
    check(created.status === 200, `POST /export 成功（HTTP ${created.status}）`,
      JSON.stringify(createdBody).slice(0, 300))

    const info = createdBody?.data ?? {}
    if (info.exportId) ctx.exports.push(info.exportId)
    check(Boolean(info.exportId), `拿到 exportId（${info.exportId}）`)
    check((info.size ?? 0) > 0, `返回了 zip 大小（${info.size} 字节）`)
    check((info.docCount ?? 0) > 0, `返回了文档份数（${info.docCount}）`)
    check(info.downloadUrl === `/api/v1/export/${info.exportId}`, '下载地址与 exportId 一致')

    const wrongMethod = await api('/api/v1/export')
    check(wrongMethod.status === 400, `GET /export（不带 id）被拒（HTTP ${wrongMethod.status}）`)

    /* ---------- 下载并解包 ---------- */
    console.log('\n【下载与内容】')
    const dl = await api(info.downloadUrl)
    check(dl.status === 200, `下载成功（HTTP ${dl.status}）`)
    check(String(dl.headers.get('content-type') ?? '').includes('zip'),
      `Content-Type 是 zip（${dl.headers.get('content-type')}）`)
    check(String(dl.headers.get('cache-control') ?? '').includes('no-store'),
      '备份件禁止缓存（no-store）')

    const buf = Buffer.from(await dl.arrayBuffer())
    check(buf.length === info.size, `下载大小与报告一致（${buf.length}）`)

    const zip = await JSZip.loadAsync(buf)
    // zip.files 里混着目录条目（files/、files/<id>/），断言只看真实文件
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir)
    check(names.includes('manifest.json'), 'zip 根目录有 manifest.json')

    const manifest = JSON.parse(await zip.file('manifest.json').async('string'))
    check(manifest.docCount === info.docCount, `manifest.docCount 与响应一致（${manifest.docCount}）`)
    check(Array.isArray(manifest.docs) && manifest.docs.length === manifest.docCount,
      'manifest.docs 条数与 docCount 一致')

    const metaFiles = names.filter((n) => n.startsWith('docs/') && n.endsWith('.json'))
    check(metaFiles.length === manifest.docCount, `每份文档都有 docs/<id>.json（${metaFiles.length} 份）`)

    const fileEntries = names.filter((n) => n.startsWith('files/'))
    const expectedFiles = manifest.docs.filter((d) => d.hasFile).length
    check(fileEntries.length === expectedFiles,
      `原件份数对得上（${fileEntries.length} / 期望 ${expectedFiles}）`)

    // 抽一份原件核对 sha256：备份里装的必须还是原来那份
    const withFile = manifest.docs.find((d) => d.hasFile && d.sha256)
    if (withFile) {
      const entry = fileEntries.find((n) => n.startsWith(`files/${withFile.id}/`))
      check(Boolean(entry), `原件存放在 files/${withFile.id}/ 下`)
      if (entry) {
        const bytes = await zip.file(entry).async('nodebuffer')
        const { createHash } = await import('node:crypto')
        const got = createHash('sha256').update(bytes).digest('hex')
        check(got === withFile.sha256, '原件 sha256 与元数据一致（备份没串味）',
          `${got} ≠ ${withFile.sha256}`)
      }
    } else {
      check(true, '（库里没有可对比的原件，跳过 sha256 校验）')
    }

    const textEntries = names.filter((n) => n.startsWith('text/'))
    check(textEntries.length > 0, `正文也一起打包了（${textEntries.length} 份）`)

    /* ---------- 过期与非法 id ---------- */
    console.log('\n【边界】')
    const bad = await api('/api/v1/export/not-a-real-id-0000')
    check(bad.status === 404 || bad.status === 400, `不存在的 id 被拒（HTTP ${bad.status}）`)
    const evil = await api('/api/v1/export/..%2f..%2fetc')
    check(evil.status === 400 || evil.status === 404, `路径穿越被拒（HTTP ${evil.status}）`)
  } finally {
    /* ---------- 清理 ---------- */
    let removed = 0
    for (const id of ctx.created) {
      const r = await api(`/api/v1/docs/${id}`, { method: 'DELETE' })
      if (r.status === 200) removed += 1
    }
    for (const id of ctx.staged) {
      await api(`/api/v1/inbox/${id}`, { method: 'DELETE' }).catch(() => {})
    }
    // 导出件直接按存储 key 清，省得留一堆 zip 在本地库
    if (ctx.exports.length > 0) {
      const store = await getDocsStore(STORES.EXPORTS)
      for (const id of ctx.exports) {
        await store.delete(`export/${id}.zip`).catch(() => {})
        await store.delete(`export/${id}.json`).catch(() => {})
      }
    }
    if (removed) console.log(`\n  已清理 ${removed} 份临时文档与 ${ctx.exports.length} 份导出件`)
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
