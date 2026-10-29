/**
 * 分类回归测试。
 *
 * 为什么必须有它：调分类规则时，我手头用来测的语料是 246 份**代码项目文档**，
 * 而资料库的真实用途是**办公文档**（合同、发票、证件、体检报告）。
 * 只看那份语料的分布变化会误导 —— 把「协议」降权能在代码语料上消掉误判，
 * 却可能把「租房协议」也打错。这个测试用**真实场景的标题与正文**锁住行为，
 * 同时把已修复的同形词误判固化成防回退用例。
 *
 * 用例分三类：
 *   expect     —— 必须包含这些分类
 *   notExpect  —— 必须不包含这些分类（防回退）
 *   anyOf      —— 至少命中其中一个即可（文档本身跨类，合理答案不止一个）
 *
 * 用法：
 *   node scripts/test-classify.mjs
 *
 * @module scripts/test-classify
 */

import { join } from 'node:path'
import { loadTaxonomy, classifyByRules } from './lib/classify.mjs'

const ROOT = process.cwd()
const taxonomy = loadTaxonomy(join(ROOT, 'config', 'taxonomy.json'))

/**
 * 用例表。body 是缩写的正文片段，保留真实文档里最具判别力的词。
 * @type {Array<{name:string, title:string, body:string, expect?:string[], notExpect?:string[], anyOf?:string[]}>}
 */
const CASES = [
  /* ---------- 真实办公文档：必须分对 ---------- */
  {
    name: '房租发票',
    title: '2026年3月房租发票.pdf',
    body: '增值税普通发票 购买方 销售方 金额 ￥3500.00 税率 付款方式 转账 备注 房租',
    expect: ['票据财务'],
  },
  {
    name: '房屋租赁合同',
    title: '房屋租赁合同.pdf',
    body: '甲方（出租方）乙方（承租方）经双方协商一致订立本合同 租金 押金 签字 盖章 日期',
    expect: ['合同证照'],
  },
  {
    name: '租房协议（同形词正例）',
    title: '租房协议.pdf',
    body: '甲方乙方就房屋租赁事宜达成如下协议 租期 押金 违约 签字',
    expect: ['合同证照'],
  },
  {
    name: '体检报告',
    title: '2026年体检报告.pdf',
    body: '体检中心 血常规 化验结果 谷丙转氨酶 门诊 医师建议复查',
    expect: ['健康医疗'],
  },
  {
    name: '英语四级真题',
    title: '英语四级2026年6月真题.pdf',
    body: 'Part I Writing 听力 阅读理解 考试时间 答题卡 作文',
    expect: ['学习资料'],
  },
  {
    name: '个人简历',
    title: '简历第一版.pdf',
    body: '工作经历 教育背景 求职意向 面试 期望薪资 项目经验',
    expect: ['求职职场'],
  },
  {
    name: '洗碗机说明书',
    title: '洗碗机使用说明书.pdf',
    body: '安装步骤 操作说明 规格参数 注意事项 保修 清洗滤网 故障排除',
    expect: ['说明书'],
  },
  {
    name: '项目需求文档',
    title: '工作站改造需求文档.md',
    body: '需求背景 立项 设计方案 评审记录 迭代计划 验收标准 复盘',
    expect: ['项目文档'],
  },
  {
    name: '身份证扫描件',
    title: '身份证正反面.pdf',
    body: '中华人民共和国居民身份证 姓名 住址 公民身份号码 签发机关 有效期限',
    expect: ['合同证照'],
  },
  {
    name: '银行流水',
    title: '招商银行流水2026.pdf',
    body: '账号 交易日期 摘要 存入 支出 余额 对账单 流水号',
    expect: ['票据财务'],
  },

  /* ---------- 同形词防回退：绝不能误判 ---------- */
  {
    name: '防回退·事件流水线（非财务）',
    title: 'events.zh',
    body: '事件流水线 事件流处理 订阅事件流 异步流水线编排 流水线阶段',
    notExpect: ['票据财务'],
  },
  {
    name: '防回退·诊断信息（非医疗）',
    title: '0004 landlock partial notice misclassified child failures',
    body: '诊断信息输出 diagnostics 诊断失败原因 打印诊断 诊断日志',
    notExpect: ['健康医疗'],
  },
  {
    name: '防回退·交互协议（非合同）',
    title: '顶部灵动岛构想',
    body: '交互协议 通信协议 协议适配层 协议解析 握手指令 协议栈',
    notExpect: ['合同证照'],
  },
  {
    name: '防回退·LLM 协议适配（非合同）',
    title: 'adding an llm adapter.zh',
    body: '实现 LLM 协议适配器 协议转换 配置 API 密钥 接口封装 SDK',
    notExpect: ['合同证照'],
  },

  /* ---------- 技术文档：不能被同形词修复误伤 ---------- */
  {
    name: '技术参考不被误伤',
    title: 'API 接口规范.md',
    body: '接口定义 请求参数 返回结构 部署说明 配置项 架构概览 源码位置',
    expect: ['技术参考'],
  },
  {
    name: '说明书不被误伤',
    title: 'config reference',
    body: '配置参数说明 参数含义 默认值 可选参数 使用手册',
    anyOf: ['说明书', '技术参考'],
  },

  /* ---------- 体裁信号：书 / 论文 ----------
   * 起因是三份真实资料入库：一份 307 页的 AI Agent 书、一篇系统分析论文
   * 全都掉进了「项目文档」。根因是**长文里主题词必然饱和** ——
   * 一本书里 设计/架构/方案 每个都会出现（每词最多计 5 次），
   * 泛词类目靠堆量就赢了，而「学习资料」的关键词全是考试那套，
   * 技术书根本不这么写。所以补了一层「体裁」判断。 */
  {
    name: '技术书（章节+致谢）',
    title: '深入理解 AI Agent：设计原理与工程实践.pdf',
    body: '引言 本书结构 本章介绍设计原理与工程实践 本章小结 致谢 示例代码 关键词 目录',
    expect: ['学习资料'],
  },
  {
    name: '学术论文（摘要+参考文献）',
    title: '基于智能技术的计算机网络安全防御系统分析_孔簇簇.pdf',
    body: '摘要 关键词 引言 设计方案 架构 流程 参考文献 结论 论文 章节安排 报告',
    expect: ['学习资料'],
  },
  {
    name: '防回退·技术规范不被书信号抢走',
    title: '阿里巴巴编码规范.pdf',
    body: '目录 示例 知识点 规范 接口 配置 部署 数据库 算法 参考手册 白皮书',
    expect: ['技术参考'],
    notExpect: ['学习资料'],
  },
  {
    name: '防回退·正式报告带摘要也不该变学习资料',
    title: '机房改造系统方案.pdf',
    body: '摘要 引言 需求 设计 方案 评审 迭代 流程 架构 报告 总结 复盘 规划 立项',
    expect: ['项目文档'],
    notExpect: ['学习资料'],
  },

  /* ---------- 目录名当命名提示 ----------
   * 整个 Java 课件目录（57 个 .java）原本全部落到「未归类」：正文是纯代码，
   * 词表里的分类关键词一个都不沾。目录名是人起的，和文件名一样能说明
   * 这是什么资料 —— 所以入库时把来源目录名一起作为命名提示送进分类器。
   * 下面两条把这个行为钉住，同时防它盖过真正的强信号。 */
  {
    name: '课程代码文件（目录名提示）',
    title: 'T1 多态 L30_面向对象进阶 多态测试 学习',
    body: 'public class T1 {\n  public static void main(String[] a) { System.out.println(1); }\n}',
    expect: ['学习资料'],
  },
  {
    name: '防回退·目录名里的「学习」不该盖过合同',
    title: '房屋租赁合同 学习',
    body: '甲方 乙方 租赁 合同 签字 盖章 租金 押金 租期 违约 协议 身份证',
    expect: ['合同证照'],
  },
]

let pass = 0
let fail = 0
const failures = []

console.log('▸ R_N_Database 分类回归测试')
console.log(`  词表 ${taxonomy.categories.length} 类 / 同形词 ${(taxonomy._ambiguousKeywords?.strongWords ?? []).length} 强 + ${(taxonomy._ambiguousKeywords?.mildWords ?? []).length} 弱\n`)

for (const c of CASES) {
  const r = classifyByRules(c.title, c.body, taxonomy)
  const got = r.categories
  const problems = []

  for (const want of c.expect ?? []) {
    if (!got.includes(want)) problems.push(`应含「${want}」但得到 [${got.join('/')}]`)
  }
  for (const bad of c.notExpect ?? []) {
    if (got.includes(bad)) problems.push(`不应含「${bad}」但得到了`)
  }
  if (c.anyOf && !c.anyOf.some((w) => got.includes(w))) {
    problems.push(`应命中 [${c.anyOf.join(' 或 ')}] 之一，但得到 [${got.join('/')}]`)
  }

  if (problems.length === 0) {
    pass += 1
    console.log(`  ✓ ${c.name.padEnd(30)} → ${got.join('/')}`)
  } else {
    fail += 1
    failures.push({ c, got, problems })
    console.log(`  ✗ ${c.name.padEnd(30)} → ${got.join('/')}`)
    for (const p of problems) console.log(`      ${p}`)
  }
}

console.log('\n────────────────────────────────')
console.log(`  通过 ${pass} / 失败 ${fail}`)

if (failures.length > 0) {
  console.log('\n  失败用例的得分明细：')
  for (const f of failures) {
    const r = classifyByRules(f.c.title, f.c.body, taxonomy)
    const ranked = Object.entries(r.scores).sort((a, b) => b[1] - a[1]).slice(0, 4)
    console.log(`  · ${f.c.name}: ${ranked.map(([k, v]) => `${k}=${v}`).join('  ') || '（全无命中）'}`)
  }
}
console.log('')

process.exit(fail === 0 ? 0 : 1)
