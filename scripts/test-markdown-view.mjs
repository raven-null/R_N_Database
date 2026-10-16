/**
 * Markdown 双视图回归测试。
 *
 * 验证「文本（渲染）」与「源码（代码格式）」两种视图：
 *   1. 渲染视图：Markdown 语法被转成 HTML（标题/表格/代码块），且不含行号
 *   2. 源码视图：等宽 + 行号，Markdown 语法**不被渲染**（能看到 # 和 ```）
 *   3. ★ 源码视图读的是**原件**而不是抽取的正文 ——
 *      抽取时 cleanText 会压缩空格、去掉行首缩进、合并空行，
 *      若用它做源码视图，代码块与列表层级会失真。这是最容易埋错的地方。
 *
 * 前提：开发服务器在跑。
 *
 * 用法：
 *   node scripts/dev-server.mjs
 *   node scripts/test-markdown-view.mjs
 *
 * @module scripts/test-markdown-view
 */

const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:8899'

const FENCE = '```'

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
 * @returns {Promise<object>} 响应体
 */
async function j(path) {
  const res = await fetch(BASE + path)
  const body = await res.json()
  if (!body?.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
  return body.data
}

/**
 * 取文本。
 * @param {string} path - 路径
 * @returns {Promise<string>} 响应文本
 */
async function text(path) {
  const res = await fetch(BASE + path)
  return res.text()
}

/**
 * HTML 转义（与服务端 escHtml 一致，用于在原文档里定位行）。
 * @param {string} s - 原文
 * @returns {string} 转义结果
 */
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

async function main() {
  console.log('▸ R_N_Database Markdown 双视图测试')
  console.log(`  后端 ${BASE}\n`)

  const manifest = await j('/api/v1/manifest')
  const allMd = manifest.docs.filter((d) => d.type === 'md')
  const upgraded = allMd.filter((d) => d.previewKind === 'markdown')

  console.log(`  Markdown 文档 ${allMd.length} 份，其中已生成渲染件 ${upgraded.length} 份\n`)
  check(allMd.length > 0, '库中有 Markdown 文档')
  check(upgraded.length === allMd.length, '所有 Markdown 都已是 markdown 预览类型',
    `未升级：${allMd.filter((d) => d.previewKind !== 'markdown').map((d) => d.title).slice(0, 5).join(', ')}`)

  if (upgraded.length === 0) {
    console.log('\n  没有可测的文档\n')
    process.exit(1)
  }

  // ---- 挑一份带围栏代码块 + 缩进的文档，覆盖面最广 ----
  // ★ 必须按**原件**挑，不能按抽取正文挑：
  // 抽取时 cleanText 已经把行首缩进去掉了，按它挑永远挑不到带缩进的文件
  // （第一版就是这么写的，结果永远选中一个 26 行的小文件）。
  let target = null
  let original = ''
  const scanLimit = Math.min(upgraded.length, 40)

  for (let i = 0; i < scanLimit; i++) {
    const d = upgraded[i]
    const raw = await text(`/api/v1/docs/${d.id}/file`).catch(() => '')
    if (raw.includes(FENCE) && /^\s{2,}\S/m.test(raw)) {
      target = d
      original = raw
      break
    }
  }
  if (!target) {
    target = upgraded[0]
    original = await text(`/api/v1/docs/${target.id}/file`)
    console.log('  ⚠ 前 40 份里没找到同时含围栏代码块与前导缩进的文档，退化用第一份')
  }

  console.log(`  测试文档：${target.title}（${target.id}）`)
  console.log(`  原件 ${original.length} 字，${original.split('\n').length} 行\n`)

  const render = await text(`/api/v1/docs/${target.id}/preview?mode=render`)
  const source = await text(`/api/v1/docs/${target.id}/preview?mode=source`)

  /* ---------- 渲染视图 ---------- */
  console.log('【渲染视图 · 文本模式】')
  check(/<h[1-6][\s>]/.test(render), 'Markdown 标题已转成 HTML 标题')
  check(render.includes('<article class="doc">'), '包在文档容器里')
  check(!render.includes('class="ln"'), '不含源码行号')
  // 原件里若有围栏代码块，渲染后应出现 <pre>
  if (original.includes(FENCE)) {
    check(render.includes('<pre>'), '围栏代码块渲染成了 <pre>')
    check(!render.includes(FENCE), '渲染视图里看不到 ``` 标记')
  }
  if (/^\|.*\|/m.test(original)) {
    check(render.includes('<table>'), '表格渲染成了 <table>')
  }

  /* ---------- 源码视图 ---------- */
  console.log('\n【源码视图 · 代码格式】')
  const lineNoCount = (source.match(/class="ln"/g) ?? []).length
  check(lineNoCount > 0, `带行号（共 ${lineNoCount} 行）`)
  check(!/<h[1-6][\s>]/.test(source), 'Markdown 语法**未被渲染**（不该出现 HTML 标题）')
  if (original.includes(FENCE)) {
    check(source.includes('```'), '源码里能看到 ``` 标记本身')
  }
  check(source.includes('class="src"'), '使用等宽源码容器')

  /* ---------- 行号与实际行数是否对得上 ---------- */
  const origLines = original.split('\n').length
  check(lineNoCount === origLines, `行号数量与原件行数一致（${lineNoCount} / ${origLines}）`)

  /* ---------- ★ 最关键：源码必须保留原始缩进 ---------- */
  console.log('\n【关键：源码保真度】')
  const indentedLines = original.split('\n').filter((l) => /^\s{2,}\S/.test(l))
  check(indentedLines.length > 0, `原件里有 ${indentedLines.length} 行带前导缩进`)

  if (indentedLines.length > 0) {
    // 逐行找，统计能原样命中的比例
    let hit = 0
    for (const line of indentedLines.slice(0, 50)) {
      if (source.includes(`>${escHtml(line)}<`)) hit += 1
    }
    const sample = indentedLines.slice(0, 50).length
    check(hit === sample,
      `带缩进的行在源码页里原样可见（${hit}/${sample}）`,
      `样例：${JSON.stringify(indentedLines[0].slice(0, 60))}`)

    // 反证：抽取的正文是否已经破坏了缩进（说明我们确实避开了它）
    const textBody = (await j(`/api/v1/docs/${target.id}/text`)).pages.join('\n')
    const textIndented = textBody.split('\n').filter((l) => /^\s{2,}\S/.test(l)).length
    console.log(`  （对照：抽取正文里带缩进的行只剩 ${textIndented} 行 —— 可见 cleanText 确实会破坏缩进）`)
  }

  /* ---------- 两种视图必须不同 ---------- */
  console.log('\n【两种视图确实不同】')
  check(render !== source, '渲染件与源码页内容不同')
  check(!render.includes('class="ln"') && source.includes('class="ln"'),
    '行号只出现在源码视图')

  /* ---------- 非 Markdown 不应带 mode ---------- */
  const pdf = manifest.docs.find((d) => d.type === 'pdf')
  if (pdf) {
    const res = await fetch(`${BASE}/api/v1/docs/${pdf.id}/preview?mode=source`)
    const ct = res.headers.get('content-type') ?? ''
    check(res.status === 200 && ct.includes('pdf'),
      `PDF 带 mode 参数不受影响（仍返回 PDF，${ct}）`)
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
