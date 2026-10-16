/**
 * 路由：/api/v1/taxonomy（分类词表）与 /api/v1/manifest（全量索引）。
 *
 * manifest 是给工作站与博客**缓存整库**用的：带 indexVersion 与 ETag，
 * 内容没变时返回 304，调用方不必重复下载。
 *
 * @module netlify/functions/_lib/routes/meta
 */

import { checkAuth } from '../auth.mjs'
import { ok, forbidden, unauthorized, serverError } from '../respond.mjs'
import { readAllMeta, readIndexMeta, readTaxonomy, tally } from '../repo.mjs'

/**
 * 统一鉴权：三个 meta 端点要求一致。
 * @param {Request} req - 请求
 * @param {URL} url - URL
 * @returns {Promise<Response|null>} 失败时返回响应，成功返回 null
 */
async function gate(req, url) {
  const auth = await checkAuth(req, url, 'read')
  if (auth.ok) return { auth, response: null }
  return {
    auth,
    response: auth.failClosed
      ? forbidden('服务端尚未配置访问密码，已拒绝所有访问（fail-closed）', { req })
      : unauthorized(auth.reason === 'BAD_TOKEN' ? '访问令牌无效' : '需要访问令牌', { req }),
  }
}

/**
 * GET /api/v1/taxonomy —— 分类树与标签表（含计数）。
 * @param {Request} req - 请求
 * @param {URL} url - URL
 * @returns {Promise<Response>} 响应
 */
export async function taxonomyRoute(req, url) {
  const { auth, response } = await gate(req, url)
  if (response) return response

  try {
    const docs = auth.role === 'guest'
      ? (await readAllMeta()).filter((d) => d.visibility === 'public')
      : await readAllMeta()

    const taxonomy = await readTaxonomy()
    const counts = tally(docs)

    // 把计数合并进词表，前端一次拿到「分类 + 数量」
    const categories = (taxonomy?.categories ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      desc: c.desc,
      count: counts.categories[c.name] ?? 0,
    }))

    // 实际用到的标签（含词表外的），按使用次数降序
    const tags = Object.entries(counts.tags)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'))

    return ok({
      version: taxonomy?.version ?? 0,
      categories,
      tags,
      types: counts.types,
      docCount: docs.length,
    }, { req })
  } catch (err) {
    return serverError(err, 'taxonomy', { req })
  }
}

/**
 * GET /api/v1/manifest —— 全量元数据 + 索引版本，供调用方整库缓存。
 *
 * 支持 ETag / If-None-Match：内容没变直接 304，省流量也省调用方解析开销。
 *
 * @param {Request} req - 请求
 * @param {URL} url - URL
 * @returns {Promise<Response>} 响应
 */
export async function manifestRoute(req, url) {
  const { auth, response } = await gate(req, url)
  if (response) return response

  try {
    let docs = await readAllMeta()
    if (auth.role === 'guest') docs = docs.filter((d) => d.visibility === 'public')

    // 只读 meta（几 KB），不再为了版本号把整个索引拉下来
    const indexMeta = await readIndexMeta()
    const version = indexMeta?.version ?? 'none'
    const etag = `"${version}-${docs.length}"`

    // 内容未变 → 304
    if (req.headers.get('if-none-match') === etag) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etag, 'Cache-Control': 'private, no-cache' },
      })
    }

    const payload = {
      version,
      builtAt: indexMeta?.builtAt ?? null,
      docCount: docs.length,
      docs: docs.map((d) => ({
        id: d.id,
        title: d.title,
        originalName: d.originalName,
        type: d.type,
        ext: d.ext,
        size: d.size,
        pages: d.pages,
        author: d.author,
        categories: d.categories ?? [],
        tags: d.tags ?? [],
        summary: d.summary ?? '',
        pinyin: d.pinyin ?? null,
        previewKind: d.previewKind,
        hasText: Boolean(d.hasText),
        needsReview: Boolean(d.needsReview),
        ingestedAt: d.ingestedAt,
        docCreatedAt: d.docCreatedAt,
      })),
      taxonomy: await readTaxonomy(),
    }

    return ok(payload, {
      req,
      headers: { ETag: etag, 'Cache-Control': 'private, no-cache' },
    })
  } catch (err) {
    return serverError(err, 'manifest', { req })
  }
}
