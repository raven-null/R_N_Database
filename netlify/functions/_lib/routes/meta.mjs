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
import { dirOf } from '../source-dir.mjs'
import { loadFolders, listFolders } from '../folders.mjs'
import { dirOfDoc, visibleDocs } from '../doc-dir.mjs'

/**
 * 统一鉴权：分类词表与清单都只需 guest（未登录即可，
 * 但只会看到标记为 public 的文档）。
 * @param {Request} req - 请求
 * @param {URL} url - URL
 * @returns {Promise<object>} { auth, response }
 */
async function gate(req, url) {
  const auth = await checkAuth(req, url, 'guest')
  if (auth.ok) return { auth, response: null }
  return {
    auth,
    response: unauthorized(auth.reason === 'BAD_TOKEN' ? '访问令牌无效' : '需要访问令牌', { req }),
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
    const folderIndex = await loadFolders()
    const docs = visibleDocs(await readAllMeta(), auth, folderIndex)

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
        // 预览件由哪个引擎生成（Office 桌面引擎 / LibreOffice / HTML 降级），
        // 保真度差异明显，调用方需要知道
        previewNote: d.previewNote ?? '',
        hasText: Boolean(d.hasText),
        needsReview: Boolean(d.needsReview),
        visibility: d.visibility === 'public' ? 'public' : 'private',
        ingestedAt: d.ingestedAt,
        docCreatedAt: d.docCreatedAt,
        // 来源目录：库是扁平的，这一项让前端能画出「按目录浏览」的树。
        // 由 sourcePath 派生，不单独存（见 _lib/source-dir.mjs）
        dir: dirOfDoc(d, folderIndex),
        folderId: d.folderId ?? null,
        sourcePath: d.sourcePath ?? '',
      })),
      // 文件夹树：前端 sidebar 直接渲染，空文件夹也在里面
      folders: listFolders(folderIndex, docs),
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
