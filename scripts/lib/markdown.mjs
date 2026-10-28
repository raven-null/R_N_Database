/**
 * Markdown 渲染视图 —— 实现已移到函数侧。
 *
 * ## 为什么搬走
 *
 * 原先渲染只在**入库时**发生，所以放在 scripts/lib 就能把 marked
 * 排除在 Netlify 函数包之外。
 *
 * 但后来加了「网页上直接编辑代码/文本」：编辑后函数必须重新渲染预览件，
 * 于是 marked 也成了运行时依赖。与其两份实现（本地一份、函数一份），
 * 不如统一在 netlify/functions/_lib/markdown-view.mjs：
 *   - 函数侧引用它（打包时带上 marked，约 40KB，可以接受）
 *   - 脚本侧也从这里转出，保证「入库渲染」与「编辑后重渲染」结果一致
 *
 * @module scripts/lib/markdown
 */

export { renderMarkdownPage, supportsDualView } from '../../netlify/functions/_lib/markdown-view.mjs'
