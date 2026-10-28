/**
 * 上传界面：选文件 + 拖拽上传 + 待处理清单。
 *
 * ## 上传是两阶段的
 *
 * 这里只负责第一阶段：把原件传到暂存区。真正的入库（抽正文、
 * Office 转 PDF、分类打标）在本地跑 `node scripts/process-pending.mjs` ——
 * 因为 Netlify 上没有 LibreOffice，也扛不住 300 页 PDF 的抽取。
 * 所以界面上要**明确告诉用户接下来该做什么**，否则文件传上去就没了下文。
 *
 * 上传用原始字节（非 multipart/base64），最省内存。
 *
 * @module public/js/upload
 */

import { esc, fmtSize, fmtDate, typeBadge } from './util.js'
import { authHeaders, apiFetch } from './api.js'

/** 单文件上限，与服务端保持一致。 */
const MAX_BYTES = 20 * 1024 * 1024

/**
 * 把单个文件传到暂存区。
 *
 * @param {File} file - 浏览器 File 对象
 * @returns {Promise<object>} 服务端返回的记录
 */
async function uploadOne(file) {
  const res = await fetch(`/api/v1/inbox?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/octet-stream' },
    body: file,
  })

  let body = null
  try {
    body = await res.json()
  } catch {
    throw new Error(`响应不是 JSON（HTTP ${res.status}）`)
  }
  if (!body?.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
  return body.data
}

/**
 * 挂载上传界面。
 *
 * @param {object} opts - { button, dropZone, banner, onChange }
 *   button   「上传」按钮
 *   dropZone 可拖拽区域（通常是右侧列表盒子）
 *   banner   结果显示区
 *   onChange  暂存区变化后的回调（重新拉清单）
 * @returns {object} 控制器
 */
export function mountUpload(opts) {
  const { button, dropZone, banner, onChange } = opts

  // 隐藏的文件选择器
  //
  // accept 只影响文件对话框的默认过滤，**真正的白名单在服务端**
  // （_lib/file-types.mjs 的 EXT_ALIASES）。这里不追求列全 60 多种后缀，
  // 但代码类必须带上 —— 否则在文件对话框里根本选不中 .ts/.py 这类文件，
  // 用户会以为"不支持代码"。
  const picker = document.createElement('input')
  picker.type = 'file'
  picker.multiple = true
  picker.accept = [
    // 文档
    '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.md', '.markdown', '.txt', '.csv',
    // 代码与配置
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte',
    '.py', '.java', '.kt', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.cs', '.rb', '.php',
    '.swift', '.dart', '.lua', '.r', '.scala', '.groovy',
    '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
    '.sql', '.html', '.css', '.scss', '.less',
    '.json', '.yaml', '.yml', '.toml', '.ini', '.xml', '.conf',
    '.proto', '.graphql', '.tex', '.diff', '.patch',
  ].join(',')
  picker.style.display = 'none'
  document.body.appendChild(picker)

  let busy = false

  /**
   * 处理一批文件。
   * @param {FileList|File[]} files - 文件列表
   */
  async function handleFiles(files) {
    const list = [...files]
    if (list.length === 0 || busy) return

    const oversize = list.filter((f) => f.size > MAX_BYTES)
    const ok = list.filter((f) => f.size <= MAX_BYTES)

    if (oversize.length) {
      banner.innerHTML = `<div class="banner warn">
        ${oversize.map((f) => esc(f.name)).join('、')} 超过 ${MAX_BYTES / 1024 / 1024}MB，
        网页上传不支持这么大的文件。<br>
        <span class="dim">请把文件放到本地目录后用命令行入库：
        <code>node scripts/ingest.mjs "目录"</code>（那条路直写存储，没有体积限制）</span>
      </div>`
    }

    if (ok.length === 0) return

    busy = true
    button.disabled = true
    const results = []

    for (let i = 0; i < ok.length; i++) {
      const f = ok[i]
      banner.innerHTML = `<div class="banner info">正在上传 ${i + 1}/${ok.length}：
        ${esc(f.name)}（${fmtSize(f.size)}）</div>`
      try {
        const rec = await uploadOne(f)
        results.push({ file: f, rec, error: null })
      } catch (err) {
        results.push({ file: f, rec: null, error: String(err?.message ?? err) })
      }
    }

    busy = false
    button.disabled = false

    const done = results.filter((r) => !r.error)
    const dupInLib = done.filter((r) => r.rec.alreadyInLibrary)
    const dupPending = done.filter((r) => r.rec.alreadyPending && !r.rec.alreadyInLibrary)

    banner.innerHTML = `<div class="banner ${results.some((r) => r.error) ? 'warn' : 'info'}">
      <b>已上传 ${done.length} / ${ok.length} 个文件</b>
      ${results.filter((r) => r.error).map((r) =>
        `<br>✗ ${esc(r.file.name)}：${esc(r.error)}`).join('')}
      ${dupInLib.length ? `<br>· ${dupInLib.length} 个库里已有同样内容，入库时会自动去重` : ''}
      ${dupPending.length ? `<br>· ${dupPending.length} 个暂存区已有同样内容` : ''}
      <br><br>
      <b>下一步</b>：文件已存进<b>线上暂存区</b>（Netlify Blobs），尚未入库。
      在本地运行：<br>
      <code>node scripts/process-pending.mjs</code>
      <br><span class="dim">
        需要先在项目根目录的 <code>.env</code> 里配好
        <code>SITE_ID</code> 与 <code>NETLIFY_ACCESS_TOKEN</code>，
        本地脚本才连得上线上暂存区（否则它只看本地目录，会显示为空）。<br>
        重活 —— 抽正文、Office 转 PDF、分类打标 —— 必须在本地跑，
        线上函数没有 LibreOffice，也扛不住大文件。
      </span>
      <br><br><button class="btn ghost" id="up-dismiss">知道了</button>
    </div>`

    document.getElementById('up-dismiss')?.addEventListener('click', () => {
      banner.innerHTML = ''
    })

    onChange?.()
  }

  button.addEventListener('click', () => picker.click())
  picker.addEventListener('change', () => {
    handleFiles(picker.files)
    picker.value = ''   // 允许再次选同一文件
  })

  // ---- 拖拽 ----
  let depth = 0
  const showDrop = (on) => dropZone.classList.toggle('dropping', on)

  dropZone.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return
    e.preventDefault()
    depth += 1
    showDrop(true)
  })
  dropZone.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  })
  dropZone.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1)
    if (depth === 0) showDrop(false)
  })
  dropZone.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return
    e.preventDefault()
    depth = 0
    showDrop(false)
    handleFiles(e.dataTransfer.files)
  })

  return { picker }
}

/**
 * 渲染待处理清单。
 *
 * @param {HTMLElement} container - 容器
 * @param {object} opts - { onChange }
 * @returns {Promise<number>} 待处理数量
 */
export async function renderPending(container, opts = {}) {
  let data
  try {
    data = await apiFetch('/api/v1/inbox')
  } catch (err) {
    container.innerHTML = `<div class="pending-note err">读取暂存区失败：${esc(err.message)}</div>`
    return 0
  }

  if (!data.total) {
    container.innerHTML = ''
    return 0
  }

  container.innerHTML = `
    <div class="pending-head">
      <b>待入库 ${data.total} 份</b>
      <span class="dim">跑 <code>node scripts/process-pending.mjs</code> 完成</span>
    </div>
    <div class="pending-list">
      ${data.items.map((it) => `
        <div class="pending-item" data-id="${esc(it.id)}">
          ${typeBadge(it.type, it.ext)}
          <div class="pending-main">
            <div class="pending-title">${esc(it.title)}</div>
            <div class="pending-meta">${fmtSize(it.size)}<i>·</i>${fmtDate(it.uploadedAt)}</div>
          </div>
          <button class="pending-del" data-del="${esc(it.id)}" title="从暂存区移除">移除</button>
        </div>`).join('')}
    </div>`

  container.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('从暂存区移除这份文件？（原文件不会入库）')) return
      try {
        await apiFetch(`/api/v1/inbox/${encodeURIComponent(btn.dataset.del)}`, { method: 'DELETE' })
        await renderPending(container, opts)
        opts.onChange?.()
      } catch (err) {
        alert(`移除失败：${err.message}`)
      }
    })
  })

  return data.total
}
