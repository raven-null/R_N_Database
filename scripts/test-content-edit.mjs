/**
 * 内容编辑回归测试：PUT /api/v1/docs/{id}/content。
 *
 * ## 为什么这个测试必须存在
 *
 * 「在网页上改内容」这条链路比以前所有写操作都长：
 *   原件 → 正文 → 预览件 → 元数据（sha/size/字数）→ **倒排索引**
 *
 * 中间任何一环漏掉都不会报错，只会**静默错**：
 *   - 漏了预览件 → 改完预览还是旧的，用户以为没保存
 *   - 漏了索引旧词条 → 旧内容里的词永远搜得到、打开却看不到
 *   - 漏了正文 → /text 还是旧内容，AI 与检索全部读旧数据
 *
 * 所以每一项都要断言到，尤其是**「旧标记搜不到了」**这一条 ——
 * 它专门验证索引增量更新用的是正确的旧正文。
 *
 * 全程自造临时文档、结束即删，不碰库里已有资料。
 *
 * 用法：
 *   node scripts/dev-server.mjs        # 另一个终端
 *   node scripts/test-content-edit.mjs
 *
 * @module scripts/test-content-edit
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { testChildEnv } from './lib/test-env.mjs'

const ROOT = process.cwd()
const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:8899'

/** 旧/新内容里的独特标记，用于验证索引是否真的换掉了词条。 */
const MARK_OLD = `quixoldmarker${Date.now()}`
const MARK_NEW = `quixnewmarker${Date.now()}`
const MARK_MD_NEW = `quixmdnewmarker${Date.now()}`

/**
 * 三份测试文档的基本名。
 *
 * 刻意用不同的基本名：标题是从**文件名**推出来的（入库时的既定规则），
 * 三个文件同名的话标题就会撞车，`findDoc` 拿不到想测的那一份。
 */
const BASE_NAME = `RNDBEDIT${Date.now()}`
const CODE_TITLE = `${BASE_NAME} code`
const MD_TITLE = `${BASE_NAME} note`
const CSV_TITLE = `${BASE_NAME} 表格`

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
 * 发 API 请求。
 * @param {string} path - 路径
 * @param {object} [opts] - { method, body, raw }
 * @returns {Promise<{status:number, body:object, text:string, headers:Headers}>} 响应
 */
async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method ?? 'GET',
    headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: opts.body !== undefined
      ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body))
      : undefined,
  })
  const text = await res.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    /* 非 JSON（原件/预览件） */
  }
  return { status: res.status, body, text, headers: res.headers }
}

/**
 * 跑一次入库（子进程）。
 * @param {string} file - 文件路径
 * @returns {Promise<number>} 退出码
 */
function ingest(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'scripts', 'ingest.mjs'), file, '--no-ai'], {
      cwd: ROOT,
      stdio: 'ignore',
      env: testChildEnv(),
    })
    child.on('error', reject)
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

/**
 * 按标题找文档。
 * @param {string} title - 标题
 * @returns {Promise<object|null>} 列表项
 */
async function findDoc(title) {
  const { body } = await api(`/api/v1/docs?q=${encodeURIComponent(title)}&limit=50`)
  return (body?.data?.items ?? []).find((d) => d.title.includes(title)) ?? null
}

/**
 * 检索是否命中某份文档。
 * @param {string} q - 查询串
 * @param {string} id - 文档 id
 * @returns {Promise<boolean>} 是否命中
 */
async function searchHits(q, id) {
  const { body } = await api(`/api/v1/search?q=${encodeURIComponent(q)}`)
  return (body?.data?.items ?? []).some((i) => i.id === id)
}

async function main() {
  console.log('▸ 渡·资·集 内容编辑回归测试')
  console.log(`  后端 ${BASE}\n`)

  try {
    const { body } = await api('/api/v1/health')
    if (!body?.ok) throw new Error('health 未返回 ok')
    console.log(`  存储 ${body.data.store.mode} / 现有文档 ${body.data.docCount} 份\n`)
  } catch (err) {
    console.error(`  无法连接开发服务器：${err.message}`)
    console.error('  请先运行：node scripts/dev-server.mjs\n')
    process.exit(1)
  }

  const workDir = mkdtempSync(join(tmpdir(), 'rndb-edit-'))
  const codeFile = join(workDir, `${BASE_NAME}-code.ts`)
  const mdFile = join(workDir, `${BASE_NAME}-note.md`)
  const csvFile = join(workDir, `${BASE_NAME}-表格.csv`)

  /** 测试过程中造出来的文档 id，收尾时无条件删除。 */
  const created = []

  const ORIGINAL = `const ${MARK_OLD} = 1

export function greet(name: string): string {
  return \`hi \${name}\`
}
`
  const EDITED = `const ${MARK_NEW} = 2

export function greet(name: string): string {
    return \`hello \${name}\`
}
`

  try {
    /* ---------- 准备：入库一份代码文件 ---------- */
    console.log('【准备：入库一份代码文件】')
    writeFileSync(codeFile, ORIGINAL, 'utf8')
    const code = await ingest(codeFile)
    check(code === 0, `入库子进程退出码 ${code}（期望 0）`)

    const found = await findDoc(CODE_TITLE)
    check(Boolean(found), '代码文件已入库')
    if (!found) {
      console.log('\n  代码文件没入库成功，后续测试无法进行\n')
      return
    }
    created.push(found.id)
    const docId = found.id

    check(found.type === 'code', `类型识别为 code（实际 ${found.type}）`)
    check(found.ext === 'ts', `扩展名 ts（实际 ${found.ext}）`)
    check(found.previewKind === 'code', `previewKind=code（实际 ${found.previewKind}）`)
    console.log(`  · id=${docId} 体积=${found.size} 正文=${found.hasText}\n`)

    /* ---------- 入库时的预览件 ---------- */
    console.log('【入库时的预览件】')
    const pv0 = await api(`/api/v1/docs/${docId}/preview`)
    check(pv0.status === 200, `预览件可访问（${pv0.status}）`)
    check(pv0.text.includes(MARK_OLD), '预览件里有原内容')
    check(/hljs/.test(pv0.text), '预览件带语法高亮样式（hljs）')
    check(/class="gutter"/.test(pv0.text), '预览件带行号栏')
    check(
      (pv0.headers.get('content-security-policy') ?? '').includes("default-src 'none'"),
      '预览件带严格 CSP',
    )

    /* ---------- 原件缓存策略 ---------- */
    console.log('\n【原件缓存策略（内容可改，不能 immutable）】')
    const f0 = await api(`/api/v1/docs/${docId}/file`)
    check(f0.text === ORIGINAL, '原件内容与写入的一致')
    const cc0 = f0.headers.get('cache-control') ?? ''
    check(!/immutable/.test(cc0), `不带 ?v= 时不可 immutable（实际 ${cc0}）`)
    check(/no-cache/.test(cc0), `不带 ?v= 时要求回源校验（实际 ${cc0}）`)
    const f0v = await api(`/api/v1/docs/${docId}/file?v=123`)
    check(/immutable/.test(f0v.headers.get('cache-control') ?? ''), '带 ?v= 才允许长缓存')

    /* ---------- 编辑内容 ---------- */
    console.log('\n【PUT 改内容】')
    const before = await api(`/api/v1/docs/${docId}`)
    const sha0 = before.body?.data?.sha256

    const put = await api(`/api/v1/docs/${docId}/content`, {
      method: 'PUT',
      body: { content: EDITED },
    })
    check(put.status === 200, `PUT 返回 200（实际 ${put.status}）`, put.body?.error?.message)
    check(put.body?.data?.index?.ok === true, '索引增量更新成功', put.body?.data?.indexError ?? '')
    check(put.body?.data?.sha256 !== sha0, '内容哈希已变化')
    check(put.body?.data?.doc?.id === docId, 'id 保持不变（内容寻址的 id 不随编辑漂移）')

    const after = await api(`/api/v1/docs/${docId}`)
    check(after.body?.data?.sha256 !== sha0, '元数据里 sha256 已更新')
    check(after.body?.data?.size === Buffer.byteLength(EDITED), `元数据 size 已更新（${after.body?.data?.size}）`)
    check(after.body?.data?.textChars === EDITED.length, `元数据 textChars 已更新（${after.body?.data?.textChars}）`)
    check(after.body?.data?.updatedAt !== before.body?.data?.updatedAt, 'updatedAt 已推进（预览缓存随之失效）')
    check(after.body?.data?.title === before.body?.data?.title, '标题等元数据没被顺手改掉')

    /* ---------- 原件已换 ---------- */
    console.log('\n【原件与正文】')
    const f1 = await api(`/api/v1/docs/${docId}/file`)
    check(f1.text === EDITED, '原件内容已换成新内容')
    check(f1.text !== ORIGINAL, '原件不是旧内容')

    const t1 = await api(`/api/v1/docs/${docId}/text`)
    const body1 = (t1.body?.data?.pages ?? []).join('\n')
    check(body1.includes(MARK_NEW), '抽取正文里有新内容')
    check(!body1.includes(MARK_OLD), '抽取正文里没有旧内容')
    check(body1.includes('    return'), '代码正文保留了 4 空格缩进（没被清洗破坏）')

    /* ---------- 预览件已重渲染 ---------- */
    console.log('\n【预览件重渲染】')
    const pv1 = await api(`/api/v1/docs/${docId}/preview`)
    check(pv1.status === 200, `预览件仍可访问（${pv1.status}）`)
    check(pv1.text.includes(MARK_NEW), '预览件里有新内容')
    check(!pv1.text.includes(MARK_OLD), '预览件里没有旧内容')
    check(/hljs/.test(pv1.text), '重渲染后仍带语法高亮')

    /* ---------- 索引真的换了词条（最关键） ---------- */
    console.log('\n【索引增量更新】')
    check(await searchHits(MARK_NEW, docId), '新内容里的词能搜到')
    check(!(await searchHits(MARK_OLD, docId)), '旧内容里的词**搜不到了**（旧词条已被清掉）')

    /* ---------- 内容没变 ---------- */
    console.log('\n【重复提交同样的内容】')
    const same = await api(`/api/v1/docs/${docId}/content`, {
      method: 'PUT',
      body: { content: EDITED },
    })
    check(same.status === 200, `返回 200（实际 ${same.status}）`)
    check(same.body?.data?.unchanged === true, '标记 unchanged=true（不做无谓的写与重渲染）')

    /* ---------- 乐观并发 ---------- */
    console.log('\n【乐观并发（两个标签页同时改）】')
    const stale = await api(`/api/v1/docs/${docId}/content`, {
      method: 'PUT',
      body: { content: `${EDITED}\n// 来自另一个标签页\n`, baseUpdatedAt: '2020-01-01T00:00:00.000Z' },
    })
    check(stale.status === 409, `基于旧版本提交返回 409（实际 ${stale.status}）`, stale.body?.error?.message)
    check(stale.body?.error?.code === 'CONFLICT', `错误码 CONFLICT（实际 ${stale.body?.error?.code}）`)

    const rightBase = await api(`/api/v1/docs/${docId}`, { method: 'GET' })
    const okBase = await api(`/api/v1/docs/${docId}/content`, {
      method: 'PUT',
      body: { content: `${EDITED}\n// 基于最新版本\n`, baseUpdatedAt: rightBase.body?.data?.updatedAt },
    })
    check(okBase.status === 200, `基于最新版本提交成功（实际 ${okBase.status}）`, okBase.body?.error?.message)

    /* ---------- 参数校验 ---------- */
    console.log('\n【参数校验】')
    const noContent = await api(`/api/v1/docs/${docId}/content`, { method: 'PUT', body: {} })
    check(noContent.status === 400, `缺 content 字段返回 400（实际 ${noContent.status}）`)

    const wrongType = await api(`/api/v1/docs/${docId}/content`, {
      method: 'PUT',
      body: { content: 123 },
    })
    check(wrongType.status === 400, `content 不是字符串返回 400（实际 ${wrongType.status}）`)

    const badJson = await api(`/api/v1/docs/${docId}/content`, { method: 'PUT', body: '{不是 json' })
    check(badJson.status === 400, `请求体不是 JSON 返回 400（实际 ${badJson.status}）`)

    const wrongMethod = await api(`/api/v1/docs/${docId}/content`, { method: 'POST', body: {} })
    check(wrongMethod.status === 400, `POST 到 /content 被拒（实际 ${wrongMethod.status}）`)

    const missing = await api('/api/v1/docs/deadbeef0000/content', {
      method: 'PUT',
      body: { content: 'x' },
    })
    check(missing.status === 404, `改不存在的文档返回 404（实际 ${missing.status}）`)

    /* ---------- 不可编辑的类型 ---------- */
    console.log('\n【不可编辑的类型（csv/pdf/docx）要明确拒绝】')
    // 内容里带上本次运行的名字：入库按 SHA-256 去重，
    // 内容一字不差的两次运行会被判为「已存在」而跳过
    writeFileSync(csvFile, `name,value\n${BASE_NAME},2\n`, 'utf8')
    const csvIngest = await ingest(csvFile)
    check(csvIngest === 0, `csv 入库退出码 ${csvIngest}`)
    const csvDoc = await findDoc(CSV_TITLE)
    if (csvDoc) {
      created.push(csvDoc.id)
      const csvPut = await api(`/api/v1/docs/${csvDoc.id}/content`, {
        method: 'PUT',
        body: { content: 'a,b\n3,4\n' },
      })
      check(csvPut.status === 400, `csv 被拒（实际 ${csvPut.status}）`, csvPut.body?.error?.message)
      check(
        /csv/.test(csvPut.body?.error?.message ?? ''),
        '错误信息里点明了类型',
        csvPut.body?.error?.message,
      )
    } else {
      check(false, 'csv 测试文档入库了')
    }

    /* ---------- Markdown 也走同一条路 ---------- */
    console.log('\n【Markdown：改内容后渲染件同步】')
    writeFileSync(mdFile, `# ${MD_TITLE}\n\n原内容 ${MARK_OLD}\n`, 'utf8')
    const mdIngest = await ingest(mdFile)
    check(mdIngest === 0, `md 入库退出码 ${mdIngest}`)
    const mdDoc = await findDoc(MD_TITLE)
    if (mdDoc) {
      created.push(mdDoc.id)
      const mdPut = await api(`/api/v1/docs/${mdDoc.id}/content`, {
        method: 'PUT',
        body: { content: `# ${MD_TITLE}\n\n## 新增小节\n\n新内容 ${MARK_MD_NEW}\n` },
      })
      check(mdPut.status === 200, `md 编辑成功（实际 ${mdPut.status}）`, mdPut.body?.error?.message)

      const mdPv = await api(`/api/v1/docs/${mdDoc.id}/preview`)
      check(mdPv.text.includes('<h2'), '渲染件里出现了新的二级标题')
      check(mdPv.text.includes(MARK_MD_NEW), '渲染件里是新内容')

      const mdSrc = await api(`/api/v1/docs/${mdDoc.id}/preview?mode=source`)
      check(mdSrc.text.includes('## 新增小节'), '源码视图显示的是新源码')

      check(await searchHits(MARK_MD_NEW, mdDoc.id), 'md 新内容进了索引')
      check(!(await searchHits(MARK_OLD, mdDoc.id)), 'md 旧内容已从索引清除')
    } else {
      check(false, 'markdown 测试文档入库了')
    }
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
    // 收尾：删掉本次造的所有文档。
    // 除了记录过的 id，再按标题前缀扫一遍 —— 测试中途失败时
    // 有文档可能「入库成功但没来得及记下 id」，漏掉就会污染库
    for (const id of created) {
      const still = await api(`/api/v1/docs/${id}`)
      if (still.status === 200) await api(`/api/v1/docs/${id}`, { method: 'DELETE' })
    }
    try {
      const { body } = await api(`/api/v1/docs?q=${encodeURIComponent(BASE_NAME)}&limit=200`)
      for (const d of body?.data?.items ?? []) {
        if (String(d.title).startsWith(BASE_NAME)) {
          await api(`/api/v1/docs/${d.id}`, { method: 'DELETE' })
        }
      }
    } catch {
      /* 忽略 */
    }
    console.log('\n  （测试文档已清理）')
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
