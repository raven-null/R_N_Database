/**
 * 构建期校验 —— Netlify build command 指向这里。
 *
 * 为什么不用 `echo '静态站，无需构建'`（图库和博客的做法）：
 * 走 GitHub 自动部署后，**每一次 push 都直接决定线上**。一个手滑的
 * 语法错误就会把站点打挂，而 Netlify 那套 echo 占位命令不做任何检查。
 * 这里做四类校验，**校验失败 → Netlify 构建失败 → 线上保持上一个正常版本**，
 * 等于免费的自动化护栏。
 *
 * 四类校验：
 *   ① 结构：必需文件是否齐全
 *   ② 函数：每个 function 能否被 import，是否声明了 config.path
 *   ③ 配置：netlify.toml 是否钉住 Node 版本、publish 目录是否存在
 *   ④ 保密：★ 公开仓库专用 —— 扫描有无密钥被写进代码 / .gitignore 是否覆盖
 *
 * **本脚本绝不读取或打印任何密钥值**，因此可以在 Netlify 构建环境安全运行。
 *
 * @module scripts/check
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { findLibreOffice } from './lib/office.mjs'

const ROOT = process.cwd()
const FUNC_DIR = join(ROOT, 'netlify', 'functions')

/** 收集到的错误与警告。 */
const errors = []
const warnings = []
const notes = []

const fail = (msg) => errors.push(msg)
const warn = (msg) => warnings.push(msg)
const note = (msg) => notes.push(msg)

/* ============================================================
   ① 结构校验
   ============================================================ */
function checkStructure() {
  const required = [
    'netlify.toml',
    'package.json',
    '.gitignore',
    'public/index.html',
  ]
  for (const rel of required) {
    if (!existsSync(join(ROOT, rel))) fail(`缺少必需文件：${rel}`)
  }
}

/* ============================================================
   ② 函数校验：能不能 import、有没有声明路由
   ============================================================ */
async function checkFunctions() {
  if (!existsSync(FUNC_DIR)) {
    fail('缺少 netlify/functions 目录')
    return
  }

  const files = readdirSync(FUNC_DIR).filter((f) => f.endsWith('.mjs'))
  if (files.length === 0) fail('netlify/functions 下没有任何 .mjs 函数')

  const paths = new Map()

  for (const file of files) {
    const full = join(FUNC_DIR, file)
    let mod
    try {
      // 动态 import 会真正执行模块顶层代码，因此语法错误、坏 import
      // 都会在这里被抓到 —— 这正是我们要的
      mod = await import(pathToFileURL(full).href)
    } catch (err) {
      fail(`函数 ${file} 无法加载：${err?.message ?? err}`)
      continue
    }

    if (typeof mod.default !== 'function') {
      fail(`函数 ${file} 没有 default 导出（Functions v2 要求 export default）`)
    }
    const path = mod.config?.path
    if (!path) {
      fail(`函数 ${file} 未声明 config.path（无法确定路由）`)
    } else if (paths.has(path)) {
      fail(`路由冲突：${path} 同时被 ${paths.get(path)} 和 ${file} 声明`)
    } else {
      paths.set(path, file)
    }
  }

  note(`已注册 API 路由 ${paths.size} 个：${[...paths.keys()].sort().join(', ')}`)
}

/* ============================================================
   ③ 配置校验
   ============================================================ */
function checkNetlifyConfig() {
  if (!existsSync(join(ROOT, 'netlify.toml'))) return
  const toml = readFileSync(join(ROOT, 'netlify.toml'), 'utf8')

  if (!/NODE_VERSION\s*=/.test(toml)) {
    fail('netlify.toml 未显式钉住 NODE_VERSION —— 线上 Node 版本漂移会导致分词与 Blobs 行为不一致')
  }
  if (!/publish\s*=\s*"public"/.test(toml)) {
    warn('netlify.toml 的 publish 不是 "public"，请确认这是有意为之')
  }
  if (!existsSync(join(ROOT, 'public'))) fail('publish 目录 public/ 不存在')
}

/* ============================================================
   ④ 保密校验（公开仓库必查）
   ============================================================ */
const SECRET_PATTERNS = [
  // Netlify Personal Access Token 前缀
  { re: /\bnfp_[A-Za-z0-9]{20,}/, what: 'Netlify Access Token（nfp_ 前缀）' },
  // 常见 LLM key
  { re: /\bsk-[A-Za-z0-9]{20,}/, what: '疑似 API Key（sk- 前缀）' },
  // 把密钥直接写进赋值语句
  {
    re: /(NETLIFY_ACCESS_TOKEN|NETLIFY_BLOBS_TOKEN|ADMIN_TOKEN|ZHIPU_API_KEY|DOCS_SIGN_SECRET)\s*=\s*["'][^"'\s]{16,}["']/,
    what: '代码里硬编码了密钥值',
  },
]

/** 遍历项目文件（跳过依赖与本地数据）。 */
function* walk(dir, depth = 0) {
  if (depth > 6) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const name = entry.name
    if (['node_modules', '.git', '.local-data', '.netlify', '.pnpm-store', '.npm-cache'].includes(name)) continue
    const full = join(dir, name)
    if (entry.isDirectory()) yield* walk(full, depth + 1)
    else if (entry.isFile()) yield full
  }
}

function checkSecrets() {
  // ---- .gitignore 必须覆盖的关键项 ----
  const giPath = join(ROOT, '.gitignore')
  if (existsSync(giPath)) {
    const gi = readFileSync(giPath, 'utf8')
    const mustIgnore = [
      ['.env', /^\.env\s*$/m, '本仓库是公开仓库，.env 必须被忽略'],
      ['.local-data/', /\.local-data\//, '本地存储可能含真实资料副本'],
      ['inbox/', /^inbox\/\s*$/m, '资料原件目录绝不能进 Git'],
      ['content/', /^content\/\s*$/m, '资料原件目录绝不能进 Git'],
    ]
    for (const [label, re, why] of mustIgnore) {
      if (!re.test(gi)) fail(`.gitignore 未忽略 ${label} —— ${why}`)
    }
  }

  // ---- .env 绝不能存在于将被提交的路径 ----
  if (existsSync(join(ROOT, '.env'))) {
    note('.env 存在（本地凭据），已确认被 .gitignore 覆盖')
  }

  // ---- 全项目密钥字样扫描 ----
  let scanned = 0
  for (const file of walk(ROOT)) {
    // .env.example 是模板，只含占位符
    const rel = relative(ROOT, file).replace(/\\/g, '/')
    if (rel === '.env.example') continue

    let size = 0
    try {
      size = statSync(file).size
    } catch {
      continue
    }
    if (size > 512 * 1024) continue // 跳过二进制/大文件
    if (/\.(png|jpg|jpeg|webp|gif|ico|pdf|woff2?|ttf|zip|gz|gguf|safetensors)$/i.test(rel)) continue

    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    // 二进制内容会出现替换字符，跳过
    if (text.includes('\u0000')) continue

    scanned += 1
    for (const { re, what } of SECRET_PATTERNS) {
      if (re.test(text)) fail(`疑似密钥泄漏：${rel} 命中「${what}」`)
    }
  }
  note(`密钥扫描已覆盖 ${scanned} 个文本文件`)
}

/* ============================================================
   ⑤ 可选工具探测（不影响构建成败）
   ============================================================ */
function checkOptionalTools() {
  // 探测逻辑统一走 scripts/lib/office.mjs，避免候选路径在两处各写一份
  const found = findLibreOffice()
  if (found) {
    note(`LibreOffice 已安装：${found}（Office 文档转高保真 PDF 预览）`)
  } else {
    warn('未检测到 LibreOffice —— docx/xlsx/pptx 只能走 HTML 降级预览，'
      + '版式/图片/图表会丢失（实测一份 21 页 PPT 只剩一堆 <li>）。'
      + '装好后跑 node scripts/reclassify.mjs --previews-only 即可升级已有文档。')
  }
}

/* ============================================================
   主流程
   ============================================================ */
async function main() {
  console.log('▸ R_N_Database 构建校验\n')

  checkStructure()
  await checkFunctions()
  checkNetlifyConfig()
  checkSecrets()
  checkOptionalTools()

  for (const n of notes) console.log(`  · ${n}`)
  for (const w of warnings) console.log(`  ⚠ ${w}`)

  if (errors.length > 0) {
    console.error('\n✗ 校验未通过，构建中止（线上保持上一个正常版本）：')
    for (const e of errors) console.error(`  ✗ ${e}`)
    process.exit(1)
  }

  console.log('\n✓ 校验通过')
}

main().catch((err) => {
  console.error('校验脚本自身出错：', err)
  process.exit(1)
})
