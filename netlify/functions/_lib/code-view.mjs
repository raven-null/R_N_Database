/**
 * 代码预览渲染（带行号 + 语法高亮）。
 *
 * ## 为什么在服务端高亮
 *
 * 与 Markdown 渲染同一个思路：变换是确定性的，算一次就够。
 *   - 前端零依赖、零加载
 *   - 编辑后由函数重新渲染并缓存，读的人不需要再跑一遍
 *   - 预览页的 CSP 可以保持严格（`default-src 'none'`），不必放开脚本
 *
 * 打包时 only 引需要的语言：highlight.js 全量 5MB，`lib/common` 36 种
 * 已经覆盖绝大多数场景，再补 7 种就够，函数包不会被撑大。
 *
 * ## 行号怎么对齐
 *
 * 高亮后的 HTML 里 `<span>` 会跨行，硬按行切会把标签切坏。
 * 所以行号单独一列，靠**相同的行高**对齐；代码用 `white-space: pre`
 * （不折行）保证"一行就是一行"。长行横向滚动，行号用
 * `position: sticky; left: 0` 钉住，滚到右边也看得到行号。
 *
 * @module netlify/functions/_lib/code-view
 */

import hljs from 'highlight.js/lib/common'
import bash from 'highlight.js/lib/languages/powershell'
import dos from 'highlight.js/lib/languages/dos'
import protobuf from 'highlight.js/lib/languages/protobuf'
import latex from 'highlight.js/lib/languages/latex'
import scala from 'highlight.js/lib/languages/scala'
import groovy from 'highlight.js/lib/languages/groovy'
import dart from 'highlight.js/lib/languages/dart'

import { escHtml } from './source-view.mjs'
import { highlightLangOf } from './file-types.mjs'
import { countLines } from './plain-text.mjs'

// lib/common 里没有的，单独补上
hljs.registerLanguage('powershell', bash)
hljs.registerLanguage('dos', dos)
hljs.registerLanguage('protobuf', protobuf)
hljs.registerLanguage('latex', latex)
hljs.registerLanguage('scala', scala)
hljs.registerLanguage('groovy', groovy)
hljs.registerLanguage('dart', dart)

/** 渲染上限（字符）。超大文件不做高亮，避免拖慢与占用。 */
const MAX_HIGHLIGHT_CHARS = 600_000

/** 高亮主题（深浅色自适应，配色跟随 GitHub 风格）。 */
const CODE_CSS = `
  :root {
    --bg: #ffffff; --fg: #1f2328; --muted: #8b949e; --line: #d8dee4;
    --gutter: #f6f8fa; --hl: #0969da;
    --k: #cf222e; --s: #0a3069; --c: #6e7781; --n: #0550ae;
    --f: #8250df; --v: #953800; --t: #0550ae;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d1117; --fg: #e6edf3; --muted: #8b949e; --line: #30363d;
      --gutter: #161b22; --hl: #6ea8fe;
      --k: #ff7b72; --s: #a5d6ff; --c: #8b949e; --n: #79c0ff;
      --f: #d2a8ff; --v: #ffa657; --t: #79c0ff;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); }
  body {
    font: 13px/1.65 ui-monospace, "Cascadia Code", Consolas, "Courier New", monospace;
    -webkit-font-smoothing: antialiased;
  }

  .meta {
    position: sticky; top: 0; z-index: 3;
    display: flex; align-items: center; gap: 10px;
    padding: 7px 14px; font-size: 11.5px; color: var(--muted);
    background: var(--gutter); border-bottom: 1px solid var(--line);
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  }
  .meta .lang { color: var(--hl); font-weight: 600; }
  .meta .spacer { flex: 1; }

  .wrap {
    display: flex; align-items: flex-start;
    overflow: auto;
    height: calc(100% - 31px);
  }
  /* 行号列：横向滚动时钉在左边 */
  .gutter {
    position: sticky; left: 0; z-index: 2;
    flex: 0 0 auto;
    padding: 10px 10px 40px 14px;
    text-align: right;
    color: var(--muted); opacity: .65;
    background: var(--gutter);
    border-right: 1px solid var(--line);
    user-select: none; white-space: pre;
  }
  .code {
    flex: 1 1 auto;
    margin: 0;
    padding: 10px 20px 40px 14px;
    white-space: pre;
    tab-size: 4;
  }
  .code code { background: none; padding: 0; font: inherit; }

  /* ---- 高亮配色 ---- */
  .hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-type { color: var(--k); }
  .hljs-string, .hljs-regexp, .hljs-addition { color: var(--s); }
  .hljs-comment, .hljs-quote { color: var(--c); font-style: italic; }
  .hljs-number, .hljs-symbol, .hljs-bullet { color: var(--n); }
  .hljs-title, .hljs-section, .hljs-name, .hljs-selector-id, .hljs-selector-class { color: var(--f); }
  .hljs-attr, .hljs-attribute, .hljs-variable, .hljs-template-variable, .hljs-params { color: var(--v); }
  .hljs-built_in, .hljs-class .hljs-title, .hljs-function .hljs-title { color: var(--t); }
  .hljs-meta, .hljs-doctag { color: var(--muted); }
  .hljs-deletion { color: var(--k); }
  .hljs-emphasis { font-style: italic; }
  .hljs-strong { font-weight: 700; }
`

/**
 * 渲染代码为完整 HTML 页（带行号与语法高亮）。
 *
 * @param {string} source - 源码文本
 * @param {object} opts - { title, ext }
 * @returns {{html:string, highlighted:boolean, lang:string|null}} 渲染结果
 */
export function renderCodePage(source, opts = {}) {
  const text = String(source ?? '')
  const lang = highlightLangOf(opts.ext)
  const tooBig = text.length > MAX_HIGHLIGHT_CHARS

  let body
  let highlighted = false

  if (lang && !tooBig) {
    try {
      body = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
      highlighted = true
    } catch {
      body = escHtml(text)
    }
  } else {
    // 认不出语言或文件太大 → 纯文本，仍然给行号
    body = escHtml(text)
  }

  // ★ 行数按**视觉行**数：文件末尾的换行是终止符，不产生新的一行。
  // 若按 split('\n').length 算，行号列会比代码块多出一行的高度，
  // 于是最后一个孤立行号挂在代码下面（真实浏览器检查抓到的就是这个）。
  const lineCount = countLines(text)
  const numbers = Array.from({ length: lineCount }, (_, i) => i + 1).join('\n')

  const note = tooBig
    ? `文件较大（${(text.length / 1024).toFixed(0)}KB），已跳过语法高亮`
    : lang
      ? ''
      : '未识别语言，按纯文本显示'

  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(opts.title ?? '')}</title>
<style>${CODE_CSS}</style>
</head>
<body>
  <div class="meta">
    <span class="lang">${escHtml(lang ?? 'text')}</span>
    <span>${lineCount} 行</span>
    <span class="spacer"></span>
    ${note ? `<span>${escHtml(note)}</span>` : ''}
  </div>
  <div class="wrap">
    <div class="gutter">${numbers}</div>
    <pre class="code"><code class="hljs">${body}</code></pre>
  </div>
</body></html>`

  return { html, highlighted, lang }
}
