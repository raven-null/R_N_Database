/**
 * 通用工具：转义、格式化、类型图标。
 * @module public/js/util
 */

/**
 * HTML 转义（所有插入 DOM 的服务端数据都必须过这里）。
 * @param {*} value - 任意值
 * @returns {string} 转义后的字符串
 */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 人类可读的文件体积。
 * @param {number} bytes - 字节数
 * @returns {string} 如 "1.2 MB"
 */
export function fmtSize(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/**
 * 格式化日期为 YYYY-MM-DD。
 * @param {string} iso - ISO 字符串
 * @returns {string} 日期，或空串
 */
export function fmtDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 类型 → 显示名与色标。 */
const TYPE_INFO = {
  pdf: { label: 'PDF', color: '#e5484d' },
  docx: { label: 'DOCX', color: '#2b6cb0' },
  xlsx: { label: 'XLSX', color: '#2f855a' },
  pptx: { label: 'PPTX', color: '#c05621' },
  md: { label: 'MD', color: '#6b7280' },
  txt: { label: 'TXT', color: '#6b7280' },
  csv: { label: 'CSV', color: '#2f855a' },
  'doc-legacy': { label: 'DOC', color: '#94a3b8' },
  'xls-legacy': { label: 'XLS', color: '#94a3b8' },
  'ppt-legacy': { label: 'PPT', color: '#94a3b8' },
}

/**
 * 取类型信息。
 * @param {string} type - 规范化类型
 * @returns {{label:string,color:string}} 类型信息
 */
export function typeInfo(type) {
  return TYPE_INFO[type] ?? { label: String(type ?? '?').toUpperCase(), color: '#6b7280' }
}

/**
 * 生成类型徽标 HTML。
 * @param {string} type - 类型
 * @returns {string} HTML
 */
export function typeBadge(type) {
  const info = typeInfo(type)
  return `<span class="type-badge" style="--tc:${info.color}">${esc(info.label)}</span>`
}

/**
 * 让输入防抖。
 * @param {Function} fn - 目标函数
 * @param {number} [ms] - 延迟毫秒
 * @returns {Function} 包装后的函数
 */
export function debounce(fn, ms = 180) {
  let timer = null
  return (...args) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}

/**
 * 取 URL 查询参数。
 * @param {string} name - 参数名
 * @returns {string} 值或空串
 */
export function param(name) {
  return new URLSearchParams(location.search).get(name) ?? ''
}

/* ============================================================
   拼音匹配
   ============================================================ */

/**
 * 判断查询串是否像拼音（纯 ASCII 字母数字，至少 2 位）。
 *
 * 至少 2 位是刻意的：单字符走拼音几乎能匹配任何标题（「j」），只会添乱。
 *
 * 服务端有一份等价实现（netlify/functions/_lib/pinyin-match.mjs）。
 * 刻意各留一份：函数打包不能跨出 netlify/functions/，浏览器也不能
 * import 服务端模块，搞一个两边都用不上的"共享"模块没有意义。
 *
 * @param {string} q - 查询串
 * @returns {boolean} 是否按拼音匹配
 */
export function looksLikePinyin(q) {
  const s = String(q ?? '').trim().toLowerCase()
  return s.length >= 2 && /^[a-z0-9]+$/.test(s)
}

/**
 * 判断文档是否匹配拼音查询。
 *
 * 拼音串由入库时算好存在元数据里，因此前端无需加载 pinyin-pro
 * （图库项目为此加载了 315KB）。
 *
 * @param {object} doc - 文档元数据
 * @param {string} q - 查询串
 * @returns {boolean} 是否命中
 */
export function matchesPinyin(doc, q) {
  if (!looksLikePinyin(q)) return false
  const p = doc?.pinyin
  if (!p) return false
  const s = String(q).trim().toLowerCase()
  return String(p.full ?? '').includes(s) || String(p.initials ?? '').includes(s)
}
