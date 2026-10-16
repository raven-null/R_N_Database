/**
 * Office 文档转 PDF（LibreOffice 无头模式）。
 *
 * 为什么需要它：docx / xlsx / pptx 的版式靠形状定位与主题，
 * 靠抽取文字永远还原不了 —— 实测一份 21 页的 PPT 走 HTML 降级后
 * 只剩一堆 <li>，图片、图表、配色、排版全丢。
 * LibreOffice 是目前唯一能本地、离线、免费做到高保真转换的方案。
 *
 * 抽成独立模块的理由：**入库**与**重建预览件**都需要它。
 * 原先它内联在 ingest.mjs 里，reclassify 想用只能复制一份。
 *
 * 未安装 LibreOffice 时所有函数返回 null，调用方回退到 HTML 降级 ——
 * 转换是增强而非硬依赖。
 *
 * @module scripts/lib/office
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** 需要走 LibreOffice 转换的类型。 */
export const OFFICE_TYPES = new Set(['docx', 'xlsx', 'pptx'])

/** LibreOffice 可执行文件的常见位置。 */
const CANDIDATES = process.platform === 'win32'
  ? [
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    ]
  : [
      '/usr/bin/soffice',
      '/usr/local/bin/soffice',
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    ]

/** 探测结果缓存（同一进程内不必反复查磁盘）。 */
let cached = undefined

/**
 * 查找 LibreOffice 可执行文件。
 * @returns {string|null} 路径，未安装时为 null
 */
export function findLibreOffice() {
  if (cached !== undefined) return cached
  cached = CANDIDATES.find((p) => existsSync(p)) ?? null
  return cached
}

/**
 * 清除探测缓存（安装后无需重启进程即可识别）。
 * @returns {void}
 */
export function resetLibreOfficeCache() {
  cached = undefined
}

/**
 * 把文件转成 PDF（内部自建临时输出目录）。
 *
 * @param {string} filePath - 源文件路径
 * @returns {Promise<Buffer|null>} PDF 内容，失败或未安装时 null
 */
export async function convertToPdf(filePath) {
  const soffice = findLibreOffice()
  if (!soffice) return null

  let outDir = null
  try {
    outDir = mkdtempSync(join(tmpdir(), 'rndb-pdf-'))
    await run(soffice, [
      '--headless', '--norestore', '--invisible', '--nolockcheck',
      '--convert-to', 'pdf',
      '--outdir', outDir,
      filePath,
    ], { timeout: 180000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })

    const expected = join(outDir, basename(filePath).replace(/\.[^.]+$/, '.pdf'))
    return existsSync(expected) ? readFileSync(expected) : null
  } catch {
    // 转换失败（文件损坏、缺字体、超时）不该让入库失败 —— 调用方会回退
    return null
  } finally {
    if (outDir) {
      try {
        rmSync(outDir, { recursive: true, force: true })
      } catch {
        /* 临时目录被占用时忽略，系统会回收 */
      }
    }
  }
}

/**
 * 把内存里的字节转成 PDF（先落临时文件再转）。
 *
 * 重建预览件时手上只有 Blobs 里的字节，没有源文件路径，
 * 所以需要这一层。
 *
 * @param {Buffer|ArrayBuffer|Uint8Array} data - 文件内容
 * @param {string} ext - 扩展名（不含点，如 'pptx'）
 * @returns {Promise<Buffer|null>} PDF 内容，失败时 null
 */
export async function convertBytesToPdf(data, ext) {
  if (!findLibreOffice()) return null

  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
  let tmp = null
  try {
    tmp = mkdtempSync(join(tmpdir(), 'rndb-office-'))
    const safeExt = String(ext || 'bin').replace(/[^a-z0-9]/gi, '') || 'bin'
    const src = join(tmp, `input.${safeExt}`)
    writeFileSync(src, buf)
    return await convertToPdf(src)
  } catch {
    return null
  } finally {
    if (tmp) {
      try {
        rmSync(tmp, { recursive: true, force: true })
      } catch {
        /* 忽略 */
      }
    }
  }
}

/**
 * 判断某类型是否需要（且能够）转 PDF。
 * @param {string} type - 规范化类型
 * @returns {boolean} 是否走转换
 */
export function needsPdfConversion(type) {
  return OFFICE_TYPES.has(type)
}

/**
 * 给出 LibreOffice 的人话状态说明（供 CLI 输出）。
 * @returns {string} 状态描述
 */
export function libreOfficeStatus() {
  const p = findLibreOffice()
  return p
    ? `已安装（${p}）—— Office 文档转高保真 PDF`
    : '未安装 —— Office 文档只能走 HTML 降级预览，版式会丢失'
}
