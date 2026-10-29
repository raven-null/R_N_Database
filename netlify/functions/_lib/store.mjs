/**
 * 存储层：Netlify Blobs（线上）/ 本地文件（开发）双模式。
 *
 * 设计要点（相对图库项目 _lib.js 的三处改进）：
 *
 * 1. **生产环境禁止静默回退**。图库的写法是 getStore() 抛错且 SITE_ID
 *    未设就退回本地文件存储 —— 本地开发很贴心，但套到 Git 自动部署上
 *    是隐患：线上万一 Blobs 没启用，函数会静默往临时目录写文件，
 *    入库看着成功、数据在冷启动后蒸发，而且不报错。
 *    这里改为：检测到运行在 Netlify 函数里就直接抛明确错误。
 *
 * 2. **零依赖可跑**。@netlify/blobs 用动态 import，只在 remote 模式加载，
 *    因此本地开发不装任何依赖也能跑通。
 *
 * 3. **本地存储的 key 校验更严**。图库用 `p.startsWith(dir)` 判断目录
 *    穿越，边界情形不严谨；这里改用字符白名单 + 显式拒绝 `..`。
 *
 * @module netlify/functions/_lib/store
 */

import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  readdirSync, unlinkSync, statSync,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
/** Blobs store 名称表。集中定义，避免各函数里散落字符串。 */
export const STORES = {
  /** 原件（pdf/docx/xlsx/pptx）—— 唯一真相，下载走这里 */
  FILES: 'doc-files',
  /** 预生成预览件（PDF）—— 保证「流畅观看」不依赖浏览器兼容性 */
  PREVIEWS: 'doc-previews',
  /** 抽取的正文（<id>.json，按页/段）—— 检索与 AI 的数据源 */
  TEXT: 'doc-text',
  /** 每份文档的元数据（<id>）—— 列表页只读它，不碰大文件 */
  META: 'doc-meta',
  /** 倒排索引 + 分类树 + 标签表 —— 整包下发前端，检索零函数调用 */
  INDEX: 'doc-index',
  /** 密码哈希 + 令牌表 —— 沿用图库 auth-config 做法 */
  AUTH: 'doc-auth',
  /** 导出/备份的 zip 暂存（下载后即可清） */
  EXPORTS: 'doc-exports',
  /**
   * 待处理的上传暂存区。
   *
   * 网页上传是**两阶段**的：文件先落到这里并标为 pending，
   * 重活（抽正文、Office 转 PDF、分类打标）留到本地跑
   * `node scripts/process-pending.mjs` —— 因为 Netlify 上既没有
   * LibreOffice，也扛不住 300 页 PDF 的抽取。
   */
  INBOX: 'doc-inbox',
}

/**
 * 本地开发时的回退存储目录。
 *
 * 可用 `DOCS_LOCAL_DIR` 覆盖 —— 主要用于**测试隔离**：
 * 测试常需要同时跑两个实例（一个无密码、一个带密码），
 * 如果共用同一个目录，带密码的那个会把鉴权配置写进去，
 * 无密码的那个也会跟着变成「已配密码」，测试结果就不可信了。
 * （实测踩过：主实例突然只返回 0 份文档。）
 */
const LOCAL_DIR = process.env.DOCS_LOCAL_DIR
  ? resolve(process.env.DOCS_LOCAL_DIR)
  : join(process.cwd(), '.local-data')

/**
 * 采集运行环境信号（只返回布尔量与版本号，绝不含密钥值）。
 * 这些信号决定存储模式，也是 /api/v1/health 里供阶段 0 实测的依据。
 * @returns {object} 运行环境信号
 */
export function runtimeInfo() {
  return {
    /** Netlify 构建期会置 true */
    onNetlifyBuild: process.env.NETLIFY === 'true',
    /** Blobs 凭据已注入（构建期与函数运行时都可能出现）*/
    hasBlobsContext: Boolean(process.env.NETLIFY_BLOBS_CONTEXT),
    /** ★ 最可靠的服务端函数信号：Netlify Functions 跑在 AWS Lambda 上 */
    inLambda: Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME),
    /** netlify dev 本地代理 */
    isNetlifyDev: process.env.NETLIFY_DEV === 'true',
    hasSiteId: Boolean(process.env.SITE_ID),
    hasToken: Boolean(process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_ACCESS_TOKEN),
    node: process.version,
  }
}

/**
 * 决定本次进程用哪种存储。
 *
 * 优先级：显式 DOCS_STORE_MODE > 环境推断。
 * 本地开发默认 local，**避免误写生产数据**；要看线上真实资料时
 * 手动把 DOCS_STORE_MODE 改成 remote。
 * @returns {'local'|'remote'} 存储模式
 */
export function resolveStoreMode() {
  const forced = String(process.env.DOCS_STORE_MODE || '').trim().toLowerCase()
  if (forced === 'remote' || forced === 'local') return forced

  const rt = runtimeInfo()
  // 线上函数：必须用真 Blobs，没有商量余地
  if (rt.inLambda) return 'remote'
  if (rt.hasBlobsContext) return 'remote'
  if (rt.hasSiteId && rt.hasToken) return 'remote'
  // 纯本地 Node 进程：走本地文件
  return 'local'
}

/* ============================================================
   本地文件存储（开发用）
   ============================================================ */

/**
 * 校验 key 安全性。只允许字母数字与 / - _ . ，并显式拒绝路径穿越。
 * @param {string} key - Blobs key
 * @returns {string} 校验通过的 key
 */
function assertSafeKey(key) {
  const k = String(key ?? '')
  if (!k) throw new Error('空的 Blobs key')
  if (!/^[A-Za-z0-9_./-]+$/.test(k)) throw new Error(`非法的 Blobs key：${k}`)
  if (k.split('/').includes('..')) throw new Error(`Blobs key 不允许路径穿越：${k}`)
  return k
}

/**
 * 创建本地文件回退存储。行为对齐 @netlify/blobs v8 的 get/set/list。
 * @param {string} name - store 名称
 * @returns {object} 类 Blobs store
 */
function localStore(name) {
  const dir = join(LOCAL_DIR, name)

  const fileOf = (key) => join(dir, ...assertSafeKey(key).split('/'))

  /** 递归收集相对 key（含子目录）*/
  const walk = (base, prefix = '') => {
    if (!existsSync(base)) return []
    const out = []
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) out.push(...walk(join(base, entry.name), rel))
      else out.push(rel)
    }
    return out
  }

  return {
    mode: 'local',
    async get(key, opts = {}) {
      const file = fileOf(key)
      if (!existsSync(file)) return null
      const buf = readFileSync(file)
      if (opts.type === 'json') return JSON.parse(buf.toString('utf8'))
      if (opts.type === 'arrayBuffer') {
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      }
      if (opts.type === 'stream') {
        const { Readable } = await import('node:stream')
        return Readable.toWeb(Readable.from(buf))
      }
      return buf.toString('utf8')
    },
    async set(key, value) {
      const file = fileOf(key)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, Buffer.isBuffer(value) ? value : Buffer.from(String(value)))
    },
    async setJSON(key, value) {
      return this.set(key, JSON.stringify(value))
    },
    async delete(key) {
      const file = fileOf(key)
      if (existsSync(file)) unlinkSync(file)
    },
    async list(opts = {}) {
      const prefix = opts.prefix || ''
      const limit = Number(opts.limit) || 200
      const all = walk(dir)
        .filter((k) => k.startsWith(prefix))
        .sort()
        .map((key) => ({ key, size: statSync(fileOf(key)).size }))
      const start = opts.cursor ? Number(opts.cursor) : 0
      const page = all.slice(start, start + limit)
      const nextCursor = start + limit < all.length ? String(start + limit) : undefined
      return { blobs: page, nextCursor, hasMore: Boolean(nextCursor) }
    },
  }
}

/* ============================================================
   Netlify Blobs 存储（线上）
   ============================================================ */

/**
 * 获取一个 store 句柄（异步：remote 模式需动态加载 @netlify/blobs）。
 *
 * @param {string} name - STORES 里的 store 名
 * @returns {Promise<object>} 类 Blobs store
 * @throws {Error} 线上环境 Blobs 不可用时抛出（**绝不静默回退**）
 */
export async function getDocsStore(name) {
  const mode = resolveStoreMode()

  if (mode === 'local') return localStore(name)

  const rt = runtimeInfo()
  let getStore
  try {
    ({ getStore } = await import('@netlify/blobs'))
  } catch (err) {
    throw storeFailure('@netlify/blobs 未安装，无法使用 remote 模式', err, rt)
  }

  const options = { name }
  // 显式凭据：只在本地脚本直写 Blobs 时出现。
  // 线上函数由 Netlify 自动注入，**不要把 token 配进 Netlify 环境变量**。
  if (rt.hasSiteId && rt.hasToken) {
    options.siteID = process.env.SITE_ID
    options.token = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_ACCESS_TOKEN
  }

  try {
    const s = getStore(options)
    return strongReads(s)
  } catch (err) {
    throw storeFailure('Netlify Blobs 不可用', err, rt)
  }
}

/**
 * 把 Blobs 句柄包成「读一律强一致」。
 *
 * ## 为什么必须这样
 *
 * Netlify Blobs 的读默认走边缘缓存、**最终一致**：刚写进去的 key 换个
 * 请求去读可能是空的（实测线上滞后数秒）。这个项目里有好几处是
 * 「写一次、紧接着读回来」的流程，最终一致会把它们逐个咬穿：
 *
 *   · 分片上传：第 1 片写了 chunk-meta，第 2 片读不到 → 当成新任务 →
 *     报「缺少文件名」（>4MB 的文件线上必挂）
 *   · 入库时 applyDocChange 读 index-meta / 分片 / docs 清单再写回 ——
 *     读不到就当成空索引，写回时把别人的改动覆盖掉（并发删除丢更新）
 *   · 删完文档刷新列表还在，过几秒才消失
 *
 * 强一致读绕过边缘缓存，代价是每次都回源。个人资料库这点延迟无所谓，
 * 换来的是「写完了就一定读得到」这个可以依赖的语义。
 *
 * 写入侧没有 consistency 选项，只能靠读侧补偿；真正需要跨请求原子的
 * 场景（比如批量打标签）由 applyDocChangesBulk 合并成一次读写来解决。
 *
 * @param {object} raw - @netlify/blobs 的 Store
 * @returns {object} 包装后的 store（mode 标 remote）
 */
function strongReads(raw) {
  const STRONG = { consistency: 'strong' }
  return {
    mode: 'remote',
    get: (key, opts = {}) => raw.get(key, { ...STRONG, ...opts }),
    getWithMetadata: (key, opts = {}) => raw.getWithMetadata(key, { ...STRONG, ...opts }),
    list: (opts = {}) => raw.list({ ...STRONG, ...opts }),
    getMetadata: (key, opts = {}) => raw.getMetadata(key, { ...STRONG, ...opts }),
    set: (key, value, opts) => raw.set(key, value, opts),
    setJSON: (key, value, opts) => raw.setJSON(key, value, opts),
    delete: (key) => raw.delete(key),
  }
}

/**
 * 构造一个说得清"该怎么办"的错误，而不是让调用方看到原始异常。
 * @param {string} what - 出错的环节
 * @param {Error} err - 原始异常
 * @param {object} rt - runtimeInfo() 结果
 * @returns {Error} 带 code 与修复指引的错误
 */
function storeFailure(what, err, rt) {
  const missing = String(err?.code) === 'MissingBlobsEnvironmentError'
    || String(err?.message ?? '').includes('MissingBlobsEnvironmentError')

  const hint = missing
    ? '请到 Netlify 站点 Settings → Data collection 开启 Netlify Blobs；本地开发则把 DOCS_STORE_MODE 设为 local。'
    : `原始错误：${err?.message ?? err}`

  const e = new Error(`[store] ${what}。${hint}`)
  e.code = 'BLOBS_UNAVAILABLE'
  e.runtime = rt
  return e
}

/**
 * 探活：报告存储模式与是否真的读写得通。
 * 供 /api/v1/health 使用，只做一次极小读写，失败不抛异常。
 * @returns {Promise<object>} { mode, ready, error? }
 */
export async function probeStore() {
  const mode = resolveStoreMode()
  try {
    const s = await getDocsStore(STORES.INDEX)
    const key = '__probe__'
    const stamp = new Date().toISOString()
    await s.set(key, stamp)
    const back = await s.get(key, { type: 'text' })
    await s.delete(key)
    return { mode, ready: back === stamp, error: null }
  } catch (err) {
    return { mode, ready: false, error: String(err?.message ?? err) }
  }
}
