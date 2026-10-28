/**
 * 阅读页逻辑：文档优先 —— 打开即整屏是文档，元信息按需展开。
 *
 * 预览策略（与入库时的预处理对应）：
 *   - PDF 原件 → 浏览器原生 PDF 渲染器（最好的阅读器，翻页/缩放/搜索都有）
 *   - LibreOffice 转出的 PDF → 同上
 *   - HTML 降级件（docx/xlsx/pptx 未装 LibreOffice 时）→ iframe
 *   - 纯文本 → 后端包成 HTML 后 iframe
 *
 * iframe 无法自定义请求头，所以预览与下载链接都带 ?token=。
 *
 * @module public/js/view
 */

import { fetchDoc, fetchTaxonomy, authedUrl } from './api.js'
import { esc, fmtSize, fmtDate, typeInfo, param, isEditableType } from './util.js'
import { mountEditor, canEditNow } from './edit.js'
import { mountCodeEditor } from './code-editor.js'

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
}

/** 当前文档，供面板/编辑器复用。 */
let current = null

/** 分类词表缓存（编辑元数据时要用；只拉一次）。 */
let taxonomyCache = null

/**
 * Markdown 的双视图模式。
 * 默认「渲染」—— 打开就能读；「源码」是代码格式（等宽 + 行号）。
 */
let mdMode = 'render'

/**
 * 该文档是否支持双视图。
 * @param {object} doc - 元数据
 * @returns {boolean} 是否支持
 */
function isDualView(doc) {
  return doc?.previewKind === 'markdown'
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
  el.title.title = doc.title

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
  const dual = isDualView(doc)

  el.actions.innerHTML = `
    ${dual ? `
      <div class="mode-switch" role="group" aria-label="查看方式">
        <button data-mode="render" class="${mdMode === 'render' ? 'on' : ''}">文本</button>
        <button data-mode="source" class="${mdMode === 'source' ? 'on' : ''}">源码</button>
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

  if (dual) {
    el.actions.querySelectorAll('.mode-switch button').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.mode === mdMode) return
        mdMode = btn.dataset.mode
        el.actions.querySelectorAll('.mode-switch button').forEach((b) => {
          b.classList.toggle('on', b.dataset.mode === mdMode)
        })
        // 只换 iframe 的 src，不重建整个预览区 —— 切换更快也不闪
        const frame = el.frame.querySelector('iframe')
        if (frame) frame.src = previewSrc(current, mdMode)
      })
    })
  }
}

/**
 * 构造预览件地址。
 *
 * ★ 必须带版本号。预览件是**派生**产物（Office 转 PDF、Markdown 渲染、
 * HTML 降级），同一份原件的预览件会被重新生成 —— 而 URL 里的 id 是
 * **原件**的内容哈希，预览件换了它不会变。
 * 早期版本因此踩坑：预览地址标了 immutable 却不带版本号，
 * 浏览器把旧的 HTML 降级版本缓存一年，重新生成 PDF 后用户永远看不到
 * （装好 LibreOffice 升级预览件后，看起来"和以前没区别"就是这个原因）。
 *
 * 版本号取 updatedAt；重建预览件与人工编辑元数据都会更新它。
 *
 * @param {object} doc - 元数据
 * @param {string} [mode] - markdown 视图模式
 * @returns {string} 带令牌与版本号的地址
 */
function previewSrc(doc, mode) {
  const params = new URLSearchParams()
  if (isDualView(doc)) params.set('mode', mode ?? mdMode)
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
 * @param {object} doc - 元数据
 */
function renderPreview(doc) {
  const q = param('q')
  el.notice.innerHTML = ''

  if (doc.extractError) {
    el.notice.innerHTML = `<div class="notice warn">正文抽取有问题：${esc(doc.extractError)}</div>`
  }

  if (!doc.previewKind || doc.previewKind === 'none') {
    el.frame.innerHTML = `<div class="empty">
      这份文档没有可用的预览件。<br>
      <span class="dim">常见原因：旧版 Office 格式（.doc/.xls/.ppt），或扫描件没有可提取的文本。<br>
      可以点上方「下载」用本地软件打开。</span>
    </div>`
    return
  }

  const src = previewSrc(doc, mdMode)

  if (doc.previewKind === 'pdf') {
    el.frame.innerHTML = `<iframe class="pdf" src="${esc(src)}" title="文档预览"></iframe>`
    const hints = []
    if (doc.previewNote) hints.push(esc(doc.previewNote))
    if (q) hints.push(`按 Ctrl+F 可搜索「${esc(q)}」`)
    if (hints.length) el.notice.innerHTML += `<div class="notice">${hints.join('　·　')}</div>`
    return
  }

  // Markdown / HTML / 文本预览
  el.frame.innerHTML = `<iframe class="html" src="${esc(src)}" title="文档预览" sandbox="allow-same-origin"></iframe>`

  const hints = []
  if (doc.previewKind === 'markdown') {
    hints.push(mdMode === 'source' ? '源码视图（等宽 + 行号）' : '渲染视图')
  }
  if (doc.previewKind === 'code') hints.push('代码预览（等宽 + 行号）')
  if (doc.previewNote) hints.push(esc(doc.previewNote))
  if (/HTML 降级/.test(doc.previewNote ?? '')) hints.push('安装 LibreOffice 可转为保真度更高的 PDF 预览')
  if (hints.length) el.notice.innerHTML = `<div class="notice">${hints.join('　·　')}</div>`
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
      if (frame) frame.src = previewSrc(current, mdMode)
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
