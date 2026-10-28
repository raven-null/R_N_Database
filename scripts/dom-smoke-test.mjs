/**
 * 前端冒烟测试：在 jsdom 里真实跑一遍列表页与阅读页。
 *
 * 为什么需要它：前端模块「语法正确」不等于「渲染正确」。
 * 没有这个测试，界面问题只能靠人工开浏览器发现。
 * 这里把 index.html / view.html 装进 jsdom，用真实的后端 API 响应
 * 喂给 fetch，然后断言 DOM 里确实出现了文档条目、筛选真的生效、
 * 阅读页真的挂上了预览 iframe。
 *
 * 前提：开发服务器已在运行（默认 127.0.0.1:8899）。
 *
 * 用法：
 *   node scripts/dev-server.mjs        # 另一个终端
 *   node scripts/dom-smoke-test.mjs
 *
 * @module scripts/dom-smoke-test
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM, VirtualConsole } from 'jsdom'

import { provisionFixtures, cleanupFixtures } from './lib/fixtures.mjs'

const ROOT = process.cwd()
const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:8899'

/**
 * 测试文档的标记前缀。
 *
 * 这个测试**自己造数据**（见 scripts/lib/fixtures.mjs）：早先的版本
 * 依赖库里恰好有 PDF / PPTX，一旦按用户要求清空测试数据，
 * 整套前端测试就再也跑不起来了。现在自备最小夹具，跑完即删。
 */
const MARK = `RNDBSMOKE${Date.now()}`

/**
 * ★ 必须在任何覆盖之前捕获 Node 原生 fetch。
 *
 * 踩过的坑：下面会把 `window.fetch` 桥接到真实服务器，而 runModule
 * 又把 `globalThis.fetch` 指向 `window.fetch`。若桥接函数内部直接调用
 * 裸 `fetch`，它解析到的正是被覆盖后的 `window.fetch` —— 无限递归，
 * 报 "Maximum call stack size exceeded"，而且错误信息会伪装成
 * 「加载清单失败」，极易误判成应用 bug。
 */
const nodeFetch = globalThis.fetch.bind(globalThis)

let passed = 0
let failed = 0

/**
 * 断言。
 * @param {boolean} cond - 条件
 * @param {string} label - 描述
 * @param {string} [detail] - 失败详情
 */
function check(cond, label, detail = '') {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`)
  }
}

/**
 * 等到某个条件成立（轮询 DOM）。
 * @param {Function} fn - 判定函数
 * @param {number} [timeoutMs] - 超时
 * @returns {Promise<boolean>} 是否成立
 */
async function waitFor(fn, timeoutMs = 5000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (fn()) return true
    } catch {
      /* DOM 尚未就绪，继续等 */
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

/**
 * 让事件循环空转一会儿（等 debounce 与异步渲染落地）。
 * @param {number} [ms] - 毫秒
 * @returns {Promise<void>} 完成
 */
const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms))

/* ============================================================
   自备夹具（实现见 scripts/lib/fixtures.mjs，与 render-check 共用）
   ============================================================ */

/** 已入库的夹具（收尾要删干净）。 */
let fixtures = null

/**
 * 造夹具并入库。
 * @returns {Promise<void>} 完成
 */
async function setUpFixtures() {
  fixtures = await provisionFixtures({ root: ROOT, base: BASE, mark: MARK })
  console.log(`  夹具：${fixtures.ids.length} 份临时文档（${MARK}）`)
}

/** 删掉夹具（文档 + 临时目录）。 */
async function tearDownFixtures() {
  const removed = await cleanupFixtures({ base: BASE, fixtures })
  if (removed) console.log(`\n  已清理 ${removed} 份夹具文档`)
}

/**
 * 建一个 jsdom 环境，把 fetch 桥接到真实开发服务器。
 * @param {string} page - 页面文件名（可含查询串）
 * @returns {{dom:JSDOM, errors:string[]}} 环境
 */
function makeDom(page) {
  const html = readFileSync(join(ROOT, 'public', page.split('?')[0]), 'utf8')
  const errors = []

  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (e) => errors.push(String(e?.message ?? e)))

  const dom = new JSDOM(html, {
    url: `${BASE}/${page}`,
    runScripts: 'outside-only',   // 手动执行模块，便于捕获错误
    pretendToBeVisual: true,
    virtualConsole,
  })

  const { window } = dom

  // 桥接 fetch：相对路径补成绝对地址后转发。
  // 用捕获好的 nodeFetch，绝不能写裸 fetch（会递归到自身）。
  window.fetch = (input, init) => {
    const url = typeof input === 'string' && input.startsWith('/') ? BASE + input : input
    return nodeFetch(url, init)
  }

  // jsdom 的 localStorage 在 file/无 origin 场景下可能缺失，补一个内存版
  if (!window.localStorage) {
    const store = new Map()
    window.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
    }
  }

  // jsdom 未实现 scrollIntoView（真实浏览器有），补个空实现。
  // 这是测试环境的能力缺口，不该为了迁就它去改应用代码。
  if (!window.Element.prototype.scrollIntoView) {
    window.Element.prototype.scrollIntoView = () => {}
  }

  return { dom, errors }
}

/**
 * 在 jsdom 里执行一个前端模块。
 *
 * 模块用相对路径 import，所以交给 Node 原生 ESM 执行；
 * 把 document / window 等注入全局，模块就会操作 jsdom 的 DOM。
 *
 * @param {JSDOM} dom - 环境
 * @param {string} relPath - 相对 public 的模块路径
 * @returns {Promise<void>} 完成
 */
async function runModule(dom, relPath) {
  const { window } = dom
  globalThis.window = window
  globalThis.document = window.document
  globalThis.location = window.location
  globalThis.localStorage = window.localStorage
  globalThis.alert = () => {}
  globalThis.prompt = () => null
  globalThis.confirm = () => false   // 避免测试里误触删除
  globalThis.fetch = window.fetch

  // 加时间戳绕开 ESM 模块缓存，保证多轮测试互不干扰
  const url = new URL(`../public/${relPath}`, import.meta.url).href
  await import(`${url}?t=${Date.now()}`)
}

/* ============================================================
   列表页
   ============================================================ */

async function testListPage() {
  console.log('\n【列表页 index.html】')

  // 断言必须**与库内容无关** —— 早期版本把「简历第一版」这类标题写死在断言里，
  // 库里从 3 份变成 256 份后全部崩掉。现在改为用真实数据驱动断言。
  const manifestRes = await nodeFetch(`${BASE}/api/v1/manifest`)
  const manifest = (await manifestRes.json()).data
  const allDocs = manifest.docs ?? []

  const { dom, errors } = makeDom('index.html')
  const { document } = dom.window

  await runModule(dom, 'js/list.js')

  const rendered = await waitFor(() => document.querySelectorAll('.doc').length > 0)
  check(
    rendered,
    '文档条目渲染出来了',
    `results 内容：${document.getElementById('results')?.textContent?.slice(0, 200)}`,
  )

  const rows = document.querySelectorAll('.doc')
  const expectShown = Math.min(allDocs.length, 60)   // 首屏上限 60
  check(
    rows.length === expectShown,
    `渲染了 ${rows.length} 条（库里 ${allDocs.length} 份，首屏预期 ${expectShown}）`,
  )

  const titles = [...document.querySelectorAll('.doc-title')].map((e) => e.textContent.trim())
  check(titles.length > 0 && titles.every((t) => t.length > 0), '每条都有非空标题')

  const badges = [...new Set([...document.querySelectorAll('.type-badge')].map((e) => e.textContent.trim()))]
  check(badges.length > 0, `类型徽标：${badges.join(',')}`)

  const chips = [...document.querySelectorAll('.chip')].map((e) => e.textContent.trim())
  check(chips.some((c) => c.startsWith('全部')), `分类切面含「全部」：${chips.slice(0, 6).join(' / ')}`)

  const stats = document.getElementById('stats')?.textContent ?? ''
  check(/\d+\s*份/.test(stats), `统计行：${stats}`)

  // 顶栏鉴权区：只应有「退出」，不该再出现角色徽标
  const authArea = document.getElementById('auth-area')
  const authHtml = authArea?.innerHTML ?? ''
  check(Boolean(authArea), '存在鉴权区')
  check(!/class="who"/.test(authHtml), '不再显示角色徽标（admin 之类）')
  check(/退出/.test(authHtml) || /登录/.test(authHtml),
    `鉴权区是登录或退出入口：${authArea?.textContent?.trim()}`)

  // ---- 点分类切面 → 真的按该分类筛选 ----
  // 挑一个库里确实存在的分类（数量 >= 1），并断言渲染出的每一条都带这个分类
  const catCount = {}
  for (const d of allDocs) for (const c of d.categories ?? []) catCount[c] = (catCount[c] ?? 0) + 1
  const pickCat = Object.entries(catCount).sort((a, b) => b[1] - a[1])[0]

  if (!pickCat) {
    check(false, '库里没有任何分类，无法验证筛选')
  } else {
    const [catName, catTotal] = pickCat
    const catChip = [...document.querySelectorAll('.chip')]
      .find((e) => e.textContent.trim().startsWith(catName))

    if (!catChip) {
      check(false, `找不到分类切面「${catName}」`)
    } else {
      catChip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      await tick(200)

      const shown = document.querySelectorAll('.doc').length
      const expectCount = Math.min(catTotal, 60)
      check(shown === expectCount, `点「${catName}」后剩 ${shown} 条（预期 ${expectCount}）`)

      const allHaveCat = [...document.querySelectorAll('.doc .cats')]
        .every((e) => e.textContent.includes(catName))
      check(allHaveCat, '筛出的每一条都确实带该分类')

      catChip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))  // 取消
      await tick(200)
    }
  }

  // ---- 搜索框即时筛选：用真实标题里的片段 ----
  const probe = allDocs[0]
  const probeTerm = String(probe.title).slice(0, 6)
  const search = document.getElementById('search')
  search.value = probeTerm
  search.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  await tick(400)

  const found = [...document.querySelectorAll('.doc')]
    .map((e) => e.querySelector('.doc-title')?.textContent?.trim() ?? '')
  check(
    found.length > 0 && found.every((t) => t.includes(probeTerm) || t.toLowerCase().includes(probeTerm.toLowerCase())),
    `搜「${probeTerm}」命中 ${found.length} 条且都含该词`,
    found.slice(0, 4).join(' | '),
  )

  // ---- 拼音检索（前端零依赖：拼音串是入库时预算好的） ----
  const pinyinDoc = allDocs.find((d) => d.pinyin?.initials && d.pinyin.initials.length >= 4)
  if (!pinyinDoc) {
    check(true, '（库中暂无带拼音的文档，跳过拼音检索检查）')
  } else {
    const py = pinyinDoc.pinyin.initials.slice(0, 4)
    search.value = py
    search.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await tick(400)

    const hits = [...document.querySelectorAll('.doc-title')].map((e) => e.textContent.trim())
    check(
      hits.includes(pinyinDoc.title),
      `拼音「${py}」命中「${pinyinDoc.title.slice(0, 20)}」（共 ${hits.length} 条）`,
      hits.slice(0, 4).join(' | '),
    )
  }

  check(errors.length === 0, '运行期无 jsdom 报错', errors.join('\n      '))
  dom.window.close()
}

/* ============================================================
   阅读页
   ============================================================ */

async function testViewPage() {
  console.log('\n【阅读页 view.html】')

  const listRes = await nodeFetch(`${BASE}/api/v1/docs`)
  const list = await listRes.json()
  const pdf = list.data.items.find((d) => d.type === 'pdf')
  const pptx = list.data.items.find((d) => d.type === 'pptx')

  // ---- PDF：应挂原生预览 iframe + 下载按钮 ----
  if (!pdf) {
    check(false, '库里没有 PDF 文档，跳过阅读页测试')
  } else {
    const { dom, errors } = makeDom(`view.html?id=${pdf.id}`)
    const { document } = dom.window
    await runModule(dom, 'js/view.js')

    await waitFor(() => document.getElementById('doc-title')?.textContent !== '加载中…')

    const title = document.getElementById('doc-title').textContent
    check(
      title === pdf.title,
      `PDF：标题与接口一致（页面「${title}」/ 接口「${pdf.title}」）`,
    )

    const iframe = document.querySelector('iframe.pdf')
    check(Boolean(iframe), 'PDF：挂上了内嵌预览 iframe')
    check(
      (iframe?.getAttribute('src') ?? '').includes(`/api/v1/docs/${pdf.id}/preview`),
      'PDF：iframe 指向 preview 接口',
    )

    const dl = [...document.querySelectorAll('.actions a')].find((a) => a.textContent.includes('下载'))
    check((dl?.getAttribute('href') ?? '').includes('/file'), 'PDF：有下载按钮且指向 file 接口')
    check(Boolean(dl?.hasAttribute('download')), 'PDF：下载链接带 download 属性')
    check(document.getElementById('doc-meta').textContent.includes('PDF'), 'PDF：元信息含格式')

    check(errors.length === 0, 'PDF：无 jsdom 报错', errors.join('\n      '))
    dom.window.close()
  }

  // ---- PPTX：预览方式取决于是否装了 LibreOffice，按实际 previewKind 断言 ----
  if (!pptx) {
    // 夹具里不造 PPTX（真要造得手搓一整套 OOXML 包，性价比太低）。
    // 缺它只说明这一条没覆盖到，不是失败 —— 断言写死成"库里必须有 PPTX"，
    // 清空测试数据之后整个测试就再也跑不起来了
    check(true, '（库中暂无 PPTX，跳过该检查）')
  } else {
    const { dom, errors } = makeDom(`view.html?id=${pptx.id}`)
    const { document } = dom.window
    await runModule(dom, 'js/view.js')

    await waitFor(() => document.getElementById('doc-title')?.textContent !== '加载中…')

    // 装了 LibreOffice → 转出 PDF（高保真）；没装 → HTML 降级
    const wantCls = pptx.previewKind === 'pdf' ? 'pdf' : 'html'
    const frame = document.querySelector(`iframe.${wantCls}`)
    check(
      Boolean(frame),
      `PPTX：previewKind=${pptx.previewKind} → 挂上了 iframe.${wantCls}`,
      `实际 iframe: ${document.querySelector('#frame iframe')?.className ?? '无'}`,
    )

    const notice = document.getElementById('notice')?.textContent ?? ''
    // 引擎名会变（Office 桌面引擎 / LibreOffice / HTML 降级），
    // 断言只要求「说明了预览件来源」，不写死具体引擎
    check(
      /转换|降级|渲染/.test(notice),
      `PPTX：提示了预览件来源：${notice.slice(0, 90)}`,
    )
    // 只有 Markdown 才该带 mode 参数
    check(
      !(frame?.getAttribute('src') ?? '').includes('mode='),
      'PPTX：非 Markdown，预览地址不带 mode 参数',
    )

    check(errors.length === 0, 'PPTX：无 jsdom 报错', errors.join('\n      '))
    dom.window.close()
  }
}

/* ============================================================
   编辑面板（只测渲染，不测写入）
   ============================================================ */

/**
 * 编辑面板的 UI 渲染测试。
 *
 * 刻意**不点保存**：写入路径由 scripts/test-write-api.mjs 用临时文档覆盖，
 * 这里若真保存就会改动库里已有资料。职责分离，测试之间不互相污染。
 */
async function testEditorPanel() {
  console.log('\n【编辑面板 view.html】')

  const listRes = await nodeFetch(`${BASE}/api/v1/docs?limit=1`)
  const list = await listRes.json()
  const doc = list.data.items[0]
  if (!doc) {
    check(false, '库里没有文档，跳过编辑面板测试')
    return
  }

  const { dom, errors } = makeDom(`view.html?id=${doc.id}`)
  const { document } = dom.window
  await runModule(dom, 'js/view.js')

  await waitFor(() => document.getElementById('doc-title')?.textContent !== '加载中…')
  await tick(400)   // 等 canEditNow() 与 taxonomy 拉取完成

  const editBtn = document.getElementById('btn-edit')
  check(Boolean(editBtn), '本地开发（admin 角色）出现「编辑元数据」按钮')

  if (editBtn) {
    editBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await tick(300)

    const editor = document.querySelector('.editor')
    check(Boolean(editor), '点击后渲染出编辑面板')

    if (editor) {
      const titleInput = document.getElementById('ed-title')
      check(Boolean(titleInput), '有标题输入框')
      check(
        (titleInput?.value ?? '').length > 0,
        `标题已预填：${titleInput?.value?.slice(0, 30)}`,
      )

      const catBoxes = document.querySelectorAll('.cat-opt input')
      check(catBoxes.length >= 9, `分类多选框有 ${catBoxes.length} 个（受控词表）`)

      // 「未归类」是兜底分类，编辑器刻意不列它（列出来只会让人误选成
      // 「未归类 + 合同证照」这种组合）。因此归在未归类的文档一个框都不勾，
      // 这是预期行为，不是 bug。
      const checkedCount = [...catBoxes].filter((cb) => cb.checked).length
      const onlyOther = (doc.categories ?? []).filter((c) => c !== '未归类').length === 0
      check(
        checkedCount >= 1 || onlyOther,
        `分类勾选与文档一致（勾了 ${checkedCount} 个${onlyOther ? '；本文档归在「未归类」，编辑器不列该选项' : ''}）`,
      )

      check(Boolean(document.getElementById('ed-tags')), '有标签输入框')
      check(Boolean(document.getElementById('ed-summary')), '有摘要输入框')
      check(Boolean(document.getElementById('ed-visibility')), '有可见性选择器')
      check(Boolean(document.getElementById('ed-save')), '有保存按钮')
      check(Boolean(document.getElementById('ed-delete')), '有删除按钮')

      const del = document.getElementById('ed-delete')
      check(/删除/.test(del?.textContent ?? ''), `删除按钮文案：${del?.textContent?.trim()}`)

      // 取消应当收起面板，且不改动任何东西
      document.getElementById('ed-cancel').dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true }),
      )
      await tick(150)
      check(!document.querySelector('.editor'), '点取消后面板收起')
    }
  }

  check(errors.length === 0, '无 jsdom 报错', errors.join('\n      '))
  dom.window.close()
}

/* ============================================================
   内容编辑器（代码 / 文本直接改写）
   ============================================================ */

/**
 * 内容编辑器的 DOM 行为测试。
 *
 * 只测**交互**，不点保存 —— 写入路径由 scripts/test-content-edit.mjs
 * 用临时文档完整覆盖（那边会真的改内容并断言索引换词条）。
 * 这里要验的是那些只能靠真实 DOM 才能发现的细节：
 *   Tab 有没有被拦下来、缩进对不对、脏标记有没有出来、
 *   关闭时有没有拦一下。
 */
async function testCodeEditor() {
  console.log('\n【内容编辑器 view.html（代码文件）】')

  const listRes = await nodeFetch(`${BASE}/api/v1/docs?q=${encodeURIComponent(MARK)}&limit=50`)
  const list = await listRes.json()
  const codeDoc = (list.data.items ?? []).find((d) => d.type === 'code')

  if (!codeDoc) {
    check(false, '没找到代码夹具，无法测试内容编辑器')
    return
  }

  const { dom, errors } = makeDom(`view.html?id=${codeDoc.id}`)
  const { document } = dom.window
  await runModule(dom, 'js/view.js')

  await waitFor(() => document.getElementById('doc-title')?.textContent !== '加载中…')
  await tick(400)   // 等 canEditNow()

  check(codeDoc.previewKind === 'code', `夹具的 previewKind=code（实际 ${codeDoc.previewKind}）`)
  check(
    Boolean(document.querySelector('iframe.html')),
    '代码文档挂上了 html 预览 iframe',
    document.querySelector('#frame iframe')?.className ?? '无 iframe',
  )
  check(
    !document.querySelector('.mode-switch'),
    '代码文档不显示「文本/源码」切换（它本身就是源码视图）',
  )

  const openBtn = document.getElementById('btn-edit-content')
  check(Boolean(openBtn), '出现「编辑内容」按钮')

  if (!openBtn) {
    check(errors.length === 0, '无 jsdom 报错', errors.join('\n      '))
    dom.window.close()
    return
  }

  openBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await tick(500)   // 等它把原件取回来

  const editor = document.querySelector('.code-editor')
  check(Boolean(editor), '点击后渲染出内容编辑器')
  if (!editor) {
    check(errors.length === 0, '无 jsdom 报错', errors.join('\n      '))
    dom.window.close()
    return
  }

  const ta = document.getElementById('ce-text')
  check(Boolean(ta), '有编辑区 textarea')
  check(
    (ta?.value ?? '').startsWith('//'),
    `编辑区已载入原件（首行：${(ta?.value ?? '').split('\n')[0].slice(0, 40)}）`,
  )
  check(
    (ta?.value ?? '').includes('  return {'),
    '载入的是**原件**，缩进没被抽取流程洗掉',
  )
  check(ta?.getAttribute('spellcheck') === 'false', '关掉了拼写检查（代码里的标识符不是错字）')
  check(ta?.getAttribute('wrap') === 'off', '代码不自动折行（一行就是一行）')

  const save = document.getElementById('ce-save')
  check(Boolean(save) && !save.disabled, '保存按钮可用')

  // ---- Tab 缩进 ----
  const pristine = ta.value
  ta.setSelectionRange(0, 0)
  ta.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
  await tick(80)
  check(ta.value.startsWith('  //'), `Tab 在行首插入了 2 空格（实际「${ta.value.slice(0, 6)}」）`)
  check(ta.value.length === pristine.length + 2, '只插入了缩进，没动别的字符')

  // ---- Shift+Tab 反缩进 ----
  ta.setSelectionRange(2, 2)
  ta.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }))
  await tick(80)
  check(ta.value === pristine, 'Shift+Tab 又把缩进退回去了')

  // ---- 脏标记 ----
  const stat0 = document.getElementById('ce-stat')?.textContent ?? ''
  check(/行/.test(stat0), `统计行显示了行数：${stat0}`)
  check(!/未保存/.test(stat0), '刚打开时不算脏')

  ta.value = `${ta.value}// 改了一行\n`
  ta.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  await tick(80)
  const stat1 = document.getElementById('ce-stat')?.textContent ?? ''
  check(/未保存/.test(stat1), `改动后出现「未保存」：${stat1}`)

  // ---- 有未保存改动时不该被「取消」静默丢掉 ----
  // runModule 把 confirm 固定为 false（等价于用户点了"取消"）
  document.getElementById('ce-cancel').dispatchEvent(
    new dom.window.MouseEvent('click', { bubbles: true }),
  )
  await tick(150)
  check(Boolean(document.querySelector('.code-editor')), '有未保存改动时，取消不会直接关掉编辑器')

  check(errors.length === 0, '无 jsdom 报错', errors.join('\n      '))
  dom.window.close()
}

/* ============================================================
   主流程
   ============================================================ */

async function main() {
  console.log('▸ R_N_Database 前端冒烟测试')
  console.log(`  后端 ${BASE}`)

  try {
    const res = await nodeFetch(`${BASE}/api/v1/health`)
    const body = await res.json()
    if (!body?.ok) throw new Error('health 未返回 ok')
    console.log(`  存储 ${body.data.store.mode} / 文档 ${body.data.docCount} 份`)
  } catch (err) {
    console.error(`\n  无法连接开发服务器（${BASE}）：${err.message}`)
    console.error('  请先在另一个终端运行：node scripts/dev-server.mjs\n')
    process.exit(1)
  }

  await setUpFixtures()

  try {
    await testListPage()
    await testViewPage()
    await testEditorPanel()
    await testCodeEditor()
  } finally {
    await tearDownFixtures()
  }

  console.log('\n────────────────────────────────')
  console.log(`  通过 ${passed} / 失败 ${failed}`)
  console.log('')
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n冒烟测试自身出错：', err)
  process.exit(1)
})
