/**
 * 从 `sourcePath` 推出「来源目录」，供按目录浏览。
 *
 * ## 为什么需要它
 *
 * 这个库的模型是**扁平**的：文档按分类与标签组织，没有目录层级。
 * 但真实资料往往是按文件夹整理的（`E:\学习\资料`、`学习/Java/学习`），
 * 导入之后人就找不到"我刚导进去的那批东西"。
 *
 * 每份文档在入库时其实都记了来源（`sourcePath`），只是从没露出来。
 * 这里把它规整成一个可直接做前缀筛选的目录字符串。
 *
 * ## 两种来源，统一成一种形状
 *
 *   `E:\学习\资料\阿里巴巴编码规范.pdf`  → `E:/学习/资料`
 *   `upload://资料/合同/2025/xx.pdf`      → `上传/资料/合同/2025`
 *
 * 后者把 `upload://` 换成中文根名 `上传` —— 只是**展示用的归一化**，
 * 目的是让两种来源能共用同一套"斜杠路径"的树与筛选逻辑；
 * 存储里的 `sourcePath` 保持原样不动。
 *
 * ## 为什么在这层做而不是存进元数据
 *
 * 目录是 `sourcePath` 的派生值。存一份就意味着两者可能不一致
 * （改了来源路径忘了更新目录），读时算一次最省心。
 *
 * @module netlify/functions/_lib/source-dir
 */

/** 网页上传来源的虚拟根名（避免 `upload://` 里的空段把树搞乱）。 */
const UPLOAD_ROOT = '上传'

/**
 * 取来源目录。
 *
 * @param {string} sourcePath - 元数据里的 sourcePath
 * @returns {string} 斜杠分隔的目录；认不出时返回空串
 */
export function dirOf(sourcePath) {
  const raw = String(sourcePath ?? '').trim()
  if (!raw) return ''

  // 网页上传：upload://相对路径（先摘前缀，避免 `//` 被下面的折叠吃掉）
  if (raw.startsWith('upload://')) {
    const rel = raw.slice('upload://'.length).replace(/\\/g, '/')
    const parts = rel.split('/').filter(Boolean)
    parts.pop()                                  // 去掉文件名，只留目录
    return parts.length ? [UPLOAD_ROOT, ...parts].join('/') : UPLOAD_ROOT
  }

  // 本机路径：统一分隔符、折叠重复分隔符、去掉尾部分隔符
  // （`E:\\学习\\资料` 这种双反斜杠在 Windows 上也合法，不折叠会得到 `E://学习//资料/`）
  const norm = raw.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '')
  const isAbs = norm.startsWith('/')
  const parts = norm.split('/').filter(Boolean)

  // 只有一个部件：要么是根（`E:` / `/`），要么根本不含目录
  if (parts.length <= 1) {
    if (isAbs) return '/'
    return parts.length === 1 && /^[A-Za-z]:$/.test(parts[0]) ? parts[0] : ''
  }

  parts.pop()                                    // 去掉文件名
  const dir = parts.join('/')
  return isAbs ? `/${dir}` : dir
}

/**
 * 把目录字符串切成从根到叶的每一级（用于画树）。
 *
 * `E:/学习/资料` → `['E:', 'E:/学习', 'E:/学习/资料']`
 *
 * @param {string} dir - 目录
 * @returns {string[]} 逐级路径
 */
export function dirChain(dir) {
  const parts = String(dir ?? '').split('/').filter(Boolean)
  const out = []
  let acc = ''
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p
    out.push(acc)
  }
  return out
}

/**
 * 判断某个目录是否在选中目录之下（含它自己）。
 * @param {string} dir - 文档的目录
 * @param {string} selected - 选中的目录
 * @returns {boolean} 是否命中
 */
export function dirMatches(dir, selected) {
  if (!selected) return true
  const d = String(dir ?? '')
  return d === selected || d.startsWith(`${selected}/`)
}
