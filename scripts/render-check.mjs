/**
 * 真实浏览器渲染检查（Chrome DevTools Protocol）。
 *
 * 为什么需要它：
 *   - jsdom 能验证 DOM 结构与逻辑，但**不计算样式、不做布局**
 *   - 截图我能生成，但没法可靠地"阅读"图片内容
 *   - 于是需要一条能拿到硬数字的路：让真实 Chrome 渲染，
 *     再把「侧边栏多宽、文档卡片多高、正文用什么颜色」问出来
 *
 * 这同时也是一个长期有用的工具：改完样式跑一次，
 * 就能发现"元素塌成 0 高度""颜色没生效"这类只有真渲染才暴露的问题。
 *
 * 用法：
 *   node scripts/dev-server.mjs            # 另一个终端
 *   node scripts/render-check.mjs          # 列表页
 *   node scripts/render-check.mjs view     # 再加阅读页
 *
 * @module scripts/render-check
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const ROOT = process.cwd()
const BASE = process.env.RENDER_BASE ?? 'http://127.0.0.1:8899'
const SHOTS = join(ROOT, '.shots')
const PORT = 9333
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
]

/**
 * 找到可用的 Chromium 内核浏览器。
 * @returns {string} 可执行文件路径
 */
function findBrowser() {
  for (const p of CHROME_CANDIDATES) {
    if (existsSync(p)) return p
  }
  throw new Error('找不到 Chrome / Edge 可执行文件')
}

/**
 * 等 CDP 端口就绪。
 * @param {number} port - 调试端口
 * @param {number} [timeoutMs] - 超时
 * @returns {Promise<object>} /json/version 的内容
 */
async function waitForCdp(port, timeoutMs = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return res.json()
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`CDP 端口 ${port} 在 ${timeoutMs}ms 内未就绪`)
}

/**
 * 建一个极简 CDP 客户端（WebSocket 由 Node 内置提供）。
 * @param {string} wsUrl - WebSocket 调试地址
 * @returns {Promise<object>} 客户端
 */
async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let nextId = 1
  const pending = new Map()

  ws.addEventListener('message', (ev) => {
    let msg
    try {
      msg = JSON.parse(ev.data)
    } catch {
      return
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    }
  })

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true })
  })

  /**
   * 发一条 CDP 命令。
   * @param {string} method - 方法名
   * @param {object} [params] - 参数
   * @returns {Promise<object>} 结果
   */
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`CDP 命令超时：${method}`))
      }
    }, 30000)
  })

  return { ws, send }
}

/**
 * 打开一个页面并等它稳定。
 * @param {object} client - CDP 客户端
 * @param {string} url - 目标地址
 * @returns {Promise<void>} 完成
 */
async function openPage(client, url) {
  await client.send('Page.enable')
  await client.send('Page.navigate', { url })
  // 等网络与 JS 都安静下来
  await new Promise((r) => setTimeout(r, 2500))
}

/**
 * 在页面里执行表达式并取回结果。
 * @param {object} client - CDP 客户端
 * @param {string} expression - JS 表达式
 * @returns {Promise<*>} 返回值
 */
async function evaluate(client, expression) {
  const res = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (res.exceptionDetails) {
    throw new Error(`页面内求值异常：${res.exceptionDetails.text}`)
  }
  return res.result?.value
}

/**
 * 截图存盘。
 * @param {object} client - CDP 客户端
 * @param {string} name - 文件名（不含扩展名）
 * @returns {Promise<number>} 字节数
 */
async function screenshot(client, name) {
  const res = await client.send('Page.captureScreenshot', { format: 'png' })
  const buf = Buffer.from(res.data, 'base64')
  writeFileSync(join(SHOTS, `${name}.png`), buf)
  return buf.length
}

/* ============================================================
   列表页检查
   ============================================================ */

/** 列表页要问的渲染事实。 */
const LIST_PROBE = `(() => {
  const box = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) }
  }
  const style = (sel, prop) => {
    const el = document.querySelector(sel)
    return el ? getComputedStyle(el)[prop] : null
  }
  const docs = [...document.querySelectorAll('.doc')]
  return {
    viewport: { w: innerWidth, h: innerHeight },
    scrollHeight: document.documentElement.scrollHeight,
    bodyBg: style('body', 'backgroundColor'),
    bodyColor: style('body', 'color'),
    bodyFont: style('body', 'fontFamily').slice(0, 46),
    topbar: box('.topbar'),
    topbarPosition: style('.topbar', 'position'),
    sidebar: box('.sidebar'),
    results: box('.results'),
    docCount: docs.length,
    firstDoc: box('.doc'),
    firstDocTitle: docs[0]?.querySelector('.doc-title')?.textContent?.trim() ?? null,
    firstDocBadge: docs[0]?.querySelector('.type-badge')?.textContent?.trim() ?? null,
    badgeColor: style('.type-badge', 'color'),
    badgeRadius: style('.type-badge', 'borderRadius'),
    chipCount: document.querySelectorAll('.chip').length,
    chipRadius: style('.chip', 'borderRadius'),
    stats: document.getElementById('stats')?.textContent?.trim() ?? null,
    searchBox: box('#search'),
    cssLoaded: getComputedStyle(document.body).backgroundColor !== 'rgba(0, 0, 0, 0)',
    linkHref: docs[0]?.getAttribute('href') ?? null,
  }
})()`

/**
 * 检查列表页。
 * @param {object} client - CDP 客户端
 */
async function checkList(client) {
  console.log('\n【列表页真实渲染】')
  await openPage(client, `${BASE}/`)
  const r = await evaluate(client, LIST_PROBE)

  const line = (label, value) => console.log(`  ${label.padEnd(22)} ${value}`)

  line('视口', `${r.viewport.w}×${r.viewport.h}`)
  line('页面高度', `${r.scrollHeight}px`)
  line('CSS 是否生效', r.cssLoaded ? `是（body 背景 ${r.bodyBg}）` : '★ 否 —— 背景透明，样式没加载')
  line('正文颜色', r.bodyColor)
  line('字体', r.bodyFont)

  console.log('  ── 布局 ──')
  line('顶栏', r.topbar ? `${r.topbar.w}×${r.topbar.h} @ y=${r.topbar.y}（${r.topbarPosition}）` : '缺失')
  line('侧边栏', r.sidebar ? `${r.sidebar.w}px 宽` : '缺失')
  line('结果区', r.results ? `${r.results.w}px 宽` : '缺失')
  line('搜索框', r.searchBox ? `${r.searchBox.w}×${r.searchBox.h}` : '缺失')

  console.log('  ── 内容 ──')
  line('文档卡片数', r.docCount)
  line('首张卡片', r.firstDoc ? `${r.firstDoc.w}×${r.firstDoc.h} @ y=${r.firstDoc.y}` : '缺失')
  line('首条标题', r.firstDocTitle ?? '（空）')
  line('首条格式徽标', `${r.firstDocBadge} / 色 ${r.badgeColor} / 圆角 ${r.badgeRadius}`)
  line('筛选切面数', r.chipCount)
  line('切面圆角', r.chipRadius)
  line('统计行', r.stats)
  line('首条链接', r.linkHref)

  const issues = []
  if (!r.cssLoaded) issues.push('CSS 未生效（body 背景透明）')
  if (!r.topbar || r.topbar.h < 30) issues.push('顶栏高度异常，可能塌陷')
  if (!r.sidebar || r.sidebar.w < 120) issues.push('侧边栏宽度异常')
  if (!r.results || r.results.w < 400) issues.push('结果区宽度异常')
  if (r.docCount < 1) issues.push('没有渲染出任何文档卡片')
  if (!r.firstDoc || r.firstDoc.h < 40) issues.push('文档卡片高度异常，可能塌陷')
  if (r.chipCount < 3) issues.push('筛选切面太少')
  if (issues.length === 0) console.log('\n  ✓ 布局与样式检查通过，未发现塌陷或未生效')
  else issues.forEach((i) => console.log(`\n  ✗ ${i}`))

  const bytes = await screenshot(client, 'list')
  console.log(`  截图已存 .shots/list.png（${(bytes / 1024).toFixed(1)}KB）`)
  return issues.length === 0
}

/* ============================================================
   阅读页检查
   ============================================================ */

/** 阅读页要问的渲染事实。 */
const VIEW_PROBE = `(() => {
  const box = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height) }
  }
  const frame = document.querySelector('iframe')
  return {
    title: document.getElementById('doc-title')?.textContent?.trim() ?? null,
    titleFontSize: getComputedStyle(document.getElementById('doc-title')).fontSize,
    metaText: document.getElementById('doc-meta')?.textContent?.trim()?.slice(0, 70) ?? null,
    notice: document.getElementById('notice')?.textContent?.trim()?.slice(0, 70) ?? null,
    tagCount: document.querySelectorAll('#doc-tags .tag').length,
    actionCount: document.querySelectorAll('.actions a').length,
    actionLabels: [...document.querySelectorAll('.actions a')].map(a => a.textContent.trim()),
    downloadHref: [...document.querySelectorAll('.actions a')].find(a => a.textContent.includes('下载'))?.getAttribute('href') ?? null,
    frameKind: frame ? (frame.className || 'iframe') : null,
    frameSrc: frame ? frame.getAttribute('src')?.slice(0, 60) : null,
    frameBox: box('iframe'),
    frameHeightSet: frame ? getComputedStyle(frame).height : null,
  }
})()`

/**
 * 检查阅读页。
 * @param {object} client - CDP 客户端
 * @param {string} id - 文档 id
 * @param {string} label - 标签
 * @param {string} shotName - 截图名
 * @returns {Promise<boolean>} 是否通过
 */
async function checkView(client, id, label, shotName) {
  console.log(`\n【阅读页真实渲染 · ${label}】`)
  await openPage(client, `${BASE}/view.html?id=${id}`)
  const r = await evaluate(client, VIEW_PROBE)

  const line = (l, v) => console.log(`  ${l.padEnd(22)} ${v}`)
  line('标题', r.title ?? '（空）')
  line('标题字号', r.titleFontSize)
  line('元信息', r.metaText ?? '（空）')
  line('标签数', r.tagCount)
  line('操作按钮', `${r.actionCount} 个：${r.actionLabels.join(' / ')}`)
  line('下载链接', r.downloadHref)
  line('预览类型', `${r.frameKind} → ${r.frameSrc}…`)
  line('预览区尺寸', r.frameBox ? `${r.frameBox.w}×${r.frameBox.h}（CSS 高度 ${r.frameHeightSet}）` : '缺失')
  if (r.notice) line('提示', r.notice)

  const issues = []
  if (!r.title || r.title === '加载中…') issues.push('标题未加载')
  if (!r.frameKind) issues.push('没有预览 iframe')
  if (r.frameBox && r.frameBox.h < 200) issues.push(`预览区高度异常（${r.frameBox.h}px），可能塌陷`)
  if (!r.downloadHref) issues.push('没有下载链接')
  if (issues.length === 0) console.log('\n  ✓ 阅读页渲染正常')
  else issues.forEach((i) => console.log(`\n  ✗ ${i}`))

  const bytes = await screenshot(client, shotName)
  console.log(`  截图已存 .shots/${shotName}.png（${(bytes / 1024).toFixed(1)}KB）`)
  return issues.length === 0
}

/* ============================================================
   编辑面板检查
   ============================================================ */

/** 点开编辑面板后要问的渲染事实。 */
const EDITOR_PROBE = `(() => {
  const box = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height) }
  }
  const style = (sel, prop) => {
    const el = document.querySelector(sel)
    return el ? getComputedStyle(el)[prop] : null
  }
  const editor = document.querySelector('.editor')
  const opts = [...document.querySelectorAll('.cat-opt')]
  return {
    hasEditButton: Boolean(document.getElementById('btn-edit')),
    hasEditor: Boolean(editor),
    editorBox: box('.editor'),
    editorBorderColor: style('.editor', 'borderColor'),
    titleValue: document.getElementById('ed-title')?.value?.slice(0, 30) ?? null,
    catOptionCount: opts.length,
    checkedCount: opts.filter(o => o.querySelector('input')?.checked).length,
    firstOptBox: opts[0] ? { w: Math.round(opts[0].getBoundingClientRect().width), h: Math.round(opts[0].getBoundingClientRect().height) } : null,
    firstOptRadius: style('.cat-opt', 'borderRadius'),
    activeOptBg: style('.cat-opt.on', 'backgroundColor'),
    hasTags: Boolean(document.getElementById('ed-tags')),
    hasSummary: Boolean(document.getElementById('ed-summary')),
    hasVisibility: Boolean(document.getElementById('ed-visibility')),
    hasSave: Boolean(document.getElementById('ed-save')),
    hasDelete: Boolean(document.getElementById('ed-delete')),
    deleteColor: style('#ed-delete', 'color'),
    scrollHeight: document.documentElement.scrollHeight,
  }
})()`

/**
 * 检查编辑面板的真实布局。
 * @param {object} client - CDP 客户端
 * @param {string} id - 文档 id
 * @returns {Promise<boolean>} 是否通过
 */
async function checkEditor(client, id) {
  console.log('\n【编辑面板真实渲染】')
  await openPage(client, `${BASE}/view.html?id=${id}`)

  // 点开编辑面板（等前端把角色与词表都拉回来）
  const clicked = await evaluate(client, `(() => {
    const b = document.getElementById('btn-edit')
    if (!b) return false
    b.click()
    return true
  })()`)
  if (!clicked) {
    console.log('  ✗ 找不到「编辑元数据」按钮（本地开发应为 admin 角色）')
    return false
  }
  await new Promise((r) => setTimeout(r, 600))

  const r = await evaluate(client, EDITOR_PROBE)
  const line = (l, v) => console.log(`  ${l.padEnd(22)} ${v}`)

  line('编辑按钮', r.hasEditButton ? '有' : '无')
  line('面板已展开', r.hasEditor ? '是' : '否')
  line('面板尺寸', r.editorBox ? `${r.editorBox.w}×${r.editorBox.h}` : '缺失')
  line('面板边框色', r.editorBorderColor)
  line('标题预填', r.titleValue ?? '（空）')
  line('分类选项', `${r.catOptionCount} 个，已勾选 ${r.checkedCount} 个`)
  line('选项尺寸/圆角', r.firstOptBox ? `${r.firstOptBox.w}×${r.firstOptBox.h} / ${r.firstOptRadius}` : '缺失')
  line('选中项背景色', r.activeOptBg)
  line('标签/摘要/可见性输入', `${r.hasTags ? '有' : '无'} / ${r.hasSummary ? '有' : '无'} / ${r.hasVisibility ? '有' : '无'}`)
  line('保存/删除按钮', `${r.hasSave ? '有' : '无'} / ${r.hasDelete ? '有' : '无'}`)
  line('删除按钮颜色', r.deleteColor)

  const issues = []
  if (!r.hasEditor) issues.push('编辑面板没渲染出来')
  if (r.editorBox && r.editorBox.h < 200) issues.push(`面板高度异常（${r.editorBox.h}px）`)
  if (r.catOptionCount < 9) issues.push(`分类选项只有 ${r.catOptionCount} 个`)
  if (!r.hasTags || !r.hasSummary || !r.hasVisibility) issues.push('缺少部分输入控件')
  if (!r.hasSave || !r.hasDelete) issues.push('缺少保存或删除按钮')
  if (issues.length === 0) console.log('\n  ✓ 编辑面板布局与样式正常')
  else issues.forEach((i) => console.log(`\n  ✗ ${i}`))

  const bytes = await screenshot(client, 'editor')
  console.log(`  截图已存 .shots/editor.png（${(bytes / 1024).toFixed(1)}KB）`)
  return issues.length === 0
}

/* ============================================================
   主流程
   ============================================================ */

async function main() {
  const browser = findBrowser()
  const profileDir = join(ROOT, '.shots', 'chrome-profile')
  mkdirSync(SHOTS, { recursive: true })

  console.log('▸ R_N_Database 真实浏览器渲染检查')
  console.log(`  浏览器 ${browser}`)

  const child = spawn(browser, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    '--window-size=1440,980',
    'about:blank',
  ], { stdio: 'ignore', detached: false })

  let ok = true
  let client = null

  try {
    const version = await waitForCdp(PORT)
    console.log(`  已连接 ${version.Browser}\n`)

    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const page = targets.find((t) => t.type === 'page')
    if (!page) throw new Error('没有可用的页面 target')

    client = await connectCdp(page.webSocketDebuggerUrl)

    ok = (await checkList(client)) && ok

    // 阅读页：取一份 PDF 与一份非 PDF
    const listRes = await fetch(`${BASE}/api/v1/docs`)
    const list = await listRes.json()
    const pdf = list.data.items.find((d) => d.type === 'pdf')
    const other = list.data.items.find((d) => d.type !== 'pdf')

    if (pdf) ok = (await checkView(client, pdf.id, 'PDF 内嵌预览', 'view-pdf')) && ok
    if (other) ok = (await checkView(client, other.id, `${other.type.toUpperCase()} 预览`, `view-${other.type}`)) && ok
    if (other) ok = (await checkEditor(client, other.id)) && ok
  } finally {
    try {
      client?.ws.close()
    } catch {
      /* 忽略 */
    }
    child.kill()
    await new Promise((r) => setTimeout(r, 400))
    try {
      rmSync(profileDir, { recursive: true, force: true })
    } catch {
      /* 配置文件被占用时忽略，下次会覆盖 */
    }
  }

  console.log('\n────────────────────────────────')
  console.log(ok ? '  ✓ 全部渲染检查通过' : '  ✗ 存在渲染问题，见上方 ✗ 标记')
  console.log('')
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error('\n渲染检查失败：', err?.message ?? err)
  process.exit(1)
})
