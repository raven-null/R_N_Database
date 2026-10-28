/**
 * Markdown 渲染视图（文本模式）。
 *
 * Markdown 文档提供两种看法：
 *   1. **源码（代码格式）** —— 见 ./source-view.mjs
 *   2. **渲染（文本模式）** —— 本模块：转成 HTML，标题/表格/代码块正常排版
 *
 * ## 为什么现在放在 _lib（而不是 scripts/lib）
 *
 * 原先渲染只在**入库时**发生，放在 scripts/lib 就能把 marked 排除在
 * Netlify 函数包之外。后来加了「网页上直接编辑代码/文本」，
 * 编辑后函数必须重新渲染预览件，marked 于是成了运行时依赖。
 * 与其维护两份实现，不如统一在这里：
 *   - 函数侧引用它（打包带上 marked，约 40KB，可以接受）
 *   - 脚本侧 scripts/lib/markdown.mjs 从这转出，
 *     保证「入库渲染」与「编辑后重渲染」结果一致
 *
 * @module netlify/functions/_lib/markdown-view
 */

import { marked } from 'marked'
import { BASE_CSS, escHtml } from './source-view.mjs'

/** 渲染视图（文档排版）的样式。 */
const RENDER_CSS = `
  .doc { max-width: 860px; margin: 0 auto; padding: 34px 32px 80px; }
  .doc > *:first-child { margin-top: 0; }
  h1, h2, h3, h4, h5, h6 { line-height: 1.35; font-weight: 650; margin: 1.6em 0 .6em; }
  h1 { font-size: 1.7em; padding-bottom: .3em; border-bottom: 1px solid var(--line); }
  h2 { font-size: 1.4em; padding-bottom: .25em; border-bottom: 1px solid var(--line); }
  h3 { font-size: 1.18em; }
  h4 { font-size: 1.03em; }
  h5, h6 { font-size: .95em; color: var(--muted); }
  p { margin: 0 0 1em; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  strong { font-weight: 650; }
  ul, ol { margin: 0 0 1em; padding-left: 1.7em; }
  li { margin: .3em 0; }
  li > ul, li > ol { margin: .3em 0; }
  blockquote {
    margin: 0 0 1em; padding: .2em 1em; color: var(--muted);
    border-left: 3px solid var(--quote);
  }
  blockquote > *:last-child { margin-bottom: 0; }
  hr { height: 1px; border: 0; background: var(--line); margin: 2em 0; }
  code {
    font-family: ui-monospace, "Cascadia Code", Consolas, "Courier New", monospace;
    font-size: .88em; background: var(--code-bg); padding: .15em .4em; border-radius: 5px;
  }
  pre {
    background: var(--code-bg); border: 1px solid var(--line); border-radius: 8px;
    padding: 13px 15px; overflow-x: auto; margin: 0 0 1em;
  }
  pre code { background: none; padding: 0; font-size: .86em; line-height: 1.6; }
  table {
    border-collapse: collapse; margin: 0 0 1em; width: 100%;
    font-size: .93em; display: block; overflow-x: auto;
  }
  th, td { border: 1px solid var(--line); padding: 7px 11px; text-align: left; vertical-align: top; }
  th { background: var(--code-bg); font-weight: 650; }
  tbody tr:nth-child(even) td { background: color-mix(in srgb, var(--code-bg) 45%, transparent); }
  img { max-width: 100%; height: auto; }
`

/**
 * 把 Markdown 渲染成完整的 HTML 页（文本模式）。
 *
 * 渲染失败时回退为纯文本而不是抛错 —— 一份格式古怪的文档
 * 不该变成打不开的文档。
 *
 * @param {string} source - Markdown 原文
 * @param {string} title - 文档标题
 * @returns {{html:string, ok:boolean, error:string|null}} 渲染结果
 */
export function renderMarkdownPage(source, title) {
  let body = ''
  let ok = true
  let error = null

  try {
    body = marked.parse(String(source ?? ''), { gfm: true, breaks: false })
  } catch (err) {
    ok = false
    error = String(err?.message ?? err)
    body = `<pre>${escHtml(source)}</pre>`
  }

  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(title)}</title>
<style>${BASE_CSS}${RENDER_CSS}</style>
</head>
<body><article class="doc">${body}</article></body></html>`

  return { html, ok, error }
}

/**
 * 判断某类型是否支持「源码 / 渲染」双视图。
 * @param {string} type - 规范化类型
 * @returns {boolean} 是否支持
 */
export function supportsDualView(type) {
  return type === 'md'
}
