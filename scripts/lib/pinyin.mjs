/**
 * 标题拼音化（供拼音检索）。
 *
 * ## 为什么在入库时算，而不是前端加载 pinyin-pro
 *
 * 浏览器端方案要加载 315KB 的 pinyin-pro（图库项目就是这么做的）。
 * 但拼音只是「标题 → 两个字符串」的确定性变换，完全可以入库时算好存进元数据：
 *   - 前端零依赖、零加载、零延迟
 *   - 拼音串随 manifest 一起下发，体积极小
 *   - 检索逻辑是纯字符串匹配，任何端（网页/工作站/博客）都能用
 *
 * 只对**含中文**的标题计算：纯英文标题（如 `README`、`events`）本身
 * 就能被直接搜到，再存一份拼音纯属浪费。
 *
 * @module scripts/lib/pinyin
 */

import { pinyin } from 'pinyin-pro'

/** CJK 字符集。 */
const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/

/**
 * 计算标题的拼音形式。
 *
 * @param {string} text - 标题（可含数字、英文）
 * @returns {{full:string, initials:string}|null} 全拼与首字母，无中文时返回 null
 */
export function pinyinForms(text) {
  const t = String(text ?? '').trim()
  if (!t || !CJK_RE.test(t)) return null

  try {
    const full = pinyin(t, { toneType: 'none', type: 'array' }).join('').toLowerCase()
    const initials = pinyin(t, { pattern: 'first', toneType: 'none', type: 'array' })
      .join('').toLowerCase()

    // 去掉非字母数字，避免标点混进检索串
    const clean = (s) => s.replace(/[^a-z0-9]/g, '')
    return { full: clean(full), initials: clean(initials) }
  } catch {
    // 拼音只是增强，失败不该影响入库
    return null
  }
}

/**
 * 判断查询串是否像拼音（纯 ASCII 字母数字）。
 *
 * 实现放在 netlify/functions/_lib/pinyin-match.mjs（零依赖，函数端也要用），
 * 这里只做转出，保证「入库时怎么算」和「检索时怎么匹配」用的是同一套判定。
 */
export { looksLikePinyin, matchesPinyin } from '../../netlify/functions/_lib/pinyin-match.mjs'
