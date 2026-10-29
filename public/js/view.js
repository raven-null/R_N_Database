/**
 * 阅读页逻辑：文档优先 —— 打开即整屏是文档，元信息按需展开。
 *
 * ## 预览有哪几档
 *
 * 同一份文档可能有多条"看得见"的路子，页面顶部给一个切换：
 *
 *   Markdown     文本（渲染）  /  源码（等宽 + 行号）
 *   Word        网页版         /  原始版式（Office 转出的 PDF）
 *   Excel       表格（原生表）  /  原始版式
 *   PowerPoint  原始版式（默认）/  网页版（实验）
 *
 * 「网页版」是入库时在本地生成好的产物（`scripts/lib/preview-web.mjs`），
 * 线上不跑任何渲染器。它比 PDF 好在：手机能看、能复制文字、能搜索。
 * 但纯网页渲染对复杂版式一定有偏差，所以 PDF 那一档始终保留。
 *
 * PowerPoint 反过来以 PDF 为默认：幻灯片就是绝对坐标摆版式，
 * 开源渲染在字体度量与换行上必然有出入，保真优先。
 *
 * iframe 无法自定义请求头，所以预览与下载链接都带 ?token=。
 *
 * @module public/js/view
 */

import { fetchDoc, fetchTaxonomy, authedUrl } from './api.js'
import { esc, fmtSize, fmtDate, typeInfo, param, isEditableType } from './util.js'
import { mountEditor, canEditNow } from './edit.js'
import { mountCodeEditor } from './code-editor.js'
import { mountSheet } from './sheet-view.js'
import { setTip } from './hint.js'

const el = {
  title: document.getElementById('doc-title'),
  meta: document.getElementById('doc-meta'),
  summary: document.getElementById('doc-summary'),
  tags: document.getElementById('doc-tags'),
  frame: document.getElementById('frame'),
  actions: document.getElementById('actions'),
  panel: document.getElementById('panel'),
  panelActions: document.getElementById('panel-actions'),
  notice: document.getElementById('notice'),
  editor: document.getElementById('editor-slot'),
  pageTip: document.getElementById('tip-page'),
}

/** 当前文档，供面板/编辑器复用。 */
let current = null

/** 分类词表缓存（编辑元数据时要用；只拉一次）。 */
let taxonomyCache = null

/** 当前视图 id（render / source / web / sheet / orig）。 */
let activeView = 'orig'

/**
 * 该文档有哪些视图可选。
 *
 * 顺序即优先级：**第一个是默认视图**。
 *   - Markdown：先给渲染视图（打开就能读）
 *   - Word：先给网页版（手机友好、可复制）
 *   - Excel：先给表格（这本该就是表）
 *   - PowerPoint：先给原始版式（保真优先），网页版标为实验
 *
 * @param {object} doc - 元数据
 * @returns {Array<{id:string, label:string, hint?:string}>} 视图列表
 */
function viewsOf(doc) {
  if (!doc) return []

  if (doc.previewKind === 'markdown') {
    return [{ id: 'render', label: '文本' }, { id: 'source', label: '源码' }]
  }

  // 「原始版式」这一档的真实含义取决于入库时能不能转 PDF
  const origLabel = doc.previewKind === 'pdf' ? '原始版式' : '基础预览'

  if (doc.webView === 'docx') {
    return [{ id: 'web', label: '网页版' }, { id: 'orig', label: origLabel }]
  }
  if (doc.webView === 'pptx') {
    return [
      { id: 'orig', label: origLabel },
      { id: 'web', label: '网页版', hint: '实验' },
    ]
  }
  if (doc.webView === 'sheet') {
    return [{ id: 'sheet', label: '表格' }, { id: 'orig', label: origLabel }]
  }
  return []
}

/**
 * 该文档能否在网页上直接改内容（代码 / Markdown / 纯文本）。
 * @param {object} doc - 元数据
 * @returns {boolean} 是否可编辑内容
 */
function editableContent(doc) {
  return isEditableType(doc?.type)
}

/**
 * 渲染标题与元信息。
 * @param {object} doc - 元数据
 */
function renderHeader(doc) {
  document.title = `${doc.title} · R_N 资料库`
  el.title.textContent = doc.title
  el.title.setAttribute('aria-label', doc.title)

  const bits = [
    `<b>${esc(typeInfo(doc.type, doc.ext).label)}</b>`,
    fmtSize(doc.size),
    doc.pages ? `${doc.pages} 页` : '',
    doc.author ? esc(doc.author) : '',
    doc.docCreatedAt ? `文档日期 ${fmtDate(doc.docCreatedAt)}` : '',
    `入库 ${fmtDate(doc.ingestedAt)}`,
    `<code>${esc(doc.originalName)}</code>`,
  ].filter(Boolean)

  el.meta.innerHTML = bits.join('<i>·</i>')

  const catHtml = (doc.categories ?? [])
    .map((c) => `<span class="tag cat">${esc(c)}</span>`).join('')
  const tagHtml = (doc.tags ?? []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')
  el.tags.innerHTML = catHtml + tagHtml
  el.tags.hidden = !catHtml && !tagHtml

  if (doc.summary) {
    el.summary.innerHTML = `<div class="summary-box"><b>AI 摘要</b>${esc(doc.summary)}</div>`
    el.summary.hidden = false
  } else {
    el.summary.innerHTML = ''
    el.summary.hidden = true
  }
}

/**
 * 渲染顶栏按钮与面板内的编辑入口。
 * @param {object} doc - 元数据
 * @param {boolean} canEdit - 是否有编辑权限
 */
function renderActions(doc, canEdit) {
  const views = viewsOf(doc)

  el.actions.innerHTML = `
    ${views.length > 1 ? `
      <div class="mode-switch" role="group" aria-label="查看方式">
        ${views.map((v) => `<button data-view="${v.id}" class="${v.id === activeView ? 'on' : ''}"
          aria-label="${esc(v.hint ? `${v.label}（${v.hint}）` : v.label)}"${v.hint ? ` data-tip="${esc(`${v.label}：${v.hint}`)}"` : ''}>${esc(v.label)}${v.hint ? '<sup>*</sup>' : ''}</button>`).join('')}
      </div>` : ''}
    <a class="btn primary" href="${esc(authedUrl(`/api/v1/docs/${doc.id}/file`))}" download>下载</a>
    <button class="btn ghost" id="btn-info" aria-expanded="false">详情</button>
  `

  el.panelActions.innerHTML = `
    ${canEdit && editableContent(doc) ? '<button class="btn" id="btn-edit-content">编辑内容</button>' : ''}
    ${canEdit ? '<button class="btn" id="btn-edit">编辑元数据</button>' : ''}
    <a class="btn ghost" href="${esc(authedUrl(`/api/v1/docs/${doc.id}/file?inline=1`))}" target="_blank" rel="noopener">新窗口打开原件</a>
  `

  const infoBtn = document.getElementById('btn-info')
  infoBtn.addEventListener('click', () => togglePanel())

  if (views.length > 1) {
    el.actions.querySelectorAll('.mode-switch button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = btn.dataset.view
        if (next === activeView) return
        activeView = next
        rememberView(doc, next)
        el.actions.querySelectorAll('.mode-switch button').forEach((b) => {
          b.classList.toggle('on', b.dataset.view === activeView)
        })
        renderPreview(current)
      })
    })
  }
}

/**
 * 记住用户对这类文档的视图偏好。
 *
 * 按 `webView` 分类记（docx / pptx / sheet），而不是按文档 id ——
 * 你要是觉得 Word 的网页版不好用，不该每打开一份都要手动切一次。
 *
 * @param {object} doc - 元数据
 * @param {string} view - 视图 id
 * @returns {void}
 */
function rememberView(doc, view) {
  try {
    localStorage.setItem(`rndb_view_${doc.webView ?? doc.type}`, view)
  } catch {
    /* 隐私模式下 localStorage 可能不可用，忽略 */
  }
}

/**
 * 读回视图偏好。
 * @param {object} doc - 元数据
 * @returns {string|null} 上次选的视图 id
 */
function recallView(doc) {
  try {
    return localStorage.getItem(`rndb_view_${doc.webView ?? doc.type}`)
  } catch {
    return null
  }
}

/**
 * 构造预览件地址。
 *
 * ★ 必须带版本号。预览件是**派生**产物（Office 转 PDF、Markdown 渲染、
 * 网页视图），同一份原件的预览件会被重新生成 —— 而 URL 里的 id 是
 * **原件**的内容哈希，预览件换了它不会变。
 * 早期版本因此踩坑：预览地址标了 immutable 却不带版本号，
 * 浏览器把旧的 HTML 降级版本缓存一年，重新生成 PDF 后用户永远看不到
 * （装好 LibreOffice 升级预览件后，看起来"和以前没区别"就是这个原因）。
 *
 * 版本号取 updatedAt；重建预览件与人工编辑元数据都会更新它。
 *
 * @param {object} doc - 元数据
 * @param {string} [view] - 视图 id
 * @returns {string} 带令牌与版本号的地址
 */
function previewSrc(doc, view = activeView) {
  const params = new URLSearchParams()
  if (doc.previewKind === 'markdown') {
    params.set('mode', view === 'source' ? 'source' : 'render')
  } else if (view === 'web') {
    params.set('view', 'web')
  }
  if (doc.updatedAt) {
    const stamp = Date.parse(doc.updatedAt)
    params.set('v', String(Number.isFinite(stamp) ? stamp : doc.updatedAt))
  }
  const q = params.toString()
  return authedUrl(`/api/v1/docs/${doc.id}/preview${q ? `?${q}` : ''}`)
}

/**
 * 切换详情面板（与编辑器互斥，避免两个面板一起把文档挤没）。
 * @param {boolean} [force] - 指定开/关
 */
function togglePanel(force) {
  const open = force ?? el.panel.hidden
  if (open) closeEditor()
  el.panel.hidden = !open
  const btn = document.getElementById('btn-info')
  if (btn) {
    btn.classList.toggle('active', open)
    btn.setAttribute('aria-expanded', String(open))
  }
}

/** 收起编辑器。 */
function closeEditor() {
  if (el.editor.firstChild) el.editor.innerHTML = ''
}

/**
 * 渲染预览区。
 *
 * 按 activeView 分派：
 *   表格视图  → 直接在 #frame 里画表格（不是 iframe，表格要能横竖滚动）
 *   网页视图  → iframe 载入入库时生成好的 HTML（Word / PowerPoint）
 *   原始版式  → iframe 载入 PDF 或降级 HTML
 *
 * @param {object} doc - 元数据
 */
function renderPreview(doc) {
  const q = param('q')
  el.notice.innerHTML = ''
  // 说明一律进顶栏那个问号，页面上不铺任何提示条
  const tips = ['「详情」展开元信息、摘要与标签；「下载」取原件。']

  if (doc.extractError) {
    el.notice.innerHTML = `<div class="notice warn">正文抽取有问题：${esc(doc.extractError)}</div>`
  }

  // ---- 表格视图：原生渲染，不走 iframe ----
  if (activeView === 'sheet' && doc.webView === 'sheet') {
    mountSheet(el.frame, { doc })
    tips.push('表格视图：可直接滚动、选中复制；想看原样请切「原始版式」。')
    setTip(el.pageTip, tips)
    return
  }

  if (!doc.previewKind || doc.previewKind === 'none') {
    el.frame.innerHTML = `<div class="empty">
      这份文档没有可用的预览件
      <button class="tip" type="button" data-tip="常见原因：旧版 Office 格式（.doc / .xls / .ppt），或扫描件没有可提取的文字。
可以点上方「下载」用本地软件打开。">?</button>
    </div>`
    setTip(el.pageTip, tips)
    return
  }

  const src = previewSrc(doc, activeView)
  const isWebView = activeView === 'web'

  // 「原始版式」这一档：入库时能转 PDF 就用 PDF 渲染器
  const usePdfRenderer = !isWebView && doc.previewKind === 'pdf'

  if (usePdfRenderer) {
    el.frame.innerHTML = `<iframe class="pdf" src="${esc(src)}" title="文档预览"></iframe>`
    if (doc.previewNote) tips.push(doc.previewNote)
    if (doc.webView) tips.push('另一档是网页视图，手机上看更舒服。')
    if (q) tips.push(`按 Ctrl+F 可搜索「${q}」。`)
    setTip(el.pageTip, tips)
    return
  }

  // 网页视图 / Markdown / HTML / 代码 / 文本预览：都是 HTML 文档
  el.frame.innerHTML = `<iframe class="html" src="${esc(src)}" title="文档预览" sandbox="allow-same-origin"></iframe>`

  if (isWebView) {
    tips.push(doc.webView === 'pptx' ? '网页版（实验）：字体度量与换行可能与 PowerPoint 略有差异。' : '网页版：可复制文字、手机上自适应。')
    if (doc.webViewNote) tips.push(doc.webViewNote)
  }
  if (doc.previewKind === 'markdown') {
    tips.push(activeView === 'source' ? '源码视图（等宽 + 行号）。' : '渲染视图。')
  }
  if (doc.previewKind === 'code') tips.push('代码预览（等宽 + 行号）。')
  if (doc.previewNote && !isWebView) tips.push(doc.previewNote)
  if (/HTML 降级/.test(doc.previewNote ?? '')) tips.push('安装 LibreOffice 可转为保真度更高的 PDF 预览。')
  setTip(el.pageTip, tips)
}

/**
 * 打开编辑器（收起详情面板，把纵向空间让给表单）。
 * @param {boolean} canEdit - 是否有编辑权限
 */
function openEditor(canEdit) {
  if (!canEdit || !current) return
  togglePanel(false)

  const mount = (doc) => mountEditor(el.editor, {
    doc,
    taxonomy: taxonomyCache,
    canEdit: true,
    onSaved: (next) => {
      current = next
      renderHeader(next)
      renderActions(next, true)
      rewirePanelButtons(true)
      // 重建编辑器以反映刚落盘的值
      mount(next)
    },
    onDeleted: () => { location.href = '/index.html' },
  })

  mount(current)
  el.editor.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

/**
 * 打开内容编辑器（直接改原件：代码 / Markdown / 纯文本）。
 *
 * 保存成功后要**换掉预览 iframe 的地址**：预览件的 URL 版本号取自
 * updatedAt，内容一改它变，浏览器才会去取新的渲染结果
 * （否则看到的是编辑前的旧预览，会以为没保存上）。
 *
 * @param {boolean} canEdit - 是否有编辑权限
 */
function openContentEditor(canEdit) {
  if (!canEdit || !current) return
  togglePanel(false)

  mountCodeEditor(el.editor, {
    doc: current,
    canEdit: true,
    onSaved: (data) => {
      if (data?.doc) {
        current = { ...current, ...data.doc }
        renderHeader(current)
        renderActions(current, true)
      }
      // 预览按新版本号重取
      const frame = el.frame.querySelector('iframe')
      if (frame) frame.src = previewSrc(current, activeView)
      else renderPreview(current)
      rewirePanelButtons(true)
    },
    onCancel: () => {},
  })

  el.editor.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

/**
 * 重新绑定详情面板里的按钮。
 *
 * 面板内容是 innerHTML 重建的，重建后旧监听器全部失效 ——
 * 不重绑就会出现"点了一次按钮之后，按钮再也不响应"。
 *
 * @param {boolean} canEdit - 是否有编辑权限
 */
function rewirePanelButtons(canEdit) {
  const editBtn = document.getElementById('btn-edit')
  if (editBtn) editBtn.onclick = () => openEditor(canEdit, taxonomyCache)

  const contentBtn = document.getElementById('btn-edit-content')
  if (contentBtn) contentBtn.onclick = () => openContentEditor(canEdit)
}

/**
 * 初始化。
 */
async function main() {
  const id = param('id')
  if (!id) {
    el.frame.innerHTML = '<div class="empty">缺少文档 id。</div>'
    return
  }

  try {
    const [doc, editable] = await Promise.all([fetchDoc(id), canEditNow()])
    current = doc

    // 选默认视图：用户上次对这类文档的选择优先，否则用 viewsOf 里的第一个。
    // 偏好只在这份文档真的支持该视图时才采用（比如上次选的是网页版，
    // 但这份 docx 渲染失败没有网页视图，就要退回原始版式）
    const views = viewsOf(doc)
    const remembered = recallView(doc)
    activeView = views.some((v) => v.id === remembered) ? remembered : (views[0]?.id ?? 'orig')

    renderHeader(doc)
    renderActions(doc, editable)
    renderPreview(doc)

    if (editable) {
      // 词表用于分类多选框；拿不到也不阻塞查看
      taxonomyCache = await fetchTaxonomy().catch(() => null)
      rewirePanelButtons(true)
    }
  } catch (err) {
    el.title.textContent = '打开失败'
    el.frame.innerHTML = `<div class="empty">${esc(err.message)}<br>
      <span class="dim"><a href="/index.html">返回列表</a></span></div>`
  }
}

main()
