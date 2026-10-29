/**
 * 运行时垫片：把函数运行环境缺的较新标准 API 补上。
 *
 * ## 为什么需要
 *
 * 本地开发用 Node 24，线上 Functions 跑 Node 20（`/api/v1/health` 的
 * `runtime.node` 会显示具体版本）。pdfjs-dist v6 在内部用了
 * `Promise.withResolvers`（Node 22 才有），于是在线上抽 PDF 正文时直接抛
 *
 *     TypeError: Promise.withResolvers is not a function
 *
 * 后果很隐蔽：PDF 照样能存、能预览、能下载，只是 `textChars: 0`、正文
 * 为空 —— 分类退化成「只看文件名」，全文检索也搜不到书里的字。本地跑
 * 一切正常，所以只有线上数据会露馅。
 *
 * 垫片必须在**任何**业务模块 import 之前生效，所以挂在函数入口第一行。
 * 新版运行时已经有了这些方法，这里的 if 判断就是空操作。
 *
 * @module netlify/functions/_lib/polyfills
 */

// Node >= 22
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function withResolvers() {
    let resolve
    let reject
    const promise = new Promise((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }
}

// Node >= 21
if (typeof Object.groupBy !== 'function') {
  Object.groupBy = function groupBy(items, keyOf) {
    const out = Object.create(null)
    for (const item of items) {
      const key = String(keyOf(item))
      ;(out[key] ??= []).push(item)
    }
    return out
  }
}

if (typeof Map.groupBy !== 'function') {
  Map.groupBy = function groupBy(items, keyOf) {
    const out = new Map()
    for (const item of items) {
      const key = keyOf(item)
      const bucket = out.get(key)
      if (bucket) bucket.push(item)
      else out.set(key, [item])
    }
    return out
  }
}
