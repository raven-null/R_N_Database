/**
 * 文件类型识别（零依赖）。
 *
 * 放在 _lib 而不是 scripts/lib：**函数运行时也要用**（上传接口要判断
 * 传上来的文件是不是支持的类型），而函数打包不方便跨出
 * netlify/functions/。scripts/lib/extract.mjs 反过来引用这里，
 * 保证「上传时的判断」与「入库时的判断」是同一套。
 *
 * @module netlify/functions/_lib/file-types
 */

/** 扩展名 → 规范化类型。 */
const EXT_ALIASES = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.doc': 'doc-legacy',
  '.xlsx': 'xlsx',
  '.xls': 'xls-legacy',
  '.pptx': 'pptx',
  '.ppt': 'ppt-legacy',
  '.md': 'md',
  '.markdown': 'md',
  '.txt': 'txt',
  '.csv': 'csv',
}

/** 类型 → MIME。 */
const MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  'doc-legacy': 'application/msword',
  'xls-legacy': 'application/vnd.ms-excel',
  'ppt-legacy': 'application/vnd.ms-powerpoint',
}

/**
 * 取扩展名（小写，含点）。只处理文件名，不碰文件系统。
 * @param {string} name - 文件名或路径
 * @returns {string} 扩展名，如 '.pdf'；无扩展名时为空串
 */
export function extnameOf(name) {
  const s = String(name ?? '')
  const base = s.split(/[\\/]/).pop() ?? ''
  const at = base.lastIndexOf('.')
  return at > 0 ? base.slice(at).toLowerCase() : ''
}

/**
 * 识别文件类型。
 * @param {string} name - 文件名或路径
 * @returns {string|null} 规范化类型，或 null 表示不支持
 */
export function detectType(name) {
  return EXT_ALIASES[extnameOf(name)] ?? null
}

/**
 * 取 MIME 类型。
 * @param {string} type - 规范化类型
 * @returns {string} MIME
 */
export function mimeOf(type) {
  return MIME[type] ?? 'application/octet-stream'
}

/**
 * 从文件名推一个兜底标题（去扩展名、把下划线连字符换成空格）。
 * @param {string} name - 文件名或路径
 * @returns {string} 标题
 */
export function titleFromFilename(name) {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? ''
  const noExt = base.replace(/\.[^.]+$/, '')
  return noExt.replace(/[_-]+/g, ' ').trim() || base || '(无标题)'
}

/** 支持的类型清单（供错误提示与文档使用）。 */
export const SUPPORTED_EXTENSIONS = Object.keys(EXT_ALIASES)
