/**
 * 把 XLSX 解析成「可渲染的表格模型」。
 *
 * ## 为什么不用通用预览库
 *
 * 表格本来就是**数据**，不是版式。把它变成 PDF 是最别扭的做法：
 * 屏幕上看要缩放拖来拖去、手机上没法看、复制出来是一堆碎行。
 * 解析成结构化单元格后，网页里能做成表头吸顶、可滚动、可整块复制，
 * 而且**不产生 PDF，也就不需要 Office 或 LibreOffice**。
 *
 * ## 只存"能看"的部分
 *
 * 刻意不做的事（做了会掉进无底洞，且对"看数据"没有帮助）：
 *   - 不计算公式（Excel 已经把结果缓存进文件，直接读缓存值即可）
 *   - 不做条件格式 / 数据验证 / 批注 / 冻结以外的视图设置
 *   - 不存边框（表框由 CSS 画，存下来只是把文件撑大）
 *
 * 保留的是真正影响可读性的：值、数字格式（金额/百分比/日期）、
 * 粗体/斜体、字体色、填充色、对齐方式、合并、列宽、行高、冻结窗格。
 *
 * ## 体积
 *
 * 单元格用定长数组 `[行, 列, 值, 数字格式?, 样式?]` 编码，
 * 空值和默认样式直接省略。个人资料库的表格通常几十 KB。
 * 但会有超大表（几万行），所以有硬上限 + 字节预算，超出就截断并在
 * 元数据里说明 —— 宁可明确说"只显示了一部分"，也不要静默卡死浏览器。
 *
 * @module scripts/lib/sheet
 */

/** 每个工作表最多保留的行/列。 */
const MAX_ROWS = 1000
const MAX_COLS = 60

/** 整本工作簿的单元格上限（超出就不再收）。 */
const MAX_CELLS = 40_000

/** 单本工作簿的模型字节预算（Netlify Blobs 单个值有上限，且前端要下载）。 */
const MAX_JSON_BYTES = 3 * 1024 * 1024

/** 最多保留的工作表数量。 */
const MAX_SHEETS = 12

/**
 * ExcelJS 的 ARGB 颜色 → `#rrggbb`。
 * @param {object|null} color - ExcelJS 颜色对象
 * @returns {string|undefined} CSS 颜色
 */
function cssColor(color) {
  const argb = color?.argb
  if (typeof argb !== 'string') return undefined
  const rgb = argb.length === 8 ? argb.slice(2) : argb
  if (!/^[0-9a-fA-F]{6}$/.test(rgb)) return undefined
  return `#${rgb.toLowerCase()}`
}

/**
 * 收集单元格样式（只收影响可读性的）。
 *
 * 关于黑/白的取舍：纯白填充等于「没填」，直接丢掉；纯黑文字在**没有填充**
 * 时等于默认文字色，也丢掉。但白字配深色底（标题栏那种）必须留下，
 * 否则渲染出来是一片看不见的深色底 —— 这里踩过一次，
 * 一开始无脑丢掉纯白/纯黑，结果深色标题栏的白字全消失了。
 *
 * @param {object} cell - ExcelJS 单元格
 * @returns {object|undefined} 样式对象；无特殊样式时返回 undefined
 */
function styleOf(cell) {
  const st = {}
  const f = cell.font ?? {}
  const fill = cell.fill
  let bg
  if (fill?.type === 'pattern' && fill.pattern !== 'none') {
    const c = cssColor(fill.fgColor)
    if (c && c !== '#ffffff') bg = c
  }

  if (bg) st.bg = bg

  const fc = cssColor(f.color)
  if (fc && !(fc === '#000000' && !bg)) st.fc = fc

  if (f.bold) st.b = 1
  if (f.italic) st.i = 1
  if (f.underline) st.u = 1
  if (f.strike) st.s = 1
  const size = typeof f.size === 'number' && f.size > 0 ? f.size : null
  if (size && size !== 11) st.fs = size

  const al = cell.alignment ?? {}
  if (al.horizontal && al.horizontal !== 'general') st.al = al.horizontal
  if (al.vertical && al.vertical !== 'bottom') st.av = al.vertical
  if (al.wrapText) st.ww = 1

  return Object.keys(st).length ? st : undefined
}

/**
 * 把 ExcelJS 的单元格值转成可 JSON 化的原始值。
 *
 * 日期转 ISO 字符串（保留时分秒信息，前端按 numFmt 决定显示成什么）；
 * 公式取**缓存结果**（Excel 存文件时已经把算好的值写进去了）；
 * 富文本拼接；超链接保留文字与地址。
 *
 * @param {*} value - ExcelJS 单元格值
 * @returns {string|number|boolean|object|null} 原始值
 */
function rawValue(value) {
  if (value === null || value === undefined) return null

  if (value instanceof Date) {
    const iso = value.toISOString()
    // 纯日期（时分秒全 0）只留日期部分，省体积也让显示更自然
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    // 超长文本（备注、地址）截断：整段塞进来对"看表"没有帮助
    if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`
    return value
  }
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) {
      return value.richText.map((r) => r.text ?? '').join('')
    }
    // 公式：{ formula, result }
    if ('result' in value) return rawValue(value.result)
    // 超链接：{ text, hyperlink }
    if ('hyperlink' in value) {
      return { href: String(value.hyperlink), text: String(value.text ?? value.hyperlink) }
    }
    if ('error' in value) return String(value.error)
    if ('text' in value) return String(value.text)
  }
  return null
}

/**
 * 解析合并区域字符串（`A1:B2`）为 `[行1, 列1, 行2, 列2]`（1 起）。
 * @param {string} ref - 合并引用
 * @returns {number[]|null} 合并范围
 */
function parseMerge(ref) {
  const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(String(ref ?? '').toUpperCase())
  if (!m) return null
  const colOf = (letters) => {
    let n = 0
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
    return n
  }
  return [Number(m[2]), colOf(m[1]), Number(m[4]), colOf(m[3])]
}

/**
 * 构建整本工作簿的表格模型。
 *
 * @param {Buffer|ArrayBuffer} buf - xlsx 文件内容
 * @returns {Promise<{ok:boolean, model:object|null, error?:string, stats:object}>} 结果
 */
export async function buildSheetModel(buf) {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()

  try {
    await wb.xlsx.load(buf)
  } catch (err) {
    return { ok: false, model: null, error: String(err?.message ?? err), stats: {} }
  }

  const sheets = []
  let cellBudget = MAX_CELLS
  let truncated = false

  for (const sheet of wb.worksheets) {
    if (sheets.length >= MAX_SHEETS) { truncated = true; break }
    if (cellBudget <= 0) { truncated = true; break }

    // ★ 用 eachRow/eachCell 逐**存在的**单元格遍历，而不是按
    // actualRowCount/actualColumnCount 铺一个矩形去 getCell。
    // 后者会漏列：实测一个带 H 列的工作簿，actualColumnCount 只报 7，
    // H 列整列被吞掉（用户会以为数据丢了）。稀疏遍历既不会漏，也更快。
    const rowsSeen = new Set()
    const collected = []
    let maxRow = 0
    let maxCol = 0
    let outOfRange = false

    sheet.eachRow({ includeEmpty: false }, (row, r) => {
      if (cellBudget <= 0) return
      if (r > MAX_ROWS) { outOfRange = true; return }
      row.eachCell({ includeEmpty: false }, (cell, c) => {
        if (cellBudget <= 0) return
        if (c > MAX_COLS) { outOfRange = true; return }
        const value = rawValue(cell.value)
        const st = styleOf(cell)
        if (value === null && !st) return

        const nf = typeof cell.numFmt === 'string' && cell.numFmt ? cell.numFmt : undefined
        // 逐级截短：[行, 列, 值] → [+ 数字格式] → [+ 样式]
        const entry = [r, c, value]
        if (nf) entry[3] = nf
        else if (st) entry[3] = null
        if (st) entry[4] = st

        collected.push(entry)
        cellBudget -= 1
        rowsSeen.add(r)
        if (r > maxRow) maxRow = r
        if (c > maxCol) maxCol = c
      })
    })

    if (outOfRange) truncated = true
    if (collected.length === 0) continue

    const totalRows = Math.min(maxRow, MAX_ROWS)
    const totalCols = Math.min(maxCol, MAX_COLS)

    // 合并区域：先解析，再把「被合并覆盖的从属格」从数据里剔掉。
    // ExcelJS 会把合并区的每个格都返回主格的值，不去重就会看到
    // 同一句标题在 5 个格里重复（表格里也会渲染成 5 份）。
    const merges = []
    const covered = new Set()
    for (const ref of sheet.model?.merges ?? []) {
      const m = parseMerge(ref)
      if (!m) continue
      if (m[0] > totalRows || m[1] > totalCols) continue
      const r2 = Math.min(m[2], totalRows)
      const c2 = Math.min(m[3], totalCols)
      if (r2 === m[0] && c2 === m[1]) continue   // 单格"合并"等于没合并
      merges.push([m[0], m[1], r2, c2])
      for (let r = m[0]; r <= r2; r++) {
        for (let c = m[1]; c <= c2; c++) {
          if (r === m[0] && c === m[1]) continue
          covered.add(`${r},${c}`)
        }
      }
    }

    const cells = covered.size
      ? collected.filter((e) => !covered.has(`${e[0]},${e[1]}`))
      : collected

    // 列宽 / 行高（只保留被显式设置过的）
    const colWidths = {}
    for (let c = 1; c <= totalCols; c++) {
      const w = sheet.getColumn(c)?.width
      if (typeof w === 'number' && w > 0) colWidths[c] = Math.round(w * 10) / 10
    }
    const rowHeights = {}
    for (const r of rowsSeen) {
      const h = sheet.getRow(r)?.height
      if (typeof h === 'number' && h > 0) rowHeights[r] = Math.round(h * 10) / 10
    }

    // 冻结窗格
    const view = (sheet.views ?? [])[0] ?? {}
    const freeze = view.state === 'frozen' || view.state === 'frozenSplit'
      ? { rows: Number(view.ySplit) || 0, cols: Number(view.xSplit) || 0 }
      : null

    sheets.push({
      name: sheet.name,
      rows: totalRows,
      cols: totalCols,
      cells,
      colWidths: Object.keys(colWidths).length ? colWidths : undefined,
      rowHeights: Object.keys(rowHeights).length ? rowHeights : undefined,
      merges: merges.length ? merges : undefined,
      freeze: freeze && (freeze.rows || freeze.cols) ? freeze : null,
    })
  }

  if (sheets.length === 0) {
    return {
      ok: false,
      model: null,
      error: '工作簿里没有可显示的内容（可能是空表或只有图表）',
      stats: {},
    }
  }

  const model = { version: 1, sheets, truncated }
  let json = JSON.stringify(model)

  // 字节预算：超了就整表丢弃（从最后一张开始），而不是截半张表
  while (Buffer.byteLength(json, 'utf8') > MAX_JSON_BYTES && model.sheets.length > 1) {
    model.sheets.pop()
    model.truncated = true
    json = JSON.stringify(model)
  }

  return {
    ok: true,
    model,
    stats: {
      sheetCount: sheets.length,
      sheetNames: sheets.map((s) => s.name),
      cells: sheets.reduce((a, s) => a + s.cells.length, 0),
      bytes: Buffer.byteLength(json, 'utf8'),
      truncated: model.truncated,
      limits: { rows: MAX_ROWS, cols: MAX_COLS, cells: MAX_CELLS },
    },
  }
}
