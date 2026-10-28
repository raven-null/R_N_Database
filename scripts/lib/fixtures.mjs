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
 * @param {object} opts - { root, base, mark }
 * @returns {Promise<{mark:string, dir:string|null, ids:string[], byKind:Record<string,string|null>, files:Record<string,string>}>} 夹具
 */
export async function provisionFixtures(opts) {
  const { root, base, mark } = opts
  const dir = mkdtempSync(join(tmpdir(), 'rndb-fixture-'))

  const files = {
    code: join(dir, `${mark}-code.ts`),
    md: join(dir, `${mark}-note.md`),
    pdf: join(dir, `${mark}-pdf.pdf`),
  }

  writeFileSync(files.code, codeFixture(mark), 'utf8')
  writeFileSync(files.md, mdFixture(mark), 'utf8')
  writeFileSync(files.pdf, buildPdf(`RNDB smoke pdf ${mark}`))

  for (const file of Object.values(files)) {
    await ingestFile(root, file)
  }

  const res = await fetch(`${base}/api/v1/docs?q=${encodeURIComponent(mark)}&limit=50`)
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
