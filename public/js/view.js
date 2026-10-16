/**
 * 阅读页逻辑：展示元数据 + 内嵌预览 + 下载。
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
import { esc, fmtSize, fmtDate, typeInfo, param } from './util.js'
import { mountEditor, canEditNow } from './edit.js'

const el = {
  title: document.getElementById('doc-title'),
  meta: document.getElementById('doc-meta'),
  summary: document.getElementById('doc-summary'),
  tags: document.getElementById('doc-tags'),
  frame: document.getElementById('frame'),
  actions: document.getElementById('actions'),
  notice: document.getElementById('notice'),
  editor: document.getElementById('editor-slot'),
}

/**
 * 渲染文档头部信息。
 * @param {object} doc - 元数据
 */
function renderHeader(doc) {
  document.title = `${doc.title} · R_N 资料库`
  el.title.textContent = doc.title

  const bits = [
    `<span class="kv">格式</span> ${esc(typeInfo(doc.type).label)}`,
    `<span class="kv">大小</span> ${fmtSize(doc.size)}`,
    doc.pages ? `<span class="kv">页数</span> ${doc.pages}` : '',
    doc.author ? `<span class="kv">作者</span> ${esc(doc.author)}` : '',
    doc.docCreatedAt ? `<span class="kv">文档日期</span> ${fmtDate(doc.docCreatedAt)}` : '',
    `<span class="kv">入库</span> ${fmtDate(doc.ingestedAt)}`,
    `<span class="kv">原文件名</span> <code>${esc(doc.originalName)}</code>`,
  ].filter(Boolean)

  el.meta.innerHTML = bits.join('<i>·</i>')

  const catHtml = (doc.categories ?? [])
    .map((c) => `<a class="tag cat" href="/index.html">${esc(c)}</a>`).join('')

  if (doc.summary) {
    el.summary.innerHTML = `<div class="summary-box"><b>AI 摘要</b>${esc(doc.summary)}</div>`
  }

  const tagHtml = (doc.tags ?? []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')
  el.tags.innerHTML = catHtml + tagHtml
}

/**
 * 渲染操作按钮。
 * @param {object} doc - 元数据
 * @param {boolean} canEdit - 是否有编辑权限
 */
function renderActions(doc, canEdit) {
  const canPreview = doc.previewKind && doc.previewKind !== 'none'
  el.actions.innerHTML = `
    <a class="btn primary" href="${esc(authedUrl(`/api/v1/docs/${doc.id}/file`))}" download>下载原件</a>
    ${canPreview ? `<a class="btn ghost" href="${esc(authedUrl(`/api/v1/docs/${doc.id}/file?inline=1`))}" target="_blank" rel="noopener">新窗口打开</a>` : ''}
    ${canEdit ? `<button class="btn ghost" id="btn-edit">编辑元数据</button>` : ''}
    <a class="btn ghost" href="/index.html">← 返回列表</a>
  `
}

/**
 * 渲染预览区。
 * @param {object} doc - 元数据
 */
function renderPreview(doc) {
  const q = param('q')

  if (doc.extractError) {
    el.notice.innerHTML = `<div class="banner warn">正文抽取有问题：${esc(doc.extractError)}</div>`
  }

  if (!doc.previewKind || doc.previewKind === 'none') {
    el.frame.innerHTML = `<div class="empty">
      这份文档没有可用的预览件。<br>
      <span class="dim">常见原因：旧版 Office 格式（.doc/.xls/.ppt），或扫描件没有可提取的文本。<br>
      可以点上方「下载原件」用本地软件打开。</span>
    </div>`
    return
  }

  const src = authedUrl(`/api/v1/docs/${doc.id}/preview`)

  if (doc.previewKind === 'pdf') {
    el.frame.innerHTML = `<iframe class="pdf" src="${esc(src)}" title="文档预览"></iframe>`
    if (doc.previewNote) {
      el.notice.innerHTML = `<div class="banner info">预览件来源：${esc(doc.previewNote)}</div>`
    }
    if (q) {
      el.notice.innerHTML += `<div class="banner info">浏览器 PDF 阅读器内可按 Ctrl+F 搜索「${esc(q)}」</div>`
    }
    return
  }

  // HTML / 文本预览
  el.frame.innerHTML = `<iframe class="html" src="${esc(src)}" title="文档预览" sandbox="allow-same-origin"></iframe>`

  const notes = []
  if (doc.previewNote) notes.push(`预览件来源：${doc.previewNote}`)
  if (doc.previewKind === 'html' && /HTML 降级/.test(doc.previewNote ?? '')) {
    notes.push('安装 LibreOffice 后可转为保真度更高的 PDF 预览')
  }
  if (notes.length) {
    el.notice.innerHTML = `<div class="banner info">${notes.map(esc).join('<br>')}</div>`
  }
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
    renderHeader(doc)
    renderActions(doc, editable)
    renderPreview(doc)

    if (editable) {
      // 词表用于分类多选框；拿不到也不阻塞查看
      const taxonomy = await fetchTaxonomy().catch(() => null)
      const btn = document.getElementById('btn-edit')
      btn?.addEventListener('click', () => {
        mountEditor(el.editor, {
          doc,
          taxonomy,
          canEdit: true,
          onSaved: (next) => {
            // 用返回的新元数据就地刷新，不必整页重载
            renderHeader(next)
            renderActions(next, true)
            if (el.editor.firstChild) {
              mountEditor(el.editor, {
                doc: next, taxonomy, canEdit: true,
                onSaved: (again) => location.reload(),
                onDeleted: () => { location.href = '/index.html' },
              })
            }
          },
          onDeleted: () => { location.href = '/index.html' },
        })
        el.editor.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      })
    }
  } catch (err) {
    el.title.textContent = '打开失败'
    el.frame.innerHTML = `<div class="empty">${esc(err.message)}<br>
      <span class="dim"><a href="/index.html">返回列表</a></span></div>`
  }
}

main()
