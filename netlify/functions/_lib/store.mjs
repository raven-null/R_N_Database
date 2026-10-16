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
}

const LOCAL_DIR = join(process.cwd(), '.local-data')

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
    s.mode = 'remote'
    return s
  } catch (err) {
    throw storeFailure('Netlify Blobs 不可用', err, rt)
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
