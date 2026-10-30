/**
 * 整文件夹上传回归测试。
 *
 * ## 它守的是什么
 *
 * 文件夹上传最容易出的错都**不报错**，只是悄悄少传：
 *
 * 1. **目录递归只读了一批**。`readEntries()` 每次最多返回 100 项
 *    （Chrome），只调一次就会漏掉后面的文件，而且没有任何提示。
 *    这里用 250 个假条目验证循环读到空。
 * 2. **目录结构丢了**。同名文件在不同子目录里很常见，
 *    不保留相对路径就分不清谁是谁。
 * 3. **垃圾文件全传上来**。Thumbs.db、~$ 锁文件、node_modules
 *    会瞬间把暂存区变成垃圾场，还得手工一个个删。
 * 4. **路径可被穿越**。相对路径是客户端给的字符串，必须当不可信输入处理。
 *
 * 用法：
 *   node scripts/dev-server.mjs
 *   node scripts/test-folder-upload.mjs
 *
 * @module scripts/test-folder-upload
 */

import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { JSDOM, VirtualConsole } from 'jsdom'

import { testChildEnv } from './lib/test-env.mjs'

const ROOT = process.cwd()
const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:8899'

/**
 * ★ 必须在任何覆盖之前捕获 Node 原生 fetch。
 *
 * 每个 jsdom 环境都会把 `window.fetch` 桥接到真实服务器，桥接函数内部
 * **不能写裸 `fetch`** —— 第二次挂载时那个名字已经指向上一轮的桥接函数，
 * 于是自己调自己，报 "Maximum call stack size exceeded"。
 * （dom-smoke-test 里踩过同一个坑。）
 */
const nodeFetch = globalThis.fetch.bind(globalThis)

/** 本轮标记：所有测试文件都带它，收尾按它清理。 */
const MARK = `RNDBDIR${Date.now()}`

/**
 * 本测试造出来的暂存记录 id（精确清理，不靠名字前缀猜）。
 *
 * ★ 之前按「名字里含 MARK」清理，踩过一次：服务端把文件名规整之后
 * `..\..\evil.txt` 变成了 `evil.txt`，不再含 MARK，于是它留在了暂存区，
 * 被后面的 process-pending 一起入库。按 id 清理才可靠。
 */
const stagedIds = new Set()

/**
 * 造一个「像浏览器 File 一样」的文件对象。
 *
 * ★ 必须用 **Node 原生 File**（Blob 的子类），不能用 jsdom 的 File：
 * jsdom 的 File 不是标准 Blob，undici 把它当普通对象序列化成
 * `[object File]` —— 于是每个文件上传上去的内容都一模一样，
 * 入库时被判为"重复"。这个坑让测试看起来只入库了 1 份文件。
 *
 * @param {string} content - 内容
 * @param {string} name - 文件名
 * @param {string} [relPath] - webkitRelativePath
 * @param {number} [size] - 伪造体积（只改 size，不真的分配内存）
 * @returns {File} 文件
 */
function makeFile(content, name, relPath, size) {
  const f = new File([content], name)
  if (relPath !== undefined) {
    Object.defineProperty(f, 'webkitRelativePath', { value: relPath })
  }
  if (size !== undefined) {
    Object.defineProperty(f, 'size', { value: size })
  }
  return f
}

let passed = 0
let failed = 0

/**
 * 断言。
 * @param {boolean} cond - 条件
 * @param {string} label - 描述
 * @param {string} [detail] - 详情
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
 * 发 API 请求（带管理员令牌 —— 本机未配密码时无需令牌，这里留出扩展位）。
 * @param {string} path - 路径
 * @param {object} [opts] - { method, body, headers }
 * @returns {Promise<{status:number, body:object|null}>} 响应
 */
async function api(path, opts = {}) {
  const res = await nodeFetch(BASE + path, {
    method: opts.method ?? 'GET',
    headers: opts.headers,
    body: opts.body,
  })
  let body = null
  try {
    body = await res.json()
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, body }
}

/**
 * 上传一份伪造文件到暂存区。
 * @param {string} name - 含目录的相对路径
 * @param {string} [content] - 内容
 * @returns {Promise<{status:number, body:object|null}>} 响应
 */
async function upload(name, content = `${MARK} ${name}`) {
  const rel = name
  const base = name.split(/[\\/]/).pop()
  const q = new URLSearchParams({ name: base, path: rel })
  const r = await api(`/api/v1/inbox?${q}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: content,
  })
  if (r.body?.data?.id) stagedIds.add(r.body.data.id)
  return r
}

/**
 * 清空暂存区里本轮造的东西（按记录的 id，精确删）。
 * @returns {Promise<number>} 删除数量
 */
async function cleanStaging() {
  let n = 0
  for (const id of stagedIds) {
    const r = await api(`/api/v1/inbox/${id}`, { method: 'DELETE' })
    if (r.status === 200) n += 1
  }
  stagedIds.clear()
  return n
}

/* ============================================================
   API：相对路径
   ============================================================ */

async function testApi() {
  console.log('\n【接口：相对路径】')

  const ok = await upload(`${MARK}/合同/2025/设备采购.pdf`)
  check(ok.status === 200, `带 path 上传成功（${ok.status}）`, ok.body?.error?.message)
  check(
    ok.body?.data?.relativePath === `${MARK}/合同/2025/设备采购.pdf`,
    `记录了相对路径（${ok.body?.data?.relativePath}）`,
  )
  check(ok.body?.data?.originalName === '设备采购.pdf', 'originalName 仍是文件名（不含目录）')
  check(ok.body?.data?.title === '设备采购', `标题取自文件名（${ok.body?.data?.title}）`)

  // 不带 path：保持原有行为
  const plainBody = `${MARK} plain`
  const plain = await api(`/api/v1/inbox?name=${MARK}-plain.txt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: plainBody,
  })
  if (plain.body?.data?.id) stagedIds.add(plain.body.data.id)
  check(plain.status === 200, `不带 path 也能上传（${plain.status}）`)
  check(plain.body?.data?.relativePath === undefined, '单文件上传不写 relativePath')

  // 清单里能看到路径
  const list = await api('/api/v1/inbox')
  const hit = (list.body?.data?.items ?? []).find((it) => it.relativePath?.includes('设备采购'))
  check(Boolean(hit), '待处理清单返回 relativePath')
  check(String(hit?.relativePath).includes('合同/2025'), `路径层级完整（${hit?.relativePath}）`)

  console.log('\n【接口：非法路径一律拒绝】')
  const traverse = await api(
    `/api/v1/inbox?name=x.txt&path=${encodeURIComponent('../../etc/x.txt')}`,
    { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: 'x' },
  )
  check(traverse.status === 400, `路径穿越被拒（${traverse.status}）`, traverse.body?.error?.message)

  const mismatch = await api(
    `/api/v1/inbox?name=a.txt&path=${encodeURIComponent('dir/b.txt')}`,
    { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: 'x' },
  )
  check(mismatch.status === 400, `路径与文件名对不上被拒（${mismatch.status}）`)

  const deep = Array.from({ length: 15 }, (_, i) => `d${i}`).join('/')
  const tooDeep = await api(
    `/api/v1/inbox?name=x.txt&path=${encodeURIComponent(`${deep}/x.txt`)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: 'x' },
  )
  check(tooDeep.status === 400, `层级过深被拒（${tooDeep.status}）`)

  const long = `${'a'.repeat(420)}/x.txt`
  const tooLong = await api(
    `/api/v1/inbox?name=x.txt&path=${encodeURIComponent(long)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: 'x' },
  )
  check(tooLong.status === 400, `路径过长被拒（${tooLong.status}）`)

  // 反斜杠与重复分隔符要能规整（Windows 风格的名字/路径）
  const winPath = `${MARK}/资料/子目录/说明.md`
  const win = await api(`/api/v1/inbox?name=说明.md&path=${encodeURIComponent(`${MARK}\\资料\\\\子目录\\说明.md`)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: `${MARK} win`,
  })
  if (win.body?.data?.id) stagedIds.add(win.body.data.id)
  check(win.status === 200, `反斜杠路径被接受（${win.status}）`, win.body?.error?.message)
  check(
    win.body?.data?.relativePath === winPath,
    `反斜杠与重复分隔符已规整（${win.body?.data?.relativePath}）`,
  )

  // 文件名里的分隔符会被剥掉（防止路径混进 originalName）
  const sneaky = await api(`/api/v1/inbox?name=${encodeURIComponent('..\\..\\evil.txt')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: `${MARK} sneaky`,
  })
  if (sneaky.body?.data?.id) stagedIds.add(sneaky.body.data.id)
  check(sneaky.status === 200, `带分隔符的文件名被接受（${sneaky.status}）`)
  check(
    sneaky.body?.data?.originalName === 'evil.txt',
    `只保留文件名末段（${sneaky.body?.data?.originalName}）`,
  )

  // 清空：后面的用例要从一个干净的暂存区开始（否则入库阶段会处理到这些）
  const n = await cleanStaging()
  check(n > 0, `测试用的暂存记录已清理（${n} 份）`)
}

/* ============================================================
   浏览器侧：目录递归 + 分类跳过
   ============================================================ */

/**
 * 造一个 jsdom 环境并挂载 upload.js。
 * @returns {Promise<object>} { dom, ctl, banner, errors }
 */
async function mountUploadUi() {
  const errors = []
  const vc = new VirtualConsole()
  vc.on('jsdomError', (e) => errors.push(String(e?.message ?? e)))

  const dom = new JSDOM(
    '<!doctype html><html><body><button id="up"></button><button id="upd"></button>'
    + '<div id="drop"></div><div id="banner"></div></body></html>',
    { url: `${BASE}/`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc },
  )
  const { window } = dom
  // 用捕获好的 nodeFetch，绝不能写裸 fetch（会递归到上一轮的桥接函数）
  window.fetch = (input, init) => {
    const url = typeof input === 'string' && input.startsWith('/') ? BASE + input : input
    return nodeFetch(url, init)
  }

  Object.assign(globalThis, {
    window,
    document: window.document,
    location: window.location,
    localStorage: window.localStorage,
  })
  globalThis.fetch = window.fetch

  const { mountUpload } = await import(`../public/js/upload.js?t=${Date.now()}`)

  let changed = null
  const onChangeDone = new Promise((resolve) => { changed = resolve })

  const ctl = mountUpload({
    button: window.document.getElementById('up'),
    folderButton: window.document.getElementById('upd'),
    dropZone: window.document.getElementById('drop'),
    banner: window.document.getElementById('banner'),
    onChange: () => changed(),
  })

  return { dom, window, ctl, banner: window.document.getElementById('banner'), errors, onChangeDone }
}

/**
 * 伪造一个 FileSystemFileEntry。
 * @param {string} name - 文件名
 * @param {object} window - jsdom window
 * @returns {object} 条目
 */
function fileEntry(name) {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (onOk) => onOk(makeFile(`${MARK} ${name}`, name)),
  }
}

/**
 * 伪造一个 FileSystemDirectoryEntry。
 *
 * ★ `readEntries` 每批最多返回 100 项（与 Chrome 一致），
 * 这样才测得出"只读一批"的漏文件 bug。
 *
 * @param {string} name - 目录名
 * @param {object[]} children - 子条目
 * @returns {object} 目录条目
 */
function dirEntry(name, children) {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let cursor = 0
      return {
        readEntries: (onOk) => {
          const batch = children.slice(cursor, cursor + 100)
          cursor += batch.length
          onOk(batch)
        },
      }
    },
  }
}

async function testBrowserCollect() {
  console.log('\n【浏览器：拖拽目录递归】')

  const { window, ctl, banner, errors } = await mountUploadUi()

  // 250 个不支持的类型：既能验证"全部被递归收集到"，
  // 又不会真的上传任何东西（分类阶段就跳过了）
  const children = Array.from({ length: 250 }, (_, i) => fileEntry(`${MARK}-shot${i}.png`))
  const root = dirEntry(MARK, children)

  const dt = {
    types: ['Files'],
    files: [],
    items: [{ kind: 'file', webkitGetAsEntry: () => root }],
  }

  // 直接 await 处理结果：只靠 DOM 回调没法确定"递归收全了没有"
  const summary = await ctl.handleDataTransfer(dt)
  const text = banner.textContent.replace(/\s+/g, ' ').trim()

  check(summary.skipped?.unsupported === 250, `收集到 250 个条目（实际 ${summary.skipped?.unsupported}）`,
    '为 100 说明 readEntries 只读了一批')
  check(text.includes('跳过 250 个不支持的类型'), '提示里如实报出跳过数量', text.slice(0, 200))
  check(text.includes('没有可上传的文件'), '全部不支持时给出明确结论')

  // 走真实的 drop 事件也要一样（验证监听器接线，不等结果只看最终提示）
  const ev = new window.Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'dataTransfer', { value: dt })
  window.document.getElementById('drop').dispatchEvent(ev)
  await new Promise((r) => setTimeout(r, 600))
  check(
    banner.textContent.includes('跳过 250 个不支持的类型'),
    'drop 事件经过同一条递归路径',
  )
  check(errors.length === 0, '无 jsdom 报错', errors.join(' | '))
}

async function testBrowserFolderPicker() {
  console.log('\n【浏览器：选文件夹上传】')

  const { window, ctl, banner, errors, onChangeDone } = await mountUploadUi()

  // 用 Node 原生 File（见 makeFile 的说明：jsdom 的 File 不能直接当请求体）
  const aContent = `${MARK} 甲 文件内容`
  const bContent = `${MARK} 乙 另一份内容`

  const files = [
    makeFile(aContent, `${MARK}-a.txt`, `${MARK}/${MARK}-a.txt`),
    makeFile(bContent, `${MARK}-b.md`, `${MARK}/子目录/${MARK}-b.md`),
    // 超限：上限已提到 100MB（大文件走分片），所以这里伪造 101MB
    makeFile(`${MARK} big`, `${MARK}-big.pdf`, `${MARK}/${MARK}-big.pdf`, 101 * 1024 * 1024),
    makeFile(`${MARK} pic`, `${MARK}-pic.png`, `${MARK}/${MARK}-pic.png`),                     // 不支持
    makeFile('db', 'Thumbs.db', `${MARK}/Thumbs.db`),                                          // 系统文件
    makeFile('lock', '~$草稿.docx', `${MARK}/~$草稿.docx`),                                     // Office 锁文件
  ]
  Object.defineProperty(ctl.dirPicker, 'files', { value: files, configurable: true })
  ctl.dirPicker.dispatchEvent(new window.Event('change', { bubbles: true }))

  await onChangeDone
  const text = banner.textContent.replace(/\s+/g, ' ').trim()

  check(text.includes('成功上传 2 / 2'), '2 个支持的、不超限的文件被上传', text.slice(0, 260))
  check(text.includes('跳过 1 个不支持的类型'), '不支持的类型被跳过')
  check(/超过 100MB/.test(text), '超限文件被跳过并说明原因', text.slice(0, 260))
  check(text.includes('跳过 2 个系统/临时文件'), 'Thumbs.db 与 ~$ 锁文件被跳过')
  check(errors.length === 0, '无 jsdom 报错', errors.join(' | '))

  // 真正落到了暂存区，且保留目录结构
  const list = await api('/api/v1/inbox')
  const items = (list.body?.data?.items ?? []).filter(
    (it) => it.originalName === `${MARK}-a.txt` || it.originalName === `${MARK}-b.md`,
  )
  for (const it of items) stagedIds.add(it.id)
  check(items.length === 2, `暂存区里有 2 条记录（实际 ${items.length}）`)
  const withSubdir = items.find((it) => it.relativePath?.includes('子目录'))
  check(Boolean(withSubdir), `子目录的目录结构被保留（${withSubdir?.relativePath}）`)

  // 两份内容必须真的不同（否则浏览器侧上传的是同一串字节，测不出什么）
  const sizes = new Set(items.map((it) => it.size))
  check(sizes.size === 2, `两份文件的体积不同，说明内容确实各自上传了（${[...sizes].join(' / ')}）`)

  return items
}

/* ============================================================
   增量同步：改一个 / 加一个 / 留一个
   ============================================================ */

/**
 * 找库里的某份文档。
 * @param {string} originalName - 原始文件名
 * @returns {Promise<object|null>} 文档列表项
 */
async function findDoc(originalName) {
  const list = await api('/api/v1/docs?limit=200')
  return (list.body?.data?.items ?? []).find((d) => d.originalName === originalName) ?? null
}

/**
 * 数库里有几份同名的文档（用来证明「替换」而不是「又多了一份」）。
 * @param {string} originalName - 原始文件名
 * @returns {Promise<object[]>} 匹配的文档
 */
async function findAllDocs(originalName) {
  const list = await api('/api/v1/docs?limit=200')
  return (list.body?.data?.items ?? []).filter((d) => d.originalName === originalName)
}

/**
 * 整目录「增量同步」的端到端验证。
 *
 * 这正是用户会问的那个问题：整个文件夹拖过一次之后，**改了几个、加了几个**，
 * 难道每次都要全量重传？期望行为是：
 *   - 没变的：**根本不上传**（本地算哈希，库里已有就跳过）
 *   - 改了的：上传，入库时按路径**替换**旧版本（不是多出一份）
 *   - 新增的：上传，入库新增
 *   - 从目录里消失的：**只报告不删除**（自动删是危险动作）
 */
async function testIncrementalSync() {
  console.log('\n【增量同步：改一个 / 加一个 / 留一个】')

  await cleanStaging()

  const root = `SYNC${Date.now()}`
  const keepName = `${root}-keep.md`
  const editName = `${root}-edit.md`
  const addName = `${root}-add.md`

  const v1Keep = `${root} 这份文件不动，内容一`
  const v1Edit = `${root} 这份要改，旧内容`
  const v2Edit = `${root} 这份要改，新内容已更新`
  const addContent = `${root} 这是第二轮新增的文件`

  const item = (name, content) => ({
    file: makeFile(content, name, `${root}/${name}`),
    relPath: `${root}/${name}`,
  })

  const { ctl, banner, errors } = await mountUploadUi()

  // ---- 第一轮：两份都上传 ----
  const round1 = await ctl.handleFiles([item(keepName, v1Keep), item(editName, v1Edit)], `文件夹 ${root}/`)
  check(round1.toSend === 2, `第一轮上传 2 个（实际 ${round1.toSend}）`, JSON.stringify(round1.planned))
  for (const it of (await api('/api/v1/inbox')).body?.data?.items ?? []) stagedIds.add(it.id)

  const { code: c1, output: o1 } = await processPending(['--no-ai'])
  check(c1 === 0, `第一轮入库退出码 ${c1}`)
  if (!/入库 2 份/.test(o1)) console.log(`      （${o1.split('\n').filter((l) => l.trim()).slice(-6).join(' / ')}）`)

  const keepBefore = await findDoc(keepName)
  const editBefore = await findDoc(editName)
  check(Boolean(keepBefore && editBefore), '第一轮入库了 2 份')
  if (!keepBefore || !editBefore) return

  console.log(`      入库后：keep=${keepBefore.id} edit=${editBefore.id}`)

  // ---- 第二轮：改一份、加一份、留一份 ----
  const round2 = await ctl.handleFiles([
    item(keepName, v1Keep),        // 没变
    item(editName, v2Edit),        // 改了
    item(addName, addContent),     // 新增
  ], `文件夹 ${root}/`)

  const text2 = banner.textContent.replace(/\s+/g, ' ').trim()
  check(round2.checked === 3, `本轮检查了 3 个文件（实际 ${round2.checked}）`)
  check(round2.toSend === 2, `只需要上传 2 个（未变的那份不上传，实际 ${round2.toSend}）`)
  check(round2.planned?.unchanged === 1, `报告「未变 1」（实际 ${round2.planned?.unchanged}）`, JSON.stringify(round2.planned))
  check(round2.planned?.replace === 1, `报告「替换 1」（实际 ${round2.planned?.replace}）`, JSON.stringify(round2.planned))
  check(round2.planned?.new === 1, `报告「新增 1」（实际 ${round2.planned?.new}）`, JSON.stringify(round2.planned))
  check(/未变 1/.test(text2) && /替换 1/.test(text2) && /新增 1/.test(text2),
    '汇总文案里说清了新增/替换/未变', text2.slice(0, 220))

  // 未变的那份不该再进暂存区
  const stagingAfter2 = (await api('/api/v1/inbox')).body?.data?.items ?? []
  for (const it of stagingAfter2) stagedIds.add(it.id)
  const stagedNames = stagingAfter2.map((it) => it.originalName)
  check(!stagedNames.includes(keepName), '没变的文件没有被重新上传', stagedNames.join(' | '))
  check(stagedNames.includes(editName) && stagedNames.includes(addName), '改的与新增的都进了暂存区')

  // ---- 入库：改的那份要「替换」，不是「多一份」 ----
  const { code: c2, output: o2 } = await processPending(['--no-ai'])
  check(c2 === 0, `第二轮入库退出码 ${c2}`)
  if (!/入库 2 份/.test(o2)) console.log(`      （${o2.split('\n').filter((l) => l.trim()).slice(-6).join(' / ')}）`)

  const keepAfter = await findAllDocs(keepName)
  const editAfter = await findAllDocs(editName)
  const addAfter = await findAllDocs(addName)

  check(keepAfter.length === 1 && keepAfter[0].id === keepBefore.id,
    `没变的文档没被重建（id 仍是 ${keepBefore.id}，实际 ${keepAfter.map((d) => d.id).join(',')}）`)
  check(editAfter.length === 1,
    `改过的文件**只有一份**文档（替换而非新增，实际 ${editAfter.length} 份）`,
    editAfter.map((d) => `${d.id}/${d.title}`).join(' | '))
  check(editAfter[0]?.id !== editBefore.id, '改过的文档 id 已更新（内容寻址）')
  check(addAfter.length === 1, `新增的文件入库了（实际 ${addAfter.length} 份）`)

  // 内容确实换了
  if (editAfter[0]) {
    const t = await api(`/api/v1/docs/${editAfter[0].id}/text`)
    const body = (t.body?.data?.pages ?? []).join('')
    check(body.includes('新内容已更新'), '文档正文是**新内容**')
    check(!body.includes('旧内容'), '文档正文里没有旧内容')
    const detail = await api(`/api/v1/docs/${editAfter[0].id}`)
    check(
      String(detail.body?.data?.sourcePath ?? '').endsWith(`${root}/${editName}`),
      `替换后仍记着同一个来源路径（下次同步还能认出它）`,
      detail.body?.data?.sourcePath,
    )
  }

  // ---- 第三轮：完全没变 → 一个字节都不该上传 ----
  const round3 = await ctl.handleFiles([
    item(keepName, v1Keep),
    item(editName, v2Edit),
    item(addName, addContent),
  ], `文件夹 ${root}/`)

  const text3 = banner.textContent.replace(/\s+/g, ' ').trim()
  check(round3.toSend === 0, `全部未变时不上传任何文件（实际 ${round3.toSend}）`)
  check(round3.planned?.unchanged === 3, `报告「未变 3」（实际 ${round3.planned?.unchanged}）`)
  check(/不需要上传/.test(text3), '明确告诉用户不用传', text3.slice(0, 160))
  check(((await api('/api/v1/inbox')).body?.data?.total ?? 0) === 0, '暂存区保持为空')

  // ---- 第四轮：少了一个文件 → 只报告，不自动删 ----
  const round4 = await ctl.handleFiles([item(keepName, v1Keep), item(editName, v2Edit)], `文件夹 ${root}/`)
  const missing = round4.planned?.missing ?? []
  check(missing.length === 1, `报告「库里另有 1 份这次没出现」（实际 ${missing.length}）`,
    JSON.stringify(missing))
  check(String(missing[0]?.path ?? '').endsWith(addName), `报告的正是少掉的那份（${missing[0]?.path}）`)

  const stillThere = await findAllDocs(addName)
  check(stillThere.length === 1, '库里那份**没有被自动删除**（删除要人来决定）')

  check(errors.length === 0, '无 jsdom 报错', errors.join(' | '))

  // 收尾：删掉本轮入库的文档
  for (const name of [keepName, editName, addName]) {
    for (const d of await findAllDocs(name)) {
      await api(`/api/v1/docs/${d.id}`, { method: 'DELETE' })
    }
  }
  console.log('  （已清理本轮入库的文档）')
}

/* ============================================================
   大文件分片上传
   ============================================================ */

/**
 * 大文件必须自动走分片。
 *
 * 起因是一次真实的线上失败：Netlify Functions 的请求体上限是 **6MB**，
 * 超过就返回 413，请求根本进不到函数里。而客户端当时允许 20MB，
 * 于是一份十几兆的 PDF 传上去只看到"响应不是 JSON（HTTP 413）"。
 *
 * 这个用例用一个 9MB 的文件走完整的浏览器侧流程：
 * 客户端应当自动切成 3 片（4MB + 4MB + 1MB），服务端拼回来后
 * **哈希必须与本地一致** —— 拼错一片，哈希立刻不同。
 */
async function testChunkedUpload() {
  console.log('\n【大文件：自动分片上传】')

  await cleanStaging()

  const root = `BIG${Date.now()}`
  const name = `${root}-big.pdf`
  const size = 9 * 1024 * 1024
  const bytes = randomBytes(size)
  const file = makeFile(bytes, name, `${root}/${name}`)

  const { ctl, banner, errors } = await mountUploadUi()
  const summary = await ctl.handleFiles([{ file, relPath: `${root}/${name}` }], `文件夹 ${root}/`)
  const text = banner.textContent.replace(/\s+/g, ' ').trim()

  check(summary.uploaded === 1, `9MB 文件上传成功（实际 ${summary.uploaded}）`, text.slice(0, 240))
  check(summary.failed === 0, `没有失败（实际 ${summary.failed}）`, text.slice(0, 240))
  check(errors.length === 0, '无 jsdom 报错', errors.join(' | '))

  const items = ((await api('/api/v1/inbox')).body?.data?.items ?? [])
    .filter((it) => it.originalName === name)
  for (const it of items) stagedIds.add(it.id)

  check(items.length === 1, `暂存区里有 1 条记录（实际 ${items.length}）`)
  check(items[0]?.size === size, `大小完全一致（${items[0]?.size} = ${size}）`)
  check(
    items[0]?.sha256 === createHash('sha256').update(bytes).digest('hex'),
    '拼回来的内容哈希与本地一致（分片没串味、没漏片）',
  )

  // 顺便验一下单片上传被拒时给了人话
  const tooBig = await api(`/api/v1/inbox?name=${root}-huge.pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.alloc(5 * 1024 * 1024, 1),   // 5MB > 服务端单片上限 4MB
  })
  check(tooBig.status === 400, `超过单片上限被拒（${tooBig.status}）`)
  check(/分片/.test(tooBig.body?.error?.message ?? ''),
    '拒绝时提示改用分片（而不是一句"太大"）', tooBig.body?.error?.message)
}

/* ============================================================
   入库阶段：来源路径
   ============================================================ */

/**
 * 跑一次 process-pending（子进程），并把它说的话带回来。
 *
 * 沙箱下 Node 用管道捕获子进程输出会 EPERM，所以重定向到文件再读 ——
 * 失败时能直接看到它为什么跳过/失败，不用猜。
 *
 * @param {string[]} args - 额外参数
 * @returns {Promise<{code:number, output:string}>} 退出码与输出
 */
async function processPending(args = []) {
  const logFile = join(tmpdir(), `rndb-pending-${Date.now()}.log`)
  const fd = openSync(logFile, 'w')
  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(ROOT, 'scripts', 'process-pending.mjs'), ...args], {
        cwd: ROOT,
        stdio: ['ignore', fd, fd],
        env: testChildEnv(),
      })
      child.on('error', reject)
      child.on('exit', (c) => resolve(c ?? 1))
    })
    return { code, output: readFileSync(logFile, 'utf8') }
  } finally {
    closeSync(fd)
    rmSync(logFile, { force: true })
  }
}

async function testIngestProvenance() {
  console.log('\n【入库：来源路径写进 sourcePath】')

  // 自己造数据，不依赖前面用例留下的暂存记录（否则一改顺序就废）
  await cleanStaging()
  const root = `PROV${Date.now()}`
  const name = `${root}-note.md`
  const up = await upload(`${root}/${name}`, `${root} 来源路径测试`)
  check(up.status === 200, `上传成功（${up.status}）`)

  const { code, output } = await processPending(['--no-ai'])
  check(code === 0, `process-pending 退出码 ${code}`)
  if (!/入库 1 份/.test(output)) {
    console.log(`      （process-pending 输出：${output.split('\n').filter((l) => l.trim()).slice(-4).join(' / ')}）`)
  }

  const docs = await findAllDocs(name)
  check(docs.length === 1, `入库了 ${docs.length} 份测试文档（期望 1）`)
  if (docs.length === 0) return

  const detail = await api(`/api/v1/docs/${docs[0].id}`)
  const sp = String(detail.body?.data?.sourcePath ?? '')
  check(sp === `upload://${root}/${name}`, `sourcePath 是上传时的相对路径（${sp}）`)

  // 收尾：删掉测试文档
  for (const d of docs) {
    await api(`/api/v1/docs/${d.id}`, { method: 'DELETE' })
  }
  console.log(`  （已清理 ${docs.length} 份测试文档）`)
}

async function main() {
  console.log('▸ 渡·资·集 整文件夹上传回归测试')
  console.log(`  后端 ${BASE}\n`)

  try {
    const health = await api('/api/v1/health')
    if (!health.body?.ok) throw new Error('health 未返回 ok')
    console.log(`  存储 ${health.body.data.store.mode} / 现有文档 ${health.body.data.docCount} 份\n`)
  } catch (err) {
    console.error(`  无法连接开发服务器：${err.message}`)
    console.error('  请先运行：node scripts/dev-server.mjs\n')
    process.exit(1)
  }

  try {
    await testApi()
    await testBrowserCollect()
    await testBrowserFolderPicker()
    await testChunkedUpload()
    await testIncrementalSync()
    await testIngestProvenance()
  } finally {
    const n = await cleanStaging()
    if (n) console.log(`\n  已清理暂存区 ${n} 份测试文件`)
  }

  console.log('\n────────────────────────────────')
  console.log(`  通过 ${passed} / 失败 ${failed}`)
  console.log('')
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n测试自身出错：', err)
  process.exit(1)
})
