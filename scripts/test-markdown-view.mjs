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
 * 测试文档**自己造**（标题 + 列表 + 表格 + 围栏代码块 + 前导缩进全都有），
 * 跑完即删。早先的版本从库里挑一份 Markdown，一旦清空测试数据
 * 整个测试就再也跑不起来了。
 *
 * 前提：开发服务器在跑。
 *
 * 用法：
 *   node scripts/dev-server.mjs
 *   node scripts/test-markdown-view.mjs
 *
 * @module scripts/test-markdown-view
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { testChildEnv } from './lib/test-env.mjs'

const ROOT = process.cwd()
const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:8899'

const FENCE = '```'

/** 测试文档的独特标记（顺带用于收尾清理）。 */
const MARK = `RNDBMD${Date.now()}`

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

/**
 * 跑一次入库（子进程）。
 * @param {string} file - 文件路径
 * @returns {Promise<number>} 退出码
 */
function ingest(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'scripts', 'ingest.mjs'), file, '--no-ai'], {
      cwd: ROOT,
      stdio: 'ignore',
      env: testChildEnv(),
    })
    child.on('error', reject)
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

/**
 * 造一份「语法全覆盖」的 Markdown 夹具。
 * @returns {string} Markdown 原文
 */
function buildFixture() {
  return [
    `# ${MARK} Markdown 夹具`,
    '',
    '这是 Markdown 双视图测试用的临时文档，覆盖标题、列表、表格与代码块。',
    '',
    '## 二级标题',
    '',
    '- 列表项一',
    '  - 嵌套列表项（两个空格缩进）',
    '- 列表项二',
    '',
    '| 列 A | 列 B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    `${FENCE}python`,
    'def add(a, b):',
    '    total = a + b',
    '    return total',
    FENCE,
    '',
    '  这一行有两个前导空格，用来验证源码视图是否保住了原始缩进。',
    '',
  ].join('\n')
}

async function main() {
  console.log('▸ R_N_Database Markdown 双视图测试')
  console.log(`  后端 ${BASE}\n`)

  const manifest = await j('/api/v1/manifest')
  const allMd = manifest.docs.filter((d) => d.type === 'md')

  // 全库不变量：所有 Markdown 都该有渲染件。库为空时这条无从验证，跳过。
  if (allMd.length > 0) {
    const notUpgraded = allMd.filter((d) => d.previewKind !== 'markdown')
    check(notUpgraded.length === 0, `库里 ${allMd.length} 份 Markdown 都已是 markdown 预览类型`,
      `未升级：${notUpgraded.map((d) => d.title).slice(0, 5).join(', ')}`)
  } else {
    check(true, '（库里暂无 Markdown，跳过全库不变量检查）')
  }

  // ---- 造夹具并入库 ----
  const workDir = mkdtempSync(join(tmpdir(), 'rndb-md-'))
  const file = join(workDir, `${MARK}-note.md`)
  let docId = null

  try {
    const original = buildFixture()
    writeFileSync(file, original, 'utf8')
    const code = await ingest(file)
    check(code === 0, `夹具入库退出码 ${code}（期望 0）`)

    const list = await j(`/api/v1/docs?q=${encodeURIComponent(MARK)}&limit=20`)
    const target = (list.items ?? []).find((d) => d.title.startsWith(MARK))
    check(Boolean(target), '夹具已入库')
    if (!target) {
      console.log('\n  夹具没入库成功，后续测试无法进行\n')
      return
    }
    docId = target.id

    check(target.previewKind === 'markdown', `previewKind=markdown（实际 ${target.previewKind}）`)

    // 以**原件**为准（接口返回的就是刚写进去的字节）
    const raw = await text(`/api/v1/docs/${docId}/file`)
    check(raw === original, '原件与写入内容逐字一致')

    console.log(`\n  测试文档：${target.title}（${docId}）`)
    console.log(`  原件 ${raw.length} 字，${raw.split('\n').length} 行\n`)

    const render = await text(`/api/v1/docs/${docId}/preview?mode=render`)
    const source = await text(`/api/v1/docs/${docId}/preview?mode=source`)

    /* ---------- 渲染视图 ---------- */
    console.log('【渲染视图 · 文本模式】')
    check(/<h[1-6][\s>]/.test(render), 'Markdown 标题已转成 HTML 标题')
    check(render.includes('<article class="doc">'), '包在文档容器里')
    check(!render.includes('class="ln"'), '不含源码行号')
    check(render.includes('<pre>'), '围栏代码块渲染成了 <pre>')
    check(!render.includes(FENCE), '渲染视图里看不到 ``` 标记')
    check(render.includes('<table>'), '表格渲染成了 <table>')

    /* ---------- 源码视图 ---------- */
    console.log('\n【源码视图 · 代码格式】')
    const lineNoCount = (source.match(/class="ln"/g) ?? []).length
    check(lineNoCount > 0, `带行号（共 ${lineNoCount} 行）`)
    check(!/<h[1-6][\s>]/.test(source), 'Markdown 语法**未被渲染**（不该出现 HTML 标题）')
    check(source.includes(FENCE), '源码里能看到 ``` 标记本身')
    check(source.includes('class="src"'), '使用等宽源码容器')

    /* ---------- 行号与实际行数是否对得上 ---------- */
    const origLines = raw.split('\n').length
    check(lineNoCount === origLines, `行号数量与原件行数一致（${lineNoCount} / ${origLines}）`)

    /* ---------- ★ 最关键：源码必须保留原始缩进 ---------- */
    console.log('\n【关键：源码保真度】')
    const indentedLines = raw.split('\n').filter((l) => /^\s{2,}\S/.test(l))
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
      const textBody = (await j(`/api/v1/docs/${docId}/text`)).pages.join('\n')
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
    } else {
      check(true, '（库里暂无 PDF，跳过「非 Markdown 忽略 mode」检查）')
    }
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
    if (docId) {
      await fetch(`${BASE}/api/v1/docs/${docId}`, { method: 'DELETE' }).catch(() => {})
      console.log(`\n  （已清理夹具文档 ${docId}）`)
    }
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
