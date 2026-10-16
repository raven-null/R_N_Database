/**
 * 列表页逻辑：加载全库清单 → 本地即时筛选 → 可选服务端全文检索。
 *
 * 设计取舍：**筛选与即时搜索走本地**（manifest 一次拉全库），
 * 只有在需要查正文时（点「全文检索」或按回车）才打 `/api/v1/search`。
 * 个人库规模下这样输入毫无延迟，也几乎不消耗函数调用。
 *
 * @module public/js/list
 */

import { loadManifest, searchDocs, clearManifestCache, ApiError, fetchTaxonomy, apiFetch } from './api.js'
import { fetchAuthStatus, login, setToken, clearToken, getToken } from './auth.js'
import { esc, fmtSize, fmtDate, typeBadge, debounce, looksLikePinyin, matchesPinyin } from './util.js'
import { mountSelect } from './select.js'
import { mountUpload, renderPending } from './upload.js'
import { openQuickTag, openTagManager } from './tags.js'

/** 应用状态。 */
const state = {
  manifest: null,
  taxonomy: null,
  category: '',
  tag: '',
  type: '',
  reviewOnly: false,
  q: '',
  deep: false,
  deepResult: null,
  sort: 'recent',
  limit: 60,
  auth: null,
}

/** 多选控制器（main 里创建）。 */
let sel = null

const SORTERS = {
  recent: (a, b) => String(b.ingestedAt ?? '').localeCompare(String(a.ingestedAt ?? '')),
  oldest: (a, b) => String(a.ingestedAt ?? '').localeCompare(String(b.ingestedAt ?? '')),
  title: (a, b) => String(a.title ?? '').localeCompare(String(b.title ?? ''), 'zh-CN'),
  size: (a, b) => (b.size ?? 0) - (a.size ?? 0),
}

const el = {
  search: document.getElementById('search'),
  sort: document.getElementById('sort'),
  facets: document.getElementById('facets'),
  results: document.getElementById('results'),
  stats: document.getElementById('stats'),
  authArea: document.getElementById('auth-area'),
  banner: document.getElementById('banner'),
  pending: document.getElementById('pending'),
  selbar: document.getElementById('selbar'),
  btnSelect: document.getElementById('btn-select'),
  btnUpload: document.getElementById('btn-upload'),
}

/* ============================================================
   筛选
   ============================================================ */

/**
 * 按当前筛选条件过滤文档。
 * @param {object[]} docs - 全部文档
 * @returns {object[]} 过滤后的文档
 */
function applyFilters(docs) {
  let out = docs

  if (state.category) out = out.filter((d) => (d.categories ?? []).includes(state.category))
  if (state.tag) out = out.filter((d) => (d.tags ?? []).includes(state.tag))
  if (state.type) out = out.filter((d) => d.type === state.type)
  if (state.reviewOnly) out = out.filter((d) => d.needsReview)

  const q = state.q.trim().toLowerCase()
  if (q) {
    // 拼音：纯 ASCII 查询额外匹配元数据里预算好的拼音串（jlxz → 简历第一版）
    const pinyin = looksLikePinyin(q)
    out = out.filter((d) => {
      if (pinyin && matchesPinyin(d, q)) return true
      return [
        d.title, d.originalName, d.summary, d.author,
        ...(d.tags ?? []), ...(d.categories ?? []),
      ].filter(Boolean).join(' ').toLowerCase().includes(q)
    })
  }

  return [...out].sort(SORTERS[state.sort] ?? SORTERS.recent)
}

/* ============================================================
   渲染
   ============================================================ */

/**
 * 渲染侧边栏分类与标签。
 * @param {object[]} docs - 全部文档
 */
function renderFacets(docs) {
  const catCount = {}
  const tagCount = {}
  const typeCount = {}

  for (const d of docs) {
    for (const c of d.categories ?? []) catCount[c] = (catCount[c] ?? 0) + 1
    for (const t of d.tags ?? []) tagCount[t] = (tagCount[t] ?? 0) + 1
    typeCount[d.type] = (typeCount[d.type] ?? 0) + 1
  }

  const catOrder = state.manifest?.taxonomy?.categories?.map((c) => c.name) ?? []
  const cats = Object.entries(catCount)
    .sort((a, b) => {
      const ia = catOrder.indexOf(a[0])
      const ib = catOrder.indexOf(b[0])
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib)
      return b[1] - a[1]
    })

  const chip = (label, count, active, attrs) =>
    `<button class="chip${active ? ' active' : ''}" ${attrs}>${esc(label)}<span class="n">${count}</span></button>`

  const tags = Object.entries(tagCount).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))

  const reviewCount = docs.filter((d) => d.needsReview).length

  el.facets.innerHTML = `
    <section class="facet">
      <h3>分类</h3>
      <div class="chips">
        ${chip('全部', docs.length, !state.category, 'data-facet="category" data-value=""')}
        ${cats.map(([name, n]) => chip(name, n, state.category === name, `data-facet="category" data-value="${esc(name)}"`)).join('')}
      </div>
    </section>

    ${reviewCount > 0 ? `
    <section class="facet">
      <h3>待处理</h3>
      <div class="chips">
        ${chip('需要复查', reviewCount, state.reviewOnly, 'data-facet="review" data-value="1"')}
      </div>
    </section>` : ''}

    <section class="facet">
      <h3>格式</h3>
      <div class="chips">
        ${Object.entries(typeCount).sort((a, b) => b[1] - a[1])
          .map(([t, n]) => chip(t.toUpperCase(), n, state.type === t, `data-facet="type" data-value="${esc(t)}"`)).join('')}
      </div>
    </section>

    <section class="facet">
      <h3>标签 <button class="facet-act" id="btn-tags" title="重命名 / 合并 / 删除标签">管理</button></h3>
      <div class="chips">
        ${tags.length
          ? tags.map(([name, n]) => chip(name, n, state.tag === name, `data-facet="tag" data-value="${esc(name)}"`)).join('')
          : '<span class="dim">还没有标签</span>'}
      </div>
    </section>
  `

  el.facets.querySelector('#btn-tags')?.addEventListener('click', () => {
    openTagManager({ onChanged: () => refreshManifest() })
  })

  el.facets.querySelectorAll('[data-facet]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.facet
      const value = btn.dataset.value
      if (kind === 'category') state.category = state.category === value ? '' : value
      else if (kind === 'tag') state.tag = state.tag === value ? '' : value
      else if (kind === 'type') state.type = state.type === value ? '' : value
      else if (kind === 'review') state.reviewOnly = !state.reviewOnly
      render()
    })
  })
}

/**
 * 渲染一条文档列表项。
 * @param {object} doc - 文档元数据
 * @returns {string} HTML
 */
function docRow(doc) {
  const tags = (doc.tags ?? []).slice(0, 5)
    .map((t) => `<span class="tag">${esc(t)}</span>`).join('')

  const pages = doc.pages ? `${doc.pages} 页` : ''
  const metaBits = [
    fmtSize(doc.size),
    pages,
    doc.author ? esc(doc.author) : '',
    fmtDate(doc.docCreatedAt || doc.ingestedAt),
  ].filter(Boolean)

  const selecting = sel?.isActive()
  const checked = selecting && sel.has(doc.id)

  return `
    <div class="doc${checked ? ' picked' : ''}" data-id="${esc(doc.id)}">
      ${selecting ? `<label class="doc-check"><input type="checkbox" data-check="${esc(doc.id)}"${checked ? ' checked' : ''}></label>` : ''}
      <a class="doc-link" href="/view.html?id=${encodeURIComponent(doc.id)}">
        ${typeBadge(doc.type)}
        <div class="doc-main">
          <div class="doc-title">${esc(doc.title)}${doc.needsReview ? '<span class="flag">待复查</span>' : ''}</div>
          ${doc.summary ? `<div class="doc-summary">${esc(doc.summary)}</div>` : ''}
          <div class="doc-meta">
            ${metaBits.map((b) => `<span>${b}</span>`).join('<i>·</i>')}
            ${(doc.categories ?? []).length ? `<i>·</i><span class="cats">${doc.categories.map(esc).join(' / ')}</span>` : ''}
          </div>
          ${tags ? `<div class="doc-tags">${tags}</div>` : ''}
        </div>
      </a>
      <button class="quick-tag" data-quick="${esc(doc.id)}" title="快速打标签">＋标签</button>
      <span class="go">打开 →</span>
    </div>`
}

/**
 * 渲染服务器全文检索结果。
 * @param {object} result - /api/v1/search 的返回
 * @returns {string} HTML
 */
function renderDeepResults(result) {
  if (!result.items?.length) {
    return `<div class="empty">全文检索没有命中「${esc(result.query)}」的正文。<br>
      <span class="dim">换个词试试，或用左侧分类浏览。</span></div>`
  }

  return `<div class="deep-note">全文检索「${esc(result.query)}」命中 ${result.total} 份（含正文）</div>`
    + result.items.map((it) => `
      <div class="doc deep" data-id="${esc(it.id)}">
        <a class="doc-link" href="/view.html?id=${encodeURIComponent(it.id)}${state.q ? `&q=${encodeURIComponent(state.q)}` : ''}">
          ${typeBadge(it.type)}
          <div class="doc-main">
            <div class="doc-title">${esc(it.title)}</div>
            ${it.snippet ? `<div class="doc-summary snippet">${esc(it.snippet)}</div>` : ''}
            <div class="doc-meta">
              <span>相关度 ${it.score}</span>
              ${it.hitPage ? `<i>·</i><span>命中第 ${it.hitPage} 页</span>` : ''}
              ${(it.categories ?? []).length ? `<i>·</i><span class="cats">${it.categories.map(esc).join(' / ')}</span>` : ''}
              ${it.matched?.length ? `<i>·</i><span class="dim">命中词：${it.matched.map(esc).join(' ')}</span>` : ''}
            </div>
          </div>
          <span class="go">打开 →</span>
        </a>
      </div>`).join('')
}

/**
 * 给渲染出来的卡片绑定交互。
 *
 * 每轮渲染后都要重新绑 —— innerHTML 会把旧节点连同监听器一起换掉。
 * @param {object[]} docs - 本轮渲染的文档（用于快速打标签取元数据）
 */
function bindCards(docs) {
  const byId = new Map(docs.map((d) => [d.id, d]))

  el.results.querySelectorAll('[data-check]').forEach((cb) => {
    cb.addEventListener('change', () => sel?.toggle(cb.dataset.check))
  })

  el.results.querySelectorAll('[data-quick]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const doc = byId.get(btn.dataset.quick)
      if (!doc) return
      openQuickTag(doc, btn, {
        // 建议 = 词表里已有的标签，按使用频次排序，避免用户手打同义词
        suggestions: (state.taxonomy?.tags ?? []).map((t) => t.name),
        onChanged: () => refreshManifest(),
      })
    })
  })

  // 选择模式下点卡片 = 勾选，而不是打开
  if (sel?.isActive()) {
    el.results.querySelectorAll('.doc').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.quick-tag') || e.target.closest('input')) return
        e.preventDefault()
        sel.toggle(card.dataset.id)
      })
    })
  }
}

/**
 * 重新拉清单并重画（元数据被改过之后）。
 *
 * 不整页刷新：批量打标签后连着改几轮都不该丢滚动位置与筛选条件。
 * @returns {Promise<void>} 完成
 */
async function refreshManifest() {
  try {
    state.manifest = await loadManifest({ force: true })
  } catch {
    return
  }
  render()
}

/**
 * 渲染整个页面。
 */
function render() {
  if (!state.manifest) return
  const docs = state.manifest.docs ?? []

  renderFacets(docs)

  if (state.deep && state.deepResult) {
    el.results.innerHTML = renderDeepResults(state.deepResult)
    bindCards(state.deepResult.items ?? [])
    el.stats.textContent = `全文检索 · ${state.deepResult.total} 条`
    return
  }

  const filtered = applyFilters(docs)

  if (filtered.length === 0) {
    el.results.innerHTML = docs.length === 0
      ? `<div class="empty">资料库还是空的。<br>
          <span class="dim">点右上角「上传」传文件，或把文档放进 <code>inbox/</code> 后跑：</span>
          <pre class="cmd">node scripts/ingest.mjs</pre></div>`
      : `<div class="empty">没有符合当前筛选条件的文档。<br>
          <span class="dim">试试清空筛选条件。</span></div>`
    el.stats.textContent = `0 / ${docs.length} 份`
    sel?.setVisible([])
    return
  }

  const shown = filtered.slice(0, state.limit)
  el.results.innerHTML = shown.map(docRow).join('')
    + (filtered.length > shown.length
      ? `<button class="more" id="more">还有 ${filtered.length - shown.length} 份，点击加载更多</button>`
      : '')

  // 告诉多选模块「本页可见的是哪些」，供「全选本页」用
  sel?.setVisible(shown.map((d) => d.id))
  bindCards(shown)

  el.stats.textContent = filtered.length === docs.length
    ? `${docs.length} 份文档`
    : `${filtered.length} / ${docs.length} 份`

  const more = document.getElementById('more')
  if (more) {
    more.addEventListener('click', () => {
      state.limit += 60
      render()
    })
  }
}

/* ============================================================
   鉴权 UI
   ============================================================ */

/**
 * 渲染登录状态区。
 *
 * 未登录**不再阻断浏览** —— 未登录访客是 guest 角色，只能看到
 * 显式标记为「公开」的文档（默认全部私有，所以通常什么也看不到）。
 * 上传与修改才需要登录。这里用一条不挡路的提示说清楚现状。
 */
async function renderAuth() {
  const status = await fetchAuthStatus()
  state.auth = status

  // 线上未配密码：不是「全站拒绝」，而是「只能看公开文档 + 谁都不能上传」
  if (!status.configured) {
    el.banner.innerHTML = `<div class="banner warn">
      服务端尚未配置访问密码。<br>
      <span class="dim">现在未登录访客只能看到标记为「公开」的文档（默认全部私有，
      所以可能什么也没有），且任何人都无法上传或修改。
      要启用完整功能，请在 Netlify 环境变量里设置 ADMIN_TOKEN 后<b>重新部署</b>。</span>
    </div>`
  }

  if (status.authenticated) {
    // 只留「退出」。之前还有个显示当前角色的 admin 徽标，
    // 单人使用下它不提供任何可操作信息，纯占位。
    el.authArea.innerHTML = `<button class="btn ghost" id="logout">退出</button>`
    document.getElementById('logout').addEventListener('click', () => {
      clearToken()
      clearManifestCache()
      location.reload()
    })
  } else {
    el.authArea.innerHTML = `<button class="btn" id="showlogin">登录</button>`
    document.getElementById('showlogin').addEventListener('click', showLoginDialog)
  }
}

/**
 * 弹出密码输入框。
 */
function showLoginDialog() {
  const token = prompt('请输入访问密码：', '')
  if (token === null) return

  login(token).then((r) => {
    if (!r.ok) {
      alert(`登录失败：${r.error}`)
      return
    }
    setToken(token)
    clearManifestCache()
    location.reload()
  })
}

/* ============================================================
   启动
   ============================================================ */

/**
 * 深度全文检索。
 */
async function runDeepSearch() {
  const q = state.q.trim()
  if (!q) {
    state.deep = false
    state.deepResult = null
    render()
    return
  }
  state.deep = true
  el.results.innerHTML = '<div class="empty">正在检索正文…</div>'
  try {
    state.deepResult = await searchDocs(q, { limit: 50 })
  } catch (err) {
    state.deepResult = { query: q, total: 0, items: [], error: err.message }
    el.results.innerHTML = `<div class="empty">检索失败：${esc(err.message)}</div>`
    return
  }
  render()
}

/**
 * 初始化。
 */
async function main() {
  await renderAuth()

  // ---- 词表（「改分类」下拉与标签建议都要用）----
  state.taxonomy = await fetchTaxonomy().catch(() => null)

  // ---- 多选与批量操作 ----
  sel = mountSelect({
    bar: el.selbar,
    taxonomy: state.taxonomy,
    onChange: () => render(),
  })

  el.btnSelect.addEventListener('click', () => {
    if (sel.isActive()) sel.exit()
    else sel.enter()
    el.btnSelect.classList.toggle('active', sel.isActive())
    el.btnSelect.textContent = sel.isActive() ? '退出选择' : '选择'
  })

  el.search.addEventListener('input', debounce(() => {
    state.q = el.search.value
    state.deep = false
    state.deepResult = null
    state.limit = 60
    render()
  }, 150))

  // 回车 = 全文检索（查正文）
  el.search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      state.q = el.search.value
      runDeepSearch()
    }
  })

  el.sort.addEventListener('change', () => {
    state.sort = el.sort.value
    render()
  })

  // ---- 上传（两阶段的第一阶段：只把原件存进暂存区）----
  // 上传是唯一需要登录的日常操作。未登录时不去挂上传逻辑，
  // 而是点一下直接引导登录 —— 比让他选完文件再吃 403 友好得多。
  const canWrite = state.auth?.authenticated === true
  if (canWrite) {
    mountUpload({
      button: el.btnUpload,
      dropZone: el.results.closest('.main') ?? el.results,
      banner: el.banner,
      onChange: () => renderPendingList(),
    })
    renderPendingList()
  } else {
    el.btnUpload.addEventListener('click', () => {
      if (confirm('上传需要登录。现在去登录？')) showLoginDialog()
    })
    el.btnUpload.title = '上传需要登录'
  }

  try {
    state.manifest = await loadManifest()
  } catch (err) {
    if (err instanceof ApiError && err.code === 'UNAUTHORIZED') {
      el.results.innerHTML = `<div class="empty">需要访问令牌。<br>
        <span class="dim">点击右上角「登录」输入访问密码。</span></div>`
      return
    }
    el.results.innerHTML = `<div class="empty">加载失败：${esc(err.message)}</div>`
    return
  }

  render()

  // 未登录时说明「你看到的是公开文档」，避免误以为资料丢了
  if (!canWrite) {
    el.stats.textContent += '　·　未登录，只显示已标记公开的文档'
  }
}

/**
 * 刷新右侧盒子顶部的待入库清单。
 * @returns {Promise<void>} 完成
 */
async function renderPendingList() {
  await renderPending(el.pending, {
    onChange: () => { /* 移除后自己会重画 */ },
  })
}

main()
