/**
 * 内容编辑器：在网页上直接改写代码 / Markdown / 纯文本的原件。
 *
 * ## 为什么不是「富文本编辑器」
 *
 * 要存的是**源码与配置**，缩进和换行就是语义。任何富文本编辑器
 * （contenteditable 一类）都会把制表符变成空格、把行尾空白吃掉、
 * 顺手把 `&` 转成实体 —— 存回去的就不是原来那个文件了。
 * 所以这里就是一个**朴素的 textarea**，只补三件代码编辑必需的事：
 *
 *   1. **Tab 插入缩进、Shift+Tab 反缩进**。默认行为是把焦点跳走，
 *      代码里没法用 —— 这是 textarea 编辑代码最致命的缺口。
 *   2. **Ctrl/Cmd+S 保存**，避免手滑离开丢掉改动。
 *   3. **有未保存改动时拦截关闭 / 离开页面**。
 *
 * ## 服务端做什么
 *
 * PUT /api/v1/docs/{id}/content 会：写原件 → 重算正文 → 重渲染预览件
 * → 增量更新倒排索引（用**新旧两版**正文算词频差）。
 * 也就是说保存之后立刻就能搜到新内容，不用重跑全库索引。
 *
 * @module public/js/code-editor
 */

import { esc } from './util.js'
import { apiFetch, authHeaders, authedUrl, loadManifest } from './api.js'
import { renderMarkdown, buildTitleIndex } from './md.js?v=0.8.1'

/** 缩进单位（空格）。用空格而不是 tab：跨编辑器最不容易走样。 */
const INDENT = '  '

/** 单次保存接受的最大字符数，与服务端 MAX_CONTENT_CHARS 保持一致。 */
const MAX_CHARS = 1_000_000

/**
 * 数行数（行尾换行是终止符，不多算一行）。
 *
 * 服务端 netlify/functions/_lib/plain-text.mjs 有一份等价实现 ——
 * 浏览器不能 import 服务端模块，两边各留一份，但规则必须一致，
 * 否则统计行显示的行数会和预览页行号列对不上。
 *
 * @param {string} s - 文本
 * @returns {number} 行数
 */
function countLines(s) {
  const t = String(s ?? '')
  if (t === '') return 1
  return t.replace(/\n$/, '').split('\n').length
}

/**
 * 挂载内容编辑器。
 *
 * @param {HTMLElement} container - 容器
 * @param {object} opts - { doc, canEdit, onSaved, onCancel }
 * @returns {Promise<void>}
 */
export async function mountCodeEditor(container, opts) {
  const { doc, canEdit } = opts

  if (!canEdit) {
    container.innerHTML = ''
    return
  }

  const ext = String(doc.ext ?? '').replace(/^\./, '').toLowerCase()
  const label = ext ? ext.toUpperCase() : '纯文本'
  // 长行的处理与内容性质有关：代码不折行（一折行就看不出结构），
  // 散文类（md/txt）折行更好读
  const wrap = ext === 'md' || ext === 'txt' ? 'soft' : 'off'

  const isMd = String(doc.ext ?? '').replace(/^\./, '').toLowerCase() === 'md'

  container.innerHTML = `
    <div class="editor code-editor${isMd ? ' md-editor' : ''}">
      <div class="editor-head">
        <b>${isMd ? '写 Markdown' : '编辑内容'}</b>
        <button class="tip" type="button" data-tip="${esc(label)} 原件直接改写。&#10;保存后会重渲染预览件，并用新旧两版正文增量更新检索索引。${isMd
    ? '&#10;&#10;Markdown 头部可以写元数据：&#10;---&#10;title: 标题&#10;tags: [标签1, 标签2]&#10;categories: [学习资料]&#10;visibility: private&#10;---&#10;保存后这些会覆盖文档的标题/标签/分类/可见性。' : ''}">?</button>
      </div>

      ${isMd ? `
      <div class="md-toolbar" id="ce-toolbar">
        <button type="button" class="md-tb" data-md="h2" title="二级标题">H2</button>
        <button type="button" class="md-tb" data-md="h3" title="三级标题">H3</button>
        <span class="md-tb-sep"></span>
        <button type="button" class="md-tb" data-md="bold" title="粗体 Ctrl+B"><b>B</b></button>
        <button type="button" class="md-tb" data-md="italic" title="斜体 Ctrl+I"><i>I</i></button>
        <button type="button" class="md-tb" data-md="code" title="行内代码">&lt;/&gt;</button>
        <button type="button" class="md-tb" data-md="strike" title="删除线"><s>S</s></button>
        <span class="md-tb-sep"></span>
        <button type="button" class="md-tb" data-md="ul" title="无序列表">•</button>
        <button type="button" class="md-tb" data-md="ol" title="有序列表">1.</button>
        <button type="button" class="md-tb" data-md="task" title="待办">☑</button>
        <button type="button" class="md-tb" data-md="quote" title="引用">❝</button>
        <span class="md-tb-sep"></span>
        <button type="button" class="md-tb" data-md="codeblock" title="代码块">{ }</button>
        <button type="button" class="md-tb" data-md="table" title="表格">▦</button>
        <button type="button" class="md-tb" data-md="link" title="链接 Ctrl+K">🔗</button>
        <button type="button" class="md-tb" data-md="wiki" title="双链 [[标题]]">[[ ]]</button>
        <span class="spacer"></span>
        <button type="button" class="md-tb" id="ce-toc-btn" title="目录">目录</button>
      </div>` : ''}

      <div class="code-edit-bar">
        <span class="dim" id="ce-stat">正在读取原件…</span>
        <span class="spacer"></span>
        <button class="tip" type="button" data-tip="Tab 插入 ${INDENT.length} 个空格&#10;Shift+Tab 反缩进&#10;Ctrl / ⌘ + S 保存${isMd ? '&#10;Ctrl + B / I / K 粗体 / 斜体 / 链接' : ''}">?</button>
      </div>

      <div class="md-split${isMd ? '' : ' single'}">
        <textarea id="ce-text" class="code-edit" spellcheck="false"
          autocapitalize="off" autocorrect="off" wrap="${wrap}" rows="24"
          aria-label="文档内容" disabled>正在加载…</textarea>
        ${isMd ? `<aside class="md-side">
          <nav class="md-toc" id="ce-toc" hidden></nav>
          <div class="md-preview" id="ce-preview"></div>
        </aside>` : ''}
      </div>

      <div class="editor-actions">
        <button class="btn primary" id="ce-save" disabled>保存</button>
        <button class="btn ghost" id="ce-cancel">取消</button>
        <span class="spacer"></span>
        <a class="btn ghost" id="ce-download" target="_blank" rel="noopener">下载当前原件</a>
      </div>

      <div id="ce-msg" class="editor-msg"></div>
    </div>
  `

  const ta = container.querySelector('#ce-text')
  const stat = container.querySelector('#ce-stat')
  const msg = container.querySelector('#ce-msg')
  const saveBtn = container.querySelector('#ce-save')
  const download = container.querySelector('#ce-download')

  download.href = authedUrl(`/api/v1/docs/${encodeURIComponent(doc.id)}/file`)

  /** 未改动的基线内容（判断是否有脏改动）。 */
  let pristine = ''
  /** 正在保存（防重复提交）。 */
  let saving = false

  /**
   * 显示提示。
   * @param {string} text - 文本
   * @param {'ok'|'err'|''} [kind] - 类型
   */
  const say = (text, kind = '') => {
    msg.className = `editor-msg ${kind}`
    msg.textContent = text
  }

  /** 更新行数/字数与脏标记。 */
  const updateStat = () => {
    const value = ta.value
    const dirty = value !== pristine
    stat.textContent = `${countLines(value)} 行 · ${value.length} 字${dirty ? ' · 未保存' : ''}`
    stat.classList.toggle('dirty', dirty)
    return dirty
  }

  // ---- 读取原件 ----
  // 不用 /text：那是**抽取后**的正文，会压缩缩进、合并空行，
  // 在编辑器里打开就已经不是原样了。必须取原件字节。
  try {
    const res = await fetch(download.href, { headers: authHeaders() })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    ta.value = text
    pristine = text
    ta.disabled = false
    saveBtn.disabled = false
    say('')
  } catch (err) {
    ta.value = ''
    say(`读取原件失败：${err.message}`, 'err')
    updateStat()
    return
  }

  updateStat()

  /* ---- 键盘 ---- */

  ta.addEventListener('keydown', (ev) => {
    if (ev.key === 'Tab' && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      ev.preventDefault()
      if (ev.shiftKey) outdent()
      else indentBlock()
      updateStat()
      return
    }
    // Ctrl/Cmd+S 保存
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
      ev.preventDefault()
      save()
      return
    }
    // Markdown 快捷键（只在 md 上生效，避免影响代码里打括号）
    if (isMd && (ev.ctrlKey || ev.metaKey)) {
      const k = ev.key.toLowerCase()
      if (k === 'b') { ev.preventDefault(); wrapSelection('**', '粗体'); return }
      if (k === 'i') { ev.preventDefault(); wrapSelection('*', '斜体'); return }
      if (k === 'k') { ev.preventDefault(); wrapSelection('[', '链接文字'); return }
    }
  })

  ta.addEventListener('input', () => {
    updateStat()
    if (isMd) schedulePreview()
  })

  /* ---- Markdown：实时预览、目录、工具栏 ---- */

  /** 预览渲染的防抖句柄。 */
  let previewTimer = 0
  /** 双链解析用的「标题 → 文档」索引（首次渲染时取一次）。 */
  let titleIndex = null

  /**
   * 安排一次预览重绘（防抖 180ms —— 每次按键都全量渲染太浪费）。
   * @returns {void}
   */
  function schedulePreview() {
    if (!isMd) return
    clearTimeout(previewTimer)
    previewTimer = setTimeout(renderPreviewNow, 180)
  }

  /**
   * 立即渲染预览与目录。
   * @returns {Promise<void>} 完成
   */
  async function renderPreviewNow() {
    const box = container.querySelector('#ce-preview')
    if (!box) return

    if (titleIndex === null) {
      try {
        const manifest = await loadManifest()
        titleIndex = buildTitleIndex(manifest?.docs ?? [])
      } catch {
        titleIndex = new Map()
      }
    }

    const { html, toc } = await renderMarkdown(ta.value, { titleIndex })
    box.innerHTML = html

    const nav = container.querySelector('#ce-toc')
    if (nav) {
      if (toc.length >= 2) {
        nav.hidden = false
        nav.innerHTML = `<b>目录</b>${toc.map((t) => `<a href="#${t.id}" data-toc="${t.id}" style="--lv:${t.level}">${esc(t.text)}</a>`).join('')}`
      } else {
        nav.hidden = true
        nav.innerHTML = ''
      }
    }
  }

  /**
   * 在光标处包一层行内标记（粗体/斜体/代码）。有选区就包住选区。
   * @param {string} mark - 标记，如 `**`
   * @param {string} [placeholder] - 没有选区时插入的占位文字
   * @returns {void}
   */
  function wrapSelection(mark, placeholder = '文字') {
    const { selectionStart: s, selectionEnd: e, value } = ta
    const picked = value.slice(s, e) || placeholder
    ta.setRangeText(`${mark}${picked}${mark}`, s, e, 'end')
    ta.setSelectionRange(s + mark.length, s + mark.length + picked.length)
    updateStat()
    schedulePreview()
  }

  /**
   * 给选中的每一行加前缀（列表、引用）。
   * @param {string} prefix - 行首前缀
   * @param {(i:number)=>string} [prefixOf] - 有序列表用：按行号生成前缀
   * @returns {void}
   */
  function prefixLines(prefix, prefixOf = null) {
    const { selectionStart: s, selectionEnd: e, value } = ta
    const from = value.lastIndexOf('\n', s - 1) + 1
    const to = e === s ? value.indexOf('\n', e) : e
    const block = value.slice(from, to === -1 ? value.length : to)
    const lines = block.split('\n')
    const next = lines.map((l, i) => `${prefixOf ? prefixOf(i) : prefix}${l}`).join('\n')
    ta.setRangeText(next, from, to === -1 ? value.length : to, 'select')
    updateStat()
    schedulePreview()
  }

  /**
   * 在光标处插入一段块级模板（代码块、表格）。
   * @param {string} text - 模板
   * @param {number} [caretOffset] - 插入后光标相对起点的偏移
   * @returns {void}
   */
  function insertBlock(text, caretOffset = text.length) {
    const { selectionStart: s, selectionEnd: e } = ta
    const before = ta.value.slice(0, s)
    const needNl = before && !before.endsWith('\n') ? '\n' : ''
    const payload = `${needNl}${text}`
    ta.setRangeText(payload, s, e, 'end')
    const caret = s + needNl.length + caretOffset
    ta.setSelectionRange(caret, caret)
    updateStat()
    schedulePreview()
  }

  /** 工具栏动作表。 */
  const MD_ACTIONS = {
    h2: () => prefixLines('## '),
    h3: () => prefixLines('### '),
    bold: () => wrapSelection('**', '粗体'),
    italic: () => wrapSelection('*', '斜体'),
    code: () => wrapSelection('`', '代码'),
    strike: () => wrapSelection('~~', '删除'),
    ul: () => prefixLines('- '),
    ol: () => prefixLines('', (i) => `${i + 1}. `),
    task: () => prefixLines('- [ ] '),
    quote: () => prefixLines('> '),
    codeblock: () => insertBlock('\n```\n\n```\n', 5),
    table: () => insertBlock('\n| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |\n'),
    link: () => wrapSelection('[', '链接文字'),
    wiki: () => wrapSelection('[[', '文档标题'),
  }

  container.querySelectorAll('[data-md]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.preventDefault()
      MD_ACTIONS[btn.dataset.md]?.()
      ta.focus()
    })
  })

  container.querySelector('#ce-toc-btn')?.addEventListener('click', () => {
    const nav = container.querySelector('#ce-toc')
    if (!nav) return
    nav.hidden = !nav.hidden
    if (!nav.hidden) renderPreviewNow()
  })

  container.querySelector('#ce-preview')?.addEventListener('click', (ev) => {
    const toc = ev.target.closest('[data-toc]')
    if (toc) {
      ev.preventDefault()
      container.querySelector(`#${CSS.escape(toc.dataset.toc)}`)?.scrollIntoView({ block: 'start' })
    }
  })

  /**
   * 在光标处插入缩进（有跨行选区时整体右移）。
   * @returns {void}
   */
  function indentBlock() {
    const { selectionStart: s, selectionEnd: e, value } = ta
    if (s === e) {
      // setRangeText 走浏览器原生编辑栈，Ctrl+Z 仍然可用
      ta.setRangeText(INDENT, s, e, 'end')
      return
    }
    const from = value.lastIndexOf('\n', s - 1) + 1
    ta.setRangeText(value.slice(from, e).replace(/^/gm, INDENT), from, e, 'select')
  }

  /**
   * 去掉行首一级缩进。
   * @returns {void}
   */
  function outdent() {
    const { selectionStart: s, selectionEnd: e, value } = ta
    const from = value.lastIndexOf('\n', s - 1) + 1
    const block = value.slice(from, e)
    const shifted = block.replace(/^(?: {1,2}|\t)/gm, '')

    if (shifted === block) {
      // 选区里没有可退的行：光标处退一格，符合直觉
      if (s > 0) ta.setRangeText('', Math.max(s - INDENT.length, from), s, 'end')
      return
    }
    ta.setRangeText(shifted, from, e, 'select')
  }

  /* ---- 保存 ---- */

  /** 保存内容。 */
  async function save() {
    if (saving) return

    const content = ta.value
    if (!content.trim()) {
      say('内容为空，已取消保存（不想保留这份文档请用「编辑元数据」里的删除）', 'err')
      return
    }
    if (content.length > MAX_CHARS) {
      say(`内容过长（${content.length} 字，上限 ${MAX_CHARS} 字）`, 'err')
      return
    }
    if (content === pristine) {
      say('内容没有改动。')
      return
    }

    saving = true
    saveBtn.disabled = true
    say('保存中…')

    try {
      const data = await apiFetch(`/api/v1/docs/${encodeURIComponent(doc.id)}/content`, {
        method: 'PUT',
        body: {
          content,
          // 乐观并发：告诉服务端我们是基于哪一版改的。
          // 若期间别处改过，服务端返回 409 而不是默默覆盖。
          baseUpdatedAt: doc.updatedAt,
        },
      })

      pristine = content
      updateStat()

      if (data.indexError) {
        say(`已保存，但索引更新失败：${data.indexError}`, 'err')
      } else {
        say(data.unchanged ? '内容没有变化。' : '已保存，预览与索引已同步。', 'ok')
      }
      opts.onSaved?.(data)
    } catch (err) {
      say(err.code === 'CONFLICT' ? `保存被拒绝：${err.message}` : `保存失败：${err.message}`, 'err')
    } finally {
      saving = false
      saveBtn.disabled = false
    }
  }

  saveBtn.addEventListener('click', save)

  container.querySelector('#ce-cancel').addEventListener('click', () => {
    if (updateStat() && !confirm('有未保存的改动，确定放弃？')) return
    container.innerHTML = ''
    opts.onCancel?.()
  })

  // 有未保存改动时，关页面/刷新要拦一下
  window.addEventListener('beforeunload', (ev) => {
    // 编辑器已卸载就不该再拦（否则会拦掉整个页面之后的每次导航）
    if (!ta.isConnected || ta.value === pristine) return
    ev.preventDefault()
    ev.returnValue = ''
  })

  ta.focus()
  ta.setSelectionRange(0, 0)
}
