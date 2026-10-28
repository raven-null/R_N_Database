/**
 * 正文与元数据抽取。
 *
 * 支持：PDF / DOCX / XLSX / PPTX / MD / TXT，全部**在本地入库时**完成，
 * 线上不跑任何转换（函数只读结果）。
 *
 * 各格式的实现选择与理由：
 *   PDF   —— pdfjs-dist 的 legacy 构建。实测中文 PDF 抽取正常
 *            （含 CID 字体编码的中文书稿），因此不引 jieba 之类的中文库。
 *   DOCX  —— mammoth 抽纯文本；再用 jszip 读 docProps/core.xml 取标题作者。
 *   XLSX  —— exceljs 逐表读单元格。**不用 npm 上的 xlsx(SheetJS)**：
 *            其 npm 版本陈旧且有安全公告。
 *   PPTX  —— jszip 解包后正则抽 <a:t> 文本节点。幻灯片文本结构简单，
 *            为此引一个库不划算。
 *   MD/TXT —— 直接读。
 *
 * 所有抽取器都做异常隔离：单个文件抽取失败不应中断整批入库，
 * 只把该文件标记为「仅元数据、无正文」。
 *
 * @module scripts/lib/extract
 */

import { readFileSync } from 'node:fs'
import { extname, basename } from 'node:path'
// 类型识别统一走函数侧共享模块：上传接口与入库必须用同一套判断，
// 否则会出现「传得上来但入不了库」这类不一致
import { detectType, mimeOf, titleFromFilename } from '../../netlify/functions/_lib/file-types.mjs'
// 正文规整同样走共享实现：网页编辑内容之后重算的正文，
// 必须与入库时算出来的一字不差
import { cleanText, plainTextOf } from '../../netlify/functions/_lib/plain-text.mjs'

export { detectType, mimeOf, titleFromFilename }

/** 单份文档正文上限（字符）。307 页的书约 50 万字符，这个上限足够宽松。 */
const MAX_TEXT_CHARS = 2_000_000

/**
 * 判断该类型能否抽取正文。
 * @param {string} type - 规范化类型
 * @returns {boolean} 是否支持
 */
export function canExtractText(type) {
  return ['pdf', 'docx', 'xlsx', 'pptx', 'md', 'txt', 'csv', 'code'].includes(type)
}

/* ============================================================
   文本清洗
   ============================================================ */

/**
 * 清洗抽取到的文本 —— 实现已移到 _lib/plain-text.mjs（见那里的说明），
 * 这里只做转出，保持既有调用点不变。
 */

/**
 * 从文件名推一个兜底标题 —— 已由 _lib/file-types.mjs 在顶部统一导入并转出，
 * 这里不再重复实现（上传接口用的是同一份逻辑）。
 */

/**
 * 已知的垃圾内嵌标题（生成工具留下的无意义值）。
 *
 * 这不是洁癖：PDF 内嵌 Title 常是 `about:blank`、`Microsoft Word - 未命名`、
 * 纯数字文件名之类。若直接采信，列表页会显示一串无意义标题，
 * **而且会顶掉文件名**，导致分类规则拿不到「简历」「发票」这类关键线索
 * （实测：一份简历因为内嵌标题是 about:blank，被误分类到「项目文档」）。
 */
const JUNK_TITLES = new Set([
  'about:blank', 'untitled', 'unknown', 'document', 'document1', 'doc1',
  'microsoft word', 'powerpoint', 'presentation', 'workbook', 'book1',
  '幻灯片', '演示文稿', '工作簿', '文档', '未命名', '无标题', '新建文档',
  '空白演示', '空白文档', '空白工作簿', '新建演示文稿',
  'sheet1', 'slide1', 'microsoft powerpoint',
])

/**
 * 生成工具留下的模板标题（前缀匹配）。
 *
 * 这些不是笔误：很多人用脚本/库生成文档，库会把**工具名**写进文档属性，
 * 于是列表页上几十份文件全叫「PptxGenJS Presentation」。
 * 实测：pptxgenjs 生成的演示文稿内嵌标题就是这串，
 * 它会顶掉文件名，用户看到的是一堆一模一样的标题。
 */
const JUNK_TITLE_PREFIXES = [
  'pptxgenjs', 'exceljs', 'jszip', 'docx4j', 'apache poi', 'aspose',
  'reportlab', 'google docs', 'google 文档', '腾讯文档', '石墨文档',
]

/**
 * 判断内嵌标题是否是垃圾值。
 * @param {string} title - 候选标题
 * @returns {boolean} 是否应丢弃
 */
export function isJunkTitle(title) {
  const t = String(title ?? '').trim()
  if (t.length < 2) return true
  const lower = t.toLowerCase()
  if (JUNK_TITLES.has(lower)) return true
  // "Microsoft Word - xxx" 形式的工具前缀
  if (/^(microsoft|wps|libreoffice|openoffice)\b/i.test(t)) return true
  // 生成库写进文档属性的工具名
  if (JUNK_TITLE_PREFIXES.some((p) => lower.startsWith(p))) return true
  // 纯数字/纯符号
  if (/^[\d\s._-]+$/.test(t)) return true
  // 看起来像 URL 或本地路径
  if (/^(https?:|file:|[a-z]:\\)/i.test(t)) return true
  return false
}

/**
 * 选出可用的标题：内嵌标题优先（若非垃圾），否则用文件名。
 * @param {string} embedded - 文档内嵌标题
 * @param {string} fromName - 从文件名推的标题
 * @returns {string} 最终标题
 */
export function pickTitle(embedded, fromName) {
  const e = String(embedded ?? '').trim()
  return isJunkTitle(e) ? fromName : e
}

/* ============================================================
   PDF
   ============================================================ */

/**
 * 抽取 PDF 正文与元数据。
 * @param {Buffer} buf - 文件内容
 * @returns {Promise<{pages:string[], meta:object}>} 结果
 */
async function extractPdf(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')

  const loadingTask = pdfjs.getDocument({
    // 复制一份 Uint8Array：pdfjs 会转移（transfer）这个 buffer，
    // 直接传原 buffer 会让调用方后续拿到空数据
    data: new Uint8Array(buf),
    useSystemFonts: true,
    isEvalSupported: false,   // 不执行文档内嵌 JS，安全考虑
    verbosity: 0,
  })
  const doc = await loadingTask.promise

  const pages = []
  let total = 0

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    // 按 hasEOL 拼行，避免同一行内被无谓切开
    let text = ''
    for (const item of content.items) {
      text += item.str
      if (item.hasEOL) text += '\n'
    }
    const cleaned = cleanText(text)
    pages.push(cleaned)
    total += cleaned.length
    page.cleanup?.()
    if (total >= MAX_TEXT_CHARS) break
  }

  let info = {}
  try {
    const raw = await doc.getMetadata()
    info = raw?.info ?? {}
  } catch {
    /* 元数据缺失不影响正文 */
  }

  const meta = {
    pages: doc.numPages,
    title: typeof info.Title === 'string' ? info.Title.trim() : '',
    author: typeof info.Author === 'string' ? info.Author.trim() : '',
    subject: typeof info.Subject === 'string' ? info.Subject.trim() : '',
    docCreatedAt: normalizePdfDate(info.CreationDate),
  }

  await destroyPdf(loadingTask, doc)
  return { pages, meta }
}

/**
 * 释放 PDF 资源。
 *
 * pdfjs-dist v6 把 destroy() 从 PDFDocumentProxy 移到了 loading task 上
 * （v4 起的变化）。这里两个都试，且清理失败不影响抽取结果 ——
 * 早先只在 doc 上调 destroy()，导致整份 PDF 的正文抽取全废。
 *
 * @param {object} loadingTask - getDocument 返回的 loading task
 * @param {object} doc - PDFDocumentProxy
 * @returns {Promise<void>} 完成
 */
async function destroyPdf(loadingTask, doc) {
  try {
    if (typeof loadingTask?.destroy === 'function') await loadingTask.destroy()
    else if (typeof doc?.destroy === 'function') await doc.destroy()
  } catch {
    /* 释放失败不该让已经抽到的正文作废 */
  }
}

/**
 * 解析 PDF 的日期字符串（形如 D:20260826120000+08'00'）。
 * @param {*} value - 原始值
 * @returns {string|null} ISO 字符串或 null
 */
function normalizePdfDate(value) {
  if (typeof value !== 'string') return null
  const m = value.match(/D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/)
  if (!m) return null
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00'] = m
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/* ============================================================
   DOCX
   ============================================================ */

/**
 * 抽取 DOCX 正文与元数据。
 * @param {Buffer} buf - 文件内容
 * @returns {Promise<{html:string, text:string, meta:object}>} 结果
 */
async function extractDocx(buf) {
  const mammoth = (await import('mammoth')).default

  const { value: html, messages } = await mammoth.convertToHtml({ buffer: buf })
  const { value: text } = await mammoth.extractRawText({ buffer: buf })

  let meta = {}
  try {
    meta = await readOoxmlCoreProps(buf)
  } catch {
    /* 核心属性缺失不影响正文 */
  }

  const warnings = (messages ?? [])
    .filter((m) => m.type === 'warning')
    .map((m) => m.message)

  return {
    html: html || '',
    text: cleanText(text),
    meta: { title: meta.title ?? '', author: meta.creator ?? '', docCreatedAt: meta.created ?? null, warnings },
  }
}

/**
 * 读取 OOXML 的 docProps/core.xml（标题/作者/创建时间）。
 * @param {Buffer} buf - 文件内容
 * @returns {Promise<object>} 核心属性
 */
async function readOoxmlCoreProps(buf) {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(buf)
  const file = zip.file('docProps/core.xml') || zip.file('docProps/app.xml')
  if (!file) return {}
  const xml = await file.async('string')

  const pick = (tag) => {
    const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))
    return m ? m[1].trim() : ''
  }
  const created = pick('dcterms:created') || pick('dcterms:modified')

  return {
    title: pick('dc:title'),
    creator: pick('dc:creator'),
    created: created ? new Date(created).toISOString() : null,
  }
}

/* ============================================================
   XLSX
   ============================================================ */

/**
 * 抽取 XLSX 正文与元数据。
 * @param {Buffer} buf - 文件内容
 * @returns {Promise<{html:string, text:string, meta:object}>} 结果
 */
async function extractXlsx(buf) {
  const ExcelJS = (await import('exceljs')).default

  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf)

  const htmlParts = []
  const textParts = []

  wb.eachSheet((sheet) => {
    const rows = []
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells = []
      row.eachCell({ includeEmpty: true }, (cell) => {
        cells.push(cellText(cell.value))
      })
      rows.push(cells)
    })
    if (rows.length === 0) return

    textParts.push(`## ${sheet.name}\n` + rows.map((r) => r.join('\t')).join('\n'))
    htmlParts.push(
      `<h3 class="sheet-name">${escHtml(sheet.name)}</h3>`
      + '<table class="sheet-table"><tbody>'
      + rows.slice(0, 500).map((r) => `<tr>${r.map((c) => `<td>${escHtml(c)}</td>`).join('')}</tr>`).join('')
      + '</tbody></table>',
    )
  })

  return {
    html: htmlParts.join('\n'),
    text: cleanText(textParts.join('\n\n')),
    meta: {
      title: wb.title ?? '',
      author: wb.creator ?? '',
      docCreatedAt: wb.created ? new Date(wb.created).toISOString() : null,
      sheetCount: wb.worksheets.length,
    },
  }
}

/**
 * 把 ExcelJS 的单元格值转成文本。
 * @param {*} value - 单元格值
 * @returns {string} 文本
 */
function cellText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    if (value instanceof Date) return value.toISOString().slice(0, 10)
    if (Array.isArray(value.richText)) return value.richText.map((r) => r.text).join('')
    if ('result' in value) return cellText(value.result)
    if ('text' in value) return String(value.text)
    if ('hyperlink' in value) return String(value.text ?? value.hyperlink)
    return ''
  }
  return String(value)
}

/* ============================================================
   PPTX
   ============================================================ */

/**
 * 抽取 PPTX 正文与元数据。
 * @param {Buffer} buf - 文件内容
 * @returns {Promise<{html:string, text:string, meta:object}>} 结果
 */
async function extractPptx(buf) {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(buf)

  // 幻灯片编号可能不是零填充的，按数字排序才不会 1,10,2
  const slideFiles = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slideNo(a) - slideNo(b))

  const slides = []
  for (const name of slideFiles) {
    const xml = await zip.file(name).async('string')
    // <a:t> 是 PowerPoint 里所有可见文本节点
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
      .map((m) => decodeXmlEntities(m[1]).trim())
      .filter(Boolean)
    slides.push(texts)
  }

  let coreMeta = {}
  try {
    const core = zip.file('docProps/core.xml')
    if (core) {
      const xml = await core.async('string')
      const pick = (tag) => {
        const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))
        return m ? decodeXmlEntities(m[1]).trim() : ''
      }
      coreMeta = {
        title: pick('dc:title'),
        author: pick('dc:creator'),
        docCreatedAt: pick('dcterms:created') ? new Date(pick('dcterms:created')).toISOString() : null,
      }
    }
  } catch {
    /* 忽略 */
  }

  const html = slides.map((texts, i) => {
    const body = texts.length
      ? `<ul>${texts.map((t) => `<li>${escHtml(t)}</li>`).join('')}</ul>`
      : '<p class="empty-slide">（本页无文本，可能是纯图片页）</p>'
    return `<section class="slide"><h3>第 ${i + 1} 页</h3>${body}</section>`
  }).join('\n')

  const text = cleanText(slides.map((t, i) => `## 第 ${i + 1} 页\n${t.join('\n')}`).join('\n\n'))

  return { html, text, meta: { ...coreMeta, slides: slides.length } }
}

/**
 * 从幻灯片文件名取编号。
 * @param {string} name - 文件名
 * @returns {number} 编号
 */
function slideNo(name) {
  const m = name.match(/slide(\d+)\.xml$/)
  return m ? Number(m[1]) : 0
}

/* ============================================================
   纯文本
   ============================================================ */

/**
 * 抽取 Markdown / 纯文本 / CSV / 代码。
 *
 * 代码与纯文本同路：直接读 UTF-8，**不做任何清洗** ——
 * 缩进、空行、行尾空白都是代码的一部分，洗掉就失真了。
 *
 * @param {Buffer} buf - 文件内容
 * @param {string} type - 规范化类型
 * @returns {{html:string, text:string, meta:object}} 结果
 */
function extractPlain(buf, type) {
  const raw = buf.toString('utf8')
  if (type === 'csv') {
    const rows = raw.split(/\r?\n/).filter(Boolean).map((line) => line.split(','))
    const html = '<table class="sheet-table"><tbody>'
      + rows.slice(0, 500).map((r) => `<tr>${r.map((c) => `<td>${escHtml(c)}</td>`).join('')}</tr>`).join('')
      + '</tbody></table>'
    return { html, text: cleanText(raw), meta: { rowCount: rows.length } }
  }

  // 代码保留原文（只统一换行为 LF），Markdown/纯文本按清洗规则压缩空白。
  // 两种行为都在 plainTextOf 里，网页编辑走的是同一份实现。
  return { html: '', text: plainTextOf(raw, type), meta: {} }
}

/* ============================================================
   统一入口
   ============================================================ */

/**
 * 抽取单个文件。
 *
 * @param {string} filePath - 文件路径
 * @param {string} type - 规范化类型（detectType 的结果）
 * @returns {Promise<object>} 抽取结果
 */
export async function extractFile(filePath, type) {
  const buf = readFileSync(filePath)

  const base = {
    ok: false,
    type,
    mime: mimeOf(type),
    size: buf.length,
    title: '',
    author: '',
    docCreatedAt: null,
    pages: null,
    text: '',
    html: '',
    error: null,
  }

  if (type === 'doc-legacy' || type === 'xls-legacy' || type === 'ppt-legacy') {
    return {
      ...base,
      error: '旧版 Office 二进制格式（.doc/.xls/.ppt）无法直接解析，'
        + '请先用 Office 或 LibreOffice 另存为 .docx/.xlsx/.pptx 后再入库',
    }
  }

  try {
    if (type === 'pdf') {
      const { pages, meta } = await extractPdf(buf)
      return {
        ...base,
        ok: true,
        pages: meta.pages,
        title: meta.title,
        author: meta.author,
        docCreatedAt: meta.docCreatedAt,
        pageTexts: pages,
        text: cleanText(pages.join('\n\n')).slice(0, MAX_TEXT_CHARS),
      }
    }

    if (type === 'docx') {
      const { html, text, meta } = await extractDocx(buf)
      return { ...base, ok: true, html, text: text.slice(0, MAX_TEXT_CHARS), title: meta.title, author: meta.author, docCreatedAt: meta.docCreatedAt }
    }

    if (type === 'xlsx') {
      const { html, text, meta } = await extractXlsx(buf)
      return { ...base, ok: true, html, text: text.slice(0, MAX_TEXT_CHARS), title: meta.title, author: meta.author, docCreatedAt: meta.docCreatedAt, pages: meta.sheetCount ?? null }
    }

    if (type === 'pptx') {
      const { html, text, meta } = await extractPptx(buf)
      return { ...base, ok: true, html, text: text.slice(0, MAX_TEXT_CHARS), title: meta.title, author: meta.author, docCreatedAt: meta.docCreatedAt, pages: meta.slides ?? null }
    }

    if (type === 'md' || type === 'txt' || type === 'csv' || type === 'code') {
      const { html, text, meta } = extractPlain(buf, type)
      return { ...base, ok: true, html, text: text.slice(0, MAX_TEXT_CHARS), pages: null, ...meta }
    }

    return { ...base, error: `不支持的类型：${type}` }
  } catch (err) {
    return { ...base, error: String(err?.message ?? err) }
  }
}

/**
 * 转义 HTML 特殊字符。
 * @param {string} s - 原始字符串
 * @returns {string} 转义结果
 */
export function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 反转义 XML 实体。
 * @param {string} s - 原始字符串
 * @returns {string} 反转义结果
 */
function decodeXmlEntities(s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
}
