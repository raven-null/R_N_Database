/**
 * 标签打分与全库重分类测试。
 *
 * 标签是这个库最被人看的一栏，也是最容易被写坏的一栏：
 * 老实现把正文里撞到的关键词直接当标签，一份编码规范能拿到 8 个含「物理」
 * 的标签。所以这里把规则逐条钉死：权重顺序、门槛、上限、排除项、可解释性。
 *
 * 前半段是纯函数（不用服务器），后半段测 `POST /reclassify`。
 *
 * @module scripts/test-tags
 */

const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:8899'
const MARK = `TAGTEST${Date.now()}`

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
 * 发 JSON 请求。
 * @param {string} path - 路径
 * @param {object} [opts] - { method, body }
 * @returns {Promise<{status:number, body:object|null}>} 响应
 */
async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method ?? 'GET',
    headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, body }
}

/** 测试用词表。 */
const TAXONOMY = {
  categories: [{ name: '学习资料' }, { name: '技术参考' }, { name: '未归类' }],
  tags: ['Java', '面向对象', '继承', '多态', '测试', '设计', '英语', '物理', '数据库', '学习资料'],
  _tagStoplist: { words: ['设计'] },
}

/**
 * 取标签名数组。
 * @param {Array<{name:string}>} scored - 打分结果
 * @returns {string[]} 名字
 */
const names = (scored) => scored.map((t) => t.name)

async function main() {
  console.log('▸ 标签打分与重分类测试\n')

  const { scoreTags, tagNames, TAG_RULES } = await import('../netlify/functions/_lib/tag-score.mjs')

  /* ---------- 权重顺序 ---------- */
  console.log('【权重与来源】')
  const dirHit = scoreTags({
    title: 'x', dirNames: ['继承测试'], categories: [], taxonomy: TAXONOMY,
  })
  check(names(dirHit).includes('继承'), `目录命中就够（${names(dirHit).join(' ')}）`)
  check(dirHit.find((t) => t.name === '继承')?.from.includes('dir'), '标出来源是 dir')

  const titleHit = scoreTags({
    title: 'Java 多态笔记', categories: [], taxonomy: TAXONOMY,
  })
  check(names(titleHit).includes('Java'), `标题命中就够（${names(titleHit).join(' ')}）`)

  const dirWins = scoreTags({
    title: 'Java', dirNames: ['继承课'], categories: [], taxonomy: TAXONOMY,
  })
  check(dirWins[0]?.name === '继承', `目录权重高于标题（首选 ${dirWins[0]?.name}）`)

  /* ---------- 正文门槛 ---------- */
  console.log('\n【正文门槛】')
  const oneHit = scoreTags({
    title: '无关标题', body: '这里提到一次 Java 而已', categories: [], taxonomy: TAXONOMY,
  })
  check(!names(oneHit).includes('Java'), '正文只出现一次不算（不产生标签）')

  const manyHits = scoreTags({
    title: '无关标题', body: '多态 '.repeat(60), categories: [], taxonomy: TAXONOMY,
  })
  check(names(manyHits).includes('多态'), `正文反复出现才算（${names(manyHits).join(' ')}）`)
  check((manyHits[0]?.from ?? []).some((f) => f.startsWith('body:')), '标出来源是 body:n')

  // 只靠正文不够：几十次的文体性重复不该自动成标签
  const bodyOnlyWeak = scoreTags({
    title: '无关标题', body: '英语 '.repeat(12), categories: [], taxonomy: TAXONOMY,
  })
  check(!names(bodyOnlyWeak).includes('英语'), '正文十几次还不够（光靠正文不足以成标签）')

  /* ---------- 排除项 ---------- */
  console.log('\n【排除项】')
  const stopHit = scoreTags({
    title: '设计模式详解', dirNames: ['设计'], body: '设计 '.repeat(30), categories: [], taxonomy: TAXONOMY,
  })
  check(!names(stopHit).includes('设计'), `停用词不参与自动打标（${names(stopHit).join(' ') || '空'}）`)

  const catHit = scoreTags({
    title: '学习资料', dirNames: ['学习资料'], categories: ['学习资料'], taxonomy: TAXONOMY,
  })
  check(!names(catHit).includes('学习资料'), '标签不重复分类名')

  /* ---------- 上限与稳定 ---------- */
  console.log('\n【上限】')
  const many = scoreTags({
    title: 'Java 面向对象 继承 多态 测试 英语 物理 数据库',
    dirNames: ['Java', '面向对象', '继承', '多态', '测试', '英语', '物理', '数据库'],
    categories: [], taxonomy: TAXONOMY,
  })
  check(many.length <= TAG_RULES.MAX_TAGS, `最多 ${TAG_RULES.MAX_TAGS} 个（实际 ${many.length}）`)
  check(many.every((t) => t.score >= TAG_RULES.MIN_SCORE), '每个都在阈值以上')
  const twice = scoreTags({
    title: 'Java 面向对象 继承 多态 测试 英语 物理 数据库',
    dirNames: ['Java', '面向对象', '继承', '多态', '测试', '英语', '物理', '数据库'],
    categories: [], taxonomy: TAXONOMY,
  })
  check(JSON.stringify(names(many)) === JSON.stringify(names(twice)), '两次结果完全一致（可复现）')
  check(tagNames(twice).length === twice.length, 'tagNames 与打分结果长度一致')

  /* ---------- 拉丁词边界 ---------- */
  console.log('\n【词边界】')
  const boundary = scoreTags({
    title: 'javascript 教程', body: 'javascript '.repeat(10), categories: [], taxonomy: TAXONOMY,
  })
  check(!names(boundary).includes('Java'), 'js 里的 java 不算命中 java（词边界生效）')

  /* ---------- 接口：重分类 ---------- */
  console.log('\n【接口：POST /reclassify】')
  const health = await api('/api/v1/health')
  if (health.status !== 200) {
    console.error(`  开发服务器没起来（${BASE}）。先跑 npm run dev\n`)
    process.exit(2)
  }

  // 造一份"标签很脏"的文档：手动塞一堆标签，再看重分类能不能清掉
  const created = []
  try {
    const made = await api('/api/v1/docs', {
      method: 'POST',
      body: { title: `${MARK} 继承练习`, content: `# ${MARK}\n\n继承与多态。\n` },
    })
    const doc = made.body?.data?.doc
    if (doc?.id) created.push(doc.id)
    check(Boolean(doc?.id), '造了一份测试笔记')

    await api(`/api/v1/docs/${doc.id}`, {
      method: 'PATCH',
      body: { tags: ['甲', '乙', '丙', '丁', '戊', '己'], visibility: 'private' },
    })
    const dirty = await api(`/api/v1/docs/${doc.id}`)
    check((dirty.body?.data?.tags ?? []).length === 6, '先把它标签搞脏（6 个）')

    const dry = await api('/api/v1/reclassify', { method: 'POST', body: { dryRun: true } })
    check(dry.status === 200, `dryRun 成功（HTTP ${dry.status}）`)
    check(typeof dry.body?.data?.tagsChanged === 'number', '报告会改多少份')
    const afterDry = await api(`/api/v1/docs/${doc.id}`)
    check((afterDry.body?.data?.tags ?? []).length === 6, 'dryRun 不会真的改数据')

    const real = await api('/api/v1/reclassify', { method: 'POST', body: {} })
    check(real.status === 200, `真跑成功（HTTP ${real.status}）`)
    check((real.body?.data?.total ?? 0) > 0, `扫描了 ${real.body?.data?.total} 份`)

    const afterReal = await api(`/api/v1/docs/${doc.id}`)
    const tagsNow = afterReal.body?.data?.tags ?? []
    // 这份被 PATCH 过 → classifySource 带 manual → 受保护，不该被改
    check(tagsNow.length === 6, `人工改过的文档被跳过（标签仍 ${tagsNow.length} 个）`)
    check((real.body?.data?.skippedManual ?? 0) >= 1, `报告里记了跳过 ${real.body?.data?.skippedManual} 份`)

    const wrongMethod = await api('/api/v1/reclassify')
    check(wrongMethod.status === 400, `GET 被拒（HTTP ${wrongMethod.status}）`)
  } finally {
    let removed = 0
    for (const id of created) {
      const r = await api(`/api/v1/docs/${id}`, { method: 'DELETE' })
      if (r.status === 200) removed += 1
    }
    if (removed) console.log(`\n  已清理 ${removed} 份测试文档`)
  }

  console.log('\n────────────────────────────────')
  console.log(`  通过 ${passed} / 失败 ${failed}`)
  console.log('')
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n测试自身出错：', err?.message ?? err)
  process.exit(2)
})
