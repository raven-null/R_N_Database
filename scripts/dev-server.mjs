/**
 * 本地开发服务器。
 *
 * 为什么不直接用 `netlify dev`：本项目要能在**不装任何依赖、不登录 Netlify**
 * 的情况下跑通全套流程。这个服务器直接把 netlify/functions 下的函数
 * 按各自声明的 config.path 挂到路由上 —— 与线上 Netlify 的行为一致，
 * 因此本地验证过的路由，线上不会变样。
 *
 * 用法：
 *   node scripts/dev-server.mjs           # 默认 http://127.0.0.1:8899
 *   PORT=9000 node scripts/dev-server.mjs
 *
 * @module scripts/dev-server
 */

import { createServer } from 'node:http'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadEnv } from './env.mjs'

const ROOT = process.cwd()
const PUBLIC_DIR = join(ROOT, 'public')
const FUNC_DIR = join(ROOT, 'netlify', 'functions')
const PORT = Number(process.env.PORT) || 8899

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

/**
 * 加载全部函数，按 config.path 建路由表。
 *
 * 支持 `config.path` 为字符串或字符串数组，并支持 `/*` 通配后缀 ——
 * 与 Netlify Functions v2 的语义保持一致，这样本地跑通的路径
 * 在线上不会变样。
 *
 * @returns {Promise<{routes:Map<string, object>, wildcards:Array<object>}>} 路由表
 */
async function loadRoutes() {
  const routes = new Map()
  const wildcards = []

  if (!existsSync(FUNC_DIR)) return { routes, wildcards }

  for (const file of readdirSync(FUNC_DIR).filter((f) => f.endsWith('.mjs'))) {
    const full = join(FUNC_DIR, file)
    let mod
    try {
      mod = await import(pathToFileURL(full).href)
    } catch (err) {
      console.error(`  ✗ 函数 ${file} 加载失败：${err?.message ?? err}`)
      continue
    }

    const declared = mod.config?.path
    const paths = Array.isArray(declared) ? declared : (declared ? [declared] : [])

    if (paths.length === 0 || typeof mod.default !== 'function') continue

    for (const p of paths) {
      const entry = { handler: mod.default, file, pattern: p }
      if (p.endsWith('/*')) {
        wildcards.push({ ...entry, prefix: p.slice(0, -2) })
        console.log(`  · 路由 ${(p + '  (通配)').padEnd(28)} → ${file}`)
      } else {
        routes.set(p, entry)
        console.log(`  · 路由 ${p.padEnd(28)} → ${file}`)
      }
    }
  }

  // 长的前缀优先匹配，避免 /api/v1/a/* 被 /api/v1/* 抢先
  wildcards.sort((a, b) => b.prefix.length - a.prefix.length)
  return { routes, wildcards }
}

/**
 * 按路径匹配路由（精确优先，其次通配）。
 * @param {string} pathname - 请求路径
 * @param {Map<string,object>} routes - 精确路由表
 * @param {Array<object>} wildcards - 通配路由表
 * @returns {object|null} 命中的路由
 */
function matchRoute(pathname, routes, wildcards) {
  if (routes.has(pathname)) return routes.get(pathname)
  for (const w of wildcards) {
    if (pathname === w.prefix || pathname.startsWith(`${w.prefix}/`)) return w
  }
  return null
}

/**
 * 把 Node 的 IncomingMessage 转成标准 Request。
 * @param {import('node:http').IncomingMessage} req - Node 请求
 * @returns {Promise<Request>} 标准请求
 */
async function toRequest(req) {
  const url = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${PORT}`}`)

  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) headers.set(k, v.join(', '))
    else if (v !== undefined) headers.set(k, v)
  }

  let body
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (chunks.length) body = Buffer.concat(chunks)
  }

  return new Request(url, { method: req.method, headers, body })
}

/**
 * 把标准 Response 写回 Node 响应。
 * @param {Response} response - 标准响应
 * @param {import('node:http').ServerResponse} res - Node 响应
 * @returns {Promise<void>} 完成
 */
async function sendResponse(response, res) {
  const headers = {}
  response.headers.forEach((v, k) => { headers[k] = v })
  const buf = Buffer.from(await response.arrayBuffer())
  res.writeHead(response.status, headers)
  res.end(buf)
}

/**
 * 提供 public/ 下的静态文件。
 * @param {URL} url - 请求 URL
 * @param {import('node:http').ServerResponse} res - Node 响应
 * @returns {boolean} 是否已处理
 */
function serveStatic(url, res) {
  let rel = decodeURIComponent(url.pathname)
  if (rel === '/' || rel === '') rel = '/index.html'

  // 防目录穿越：解析后必须仍在 public/ 内
  const full = resolve(PUBLIC_DIR, '.' + normalize(rel))
  if (!full.startsWith(PUBLIC_DIR + sep) && full !== PUBLIC_DIR) {
    res.writeHead(403).end('Forbidden')
    return true
  }
  if (!existsSync(full) || !statSync(full).isFile()) return false

  res.writeHead(200, {
    'Content-Type': MIME[extname(full).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  })
  res.end(readFileSync(full))
  return true
}

async function main() {
  const env = loadEnv()
  console.log('▸ 渡·资·集 本地开发服务器\n')
  console.log(env.loaded
    ? `  · 已加载 .env（${env.keys.length} 个键）`
    : '  · 未发现 .env（使用默认值；这是正常的本地开发状态）')

  const { resolveStoreMode } = await import(
    pathToFileURL(join(FUNC_DIR, '_lib', 'store.mjs')).href
  )
  const mode = resolveStoreMode()
  console.log(`  · 存储模式：${mode}${mode === 'local' ? '（.local-data/，不碰线上数据）' : '（真实 Netlify Blobs）'}`)

  const { routes, wildcards } = await loadRoutes()

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

    // 1) API 路由
    const hit = matchRoute(url.pathname, routes, wildcards)
    if (hit) {
      try {
        const response = await hit.handler(await toRequest(req))
        await sendResponse(response, res)
      } catch (err) {
        console.error(`[${hit.file}]`, err)
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({
          ok: false,
          error: { code: 'DEV_SERVER_ERROR', message: String(err?.message ?? err) },
        }))
      }
      console.log(`  ${req.method} ${url.pathname} → 函数 ${hit.file}`)
      return
    }

    // 2) 静态文件
    if (serveStatic(url, res)) return

    // 3) 未命中
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('404 Not Found')
  })

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\n  站点     http://127.0.0.1:${PORT}/`)
    console.log(`  探活     http://127.0.0.1:${PORT}/api/v1/health`)
    console.log('\n  Ctrl+C 停止\n')
  })
}

main().catch((err) => {
  console.error('开发服务器启动失败：', err)
  process.exit(1)
})
