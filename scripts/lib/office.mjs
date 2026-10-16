/**
 * Office 文档转 PDF。
 *
 * ## 两条转换路径，按保真度排序
 *
 * 1. **Office 桌面应用自己的引擎**（PowerPoint / Word / Excel）
 *    导出的 PDF 与你在桌面软件里看到的**完全一致** —— 这就是保真度的上限。
 *    走 VBScript 晚绑定调用 COM；用 VBScript 而不是 PowerShell 是因为
 *    PowerShell 会去加载 Office 的 PIA 互操作程序集，而本机那个是坏的
 *    （每次接口查询都报 TYPE_E_CANTLOADLIBRARY 0x80029C4A，
 *     `$app.Presentations` 直接返回 NULL）。VBScript 走纯 IDispatch，绕开 PIA。
 *
 * 2. **LibreOffice**（后备，跨平台）
 *    版式还原不错，但**排版引擎与 PowerPoint 不同**：中文标点挤压、
 *    文本内边距、行距算法都有差异，密集排版的幻灯片会出现文字撑破方框。
 *    实测同一份 34 页 PPT：字体都正确嵌入 MicrosoftYaHei，
 *    但 LibreOffice 版有明显文字溢出，PowerPoint 版没有。
 *
 * 因此默认**优先用 Office 桌面引擎**，不可用时自动退回 LibreOffice。
 * 可用 DOCS_OFFICE_ENGINE=office|libreoffice 强制指定。
 *
 * 未安装任何转换器时全部返回 null，调用方回退到 HTML 降级预览 ——
 * 转换是增强而非硬依赖。
 *
 * @module scripts/lib/office
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** 需要走转换的类型。 */
export const OFFICE_TYPES = new Set(['docx', 'xlsx', 'pptx'])

/** 扩展名 → Office 应用类别。 */
const EXT_TO_KIND = { '.pptx': 'pptx', '.docx': 'docx', '.xlsx': 'xlsx' }

/** 导出脚本（与本源文件同目录）。 */
const VBS_PATH = fileURLToPath(new URL('./office-export.vbs', import.meta.url))

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

/** LibreOffice 探测结果缓存。 */
let cachedSoffice = undefined

/**
 * Office 桌面引擎是否可用。
 * 首次失败后记住结论，避免每个文件都白等一次 COM 超时。
 * @type {boolean|undefined}
 */
let officeComUsable = undefined

/**
 * 查找 LibreOffice 可执行文件。
 * @returns {string|null} 路径，未安装时为 null
 */
export function findLibreOffice() {
  if (cachedSoffice !== undefined) return cachedSoffice
  cachedSoffice = CANDIDATES.find((p) => existsSync(p)) ?? null
  return cachedSoffice
}

/**
 * 清除探测缓存（安装后无需重启进程即可识别）。
 * @returns {void}
 */
export function resetLibreOfficeCache() {
  cachedSoffice = undefined
  officeComUsable = undefined
}

/**
 * 用 Office 桌面应用自己的引擎把文档导出为 PDF。
 *
 * @param {string} filePath - 源文件
 * @param {string} kind - 'pptx' | 'docx' | 'xlsx'
 * @returns {Promise<Buffer|null>} PDF 内容，不可用或失败时 null
 */
async function convertWithOfficeApp(filePath, kind) {
  if (process.platform !== 'win32') return null
  if (officeComUsable === false) return null
  if (!existsSync(VBS_PATH)) return null

  let outDir = null
  try {
    outDir = mkdtempSync(join(tmpdir(), 'rndb-com-'))
    const out = join(outDir, 'out.pdf')

    const { stdout } = await run('cscript.exe', [
      '//nologo', VBS_PATH, kind, filePath, out,
    ], { timeout: 180000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })

    if (existsSync(out)) {
      officeComUsable = true
      return readFileSync(out)
    }

    // 没产出文件 → 记下不可用，后续文件不再浪费时间试
    officeComUsable = false
    void stdout
    return null
  } catch {
    officeComUsable = false
    return null
  } finally {
    if (outDir) {
      try {
        rmSync(outDir, { recursive: true, force: true })
      } catch {
        /* 忽略 */
      }
    }
  }
}

/**
 * 用 LibreOffice 把文件转成 PDF（内部自建临时输出目录）。
 *
 * @param {string} filePath - 源文件路径
 * @returns {Promise<Buffer|null>} PDF 内容，失败或未安装时 null
 */
export async function convertWithLibreOffice(filePath) {
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
 * 把文件转成 PDF —— 优先 Office 桌面引擎，退回 LibreOffice。
 *
 * @param {string} filePath - 源文件路径
 * @param {object} [opts] - { engine: 'office' | 'libreoffice' | 'auto' }
 * @returns {Promise<{pdf:Buffer|null, engine:string}>} PDF 内容与实际使用的引擎
 */
export async function convertToPdfDetailed(filePath, opts = {}) {
  const engine = opts.engine ?? process.env.DOCS_OFFICE_ENGINE ?? 'auto'
  const kind = EXT_TO_KIND[extname(filePath).toLowerCase()]

  if (engine !== 'libreoffice' && kind) {
    const pdf = await convertWithOfficeApp(filePath, kind)
    if (pdf) return { pdf, engine: 'office' }
    if (engine === 'office') return { pdf: null, engine: 'office' }
  }

  const pdf = await convertWithLibreOffice(filePath)
  return { pdf, engine: pdf ? 'libreoffice' : 'none' }
}

/**
 * 把文件转成 PDF（只返回内容，供调用方直接使用）。
 *
 * @param {string} filePath - 源文件路径
 * @param {object} [opts] - { engine }
 * @returns {Promise<Buffer|null>} PDF 内容，失败时 null
 */
export async function convertToPdf(filePath, opts = {}) {
  const { pdf } = await convertToPdfDetailed(filePath, opts)
  return pdf
}

/**
 * 把内存里的字节转成 PDF（先落临时文件再转）。
 *
 * 重建预览件时手上只有 Blobs 里的字节，没有源文件路径，
 * 所以需要这一层。
 *
 * @param {Buffer|ArrayBuffer|Uint8Array} data - 文件内容
 * @param {string} ext - 扩展名（不含点，如 'pptx'）
 * @param {object} [opts] - { engine }
 * @returns {Promise<Buffer|null>} PDF 内容，失败时 null
 */
export async function convertBytesToPdf(data, ext, opts = {}) {
  const { pdf } = await convertBytesToPdfDetailed(data, ext, opts)
  return pdf
}

/**
 * 同 convertBytesToPdf，但额外返回**实际使用的引擎**。
 *
 * 引擎差异对用户可见（Office 桌面引擎与 LibreOffice 的排版结果不同），
 * 因此调用方需要把引擎记进元数据、在网页上如实告知。
 *
 * @param {Buffer|ArrayBuffer|Uint8Array} data - 文件内容
 * @param {string} ext - 扩展名（不含点，如 'pptx'）
 * @param {object} [opts] - { engine }
 * @returns {Promise<{pdf:Buffer|null, engine:string}>} PDF 内容与引擎
 */
export async function convertBytesToPdfDetailed(data, ext, opts = {}) {
  const safeExt = String(ext || 'bin').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin'
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)

  let tmp = null
  try {
    tmp = mkdtempSync(join(tmpdir(), 'rndb-office-'))
    const src = join(tmp, `input.${safeExt}`)
    writeFileSync(src, buf)
    return await convertToPdfDetailed(src, opts)
  } catch {
    return { pdf: null, engine: 'none' }
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
 * 给出转换器的人话状态说明（供 CLI 输出与构建校验使用）。
 * @returns {string} 状态描述
 */
export function officeEngineStatus() {
  const parts = []
  if (process.platform === 'win32' && existsSync(VBS_PATH)) {
    parts.push('Office 桌面引擎（保真度最高，与桌面软件所见一致）')
  }
  const lo = findLibreOffice()
  if (lo) parts.push(`LibreOffice 后备（${lo}）`)

  if (parts.length === 0) {
    return '不可用 —— Office 文档只能走 HTML 降级预览，版式会丢失'
  }
  return `可用：${parts.join('；')}`
}
