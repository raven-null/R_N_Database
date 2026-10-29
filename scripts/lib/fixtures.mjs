/**
 * 测试夹具：给前端测试（jsdom 冒烟、真实浏览器渲染检查）造临时文档。
 *
 * ## 为什么要独立成一个模块
 *
 * 两个测试都需要「库里得有东西」：代码、Markdown、一页 PDF。
 * 早先它们直接从库里挑现成文档 —— 只要按用户要求清空测试数据，
 * 整套前端测试就再也跑不起来，而且断言一崩一大片，
 * 分不清是「应用坏了」还是「库空了」。
 *
 * 现在测试自备夹具、跑完即删：不碰用户资料，也不要求库非空。
 * 造数据的方式与真实入库完全一致（走 scripts/ingest.mjs），
 * 所以测出来的是真实路径，不是造出来的假数据。
 *
 * @module scripts/lib/fixtures
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import zlib from 'node:zlib'
import JSZip from 'jszip'

import { testChildEnv } from './test-env.mjs'

/**
 * 生成一份**最小但合法**的单页 PDF。
 *
 * 不引 pdfkit 之类：夹具只要能被 pdfjs 打开、能抽出一行文字就够了，
 * 手写几个对象比多一个构建依赖划算。xref 的字节偏移必须准确，
 * 所以这里边拼边记 offset（内容全是 ASCII，字符数即字节数）。
 *
 * @param {string} text - 页面上的文字（只能 ASCII：Helvetica 只认单字节）
 * @returns {Buffer} PDF 内容
 */
export function buildPdf(text) {
  const stream = `BT /F1 16 Tf 30 120 Td (${text}) Tj ET`
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] '
      + '/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]

  let out = '%PDF-1.4\n'
  const offsets = []
  for (let i = 0; i < bodies.length; i++) {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${bodies[i]}\nendobj\n`
  }
  const xrefAt = out.length
  out += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`
  return Buffer.from(out, 'utf8')
}

/* ============================================================
   Office 夹具
   ============================================================ */

/**
 * 生成一份最小 DOCX（标题段 + 正文段 + 2×2 表格）。
 *
 * 手搓 OOXML 而不是引 docx 生成库：只要三个 part 就能被 Word / docx-preview
 * 正常打开，比多一个依赖划算。★ 注意必须带 `sectPr`（页面尺寸），
 * 缺了它 docx-preview 拿不到纸张大小，分页样式会退化。
 *
 * @param {string} mark - 写进正文的独特标记（保证每次夹具内容不同，不被去重跳过）
 * @returns {Promise<Buffer>} docx 内容
 */
export async function buildDocxFixture(mark) {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
  const p = (text, bold = false, size = 0) => `<w:p><w:r><w:rPr>${bold ? '<w:b/>' : ''}${size ? `<w:sz w:val="${size}"/>` : ''}</w:rPr>`
    + `<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`
  const cell = (text) => `<w:tc>${p(text)}</w:tc>`

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${p(`${mark} 测试文档`, true, 36)}
${p('这是夹具正文，用于验证网页视图里段落能正常显示。')}
<w:tbl>
<w:tr>${cell('项目')}${cell('数值')}</w:tr>
<w:tr>${cell(mark)}${cell('42')}</w:tr>
</w:tbl>
${p('表格之后的一段文字。')}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
</w:body></w:document>`

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

  const zip = new JSZip()
  zip.file('[Content_Types].xml', contentTypes)
  zip.folder('_rels').file('.rels', rels)
  zip.folder('word').file('document.xml', documentXml)
  // JSZip 3 起 `generate()` 已移除，只有异步版
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

/**
 * 生成一份带样式与数字格式的 XLSX 夹具。
 *
 * 刻意包含：合并标题、粗体表头、货币/百分比/日期格式、冻结窗格、
 * 两个工作表、以及足够多的行让「分批渲染」这条路径也跑到。
 *
 * @param {string} mark - 独特性标记（同时写进单元格值）
 * @returns {Promise<Buffer>} xlsx 内容
 */
export async function buildXlsxFixture(mark) {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()

  // 同时冻结首行表头与首列（xSplit:1）—— 冻结列只有真浏览器才验得出来
  const ws = wb.addWorksheet('台账', { views: [{ state: 'frozen', xSplit: 1, ySplit: 2 }] })
  ws.columns = [{ width: 12 }, { width: 30 }, { width: 14 }, { width: 10 }, { width: 16 }]
  ws.mergeCells('A1:E1')
  const title = ws.getCell('A1')
  title.value = `${mark} 设备台账`
  title.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } }
  title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } }
  title.alignment = { horizontal: 'center', vertical: 'middle' }
  ws.getRow(1).height = 28

  for (const [i, h] of ['编号', '名称', '单价', '数量', '小计'].entries()) {
    const c = ws.getRow(2).getCell(i + 1)
    c.value = h
    c.font = { bold: true }
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } }
  }

  for (let r = 0; r < 60; r++) {
    const row = ws.getRow(3 + r)
    row.getCell(1).value = `${mark}-${1000 + r}`
    row.getCell(2).value = `测试设备 ${r}`
    row.getCell(3).value = 1000 + r * 5
    row.getCell(3).numFmt = '¥#,##0.00'
    row.getCell(4).value = (r % 4) + 1
    row.getCell(5).value = { formula: `C${3 + r}*D${3 + r}`, result: (1000 + r * 5) * ((r % 4) + 1) }
    row.getCell(5).numFmt = '¥#,##0.00'
  }
  ws.getCell('G1').value = '占比'
  ws.getCell('G2').value = 0.37
  ws.getCell('G2').numFmt = '0.0%'
  ws.getCell('H1').value = '日期'
  ws.getCell('H2').value = new Date('2025-03-14T00:00:00.000Z')
  ws.getCell('H2').numFmt = 'yyyy-mm-dd'

  const ws2 = wb.addWorksheet('汇总')
  ws2.getCell('A1').value = `${mark} 汇总`
  ws2.getCell('A1').font = { bold: true, size: 14 }
  ws2.getCell('A3').value = '办公'
  ws2.getCell('B3').value = 17

  return Buffer.from(await wb.xlsx.writeBuffer())
}

/**
 * 生成一份带形状 / 表格 / 图片的 PPTX 夹具。
 *
 * @param {string} mark - 独特性标记
 * @returns {Promise<Buffer>} pptx 内容
 */
export async function buildPptxFixture(mark) {
  const { default: PptxGenJS } = await import('pptxgenjs')
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_16x9'

  const s1 = pptx.addSlide()
  s1.background = { color: '1F2937' }
  s1.addText(`${mark} 演示`, { x: 0.6, y: 1.5, w: 8.8, h: 1.2, fontSize: 40, bold: true, color: 'FFFFFF' })
  s1.addText('用于验证网页视图的形状 / 表格 / 图片还原', { x: 0.6, y: 2.8, w: 8.8, h: 0.8, fontSize: 18, color: '9AA3B2' })

  const s2 = pptx.addSlide()
  s2.addText('形状与表格', { x: 0.5, y: 0.35, w: 9, h: 0.7, fontSize: 26, bold: true, color: '0F172A' })
  s2.addShape(pptx.ShapeType.roundRect, {
    x: 0.5, y: 1.2, w: 4.2, h: 1.4,
    fill: { color: 'EEF4FF' }, line: { color: '2563EB', width: 2 },
  })
  s2.addText('圆角矩形', { x: 0.7, y: 1.6, w: 3.8, h: 0.6, fontSize: 16, color: '1E3A8A' })
  s2.addShape(pptx.ShapeType.ellipse, { x: 5.1, y: 1.2, w: 1.4, h: 1.4, fill: { color: 'F97316' } })
  s2.addTable(
    [[{ text: '项目', options: { bold: true } }, { text: '数值', options: { bold: true } }],
      [mark, '256'], ['标签', '34']],
    { x: 0.5, y: 3.0, w: 6.2, fontSize: 14, border: { pt: 1, color: 'CBD5E1' } },
  )

  const s3 = pptx.addSlide()
  s3.addText('图文混排', { x: 0.5, y: 0.3, w: 9, h: 0.7, fontSize: 26, bold: true })
  // 用一张纯色小图当图片素材（不依赖仓库里的截图，测试可移植）
  const png = buildTinyPng()
  s3.addImage({ data: `image/png;base64,${png.toString('base64')}`, x: 0.5, y: 1.2, w: 4.4, h: 3.0 })
  s3.addText('右侧文字用于观察换行与行高。\nEnglish mixed line for wrapping behaviour.', {
    x: 5.3, y: 1.2, w: 4.2, h: 3.0, fontSize: 14, lineSpacingMultiple: 1.2,
  })

  const out = await pptx.write({ outputType: 'nodebuffer' })
  return Buffer.from(out)
}

/**
 * 一个 2×2 的单色 PNG（红/绿/蓝/白各一格）。
 * @returns {Buffer} PNG 内容
 */
function buildTinyPng() {
  const { deflateSync } = zlib
  const size = 2
  const rows = []
  const colors = [[255, 0, 0], [0, 128, 0], [0, 0, 255], [255, 255, 0]]
  for (let y = 0; y < size; y++) {
    const row = [0] // filter type 0
    for (let x = 0; x < size; x++) row.push(...colors[y * size + x])
    rows.push(Buffer.from(row))
  }
  const raw = Buffer.concat(rows)

  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8    // bit depth
  ihdr[9] = 2    // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** CRC32 查表（PNG 用）。 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

/**
 * 计算 CRC32。
 * @param {Buffer} buf - 数据
 * @returns {number} 校验值
 */
function crc32(buf) {
  let c = 0xFFFFFFFF
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

/**
 * 跑一次真实入库（子进程）。
 *
 * stdio 用 'ignore'：沙箱下 Node 的 child_process 若用管道捕获输出会 EPERM。
 *
 * @param {string} root - 项目根目录
 * @param {string} file - 文件路径
 * @returns {Promise<number>} 退出码
 */
export function ingestFile(root, file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'scripts', 'ingest.mjs'), file, '--no-ai'], {
      cwd: root,
      stdio: 'ignore',
      // 钉死本地存储：别继承开发者 .env 里的 remote 模式（见 test-env.mjs）
      env: testChildEnv(),
    })
    child.on('error', reject)
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

/** 代码夹具的内容（带缩进：编辑器的 Tab/Shift+Tab 断言要用）。 */
function codeFixture(mark) {
  return [
    `// ${mark}`,
    'export interface Point {',
    '  x: number',
    '  y: number',
    '}',
    '',
    'export function add(a: Point, b: Point): Point {',
    '  return { x: a.x + b.x, y: a.y + b.y }',
    '}',
    '',
  ].join('\n')
}

/** Markdown 夹具的内容（标题 / 列表 / 表格 / 围栏代码块 / 缩进都有）。 */
function mdFixture(mark) {
  const fence = '```'
  return [
    `# ${mark} note`,
    '',
    '前端测试用的临时 Markdown，覆盖标题、列表、表格与代码块。',
    '',
    '## 二级标题',
    '',
    '- 列表项一',
    '  - 嵌套列表项',
    '',
    '| 列 A | 列 B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    `${fence}python`,
    'def add(a, b):',
    '    return a + b',
    fence,
    '',
    '  这一行有两个前导空格。',
    '',
  ].join('\n')
}

/**
 * 造夹具并入库。
 *
 * Office 三件套是可选的（`office: true`）：入库它们要走 Office/LibreOffice
 * 转 PDF，每份 2–4 秒，只有需要验证 Word/Excel/PPT 视图的测试才值得付这个钱。
 *
 * @param {object} opts - { root, base, mark, office? }
 * @returns {Promise<{mark:string, dir:string|null, ids:string[], byKind:Record<string,string|null>, files:Record<string,string>}>} 夹具
 */
export async function provisionFixtures(opts) {
  const { root, base, mark, office = false } = opts
  const dir = mkdtempSync(join(tmpdir(), 'rndb-fixture-'))

  const files = {
    code: join(dir, `${mark}-code.ts`),
    md: join(dir, `${mark}-note.md`),
    pdf: join(dir, `${mark}-pdf.pdf`),
  }

  writeFileSync(files.code, codeFixture(mark), 'utf8')
  writeFileSync(files.md, mdFixture(mark), 'utf8')
  writeFileSync(files.pdf, buildPdf(`RNDB smoke pdf ${mark}`))

  if (office) {
    // 标记必须写进**内容**里：入库按 SHA-256 去重，两次运行内容一模一样
    // 就会被判为"已存在"而跳过，于是拿不到本次的 id
    files.docx = join(dir, `${mark}-word.docx`)
    files.xlsx = join(dir, `${mark}-sheet.xlsx`)
    files.pptx = join(dir, `${mark}-deck.pptx`)
    writeFileSync(files.docx, await buildDocxFixture(mark))
    writeFileSync(files.xlsx, await buildXlsxFixture(mark))
    writeFileSync(files.pptx, await buildPptxFixture(mark))
  }

  for (const file of Object.values(files)) {
    await ingestFile(root, file)
  }

  const res = await fetch(`${base}/api/v1/docs?q=${encodeURIComponent(mark)}&limit=100`)
  const body = await res.json()
  const items = (body?.data?.items ?? []).filter((d) => String(d.title).startsWith(mark))

  return {
    mark,
    dir,
    files,
    ids: items.map((d) => d.id),
    byKind: {
      code: items.find((d) => d.type === 'code')?.id ?? null,
      md: items.find((d) => d.type === 'md')?.id ?? null,
      pdf: items.find((d) => d.type === 'pdf')?.id ?? null,
      docx: items.find((d) => d.type === 'docx')?.id ?? null,
      xlsx: items.find((d) => d.type === 'xlsx')?.id ?? null,
      pptx: items.find((d) => d.type === 'pptx')?.id ?? null,
    },
  }
}

/**
 * 删掉夹具（文档 + 临时目录）。
 *
 * 除了记录过的 id，再按标记扫一遍：测试中途崩掉时可能有文档
 * 「入库成功但没来得及记下 id」，漏掉就会污染库。
 *
 * @param {object} opts - { base, fixtures }
 * @returns {Promise<number>} 删掉的文档数
 */
export async function cleanupFixtures(opts) {
  const { base, fixtures } = opts
  let removed = 0

  for (const id of fixtures.ids ?? []) {
    const res = await fetch(`${base}/api/v1/docs/${id}`, { method: 'DELETE' }).catch(() => null)
    if (res?.ok) removed += 1
  }

  if (fixtures.mark) {
    try {
      const res = await fetch(`${base}/api/v1/docs?q=${encodeURIComponent(fixtures.mark)}&limit=200`)
      const body = await res.json()
      for (const d of body?.data?.items ?? []) {
        if (!String(d.title).startsWith(fixtures.mark)) continue
        const del = await fetch(`${base}/api/v1/docs/${d.id}`, { method: 'DELETE' }).catch(() => null)
        if (del?.ok) removed += 1
      }
    } catch {
      /* 忽略：清理失败不该让测试结论反转 */
    }
  }

  try {
    if (fixtures.dir) rmSync(fixtures.dir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }

  return removed
}
