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

/** 列表页要问的渲染事实（含两个盒子的独立滚动能力）。 */
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
  const side = document.querySelector('.sidebar')
  const main = document.querySelector('.main')
  const docs = [...document.querySelectorAll('.doc')]
  const doc = document.documentElement
  return {
    viewport: { w: innerWidth, h: innerHeight },
    bodyOverflow: getComputedStyle(document.body).overflow,
    pageScrolls: doc.scrollHeight > innerHeight + 2,
    pageScrollHeight: doc.scrollHeight,

    bodyBg: style('body', 'backgroundColor'),
    cssLoaded: style('body', 'backgroundColor') !== 'rgba(0, 0, 0, 0)',

    topbar: box('.topbar'),
    topbarPosition: style('.topbar', 'position'),

    // 两个盒子
    sidebarBox: box('.sidebar'),
    mainBox: box('.main'),
    layoutCols: style('.layout', 'gridTemplateColumns'),
    gap: style('.layout', 'gap'),

    sidebarBorder: style('.sidebar', 'borderTopWidth'),
    mainBorder: style('.main', 'borderTopWidth'),
    sidebarRadius: style('.sidebar', 'borderRadius'),
    mainRadius: style('.main', 'borderRadius'),
    sidebarOverflowY: style('.sidebar', 'overflowY'),
    mainOverflowY: style('.main', 'overflowY'),

    // 独立滚动能力
    sidebarScrollH: side ? side.scrollHeight : null,
    sidebarClientH: side ? side.clientHeight : null,
    mainScrollH: main ? main.scrollHeight : null,
    mainClientH: main ? main.clientHeight : null,

    docCount: docs.length,
    firstDocTitle: docs[0]?.querySelector('.doc-title')?.textContent?.trim() ?? null,
    chipCount: document.querySelectorAll('.chip').length,
    stats: document.getElementById('stats')?.textContent?.trim() ?? null,
    searchBox: box('#search'),
    listHeadPosition: style('.list-head', 'position'),
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
  line('CSS 是否生效', r.cssLoaded ? `是（body 背景 ${r.bodyBg}）` : '★ 否 —— 样式没加载')
  line('整页是否滚动', r.pageScrolls ? `★ 会滚动（内容 ${r.pageScrollHeight}px）` : '已锁定（滚动在盒子里）')

  console.log('  ── 两个盒子 ──')
  line('布局列', `${r.layoutCols}（间距 ${r.gap}）`)
  line('左侧盒子', r.sidebarBox ? `${r.sidebarBox.w}×${r.sidebarBox.h} @ x=${r.sidebarBox.x}` : '缺失')
  line('右侧盒子', r.mainBox ? `${r.mainBox.w}×${r.mainBox.h} @ x=${r.mainBox.x}` : '缺失')
  line('边框 / 圆角', `左 ${r.sidebarBorder}/${r.sidebarRadius}　右 ${r.mainBorder}/${r.mainRadius}`)
  line('各自 overflow-y', `左 ${r.sidebarOverflowY}　右 ${r.mainOverflowY}`)
  line('左盒子内容/可视高', `${r.sidebarScrollH} / ${r.sidebarClientH}`)
  line('右盒子内容/可视高', `${r.mainScrollH} / ${r.mainClientH}`)

  console.log('  ── 内容 ──')
  line('文档卡片数', r.docCount)
  line('首条标题', r.firstDocTitle ?? '（空）')
  line('筛选切面数', r.chipCount)
  line('统计行', `${r.stats}（position: ${r.listHeadPosition}）`)
  line('搜索框', r.searchBox ? `${r.searchBox.w}×${r.searchBox.h}` : '缺失')

  const issues = []
  if (!r.cssLoaded) issues.push('CSS 未生效（body 背景透明）')
  if (r.pageScrolls) issues.push('整页不该滚动，滚动应当发生在两个盒子里')
  if (r.bodyOverflow !== 'hidden') issues.push(`body overflow 应为 hidden（现为 ${r.bodyOverflow}）`)
  if (!r.sidebarBox || r.sidebarBox.w < 150) issues.push('左侧盒子宽度异常')
  if (!r.mainBox || r.mainBox.w < 400) issues.push('右侧盒子宽度异常')
  // 左右并排：右侧盒子应当明显在左侧盒子右边
  if (r.sidebarBox && r.mainBox && r.mainBox.x <= r.sidebarBox.x + r.sidebarBox.w) {
    issues.push('两个盒子不是左右并排')
  }
  if (r.sidebarBorder !== '1px' || r.mainBorder !== '1px') issues.push('两个盒子应当各有边框')
  if (r.sidebarOverflowY !== 'auto' || r.mainOverflowY !== 'auto') issues.push('两个盒子应当各自 overflow-y:auto')
  if (!r.mainScrollH || !r.mainClientH || r.mainScrollH <= r.mainClientH) {
    issues.push('右侧盒子内容没有超出高度，无法验证独立滚动')
  }
  if (r.docCount < 1) issues.push('没有渲染出任何文档卡片')
  if (r.chipCount < 3) issues.push('筛选切面太少')
  if (r.listHeadPosition !== 'sticky') issues.push('统计行应当贴顶吸附')

  // ---- 独立滚动：滚右边，左边不该跟着动 ----
  if (r.sidebarScrollH > r.sidebarClientH) {
    await evaluate(client, `document.querySelector('.main').scrollTop = 600`)
    await new Promise((res) => setTimeout(res, 250))
    const after = await evaluate(client, `({
      mainTop: document.querySelector('.main').scrollTop,
      sideTop: document.querySelector('.sidebar').scrollTop,
      pageTop: window.scrollY,
      docTop: document.scrollingElement.scrollTop,
    })`)
    line('滚右边 600px 后', `右 ${after.mainTop}　左 ${after.sideTop}　整页 ${after.docTop}`)
    if (after.mainTop < 500) issues.push('右侧盒子没有真的滚动')
    if (after.sideTop !== 0) issues.push('滚右边时左边跟着动了（未独立）')
    if (after.docTop !== 0) issues.push('滚右边时整页也滚了（未独立）')
  } else {
    line('独立滚动验证', '左盒子内容未超屏，仅验证右盒子与整页互不影响')
    await evaluate(client, `document.querySelector('.main').scrollTop = 600`)
    await new Promise((res) => setTimeout(res, 250))
    const after = await evaluate(client, `({
      mainTop: document.querySelector('.main').scrollTop,
      docTop: document.scrollingElement.scrollTop,
    })`)
    line('滚右边 600px 后', `右 ${after.mainTop}　整页 ${after.docTop}`)
    if (after.mainTop < 500) issues.push('右侧盒子没有真的滚动')
    if (after.docTop !== 0) issues.push('滚右边时整页也滚了（未独立）')
  }

  if (issues.length === 0) console.log('\n  ✓ 两个盒子独立滚动正常')
  else issues.forEach((i) => console.log(`\n  ✗ ${i}`))

  const bytes = await screenshot(client, 'list')
  console.log(`  截图已存 .shots/list.png（${(bytes / 1024).toFixed(1)}KB）`)
  return issues.length === 0
}

/* ============================================================
   阅读页检查
   ============================================================ */

/** 阅读页要问的渲染事实（文档优先布局）。 */
const VIEW_PROBE = `(() => {
  const box = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.y) }
  }
  const frame = document.querySelector('iframe')
  const panel = document.getElementById('panel')
  const doc = document.documentElement
  return {
    viewportH: innerHeight,
    viewportW: innerWidth,
    bodyOverflow: getComputedStyle(document.body).overflow,
    title: document.getElementById('doc-title')?.textContent?.trim() ?? null,
    titleFontSize: getComputedStyle(document.getElementById('doc-title')).fontSize,
    titleWhiteSpace: getComputedStyle(document.getElementById('doc-title')).whiteSpace,
    topbar: box('.view-topbar'),
    frameBox: box('#frame'),
    frameFillRatio: box('#frame') ? +(box('#frame').h / innerHeight).toFixed(3) : null,
    // 关键：详情面板默认必须折叠
    panelHidden: panel ? panel.hasAttribute('hidden') : null,
    panelBox: panel && !panel.hasAttribute('hidden') ? box('#panel') : null,
    metaText: document.getElementById('doc-meta')?.textContent?.trim()?.slice(0, 60) ?? null,
    tagCount: document.querySelectorAll('#doc-tags .tag').length,
    topbarButtons: [...document.querySelectorAll('.view-topbar .actions .btn')].map(b => b.textContent.trim()),
    downloadHref: [...document.querySelectorAll('.actions a')].find(a => a.textContent.includes('下载'))?.getAttribute('href') ?? null,
    frameKind: frame ? (frame.className || 'iframe') : null,
    frameSrc: frame ? frame.getAttribute('src')?.slice(0, 55) : null,
    // 页面是否还能滚动（文档优先布局应当锁住整页滚动）
    docScrollH: doc.scrollHeight,
    pageScrolls: doc.scrollHeight > innerHeight + 2,
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
  line('视口', `${r.viewportW}×${r.viewportH}`)
  line('标题', r.title ?? '（空）')
  line('标题字号/不换行', `${r.titleFontSize} / ${r.titleWhiteSpace}`)
  line('顶栏高度', r.topbar ? `${r.topbar.h}px（占视口 ${(r.topbar.h / r.viewportH * 100).toFixed(1)}%）` : '缺失')
  line('文档区高度', r.frameBox ? `${r.frameBox.h}px（占视口 ${(r.frameFillRatio * 100).toFixed(1)}%）` : '缺失')
  line('详情面板', r.panelHidden === true ? '默认折叠 ✓' : r.panelHidden === false ? '★ 默认展开了' : '缺失')
  line('顶栏按钮', r.topbarButtons.join(' / '))
  line('下载链接', r.downloadHref ?? '缺失')
  line('预览类型', `${r.frameKind} → ${r.frameSrc}…`)
  line('整页滚动', r.pageScrolls ? `★ 会滚动（文档高度 ${r.docScrollH}）` : '已锁定（文档区内部滚动）')

  const issues = []
  if (!r.title || r.title === '加载中…') issues.push('标题未加载')
  if (!r.frameKind) issues.push('没有预览 iframe')
  // 文档优先：文档区应吃掉绝大部分视口
  if (r.frameFillRatio !== null && r.frameFillRatio < 0.85) {
    issues.push(`文档区只占视口 ${(r.frameFillRatio * 100).toFixed(1)}%，元信息仍占太多空间`)
  }
  if (r.topbar && r.topbar.h > 60) issues.push(`顶栏过高（${r.topbar.h}px）`)
  if (r.panelHidden !== true) issues.push('详情面板默认应当是折叠的')
  if (r.pageScrolls) issues.push('整页不应滚动（应锁在文档区内滚动）')
  if (!r.downloadHref) issues.push('没有下载链接')
  if (issues.length === 0) console.log('\n  ✓ 文档优先布局正常')
  else issues.forEach((i) => console.log(`\n  ✗ ${i}`))

  const bytes = await screenshot(client, shotName)
  console.log(`  截图已存 .shots/${shotName}.png（${(bytes / 1024).toFixed(1)}KB）`)

  // 展开详情面板：验证面板出现且文档区相应收缩，然后再收起
  await evaluate(client, `document.getElementById('btn-info')?.click()`)
  await new Promise((r2) => setTimeout(r2, 300))
  const opened = await evaluate(client, VIEW_PROBE)
  const okOpen = opened.panelHidden === false && (opened.frameBox?.h ?? 0) < (r.frameBox?.h ?? 0)
  console.log(`  展开详情：面板高 ${opened.panelBox?.h ?? 0}px，文档区 ${r.frameBox?.h ?? 0} → ${opened.frameBox?.h ?? 0}px  ${okOpen ? '✓' : '✗'}`)
  if (!okOpen) issues.push('点「详情」后面板未展开或文档区未相应收缩')
  await screenshot(client, `${shotName}-panel`)

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
   Markdown 双视图检查
   ============================================================ */

/** 双视图要问的渲染事实（含 iframe 内部，同源可直接读）。 */
const MD_PROBE = `(() => {
  const box = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height) }
  }
  const btns = [...document.querySelectorAll('.mode-switch button')]
  const frame = document.querySelector('#frame iframe')
  let inner = null
  try {
    const d = frame?.contentDocument
    if (d) {
      inner = {
        hasLineNo: !!d.querySelector('.ln'),
        lineCount: d.querySelectorAll('.ln').length,
        hasHeading: !!d.querySelector('h1, h2, h3'),
        hasPre: !!d.querySelector('pre'),
        hasTable: !!d.querySelector('table'),
        bodyLen: d.body?.innerHTML?.length ?? 0,
        fontFamily: d.querySelector('.src') ? getComputedStyle(d.querySelector('.src')).fontFamily.slice(0, 30) : null,
      }
    }
  } catch (e) { inner = { error: String(e.message) } }
  return {
    modeButtons: btns.map(b => ({ text: b.textContent.trim(), on: b.classList.contains('on') })),
    switchBox: box('.mode-switch'),
    frameSrc: frame?.getAttribute('src') ?? null,
    frameBox: box('#frame'),
    inner,
    topbarH: box('.view-topbar')?.h ?? null,
  }
})()`

/**
 * 检查 Markdown 双视图。
 * @param {object} client - CDP 客户端
 * @param {string} id - Markdown 文档 id
 * @param {string} title - 文档标题
 * @returns {Promise<boolean>} 是否通过
 */
async function checkMarkdown(client, id, title) {
  console.log(`\n【Markdown 双视图 · ${String(title).slice(0, 20)}】`)
  await openPage(client, `${BASE}/view.html?id=${id}`)
  await new Promise((r) => setTimeout(r, 900))   // 等 iframe 内容加载

  const issues = []
  const line = (l, v) => console.log(`  ${l.padEnd(22)} ${v}`)

  const render = await evaluate(client, MD_PROBE)
  line('切换控件', render.modeButtons.map((b) => `${b.text}${b.on ? '●' : ''}`).join(' / '))
  line('控件尺寸', render.switchBox ? `${render.switchBox.w}×${render.switchBox.h}` : '缺失')
  line('iframe 地址', render.frameSrc?.replace(/token=[^&]*/, 'token=***') ?? '缺失')
  line('渲染视图内容', render.inner
    ? `标题 ${render.inner.hasHeading ? '有' : '无'} / 表格 ${render.inner.hasTable ? '有' : '无'} / 代码块 ${render.inner.hasPre ? '有' : '无'} / 行号 ${render.inner.lineCount}`
    : '读不到 iframe')

  if (render.modeButtons.length !== 2) issues.push('没有出现两个模式按钮')
  if (!render.modeButtons.some((b) => b.text.includes('文本') && b.on)) issues.push('默认应停在「文本」模式')
  if (render.inner?.hasLineNo) issues.push('渲染视图不该出现源码行号')
  if (!render.inner?.hasHeading) issues.push('渲染视图没有渲染出标题')

  // ---- 切到源码 ----
  await evaluate(client, `[...document.querySelectorAll('.mode-switch button')].find(b => b.textContent.includes('源码'))?.click()`)
  await new Promise((r) => setTimeout(r, 900))

  const source = await evaluate(client, MD_PROBE)
  line('切换后按钮', source.modeButtons.map((b) => `${b.text}${b.on ? '●' : ''}`).join(' / '))
  line('切换后 iframe', source.frameSrc?.includes('mode=source') ? '已带 mode=source' : (source.frameSrc?.slice(0, 60) ?? '缺失'))
  line('源码视图内容', source.inner
    ? `行号 ${source.inner.lineCount} 行 / HTML 标题 ${source.inner.hasHeading ? '有（不该有）' : '无'} / 等宽 ${source.inner.fontFamily ?? '-'}`
    : '读不到 iframe')

  if (!source.modeButtons.some((b) => b.text.includes('源码') && b.on)) issues.push('点「源码」后按钮未高亮')
  if (!(source.frameSrc ?? '').includes('mode=source')) issues.push('iframe 地址没有切到 mode=source')
  if (!source.inner?.hasLineNo) issues.push('源码视图没有行号')
  if ((source.inner?.lineCount ?? 0) < 2) issues.push(`源码视图行号太少（${source.inner?.lineCount}）`)
  if (source.inner?.hasHeading) issues.push('源码视图不该渲染出 HTML 标题')

  // 切回文本
  await evaluate(client, `[...document.querySelectorAll('.mode-switch button')].find(b => b.textContent.includes('文本'))?.click()`)
  await new Promise((r) => setTimeout(r, 700))
  const back = await evaluate(client, MD_PROBE)
  line('切回文本', back.inner?.hasLineNo ? '★ 仍是源码视图' : '已回到渲染视图')
  if (back.inner?.hasLineNo) issues.push('切回「文本」后没有回到渲染视图')

  if (issues.length === 0) console.log('\n  ✓ 双视图切换正常')
  else issues.forEach((i) => console.log(`\n  ✗ ${i}`))

  await screenshot(client, 'md-render')
  console.log('  截图已存 .shots/md-render.png')
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

    // Markdown 双视图
    const md = list.data.items.find((d) => d.type === 'md')
    if (md) ok = (await checkMarkdown(client, md.id, md.title)) && ok

    // Office 文档应当是 PDF 预览（装了 LibreOffice 的前提下）
    const office = list.data.items.find((d) => ['pptx', 'docx', 'xlsx'].includes(d.type))
    const soffice = ['C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
      '/usr/bin/soffice'].some((p) => existsSync(p))

    if (office) {
      console.log('\n【Office 文档预览保真度】')
      console.log(`  文档 ${String(office.title).slice(0, 24)}（${office.type}）→ previewKind = ${office.previewKind}`)
      console.log(`  LibreOffice ${soffice ? '已安装' : '未安装'}`)
      if (soffice && office.previewKind !== 'pdf') {
        console.log('  ✗ 装了 LibreOffice 却仍走 HTML 降级 —— 版式会丢失')
        ok = false
      } else if (soffice) {
        console.log('  ✓ 走 PDF 高保真预览')
        // ★ 必须先导航到这个文档，否则读到的是上一个检查残留的页面
        await openPage(client, `${BASE}/view.html?id=${office.id}`)
        await new Promise((r2) => setTimeout(r2, 1200))
        const r = await evaluate(client, `(() => {
          const f = document.querySelector('#frame iframe')
          return { cls: f?.className ?? null, src: f?.getAttribute('src')?.slice(0, 55) ?? null }
        })()`)
        console.log(`  iframe ${r.cls} → ${r.src}…`)
        if (r.cls !== 'pdf') {
          console.log('  ✗ Office 文档没有用 PDF 渲染器')
          ok = false
        } else {
          const bytes = await screenshot(client, 'view-office')
          console.log(`  ✓ 用 PDF 渲染器打开，截图 .shots/view-office.png（${(bytes / 1024).toFixed(1)}KB）`)
        }
      } else {
        console.log('  · 未装 LibreOffice，此处只报告不断言')
      }
    }
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
