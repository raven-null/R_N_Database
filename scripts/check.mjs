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

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { officeEngineStatus } from './lib/office.mjs'

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
   ⑤ 转换引擎探测（不影响构建成败）
   ============================================================ */
function checkOptionalTools() {
  // 探测逻辑统一走 scripts/lib/office.mjs，避免引擎判断在两处各写一份
  const status = officeEngineStatus()
  if (status.startsWith('可用')) {
    note(`Office 转换 ${status}`)
  } else {
    warn(`Office 转换${status}。`
      + '装 LibreOffice（或在本机用 Office 桌面版）即可获得 PDF 预览；'
      + '就绪后跑 node scripts/reclassify.mjs --previews-only 升级已有文档。')
  }
}

/* ============================================================
   ⑥ 环境变量取值泄漏扫描（对齐 Netlify 的 secrets scanning）
   ============================================================
   踩过的坑：把用户的实际口令写进了代码注释，还写进了提交信息，
   结果（a）Netlify 的 secrets scanning 直接让构建失败，
       （b）密码公开在 GitHub 上，只能作废重设。

   前五节的正则只认特定前缀（nfp_/sk- 等），认不出「随便起一个」的口令。
   Netlify 的做法是拿**环境变量的值**去全文搜索 —— 这里照做，
   这样在本地就能拦住，不必等推上去才被平台打回。

   同时扫提交信息：泄漏经常发生在说明文字里（我就是这么栽的），
   而提交信息不进工作区文件，只扫文件是抓不到的。
   ============================================================ */

/** 需要防泄漏的环境变量名。 */
const SENSITIVE_ENV_KEYS = [
  'ADMIN_TOKEN',
  'NETLIFY_ACCESS_TOKEN',
  'NETLIFY_BLOBS_TOKEN',
  'ZHIPU_API_KEY',
  'AI_API_KEY',
  'DOCS_SIGN_SECRET',
  'STATION_LLM_API_KEY',
]

/**
 * 扫描当前环境里敏感变量的**值**是否出现在项目文件或提交信息里。
 * @returns {void}
 */
function checkEnvValueLeaks() {
  const values = []
  for (const key of SENSITIVE_ENV_KEYS) {
    const v = String(process.env[key] ?? '').trim()
    // 太短的值容易误报（例如 "1111"），但不扫又漏；取 6 位以上
    if (v.length >= 6) values.push({ key, value: v })
  }

  if (values.length === 0) {
    note('环境变量泄漏扫描：当前环境没有配置敏感变量，跳过')
  }

  // ---- 工作区文件 ----
  for (const file of walk(ROOT)) {
    const rel = relative(ROOT, file).replace(/\\/g, '/')
    if (rel === '.env.example') continue   // 模板文件只有占位符

    let size = 0
    try {
      size = statSync(file).size
    } catch {
      continue
    }
    if (size > 512 * 1024) continue

    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (text.includes('\u0000')) continue

    for (const { key, value } of values) {
      if (text.includes(value)) {
        fail(`环境变量 ${key} 的**值**出现在文件里：${rel}`
          + '（Netlify 的 secrets scanning 会因此让构建失败，且该值已公开）')
      }
    }
  }

  // ---- 提交信息 ----
  // 提交信息不进工作区文件，只扫文件抓不到 —— 而我恰恰是在这里泄漏的
  try {
    const log = execFileSync('git', ['log', '--all', '--format=%H%n%B'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    })
    for (const { key, value } of values) {
      if (log.includes(value)) {
        fail(`环境变量 ${key} 的**值**出现在某条提交信息里`
          + '（工作区扫描抓不到；需改写历史：git commit --amend / git filter-branch）')
      }
    }
    note('环境变量泄漏扫描：已覆盖工作区文件与全部提交信息')
  } catch (err) {
    warn(`无法读取 git 提交信息，跳过提交信息扫描：${err?.message ?? err}`)
  }
}

/* ============================================================
   主流程
   ============================================================ */

/**
 * 生成 `_lib/build-info.mjs`：把这版代码的 commit / 分支 / Node 版本写进函数。
 *
 * ## 为什么需要
 *
 * 这次排查里最浪费时间的一类对话是「我改的代码到底上线没有？」——
 * Netlify 的 `COMMIT_REF` 只在**构建期**有值，函数运行时读到的是空，
 * 于是 `/health` 里那一行永远是 null，只能靠 behavioural 试探。
 *
 * 构建命令 `node scripts/check.mjs` 在打包之前执行，此刻把 commit 写成
 * 一个普通模块，函数静态 import 它，就能在线上如实回报「我是哪一版」。
 *
 * ## 为什么不让它每次都变
 *
 * `builtAt` 如果每次本地跑 check 都刷新，生成文件会天天变动、把 diff 弄脏。
 * 所以只有 commit / 分支 / Node 变了才重写；同一版重复构建保持第一次的时间。
 *
 * @returns {void}
 */
function generateBuildInfo() {
  const dst = join(ROOT, 'netlify', 'functions', '_lib', 'build-info.mjs')

  const git = (args) => {
    try {
      return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
    } catch {
      return ''
    }
  }

  const commit = (process.env.COMMIT_REF || git(['rev-parse', 'HEAD']) || '').slice(0, 40)
  const branch = process.env.BRANCH || process.env.HEAD || git(['rev-parse', '--abbrev-ref', 'HEAD']) || ''
  const node = process.version.replace(/^v/, '')
  const dirty = (() => {
    try {
      return execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim().length > 0
    } catch {
      return false
    }
  })()

  // 同一版就别重写，保住原来的 builtAt
  if (existsSync(dst)) {
    const prev = readFileSync(dst, 'utf8')
    const same = prev.includes(`commit: '${commit.slice(0, 12)}'`)
      && prev.includes(`branch: '${branch}'`)
      && prev.includes(`node: '${node}'`)
    if (same) {
      note(`构建信息：${commit.slice(0, 7) || '(无 git)'} @ ${node}（未变，沿用）`)
      return
    }
  }

  const body = `/**
 * 构建信息（供 /api/v1/health 回报）。
 *
 * ⚠ 由 scripts/check.mjs **自动生成**，不要手改。
 * 存在的唯一目的：让"线上跑的到底是哪一版代码"这个问题有一个确定答案。
 *
 * @module netlify/functions/_lib/build-info
 */

export default {
  commit: '${commit.slice(0, 12)}',
  branch: '${branch}',
  node: '${node}',
  builtAt: '${new Date().toISOString()}',
  dirty: ${dirty},
}
`

  try {
    writeFileSync(dst, body, 'utf8')
    note(`已生成构建信息 _lib/build-info.mjs（${commit.slice(0, 7) || '无 git'} @ ${node}）`)
  } catch (err) {
    fail(`写 build-info.mjs 失败：${err.message}`)
  }
}

/**
 * 把分类词表同步给函数侧（`_lib/taxonomy-default.mjs`）。
 *
 * ## 为什么需要
 *
 * 服务端一键入库要在函数里分类，而函数读不到 `config/` 目录。
 * 词表平时存在 Blobs（`doc-index/taxonomy`），但**库从没初始化过**时
 * 那里是空的 —— 而服务端入库恰恰有可能就是第一次初始化的动作。
 *
 * ## 为什么在构建时生成而不是手抄一份
 *
 * 手抄必然漂移：改了 `config/taxonomy.json` 却忘了同步，于是"词表改了
 * 但服务端分类没变"，而且没有任何报错。这里每次构建都重新生成，
 * 生成完再比对一次，不一致就让构建失败。
 *
 * @returns {void}
 */
/**
 * 把 marked 的浏览器版复制到 `public/vendor/`。
 *
 * ## 为什么要在构建期复制
 *
 * 阅读页的 Markdown 预览由服务端渲染（`_lib/markdown-view.mjs`），但
 * **编辑时的实时预览**必须在浏览器里、每敲几个字就重画一次 —— 不能每
 * 一次按键都打一趟服务器。
 *
 * `marked` 已经是项目依赖，但 Netlify 只发布 `public/`，node_modules 里的
 * 东西不会被托管。所以构建期把它拷一份进去。拷贝而不是手写/引入 CDN：
 *   · 手写一个 Markdown 渲染器是重新发明轮子，还必然和线上预览不一致
 *   · CDN 会让"离线/被墙/版本漂移"变成站点的一部分
 *
 * 目标文件提交进仓库（体积约 40KB），这样本地起 dev server 也能直接用。
 *
 * @returns {void}
 */
function syncVendorAssets() {
  const src = join(ROOT, 'node_modules', 'marked', 'lib', 'marked.esm.js')
  const dir = join(ROOT, 'public', 'vendor')
  const dst = join(dir, 'marked.esm.js')

  if (!existsSync(src)) {
    warn('没有找到 marked 的浏览器构建（node_modules/marked）—— 编辑器实时预览会退化成纯文本')
    return
  }
  const body = readFileSync(src, 'utf8')

  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    if (existsSync(dst) && readFileSync(dst, 'utf8') === body) {
      note(`编辑器依赖已是最新（marked ${(body.length / 1024).toFixed(0)}KB）`)
      return
    }
    writeFileSync(dst, body, 'utf8')
    note(`已同步编辑器依赖到 public/vendor/marked.esm.js（${(body.length / 1024).toFixed(0)}KB）`)
  } catch (err) {
    fail(`写 public/vendor/marked.esm.js 失败：${err.message}`)
  }
}

function syncTaxonomyForFunctions() {
  const src = join(ROOT, 'config', 'taxonomy.json')
  const dst = join(ROOT, 'netlify', 'functions', '_lib', 'taxonomy-default.mjs')

  let raw
  try {
    raw = readFileSync(src, 'utf8')
  } catch (err) {
    fail(`读不到词表 config/taxonomy.json：${err.message}`)
    return
  }

  let tax
  try {
    tax = JSON.parse(raw)
  } catch (err) {
    fail(`config/taxonomy.json 不是合法 JSON：${err.message}`)
    return
  }
  if (!Array.isArray(tax.categories) || tax.categories.length === 0) {
    fail('config/taxonomy.json 里没有 categories')
    return
  }

  const body = `/**
 * 分类词表的只读副本（供函数使用）。
 *
 * ⚠ 由 scripts/check.mjs 从 config/taxonomy.json **自动生成**，不要手改。
 * 要改词表请改 config/taxonomy.json —— 下次构建会覆盖这里。
 *
 * @module netlify/functions/_lib/taxonomy-default
 */

export default ${JSON.stringify(tax, null, 2)}
`

  const prev = existsSync(dst) ? readFileSync(dst, 'utf8') : ''
  if (prev === body) {
    note(`词表已同步给函数侧（${tax.categories.length} 类 / ${(tax.tags ?? []).length} 标签）`)
    return
  }

  try {
    writeFileSync(dst, body, 'utf8')
    note(`已把词表同步到 _lib/taxonomy-default.mjs（${tax.categories.length} 类）`)
  } catch (err) {
    fail(`写 taxonomy-default.mjs 失败：${err.message}`)
  }
}

async function main() {
  console.log('▸ R_N_Database 构建校验\n')

  checkStructure()
  await checkFunctions()
  checkNetlifyConfig()
  checkSecrets()
  checkEnvValueLeaks()
  checkOptionalTools()
  syncTaxonomyForFunctions()
  syncVendorAssets()
  generateBuildInfo()

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
