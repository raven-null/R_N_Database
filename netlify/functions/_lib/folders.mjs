/**
 * 虚拟文件夹树：把「文件夹」从路径的派生物升级成第一类数据。
 *
 * ## 现在的痛
 *
 * 文件夹一直是从 `sourcePath` 推导出来的字符串（见 `source-dir.mjs`）。
 * 后果很具体：**不能建空文件夹、不能改名、不能移动**；删一个文件夹等于
 * 批量删文档；`dir` 与真实结构之间没有稳定的锚点。
 *
 * ## 改成了什么
 *
 * 一个扁平的节点表（`doc-folders` store，key = fid）：
 *
 *     { fid, parentFid, name, visibility, createdAt, sort }
 *
 * 文档通过 `folderId` 指向节点。文件夹的**路径**由「一路往上找 name」得到，
 * 所以：
 *
 *   · 改名 = 改一个 name，子树里所有文档的 `dir` 自动跟着变（零拷贝）
 *   · 移动 = 改一个 parentFid（O(1)），不需要批量改文档
 *   · 可以有**空文件夹**（这正是上次「为什么我没看到文件夹」的另一半答案）
 *   · 删除文件夹 = 子节点与文档**上移到父级**，不销毁数据
 *
 * ## fid 为什么不能由路径哈希出来
 *
 * 早期想法是 `fid = hash(路径)`，看着省事，但改名的瞬间 fid 就变了，
 * 所有引用它的文档全部失联。所以 fid 在**创建时**随机生成、之后永不变；
 * `ensurePath()` 的幂等性靠"按 parentFid + name 查找"实现，不靠 id 推导。
 *
 * ## 可见性继承
 *
 * 文件夹的 `visibility` 取 `inherit | public | private`：
 * 有效可见性 = 自身与所有祖先中最严格的那个（有 private 就是 private）。
 * 只会收紧、不会放宽 —— 所以「把证件文件夹整体设为私有」是一步操作，
 * 而不会意外把里面的东西变成公开。
 *
 * @module netlify/functions/_lib/folders
 */

import { getDocsStore, STORES } from './store.mjs'

/** 单个名称最大长度。 */
const MAX_NAME_LEN = 60
/** 树的最大深度（防止有人把整个盘符结构倒进来）。 */
const MAX_DEPTH = 12
/** 整棵树在 store 里的 key。 */
const TREE_KEY = 'tree'

/** 合法可见性。`inherit` = 跟随父级（默认）。 */
export const FOLDER_VISIBILITIES = ['inherit', 'public', 'private']

/**
 * 规范化一个文件夹名。
 *
 * 去掉分隔符与控制字符 —— 名称里带 `/` 会把路径解析搞乱，
 * 直接拒绝比事后兼容省事。重名由 `autoSuffix()` 处理，不在这里报错。
 *
 * @param {string} raw - 原始名称
 * @returns {string} 规范化后的名称；不合法时返回空串
 */
export function normalizeFolderName(raw) {
  const s = String(raw ?? '')
    .replace(/[\\/]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s || s === '.' || s === '..') return ''
  return [...s].slice(0, MAX_NAME_LEN).join('')
}

/**
 * 生成一个不会被猜到的 fid。
 * @returns {string} 形如 `f3k9x2m1`
 */
function newFid() {
  const alphabet = 'abcdefghijkmnopqrstuvwxyz23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  let out = 'f'
  for (const b of bytes) out += alphabet[b % alphabet.length]
  return out
}

/**
 * 读出整棵树。
 *
 * ## 为什么整棵树存在**一个 blob** 里
 *
 * 第一版是"一个 fid 一个 key"，看着规整，但读一次树要 list + N 次 get，
 * 而树在每个读接口里都要用（算 dir、算可见性继承、算计数）——
 * 一次列表请求就要多几十个往返。个人库的文件夹规模是几十个，
 * 整棵树序列化后不过几 KB，一次 get 更合适。
 *
 * 代价是并发写会互相覆盖；文件夹操作是低频人工动作，接受。
 *
 * @returns {Promise<FolderIndex>} 索引
 */
export async function loadFolders() {
  const store = await getDocsStore(STORES.FOLDERS)
  const raw = await store.get(TREE_KEY, { type: 'json' }).catch(() => null)
  const nodes = new Map()
  for (const n of raw?.nodes ?? []) {
    if (n?.fid) nodes.set(n.fid, n)
  }
  return buildIndex(nodes, store)
}

/**
 * 把整棵树写回去。
 * @param {FolderIndex} idx - 索引
 * @returns {Promise<void>} 完成
 */
export async function saveFolders(idx) {
  if (!idx.store) return
  const nodes = [...idx.nodes.values()]
  await idx.store.set(TREE_KEY, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), nodes }))
}

/**
 * 用给定节点集构造索引对象。
 * @param {Map<string, object>} nodes - fid → 节点
 * @param {object} [store] - 底层 store（写操作用）
 * @returns {FolderIndex} 索引
 */
function buildIndex(nodes, store = null) {
  const childrenOf = new Map()     // parentFid(或 '') → [节点]
  for (const n of nodes.values()) {
    const key = n.parentFid ?? ''
    if (!childrenOf.has(key)) childrenOf.set(key, [])
    childrenOf.get(key).push(n)
  }
  for (const arr of childrenOf.values()) {
    arr.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || String(a.name).localeCompare(String(b.name)))
  }

  return {
    store,
    nodes,
    childrenOf,
    /** 取节点 */
    get: (fid) => nodes.get(String(fid ?? '')) ?? null,
    /** 取某层的子节点 */
    children: (fid) => childrenOf.get(String(fid ?? '')) ?? [],
    /** 从根到该节点的名称链（不含自己） */
    pathParts: (fid) => pathPartsOf(nodes, fid),
    /** 从根到该节点的路径字符串 */
    pathOf: (fid) => pathPartsOf(nodes, fid).join('/'),
    /** 有效可见性：链上任意一层 private 即 private */
    effectiveVisibility: (fid) => effectiveVisibilityOf(nodes, fid),
  }
}

/**
 * 取从根到该节点的名称数组。
 * @param {Map<string, object>} nodes - 节点表
 * @param {string} fid - 目标
 * @returns {string[]} 名称链
 */
function pathPartsOf(nodes, fid) {
  const out = []
  let cur = nodes.get(String(fid ?? ''))
  let guard = 0
  while (cur && guard++ < MAX_DEPTH + 4) {
    out.unshift(String(cur.name ?? ''))
    cur = cur.parentFid ? nodes.get(cur.parentFid) : null
  }
  return out
}

/**
 * 有效可见性：链上任意一层 private 即 private，否则 public。
 * @param {Map<string, object>} nodes - 节点表
 * @param {string} fid - 目标
 * @returns {'public'|'private'} 结果
 */
function effectiveVisibilityOf(nodes, fid) {
  let cur = nodes.get(String(fid ?? ''))
  let guard = 0
  while (cur && guard++ < MAX_DEPTH + 4) {
    if (cur.visibility === 'private') return 'private'
    cur = cur.parentFid ? nodes.get(cur.parentFid) : null
  }
  return 'public'
}

/**
 * 在给定"已占用名称"里挑一个不冲突的名字。
 * @param {string[]} taken - 已占用的名称
 * @param {string} name - 期望名称
 * @returns {string} 可用名称
 */
function pickFreeName(taken, name) {
  const used = new Set(taken)
  if (!used.has(name)) return name
  for (let i = 2; i < 1000; i++) {
    const cand = `${name} (${i})`
    if (!used.has(cand)) return cand
  }
  return `${name} ${Date.now()}`
}

/**
 * 同一父级下重名时自动加后缀：`资料` → `资料 (2)`。
 * @param {FolderIndex} idx - 索引
 * @param {string|null} parentFid - 父级
 * @param {string} name - 期望名称
 * @returns {string} 可用名称
 */
function autoSuffix(idx, parentFid, name) {
  return pickFreeName(idx.children(parentFid).map((n) => n.name), name)
}

/**
 * 在某一层按名字找子节点。
 * @param {FolderIndex} idx - 索引
 * @param {string|null} parentFid - 父级
 * @param {string} name - 名称
 * @returns {object|null} 节点
 */
function childByName(idx, parentFid, name) {
  return idx.children(parentFid).find((n) => n.name === name) ?? null
}

/**
 * 确保一条路径存在，返回叶子文件夹的 fid。
 *
 * 幂等：同名同父已存在就复用。上传整目录时逐级调用它，
 * 所以重复推同一个目录不会长出重复文件夹。
 *
 * @param {FolderIndex} idx - 索引（会被就地更新）
 * @param {string[]} parts - 名称链，如 `['上传', '学习', 'L30']`
 * @returns {Promise<string|null>} 叶子 fid；路径为空时 null（= 根）
 */
export async function ensurePath(idx, parts) {
  const clean = (parts ?? []).map(normalizeFolderName).filter(Boolean).slice(0, MAX_DEPTH)
  let parentFid = null

  for (const name of clean) {
    let node = childByName(idx, parentFid, name)
    if (!node) {
      node = {
        fid: newFid(),
        parentFid,
        name,
        visibility: 'inherit',
        createdAt: new Date().toISOString(),
        sort: (idx.children(parentFid).length + 1) * 10,
      }
      idx.nodes.set(node.fid, node)
      const key = parentFid ?? ''
      if (!idx.childrenOf.has(key)) idx.childrenOf.set(key, [])
      idx.childrenOf.get(key).push(node)
    }
    parentFid = node.fid
  }
  await saveFolders(idx)
  return parentFid
}

/**
 * 新建文件夹。
 *
 * @param {FolderIndex} idx - 索引
 * @param {object} opts - { name, parentFid, visibility }
 * @returns {Promise<object>} 新节点
 */
export async function createFolder(idx, opts = {}) {
  const name = normalizeFolderName(opts.name)
  if (!name) throw new Error('文件夹名不合法')
  const parentFid = opts.parentFid ? String(opts.parentFid) : null
  if (parentFid && !idx.get(parentFid)) throw new Error('父文件夹不存在')
  if (parentFid && idx.pathParts(parentFid).length >= MAX_DEPTH) {
    throw new Error(`层级太深了（上限 ${MAX_DEPTH} 层）`)
  }

  const node = {
    fid: newFid(),
    parentFid,
    name: autoSuffix(idx, parentFid, name),
    visibility: FOLDER_VISIBILITIES.includes(opts.visibility) ? opts.visibility : 'inherit',
    createdAt: new Date().toISOString(),
    sort: (idx.children(parentFid).length + 1) * 10,
  }
  idx.nodes.set(node.fid, node)
  const key = parentFid ?? ''
  if (!idx.childrenOf.has(key)) idx.childrenOf.set(key, [])
  idx.childrenOf.get(key).push(node)
  await saveFolders(idx)
  return node
}

/**
 * 修改文件夹：改名 / 移动 / 改可见性。
 *
 * @param {FolderIndex} idx - 索引
 * @param {string} fid - 目标
 * @param {object} patch - { name, parentFid, visibility }
 * @returns {Promise<object>} 更新后的节点
 */
export async function updateFolder(idx, fid, patch = {}) {
  const node = idx.get(fid)
  if (!node) throw new Error('文件夹不存在')

  if (patch.name !== undefined) {
    const name = normalizeFolderName(patch.name)
    if (!name) throw new Error('文件夹名不合法')
    const taken = idx.children(node.parentFid).filter((n) => n.fid !== node.fid).map((n) => n.name)
    node.name = pickFreeName(taken, name)
  }

  if (patch.parentFid !== undefined) {
    const nextParent = patch.parentFid ? String(patch.parentFid) : null
    if (nextParent === node.fid) throw new Error('不能把文件夹移到自己里面')
    if (nextParent) {
      if (!idx.get(nextParent)) throw new Error('目标文件夹不存在')
      // 防环：目标不能是自己的后代
      let cur = idx.get(nextParent)
      let guard = 0
      while (cur && guard++ < MAX_DEPTH + 4) {
        if (cur.fid === node.fid) throw new Error('不能把文件夹移到自己的子目录里')
        cur = cur.parentFid ? idx.get(cur.parentFid) : null
      }
    }
    const key = node.parentFid ?? ''
    const arr = idx.childrenOf.get(key) ?? []
    idx.childrenOf.set(key, arr.filter((n) => n.fid !== node.fid))

    node.parentFid = nextParent
    const nk = nextParent ?? ''
    if (!idx.childrenOf.has(nk)) idx.childrenOf.set(nk, [])
    idx.childrenOf.get(nk).push(node)
  }

  if (patch.visibility !== undefined) {
    if (!FOLDER_VISIBILITIES.includes(patch.visibility)) {
      throw new Error('visibility 只能是 inherit / public / private')
    }
    node.visibility = patch.visibility
  }

  node.updatedAt = new Date().toISOString()
  await saveFolders(idx)
  return node
}

/**
 * 删除文件夹：子文件夹与文档上移到父级，不销毁数据。
 *
 * 为什么不是"连子树一起删"：文件夹只是组织方式，文件是资产。
 * 一次误删把整棵树的文档带走，是最难补救的事故。
 *
 * @param {FolderIndex} idx - 索引
 * @param {string} fid - 目标
 * @returns {Promise<{removed:object, reparented:number}>} 结果
 */
export async function deleteFolder(idx, fid) {
  const node = idx.get(fid)
  if (!node) throw new Error('文件夹不存在')

  const kids = idx.children(fid)
  for (const k of kids) {
    k.parentFid = node.parentFid
  }
  const parentKey = node.parentFid ?? ''
  if (!idx.childrenOf.has(parentKey)) idx.childrenOf.set(parentKey, [])
  idx.childrenOf.set(parentKey, [...idx.childrenOf.get(parentKey), ...kids])

  idx.nodes.delete(fid)
  const ownKey = fid
  idx.childrenOf.delete(ownKey)

  await saveFolders(idx)
  return { removed: node, reparented: kids.length }
}

/**
 * 列出全部文件夹（带路径与文档计数），供 `/folders` 与前端 sidebar 使用。
 *
 * @param {FolderIndex} idx - 索引
 * @param {Array<object>} docs - 文档列表（用来数 docCount，可为空）
 * @returns {Array<object>} 扁平列表
 */
export function listFolders(idx, docs = []) {
  const counts = new Map()
  const totals = new Map()
  for (const d of docs) {
    const fid = d.folderId ? String(d.folderId) : null
    if (!fid) continue
    counts.set(fid, (counts.get(fid) ?? 0) + 1)
    // 逐级累加，父级显示"含子级"的数量
    for (const up of ancestorChain(idx, fid)) {
      totals.set(up, (totals.get(up) ?? 0) + 1)
    }
  }

  const out = []
  for (const node of idx.nodes.values()) {
    const parts = idx.pathParts(node.fid)
    out.push({
      fid: node.fid,
      parentFid: node.parentFid ?? null,
      name: node.name,
      path: parts.join('/'),
      depth: parts.length,
      visibility: node.visibility ?? 'inherit',
      effectiveVisibility: idx.effectiveVisibility(node.fid),
      docCount: counts.get(node.fid) ?? 0,
      totalDocCount: totals.get(node.fid) ?? 0,
      createdAt: node.createdAt ?? null,
    })
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * 取某文件夹自身与其所有祖先。
 * @param {FolderIndex} idx - 索引
 * @param {string} fid - 起点
 * @returns {string[]} fid 列表（含自己）
 */
function ancestorChain(idx, fid) {
  const out = []
  let cur = idx.get(fid)
  let guard = 0
  while (cur && guard++ < MAX_DEPTH + 4) {
    out.push(cur.fid)
    cur = cur.parentFid ? idx.get(cur.parentFid) : null
  }
  return out
}

/**
 * 取某文件夹的整棵子树（含自己）。
 * @param {FolderIndex} idx - 索引
 * @param {string} fid - 根
 * @returns {Set<string>} fid 集合
 */
export function subtreeFids(idx, fid) {
  const out = new Set()
  const stack = [String(fid)]
  while (stack.length) {
    const cur = stack.pop()
    if (!cur || out.has(cur)) continue
    out.add(cur)
    for (const k of idx.children(cur)) stack.push(k.fid)
  }
  return out
}
