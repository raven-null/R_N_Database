/**
 * 列表页逻辑：加载全库清单 → 本地即时筛选 → 可选服务端全文检索。
 *
 * 设计取舍：**筛选与即时搜索走本地**（manifest 一次拉全库），
 * 只有在需要查正文时（点「全文检索」或按回车）才打 `/api/v1/search`。
 * 个人库规模下这样输入毫无延迟，也几乎不消耗函数调用。
 *
 * @module public/js/list
 */

import { loadManifest, searchDocs, clearManifestCache, ApiError } from './api.js'
import { fetchAuthStatus, login, setToken, clearToken, getToken } from './auth.js'
import { esc, fmtSize, fmtDate, typeBadge, debounce, looksLikePinyin, matchesPinyin } from './util.js'

/** 应用状态。 */
const state = {
  manifest: null,
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

    ${tags.length ? `
    <section class="facet">
      <h3>标签</h3>
      <div class="chips">
        ${tags.map(([name, n]) => chip(name, n, state.tag === name, `data-facet="tag" data-value="${esc(name)}"`)).join('')}
      </div>
    </section>` : ''}
  `

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

  return `
    <a class="doc" href="/view.html?id=${encodeURIComponent(doc.id)}">
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
      <span class="go">打开 →</span>
    </a>`
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
      <a class="doc deep" href="/view.html?id=${encodeURIComponent(it.id)}${state.q ? `&q=${encodeURIComponent(state.q)}` : ''}">
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
      </a>`).join('')
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
    el.stats.textContent = `全文检索 · ${state.deepResult.total} 条`
    return
  }

  const filtered = applyFilters(docs)

  if (filtered.length === 0) {
    el.results.innerHTML = docs.length === 0
      ? `<div class="empty">资料库还是空的。<br>
          <span class="dim">把文档放进 <code>inbox/</code>，然后运行：</span>
          <pre class="cmd">node scripts/ingest.mjs</pre></div>`
      : `<div class="empty">没有符合当前筛选条件的文档。<br>
          <span class="dim">试试清空筛选条件。</span></div>`
    el.stats.textContent = `0 / ${docs.length} 份`
    return
  }

  const shown = filtered.slice(0, state.limit)
  el.results.innerHTML = shown.map(docRow).join('')
    + (filtered.length > shown.length
      ? `<button class="more" id="more">还有 ${filtered.length - shown.length} 份，点击加载更多</button>`
      : '')

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
 */
async function renderAuth() {
  const status = await fetchAuthStatus()
  state.auth = status

  if (status.failClosed) {
    el.banner.innerHTML = `<div class="banner error">
      服务端尚未配置访问密码，已拒绝所有访问。<br>
      <span class="dim">这是刻意的 fail-closed 设计：私有资料库在未设密码时应当拒绝访问，而不是敞开。
      请在部署环境设置 ADMIN_TOKEN。</span>
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

  if (el.banner.querySelector('.banner.error')) {
    // fail-closed 时不必再去拉清单
    el.results.innerHTML = '<div class="empty">等待配置访问密码。</div>'
    return
  }

  try {
    state.manifest = await loadManifest()
  } catch (err) {
    if (err instanceof ApiError && err.code === 'UNAUTHORIZED') {
      el.results.innerHTML = `<div class="empty">需要登录才能查看资料库。<br>
        <span class="dim">点击右上角「登录」输入访问密码。</span></div>`
      return
    }
    el.results.innerHTML = `<div class="empty">加载失败：${esc(err.message)}</div>`
    return
  }

  render()
}

main()
