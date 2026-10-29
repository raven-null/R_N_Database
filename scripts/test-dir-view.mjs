/**
 * 「按来源目录浏览」回归测试。
 *
 * ## 它守的是什么
 *
 * 这个库是扁平的（分类 + 标签 + 搜索），但真实资料是按文件夹整理的。
 * 目录能力靠两件事拼出来，两边都容易悄悄坏掉：
 *
 * 1. **派生规则**（`dirOf`）：`sourcePath` 是人给的字符串，形态五花八门 ——
 *    Windows 盘符、双反斜杠、`upload://`、Unix 绝对路径、没有目录的相对路径。
 *    推错一个字符，界面上就会多出 `E://学习//资料/` 这种目录，或者把
 *    不同盘的同名目录合并成一个。
 * 2. **前缀筛选**：点父目录要连带子目录，但 `E:/学习` 不能误伤 `E:/学习资料`。
 *
 * 纯函数部分不需要服务器；界面部分用 jsdom 跑真实页面。
 *
 * 用法：
 *   node scripts/dev-server.mjs
 *   node scripts/test-dir-view.mjs
 *
 * @module scripts/test-dir-view
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM, VirtualConsole } from 'jsdom'

import { dirOf, dirChain, dirMatches } from '../netlify/functions/_lib/source-dir.mjs'

const ROOT = process.cwd()
const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:8899'

const nodeFetch = globalThis.fetch.bind(globalThis)

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
 * 取 JSON。
 * @param {string} path - 路径
 * @returns {Promise<object>} data
 */
async function j(path) {
  const res = await nodeFetch(BASE + path)
  const body = await res.json()
  if (!body?.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
  return body.data
}

/* ============================================================
   纯函数：目录派生
   ============================================================ */

function testDirOf() {
  console.log('\n【派生规则：sourcePath → 目录】')

  const cases = [
    ['E:\\学习\\资料\\文库.pdf', 'E:/学习/资料', 'Windows 盘符路径'],
    ['E:\\\\学习\\\\资料\\\\双反斜杠.pdf', 'E:/学习/资料', '重复反斜杠要折叠'],
    // sourcePath 的契约是**文件路径**，末尾带分隔符属于越界输入。
    // 处理方式：先剥掉尾部斜杠，再把最后一段当文件名 ——
    // 这类输入会少一级目录，但绝不会冒出 `E:/学习/资料/` 这种带尾斜杠的假节点。
    ['E:\\学习\\资料\\末尾有分隔符\\', 'E:/学习/资料', '尾部斜杠被剥掉（不产生带尾斜杠的目录）'],
    ['E:\\只有一个文件.pdf', 'E:', '盘符根目录'],
    ['E:\\', 'E:', '只有盘符'],
    ['D:\\学习\\资料\\x.pdf', 'D:/学习/资料', '另一个盘不合并'],
    ['upload://资料/合同/2025/x.pdf', '上传/资料/合同/2025', '网页上传的相对路径'],
    ['upload://资料\\x.pdf', '上传/资料', '上传路径里的反斜杠'],
    ['upload://x.pdf', '上传', '直接传到根的文件'],
    ['/home/u/docs/a.pdf', '/home/u/docs', 'Unix 绝对路径保留前导斜杠'],
    ['/a.pdf', '/', 'Unix 根目录'],
    ['//nas/share/x.pdf', '/nas/share', 'UNC 路径'],
    ['a.pdf', '', '没有目录部分'],
    ['', '', '空来源'],
    [undefined, '', '缺来源'],
  ]

  for (const [input, want, why] of cases) {
    const got = dirOf(input)
    check(got === want, `${why}：${JSON.stringify(input)} → ${JSON.stringify(got)}`,
      got === want ? '' : `期望 ${JSON.stringify(want)}`)
  }

  console.log('\n【逐级切分与前缀匹配】')
  check(
    JSON.stringify(dirChain('E:/学习/资料')) === JSON.stringify(['E:', 'E:/学习', 'E:/学习/资料']),
    'dirChain 逐级正确',
    JSON.stringify(dirChain('E:/学习/资料')),
  )
  check(dirMatches('E:/学习/资料', ''), '未选目录时全部通过')
  check(dirMatches('E:/学习/资料', 'E:/学习'), '父目录含子目录')
  check(dirMatches('E:/学习', 'E:/学习'), '自己匹配自己')
  check(!dirMatches('E:/学习资料', 'E:/学习'), 'E:/学习 不误伤 E:/学习资料（前缀要带斜杠）')
  check(!dirMatches('D:/学习/资料', 'E:/学习'), '不同盘不匹配')
}

/* ============================================================
   接口：dir 字段
   ============================================================ */

async function testApi() {
  console.log('\n【接口：manifest 与列表都带 dir】')

  const manifest = await j('/api/v1/manifest')
  check(Array.isArray(manifest.docs), 'manifest 有 docs')
  check(
    manifest.docs.every((d) => typeof d.dir === 'string'),
    'manifest 每份文档都带 dir 字符串',
    manifest.docs.filter((d) => typeof d.dir !== 'string').map((d) => d.title).join(' | '),
  )
  const withDir = manifest.docs.filter((d) => d.dir)
  check(withDir.length === manifest.docs.length, `全部文档都推得出目录（${withDir.length}/${manifest.docs.length}）`)
  check(
    manifest.docs.every((d) => Array.isArray(dirChain(d.dir))),
    'dir 都能切成层级',
  )

  const list = await j('/api/v1/docs?limit=5')
  check(
    (list.items ?? []).every((it) => typeof it.dir === 'string'),
    '列表接口也带 dir',
  )

  // manifest 里的 dir 必须与当场重算的结果一致（避免存了派生值又不更新）
  const mismatch = manifest.docs.filter((d) => d.dir !== dirOf(d.sourcePath))
  check(mismatch.length === 0, 'dir 与 sourcePath 始终一致（读时算，不是存的）',
    mismatch.map((d) => `${d.title}: ${d.dir} ≠ ${dirOf(d.sourcePath)}`).join(' | '))

  return manifest
}

/* ============================================================
   界面：侧栏目录树
   ============================================================ */

/**
 * 在 jsdom 里打开列表页。
 * @returns {Promise<{dom:object, errors:string[]}>} 环境
 */
async function openListPage() {
  const errors = []
  const vc = new VirtualConsole()
  vc.on('jsdomError', (e) => errors.push(String(e?.message ?? e)))

  const dom = new JSDOM(readFileSync(join(ROOT, 'public', 'index.html'), 'utf8'), {
    url: `${BASE}/`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: vc,
  })
  const { window } = dom
  window.fetch = (input, init) => {
    const url = typeof input === 'string' && input.startsWith('/') ? BASE + input : input
    return nodeFetch(url, init)
  }
  window.Element.prototype.scrollIntoView = () => {}

  Object.assign(globalThis, {
    window,
    document: window.document,
    location: window.location,
    localStorage: window.localStorage,
  })
  globalThis.fetch = window.fetch
  globalThis.confirm = () => false

  await import(`../public/js/list.js?t=${Date.now()}`)

  const waitFor = async (fn, ms = 6000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await new Promise((r) => setTimeout(r, 50))
    }
    return false
  }
  await waitFor(() => window.document.querySelectorAll('.doc').length > 0)

  return { dom, window, errors }
}

async function testUi() {
  console.log('\n【界面：侧栏来源目录树】')

  const { dom, window, errors } = await openListPage()
  const d = window.document

  const section = [...d.querySelectorAll('.facet')]
    .find((s) => s.querySelector('h3')?.textContent.includes('来源目录'))
  check(Boolean(section), '侧栏有「来源目录」分区')

  const rows = section?.querySelectorAll('.dir-row') ?? []
  check(rows.length > 0, `目录树有 ${rows.length} 行`)

  const names = [...(section?.querySelectorAll('.dir-name') ?? [])].map((b) => b.textContent.trim())
  check(names.length > 0, `节点名：${names.slice(0, 6).join(' / ')}`)

  // 顶层默认展开：应当能直接看到盘符或「上传」
  const hasTop = names.some((n) => /^[A-Z]:/.test(n) || n.startsWith('上传'))
  check(hasTop, '顶层节点可见（盘符 / 上传）')

  // 点一个目录 → 列表被筛选，且选中的行高亮
  const target = [...(section?.querySelectorAll('.dir-name') ?? [])]
    .find((b) => (b.getAttribute('title') ?? '').split('/').length >= 2)
  if (!target) {
    check(false, '找不到可用于筛选的多级目录')
  } else {
    const dirValue = target.getAttribute('data-value')
    const before = d.querySelectorAll('.doc').length
    target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 350))

    const after = d.querySelectorAll('.doc').length
    const activeRow = d.querySelector('.dir-row.active')
    check(Boolean(activeRow), `点「${dirValue}」后有节点高亮`)
    check(
      after > 0 && after <= before,
      `筛选后剩下 ${after} 条（筛选前 ${before} 条）`,
    )

    // 列表行的来源目录也要显示出来
    const dirLabels = [...d.querySelectorAll('.doc-dir')].map((e) => e.getAttribute('title'))
    check(dirLabels.length === after, `每条结果都显示来源目录（${dirLabels.length}/${after}）`)
    check(
      dirLabels.every((t) => String(t) === dirValue || String(t).startsWith(`${dirValue}/`)),
      '显示的目录都在选中目录之下（前缀匹配正确）',
      dirLabels.slice(0, 3).join(' | '),
    )

    // 再点一次 = 取消筛选
    d.querySelector('.dir-row.active .dir-name')
      ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 350))
    check(d.querySelectorAll('.doc').length === before, '再点一次取消筛选，恢复全部')
  }

  check(errors.length === 0, '无 jsdom 报错', errors.join(' | '))
  dom.window.close()
}

async function main() {
  console.log('▸ R_N_Database 按来源目录浏览 · 回归测试')
  console.log(`  后端 ${BASE}\n`)

  testDirOf()

  try {
    const health = await j('/api/v1/health')
    console.log(`\n  存储 ${health.store.mode} / 文档 ${health.docCount} 份`)
    if (health.docCount === 0) {
      console.log('  ⚠ 库是空的，跳过接口与界面部分（先入一份文档再跑）\n')
    } else {
      await testApi()
      await testUi()
    }
  } catch (err) {
    console.error(`\n  无法连接开发服务器：${err.message}`)
    console.error('  请先运行：node scripts/dev-server.mjs\n')
    process.exit(1)
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
