/**
 * 文件类型识别与**能力表**（零依赖）。
 *
 * 放在 _lib 而不是 scripts/lib：**函数运行时也要用**（上传接口要判断
 * 传上来的文件是不是支持的类型），而函数打包不方便跨出
 * netlify/functions/。scripts/lib/extract.mjs 反过来引用这里，
 * 保证「上传时的判断」与「入库时的判断」是同一套。
 *
 * ## v2：从"扩展名白名单"升级成"能力表"
 *
 * 原来只有一张「扩展名 → 类型」的映射，回答的是"能不能存"。
 * 但实际要回答三个问题：能不能抽正文、网页上怎么显示、能不能编辑。
 * 这三个问题散落在各处的 `if (type === 'pdf')` 分支里，加一种格式要改三处，
 * 还容易漏（`.md` 到底走哪条路？）。现在每种类型只登记一次能力：
 *
 *   extract  —— 抽正文用哪个解析器（null = 抽不出，只能存）
 *   preview  —— 网页上怎么显示（browser / html / sheet / markdown / code / text / none）
 *   editable —— 能否在网页里直接编辑
 *
 * 加一种新格式 = 在 TYPES 里加一行 + 在 EXT_ALIASES 里挂扩展名。
 *
 * ## 支持的边界（已定）
 *
 * 只做**文本资料**：代码、PDF、Word、Excel、PPT、txt、markdown、csv。
 * 不做图片/音频/视频/压缩包存储（zip 只作导入通道，见 ingest 侧）。
 * 私钥与证书类一律拒收 —— 这个库默认还是可能公开的，不适合放。
 *
 * @module netlify/functions/_lib/file-types
 */

/**
 * 类型能力表。
 *
 * `extract` 的取值对应 `extract-text.mjs` 里的解析分支；
 * `preview` 的取值对应 `/docs/{id}/preview` 的渲染方式。
 */
const TYPES = {
  pdf: {
    mime: 'application/pdf',
    extract: 'pdf',
    preview: 'browser',      // 浏览器原生 PDF 阅读器就是最好的预览器
    editable: false,
    label: 'PDF',
  },
  docx: {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extract: 'docx',
    preview: 'html',
    editable: false,
    label: 'Word',
  },
  xlsx: {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extract: 'xlsx',
    preview: 'sheet',
    editable: false,
    label: 'Excel',
  },
  pptx: {
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extract: 'pptx',
    preview: 'html',
    editable: false,
    label: 'PowerPoint',
  },
  md: {
    mime: 'text/markdown; charset=utf-8',
    extract: 'plain',
    preview: 'markdown',
    editable: true,
    label: 'Markdown',
  },
  txt: {
    mime: 'text/plain; charset=utf-8',
    extract: 'plain',
    preview: 'text',
    editable: true,
    label: '纯文本',
  },
  csv: {
    mime: 'text/csv; charset=utf-8',
    extract: 'plain',
    preview: 'text',        // 表格由前端 sheet 视图接管，这里只是兜底
    editable: false,        // 编辑 CSV 需要结构校验，暂不放开门
    label: 'CSV',
  },
  code: {
    mime: 'text/plain; charset=utf-8',
    extract: 'plain',
    preview: 'code',
    editable: true,
    label: '代码',
  },

  /* ---- 旧版 Office：能存，但抽不出正文 ---- */
  'doc-legacy': {
    mime: 'application/msword',
    extract: null,
    preview: 'none',
    editable: false,
    label: 'Word 97-2003',
    legacyHint: '旧版 .doc 无法解析，请另存为 .docx 后重新上传（否则搜不到正文）',
  },
  'xls-legacy': {
    mime: 'application/vnd.ms-excel',
    extract: null,
    preview: 'none',
    editable: false,
    label: 'Excel 97-2003',
    legacyHint: '旧版 .xls 无法解析，请另存为 .xlsx 后重新上传（否则搜不到正文）',
  },
  'ppt-legacy': {
    mime: 'application/vnd.ms-powerpoint',
    extract: null,
    preview: 'none',
    editable: false,
    label: 'PowerPoint 97-2003',
    legacyHint: '旧版 .ppt 无法解析，请另存为 .pptx 后重新上传（否则搜不到正文）',
  },
}

/** 未知类型的兜底能力。 */
const UNKNOWN_TYPE = {
  mime: 'application/octet-stream',
  extract: 'plain',
  preview: 'text',
  editable: false,
  label: '未知',
}

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

/**
 * 明确拒收的扩展名 —— 不是"不认识"，而是**故意不收**，要给出理由。
 *
 * 这些文件要么是二进制灾难（存了也搜不到、预览不了），
 * 要么是安全问题（私钥/证书躺在一个可能公开的库里）。
 */
const REJECTED = {
  '.pem': '私钥/证书类文件不适合放在资料库（库可能公开可见）',
  '.key': '私钥/证书类文件不适合放在资料库',
  '.crt': '证书文件不适合放在资料库',
  '.p12': '证书/密钥容器不适合放在资料库',
  '.pfx': '证书/密钥容器不适合放在资料库',
  '.zip': '压缩包请作为导入：上传后会自动解压其中的文件',
  '.7z': '暂不支持 .7z（线上解不开），请转成 .zip 或解压后上传',
  '.rar': '暂不支持 .rar（线上解不开），请转成 .zip 或解压后上传',
  '.png': '本库只存文本资料，不存图片',
  '.jpg': '本库只存文本资料，不存图片',
  '.jpeg': '本库只存文本资料，不存图片',
  '.mp4': '本库只存文本资料，不存视频',
  '.mp3': '本库只存文本资料，不存音频',
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
 * 取某个类型的完整能力。
 *
 * @param {string} type - 规范化类型（detectType 的结果）
 * @returns {{mime:string, extract:string|null, preview:string, editable:boolean, label:string, legacyHint?:string}} 能力
 */
export function capabilitiesOf(type) {
  return TYPES[type] ?? UNKNOWN_TYPE
}

/**
 * 判断该类型是否可在网页上直接编辑（纯文本类）。
 * @param {string} type - 规范化类型
 * @returns {boolean} 是否可编辑
 */
export function isEditableType(type) {
  return capabilitiesOf(type).editable
}

/**
 * 判断该类型能否抽出正文（不能抽的类型只能存与下载）。
 * @param {string} type - 规范化类型
 * @returns {boolean} 能否抽正文
 */
export function canExtractText(type) {
  return Boolean(capabilitiesOf(type).extract)
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
 * 为什么拒收这个文件？（给上传接口用的明确理由）
 *
 * @param {string} name - 文件名
 * @returns {string|null} 拒收理由；null 表示不是明确拒收的类型
 */
export function rejectionReason(name) {
  return REJECTED[extnameOf(name)] ?? null
}

/**
 * 取 MIME 类型。
 * @param {string} type - 规范化类型
 * @returns {string} MIME
 */
export function mimeOf(type) {
  return capabilitiesOf(type).mime ?? 'application/octet-stream'
}

/**
 * 从文件名推一个兜底标题（去扩展名、把下划线连字符换成空格）。
 * @param {string} name - 文件名
 * @returns {string} 标题
 */
export function titleFromFilename(name) {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? ''
  const noExt = base.replace(/\.[^.]+$/, '')
  return noExt.replace(/[_-]+/g, ' ').trim() || base || '(无标题)'
}

/**
 * 供 UI 展示的"支持哪些类型"清单。
 *
 * 按类别归拢而不是平铺一堆扩展名 —— 用户关心的是"能不能存帮我搜到"，
 * 不是逐个后缀。上传失败提示也用它。
 */
export const SUPPORTED_GROUPS = [
  { label: 'PDF', exts: ['.pdf'] },
  { label: 'Word', exts: ['.docx', '.doc'] },
  { label: 'Excel', exts: ['.xlsx', '.xls'] },
  { label: 'PPT', exts: ['.pptx', '.ppt'] },
  { label: 'Markdown', exts: ['.md', '.markdown'] },
  { label: '纯文本', exts: ['.txt', '.csv'] },
  { label: '代码', exts: ['.java', '.py', '.js', '.ts', '.go', '.rs', '.sql', '.json', '.yaml', '…'] },
]

/** 支持的类型清单（供错误提示与文档使用）。 */
export const SUPPORTED_EXTENSIONS = Object.keys(EXT_ALIASES)
