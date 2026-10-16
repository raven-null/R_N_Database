/**
 * 文档编辑面板。
 *
 * 存在的意义：没有它，「待复查」队列就是个死胡同 ——
 * 机器分错了类你只能干瞪眼，或者改词表后重跑全库。
 * 有了它，复查 = 打开 → 改 → 保存，索引增量同步。
 *
 * 单独成模块而不是塞进 view.js：编辑表单有自己的状态与校验，
 * 混在阅读逻辑里会两头都难维护（图库项目 270KB 单文件的教训）。
 *
 * @module public/js/edit
 */

import { esc } from './util.js'
import { apiFetch, authHeaders } from './api.js'

/**
 * 挂载编辑面板。
 *
 * @param {HTMLElement} container - 容器
 * @param {object} opts - { doc, taxonomy, canEdit, onSaved, onDeleted }
 * @returns {void}
 */
export function mountEditor(container, opts) {
  const { doc, taxonomy, canEdit } = opts

  if (!canEdit) {
    container.innerHTML = ''
    return
  }

  const cats = (taxonomy?.categories ?? []).filter((c) => c.id !== 'other')
  const selected = new Set(doc.categories ?? [])

  container.innerHTML = `
    <div class="editor">
      <div class="editor-head">
        <b>编辑元数据</b>
        <span class="dim">改分类/标签/标题后索引会立即同步，「待复查」标记自动清除</span>
      </div>

      <label class="field">
        <span>标题</span>
        <input id="ed-title" type="text" value="${esc(doc.title)}" maxlength="200">
      </label>

      <div class="field">
        <span>分类<em>（可多选，来自受控词表）</em></span>
        <div class="cat-picker">
          ${cats.map((c) => `
            <label class="cat-opt${selected.has(c.name) ? ' on' : ''}" data-cat="${esc(c.name)}">
              <input type="checkbox" value="${esc(c.name)}" ${selected.has(c.name) ? 'checked' : ''}>
              <span>${esc(c.name)}</span>
            </label>`).join('')}
        </div>
      </div>

      <label class="field">
        <span>标签<em>（逗号分隔，允许新建）</em></span>
        <input id="ed-tags" type="text" value="${esc((doc.tags ?? []).join(', '))}">
      </label>

      <label class="field">
        <span>摘要</span>
        <textarea id="ed-summary" rows="3" maxlength="600">${esc(doc.summary ?? '')}</textarea>
      </label>

      <label class="field">
        <span>可见性</span>
        <select id="ed-visibility">
          <option value="private"${doc.visibility !== 'public' ? ' selected' : ''}>私有（仅 admin/read 令牌可见）</option>
          <option value="public"${doc.visibility === 'public' ? ' selected' : ''}>公开（guest 令牌也能看到）</option>
        </select>
      </label>

      <div class="editor-actions">
        <button class="btn primary" id="ed-save">保存</button>
        <button class="btn ghost" id="ed-cancel">取消</button>
        <span class="spacer"></span>
        <button class="btn danger" id="ed-delete">删除这份文档</button>
      </div>

      <div id="ed-msg" class="editor-msg"></div>
    </div>
  `

  const msg = container.querySelector('#ed-msg')

  /**
   * 显示提示消息。
   * @param {string} text - 文本
   * @param {'ok'|'err'} [kind] - 类型
   */
  const say = (text, kind = 'ok') => {
    msg.className = `editor-msg ${kind}`
    msg.textContent = text
  }

  // 分类选项的高亮跟随勾选
  container.querySelectorAll('.cat-opt input').forEach((cb) => {
    cb.addEventListener('change', () => {
      cb.closest('.cat-opt').classList.toggle('on', cb.checked)
    })
  })

  container.querySelector('#ed-cancel').addEventListener('click', () => {
    container.innerHTML = ''
  })

  container.querySelector('#ed-save').addEventListener('click', async () => {
    const btn = container.querySelector('#ed-save')
    btn.disabled = true
    say('保存中…')

    const picked = [...container.querySelectorAll('.cat-opt input:checked')].map((cb) => cb.value)
    const body = {
      title: container.querySelector('#ed-title').value.trim(),
      categories: picked.length ? picked : ['未归类'],
      tags: container.querySelector('#ed-tags').value
        .split(/[,，]/).map((s) => s.trim()).filter(Boolean),
      summary: container.querySelector('#ed-summary').value.trim(),
      visibility: container.querySelector('#ed-visibility').value,
    }

    try {
      const data = await apiFetch(`/api/v1/docs/${encodeURIComponent(doc.id)}`, {
        method: 'PATCH',
        body,
      })
      say(data.indexError
        ? `已保存，但索引更新失败：${data.indexError}`
        : '已保存，索引已同步。', data.indexError ? 'err' : 'ok')
      btn.disabled = false
      opts.onSaved?.(data.doc)
    } catch (err) {
      say(`保存失败：${err.message}`, 'err')
      btn.disabled = false
    }
  })

  container.querySelector('#ed-delete').addEventListener('click', async () => {
    const yes = confirm(
      `确定删除「${doc.title}」？\n\n`
      + '会同时删除原件、预览件、抽取的正文与索引记录，且不可撤销。\n'
      + '本地的源文件不受影响。',
    )
    if (!yes) return

    const btn = container.querySelector('#ed-delete')
    btn.disabled = true
    say('删除中…')
    try {
      await apiFetch(`/api/v1/docs/${encodeURIComponent(doc.id)}`, { method: 'DELETE' })
      say('已删除，正在返回列表…')
      opts.onDeleted?.(doc.id)
    } catch (err) {
      say(`删除失败：${err.message}`, 'err')
      btn.disabled = false
    }
  })
}

/**
 * 查询当前令牌的角色，判断能否编辑。
 * @returns {Promise<boolean>} 是否具备编辑权限
 */
export async function canEditNow() {
  try {
    const res = await fetch('/api/v1/auth/status', { headers: authHeaders() })
    const body = await res.json()
    return body?.data?.role === 'admin'
  } catch {
    return false
  }
}
