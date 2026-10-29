/**
 * Markdown 写作链路测试：新建笔记、front matter 驱动元数据、双链渲染。
 *
 * 三块分别验证：
 *   ① `POST /docs` 能在指定文件夹里建一篇笔记，且立刻可列出、可搜到
 *   ② front matter 覆盖标题/标签/分类/可见性，且**不进索引正文**
 *   ③ 浏览器端渲染：GFM 表格、双链、锚点、目录
 *
 * ①② 走 HTTP（需要 npm run dev），③ 用 jsdom 直接跑 public/js/md.js，
 * 因为它依赖 `marked` 的浏览器构建（构建期已复制到 public/vendor/）。
 *
 * @module scripts/test-md-note
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'

const ROOT = process.cwd()
const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:8899'
const MARK = `MDNOTE${Date.now()}`

let passed = 0
let failed = 0

/**
 * 断言。
 * @param {boolean} cond - 条件
 * @param {string} label - 描述
 * @param {string} [detail] - 详情
 */
function check(cond, label, detail = '') {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`)
  }
}

/**
 * 发 JSON 请求。
 * @param {string} path - 路径
 * @param {object} [opts] - { method, body }
 * @returns {Promise<{status:number, body:object|null}>} 响应
 */
async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method ?? 'GET',
    headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, body }
}

/**
 * 用 jsdom 载入 md.js，验证渲染结果。
 * @returns {Promise<{renderMarkdown:Function, buildTitleIndex:Function, window:object}>} 模块
 */
async function loadMdModule() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    runScripts: 'outside-only',
  })
  // navigator 在 Node 21+ 是只读 getter，硬赋值会抛错 —— md.js 也不需要它
  const globalKeys = ['window', 'document', 'CSS', 'HTMLElement', 'Node', 'Event']
  const saved = new Map()
  for (const k of globalKeys) {
    saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k))
    Object.defineProperty(globalThis, k, {
      value: dom.window[k], configurable: true, writable: true,
    })
  }

  try {
    const mod = await import(`../public/js/md.js?t=${Date.now()}`)
    return { ...mod, window: dom.window }
  } finally {
    for (const [k, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, k, desc)
      else delete globalThis[k]
    }
  }
}

async function main() {
  console.log('▸ Markdown 写作测试\n')

  const created = []

  try {
    const health = await api('/api/v1/health')
    if (health.status !== 200) {
      console.error(`  开发服务器没起来（${BASE}）。先跑 npm run dev\n`)
      process.exit(2)
    }

    /* ---------- 新建笔记 ---------- */
    console.log('【新建笔记】')
    const made = await api('/api/v1/docs', {
      method: 'POST',
      body: { title: `${MARK} 第一篇`, content: `# ${MARK} 第一篇\n\n正文内容。\n` },
    })
    check(made.status === 200, `POST /docs 成功（HTTP ${made.status}）`)
    const doc = made.body?.data?.doc
    if (doc?.id) created.push(doc.id)
    check(Boolean(doc?.id), `拿到文档 id（${doc?.id}）`)
    check(doc?.type === 'md' && doc?.ext === 'md', '类型是 markdown')
    check(doc?.visibility === 'private', `默认私有（${doc?.visibility}）`)
    check(doc?.schemaVersion === 2, '符合文档模型 v2')

    const listed = await api('/api/v1/docs?limit=300')
    check((listed.body?.data?.items ?? []).some((d) => d.id === doc.id), '列表里立刻能看到')
    const found = await api(`/api/v1/search?q=${encodeURIComponent(MARK)}`)
    check((found.body?.data?.items ?? []).some((i) => i.id === doc.id), '立刻能搜到')

    const again = await api('/api/v1/docs', {
      method: 'POST',
      body: { title: `${MARK} 第一篇`, content: `# ${MARK} 第一篇\n\n正文内容。\n` },
    })
    check(again.body?.data?.existing === true, '同样内容再建一次是幂等（提示已存在）')
    check(again.body?.data?.doc?.id === doc.id, '返回的是同一份文档，没有多造一份')

    const noTitle = await api('/api/v1/docs', { method: 'POST', body: { title: '  ' } })
    check(noTitle.status === 400, `缺标题被拒（HTTP ${noTitle.status}）`)

    /* ---------- front matter ---------- */
    console.log('\n【front matter 驱动元数据】')
    const fmContent = [
      '---',
      `title: ${MARK} 带头部`,
      'tags: [自定义标签, 双链]',
      'categories: [学习资料]',
      'visibility: public',
      '---',
      '',
      `# ${MARK} 带头部`,
      '',
      'SECRETKEYWORD 只在正文里。',
      '',
    ].join('\n')

    const fmRes = await api('/api/v1/docs', {
      method: 'POST',
      body: { title: '先随便起个名', content: fmContent },
    })
    const fmDoc = fmRes.body?.data?.doc
    if (fmDoc?.id) created.push(fmDoc.id)
    check(Boolean(fmDoc?.id), '带 front matter 的笔记建成了')
    check(fmDoc?.title === `${MARK} 带头部`, `标题来自 front matter（${fmDoc?.title}）`)
    check((fmDoc?.tags ?? []).includes('自定义标签'), `标签来自 front matter（${(fmDoc?.tags ?? []).join(' ')}）`)
    check((fmDoc?.categories ?? []).includes('学习资料'), '分类来自 front matter')
    check(fmDoc?.visibility === 'public', `可见性来自 front matter（${fmDoc?.visibility}）`)
    check(fmDoc?.needsReview === false, '有明确分类时不标「待复查」')

    // front matter 不能进索引正文
    const text = await api(`/api/v1/docs/${fmDoc.id}/text`)
    const bodyText = (text.body?.data?.pages ?? []).join('\n')
    check(!bodyText.includes('SECRETKEYWORD') === false, '正文被抽取到了')
    check(!/tags:\s*\[/.test(bodyText) && !bodyText.includes('categories:'),
      'front matter 没有被当成正文内容')
    const searchYaml = await api(`/api/v1/search?q=${encodeURIComponent('categories:')}`)
    check(!(searchYaml.body?.data?.items ?? []).some((i) => i.id === fmDoc.id),
      '搜 YAML 关键字搜不到它（元数据不进索引）')

    /* ---------- front matter 随内容编辑生效 ---------- */
    console.log('\n【改头部 = 改元数据】')
    const fm2 = fmContent
      .replace('tags: [自定义标签, 双链]', 'tags: [改过的标签]')
      .replace('visibility: public', 'visibility: private')
    const put = await api(`/api/v1/docs/${fmDoc.id}/content`, {
      method: 'PUT',
      body: { content: fm2 },
    })
    check(put.status === 200, `PUT /content 成功（HTTP ${put.status}）`)
    check((put.body?.data?.doc?.tags ?? []).includes('改过的标签'),
      `标签跟着头部变了（${(put.body?.data?.doc?.tags ?? []).join(' ')}）`)
    check(put.body?.data?.doc?.visibility === 'private', '可见性跟着头部变了')
    check(put.body?.data?.doc?.id === fmDoc.id, 'id 没有变（引用不断裂）')

    /* ---------- 浏览器端渲染 ---------- */
    console.log('\n【渲染】')
    const vendor = join(ROOT, 'public', 'vendor', 'marked.esm.js')
    let hasVendor = true
    try { readFileSync(vendor) } catch { hasVendor = false }
    check(hasVendor, '构建期已把 marked 复制到 public/vendor/')

    const mdMod = await loadMdModule()
    const sample = [
      '# 标题一',
      '',
      '正文 **[[' + `${MARK} 第一篇` + ']]** 与 [[不存在的文档]]。',
      '',
      '| 列 1 | 列 2 |',
      '| --- | --- |',
      '| a | b |',
      '',
      '- [x] 已完成',
      '- [ ] 未完成',
      '',
      '```js',
      'const x = 1',
      '```',
      '',
      '## 标题二',
    ].join('\n')

    const titleIndex = mdMod.buildTitleIndex([{ id: 'abc123', title: `${MARK} 第一篇` }])
    const { html, toc } = await mdMod.renderMarkdown(sample, { titleIndex })

    check(html.includes('<table'), 'GFM 表格渲染出来了')
    check(html.includes('type="checkbox"'), '任务列表渲染出来了')
    check(html.includes('href="/view.html?id=abc123"'), '双链指向真实文档')
    check(html.includes('class="wiki missing"'), '指向不存在的文档时标成 missing')
    check(/<h1[^>]*id="h-1"/.test(html), '标题带锚点 id')
    check(toc.length === 2, `目录抽到 ${toc.length} 项（h1 + h2）`)
    check(toc[0].text === '标题一' && toc[1].level === 2, `目录层级正确（${toc.map((t) => t.level + t.text).join(' / ')}）`)
    check(html.includes('data-copy'), '代码块带复制按钮')
    check(!/<script/i.test(html), '没有残留 script 标签')
  } finally {
    /* ---------- 清理 ---------- */
    let removed = 0
    for (const id of created) {
      const r = await api(`/api/v1/docs/${id}`, { method: 'DELETE' })
      if (r.status === 200) removed += 1
    }
    if (removed) console.log(`\n  已清理 ${removed} 份测试笔记`)
  }

  console.log('\n────────────────────────────────')
  console.log(`  通过 ${passed} / 失败 ${failed}`)
  console.log('')
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n测试自身出错：', err?.message ?? err)
  process.exit(2)
})
