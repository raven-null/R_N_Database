/**
 * 文档模型与格式能力表的单元测试（不需要起服务器）。
 *
 * 这两处是「一个字段缺失就静默改行为」的高危区：
 * 可见性缺字段曾经让整个库在站点上消失、格式能力散落在分支里曾经让
 * `.md` 走错路径。所以这里逐条把约定钉住。
 *
 * @module scripts/test-model
 */

import {
  normalizeDoc, checkInvariants, migrateDoc,
  SCHEMA_VERSION, DEFAULT_VISIBILITY,
} from '../netlify/functions/_lib/doc-model.mjs'
import {
  capabilitiesOf, detectType, isEditableType, canExtractText,
  mimeOf, rejectionReason, titleFromFilename, SUPPORTED_GROUPS,
} from '../netlify/functions/_lib/file-types.mjs'

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

/** 造一份最小可用元数据。 */
const base = {
  id: 'abc123def456',
  originalName: 'T7_继承.java',
  type: 'code',
  ext: 'java',
  size: 770,
  title: 'T7 继承',
}

function main() {
  console.log('▸ 文档模型测试\n')

  /* ---------- 默认值 ---------- */
  console.log('【行为开关的默认值】')
  const d = normalizeDoc({ ...base })
  check(d.visibility === DEFAULT_VISIBILITY, `可见性默认 private（${d.visibility}）`)
  check(DEFAULT_VISIBILITY === 'private', '策略常量就是 private')
  check(d.status === 'active', `状态默认 active（${d.status}）`)
  check(d.rev === 1, `rev 默认 1（${d.rev}）`)
  check(d.needsReview === false, 'needsReview 默认 false')
  check(d.schemaVersion === SCHEMA_VERSION, `schemaVersion=${d.schemaVersion}`)
  check(checkInvariants(d).length === 0, '规范化产物满足全部不变式',
    JSON.stringify(checkInvariants(d)))

  console.log('\n【非法值回退】')
  check(normalizeDoc({ ...base, visibility: 'secret' }).visibility === 'private',
    'visibility 非法时回退到 private，而不是保留脏值')
  check(normalizeDoc({ ...base, status: 'deleted' }).status === 'deleted',
    '合法状态被保留')
  check(normalizeDoc({ ...base, rev: -3 }).rev === 1, '非法 rev 回退到 1')
  check(normalizeDoc({ ...base, size: '770' }).size === 770, '字符串 size 被转成数字')
  check(normalizeDoc({ ...base, size: 'abc' }).size === 0, '非数字 size 回退到 0')

  console.log('\n【数组归一】')
  check(JSON.stringify(normalizeDoc({ ...base, tags: '学习' }).tags) === '["学习"]',
    '单个字符串标签变成数组')
  check(JSON.stringify(normalizeDoc({ ...base, tags: ['学习', '学习', ' ', '测试'] }).tags) === '["学习","测试"]',
    '标签去重、去空白、保序')
  check(JSON.stringify(normalizeDoc({ ...base, categories: null }).categories) === '[]',
    'null 分类变成空数组')

  console.log('\n【标题兜底】')
  check(normalizeDoc({ id: 'x1', originalName: 'L23_集合框架.java', type: 'code' }).title === 'L23 集合框架',
    '没有 title 时从文件名推')
  check(titleFromFilename('a/b/c_笔记.md') === 'c 笔记', '文件名推标题去路径去扩展名')

  console.log('\n【结构化视图与旧字段并存】')
  const withText = normalizeDoc({ ...base, textChars: 1234, previewKind: 'code' })
  check(withText.text.chars === 1234 && withText.textChars === 1234,
    'text.chars 与 textChars 一致（过渡期并存）')
  check(withText.text.hasText === true, '有正文时 hasText 为真')
  check(withText.preview.kind === 'code' && withText.previewKind === 'code',
    'preview.kind 与 previewKind 一致')
  check(withText.index && withText.index.pending === false, '索引进度块存在且默认不 pending')

  console.log('\n【未知字段不丢】')
  const extra = normalizeDoc({ ...base, pinyin: 't7 jicheng', ingestedBy: 'server', webView: 'docx' })
  check(extra.pinyin === 't7 jicheng' && extra.ingestedBy === 'server' && extra.webView === 'docx',
    'pinyin / ingestedBy / webView 等既有字段被保留（迁移不能丢数据）')

  /* ---------- 迁移语义 ---------- */
  console.log('\n【迁移：历史文档默认公开】')
  const old = { id: 'old1', title: '旧资料', type: 'pdf', size: 100, categories: ['学习资料'] }
  const mig = migrateDoc(old)
  check(mig.doc.visibility === 'public',
    `缺 visibility 的历史文档补成 public（${mig.doc.visibility}）—— 修数据不改可见范围`)
  check(mig.changed === true, '确实发生了升级')
  const mig2 = migrateDoc(mig.doc)
  check(mig2.changed === false, '已升级的文档再迁移一次是空操作（幂等）')
  const priv = migrateDoc({ id: 'p1', title: '私有件', type: 'pdf', size: 1, visibility: 'private' })
  check(priv.doc.visibility === 'private', '已有的 private 不会被迁移覆盖')

  /* ---------- 能力表 ---------- */
  console.log('\n【格式能力表】')
  check(capabilitiesOf('pdf').preview === 'browser', 'PDF 用浏览器原生预览')
  check(capabilitiesOf('md').preview === 'markdown' && capabilitiesOf('md').editable === true,
    'Markdown 可渲染预览、可编辑')
  check(capabilitiesOf('docx').extract === 'docx', 'Word 能抽正文')
  check(capabilitiesOf('doc-legacy').extract === null, '旧版 .doc 抽不出正文')
  check(capabilitiesOf('doc-legacy').preview === 'none', '旧版 .doc 无预览')
  check(Boolean(capabilitiesOf('doc-legacy').legacyHint), '旧格式带明确的转换提示')
  check(canExtractText('pdf') === true && canExtractText('ppt-legacy') === false,
    'canExtractText 与能力表一致')
  check(isEditableType('md') && isEditableType('code') && isEditableType('txt'),
    'md / code / txt 可在网页编辑')
  check(!isEditableType('csv') && !isEditableType('pdf'), 'csv 与 pdf 不可编辑')
  check(mimeOf('xlsx').includes('spreadsheetml'), 'xlsx 的 MIME 正确')

  console.log('\n【类型识别与拒收】')
  check(detectType('a/b/笔记.MD') === 'md', '扩展名大小写不敏感')
  check(detectType('foo.unknownext') === null, '未知扩展名返回 null')
  check(rejectionReason('a.zip')?.includes('解压'), 'zip 被拒收并说明"会解压"')
  check(rejectionReason('a.png')?.includes('图片'), '图片被拒收并说明原因')
  check(rejectionReason('a.pem') !== null, '私钥类被拒收')
  check(rejectionReason('a.pdf') === null, '正常类型没有拒收理由')

  console.log('\n【支持清单】')
  check(SUPPORTED_GROUPS.length >= 5, `按类别给出支持范围（${SUPPORTED_GROUPS.map((g) => g.label).join('/')}）`)
  check(SUPPORTED_GROUPS.some((g) => g.label === 'Markdown'), '清单里明确有 Markdown')

  console.log('\n────────────────────────────────')
  console.log(`  通过 ${passed} / 失败 ${failed}`)
  console.log('')
  process.exit(failed === 0 ? 0 : 1)
}

main()
