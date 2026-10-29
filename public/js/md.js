/**
 * 浏览器端的 Markdown 渲染（实时预览用）。
 *
 * ## 为什么不复用服务端的渲染
 *
 * 阅读页与入库预览都是服务端渲染的（`_lib/markdown-view.mjs`，带完整
 * 消毒与样式）。但**编辑时的实时预览**必须在浏览器里：每敲几个字就重画
 * 一次，打一趟服务器既慢又浪费。
 *
 * 渲染器本身用 `marked`（项目已有依赖，构建期复制到 `public/vendor/`），
 * 保证语法支持与线上预览一致（GFM 表格 / 任务列表 / 删除线 / 脚注）。
 *
 * ## 这一层额外做的事
 *
 * 1. **双链**：`[[文档标题]]` → 站内链接。标题在清单里查得到就直连，
 *    查不到就标成红色虚线（表示"还没写"），点击时可以新建。
 * 2. **锚点**：每个标题生成稳定 id，供目录（TOC）跳转。
 * 3. **目录**：抽出 h1–h3 生成侧边目录。
 * 4. **代码块复制按钮**：预览里直接挂上（不用回源码里找）。
 *
 * @module public/js/md
 */

import { esc } from './util.js'

/** marked 实例（首次 render 时懒加载）。 */
let md = null
let loadFailed = false

/**
 * 极简消毒：去掉脚本、事件属性与 javascript: 链接。
 *
 * 这里的内容是**本人**写的笔记，风险远低于开放评论；但预览 HTML 会
 * 直接进 innerHTML，而笔记里也可能粘进别人的 HTML 片段。宁可少渲染
 * 一点，也不要在自己的库里留一个 XSS 口子。
 *
 * @param {string} html - marked 的输出
 * @returns {string} 干净的 HTML
 */
function sanitize(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '')
}

/**
 * 懒加载 marked（失败则退化为纯文本渲染，不让编辑面板崩掉）。
 * @returns {Promise<object|null>} marked 模块
 */
async function loadMarked() {
  if (md || loadFailed) return md
  try {
    // 用 import.meta.url 解析，而不是写死 '/vendor/…'：
    // 浏览器里会解析成 /vendor/marked.esm.js，Node 里（测试）解析成
    // 磁盘上的同一份文件 —— 两条路用的是**同一份** marked，不会漂移
    const mod = await import(new URL('../vendor/marked.esm.js', import.meta.url).href)
    md = mod.marked ?? mod.default ?? mod
  } catch {
    loadFailed = true
    md = null
  }
  return md
}

/**
 * 给标题加锚点 id。
 * @param {string} html - HTML
 * @returns {string} 处理后的 HTML
 */
function anchorHeadings(html) {
  let seq = 0
  return html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (all, level, inner) => {
    seq += 1
    return `<h${level} id="h-${seq}" data-h="${level}">${inner}</h${level}>`
  })
}

/**
 * 双链：`[[标题]]` → 站内链接。
 *
 * @param {string} html - HTML
 * @param {Map<string, object>} titleIndex - 标题 → 文档
 * @returns {string} 处理后的 HTML
 */
function renderWikiLinks(html, titleIndex) {
  return html.replace(/\[\[([^\]|]{1,120})(?:\|([^\]]{1,120}))?\]\]/g, (all, target, alias) => {
    const title = String(target).trim()
    const label = esc(String(alias ?? target).trim())
    const hit = titleIndex?.get(title.toLowerCase())
    if (hit) {
      return `<a class="wiki" href="/view.html?id=${encodeURIComponent(hit.id)}" data-wiki="${esc(title)}">${label}</a>`
    }
    return `<a class="wiki missing" href="#" data-wiki-new="${esc(title)}" title="库里还没有「${esc(title)}」，点一下新建">${label}</a>`
  })
}

/**
 * 给每个代码块加"复制"按钮（用 data 标记，点击由页面委托处理）。
 * @param {string} html - HTML
 * @returns {string} 处理后的 HTML
 */
function decorateCodeBlocks(html) {
  return html.replace(/<pre><code([^>]*)>([\s\S]*?)<\/code><\/pre>/g,
    (all, attrs, code) => `<div class="md-code"><button class="md-copy" type="button" data-copy>复制</button>`
      + `<pre><code${attrs}>${code}</code></pre></div>`)
}

/**
 * 从渲染后的 HTML 抽目录（h1–h3）。
 *
 * @param {string} html - 已渲染 HTML
 * @returns {Array<{level:number, text:string, id:string}>} 目录项
 */
export function extractToc(html) {
  const out = []
  const re = /<h([1-3])[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g
  let m
  while ((m = re.exec(String(html ?? ''))) !== null) {
    const text = m[3].replace(/<[^>]+>/g, '').trim()
    if (text) out.push({ level: Number(m[1]), text, id: m[2] })
  }
  return out
}

/**
 * 渲染 Markdown。
 *
 * @param {string} text - Markdown 源码
 * @param {object} [opts] - { titleIndex: Map<string, doc> }
 * @returns {Promise<{html:string, toc:Array}>} 结果
 */
export async function renderMarkdown(text, opts = {}) {
  const src = String(text ?? '')
  const marked = await loadMarked()

  let html
  if (marked) {
    html = marked.parse(src, { gfm: true, breaks: false, async: false })
  } else {
    // marked 没加载出来：至少把内容按段落显示，别让预览区一片空白
    html = src.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')
  }

  html = sanitize(String(html))
  html = renderWikiLinks(html, opts.titleIndex)
  html = anchorHeadings(html)
  html = decorateCodeBlocks(html)

  return { html, toc: extractToc(html) }
}

/**
 * 用清单建「标题 → 文档」索引，供双链解析。
 *
 * @param {object[]} docs - manifest.docs
 * @returns {Map<string, object>} 小写标题 → 文档
 */
export function buildTitleIndex(docs) {
  const map = new Map()
  for (const d of docs ?? []) {
    const t = String(d.title ?? '').trim().toLowerCase()
    if (t && !map.has(t)) map.set(t, d)
    const base = String(d.originalName ?? '').replace(/\.[^.]+$/, '').trim().toLowerCase()
    if (base && !map.has(base)) map.set(base, d)
  }
  return map
}

/**
 * 处理预览区里的交互（复制按钮、缺失双链的新建）。
 *
 * @param {HTMLElement} root - 预览容器
 * @param {object} [handlers] - { onCreateFromLink(title) }
 * @returns {void}
 */
export function wirePreview(root, handlers = {}) {
  root.addEventListener('click', (ev) => {
    const copy = ev.target.closest('[data-copy]')
    if (copy) {
      ev.preventDefault()
      const code = copy.parentElement?.querySelector('code')?.textContent ?? ''
      navigator.clipboard?.writeText(code).then(() => {
        copy.textContent = '已复制'
        setTimeout(() => { copy.textContent = '复制' }, 1400)
      }).catch(() => { copy.textContent = '复制失败' })
      return
    }
    const missing = ev.target.closest('[data-wiki-new]')
    if (missing) {
      ev.preventDefault()
      handlers.onCreateFromLink?.(missing.dataset.wikiNew)
    }
  })
}
