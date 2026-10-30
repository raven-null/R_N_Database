/**
 * 全库重新分类：把新的分类规则与标签打分套到已有文档上。
 *
 * ## 为什么需要
 *
 * 规则与词表都在代码/配置里，而分类结果是一次性写进 META 的。
 * 于是"改了词表、改了打分规则"这件事对**已经有文档毫无影响** ——
 * 站点上还是那批又吵又乱的标签，只能靠删库重灌才能看到新结果。
 *
 * 这个接口就是那条缺失的回路：读全文 → 按当前规则重算分类与标签 → 写回 META
 * → 重建索引清单。只改元数据，不动原件与正文。
 *
 * ## 什么会被保留
 *
 * · **人工改过的**（`classifySource` 里带 `manual`）一律跳过 —— 人比规则大
 * · Markdown 的 front matter（`front-matter`）跳过 —— 那是作者亲手写的
 * · `visibility` / `folderId` / 标题 不动：分类只负责分类
 *
 * @module netlify/functions/_lib/reclassify
 */

import { ok, serverError } from './respond.mjs'
import { getDocsStore, STORES } from './store.mjs'
import { classifyByRules } from './classify-rules.mjs'
import { scoreTags, tagNames } from './tag-score.mjs'
import { readAllMetaForMaintenance, rebuildFromMetas } from './index-repair.mjs'
import { loadFolders } from './folders.mjs'
import { dirOf } from './source-dir.mjs'
import TAXONOMY_DEFAULT from './taxonomy-default.mjs'

/** 单次最多处理多少份（再多会顶到函数时限）。 */
const MAX_DOCS = 400

/**
 * 每份文档最多喂多少正文字符给分类器。
 *
 * 与索引侧同一口径（`tokenize.MAX_INDEX_CHARS` 是 6 万）：体裁信号（参考文献、
 * 致谢、本章）在书里出现得很早，6 万字足够；再多只是白烧 CPU。
 */
const MAX_BODY_CHARS = 60_000

/**
 * 哪些文档不该被自动重分类。
 *
 * @param {object} meta - 元数据
 * @returns {boolean} 是否跳过
 */
function isProtected(meta) {
  const source = String(meta?.classifySource ?? '')
  return source.includes('manual') || source === 'front-matter'
}

/**
 * 取某份文档的目录层级名（用于标签打分里的"目录命中"）。
 *
 * @param {object} meta - 元数据
 * @param {object} folderIndex - 文件夹树
 * @returns {string[]} 各级名字
 */
function dirNamesOf(meta, folderIndex) {
  const fid = meta?.folderId
  if (fid && folderIndex) {
    const parts = folderIndex.pathParts?.(fid)
    if (parts?.length) return parts
  }
  const dir = dirOf(meta?.sourcePath)
  return dir ? dir.split('/').filter(Boolean) : []
}

/**
 * POST /api/v1/reclassify（admin）
 *
 * 请求体可选：`{ dryRun: true }` 只报告不改动。
 *
 * @param {Request} req - 请求
 * @returns {Promise<Response>} 响应
 */
export async function reclassify(req) {
  let body = {}
  try {
    body = await req.json()
  } catch {
    /* 没有请求体也算正常 */
  }
  const dryRun = Boolean(body?.dryRun)

  try {
    const metas = await readAllMetaForMaintenance()
    if (metas.length === 0) return ok({ total: 0, note: '库里没有文档。' }, { req })
    if (metas.length > MAX_DOCS) {
      return ok({
        total: metas.length,
        note: `一次最多处理 ${MAX_DOCS} 份（当前 ${metas.length} 份），请分批或用本地脚本 node scripts/reclassify.mjs`,
      }, { req })
    }

    const taxonomy = TAXONOMY_DEFAULT
    const folderIndex = await loadFolders()
    const metaStore = await getDocsStore(STORES.META)
    const textStore = await getDocsStore(STORES.TEXT)

    let skippedManual = 0
    let categoriesChanged = 0
    let tagsChanged = 0
    let tagsBefore = 0
    let tagsAfter = 0
    const samples = []

    for (const meta of metas) {
      if (isProtected(meta)) { skippedManual += 1; continue }

      const dirNames = dirNamesOf(meta, folderIndex)
      // 分类提示 = 标题 + 文件名 + 各级目录名（目录名是人起的，最可信）
      const hint = [meta.title, meta.originalName, ...dirNames].filter(Boolean).join(' ')

      // ★ 必须把正文也读出来：体裁信号（参考文献/致谢/本章/摘要）全在正文里，
      //   只给标题的话，一本 307 页的书会被判成「项目文档」—— 这个坑真踩过。
      const text = await textStore.get(meta.id, { type: 'json' }).catch(() => null)
      const body = (text?.pages ?? []).join('\n').slice(0, MAX_BODY_CHARS)

      const cls = classifyByRules(hint, body, taxonomy)
      const scored = scoreTags({
        title: String(meta.title ?? ''),
        fileName: String(meta.originalName ?? ''),
        dirNames,
        body,
        categories: cls.categories,
        taxonomy,
      })
      const nextTags = tagNames(scored)

      const oldCats = (meta.categories ?? []).join('/')
      const newCats = cls.categories.join('/')
      const oldTags = (meta.tags ?? []).join(' ')
      const newTagsStr = nextTags.join(' ')

      tagsBefore += (meta.tags ?? []).length
      tagsAfter += nextTags.length

      if (oldCats !== newCats) {
        categoriesChanged += 1
        if (samples.length < 8) samples.push(`${meta.title}：分类 ${oldCats || '（空）'} → ${newCats}`)
      }
      if (oldTags !== newTagsStr) {
        tagsChanged += 1
        if (samples.length < 8) samples.push(`${meta.title}：标签 ${oldTags || '（空）'} → ${newTagsStr || '（空）'}`)
      }

      if (dryRun) continue

      meta.categories = cls.categories
      meta.tags = nextTags
      // 有明确分类就不再是"待复查"
      if (!cls.categories.includes('未归类')) meta.needsReview = false
      meta.classifySource = 'rules'
      meta.updatedAt = new Date().toISOString()
      await metaStore.set(meta.id, JSON.stringify(meta))
    }

    let indexNote = '未改动（dryRun）'
    if (!dryRun) {
      const { index } = await rebuildFromMetas(metas)
      indexNote = `索引已重建（${index.termCount} 个词条）`
    }

    return ok({
      total: metas.length,
      skippedManual,
      categoriesChanged,
      tagsChanged,
      tagsBefore,
      tagsAfter,
      dryRun,
      samples,
      note: `扫描 ${metas.length} 份：分类变了 ${categoriesChanged} 份，标签变了 ${tagsChanged} 份`
        + `（标签总数 ${tagsBefore} → ${tagsAfter}），跳过人工/头部 ${skippedManual} 份。${indexNote}`,
    }, { req })
  } catch (err) {
    return serverError(err, 'reclassify', { req })
  }
}
