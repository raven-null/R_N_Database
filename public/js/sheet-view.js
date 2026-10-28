/**
 * Excel 表格视图：把入库时解析好的结构化数据画成表格。
 *
 * ## 为什么它比 PDF 好用
 *
 * 表格是**数据**，不是版式。变成 PDF 之后：要缩放拖来拖去、手机上没法看、
 * 复制出来是一堆碎行、想找一行得靠肉眼。画成真表格之后：
 * 表头钉住、能横竖滚动、能整块复制、浏览器自带搜索也照常好用。
 *
 * ## 数据从哪来
 *
 * 入库时 `scripts/lib/sheet.mjs` 已经把 xlsx 解析成一份紧凑模型：
 *   - `cells`: `[行, 列, 值, 数字格式?, 样式?]`（1 起，稀疏，只含有内容的格）
 *   - `merges` / `colWidths` / `rowHeights` / `freeze`
 * 浏览器这边只负责画，不解析 xlsx —— 所以这个视图**不需要任何依赖**，
 * 也不用把几 MB 的 xlsx 下载到前端。
 *
 * ## 大表怎么处理
 *
 * 一次画几万个格子会让浏览器卡住，所以按块渲染（默认 200 行一批），
 * 用户点「继续加载」再看后面。上限在入库时已经截断过了，
 * 这里再截一次是为了防止极端数据把页面拖死。
 *
 * @module public/js/sheet-view
 */

import { apiFetch } from './api.js'
import { esc } from './util.js'

/** 一批渲染多少行。 */
const CHUNK_ROWS = 200

/** 单批渲染的单元格上限（宽表时提前收手）。 */
const CHUNK_CELLS = 6000

/** 默认列宽（Excel 的默认 8.43 字符）与行高（px）。 */
const DEFAULT_COL_PX = 68
const DEFAULT_ROW_PX = 21

/** 单列最宽（px），防止某一列把整表撑爆。 */
const MAX_COL_PX = 420

/**
 * 单元格数字格式 → 显示文本。
 *
 * 只覆盖真实表格里 95% 的情况：百分比、货币、千分位、日期。
 * 不做完整的 Excel 格式引擎 —— 那是个无底洞，而且看数据不需要。
 *
 * @param {*} value - 原始值
 * @param {string} [numFmt] - 数字格式串
 * @returns {string} 显示文本
 */
export function formatCell(value, numFmt) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    if (value.href) return String(value.text ?? value.href)
    return ''
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value !== 'number') {
    const s = String(value)
    // ISO 日期串按格式串显示
    if (numFmt && /[ymd]/i.test(numFmt) && /^\d{4}-\d{2}-\d{2}/.test(s)) {
      return formatDate(s, numFmt)
    }
    return s
  }

  const fmt = numFmt ?? ''

  // 百分比
  if (fmt.includes('%')) {
    const dec = decimalsOf(fmt)
    return `${(value * 100).toFixed(dec)}%`
  }

  // 货币（¥ $ € £ 或 "元"）
  const currency = /[¥$€£]/.exec(fmt)
  if (currency) {
    const dec = fmt.includes('.00') || fmt.includes('.0') ? decimalsOf(fmt) : 0
    return `${currency[0]}${thousands(value, dec)}`
  }

  // 千分位
  if (fmt.includes('#,##0')) {
    return thousands(value, decimalsOf(fmt))
  }

  // 日期序列号（Excel 里存的是数字）
  if (/[ymd]/i.test(fmt) && Number.isFinite(value) && value > 20000 && value < 80000) {
    const ms = (value - 25569) * 86400 * 1000
    return formatDate(new Date(ms).toISOString(), fmt)
  }

  // 普通数字：去掉浮点噪声（0.1+0.2 那种）
  if (Number.isInteger(value)) return String(value)
  return String(Math.round(value * 1e6) / 1e6)
}

/**
 * 从格式串里取小数位数。
 * @param {string} fmt - 格式串
 * @returns {number} 小数位
 */
function decimalsOf(fmt) {
  const m = /\.(0+)/.exec(fmt)
  return m ? m[1].length : 0
}

/**
 * 加千分位。
 * @param {number} n - 数值
 * @param {number} dec - 小数位
 * @returns {string} 文本
 */
function thousands(n, dec) {
  const fixed = Math.abs(n).toFixed(dec)
  const [int, frac] = fixed.split('.')
  const sign = n < 0 ? '-' : ''
  return sign + int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? `.${frac}` : '')
}

/**
 * 按格式串输出日期。
 * @param {string} iso - ISO 时间串
 * @param {string} fmt - 格式串
 * @returns {string} 文本
 */
function formatDate(iso, fmt) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n) => String(n).padStart(2, '0')
  let out = fmt
  if (/yyyy/i.test(out)) out = out.replace(/yyyy/gi, String(d.getFullYear()))
  else if (/yy/i.test(out)) out = out.replace(/yy/gi, p(d.getFullYear() % 100))
  out = out.replace(/mm/g, p(d.getMonth() + 1))
  out = out.replace(/dd/gi, p(d.getDate()))
  out = out.replace(/hh/gi, p(d.getHours()))
  out = out.replace(/ss/gi, p(d.getSeconds()))
  // 格式串里常带引号和反斜杠（`"年"m"月"`），清掉便于阅读
  return out.replace(/["\\]/g, '').replace(/;/g, ' ')
}

/**
 * 挂载表格视图。
 *
 * @param {HTMLElement} container - 容器（阅读页的 #frame）
 * @param {object} opts - { doc }
 * @returns {Promise<{ok:boolean, error?:string}>} 结果
 */
export async function mountSheet(container, opts) {
  const { doc } = opts

  container.innerHTML = '<div class="sheet-loading">正在加载表格…</div>'

  let data
  try {
    data = await apiFetch(`/api/v1/docs/${encodeURIComponent(doc.id)}/preview?view=sheet`)
  } catch (err) {
    container.innerHTML = `<div class="empty">表格视图加载失败：${esc(err.message)}</div>`
    return { ok: false, error: err.message }
  }

  const sheets = data?.sheets ?? []
  if (sheets.length === 0) {
    container.innerHTML = '<div class="empty">这份工作簿没有可显示的表格。</div>'
    return { ok: false, error: '没有工作表' }
  }

  const root = document.createElement('div')
  root.className = 'sheet-view'

  // ---- 顶部：工作表切换 + 说明 ----
  const bar = document.createElement('div')
  bar.className = 'sheet-bar'
  const tabs = document.createElement('div')
  tabs.className = 'sheet-tabs'
  const info = document.createElement('span')
  info.className = 'dim sheet-info'
  bar.append(tabs, info)
  root.append(bar)

  // ---- 表格画布 ----
  const scroll = document.createElement('div')
  scroll.className = 'sheet-scroll'
  root.append(scroll)

  container.innerHTML = ''
  container.append(root)

  if (data.truncated) {
    const warn = document.createElement('div')
    warn.className = 'notice warn sheet-truncated'
    warn.textContent = '这份表格较大，只显示了前面的一部分（完整数据请下载原件或在「原始版式」里查看）。'
    root.insertBefore(warn, scroll)
  }

  let activeIndex = 0

  /**
   * 渲染某个工作表。
   * @param {number} index - 工作表序号
   * @returns {void}
   */
  const renderSheet = (index) => {
    activeIndex = index
    const sheet = sheets[index]

    tabs.innerHTML = sheets.map((s, i) => `
      <button class="sheet-tab${i === index ? ' on' : ''}" data-tab="${i}">${esc(s.name || `工作表${i + 1}`)}</button>
    `).join('')
    tabs.querySelectorAll('.sheet-tab').forEach((btn) => {
      btn.addEventListener('click', () => renderSheet(Number(btn.dataset.tab)))
    })

    info.textContent = `${sheet.rows} 行 × ${sheet.cols} 列`

    // 行索引：col → 单元格条目
    /** @type {Map<number, Map<number, any[]>>} */
    const byRow = new Map()
    for (const entry of sheet.cells ?? []) {
      const [r, c] = entry
      let row = byRow.get(r)
      if (!row) { row = new Map(); byRow.set(r, row) }
      row.set(c, entry)
    }

    // 合并区域：锚点记 rowspan/colspan，被覆盖的格子跳过
    const covered = new Set()
    const anchors = new Map()
    let crossesFreeze = false
    const freezeRows = Math.max(0, Math.min(sheet.freeze?.rows ?? 0, sheet.rows ?? 0))
    for (const [r1, c1, r2, c2] of sheet.merges ?? []) {
      const rowspan = r2 - r1 + 1
      const colspan = c2 - c1 + 1
      anchors.set(`${r1},${c1}`, { rowspan, colspan })
      for (let r = r1; r <= r2; r++) {
        for (let c = c1; c <= c2; c++) {
          if (r === r1 && c === c1) continue
          covered.add(`${r},${c}`)
        }
      }
      // 合并跨过冻结分界时不做冻结：thead 与 tbody 分家会把合并拆坏
      if (freezeRows > 0 && r1 <= freezeRows && r2 > freezeRows) crossesFreeze = true
    }
    const stickyRows = crossesFreeze ? 0 : freezeRows
    const stickyCols = Math.max(0, Math.min(sheet.freeze?.cols ?? 0, sheet.cols ?? 0))

    // 列宽 / 行高（入库时给的是"字符宽"和"磅"，这里换算成像素）
    const colPx = []
    const colLeft = []
    let acc = 0
    for (let c = 1; c <= sheet.cols; c++) {
      const chars = sheet.colWidths?.[c]
      const w = Math.min(Math.round(chars ? chars * 7.5 + 5 : DEFAULT_COL_PX), MAX_COL_PX)
      colPx[c] = w
      colLeft[c] = acc
      acc += w
    }
    const rowPx = (r) => {
      const pt = sheet.rowHeights?.[r]
      return pt ? Math.max(Math.round(pt * 4 / 3), 16) : DEFAULT_ROW_PX
    }

    /**
     * 画一行。
     * @param {number} r - 行号（1 起）
     * @returns {string} tr HTML
     */
    const rowHtml = (r) => {
      const parts = []
      for (let c = 1; c <= sheet.cols; c++) {
        if (covered.has(`${r},${c}`)) continue
        const anchor = anchors.get(`${r},${c}`)
        const entry = byRow.get(r)?.get(c)
        const value = entry?.[2]
        const nf = entry?.[3] ?? undefined
        const st = entry?.[4] ?? undefined

        const cls = ['c']
        if (st?.b) cls.push('b')
        if (st?.i) cls.push('i')
        if (st?.u) cls.push('u')
        if (st?.s) cls.push('s')
        // 数字默认右对齐（与表格软件的习惯一致）
        const isNum = typeof value === 'number'
        if (st?.al) cls.push(`al-${st.al}`)
        else if (isNum) cls.push('num')

        const style = []
        if (st?.bg) style.push(`background:${st.bg}`)
        if (st?.fc) style.push(`color:${st.fc}`)
        if (st?.fs) style.push(`font-size:${Math.min(Math.max(st.fs, 8), 28)}px`)
        if (st?.av) style.push(`vertical-align:${st.av === 'middle' ? 'middle' : st.av === 'top' ? 'top' : 'bottom'}`)
        if (st?.ww) style.push('white-space:pre-wrap')
        if (anchor) {
          if (anchor.colspan > 1) style.push(`/*cs:${anchor.colspan}*/`)
        }
        // 冻结列：钉在左侧
        if (c <= stickyCols) {
          cls.push('frozen-x')
          style.push(`left:${colLeft[c]}px`)
        }

        const span = anchor
          ? `${anchor.colspan > 1 ? ` colspan="${anchor.colspan}"` : ''}${anchor.rowspan > 1 ? ` rowspan="${anchor.rowspan}"` : ''}`
          : ''
        const text = esc(formatCell(value, nf))
        const title = text.length > 40 ? ` title="${esc(text)}"` : ''
        parts.push(`<td class="${cls.join(' ')}"${span}${style.length ? ` style="${style.join(';')}"` : ''}${title}>${text}</td>`)
      }
      const h = rowPx(r)
      return `<tr style="height:${h}px">${parts.join('')}</tr>`
    }

    // ---- 组装 table ----
    const table = document.createElement('table')
    table.className = 'sheet-table-view'

    const colgroup = document.createElement('colgroup')
    for (let c = 1; c <= sheet.cols; c++) {
      const col = document.createElement('col')
      col.style.width = `${colPx[c]}px`
      colgroup.append(col)
    }
    table.append(colgroup)

    if (stickyRows > 0) {
      const thead = document.createElement('thead')
      for (let r = 1; r <= stickyRows; r++) thead.insertAdjacentHTML('beforeend', rowHtml(r))
      table.append(thead)
    }

    const tbody = document.createElement('tbody')
    table.append(tbody)
    scroll.innerHTML = ''
    scroll.append(table)

    let rendered = stickyRows
    let pendingRows = 0

    // 「继续加载」按钮
    const more = document.createElement('button')
    more.className = 'btn ghost sheet-more'
    const updateMore = () => {
      const remain = sheet.rows - rendered
      if (remain <= 0) { more.remove(); return }
      more.textContent = `继续加载（还有 ${remain} 行）`
      if (!more.isConnected) scroll.after(more)
    }

    const appendChunk = () => {
      let cells = 0
      const limit = Math.min(sheet.rows, rendered + CHUNK_ROWS)
      let r = rendered + 1
      const html = []
      for (; r <= limit; r++) {
        html.push(rowHtml(r))
        cells += sheet.cols
        if (cells >= CHUNK_CELLS) { r += 1; break }
      }
      tbody.insertAdjacentHTML('beforeend', html.join(''))
      rendered = r - 1
      updateMore()
    }

    more.addEventListener('click', appendChunk)
    appendChunk()
    if (sheet.rows <= rendered) more.remove()
  }

  // 多工作表时默认可切换；单表也走同一条路径（顶部仍显示名字）
  renderSheet(0)

  return { ok: true, sheetCount: sheets.length, activeIndex }
}
