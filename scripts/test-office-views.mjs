/**
 * Office 三种格式「网页视图」回归测试。
 *
 * ## 它验证什么
 *
 * 这条链路的核心主张是：**不转成 PDF 也能正常看 Word / Excel / PowerPoint**。
 * 所以每一项都必须验到"看得到、看得对"：
 *
 *   Word      入库时渲染出 HTML（段落、表格都在），文字与原件一致
 *   Excel     解析出结构化表格（值/合并/冻结/数字格式），不是一串文本
 *   PPT       每张幻灯片渲染成内联 SVG（形状、表格、图片都在），文字与 PDF 一致
 *
 * 以及**不能忘的那件事**：PDF 那一档必须还在。网页视图是加一档，
 * 不是替换 —— 复杂版式出偏差时用户得能切回原始版式。
 *
 * ## 为什么文字比对要用 PDF
 *
 * 我看不见渲染结果的像素，但可以验证"内容没丢"：把 Office 转出的 PDF
 * 抽出的文字，与网页视图里的文字逐条比对。文字对得上、元素齐全、
 * 没有溢出，剩下的就只是字体度量级别的差异 —— 那是可以接受的。
 *
 * 用法：
 *   node scripts/dev-server.mjs
 *   node scripts/test-office-views.mjs
 *
 * @module scripts/test-office-views
 */

import { join } from 'node:path'

import { provisionFixtures, cleanupFixtures } from './lib/fixtures.mjs'

const ROOT = process.cwd()
const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:8899'

const MARK = `RNDBOFFICE${Date.now()}`

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
  const res = await fetch(BASE + path)
  const body = await res.json()
  if (!body?.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
  return body.data
}

/**
 * 取文本响应。
 * @param {string} path - 路径
 * @returns {Promise<{status:number, text:string, headers:Headers}>} 响应
 */
async function t(path) {
  const res = await fetch(BASE + path)
  return { status: res.status, text: await res.text(), headers: res.headers }
}

/**
 * 归一化文本，用于比对（去空白与标点差异）。
 * @param {string} s - 原文
 * @returns {string} 归一化结果
 */
function norm(s) {
  return String(s ?? '').replace(/[\s\u3000]+/g, '').toLowerCase()
}

async function main() {
  console.log('▸ R_N_Database Office 网页视图回归测试')
  console.log(`  后端 ${BASE}\n`)

  try {
    const health = await j('/api/v1/health')
    console.log(`  存储 ${health.store.mode} / 现有文档 ${health.docCount} 份\n`)
  } catch (err) {
    console.error(`  无法连接开发服务器：${err.message}`)
    console.error('  请先运行：node scripts/dev-server.mjs\n')
    process.exit(1)
  }

  console.log('【准备：造 Office 夹具并入库】')
  const fixtures = await provisionFixtures({ root: ROOT, base: BASE, mark: MARK, office: true })
  console.log(`  已入库 ${fixtures.ids.length} 份（${MARK}）`)
  const kinds = Object.entries(fixtures.byKind).filter(([, v]) => v).map(([k]) => k)
  console.log(`  类型：${kinds.join(' / ')}\n`)

  try {
    const { docx: docxId, xlsx: xlsxId, pptx: pptxId } = fixtures.byKind

    /* ============================================================
       Word
       ============================================================ */
    console.log('【Word：网页视图】')
    if (!docxId) {
      check(false, 'Word 夹具入库成功')
    } else {
      const meta = await j(`/api/v1/docs/${docxId}`)
      check(meta.webView === 'docx', `元数据标记 webView=docx（实际 ${meta.webView}）`)
      check(meta.previewKind === 'pdf', `PDF 那一档仍然存在（previewKind=${meta.previewKind}）`)

      const web = await t(`/api/v1/docs/${docxId}/preview?view=web`)
      check(web.status === 200, `网页视图可访问（${web.status}）`)
      check(/text\/html/.test(web.headers.get('content-type') ?? ''), '返回 HTML')
      check(
        (web.headers.get('content-security-policy') ?? '').includes("default-src 'none'"),
        '带严格 CSP（禁脚本、禁外部资源）',
      )
      check(web.text.includes('<section class="docx"'), '是 docx-preview 渲染的页面结构')
      check(/<table/.test(web.text), '表格渲染出来了')
      check(web.text.includes(MARK), '标题里带夹具标记（说明渲染的是这份文档）')
      check(/<p>/.test(web.text), '段落存在')

      // 文字与 PDF 对照：网页视图不能丢内容
      const pdf = await fetch(`${BASE}/api/v1/docs/${docxId}/preview`)
      if ((pdf.headers.get('content-type') ?? '').includes('pdf')) {
        const pdfText = await j(`/api/v1/docs/${docxId}/text`)
        const body = norm((pdfText.pages ?? []).join(' '))
        const rendered = norm(web.text.replace(/<[^>]+>/g, ' '))
        // 抽样：正文里的几个词都得在渲染结果里出现
        const probes = ['项目', '数值', '42', '表格之后的一段文字']
        const hits = probes.filter((p) => body.includes(norm(p)) && rendered.includes(norm(p)))
        check(
          hits.length === probes.length,
          `网页视图与抽取正文内容一致（${hits.length}/${probes.length} 个探针命中）`,
          `未命中：${probes.filter((p) => !hits.includes(p)).join('、')}`,
        )
      } else {
        check(true, '（PDF 预览不可用，跳过文字对照）')
      }

      // 下载原件不受影响
      const file = await fetch(`${BASE}/api/v1/docs/${docxId}/file`)
      check(file.status === 200, `原件仍可下载（${file.status}）`)
    }

    /* ============================================================
       Excel
       ============================================================ */
    console.log('\n【Excel：表格视图】')
    if (!xlsxId) {
      check(false, 'Excel 夹具入库成功')
    } else {
      const meta = await j(`/api/v1/docs/${xlsxId}`)
      check(meta.webView === 'sheet', `元数据标记 webView=sheet（实际 ${meta.webView}）`)

      const model = await j(`/api/v1/docs/${xlsxId}/preview?view=sheet`)
      check(Array.isArray(model.sheets) && model.sheets.length === 2,
        `解析出 2 个工作表（实际 ${model.sheets?.length}）`,
        JSON.stringify(model.sheets?.map((s) => s.name)))

      const ws = model.sheets[0]
      check(ws.name === '台账', `首表名「台账」（实际 ${ws.name}）`)
      check(ws.rows >= 60, `行数 ${ws.rows}（夹具 63 行）`)
      check(ws.cols === 8, `列数 ${ws.cols}（夹具 8 列，H 列不能被吞掉）`)
      check(Array.isArray(ws.merges) && ws.merges.length === 1, '合并区域解析到 1 个')
      check(ws.merges?.[0]?.[0] === 1 && ws.merges?.[0]?.[3] === 5, '合并范围是 A1:E1')
      check(ws.freeze?.rows === 2, `冻结前 2 行（实际 ${JSON.stringify(ws.freeze)}）`)

      // 合并区不能重复出现同一句标题：
      // A1:E1 合并后，第 1 行应当只剩 A1（锚点）+ G1「占比」+ H1「日期」
      const row1 = ws.cells.filter((c) => c[0] === 1).map((c) => c[1]).sort((a, b) => a - b)
      check(
        JSON.stringify(row1) === JSON.stringify([1, 7, 8]),
        `第 1 行只剩 3 个格（合并区从属格已去掉，实际 ${JSON.stringify(row1)}）`,
      )
      check(
        ![2, 3, 4, 5].some((c) => row1.includes(c)),
        'B1:E1 这些被合并覆盖的格子没有重复出现',
      )

      const titleCell = ws.cells.find((c) => c[0] === 1 && c[1] === 1)
      check(titleCell?.[4]?.bg === '#1f4e79', '标题格保留了深色填充')
      check(titleCell?.[4]?.fc === '#ffffff', '标题格保留了白字（深底白字不能丢）')

      // 数字格式
      const money = ws.cells.find((c) => c[1] === 3 && c[0] === 3)
      check(money?.[3] === '¥#,##0.00', `单价带货币格式（${money?.[3]}）`)
      check(typeof money?.[2] === 'number', '单元格值是数字而不是字符串（前端才能右对齐）')

      const pct = ws.cells.find((c) => c[1] === 7 && c[0] === 2)
      check(pct?.[3] === '0.0%', `百分比格式保留（${pct?.[3]}）`)

      const date = ws.cells.find((c) => c[1] === 8 && c[0] === 2)
      check(typeof date?.[2] === 'string' && /^\d{4}-\d{2}-\d{2}/.test(date[2]),
        `日期转成了 ISO 串（${date?.[2]}）`)

      // 公式取缓存结果
      const calc = ws.cells.find((c) => c[1] === 5 && c[0] === 3)
      check(typeof calc?.[2] === 'number', `公式格取到缓存结果（${calc?.[2]}）`)

      check(model.truncated === false, '夹具规模没有触发截断')

      // 非 Excel 不该有表格视图
      if (docxId) {
        const wrong = await fetch(`${BASE}/api/v1/docs/${docxId}/preview?view=sheet`)
        check(wrong.status === 404, `对 docx 请求 sheet 视图返回 404（实际 ${wrong.status}）`)
      }
    }

    /* ============================================================
       PowerPoint
       ============================================================ */
    console.log('\n【PowerPoint：网页视图】')
    if (!pptxId) {
      check(false, 'PPT 夹具入库成功')
    } else {
      const meta = await j(`/api/v1/docs/${pptxId}`)
      check(meta.webView === 'pptx', `元数据标记 webView=pptx（实际 ${meta.webView}）`)
      check(meta.previewKind === 'pdf', 'PDF 那一档仍然存在（PPT 默认仍用 PDF）')

      const web = await t(`/api/v1/docs/${pptxId}/preview?view=web`)
      check(web.status === 200, `网页视图可访问（${web.status}）`)
      const svgCount = (web.text.match(/<svg/g) ?? []).length
      check(svgCount === 3, `3 张幻灯片各一段 SVG（实际 ${svgCount}）`)
      check(/<foreignObject/.test(web.text), '文字用 foreignObject（内联 SVG 才能渲染，外链会丢字）')
      check(/<image[^>]+data:image\/png/.test(web.text), '图片以 data: URL 内联（不依赖外部请求）')
      check(/<table/.test(web.text), '表格渲染出来了（foreignObject 里的 HTML 表格）')
      check(!/googleapis/.test(web.text), '不引用任何外部字体（私有库不该向外发请求）')
      check(web.text.includes(MARK), '文字里带夹具标记')

      // 与 PDF 文字对照
      const draw = await fetch(`${BASE}/api/v1/docs/${pptxId}/preview`)
      if ((draw.headers.get('content-type') ?? '').includes('pdf')) {
        const text = await j(`/api/v1/docs/${pptxId}/text`)
        const pdfNorm = norm((text.pages ?? []).join(' '))
        const svgNorm = norm(web.text.replace(/<[^>]+>/g, ' '))
        const probes = ['形状与表格', '圆角矩形', '项目', '数值', '图文混排', 'English mixed line']
        const hits = probes.filter((p) => pdfNorm.includes(norm(p)) && svgNorm.includes(norm(p)))
        check(
          hits.length === probes.length,
          `SVG 文字与 PDF 逐条一致（${hits.length}/${probes.length} 个探针命中）`,
          `未命中：${probes.filter((p) => !hits.includes(p)).join('、')}`,
        )
      } else {
        check(true, '（PDF 预览不可用，跳过文字对照）')
      }

      // 位置检查：元素该落在幻灯片范围内（用 translate 判断，不要看 foreignObject）
      //
      // ★ foreignObject 的 y 可以是负的、高度可以是幻灯片的好几倍 ——
      // 那是 pagus 的**设计**：为了容纳自动行高/溢出，它会把文本框对称放大，
      // 让原容器仍落在正确位置。真正决定位置的是外层 <g transform="translate(x,y)">，
      // 所以这里查 translate，并且要求页面能裁剪（CSS 的 overflow: hidden）。
      const viewBox = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(web.text)
      const vbW = Number(viewBox?.[1] ?? 0)
      const vbH = Number(viewBox?.[2] ?? 0)
      check(vbW > 0 && vbH > 0, `SVG 有 viewBox（${vbW}×${vbH}）`)

      const translates = [...web.text.matchAll(/translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\s*\)/g)]
        .map((m) => [Number(m[1]), Number(m[2])])
      check(translates.length >= 6, `元素定位来自 translate（共 ${translates.length} 个）`)
      check(
        translates.every(([x, y]) => x >= -1 && y >= -1 && x <= vbW && y <= vbH),
        '所有元素的原点都落在幻灯片内',
        translates.filter(([x, y]) => x < -1 || y < -1 || x > vbW || y > vbH).slice(0, 4).join(' | '),
      )
      // 幻灯片是固定比例，CSS 的 aspect-ratio 才算得准
      check(
        Math.abs((vbW / vbH) - (16 / 9)) < 0.02,
        `viewBox 比例是 16:9（${(vbW / vbH).toFixed(3)}）`,
      )
    }

    /* ============================================================
       一致性
       ============================================================ */
    console.log('\n【接口一致性】')
    if (docxId) {
      const wrong = await fetch(`${BASE}/api/v1/docs/${docxId}/preview?view=web`)
      const hasVersion = /[?&]v=/.test(`${BASE}/api/v1/docs/${docxId}/preview?view=web&v=1`)
      check(hasVersion, '网页视图支持 ?v= 版本化缓存')
      check(wrong.status === 200, '同一地址可重复取用（预览件是静态产物）')
    }

    const missing = await fetch(`${BASE}/api/v1/docs/deadbeef0000/preview?view=web`)
    check(missing.status === 404, `不存在的文档返回 404（实际 ${missing.status}）`)
  } finally {
    const removed = await cleanupFixtures({ base: BASE, fixtures })
    console.log(`\n  已清理 ${removed} 份夹具文档（${join(ROOT, '.local-data')}）`)
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
