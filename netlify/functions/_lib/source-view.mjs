/**
 * 源码视图（代码格式）渲染。
 *
 * Markdown 文档的第二种看法的服务端实现：把原始文本渲染成
 * 等宽字体 + 行号的「代码格式」页面。
 *
 * ## 为什么放在 _lib 而不是 scripts/lib
 *
 * 这个视图是**按需生成**的（不预存，避免同一份内容存两遍），
 * 所以 Netlify 函数运行时要能拿到它。而 Markdown → HTML 的渲染
 * （需要 marked）只在入库时用得到，放在 scripts/lib。
 * 函数打包不方便跨出 netlify/functions/，脚本引用函数侧则没有限制 ——
 * 因此把「运行时需要的」放这里，「只在本地用的」放 scripts/lib。
 * 这样 marked 也不会被打进函数包。
 *
 * @module netlify/functions/_lib/source-view
 */

/** 源码视图最多渲染的行数，防止病态文件把页面撑爆。 */
const MAX_SOURCE_LINES = 20000

/** 深浅色自适应的基础样式，与渲染视图共用。 */
export const BASE_CSS = `
  :root {
    --bg: #ffffff; --fg: #1f2328; --muted: #656d76; --line: #d8dee4;
    --code-bg: #f6f8fa; --accent: #2563eb; --quote: #d0d7de;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d1117; --fg: #e6edf3; --muted: #8b949e; --line: #30363d;
      --code-bg: #161b22; --accent: #6ea8fe; --quote: #3d444d;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); }
  body {
    font: 15px/1.75 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-thumb { background: var(--line); border-radius: 5px; }
`

/** 源码视图样式。 */
const SOURCE_CSS = `
  .src {
    font-family: ui-monospace, "Cascadia Code", Consolas, "Courier New", monospace;
    font-size: 13px; line-height: 1.65; padding: 18px 0 60px;
  }
  .row { display: flex; }
  .row:hover { background: color-mix(in srgb, var(--code-bg) 80%, transparent); }
  .ln {
    flex: 0 0 auto; width: 62px; padding-right: 14px; text-align: right;
    color: var(--muted); opacity: .55; user-select: none;
    border-right: 1px solid var(--line); margin-right: 14px;
  }
  .tx {
    flex: 1 1 auto; min-width: 0;
    white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere;
  }
  /* 空行也要占位，否则行号与内容会错位 */
  .tx:empty::after { content: " "; }
  .empty-file { padding: 40px 32px; color: var(--muted); }
`

/**
 * HTML 转义。
 * @param {string} s - 原文
 * @returns {string} 转义结果
 */
export function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 把源码渲染成完整的 HTML 页（代码格式，带行号）。
 *
 * @param {string} source - 原始文本
 * @param {string} title - 文档标题
 * @returns {string} 完整 HTML
 */
export function renderSourcePage(source, title) {
  const text = String(source ?? '')
  const lines = text.split('\n')
  const shown = lines.slice(0, MAX_SOURCE_LINES)

  const rows = shown.map((line, i) =>
    `<div class="row"><span class="ln">${i + 1}</span><span class="tx">${escHtml(line)}</span></div>`,
  ).join('')

  const truncated = lines.length > MAX_SOURCE_LINES
    ? `<div class="row"><span class="ln"></span><span class="tx">… 已截断，仅显示前 ${MAX_SOURCE_LINES} 行（共 ${lines.length} 行）</span></div>`
    : ''

  const body = shown.length === 0
    ? '<p class="empty-file">（空文件）</p>'
    : `<div class="src">${rows}${truncated}</div>`

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(title)} · 源码</title>
<style>${BASE_CSS}${SOURCE_CSS}</style>
</head>
<body>${body}</body></html>`
}
