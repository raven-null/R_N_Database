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

  // ---- 代码 / 配置：只存与编辑，**不执行** ----
  '.js': 'code', '.mjs': 'code', '.cjs': 'code', '.jsx': 'code',
  '.ts': 'code', '.mts': 'code', '.cts': 'code', '.tsx': 'code',
  '.vue': 'code', '.svelte': 'code', '.astro': 'code',
  '.py': 'code', '.pyi': 'code', '.ipynb': 'code',
  '.java': 'code', '.kt': 'code', '.kts': 'code', '.scala': 'code', '.groovy': 'code',
  '.c': 'code', '.h': 'code', '.cpp': 'code', '.hpp': 'code', '.cc': 'code', '.cxx': 'code',
  '.cs': 'code', '.go': 'code', '.rs': 'code', '.rb': 'code', '.php': 'code',
  '.swift': 'code', '.m': 'code', '.mm': 'code', '.dart': 'code', '.lua': 'code', '.r': 'code',
  '.sh': 'code', '.bash': 'code', '.zsh': 'code', '.fish': 'code',
  '.ps1': 'code', '.psm1': 'code', '.bat': 'code', '.cmd': 'code',
  '.sql': 'code',
  '.html': 'code', '.htm': 'code', '.css': 'code', '.scss': 'code', '.sass': 'code', '.less': 'code',
  '.json': 'code', '.jsonc': 'code', '.json5': 'code',
  '.yaml': 'code', '.yml': 'code', '.toml': 'code', '.ini': 'code', '.cfg': 'code', '.conf': 'code',
  '.xml': 'code', '.gradle': 'code', '.mk': 'code',
  '.proto': 'code', '.graphql': 'code', '.gql': 'code',
  '.tex': 'code', '.diff': 'code', '.patch': 'code',
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
  code: 'text/plain; charset=utf-8',
  'doc-legacy': 'application/msword',
  'xls-legacy': 'application/vnd.ms-excel',
  'ppt-legacy': 'application/vnd.ms-powerpoint',
}

/**
 * 扩展名 → highlight.js 语言名。
 *
 * 与 EXT_ALIASES 分开：那里只回答「能不能存」，这里回答「按什么语法高亮」。
 * 认不出的语言回退为纯文本 —— 不会因为多一个没登记的后缀就打不开。
 */
const EXT_TO_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  vue: 'xml', svelte: 'xml', astro: 'xml',
  py: 'python', pyi: 'python', ipynb: 'json',
  java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', groovy: 'groovy',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', cxx: 'cpp',
  cs: 'csharp', go: 'go', rs: 'rust', rb: 'ruby', php: 'php',
  swift: 'swift', m: 'objectivec', mm: 'objectivec', dart: 'dart', lua: 'lua', r: 'r',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  ps1: 'powershell', psm1: 'powershell', bat: 'dos', cmd: 'dos',
  sql: 'sql',
  html: 'xml', htm: 'xml', xml: 'xml',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  json: 'json', jsonc: 'json', json5: 'json',
  yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
  gradle: 'groovy', mk: 'makefile',
  proto: 'protobuf', graphql: 'graphql', gql: 'graphql',
  tex: 'latex', diff: 'diff', patch: 'diff',
}

/**
 * 取 highlight.js 语言名。
 * @param {string} ext - 扩展名（可带点，如 '.ts'）
 * @returns {string|null} 语言名，认不出时为 null（按纯文本渲染）
 */
export function highlightLangOf(ext) {
  const e = String(ext ?? '').replace(/^\./, '').toLowerCase()
  return EXT_TO_LANG[e] ?? null
}

/**
 * 判断该类型是否可在网页上直接编辑（纯文本类）。
 * @param {string} type - 规范化类型
 * @returns {boolean} 是否可编辑
 */
export function isEditableType(type) {
  return type === 'code' || type === 'md' || type === 'txt'
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
