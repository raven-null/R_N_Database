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

import { provisionFixtures, cleanupFixtures } from './lib/fixtures.mjs'

const ROOT = process.cwd()
const BASE = process.env.RENDER_BASE ?? 'http://127.0.0.1:8899'
const SHOTS = join(ROOT, '.shots')
const PORT = 9333

/** 夹具标记（库里原有文档不受影响，跑完即删）。 */
const MARK = `RNDBRENDER${Date.now()}`
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

    // 来源目录树：行数、行高，以及侧栏有没有被长路径撑出横向滚动
    dirRows: document.querySelectorAll('.dir-row').length,
    dirRowBox: box('.dir-row'),
    dirTreeBox: box('.dir-tree'),
    sidebarScrollW: side ? side.scrollWidth : null,
    sidebarClientW: side ? side.clientWidth : null,
    dirNames: [...document.querySelectorAll('.dir-name')]
      .map((b) => b.getAttribute('title') ?? b.textContent.trim()).slice(0, 6),
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
  line('来源目录树', r.dirRows > 0
    ? `${r.dirRows} 行，高 ${r.dirTreeBox?.h ?? 0}px　${r.dirNames.join(' / ')}`
    : '（库里没有来源目录信息）')
  line('侧栏滚动宽/可视宽', `${r.sidebarScrollW} / ${r.sidebarClientW}`)

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
    // 库很小（例如只有几个测试夹具）时右侧内容本来就不会溢出，
    // 这不是缺陷 —— 下面的滚动独立性检查仍然照跑
    line('右侧内容溢出', `未溢出（内容 ${r.mainScrollH} / 可视 ${r.mainClientH}），跳过溢出相关断言`)
  }
  if (r.docCount < 1) issues.push('没有渲染出任何文档卡片')
  if (r.chipCount < 3) issues.push('筛选切面太少')
  if (r.listHeadPosition !== 'sticky') issues.push('统计行应当贴顶吸附')

  // 来源目录树：库里有文档就该有目录节点；长路径不能把侧栏撑出横向滚动
  if (r.docCount > 0 && r.dirRows === 0) issues.push('有文档却没有渲染出来源目录树')
  if (r.dirRows > 0 && (r.dirRowBox?.h ?? 0) < 10) issues.push('目录行高度塌陷')
  if (r.sidebarScrollW && r.sidebarClientW && r.sidebarScrollW > r.sidebarClientW + 2) {
    issues.push(`侧栏被撑出横向滚动（内容宽 ${r.sidebarScrollW} > 可视 ${r.sidebarClientW}）`
      + ' —— 长目录名没截断')
  }

  // ---- 独立滚动：滚右边，左边不该跟着动 ----
  // ★ 只有内容真的超出可视高度时才谈得上「能滚」，而且**能滚的距离**
  // 取决于内容多少（几份文档时可能只有几十像素）。所以断言"滚到了
  // 它能滚到的位置"，而不是写死 600。
  const mainOverflows = (r.mainScrollH ?? 0) > (r.mainClientH ?? 0)
  const maxScroll = Math.max(0, (r.mainScrollH ?? 0) - (r.mainClientH ?? 0))
  const want = Math.min(600, maxScroll)

  await evaluate(client, `document.querySelector('.main').scrollTop = 600`)
  await new Promise((res) => setTimeout(res, 250))
  const after = await evaluate(client, `({
    mainTop: document.querySelector('.main').scrollTop,
    sideTop: document.querySelector('.sidebar').scrollTop,
    docTop: document.scrollingElement.scrollTop,
  })`)
  line('滚右边 600px 后', `右 ${after.mainTop}（最多可滚 ${maxScroll}）　左 ${after.sideTop}　整页 ${after.docTop}`)

  if (mainOverflows) {
    if (Math.abs(after.mainTop - want) > 2) {
      issues.push(`右侧盒子滚到了 ${after.mainTop}，但最多应能滚到 ${want}`)
    }
  } else {
    line('滚动独立性验证', '内容未超屏，无法触发滚动（不是缺陷）；仍检查整页是否被带动')
  }
  if (r.sidebarScrollH > r.sidebarClientH && after.sideTop !== 0) {
    issues.push('滚右边时左边跟着动了（未独立）')
  }
  if (after.docTop !== 0) issues.push('滚右边时整页也滚了（未独立）')

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
    // ★ 预览地址必须带版本号：预览件是派生产物、会被重新生成，
    // 而不带版本号的地址若标了 immutable，浏览器会永远用旧预览件
    frameHasVersion: /[?&]v=/.test(frame?.getAttribute('src') ?? ''),
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
  line('预览地址带版本号', r.frameHasVersion ? '是 ✓' : '★ 否 —— 会卡在旧预览件上')
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
  if (!r.frameHasVersion) {
    issues.push('预览地址未带版本号 —— 预览件重新生成后浏览器会一直用旧缓存')
  }
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

/**
 * 检查上传 / 多选 / 标签管理这三块新 UI 的真实渲染与交互。
 * @param {object} client - CDP 客户端
 * @returns {Promise<boolean>} 是否通过
 */
async function checkTools(client) {
  console.log('\n【上传 / 多选 / 标签管理】')
  await openPage(client, `${BASE}/`)
  await new Promise((r) => setTimeout(r, 900))

  const issues = []
  const line = (l, v) => console.log(`  ${l.padEnd(22)} ${v}`)

  const probe = `(() => {
    const box = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { w: Math.round(r.width), h: Math.round(r.height) }
    }
    return {
      hasUpload: !!document.getElementById('btn-upload'),
      hasUploadDir: !!document.getElementById('btn-upload-dir'),
      uploadDirBox: box('#btn-upload-dir'),
      hasSelect: !!document.getElementById('btn-select'),
      hasTagAdmin: !!document.getElementById('btn-tags'),
      uploadBox: box('#btn-upload'),
      quickTagCount: document.querySelectorAll('.quick-tag').length,
      selbarHidden: document.getElementById('selbar')?.hasAttribute('hidden'),
      checkCount: document.querySelectorAll('.doc-check').length,
      docLinkCount: document.querySelectorAll('.doc-link').length,
      docCount: document.querySelectorAll('.doc').length,
    }
  })()`

  const r = await evaluate(client, probe)
  line('上传按钮', r.hasUpload ? `${r.uploadBox?.w}×${r.uploadBox?.h}` : '缺失')
  line('传文件夹按钮', r.hasUploadDir ? `${r.uploadDirBox?.w}×${r.uploadDirBox?.h}` : '缺失')
  line('选择按钮', r.hasSelect ? '有' : '缺失')
  line('标签管理入口', r.hasTagAdmin ? '有' : '缺失')
  line('卡片可点区域', `${r.docLinkCount} 个 .doc-link / ${r.docCount} 张卡片`)
  line('快速打标签按钮', `${r.quickTagCount} 个`)
  line('批量操作栏', r.selbarHidden ? '默认隐藏 ✓' : '★ 默认显示了')

  if (!r.hasUpload) issues.push('缺少上传按钮')
  if (!r.hasUploadDir) issues.push('缺少「传文件夹」按钮')
  if (r.uploadDirBox && r.uploadDirBox.h < 24) issues.push('「传文件夹」按钮高度塌陷')
  if (!r.hasSelect) issues.push('缺少选择按钮')
  if (!r.hasTagAdmin) issues.push('缺少标签管理入口')
  if (r.docCount > 0 && r.docLinkCount !== r.docCount) {
    issues.push(`可点区域数(${r.docLinkCount})与卡片数(${r.docCount})不一致 —— 卡片结构可能坏了`)
  }
  if (r.quickTagCount !== r.docCount) issues.push('不是每张卡片都有快速打标签按钮')
  if (!r.selbarHidden) issues.push('批量操作栏应当默认隐藏')

  // ---- 进入选择模式：出现勾选框、操作栏弹出 ----
  await evaluate(client, `document.getElementById('btn-select')?.click()`)
  await new Promise((rr) => setTimeout(rr, 400))
  const sel = await evaluate(client, probe)
  line('进入选择模式后', `勾选框 ${sel.checkCount} 个 / 操作栏${sel.selbarHidden ? '仍隐藏 ✗' : '已弹出 ✓'}`)
  if (sel.checkCount !== sel.docCount) issues.push('选择模式下每张卡片都应有勾选框')
  if (sel.selbarHidden) issues.push('进入选择模式后操作栏没有出现')

  // 勾一个，看计数是否变化
  await evaluate(client, `document.querySelector('.doc-check input')?.click()`)
  await new Promise((rr) => setTimeout(rr, 350))
  const picked = await evaluate(client, `(() => ({
    count: document.querySelector('.selbar-count')?.textContent?.trim() ?? '',
    actions: [...document.querySelectorAll('.selbar-actions .btn')].map(b => b.textContent.trim()),
    hasPanel: !!document.querySelector('.selbar-panel'),
  }))()`)
  line('勾选一份后', picked.count)
  line('批量动作', picked.actions.join(' / '))
  if (!/1/.test(picked.count)) issues.push(`勾选计数不对：${picked.count}`)
  if (picked.actions.length < 5) issues.push(`批量动作太少：${picked.actions.join('/')}`)

  // 点「加标签」应弹出输入面板
  await evaluate(client, `[...document.querySelectorAll('.selbar-actions .btn')].find(b => b.textContent.includes('加标签'))?.click()`)
  await new Promise((rr) => setTimeout(rr, 350))
  const panel = await evaluate(client, `(() => ({
    hasInput: !!document.getElementById('selbar-tags'),
    box: (() => { const el = document.querySelector('.selbar-panel'); if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } })(),
  }))()`)
  line('「加标签」面板', panel.hasInput ? `已展开 ${panel.box?.w}×${panel.box?.h}` : '★ 没展开')
  if (!panel.hasInput) issues.push('点「加标签」没有出现输入框')

  const bytes = await screenshot(client, 'tools-selbar')
  console.log(`  截图已存 .shots/tools-selbar.png（${(bytes / 1024).toFixed(1)}KB）`)

  // 退出选择模式
  await evaluate(client, `[...document.querySelectorAll('.selbar-actions, .selbar-inner')].flatMap(e => [...e.querySelectorAll('.btn')]).find(b => b.textContent.includes('退出选择'))?.click()`)
  await new Promise((rr) => setTimeout(rr, 350))

  // ---- 快速打标签浮层 ----
  await evaluate(client, `document.querySelector('.quick-tag')?.click()`)
  await new Promise((rr) => setTimeout(rr, 400))
  const pop = await evaluate(client, `(() => {
    const el = document.querySelector('.popover')
    if (!el) return { open: false }
    const r = el.getBoundingClientRect()
    return { open: true, w: Math.round(r.width), h: Math.round(r.height), hasInput: !!document.getElementById('qt-input') }
  })()`)
  line('快速打标签浮层', pop.open ? `${pop.w}×${pop.h}，输入框${pop.hasInput ? '有' : '无'}` : '★ 没弹出')
  if (!pop.open) issues.push('点「＋标签」没有弹出浮层')
  if (pop.open && !pop.hasInput) issues.push('浮层里没有输入框')
  await evaluate(client, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
  await new Promise((rr) => setTimeout(rr, 250))

  // ---- 标签管理面板 ----
  await evaluate(client, `document.getElementById('btn-tags')?.click()`)
  await new Promise((rr) => setTimeout(rr, 900))
  const modal = await evaluate(client, `(() => {
    const el = document.querySelector('.modal')
    if (!el) return { open: false }
    const r = el.getBoundingClientRect()
    return {
      open: true, w: Math.round(r.width), h: Math.round(r.height),
      rows: document.querySelectorAll('.tag-table tbody tr').length,
      ops: [...document.querySelectorAll('.tag-ops .btn')].slice(0, 3).map(b => b.textContent.trim()),
    }
  })()`)
  line('标签管理面板', modal.open ? `${modal.w}×${modal.h}，${modal.rows} 行` : '★ 没弹出')
  line('每行操作', modal.ops?.join(' / ') ?? '-')
  if (!modal.open) issues.push('点「管理」没有弹出标签面板')
  if (modal.open && modal.rows < 1) issues.push('标签面板没有数据行')
  if (modal.open && !modal.ops?.includes('重命名')) issues.push('标签面板缺少重命名操作')

  const bytes2 = await screenshot(client, 'tools-tagmodal')
  console.log(`  截图已存 .shots/tools-tagmodal.png（${(bytes2 / 1024).toFixed(1)}KB）`)

  if (issues.length === 0) console.log('\n  ✓ 新 UI 渲染与交互正常')
  else issues.forEach((i) => console.log(`\n  ✗ ${i}`))
  return issues.length === 0
}

/**
 * 空库时的检查：此时用户看到的就是空状态，它本身也是一个该验证的界面。
 * @param {object} client - CDP 客户端
 * @returns {Promise<boolean>} 是否通过
 */
async function checkEmptyState(client) {
  console.log('\n【空库 · 空状态界面】')
  await openPage(client, `${BASE}/`)
  await new Promise((r) => setTimeout(r, 900))

  const r = await evaluate(client, `(() => {
    const box = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const b = el.getBoundingClientRect()
      return { w: Math.round(b.width), h: Math.round(b.height) }
    }
    const empty = document.querySelector('#results .empty')
    return {
      docCount: document.querySelectorAll('.doc').length,
      emptyText: empty?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 120) ?? null,
      emptyBox: box('#results .empty'),
      stats: document.getElementById('stats')?.textContent?.trim() ?? null,
      chips: [...document.querySelectorAll('.chip')].map((c) => c.textContent.trim()).slice(0, 6),
      hasUpload: !!document.getElementById('btn-upload'),
      hasTagAdmin: !!document.getElementById('btn-tags'),
      sidebarText: document.querySelector('.sidebar')?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 80) ?? null,
      cssLoaded: getComputedStyle(document.body).backgroundColor !== 'rgba(0, 0, 0, 0)',
      bodyOverflow: getComputedStyle(document.body).overflow,
    }
  })()`)

  const line = (l, v) => console.log(`  ${l.padEnd(22)} ${v}`)
  line('文档卡片', `${r.docCount} 张（应为 0）`)
  line('统计行', r.stats ?? '（无）')
  line('空状态提示', r.emptyText ?? '★ 没有空状态提示')
  line('空状态区域', r.emptyBox ? `${r.emptyBox.w}×${r.emptyBox.h}` : '缺失')
  line('筛选切面', r.chips.join(' / ') || '（无）')
  line('侧栏', r.sidebarText ?? '（无）')
  line('上传 / 标签管理入口', `${r.hasUpload ? '有' : '无'} / ${r.hasTagAdmin ? '有' : '无'}`)
  line('CSS / 整页滚动', `${r.cssLoaded ? '已生效' : '★ 未生效'} / ${r.bodyOverflow}`)

  const issues = []
  if (r.docCount !== 0) issues.push(`空库却渲染出 ${r.docCount} 张卡片`)
  if (!r.emptyText) issues.push('空库时没有任何引导文案 —— 用户会看到一片空白')
  if (!r.emptyText?.includes('上传') && !r.emptyText?.includes('ingest')) {
    issues.push('空状态没有告诉用户怎么往里加文档')
  }
  if (!r.cssLoaded) issues.push('CSS 未生效')
  if (r.bodyOverflow !== 'hidden') issues.push('整页滚动应当锁定')
  if (!r.hasUpload) issues.push('空库时也该有上传入口')

  if (issues.length === 0) console.log('\n  ✓ 空状态正常，且有明确的下一步引导')
  else issues.forEach((i) => console.log(`\n  ✗ ${i}`))

  const bytes = await screenshot(client, 'empty-state')
  console.log(`  截图已存 .shots/empty-state.png（${(bytes / 1024).toFixed(1)}KB）`)
  return issues.length === 0
}

/* ============================================================
   代码预览 / 内容编辑器检查
   ============================================================ */

/**
 * 代码预览页要问的渲染事实（读 iframe 内部：同源可直接访问）。
 *
 * 重点是**行号与代码行是否对齐**。行号是单独一列，靠相同的字号与行高
 * 对齐；一旦哪边多了一点 padding 或字号不同，行号就会整体偏移 ——
 * 这种问题在 DOM 结构测试里完全看不出来，只有真渲染才暴露。
 */
const CODE_PROBE = `(() => {
  const box = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height) }
  }
  const frame = document.querySelector('#frame iframe')
  const out = {
    frameCls: frame?.className ?? null,
    frameSrc: frame?.getAttribute('src') ?? null,
    hasVersion: /[?&]v=/.test(frame?.getAttribute('src') ?? ''),
    topbarButtons: [...document.querySelectorAll('.view-topbar .actions .btn')].map(b => b.textContent.trim()),
    notice: document.getElementById('notice')?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 80) ?? '',
  }
  try {
    const d = frame?.contentDocument
    if (!d) return { ...out, inner: null }
    const gutter = d.querySelector('.gutter')
    const pre = d.querySelector('pre.code')
    const gs = gutter ? getComputedStyle(gutter) : null
    const ps = pre ? getComputedStyle(pre) : null
    out.inner = {
      gutterLines: (gutter?.textContent ?? '').trim().split('\\n').length,
      codeLines: (pre?.textContent ?? '').replace(/\\n$/, '').split('\\n').length,
      gutterScrollH: gutter?.scrollHeight ?? null,
      codeScrollH: pre?.scrollHeight ?? null,
      gutterPaddingTop: gs?.paddingTop ?? null,
      codePaddingTop: ps?.paddingTop ?? null,
      gutterLineHeight: gs?.lineHeight ?? null,
      codeLineHeight: ps?.lineHeight ?? null,
      codeWhiteSpace: ps?.whiteSpace ?? null,
      gutterPosition: gs?.position ?? null,
      fontFamily: ps?.fontFamily?.slice(0, 40) ?? null,
      hljsSpans: d.querySelectorAll('.hljs-keyword, .hljs-string, .hljs-title, .hljs-number').length,
      lang: d.querySelector('.meta .lang')?.textContent?.trim() ?? null,
      metaLineCount: d.querySelector('.meta')?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 60) ?? null,
      bodyBg: getComputedStyle(d.body).backgroundColor,
    }
  } catch (e) {
    out.inner = { error: String(e.message) }
  }
  return out
})()`

/**
 * 检查代码文档的预览页（带行号 + 语法高亮）。
 * @param {object} client - CDP 客户端
 * @param {string} id - 代码文档 id
 * @returns {Promise<boolean>} 是否通过
 */
async function checkCodePreview(client, id) {
  console.log('\n【代码预览真实渲染】')
  await openPage(client, `${BASE}/view.html?id=${id}`)
  await new Promise((r) => setTimeout(r, 900))

  const r = await evaluate(client, CODE_PROBE)
  const line = (l, v) => console.log(`  ${l.padEnd(22)} ${v}`)
  const inner = r.inner ?? {}

  line('预览 iframe', `${r.frameCls ?? '缺失'}（带版本号：${r.hasVersion ? '是' : '否'}）`)
  line('语言标识', inner.lang ?? '缺失')
  line('元信息条', inner.metaLineCount ?? '缺失')
  line('行号列 / 代码行', `${inner.gutterLines} / ${inner.codeLines}`)
  line('行号列与代码高度', `${inner.gutterScrollH} / ${inner.codeScrollH}`)
  line('行高', `${inner.gutterLineHeight} / ${inner.codeLineHeight}（padding-top ${inner.gutterPaddingTop} / ${inner.codePaddingTop}）`)
  line('代码 white-space', inner.codeWhiteSpace ?? '缺失')
  line('行号列定位', `${inner.gutterPosition}（横向滚动时钉住）`)
  line('等宽字体', inner.fontFamily ?? '缺失')
  line('高亮 token 数', inner.hljsSpans ?? 0)
  line('页面背景', inner.bodyBg ?? '缺失')

  const issues = []
  if (r.frameCls !== 'html') issues.push(`代码文档的预览 iframe 类型是 ${r.frameCls}，应为 html`)
  if (!r.hasVersion) issues.push('预览地址没带版本号')
  if (!inner.gutterLines) issues.push('没有行号列')
  if (inner.gutterLines !== inner.codeLines) {
    issues.push(`行号数(${inner.gutterLines})与代码行数(${inner.codeLines})不一致`)
  }
  // ★ 对齐：两边 padding-top 与行高必须一致，总高度才会一致
  if (inner.gutterScrollH !== inner.codeScrollH) {
    issues.push(`行号列与代码块高度不等（${inner.gutterScrollH} vs ${inner.codeScrollH}）—— 行号会整体偏移`)
  }
  if (inner.gutterPaddingTop !== inner.codePaddingTop) issues.push('行号列与代码块的 padding-top 不一致')
  if (inner.gutterLineHeight !== inner.codeLineHeight) issues.push('行号列与代码块的行高不一致')
  if (inner.codeWhiteSpace !== 'pre') issues.push(`代码应保持 white-space: pre（现为 ${inner.codeWhiteSpace}）—— 折行会打乱行号`)
  if (inner.gutterPosition !== 'sticky') issues.push('行号列应当 position: sticky')
  if (!/mono|Consolas|Courier/i.test(inner.fontFamily ?? '')) issues.push('代码没用等宽字体')
  if ((inner.hljsSpans ?? 0) < 3) issues.push(`语法高亮没生效（token 数 ${inner.hljsSpans}）`)

  if (issues.length === 0) console.log('\n  ✓ 代码预览（行号对齐 + 高亮）正常')
  else issues.forEach((i) => console.log(`\n  ✗ ${i}`))

  const bytes = await screenshot(client, 'code-preview')
  console.log(`  截图已存 .shots/code-preview.png（${(bytes / 1024).toFixed(1)}KB）`)
  return issues.length === 0
}

/**
 * 内容编辑器要问的渲染事实。
 */
const CODE_EDITOR_PROBE = `(() => {
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
  const ta = document.getElementById('ce-text')
  return {
    hasButton: Boolean(document.getElementById('btn-edit-content')),
    hasEditor: Boolean(document.querySelector('.code-editor')),
    editorBox: box('.code-editor'),
    taBox: box('#ce-text'),
    taFont: style('#ce-text', 'fontFamily')?.slice(0, 40) ?? null,
    taFontSize: style('#ce-text', 'fontSize') ?? null,
    taWhiteSpace: style('#ce-text', 'whiteSpace') ?? null,
    taTabSize: style('#ce-text', 'tabSize') ?? null,
    taResize: style('#ce-text', 'resize') ?? null,
    taDisabled: ta ? ta.disabled : null,
    taLines: ta ? ta.value.split('\\n').length : 0,
    taChars: ta?.value?.length ?? 0,
    stat: document.getElementById('ce-stat')?.textContent?.trim() ?? null,
    saveDisabled: document.getElementById('ce-save')?.disabled ?? null,
    barText: document.querySelector('.code-edit-bar')?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 90) ?? null,
    viewportH: innerHeight,
  }
})()`

/**
 * 检查内容编辑器的真实布局与 Tab 缩进。
 * @param {object} client - CDP 客户端
 * @param {string} id - 代码文档 id
 * @returns {Promise<boolean>} 是否通过
 */
async function checkContentEditor(client, id) {
  console.log('\n【内容编辑器真实渲染】')
  await openPage(client, `${BASE}/view.html?id=${id}`)
  await new Promise((r) => setTimeout(r, 700))

  const clicked = await evaluate(client, `(() => {
    const b = document.getElementById('btn-edit-content')
    if (!b) return false
    b.click()
    return true
  })()`)
  if (!clicked) {
    console.log('  ✗ 找不到「编辑内容」按钮（本地开发应为 admin 角色，且这份文档应是代码/文本类）')
    return false
  }
  await new Promise((r) => setTimeout(r, 1200))   // 等原件取回来

  const r = await evaluate(client, CODE_EDITOR_PROBE)
  const line = (l, v) => console.log(`  ${l.padEnd(22)} ${v}`)

  line('编辑器尺寸', r.editorBox ? `${r.editorBox.w}×${r.editorBox.h}` : '缺失')
  line('编辑区尺寸', r.taBox ? `${r.taBox.w}×${r.taBox.h}（占视口 ${(r.taBox.h / r.viewportH * 100).toFixed(0)}%）` : '缺失')
  line('等宽 / 字号', `${r.taFont} / ${r.taFontSize}`)
  line('white-space / tab-size', `${r.taWhiteSpace} / ${r.taTabSize}`)
  line('可调整高度', r.taResize)
  line('已载入内容', `${r.taLines} 行 / ${r.taChars} 字`)
  line('统计行', r.stat ?? '缺失')
  line('操作提示', r.barText ?? '缺失')
  line('保存按钮可用', r.saveDisabled === false ? '是' : '否')

  const issues = []
  if (!r.hasEditor) issues.push('内容编辑器没渲染出来')
  if (r.taDisabled !== false) issues.push('编辑区仍是禁用状态（原件没取回来？）')
  if (r.taLines < 2) issues.push('编辑区没有载入内容')
  if (!r.taBox) issues.push('编辑区没有尺寸')
  // 编辑器要足够大才谈得上"顺手编辑代码"
  if (r.taBox && r.taBox.h < 300) issues.push(`编辑区太矮（${r.taBox.h}px），编辑代码不够用`)
  if (r.taBox && r.taBox.w < 400) issues.push(`编辑区太窄（${r.taBox.w}px）`)
  if (!/mono|Consolas|Courier/i.test(r.taFont ?? '')) issues.push('编辑区不是等宽字体')
  if (r.taWhiteSpace !== 'pre') issues.push(`代码编辑区应 white-space: pre（现为 ${r.taWhiteSpace}）—— 否则长行折行会看不出缩进结构`)
  if (!/^(2|2px|2em)$/.test(String(r.taTabSize))) issues.push(`tab-size 应为 2（现为 ${r.taTabSize}）`)
  if (r.saveDisabled !== false) issues.push('保存按钮不可用')

  // ---- Tab 真的插入缩进（合成事件即可：处理器不校验 isTrusted）----
  const tabProbe = await evaluate(client, `(() => {
    const ta = document.getElementById('ce-text')
    const before = ta.value
    ta.setSelectionRange(0, 0)
    ta.focus()
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    const afterTab = ta.value
    ta.setSelectionRange(2, 2)
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
    return {
      startsWithIndent: afterTab.startsWith('  '),
      grew: afterTab.length === before.length + 2,
      restored: ta.value === before,
      stat: document.getElementById('ce-stat')?.textContent?.trim() ?? '',
      focusMoved: document.activeElement !== ta,
    }
  })()`)
  line('Tab 插入缩进', tabProbe.startsWithIndent ? '是' : '否')
  line('Shift+Tab 反缩进', tabProbe.restored ? '已还原' : '未还原')
  if (!tabProbe.startsWithIndent) issues.push('Tab 没有插入缩进（焦点可能被跳走）')
  if (!tabProbe.grew) issues.push('Tab 插入的字符数不对')
  if (!tabProbe.restored) issues.push('Shift+Tab 没有正确反缩进')

  if (issues.length === 0) console.log('\n  ✓ 内容编辑器布局与交互正常')
  else issues.forEach((i) => console.log(`\n  ✗ ${i}`))

  const bytes = await screenshot(client, 'code-editor')
  console.log(`  截图已存 .shots/code-editor.png（${(bytes / 1024).toFixed(1)}KB）`)
  return issues.length === 0
}

/* ============================================================
   Office 网页视图检查（Word / Excel / PowerPoint）
   ============================================================ */

/**
 * Excel 表格视图要问的渲染事实。
 *
 * 重点是**钉住效果**：表头吸顶、冻结列贴左，这是表格视图存在的理由，
 * 而它们只有真渲染才能验证（jsdom 不算布局，sticky 永远是 0）。
 */
const SHEET_PROBE = `(() => {
  const box = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) }
  }
  const scroll = document.querySelector('.sheet-scroll')
  const head = document.querySelector('.sheet-table-view thead td')
  const frozen = document.querySelector('.sheet-table-view td.frozen-x')
  const cells = [...document.querySelectorAll('.sheet-table-view td')]
  const money = cells.find((c) => /^¥/.test(c.textContent))
  const merged = document.querySelector('.sheet-table-view td[colspan]')
  return {
    buttons: [...document.querySelectorAll('.mode-switch button')].map((b) => ({ t: b.textContent.trim(), on: b.classList.contains('on') })),
    tabs: [...document.querySelectorAll('.sheet-tab')].map((b) => ({ t: b.textContent.trim(), on: b.classList.contains('on') })),
    hasView: Boolean(document.querySelector('.sheet-view')),
    scrollBox: box('.sheet-scroll'),
    scrollTop: scroll?.scrollTop ?? null,
    scrollH: scroll?.scrollHeight ?? null,
    clientH: scroll?.clientHeight ?? null,
    scrollW: scroll?.scrollWidth ?? null,
    clientW: scroll?.clientWidth ?? null,
    headBox: box('.sheet-table-view thead td'),
    headPos: head ? getComputedStyle(head).position : null,
    headZ: head ? getComputedStyle(head).zIndex : null,
    theadRows: document.querySelectorAll('.sheet-table-view thead tr').length,
    bodyRows: document.querySelectorAll('.sheet-table-view tbody tr').length,
    cellCount: cells.length,
    frozenCount: document.querySelectorAll('.sheet-table-view td.frozen-x').length,
    frozenBox: box('.sheet-table-view td.frozen-x'),
    frozenPos: frozen ? getComputedStyle(frozen).position : null,
    info: document.querySelector('.sheet-info')?.textContent?.trim() ?? null,
    moneyText: money?.textContent ?? null,
    moneyAlign: money ? getComputedStyle(money).textAlign : null,
    mergedSpan: merged?.getAttribute('colspan') ?? null,
    mergedText: merged?.textContent?.slice(0, 24) ?? null,
    mergedW: merged ? Math.round(merged.getBoundingClientRect().width) : null,
    // 拿一个**未合并**的格子做宽度基准（cells[0] 就是合并格本身，不能拿来比）
    singleCellW: (() => {
      const c = document.querySelector('.sheet-table-view tbody tr td')
      return c ? Math.round(c.getBoundingClientRect().width) : null
    })(),
    tableW: (() => {
      const t = document.querySelector('.sheet-table-view')
      return t ? Math.round(t.getBoundingClientRect().width) : null
    })(),
    bodyBg: getComputedStyle(document.body).backgroundColor,
    iframe: Boolean(document.querySelector('#frame iframe')),
  }
})()`

/**
 * 检查 Excel 表格视图。
 * @param {object} client - CDP 客户端
 * @param {string} id - xlsx 文档 id
 * @returns {Promise<boolean>} 是否通过
 */
async function checkSheetView(client, id) {
  console.log('\n【Excel 表格视图真实渲染】')
  await openPage(client, `${BASE}/view.html?id=${id}`)
  await new Promise((r) => setTimeout(r, 1200))

  const r = await evaluate(client, SHEET_PROBE)
  const line = (l, v) => console.log(`  ${l.padEnd(22)} ${v}`)
  const issues = []

  line('视图切换', r.buttons.map((b) => `${b.t}${b.on ? '●' : ''}`).join(' / '))
  line('工作表标签', r.tabs.map((b) => `${b.t}${b.on ? '●' : ''}`).join(' / '))
  line('规模', `${r.info}　表头 ${r.theadRows} 行 / 表体 ${r.bodyRows} 行`)
  line('单元格数', r.cellCount)
  line('表头定位', `${r.headPos}（z=${r.headZ}）`)
  line('冻结列', `${r.frozenCount} 个（${r.frozenPos}）`)
  line('滚动区', `${r.scrollW}×${r.scrollH} 内容 / ${r.clientW}×${r.clientH} 可视`)
  line('货币单元格', `${r.moneyText}（text-align: ${r.moneyAlign}）`)
  line('合并单元格', `${r.mergedText} colspan=${r.mergedSpan} 宽 ${r.mergedW}px（普通格 ${r.singleCellW}px，整表 ${r.tableW}px）`)

  if (!r.hasView) issues.push('没有渲染出表格视图')
  if (r.buttons.length !== 2) issues.push('视图切换按钮不是 2 个')
  if (!r.buttons.some((b) => b.on && b.t.includes('表格'))) issues.push('默认视图应是「表格」')
  if (r.tabs.length !== 2) issues.push(`工作表标签数异常（${r.tabs.length}）`)
  if (r.bodyRows < 10) issues.push(`表体只渲染了 ${r.bodyRows} 行`)
  if (r.headPos !== 'sticky') issues.push('表头应当 position: sticky')
  if (!r.headBox || r.headBox.h < 14) issues.push('表头行高度异常')
  if (!/right/.test(r.moneyAlign ?? '')) issues.push('数字/金额应当右对齐')
  if (r.mergedSpan !== '5') issues.push(`合并单元格 colspan 应为 5（实际 ${r.mergedSpan}）`)
  if (r.mergedW && r.singleCellW && r.mergedW <= r.singleCellW * 1.5) {
    issues.push(`合并单元格没有跨列展开（合并 ${r.mergedW}px / 单格 ${r.singleCellW}px）`)
  }
  if (r.frozenCount < 1) issues.push('没有冻结列（夹具冻结了第 1 列）')
  else if (r.frozenPos !== 'sticky') issues.push(`冻结列应当 position: sticky（实际 ${r.frozenPos}）`)
  if (r.scrollH <= r.clientH) issues.push('表格内容没有超出可视高度，无法验证滚动')

  // ★ 滚动后表头必须钉住（y 不变），内容动
  if (r.scrollH > r.clientH) {
    const before = r.headBox?.y ?? null
    await evaluate(client, `document.querySelector('.sheet-scroll').scrollTop = 300`)
    await new Promise((res) => setTimeout(res, 250))
    const after = await evaluate(client, SHEET_PROBE)
    line('滚动 300px 后', `表头 y ${before} → ${after.headBox?.y}　滚动量 ${after.scrollTop}`)
    if (after.scrollTop < 250) issues.push('表格没有真的滚动')
    if (before !== null && Math.abs((after.headBox?.y ?? 0) - before) > 2) {
      issues.push(`表头没有钉住（y 从 ${before} 变到 ${after.headBox?.y}）`)
    }
  }

  // 切到原始版式应当是 PDF 预览
  await evaluate(client, `[...document.querySelectorAll('.mode-switch button')].find(b => b.textContent.includes('原始'))?.click()`)
  await new Promise((res) => setTimeout(res, 1500))
  const switched = await evaluate(client, `(() => {
    const f = document.querySelector('#frame iframe')
    return { cls: f?.className ?? null, src: f?.getAttribute('src') ?? null }
  })()`)
  line('切到原始版式', `${switched.cls} → ${(switched.src ?? '').replace(/token=[^&]*/, 'token=***').slice(0, 60)}`)
  if (!switched.cls) issues.push('切到原始版式后没有预览')

  if (issues.length === 0) console.log('\n  ✓ 表格视图正常（含表头钉住与滚动）')
  else issues.forEach((i) => console.log(`\n  ✗ ${i}`))

  const bytes = await screenshot(client, 'sheet-view')
  console.log(`  截图已存 .shots/sheet-view.png（${(bytes / 1024).toFixed(1)}KB）`)
  return issues.length === 0
}

/**
 * Word / PPT 的网页视图要问的渲染事实（读 iframe 内部）。
 */
const WEBVIEW_PROBE = `(() => {
  const frame = document.querySelector('#frame iframe')
  const out = {
    buttons: [...document.querySelectorAll('.mode-switch button')].map((b) => ({ t: b.textContent.trim(), on: b.classList.contains('on') })),
    frameCls: frame?.className ?? null,
    frameSrc: frame?.getAttribute('src') ?? null,
    notice: document.getElementById('notice')?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 80) ?? '',
    inner: null,
  }
  try {
    const d = frame?.contentDocument
    if (!d) return out
    const de = d.documentElement
    out.inner = {
      // Word
      sections: d.querySelectorAll('section.docx').length,
      tables: d.querySelectorAll('table').length,
      images: d.querySelectorAll('img').length,
      paragraphs: d.querySelectorAll('p').length,
      // PPT
      svgs: d.querySelectorAll('svg').length,
      foreignObjects: d.querySelectorAll('foreignObject').length,
      slideBoxes: [...d.querySelectorAll('.slide')].map((s) => {
        const r = s.getBoundingClientRect()
        return { w: Math.round(r.width), h: Math.round(r.height) }
      }),
      textLen: (d.body?.textContent ?? '').replace(/\\s+/g, '').length,
      textSample: (d.body?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 60),
      hOverflow: de ? de.scrollWidth - de.clientWidth : null,
      bodyBg: d.body ? getComputedStyle(d.body).backgroundColor : null,
      pageW: d.querySelector('section.docx') ? Math.round(d.querySelector('section.docx').getBoundingClientRect().width) : null,
      iframeW: de ? de.clientWidth : null,
    }
  } catch (e) { out.inner = { error: String(e.message) } }
  return out
})()`

/**
 * 检查 Word 网页视图。
 * @param {object} client - CDP 客户端
 * @param {string} id - docx 文档 id
 * @returns {Promise<boolean>} 是否通过
 */
async function checkWordView(client, id) {
  console.log('\n【Word 网页视图真实渲染】')
  await openPage(client, `${BASE}/view.html?id=${id}`)
  await new Promise((r) => setTimeout(r, 1200))

  const r = await evaluate(client, WEBVIEW_PROBE)
  const line = (l, v) => console.log(`  ${l.padEnd(22)} ${v}`)
  const issues = []
  const inner = r.inner ?? {}

  line('视图切换', r.buttons.map((b) => `${b.t}${b.on ? '●' : ''}`).join(' / '))
  line('iframe 类型', r.frameCls)
  line('页面结构', `section ${inner.sections} 个 / 段落 ${inner.paragraphs} / 表格 ${inner.tables} / 图片 ${inner.images}`)
  line('正文长度', `${inner.textLen} 字：${inner.textSample ?? ''}`)
  line('纸张宽度', `${inner.pageW}px（iframe 可视 ${inner.iframeW}px）`)
  line('横向溢出', `${inner.hOverflow}px`)

  if (!r.buttons.some((b) => b.on && b.t.includes('网页'))) issues.push('Word 默认视图应是「网页版」')
  if (r.frameCls !== 'html') issues.push(`网页视图应是 html iframe（实际 ${r.frameCls}）`)
  if (!(r.frameSrc ?? '').includes('view=web')) issues.push('iframe 地址没带 view=web')
  if (!inner.sections) issues.push('docx-preview 的页面结构没出现')
  if ((inner.paragraphs ?? 0) < 2) issues.push('段落太少')
  if ((inner.tables ?? 0) < 1) issues.push('表格没渲染出来')
  if ((inner.textLen ?? 0) < 10) issues.push('正文几乎是空的')
  // 纸张比 iframe 宽就会横向滚 —— 那说明宽度没自适应
  if (inner.pageW && inner.iframeW && inner.pageW > inner.iframeW + 2) {
    issues.push(`纸张宽度超出 iframe（${inner.pageW} > ${inner.iframeW}）`)
  }

  if (issues.length === 0) console.log('\n  ✓ Word 网页视图正常')
  else issues.forEach((i) => console.log(`\n  ✗ ${i}`))

  const bytes = await screenshot(client, 'word-webview')
  console.log(`  截图已存 .shots/word-webview.png（${(bytes / 1024).toFixed(1)}KB）`)
  return issues.length === 0
}

/**
 * 检查 PPT 网页视图。
 * @param {object} client - CDP 客户端
 * @param {string} id - pptx 文档 id
 * @returns {Promise<boolean>} 是否通过
 */
async function checkSlidesView(client, id) {
  console.log('\n【PPT 网页视图真实渲染】')
  await openPage(client, `${BASE}/view.html?id=${id}`)
  await new Promise((r) => setTimeout(r, 1200))

  const first = await evaluate(client, WEBVIEW_PROBE)
  const line = (l, v) => console.log(`  ${l.padEnd(22)} ${v}`)
  const issues = []

  // PPT 默认是 PDF，先确认这一点，再切到网页版
  line('默认视图', first.buttons.map((b) => `${b.t}${b.on ? '●' : ''}`).join(' / '))
  line('默认 iframe', first.frameCls)
  if (!first.buttons.some((b) => b.on && b.t.includes('原始'))) {
    issues.push('PowerPoint 默认视图应是「原始版式」（保真优先）')
  }

  await evaluate(client, `[...document.querySelectorAll('.mode-switch button')].find(b => b.textContent.includes('网页'))?.click()`)
  await new Promise((r) => setTimeout(r, 1600))

  const r = await evaluate(client, WEBVIEW_PROBE)
  const inner = r.inner ?? {}
  line('切到网页版', `${r.frameCls} → ${(r.frameSrc ?? '').replace(/token=[^&]*/, 'token=***').slice(0, 56)}`)
  line('幻灯片', `${inner.svgs} 段 SVG / ${inner.foreignObjects} 个文本框`)
  line('幻灯片尺寸', (inner.slideBoxes ?? []).map((b) => `${b.w}×${b.h}`).join(' '))
  line('正文长度', `${inner.textLen} 字：${inner.textSample ?? ''}`)
  line('提示', r.notice)

  if (r.frameCls !== 'html') issues.push('切换后不是 html iframe')
  if (!(r.frameSrc ?? '').includes('view=web')) issues.push('iframe 地址没带 view=web')
  if ((inner.svgs ?? 0) < 3) issues.push(`SVG 数量不足（${inner.svgs}）`)
  if ((inner.foreignObjects ?? 0) < 3) issues.push(`文本框数量不足（${inner.foreignObjects}）`)
  if ((inner.textLen ?? 0) < 20) issues.push('幻灯片文字几乎是空的')
  // 每张幻灯片都该是同比例、有实际尺寸
  const boxes = inner.slideBoxes ?? []
  if (boxes.length && boxes.some((b) => b.h < 30 || b.w < 60)) {
    issues.push(`有幻灯片高度塌陷：${boxes.map((b) => `${b.w}×${b.h}`).join(' ')}`)
  }
  if (boxes.length) {
    const ratio = boxes[0].w / boxes[0].h
    if (Math.abs(ratio - 16 / 9) > 0.05) issues.push(`幻灯片比例不是 16:9（${ratio.toFixed(3)}）`)
  }

  if (issues.length === 0) console.log('\n  ✓ PPT 网页视图正常（SVG 内联、文字在、比例对）')
  else issues.forEach((i) => console.log(`\n  ✗ ${i}`))

  const bytes = await screenshot(client, 'pptx-webview')
  console.log(`  截图已存 .shots/pptx-webview.png（${(bytes / 1024).toFixed(1)}KB）`)
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
  let fixtures = null

  try {
    const version = await waitForCdp(PORT)
    console.log(`  已连接 ${version.Browser}\n`)

    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const page = targets.find((t) => t.type === 'page')
    if (!page) throw new Error('没有可用的页面 target')

    client = await connectCdp(page.webSocketDebuggerUrl)

    const health = await (await fetch(`${BASE}/api/v1/health`)).json()
    const docCount = health?.data?.docCount ?? 0
    if (docCount === 0) {
      console.log('\n  库是空的 —— 先验证空状态界面，再造夹具跑完整检查。')
    } else {
      console.log(`\n  库里已有 ${docCount} 份文档；另外造 3 份夹具，保证各类型都有覆盖。`)
    }

    // 空库也要能测：空状态本身是一个该验证的界面
    if (docCount === 0) {
      ok = (await checkEmptyState(client)) && ok
    }

    // 夹具始终造：代码/Markdown/PDF/Office 三件套的检查不能因为"库里恰好没有"而跳过
    fixtures = await provisionFixtures({ root: ROOT, base: BASE, mark: MARK, office: true })
    console.log(`  夹具：${fixtures.ids.length} 份（${MARK}）`)

    ok = (await checkList(client)) && ok

    // 阅读页：优先用夹具里的 PDF 与代码文档（类型确定），没有再退回库里的
    const listRes = await fetch(`${BASE}/api/v1/docs?limit=200`)
    const list = await listRes.json()
    const byId = (id) => (id ? list.data.items.find((d) => d.id === id) : null)

    const pdf = byId(fixtures.byKind.pdf) ?? list.data.items.find((d) => d.type === 'pdf')
    const code = byId(fixtures.byKind.code) ?? list.data.items.find((d) => d.type === 'code')
    const other = list.data.items.find((d) => d.type !== 'pdf')

    if (pdf) ok = (await checkView(client, pdf.id, 'PDF 内嵌预览', 'view-pdf')) && ok
    if (other) ok = (await checkView(client, other.id, `${other.type.toUpperCase()} 预览`, `view-${other.type}`)) && ok
    if (other) ok = (await checkEditor(client, other.id)) && ok

    // ★ 代码：预览件（行号对齐 + 高亮）与内容编辑器
    if (code) {
      ok = (await checkCodePreview(client, code.id)) && ok
      ok = (await checkContentEditor(client, code.id)) && ok
    } else {
      console.log('\n【代码预览 / 内容编辑器】\n  ✗ 库里没有代码文档，也不该出现这种情况（夹具本该造出一份）')
      ok = false
    }

    // Markdown 双视图
    const md = byId(fixtures.byKind.md) ?? list.data.items.find((d) => d.type === 'md')
    if (md) ok = (await checkMarkdown(client, md.id, md.title)) && ok

    // ★ Office 三件套的网页视图（不转 PDF 的那条路）
    const docx = byId(fixtures.byKind.docx)
    const xlsx = byId(fixtures.byKind.xlsx)
    const pptx = byId(fixtures.byKind.pptx)
    if (docx) ok = (await checkWordView(client, docx.id)) && ok
    if (xlsx) ok = (await checkSheetView(client, xlsx.id)) && ok
    if (pptx) ok = (await checkSlidesView(client, pptx.id)) && ok
    if (!docx || !xlsx || !pptx) {
      console.log('\n【Office 网页视图】\n  ✗ 缺少 Office 夹具（docx/xlsx/pptx 应各有一份）')
      ok = false
    }

    // 上传 / 多选 / 标签管理
    ok = (await checkTools(client)) && ok

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
        console.log('  ✓ 入库时的预览件是 PDF（高保真那一档）')
        // ★ 必须先导航到这个文档，否则读到的是上一个检查残留的页面
        await openPage(client, `${BASE}/view.html?id=${office.id}`)
        await new Promise((r2) => setTimeout(r2, 1200))
        // 阅读页可能记住了上次选的视图，这里显式切回「原始版式」再断言
        await evaluate(client, `[...document.querySelectorAll('.mode-switch button')].find(b => b.textContent.includes('原始'))?.click()`)
        await new Promise((r2) => setTimeout(r2, 1200))
        const r = await evaluate(client, `(() => {
          const f = document.querySelector('#frame iframe')
          return { cls: f?.className ?? null, src: f?.getAttribute('src')?.slice(0, 55) ?? null }
        })()`)
        console.log(`  iframe ${r.cls} → ${r.src}…`)
        if (r.cls !== 'pdf') {
          console.log('  ✗ 「原始版式」没有用 PDF 渲染器')
          ok = false
        } else {
          const bytes = await screenshot(client, 'view-office')
          console.log(`  ✓ 原始版式用 PDF 渲染器打开，截图 .shots/view-office.png（${(bytes / 1024).toFixed(1)}KB）`)
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

    // 夹具必须清干净：它们会出现在用户下一次打开的列表里
    if (fixtures) {
      const removed = await cleanupFixtures({ base: BASE, fixtures }).catch(() => 0)
      if (removed) console.log(`\n  已清理 ${removed} 份夹具文档`)
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
