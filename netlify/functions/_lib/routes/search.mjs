/**
 * 路由：GET /api/v1/search —— 服务端全文检索。
 *
 * 前端的即时筛选走 manifest 里的元数据（零延迟），
 * 这个端点是**深度检索**的兜底：查正文、返回命中片段。
 * 也供工作站与博客直接调用。
 *
 * @module netlify/functions/_lib/routes/search
 */

import { checkAuth } from '../auth.mjs'
import { ok, badRequest, forbidden, unauthorized, serverError } from '../respond.mjs'
import { readAllMeta, readIndexMeta, readPostingsForTerms, readDocText } from '../repo.mjs'
import { searchIndex, makeSnippet, queryTerms } from '../tokenize.mjs'

/** 默认返回条数。 */
const DEFAULT_LIMIT = 30

/**
 * 处理搜索。
 * @param {Request} req - 请求
 * @param {URL} url - URL
 * @returns {Promise<Response>} 响应
 */
export async function searchRoute(req, url) {
  // 读只要 guest（未登录即可，但只会命中标记为 public 的文档）
  const auth = await checkAuth(req, url, 'guest')
  if (!auth.ok) {
    return auth.role === 'guest' || auth.role === null
      ? unauthorized(auth.reason === 'BAD_TOKEN' ? '访问令牌无效' : '需要访问令牌', { req })
      : forbidden('当前身份权限不足', { req })
  }

  const q = (url.searchParams.get('q') ?? '').trim()
  if (!q) return badRequest('缺少查询参数 q', { req })

  try {
    const docs = await readAllMeta()
    const visible = auth.role === 'guest'
      ? docs.filter((d) => d.visibility === 'public')
      : docs

    const indexMeta = await readIndexMeta()
    if (!indexMeta) {
      return ok({
        query: q,
        total: 0,
        items: [],
        note: '索引尚未构建。请先运行 node scripts/ingest.mjs 入库。',
      }, { req })
    }

    // ★ 只读查询词所在的分片，而不是全量索引。
    // 全量索引 256 份文档时已 6.23MB，实测每次检索读全量要 134–149ms；
    // 分片后通常只碰 2–6 片。
    const terms = queryTerms(q).map((t) => t.term)
    const { postings, shardsRead } = await readPostingsForTerms(terms)

    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || DEFAULT_LIMIT, 1), 100)
    // 打分在 tokenize.searchIndex 里做（BM25：词频饱和 + 长度归一化 +
    // 查询词条分级）。这里给它一个"局部索引"：postings 只含相关分片，
    // 而 docCount / avgLength / lengths 来自 meta。
    const hits = searchIndex(
      {
        postings,
        docCount: indexMeta.docCount,
        avgLength: indexMeta.avgLength,
        lengths: indexMeta.lengths,
      },
      q,
      { docs: visible, limit },
    )

    // 为命中项生成正文片段：只对命中的那几条读正文，不整库加载
    const items = []
    for (const hit of hits) {
      const doc = visible.find((d) => d.id === hit.id)
      if (!doc) continue

      let snippet = doc.summary || ''
      let hitPage = null

      if (!snippet || hit.matched.length > 0) {
        const text = await readDocText(hit.id).catch(() => null)
        const pages = text?.pages ?? []
        for (let i = 0; i < pages.length; i++) {
          const s = makeSnippet(pages[i], hit.matched)
          if (s && hit.matched.some((t) => pages[i].toLowerCase().includes(String(t).toLowerCase()))) {
            snippet = s
            hitPage = i + 1
            break
          }
        }
        if (!snippet && pages.length) snippet = makeSnippet(pages[0], hit.matched)
      }

      items.push({
        id: doc.id,
        title: doc.title,
        originalName: doc.originalName,
        type: doc.type,
        categories: doc.categories ?? [],
        tags: doc.tags ?? [],
        summary: doc.summary ?? '',
        snippet,
        hitPage,
        matched: hit.matched.slice(0, 8),
        score: Math.round(hit.score * 100) / 100,
        ingestedAt: doc.ingestedAt,
      })
    }

    return ok({
      query: q,
      total: items.length,
      indexVersion: indexMeta.version,
      shardsRead,
      items,
    }, { req })
  } catch (err) {
    return serverError(err, 'search', { req })
  }
}
