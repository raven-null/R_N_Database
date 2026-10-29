/**
 * 多选与批量操作。
 *
 * 整理几百份文档时一份份改元数据不现实，这个模块提供：
 * 进入选择模式 → 勾选若干 → 底部操作栏批量加/删标签、改分类、
 * 标为待复查、删除。
 *
 * 与 list.js 的分工：选择状态与操作栏在这里，list.js 只负责
 * 按 `isActive()`/`has(id)` 决定卡片上要不要画勾选框。
 *
 * @module public/js/select
 */

import { esc } from './util.js'
import { apiFetch } from './api.js'

/**
 * 挂载选择模式。
 *
 * @param {object} opts - { bar, taxonomy, onChange, onDelete }
 *   bar       底部操作栏容器
 *   taxonomy  分类词表（用于「改分类」的下拉）
 *   onChange  数据变化后的回调（重新渲染列表）
 *   onDelete  删除后的回调
 * @returns {object} 控制器
 */
export function mountSelect(opts) {
  const { bar, onChange } = opts
  const picked = new Set()
  let active = false

  /* ---------------- 状态接口 ---------------- */

  const api = {
    /** 是否处于选择模式。 */
    isActive: () => active,
    /** 某份文档是否被勾选。 */
    has: (id) => picked.has(id),
    /** 已选数量。 */
    count: () => picked.size,
    /**
     * 进入选择模式。
     *
     * 必须通知 list.js 重画 —— 卡片上要不要画勾选框由它决定。
     * （早期版本只重画了操作栏，结果操作栏弹出来了、卡片上却没有勾选框，
     *   连带「已选 0 份」把后续所有批量按钮都置灰了。）
     */
    enter: () => {
      active = true
      render()
      onChange?.()
    },
    /** 退出并清空。 */
    exit: () => {
      active = false
      picked.clear()
      render()
      onChange?.()
    },
    /**
     * 勾选/取消。
     *
     * 这里**不整表重渲染**：60 张卡片重画一次会闪，而且会丢掉滚动位置。
     * 勾选框本身由浏览器切换，这里只需同步卡片高亮与操作栏计数。
     */
    toggle: (id) => {
      if (picked.has(id)) picked.delete(id)
      else picked.add(id)

      const card = document.querySelector(`.doc[data-id="${CSS.escape(id)}"]`)
      if (card) {
        card.classList.toggle('picked', picked.has(id))
        const cb = card.querySelector('input[data-check]')
        if (cb) cb.checked = picked.has(id)
      }
      render()
    },
    /** 全选当前可见的。 */
    selectAll: (ids) => {
      for (const id of ids) picked.add(id)
      render()
      onChange?.()
    },
  }

  /* ---------------- 渲染 ---------------- */

  /** 当前展开的输入面板：'add' | 'remove' | 'category' | null。 */
  let mode = null
  /** 缓存最近一次渲染出的可见 id（供「全选」用）。 */
  let visibleIds = []

  /**
   * 更新可见 id 列表（list.js 渲染后调用）。
   * @param {string[]} ids - 当前列表中显示的文档 id
   */
  api.setVisible = (ids) => { visibleIds = ids }

  /** 重画操作栏。 */
  function render() {
    if (!active) {
      bar.hidden = true
      bar.innerHTML = ''
      return
    }

    bar.hidden = false
    const n = picked.size

    bar.innerHTML = `
      <div class="selbar-inner">
        <span class="selbar-count">已选 <b>${n}</b> 份</span>
        <button class="tip" type="button" data-tip="批量操作会直接改写选中文档的元数据并同步检索索引。&#10;「改分类」是整体替换，「加 / 删标签」只动标签，「删除」连原件一起删且不可撤销。">?</button>

        <div class="selbar-actions">
          <button class="btn" data-op="add" ${n ? '' : 'disabled'}>加标签</button>
          <button class="btn" data-op="remove" ${n ? '' : 'disabled'}>删标签</button>
          <button class="btn" data-op="category" ${n ? '' : 'disabled'}>改分类</button>
          <button class="btn ghost" data-op="review" ${n ? '' : 'disabled'}>标为待复查</button>
          <button class="btn danger" data-op="delete" ${n ? '' : 'disabled'}>删除</button>
        </div>

        <span class="selbar-spacer"></span>
        <button class="btn ghost" data-op="all">全选本页</button>
        <button class="btn ghost" data-op="clear">清空</button>
        <button class="btn ghost" data-op="exit">退出选择</button>
      </div>
      <div class="selbar-panel" id="selbar-panel"></div>
    `

    bar.querySelectorAll('[data-op]').forEach((btn) => {
      btn.addEventListener('click', () => onAction(btn.dataset.op))
    })

    if (mode) renderPanel()
  }

  /**
   * 渲染输入面板（加标签 / 删标签 / 改分类）。
   */
  function renderPanel() {
    const panel = bar.querySelector('#selbar-panel')
    if (!panel) return

    if (mode === 'add' || mode === 'remove') {
      const isAdd = mode === 'add'
      panel.innerHTML = `
        <div class="selbar-row">
          <input id="selbar-tags" type="text" placeholder="标签" aria-label="标签名，多个用逗号分隔"
                 autocomplete="off">
          <button class="btn primary" id="selbar-go">${isAdd ? '添加' : '移除'}</button>
          <button class="btn ghost" id="selbar-cancel">取消</button>
          <button class="tip" type="button" data-tip="${isAdd
    ? '给选中的每一份加上这些标签，已存在的不重复。多个标签用逗号分隔。'
    : '从选中的每一份里去掉这些标签。多个标签用逗号分隔。'}">?</button>
        </div>`
    } else if (mode === 'category') {
      const cats = (opts.taxonomy?.categories ?? []).filter((c) => c.id !== 'other')
      panel.innerHTML = `
        <div class="selbar-row">
          <select id="selbar-cat" aria-label="目标分类">
            ${cats.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('')}
          </select>
          <button class="btn primary" id="selbar-go">设为该分类</button>
          <button class="btn ghost" id="selbar-cancel">取消</button>
          <button class="tip" type="button" data-tip="会把选中文档的分类整体替换为所选分类。">?</button>
        </div>`
    }

    panel.querySelector('#selbar-cancel')?.addEventListener('click', () => {
      mode = null
      render()
    })

    panel.querySelector('#selbar-go')?.addEventListener('click', async () => {
      if (mode === 'category') {
        const cat = panel.querySelector('#selbar-cat')?.value ?? ''
        await runBatch('setCategory', { categories: [cat] })
        return
      }
      const tags = String(panel.querySelector('#selbar-tags')?.value ?? '')
        .split(/[,，]/).map((s) => s.trim()).filter(Boolean)
      if (tags.length === 0) {
        alert('请至少输入一个标签')
        return
      }
      await runBatch(mode === 'add' ? 'addTags' : 'removeTags', { tags })
    })

    panel.querySelector('#selbar-tags')?.focus()
    panel.querySelector('#selbar-tags')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') panel.querySelector('#selbar-go')?.click()
    })
  }

  /**
   * 执行批量操作。
   * @param {string} op - 操作名
   * @param {object} [extra] - 附加参数
   */
  async function runBatch(op, extra = {}) {
    const ids = [...picked]
    if (ids.length === 0) return

    const goBtn = bar.querySelector('#selbar-go')
    if (goBtn) { goBtn.disabled = true; goBtn.textContent = '处理中…' }

    try {
      const data = await apiFetch('/api/v1/docs/batch', {
        method: 'POST',
        body: { ids, op, ...extra },
      })
      mode = null
      picked.clear()
      render()
      onChange?.()
      // 结果用临时提示告知，不打断操作
      flash(`已处理 ${data.applied} 份${data.indexError ? '（索引未同步，请跑 reindex）' : ''}`)
    } catch (err) {
      if (goBtn) { goBtn.disabled = false; goBtn.textContent = '重试' }
      alert(`批量操作失败：${err.message}`)
    }
  }

  /**
   * 显示一条短暂提示。
   * @param {string} text - 文本
   */
  function flash(text) {
    const el = document.createElement('div')
    el.className = 'toast'
    el.textContent = text
    document.body.appendChild(el)
    setTimeout(() => el.classList.add('show'), 10)
    setTimeout(() => {
      el.classList.remove('show')
      setTimeout(() => el.remove(), 300)
    }, 2200)
  }

  /**
   * 顶部按钮/栏内按钮的入口。
   * @param {string} op - 操作名
   */
  function onAction(op) {
    if (op === 'exit') return api.exit()
    if (op === 'clear') {
      picked.clear()
      mode = null
      render()
      onChange?.()   // 清空后卡片高亮要跟着掉
      return
    }
    if (op === 'all') { api.selectAll(visibleIds); return }
    if (op === 'review') return runBatch('markReview')

    if (op === 'delete') {
      const n = picked.size
      if (!confirm(`确定删除选中的 ${n} 份文档？\n\n`
        + '会同时删除原件、预览件、正文与索引记录，且不可撤销。\n'
        + '本地的源文件不受影响。')) return
      return runBatch('delete')
    }

    mode = mode === op ? null : op
    render()
  }

  render()
  return api
}
