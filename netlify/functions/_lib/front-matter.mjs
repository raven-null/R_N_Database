/**
 * YAML front matter：让 **Markdown 文档自己带元数据**。
 *
 * ```
 * ---
 * title: 多态笔记
 * tags: [面向对象, 多态]
 * categories: [学习资料]
 * visibility: private
 * ---
 *
 * 正文从这里开始……
 * ```
 *
 * ## 为什么值得做
 *
 * 这个库的分类与标签一直是"入库时机器猜"。猜得对不对，人只有在阅读页
 * 才看得出来。而 Markdown 是唯一一种**人和机器都能写**的格式 ——
 * 让人在文件头写清楚元数据，比事后纠错便宜得多。
 * 你在本地用任何编辑器写的 `.md`，拖进来就自带分类与标签。
 *
 * ## 只实现 YAML 的一个子集
 *
 * 支持：`key: 值`、`key: [a, b]`、`key:` 后面跟 `- item` 列表、`#` 注释、引号。
 * 不支持嵌套、锚点、多行折叠 —— 那需要完整的 YAML 解析器，而元数据用不上。
 * **解析失败的策略是不认**（当作普通正文），绝不能让一篇笔记因为头部的
 * 一个语法错误就进不了库。
 *
 * @module netlify/functions/_lib/front-matter
 */

/** front matter 的边界标记。 */
const FENCE = '---'

/**
 * 去掉 UTF-8 BOM。
 *
 * Windows 上的编辑器（记事本、部分 VS Code 默认配置）保存 UTF-8 时会带 BOM，
 * 于是文件头第一个字符是 `\uFEFF` 而不是 `-`。不处理的话 front matter 永远
 * 认不出来 —— 表现就是"我明明写了 tags，入库却不认"，而且完全看不出原因。
 *
 * @param {string} text - 原文
 * @returns {string} 去掉 BOM 的文本
 */
function stripBom(text) {
  return String(text ?? '').replace(/^\uFEFF/, '')
}

/**
 * 是否可能带 front matter（快速判定，避免给每篇正文都跑正则）。
 * @param {string} text - 正文
 * @returns {boolean} 是否可能
 */
export function hasFrontMatter(text) {
  const s = stripBom(text)
  return s.startsWith(`${FENCE}\n`) || s.startsWith(`${FENCE}\r\n`)
}

/**
 * 拆出 front matter 与正文。
 *
 * 没有 front matter（或格式不合法）时，`data` 为空对象、`body` 是原文。
 *
 * @param {string} text - 完整文件内容
 * @returns {{data:object, body:string, raw:string}} 结果
 */
export function parseFrontMatter(text) {
  const s = stripBom(text)
  if (!hasFrontMatter(s)) return { data: {}, body: s, raw: '' }

  // 找到第二个 --- 行
  const lines = s.split(/\r?\n/)
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === FENCE) { end = i; break }
  }
  if (end === -1) return { data: {}, body: s, raw: '' }

  const raw = lines.slice(1, end).join('\n')
  const body = lines.slice(end + 1).join('\n')

  let data
  try {
    data = parseYamlSubset(raw)
  } catch {
    // 解析不了就当没有：宁可少一份元数据，也不能让文档进不了库
    return { data: {}, body: s, raw: '' }
  }
  return { data, body, raw }
}

/**
 * 去掉 front matter，只留正文。
 * @param {string} text - 完整内容
 * @returns {string} 正文
 */
export function stripFrontMatter(text) {
  return parseFrontMatter(text).body
}

/**
 * 极简 YAML 子集解析器。
 *
 * @param {string} src - front matter 原文（不含 --- 标记）
 * @returns {object} 键值对
 */
function parseYamlSubset(src) {
  const out = {}
  let currentListKey = null

  for (const line of src.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue

    // 列表项：`- value`
    const listItem = line.match(/^\s*-\s+(.*)$/)
    if (listItem && currentListKey) {
      const v = unquote(stripComment(listItem[1]))
      if (v) out[currentListKey].push(v)
      continue
    }

    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/)
    if (!kv) continue

    const key = kv[1]
    const rest = stripComment(kv[2]).trim()

    if (rest === '') {
      // 后面可能跟一个 `- item` 列表
      out[key] = []
      currentListKey = key
      continue
    }
    currentListKey = null

    if (rest.startsWith('[') && rest.endsWith(']')) {
      out[key] = rest.slice(1, -1).split(',').map((x) => unquote(x.trim())).filter(Boolean)
    } else if (rest === 'true' || rest === 'false') {
      out[key] = rest === 'true'
    } else {
      out[key] = unquote(rest)
    }
  }
  return out
}

/**
 * 去掉行尾注释（不处理引号内的 #，够用）。
 * @param {string} s - 片段
 * @returns {string} 干净片段
 */
function stripComment(s) {
  const t = String(s ?? '')
  const at = t.indexOf(' #')
  return at === -1 ? t : t.slice(0, at)
}

/**
 * 去掉成对的引号。
 * @param {string} s - 片段
 * @returns {string} 结果
 */
function unquote(s) {
  const t = String(s ?? '').trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1)
  }
  return t
}

/**
 * 把 front matter 里的元数据映射成文档字段。
 *
 * 只认几个明确的键，其余原样放进 `extra` —— 这样用户写 `status:` 之类的
 * 自定义字段也不会被吞掉，但也不会误改内部字段。
 *
 * @param {object} data - parseFrontMatter().data
 * @returns {object} { title, tags, categories, visibility, summary, extra }
 */
export function metaFromFrontMatter(data) {
  const d = data ?? {}
  const list = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [])
  const str = (v) => (v === undefined || v === null || v === '' ? '' : String(v).trim())

  const known = new Set([
    'title', 'tags', 'categories', 'category', 'visibility', 'summary',
    'date', 'author', 'created', 'createdat', 'doccreatedat',
  ])
  const extra = {}
  for (const [k, v] of Object.entries(d)) {
    if (!known.has(String(k).toLowerCase())) extra[k] = v
  }

  const cats = list(d.categories)
  const oneCat = str(d.category)
  if (cats.length === 0 && oneCat) cats.push(oneCat)

  return {
    title: str(d.title),
    tags: list(d.tags),
    categories: cats,
    visibility: str(d.visibility).toLowerCase() === 'public' ? 'public'
      : (str(d.visibility).toLowerCase() === 'private' ? 'private' : ''),
    summary: str(d.summary),
    author: str(d.author),
    docCreatedAt: str(d.docCreatedAt ?? d.createdat ?? d.created ?? d.date) || null,
    extra,
  }
}
