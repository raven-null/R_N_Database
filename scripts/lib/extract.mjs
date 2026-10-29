/**
 * 正文与元数据抽取（脚本侧入口）。
 *
 * ## 实现已经搬到 `netlify/functions/_lib/extract-text.mjs`
 *
 * 原因见那边的说明：新增「服务端一键入库」之后，函数也要能抽正文，
 * 而函数不能 import 到 scripts/ 里。与其抄两份（同一个文件在本地入库
 * 与服务端入库会得到不同的正文/页数），不如整体搬进 _lib，这里只留一层
 * 「读文件 + 交给共享实现」的小包装 —— 脚本里所有调用点一行都不用改。
 *
 * 这也是 marked（markdown-view）与 cleanText（plain-text）走过的同一条路。
 *
 * @module scripts/lib/extract
 */

import { readFileSync } from 'node:fs'

import { extractBytes } from '../../netlify/functions/_lib/extract-text.mjs'

export {
  detectType,
  mimeOf,
  titleFromFilename,
  canExtractText,
  isJunkTitle,
  pickTitle,
  escHtml,
  extractBytes,
} from '../../netlify/functions/_lib/extract-text.mjs'

/**
 * 抽取单个文件（脚本侧：从磁盘读）。
 *
 * @param {string} filePath - 文件路径
 * @param {string} type - 规范化类型（detectType 的结果）
 * @returns {Promise<object>} 抽取结果
 */
export async function extractFile(filePath, type) {
  return extractBytes(readFileSync(filePath), type)
}
