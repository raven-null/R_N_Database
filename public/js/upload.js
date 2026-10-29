/**
 * 上传界面：选文件 / 选整个文件夹 + 拖拽上传 + 待处理清单。
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
 * ## 为什么"整个文件夹"要单独设计
 *
 * 一个真实的资料目录里，能入库的往往只是少数：
 * 还有 `Thumbs.db`、`~$草稿.docx` 这种 Office 临时锁文件、`.git`、
 * `node_modules`、几张截图、几个 200MB 的视频。如果照单全传：
 *   - 大量无效文件占满暂存区，还得一个个手动移除
 *   - 一个超大文件就能让整批失败
 * 所以这里先**在浏览器侧筛一遍**：不支持的类型、超限体积、系统垃圾文件
 * 都跳过并如实报数，用户能看到"传了什么、跳了什么、为什么"。
 *
 * 目录结构会保留：每个文件带着相对路径上传（`合同/2025/xx.pdf`），
 * 入库时写进 `sourcePath`，暂存区里也能分清同名文件。
 *
 * ## 拖拽文件夹的坑
 *
 * `drop` 事件里 `dataTransfer.files` 对**文件夹**通常是空的 ——
 * 必须走 `webkitGetAsEntry()` 递归读目录。而且 `readEntries()`
 * 一次只返回一部分（Chrome 每次最多 100 项），要循环读到返回空数组为止，
 * 否则大目录会**只上传前 100 个文件**且不报错。
 *
 * @module public/js/upload
 */

import { esc, fmtSize, fmtDate, typeBadge } from './util.js'
import { authHeaders, apiFetch } from './api.js'

/**
 * 单文件大小上限。
 *
 * 100MB 是**分片上传**的上限，不是单次请求的上限 ——
 * Netlify 函数的请求体只有 6MB，超过 4MB 的文件会自动切片传。
 * 再大的文件建议用命令行（`node scripts/ingest.mjs "目录"`，
 * 直写 Blobs，没有这些限制，也不过网络）。
 */
const MAX_BYTES = 100 * 1024 * 1024

/**
 * 分片大小。
 *
 * ★ 必须 ≤ 4MB：Netlify Functions 的请求体上限是 **6MB**，超了平台直接
 * 返回 413，请求根本进不到函数里。这个数字与服务端 CHUNK_SIZE 一致。
 */
const CHUNK_SIZE = 4 * 1024 * 1024

/** 一次最多处理多少个文件（再多请走命令行，那个没有限制）。 */
const MAX_FILES = 500

/** 一次最多处理多少字节。 */
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024

/** 并发上传数。串行 100 个文件太慢，全开又会把浏览器连接数打满。 */
const CONCURRENCY = 3

/** 算哈希的并发数（读文件是 I/O，3 路够用也不至于把磁盘打满）。 */
const HASH_CONCURRENCY = 3

/**
 * 在浏览器本地算文件内容的 SHA-256（16 进制）。
 *
 * `crypto.subtle` 只在**安全上下文**可用（HTTPS 与 localhost/127.0.0.1）。
 * 局域网里用 http://192.168.x.x 打开时就拿不到 —— 那种情况下退化成
 * "全部上传"，功能不受影响，只是失去了"跳过没变的文件"这个优化。
 *
 * @param {File} file - 文件
 * @returns {Promise<string|null>} 十六进制哈希；不可用时返回 null
 */
async function sha256Of(file) {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return null
  try {
    const buf = await file.arrayBuffer()
    const digest = await subtle.digest('SHA-256', buf)
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}

/**
 * 比对哪些文件需要真的上传。
 *
 * @param {Array<{hash:string, path:string}>} files - 待比对
 * @param {string} root - 根目录名（用于报告"库里已有但这次没出现"的文档）
 * @returns {Promise<{items:object[], stats:object, missing:object[]}>} 比对结果
 */
async function checkBatch(files, root) {
  const data = await apiFetch('/api/v1/inbox/check', {
    method: 'POST',
    body: { files, root },
  })
  return data
}

/**
 * 系统/临时垃圾文件名（整目录上传时静默跳过）。
 *
 * 这些不是"用户想存进资料库的东西"，混进来只会让暂存区变成垃圾场。
 */
const NOISE_FILES = new Set([
  'thumbs.db', 'desktop.ini', '.ds_store', '.localized', 'ehthumbs.db',
])

/** 整目录上传时跳过的目录名（含这些名字的整棵子树都不进）。 */
const NOISE_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv',
  '.idea', '.vscode', '.cache', '.npm', '.pnpm-store', '$RECYCLE.BIN',
  'System Volume Information',
])

/**
 * 判断是不是系统垃圾文件。
 * @param {string} name - 文件名
 * @returns {boolean} 是否跳过
 */
function isNoiseFile(name) {
  const base = String(name).toLowerCase()
  if (NOISE_FILES.has(base)) return true
  // Office 的锁文件 / 临时文件：~$草稿.docx、.~lock.xx#
  if (base.startsWith('~$') || base.startsWith('.~lock.')) return true
  if (base.endsWith('.tmp') || base.endsWith('.crdownload') || base.endsWith('.part')) return true
  return false
}

/**
 * 取一批文件的共同根目录名（`合同/2025/xx.pdf` → `合同`）。
 *
 * 只用于「库里这个目录下有什么、这次却没出现」这条报告。
 * 要求所有文件都在同一个根之下，否则返回空串（混着多个目录时不猜）。
 *
 * @param {Array<{relPath:string}>} items - 文件列表
 * @returns {string} 根目录名；无法确定时为空串
 */
function rootOf(items) {
  const roots = new Set()
  for (const it of items) {
    const parts = String(it.relPath ?? '').split('/')
    if (parts.length < 2) return ''   // 有文件不在任何子目录里，不猜
    roots.add(parts[0])
  }
  return roots.size === 1 ? [...roots][0] : ''
}

/**
 * 把 HTTP 失败翻译成人能看懂的话。
 *
 * 这几个状态码背后都是**平台限制**，而不是我们的代码出错，
 * 直接甩一句"响应不是 JSON（HTTP 413）"没有任何指导意义 ——
 * 线上第一次拖大文件进来时，用户看到的就是这句话。
 *
 * @param {number} status - HTTP 状态
 * @param {string} [snippet] - 响应体片段（可能是 HTML）
 * @returns {string} 说明
 */
function explainStatus(status, snippet = '') {
  if (status === 413) {
    return '文件太大，超过了服务端单次请求上限（Netlify 函数 6MB）—— '
      + '应该是分片上传没生效，请刷新页面重试'
  }
  if (status === 401 || status === 403) return '没有上传权限，请先登录'
  if (status === 404) return '上传接口不存在（部署可能不完整）'
  if (status === 429) return '请求太频繁，稍等一下再试'
  if (status === 502 || status === 503 || status === 504) return '服务端超时或暂时不可用，稍后重试'
  if (status >= 500) return `服务端错误（HTTP ${status}）${snippet ? `：${snippet.slice(0, 80)}` : ''}`
  return `HTTP ${status}${snippet ? `：${snippet.slice(0, 80)}` : ''}`
}

/**
 * 读一次响应并转成统一结果。
 *
 * @param {Response} res - 响应
 * @returns {Promise<object>} 业务数据
 */
async function readJsonOrThrow(res) {
  let text = ''
  try {
    text = await res.text()
  } catch {
    /* 读不出来就按状态码解释 */
  }

  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    // 非 JSON：多半是平台的错误页（413 之类）
    throw new Error(explainStatus(res.status, text))
  }

  if (!body?.ok) {
    throw new Error(body?.error?.message ?? explainStatus(res.status))
  }
  return body.data
}

/**
 * 分片上传一个大文件。
 *
 * Netlify 函数的请求体上限是 6MB，超了直接 413（请求进不到我们的代码）。
 * 所以 > 4MB 的文件切成 4MB 一片多次传，服务端按 uploadId 攒起来再合流。
 *
 * @param {File} file - 文件
 * @param {string} relPath - 相对路径
 * @param {(i:number, total:number) => void} [onChunk] - 分片进度回调
 * @returns {Promise<object>} 服务端返回的记录
 */
async function uploadChunked(file, relPath, onChunk) {
  const uploadId = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random()}`)
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 32)
  const total = Math.ceil(file.size / CHUNK_SIZE)

  for (let i = 0; i < total; i++) {
    const blob = file.slice(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, file.size))
    const params = new URLSearchParams({
      uploadId,
      index: String(i),
      total: String(total),
      size: String(file.size),
    })
    // 文件名与路径只需要第一片带上，后续分片服务端从存档里取
    if (i === 0) {
      params.set('name', file.name)
      if (relPath && relPath.includes('/')) params.set('path', relPath)
    }

    onChunk?.(i + 1, total)
    const res = await fetch(`/api/v1/inbox/chunk?${params}`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/octet-stream' },
      body: blob,
    })
    await readJsonOrThrow(res)
  }

  const done = await fetch(`/api/v1/inbox/chunk/complete?uploadId=${uploadId}`, {
    method: 'POST',
    headers: authHeaders(),
  })
  return readJsonOrThrow(done)
}

/**
 * 把单个文件传到暂存区（自动选择整份传还是分片传）。
 *
 * @param {File} file - 浏览器 File 对象
 * @param {string} [relPath] - 相对路径（整目录上传时才有）
 * @param {(i:number, total:number) => void} [onChunk] - 分片进度回调
 * @returns {Promise<object>} 服务端返回的记录
 */
async function uploadOne(file, relPath, onChunk) {
  // 大文件走分片：一次传整份必然撞 6MB 请求体上限
  if (file.size > CHUNK_SIZE) return uploadChunked(file, relPath, onChunk)

  const params = new URLSearchParams({ name: file.name })
  // 只有真的带目录信息时才传 path，单文件上传保持原来的请求形态
  if (relPath && relPath.includes('/')) params.set('path', relPath)

  const res = await fetch(`/api/v1/inbox?${params}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/octet-stream' },
    body: file,
  })

  return readJsonOrThrow(res)
}

/**
 * 递归读完一个目录条目。
 *
 * ★ `readEntries()` 每次只返回一批（Chrome 上限 100），必须循环到
 * 返回空数组。只读一次会静默漏掉后面的文件。
 *
 * @param {object} entry - FileSystemDirectoryEntry
 * @returns {Promise<object[]>} 条目数组
 */
async function readAllEntries(entry) {
  const reader = entry.createReader()
  const out = []
  for (let round = 0; round < 200; round++) {
    const batch = await new Promise((resolve, reject) => {
      reader.readEntries((list) => resolve(list), (err) => reject(err))
    })
    if (!batch || batch.length === 0) break
    out.push(...batch)
  }
  return out
}

/**
 * 递归收集一个条目下的所有文件。
 *
 * @param {object} entry - FileSystemEntry
 * @param {string} prefix - 当前相对路径前缀
 * @param {Array<{file:File, relPath:string, reason?:string}>} out - 输出
 * @returns {Promise<void>} 完成
 */
async function walkEntry(entry, prefix, out) {
  if (!entry) return

  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => {
      entry.file((f) => resolve(f), (err) => reject(err))
    })
    out.push({ file, relPath: prefix ? `${prefix}/${file.name}` : file.name })
    return
  }

  if (!entry.isDirectory) return
  if (NOISE_DIRS.has(entry.name)) return

  const children = await readAllEntries(entry)
  const next = prefix ? `${prefix}/${entry.name}` : entry.name
  for (const child of children) {
    await walkEntry(child, next, out)
  }
}

/**
 * 从拖放事件里收集文件（支持文件夹）。
 *
 * @param {DataTransfer} dt - 拖放数据
 * @returns {Promise<Array<{file:File, relPath:string}>>} 文件列表
 */
async function collectFromDataTransfer(dt) {
  const items = dt.items ? [...dt.items].filter((i) => i.kind === 'file') : []
  const entries = items
    .map((i) => (typeof i.webkitGetAsEntry === 'function' ? i.webkitGetAsEntry() : null))
    .filter(Boolean)

  // 老浏览器没有 webkitGetAsEntry：退化成普通文件列表（文件夹会丢）
  if (entries.length === 0) {
    return [...(dt.files ?? [])].map((f) => ({ file: f, relPath: f.webkitRelativePath || f.name }))
  }

  const out = []
  for (const entry of entries) {
    await walkEntry(entry, '', out)
  }
  return out
}

/**
 * 挂载上传界面。
 *
 * @param {object} opts - { button, folderButton, dropZone, banner, onChange }
 *   button       「上传」按钮（选文件）
 *   folderButton 「传文件夹」按钮（可选；没有就退化成只有拖拽支持文件夹）
 *   dropZone     可拖拽区域（通常是右侧列表盒子）
 *   banner       结果显示区
 *   onChange     暂存区变化后的回调（重新拉清单）
 * @returns {object} 控制器
 */
export function mountUpload(opts) {
  const { button, folderButton, dropZone, banner, onChange } = opts

  // 允许的后缀。accept 只影响文件对话框的默认过滤，
  // **真正的白名单在服务端**（_lib/file-types.mjs 的 EXT_ALIASES）。
  // 代码类必须带上 —— 否则文件对话框里根本选不中 .ts/.py，
  // 用户会以为"不支持代码"。
  const ACCEPT = [
    '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.md', '.markdown', '.txt', '.csv',
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte',
    '.py', '.java', '.kt', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.cs', '.rb', '.php',
    '.swift', '.dart', '.lua', '.r', '.scala', '.groovy',
    '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
    '.sql', '.html', '.css', '.scss', '.less',
    '.json', '.yaml', '.yml', '.toml', '.ini', '.xml', '.conf',
    '.proto', '.graphql', '.tex', '.diff', '.patch',
  ].join(',')

  /** 建一个隐藏的文件选择器。 */
  const makePicker = () => {
    const el = document.createElement('input')
    el.type = 'file'
    el.multiple = true
    el.accept = ACCEPT
    el.style.display = 'none'
    document.body.appendChild(el)
    return el
  }

  const picker = makePicker()

  // 目录选择器：webkitdirectory 会让浏览器把整个目录递归列进 files，
  // 每个 File 上带 webkitRelativePath（`合同/2025/xx.pdf`）
  const dirPicker = makePicker()
  dirPicker.removeAttribute('accept')
  dirPicker.setAttribute('webkitdirectory', '')
  dirPicker.setAttribute('directory', '')
  dirPicker.webkitdirectory = true

  let busy = false
  /** 取消标记（用户可以中途停下）。 */
  let cancelled = false

  /**
   * 把文件列表按「能传 / 不能传」分类。
   * @param {Array<{file:File, relPath:string}>} items - 候选
   * @returns {{ok:Array, unsupported:Array, oversize:Array, noise:Array}} 分类结果
   */
  const classify = (items) => {
    const ok = []
    const unsupported = []
    const oversize = []
    const noise = []

    const isSupported = (name) => {
      const m = /\.([A-Za-z0-9]+)$/.exec(name)
      if (!m) return false
      return ACCEPT.split(',').includes(`.${m[1].toLowerCase()}`)
    }

    for (const it of items) {
      if (isNoiseFile(it.file.name) || it.relPath.split('/').some((p) => NOISE_DIRS.has(p))) {
        noise.push(it)
      } else if (!isSupported(it.file.name)) {
        unsupported.push(it)
      } else if (it.file.size > MAX_BYTES) {
        oversize.push(it)
      } else {
        ok.push(it)
      }
    }
    return { ok, unsupported, oversize, noise }
  }

  /**
   * 处理一批文件（含整目录）。
   *
   * @param {Array<{file:File, relPath:string}>} items - 文件
   * @param {string} [sourceLabel] - 来源说明（如「文件夹 合同/」）
   * @returns {Promise<{uploaded:number, failed:number, skipped:object, cancelled:boolean}>} 结果摘要
   */
  async function handleFiles(items, sourceLabel = '') {
    if (busy) {
      banner.innerHTML = '<div class="banner warn">上一批还在上传，等它结束再试。</div>'
      return { uploaded: 0, failed: 0, skipped: {}, cancelled: false, busy: true }
    }
    if (items.length === 0) return { uploaded: 0, failed: 0, skipped: {}, cancelled: false }

    const { ok, unsupported, oversize, noise } = classify(items)

    // 体积/数量上限：明确拒绝，而不是传到一半失败
    let total = ok.reduce((a, it) => a + it.file.size, 0)
    let queue = ok
    let clipped = false
    if (queue.length > MAX_FILES) {
      queue = queue.slice(0, MAX_FILES)
      clipped = true
      total = queue.reduce((a, it) => a + it.file.size, 0)
    }
    if (total > MAX_TOTAL_BYTES) {
      clipped = true
    }

    const skipLines = []
    if (unsupported.length) {
      const exts = [...new Set(unsupported.map((it) => {
        const m = /\.([A-Za-z0-9]+)$/.exec(it.file.name)
        return m ? `.${m[1].toLowerCase()}` : '(无扩展名)'
      }))]
      skipLines.push(`跳过 ${unsupported.length} 个不支持的类型（${exts.slice(0, 8).join(' ')}${exts.length > 8 ? ' …' : ''}）`)
    }
    if (oversize.length) {
      skipLines.push(`跳过 ${oversize.length} 个超过 ${MAX_BYTES / 1024 / 1024}MB 的文件：${
        oversize.slice(0, 5).map((it) => esc(it.file.name)).join('、')}${oversize.length > 5 ? ' …' : ''}`)
    }
    if (noise.length) {
      skipLines.push(`跳过 ${noise.length} 个系统/临时文件（Thumbs.db、~$ 锁文件、node_modules 等）`)
    }
    if (clipped) {
      skipLines.push(`本次最多处理 ${MAX_FILES} 个文件 / ${(MAX_TOTAL_BYTES / 1024 / 1024 / 1024).toFixed(0)}GB，其余请分批或改用命令行`)
    }

    if (queue.length === 0) {
      banner.innerHTML = `<div class="banner warn">
        <b>没有可上传的文件</b>${sourceLabel ? `（${esc(sourceLabel)}）` : ''}
        ${skipLines.map((l) => `<br>· ${l}`).join('')}
        <br><br>更大的文件或整批大量文件请用命令行：
        <code>node scripts/ingest.mjs "目录"</code>
      </div>`
      return {
        uploaded: 0,
        failed: 0,
        cancelled: false,
        skipped: {
          unsupported: unsupported.length,
          oversize: oversize.length,
          noise: noise.length,
          clipped,
        },
      }
    }

    busy = true
    cancelled = false
    button.disabled = true
    if (folderButton) folderButton.disabled = true

    /**
     * 刷新进度。
     * @param {string} phase - 阶段说明
     * @param {number} n - 已完成
     * @param {number} of - 总数
     * @param {string} current - 当前文件
     */
    const showProgress = (phase, n, of, current) => {
      const pct = of ? Math.round((n / of) * 100) : 0
      banner.innerHTML = `<div class="banner info">
        <b>${phase} ${n}/${of}</b>
        ${sourceLabel ? `<span class="dim">（${esc(sourceLabel)}）</span>` : ''}
        <div class="up-progress"><i style="width:${pct}%"></i></div>
        <span class="dim">${esc(current ?? '')}</span>
        ${skipLines.length ? `<div class="dim" style="margin-top:4px">${skipLines.join('；')}</div>` : ''}
        <div style="margin-top:6px"><button class="btn ghost" id="up-cancel">停止</button></div>
      </div>`
      document.getElementById('up-cancel')?.addEventListener('click', () => {
        cancelled = true
        banner.innerHTML = '<div class="banner warn">正在停止…（已上传的文件会保留在暂存区）</div>'
      })
    }

    /* ---------- 阶段一：本地算哈希，问服务端哪些真的需要传 ---------- */
    //
    // 这是「增量同步」的关键：整个文件夹重传一遍是浪费，几百份文件里可能
    // 只改了两个。内容有没有变只有哈希说了算，而哈希可以在**本地**算
    // （crypto.subtle，一个字节都不上传），再拿结果去比对。
    //
    // 拿不到 crypto.subtle（局域网里用 http:// 打开）时不做比对，
    // 退化成"全部上传"—— 入库仍会按内容去重，只是白传一遍。
    let plan = null
    let hashNote = ''

    if (queue.length > 0) {
      const hashes = new Array(queue.length).fill(null)
      let hDone = 0
      let hCursor = 0

      const hashWorker = async () => {
        for (;;) {
          const idx = hCursor
          hCursor += 1
          if (idx >= queue.length) return
          hashes[idx] = await sha256Of(queue[idx].file)
          hDone += 1
          if (hDone % 5 === 0 || hDone === queue.length) {
            showProgress('正在校验内容（不会上传）', hDone, queue.length, queue[idx].relPath)
          }
        }
      }

      showProgress('正在校验内容（不会上传）', 0, queue.length, queue[0].relPath)
      await Promise.all(Array.from({ length: Math.min(HASH_CONCURRENCY, queue.length) }, hashWorker))

      if (cancelled) {
        busy = false
        button.disabled = false
        if (folderButton) folderButton.disabled = false
        banner.innerHTML = '<div class="banner warn">已停止（还没上传任何文件）。</div>'
        return { uploaded: 0, failed: 0, cancelled: true, skipped: {}, planned: null }
      }

      if (hashes.every(Boolean)) {
        try {
          plan = await checkBatch(
            queue.map((it, i) => ({ hash: hashes[i], path: it.relPath })),
            rootOf(queue),
          )
        } catch (err) {
          hashNote = `（内容比对失败，已改为全部上传：${err.message}）`
        }
      } else {
        hashNote = '（当前环境不支持本地算哈希，已改为全部上传）'
      }
    }

    // 只上传服务端说「需要」的那些
    let toSend = queue
    let planStats = null
    if (plan) {
      const send = []
      const counters = { new: 0, replace: 0, unchanged: 0, pending: 0 }
      plan.items.forEach((r, i) => {
        counters[r.status] = (counters[r.status] ?? 0) + 1
        if (r.status === 'new' || r.status === 'replace') send.push(queue[i])
      })
      toSend = send
      planStats = { ...counters, missing: plan.missing ?? [] }
    }

    /* ---------- 阶段二：真正上传 ---------- */
    const results = []
    let done = 0

    // 并发上传：慢的是网络往返，串行 100 个文件会让人一直干等
    let cursor = 0
    const worker = async () => {
      for (;;) {
        if (cancelled) return
        const idx = cursor
        cursor += 1
        if (idx >= toSend.length) return
        const it = toSend[idx]
        try {
          const rec = await uploadOne(it.file, it.relPath, (i, total) => {
            // 单个大文件要传好几个分片，进度条得让用户看到它在动
            if (total > 1) showProgress(`正在上传（分片 ${i}/${total}）`, done, toSend.length, it.relPath)
          })
          results.push({ item: it, rec, error: null })
        } catch (err) {
          results.push({ item: it, rec: null, error: String(err?.message ?? err) })
        }
        done += 1
        showProgress('正在上传', done, toSend.length, it.relPath)
      }
    }

    if (toSend.length > 0) {
      showProgress('正在上传', 0, toSend.length, toSend[0].relPath)
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, toSend.length) }, worker))
    }

    busy = false
    button.disabled = false
    if (folderButton) folderButton.disabled = false

    const failed = results.filter((r) => r.error)
    const doneOk = results.filter((r) => !r.error)
    const dupInLib = doneOk.filter((r) => r.rec.alreadyInLibrary)
    const dupPending = doneOk.filter((r) => r.rec.alreadyPending && !r.rec.alreadyInLibrary)

    // 暂存区在哪，取决于你是从本地 dev-server 还是线上站点上传的
    const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname)
    const stagingName = isLocal
      ? '本地暂存区 .local-data/doc-inbox/'
      : '线上暂存区（Netlify Blobs）'
    const stagingHint = isLocal
      ? '本地暂存区直接读得到，不需要额外配置。'
      : '线上暂存区需要在项目根目录的 .env 里配好 DOCS_STORE_MODE=remote、SITE_ID 与 NETLIFY_ACCESS_TOKEN。'

    // 增量同步的结果汇总：说清「新增多少、替换多少、跳过了什么」
    const planLines = []
    if (planStats) {
      const bits = []
      if (planStats.new) bits.push(`新增 ${planStats.new}`)
      if (planStats.replace) bits.push(`替换 ${planStats.replace}（入库时删旧迎新）`)
      if (planStats.unchanged) bits.push(`未变 ${planStats.unchanged}（库里已有同内容，跳过上传）`)
      if (planStats.pending) bits.push(`暂存区已有 ${planStats.pending}`)
      // ★ 写成「本次比对」而不是光秃秃的「新增 3」：
      // 上传失败时，"已上传 2/3" 与 "新增 3" 并排会让人以为成功了 3 个
      if (bits.length) planLines.push(`本次比对 —— ${bits.join('　·　')}`)
    } else if (hashNote) {
      planLines.push(hashNote)
    }
    if (planStats?.missing?.length) {
      const sample = planStats.missing.slice(0, 5).map((m) => esc(m.path)).join('、')
      planLines.push(
        `库里另有 ${planStats.missing.length} 份文档在这个目录下、但这次没出现（可能被删或改名，不会自动删除）：`
        + `${sample}${planStats.missing.length > 5 ? ' …' : ''}`,
      )
    }

    const nothingToSend = toSend.length === 0

    banner.innerHTML = `<div class="banner ${failed.length || cancelled ? 'warn' : 'info'}">
      <b>${nothingToSend
    ? `不需要上传：${queue.length} 个文件都已是最新`
    : `成功上传 ${doneOk.length} / ${toSend.length} 个文件（本次共检查 ${queue.length} 个）`}</b>
      ${cancelled ? '<br>· 已按你的要求停止，剩余文件没有上传' : ''}
      ${planLines.map((l) => `<br>· ${l}`).join('')}
      ${skipLines.map((l) => `<br>· ${l}`).join('')}
      ${failed.length ? `<br>✗ ${failed.length} 个上传失败：` : ''}
      ${failed.slice(0, 8).map((r) => `<br>　✗ ${esc(r.item.relPath)}：${esc(r.error)}`).join('')}
      ${failed.length > 8 ? `<br>　✗ 另有 ${failed.length - 8} 个失败` : ''}
      ${dupInLib.length ? `<br>· ${dupInLib.length} 个库里已有同样内容，入库时会自动去重` : ''}
      ${dupPending.length ? `<br>· ${dupPending.length} 个暂存区已有同样内容` : ''}
      ${nothingToSend ? '' : `<br><br>尚未入库，在本地运行 <code>node scripts/process-pending.mjs</code>
      <button class="tip" type="button" data-tip="文件已存进${esc(stagingName)}。&#10;${esc(stagingHint)}&#10;重排、抽正文、Office 转 PDF、分类打标这些重活只能在本地跑。&#10;已改动的文件会按路径替换旧版本，不会变成两份。">?</button>`}
      <br><br><button class="btn ghost" id="up-dismiss">知道了</button>
    </div>`

    document.getElementById('up-dismiss')?.addEventListener('click', () => {
      banner.innerHTML = ''
    })

    onChange?.()

    return {
      uploaded: doneOk.length,
      failed: failed.length,
      cancelled,
      planned: planStats,
      checked: queue.length,
      toSend: toSend.length,
      skipped: {
        unsupported: unsupported.length,
        oversize: oversize.length,
        noise: noise.length,
        clipped,
      },
    }
  }

  /**
   * 处理一次拖放（含文件夹递归）。
   *
   * 单独暴露出来，一是让 drop 监听器保持一行，二是测试可以直接
   * await 它拿到结果 —— 目录递归那 250 个条目到底收全没有，
   * 只有这样才能断言。
   *
   * @param {DataTransfer} dt - 拖放数据
   * @returns {Promise<object>} 结果摘要
   */
  async function handleDataTransfer(dt) {
    const items = await collectFromDataTransfer(dt).catch(() => [])
    if (items.length === 0) {
      banner.innerHTML = '<div class="banner warn">没有读到任何文件；文件夹请用「传文件夹」按钮选。</div>'
      return { uploaded: 0, failed: 0, cancelled: false, skipped: {}, empty: true }
    }
    const roots = [...new Set(items.map((it) => it.relPath.split('/')[0]))]
    const label = roots.length === 1 && items.some((it) => it.relPath.includes('/'))
      ? `文件夹 ${roots[0]}/`
      : ''
    return handleFiles(items, label)
  }

  // ---- 选文件 ----
  button.addEventListener('click', () => picker.click())
  picker.addEventListener('change', () => {
    handleFiles([...picker.files].map((f) => ({
      file: f,
      relPath: f.webkitRelativePath || f.name,
    })))
    picker.value = ''   // 允许再次选同一文件
  })

  // ---- 选文件夹 ----
  if (folderButton) {
    folderButton.addEventListener('click', () => dirPicker.click())
    dirPicker.addEventListener('change', () => {
      const files = [...dirPicker.files]
      const rootDir = files[0]?.webkitRelativePath?.split('/')[0] ?? '文件夹'
      handleFiles(
        files.map((f) => ({ file: f, relPath: f.webkitRelativePath || f.name })),
        `文件夹 ${rootDir}/`,
      )
      dirPicker.value = ''
    })
  }

  // ---- 拖拽（支持文件夹）----
  let depth = 0
  const showDrop = (on) => dropZone.classList.toggle('dropping', on)

  const hasFiles = (e) => {
    const types = e.dataTransfer?.types ?? []
    return types.includes('Files')
  }

  dropZone.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    depth += 1
    showDrop(true)
  })
  dropZone.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  })
  dropZone.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1)
    if (depth === 0) showDrop(false)
  })
  dropZone.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    depth = 0
    showDrop(false)
    // ★ 文件夹的 drop 里 dataTransfer.files 往往是空的，必须走 items + 递归
    handleDataTransfer(e.dataTransfer)
  })

  return { picker, dirPicker, handleFiles, handleDataTransfer }
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
      <code>node scripts/process-pending.mjs</code>
      <button class="tip" type="button" data-tip="上传只把原件存进暂存区；重排、抽正文、转 PDF、分类打标都要在本地跑这条命令完成。&#10;已改动的文件会按路径替换旧版本，不会变成两份。">?</button>
    </div>
    <div class="pending-list">
      ${data.items.map((it) => `
        <div class="pending-item" data-id="${esc(it.id)}">
          ${typeBadge(it.type, it.ext)}
          <div class="pending-main">
            <div class="pending-title">${esc(it.title)}</div>
            <div class="pending-meta">
              ${it.relativePath ? `<span class="pending-path" title="${esc(it.relativePath)}">${esc(it.relativePath)}</span><i>·</i>` : ''}
              ${fmtSize(it.size)}<i>·</i>${fmtDate(it.uploadedAt)}
            </div>
          </div>
          <button class="pending-del" data-del="${esc(it.id)}" aria-label="从暂存区移除">移除</button>
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
