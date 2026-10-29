/**
 * 读接口共用的两个派生计算：**目录** 与 **对外可见性**。
 *
 * 都依赖文件夹树，所以集中一处，避免四个地方各算一遍算出四种结果 ——
 * 「访客为什么看不到这份文档」这类问题，最怕的就是各处口径不一。
 *
 * @module netlify/functions/_lib/doc-dir
 */

import { dirOf } from './source-dir.mjs'

/**
 * 文档展示用的目录。
 *
 * 优先用文件夹树的路径（可以在网页上改名/移动，改完自动跟着变）；
 * 文档还没落位（老数据、或文件夹被删）时退回 `sourcePath` 推导。
 *
 * @param {object} doc - 文档元数据
 * @param {object|null} folderIndex - loadFolders() 的结果
 * @returns {string} 斜杠分隔的目录
 */
export function dirOfDoc(doc, folderIndex) {
  const fid = doc?.folderId
  if (fid && folderIndex) {
    const p = folderIndex.pathOf?.(fid)
    if (p) return String(p)
  }
  return dirOf(doc?.sourcePath)
}

/**
 * 文档是否对访客（未登录）可见。
 *
 * 两个条件都要满足：
 *   1. 文档自己 `visibility === 'public'`
 *   2. 它所在的文件夹链上没有一层是 private
 *
 * 只会收紧、不会放宽：文件夹的 `public` 不会把一份私有文档变成公开。
 *
 * @param {object} doc - 文档元数据
 * @param {object|null} folderIndex - loadFolders() 的结果
 * @returns {boolean} 是否公开
 */
export function isPublicDoc(doc, folderIndex) {
  if (doc?.visibility !== 'public') return false
  const fid = doc?.folderId
  if (fid && folderIndex?.effectiveVisibility) {
    if (folderIndex.effectiveVisibility(fid) === 'private') return false
  }
  return true
}

/**
 * 按角色过滤文档列表（`guest` 只能看公开的）。
 *
 * @param {object[]} docs - 文档列表
 * @param {object} auth - checkAuth 的结果
 * @param {object|null} folderIndex - loadFolders() 的结果
 * @returns {object[]} 过滤后的列表
 */
export function visibleDocs(docs, auth, folderIndex) {
  if (auth?.role !== 'guest') return docs
  return docs.filter((d) => isPublicDoc(d, folderIndex))
}
