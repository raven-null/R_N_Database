/**
 * 标签：快速增删 + 全库管理。
 *
 * 两个东西：
 *   1. `openQuickTag` —— 列表页/阅读页点一下就能加删标签，
 *      不必每次展开完整的编辑面板。
 *   2. `openTagManager` —— 全库标签的重命名、合并、删除。
 *      标签用久了必然出现同义词（「AI」与「人工智能」、「设计」与「UI设计」），
 *      没有合并手段就只能一份份手改。
 *
 * 浮层都挂在 `document.body` 上而不是卡片里 —— 列表重渲染会把卡片换掉，
 * 挂在里面的浮层会跟着消失。
 *
 * @module public/js/tags
 */

import { esc } from './util.js'
import { apiFetch } from './api.js'

/** 同时只允许一个浮层。 */
let current = null

/**
 * 关掉当前浮层。
 * @returns {void}
 */
export function closePopover() {
  if (current) {
    current.remove()
    current = null
    document.removeEventListener('mousedown', onOutside, true)
    document.removeEventListener('keydown', onEsc, true)
  }
}

/**
 * 点击浮层外部时关闭。
 * @param {MouseEvent} e - 事件
 */
function onOutside(e) {
  if (current && !current.contains(e.target)) closePopover()
}

/**
 * Esc 关闭。
 * @param {KeyboardEvent} e - 事件
 */
function onEsc(e) {
  if (e.key === 'Escape') closePopover()
}

/**
 * 把浮层放到锚点附近，并保证不出屏。
 * @param {HTMLElement} el - 浮层
 * @param {HTMLElement} anchor - 锚点
 * @returns {void}
 */
function place(el, anchor) {
  const r = anchor.getBoundingClientRect()
  const w = el.offsetWidth
  const h = el.offsetHeight
  let left = r.left
  let top = r.bottom + 6

  if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8
  if (left < 8) left = 8
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6)

  el.style.left = `${left}px`
  el.style.top = `${top}px`
}

/* ============================================================
   快速打标签
   ============================================================ */

/**
 * 打开「快速打标签」浮层。
 *
 * @param {object} doc - 文档元数据（需含 tags）
 * @param {HTMLElement} anchor - 锚点元素
 * @param {object} [opts] - { onChanged(newTags), suggestions: string[] }
 * @returns {void}
 */
export function openQuickTag(doc, anchor, opts = {}) {
  closePopover()

  const tags = [...(doc.tags ?? [])]
  const box = document.createElement('div')
  box.className = 'popover'
  box.innerHTML = `
    <div class="popover-head">${esc(doc.title).slice(0, 40)}</div>
    <div class="popover-tags" id="qt-list"></div>
    <div class="popover-row">
      <input id="qt-input" type="text" placeholder="输入标签后回车" autocomplete="off">
    </div>
    <div class="popover-sugs" id="qt-sugs"></div>`

  document.body.appendChild(box)
  current = box
  place(box, anchor)
  document.addEventListener('mousedown', onOutside, true)
  document.addEventListener('keydown', onEsc, true)

  const listEl = box.querySelector('#qt-list')
  const input = box.querySelector('#qt-input')
  const sugEl = box.querySelector('#qt-sugs')

  /**
   * 把标签变更提交到后端。
   * @param {string[]} next - 新的标签数组
   */
  async function save(next) {
    try {
      const data = await apiFetch(`/api/v1/docs/${encodeURIComponent(doc.id)}`, {
        method: 'PATCH',
        body: { tags: next },
      })
      doc.tags = data.doc.tags
      opts.onChanged?.(data.doc.tags)
    } catch (err) {
      alert(`保存失败：${err.message}`)
    }
  }

  /** 重画标签与建议。 */
  function draw() {
    listEl.innerHTML = tags.length
      ? tags.map((t) => `<span class="tag removable" data-tag="${esc(t)}">${esc(t)}<b>×</b></span>`).join('')
      : '<span class="dim">还没有标签</span>'

    listEl.querySelectorAll('[data-tag]').forEach((el) => {
      el.addEventListener('click', async () => {
        tags.splice(tags.indexOf(el.dataset.tag), 1)
        draw()
        await save([...tags])
      })
    })

    const used = new Set(tags)
    const sugs = (opts.suggestions ?? []).filter((s) => !used.has(s)).slice(0, 8)
    sugEl.innerHTML = sugs.length
      ? `<span class="dim">常用：</span>${sugs.map((s) => `<span class="tag clickable" data-sug="${esc(s)}">${esc(s)}</span>`).join('')}`
      : ''

    sugEl.querySelectorAll('[data-sug]').forEach((el) => {
      el.addEventListener('click', async () => {
        if (!tags.includes(el.dataset.sug)) {
          tags.push(el.dataset.sug)
          draw()
          await save([...tags])
        }
      })
    })
  }

  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return
    const v = input.value.trim()
    if (!v) return
    if (!tags.includes(v)) {
      tags.push(v)
      input.value = ''
      draw()
      await save([...tags])
    }
    input.value = ''
  })

  draw()
  input.focus()
}

/* ============================================================
   标签管理
   ============================================================ */

/**
 * 打开标签管理面板：重命名、合并、删除。
 *
 * @param {object} [opts] - { onChanged }
 * @returns {Promise<void>} 完成
 */
export async function openTagManager(opts = {}) {
  let stats
  try {
    stats = await apiFetch('/api/v1/tags')
  } catch (err) {
    alert(`读取标签失败：${err.message}`)
    return
  }

  const mask = document.createElement('div')
  mask.className = 'modal-mask'
  mask.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <b>标签管理</b>
        <span class="dim">共 ${stats.total} 个标签 · ${stats.docCount} 份文档</span>
        <span class="modal-spacer"></span>
        <button class="btn ghost" data-close>关闭</button>
      </div>
      <div class="modal-body" id="tm-body"></div>
      <div class="modal-foot dim">
        重命名与合并会**改掉所有用到该标签的文档**；删除只是把标签从文档上摘掉，不会删文档。
      </div>
    </div>`

  document.body.appendChild(mask)
  const body = mask.querySelector('#tm-body')

  const close = () => {
    mask.remove()
    opts.onChanged?.()
  }
  mask.querySelector('[data-close]').addEventListener('click', close)
  mask.addEventListener('mousedown', (e) => {
    if (e.target === mask) close()
  })
  document.addEventListener('keydown', function esc2(e) {
    if (e.key === 'Escape') {
      close()
      document.removeEventListener('keydown', esc2, true)
    }
  }, true)

  /** 重画标签列表。 */
  function draw() {
    if (stats.tags.length === 0) {
      body.innerHTML = '<div class="empty">还没有任何标签。</div>'
      return
    }

    body.innerHTML = `
      <table class="tag-table">
        <thead><tr><th>标签</th><th class="num">文档数</th><th>操作</th></tr></thead>
        <tbody>
          ${stats.tags.map((t) => `
            <tr data-tag="${esc(t.name)}">
              <td><span class="tag">${esc(t.name)}</span></td>
              <td class="num">${t.count}</td>
              <td class="tag-ops">
                <button class="btn ghost" data-act="rename">重命名</button>
                <button class="btn ghost" data-act="merge">合并到…</button>
                <button class="btn danger" data-act="delete">删除</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
      ${stats.unused.length ? `
        <div class="modal-note">
          <b>词表里定义但没人用的标签</b>（${stats.unused.length} 个）：
          ${stats.unused.map((u) => `<span class="tag dimtag">${esc(u)}</span>`).join('')}
          <div class="dim">这些还没被任何文档使用，可在 config/taxonomy.json 里决定保留或清理。</div>
        </div>` : ''}`

    body.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tag = btn.closest('[data-tag]').dataset.tag
        if (btn.dataset.act === 'rename') doRename(tag)
        else if (btn.dataset.act === 'merge') doMerge(tag)
        else doDelete(tag)
      })
    })
  }

  /**
   * 重命名一个标签。
   * @param {string} from - 原标签
   */
  async function doRename(from) {
    const to = prompt(`把标签「${from}」重命名为：`, from)
    if (to === null) return
    const next = to.trim()
    if (!next || next === from) return

    try {
      const data = await apiFetch('/api/v1/tags/rename', {
        method: 'POST',
        body: { from, to: next },
      })
      await reload(`已将「${from}」重命名为「${next}」，影响 ${data.affected} 份文档`)
    } catch (err) {
      alert(`重命名失败：${err.message}`)
    }
  }

  /**
   * 把多个标签合并到一个。
   * @param {string} target - 合并到的目标标签
   */
  async function doMerge(target) {
    const others = stats.tags.map((t) => t.name).filter((n) => n !== target)
    if (others.length === 0) return

    const picked = prompt(
      `把哪些标签合并到「${target}」？\n\n`
      + `输入要合并的标签名，多个用逗号分隔。可选：\n${others.join('、')}`,
      '',
    )
    if (picked === null || !picked.trim()) return

    const from = picked.split(/[,，]/).map((s) => s.trim()).filter((s) => s && s !== target)
    if (from.length === 0) return

    try {
      const data = await apiFetch('/api/v1/tags/rename', {
        method: 'POST',
        body: { from, to: target },
      })
      await reload(`已把 ${from.length} 个标签合并到「${target}」，影响 ${data.affected} 份文档`)
    } catch (err) {
      alert(`合并失败：${err.message}`)
    }
  }

  /**
   * 全库删除一个标签。
   * @param {string} tag - 标签名
   */
  async function doDelete(tag) {
    if (!confirm(`把标签「${tag}」从所有文档上摘掉？\n\n文档本身不会被删除。`)) return
    try {
      const data = await apiFetch(`/api/v1/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' })
      await reload(`已删除标签「${tag}」，影响 ${data.affected} 份文档`)
    } catch (err) {
      alert(`删除失败：${err.message}`)
    }
  }

  /**
   * 重新拉统计并重画。
   * @param {string} [msg] - 操作结果提示
   */
  async function reload(msg) {
    try {
      stats = await apiFetch('/api/v1/tags')
    } catch {
      /* 拉不到就保持旧数据 */
    }
    draw()
    if (msg) {
      const note = mask.querySelector('.modal-head .dim')
      if (note) note.textContent = msg
    }
  }

  draw()
}
