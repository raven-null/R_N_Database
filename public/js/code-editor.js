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
import { apiFetch, authHeaders, authedUrl } from './api.js'

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

  container.innerHTML = `
    <div class="editor code-editor">
      <div class="editor-head">
        <b>编辑内容</b>
        <button class="tip" type="button" data-tip="${esc(label)} 原件直接改写。&#10;保存后会重渲染预览件，并用新旧两版正文增量更新检索索引。">?</button>
      </div>

      <div class="code-edit-bar">
        <span class="dim" id="ce-stat">正在读取原件…</span>
        <span class="spacer"></span>
        <button class="tip" type="button" data-tip="Tab 插入 ${INDENT.length} 个空格&#10;Shift+Tab 反缩进&#10;Ctrl / ⌘ + S 保存">?</button>
      </div>

      <textarea id="ce-text" class="code-edit" spellcheck="false"
        autocapitalize="off" autocorrect="off" wrap="${wrap}" rows="24"
        aria-label="文档内容" disabled>正在加载…</textarea>

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
    }
  })

  ta.addEventListener('input', updateStat)

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
