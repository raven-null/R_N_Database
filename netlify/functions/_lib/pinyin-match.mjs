/**
 * 拼音匹配（服务端）。
 *
 * 拼音串由入库脚本预算好存在文档元数据的 `pinyin` 字段里
 * （见 scripts/lib/pinyin.mjs），这里只做纯字符串匹配，**零依赖** ——
 * 因此可以安全地被打包进 Netlify 函数。
 *
 * 前端的等价实现在 public/js/util.js 里。两边刻意各留一份：
 * 函数打包不能跨出 netlify/functions/，浏览器也不能 import 服务端模块，
 * 与其搞一个两边都用不上的"共享"模块，不如各自就近实现（各约 4 行）。
 *
 * @module netlify/functions/_lib/pinyin-match
 */

/**
 * 判断查询串是否像拼音（纯 ASCII 字母数字，且至少 2 位）。
 *
 * 至少 2 位是刻意的：单字符走拼音几乎能匹配任何标题（「j」），只会添乱。
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
 * @param {object} doc - 文档元数据（需含 pinyin 字段）
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
