/**
 * Office 文件的「网页视图」渲染（Word / PowerPoint）。
 *
 * ## 为什么在入库时渲染
 *
 * 本项目的预览件一律是**入库时在本地生成、线上只读**的产物。
 * 因此这里不需要把渲染引擎塞进浏览器或 Netlify 函数：
 *   - Word：docx-preview 在 jsdom 里跑一遍，产出静态 HTML
 *   - PPT：pagus 把每张幻灯片渲染成 SVG 字符串
 *
 * 好处是线上零依赖、零等待，CSP 可以继续锁到 `default-src 'none'`。
 *
 * ## 保真度的诚实说明
 *
 * - **Word**：段落/表格/图片/字体/字号/页面分页基本还原；
 *   公式(OMML)、图表、复杂文本框会有偏差。遇到看不下去的情况，
 *   阅读页里始终保留「原始版式」这一档（Office 转出的 PDF）。
 * - **PowerPoint**：版面是绝对坐标，开源实现很难复刻 PowerPoint 的排版引擎。
 *   实测文字内容、形状、表格、图片、填充色都能正确还原
 *   （与 Office 转出的 PDF 逐条文字比对一致），但字体度量与换行位置
 *   会有差异。所以 PPT 的默认视图仍然是 PDF，网页视图作为可选项。
 *
 * ## 外部资源一律不加载
 *
 * pagus 支持注入 Google Fonts 来替换 Office 字体，这里**明确不用**：
 * 私有资料库不该因为看一份 PPT 就向第三方发请求，
 * 预览页的 CSP 也不允许外部样式。字体走系统本地字体。
 *
 * @module scripts/lib/preview-web
 */

/** 渲染超时（毫秒）。病态文件不该把整批入库卡死。 */
const RENDER_TIMEOUT_MS = 30_000

/**
 * 网页视图产物的体积上限（4MB）。
 *
 * 预览件存在 Netlify Blobs 里，单个值有上限；而且这是要下发给浏览器的东西。
 * 图片多的 Word/PPT 会因 base64 内联膨胀约三分之一 —— 超大文件宁可不生成
 * 网页视图（阅读页会自动只显示「原始版式」），也不能写入一个存不下的值。
 */
const MAX_WEB_VIEW_BYTES = 4 * 1024 * 1024

/** 渲染页的统一 CSP（与 docs 路由里 HTML 预览件一致）。 */
export const WEB_VIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:;"

/**
 * HTML 转义（标题用）。
 * @param {string} s - 原文
 * @returns {string} 转义结果
 */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 给 Promise 套一个超时。
 * @param {Promise} p - 目标 Promise
 * @param {number} ms - 超时毫秒
 * @param {string} what - 出错时的说明
 * @returns {Promise} 结果
 */
function withTimeout(p, ms, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}超时（${ms}ms）`)), ms)
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

/* ============================================================
   Word → 静态 HTML
   ============================================================ */

/**
 * 把一个 DOM 库的全局变量借过来，跑完再还回去。
 *
 * docx-preview 是按浏览器写的：它要 document / DOMParser / FileReader /
 * requestAnimationFrame。jsdom 能给，但把 jsdom 的 window 长期挂在
 * globalThis 上会污染同进程里的其他代码（入库要顺带抽 PDF 正文等），
 * 所以只在渲染期间挂载，结束后逐个还原。
 *
 * @param {(window: object) => Promise<*>} fn - 在 DOM 就绪后执行的函数
 * @returns {Promise<*>} fn 的返回值
 */
async function withDom(fn) {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body><div id="body"></div><div id="style"></div></body></html>',
    { pretendToBeVisual: true },
  )
  const { window } = dom

  // jsdom 不做 SVG 布局，也不实现这两个方法；docx-preview 画文本框/VML 时会调
  if (window.SVGElement) {
    window.SVGElement.prototype.getBBox = () => ({ x: 0, y: 0, width: 0, height: 0 })
    window.SVGElement.prototype.getComputedTextLength = () => 0
  }

  /**
   * 需要借用的全局名。
   *
   * ★ 直接赋原值，**不要 bind**。一开始我对函数做了 `v.bind(window)`，
   * 结果 `HTMLElement` 这类构造器变成了绑定后的副本，
   * 库内部的 `el instanceof HTMLElement` 全部为 false，
   * docx-preview 于是把整篇文档当成空文档渲染 —— 页面只有空壳，
   * 却没有任何报错。这个坑值得写在这儿，别再踩。
   */
  const KEYS = [
    'window', 'document', 'DOMParser', 'XMLSerializer', 'FileReader', 'Blob',
    'Node', 'SVGElement', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame',
  ]

  const saved = new Map()
  for (const k of KEYS) {
    saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k))
    const v = window[k]
    if (v === undefined) continue
    try {
      globalThis[k] = v
    } catch {
      /* 只读全局属性，跳过 */
    }
  }

  try {
    return await fn(window)
  } finally {
    for (const [k, desc] of saved) {
      try {
        if (desc) Object.defineProperty(globalThis, k, desc)
        else delete globalThis[k]
      } catch {
        /* 还原失败不影响结果 */
      }
    }
    // 等 rAF 里的收尾任务跑完再关窗，否则 jsdom 会在已销毁的窗口上抛错
    await new Promise((r) => setTimeout(r, 80))
    try { dom.window.close() } catch { /* 忽略 */ }
  }
}

/**
 * 渲染 DOCX 为可独立打开的 HTML 页面。
 *
 * @param {Buffer} buf - docx 内容
 * @param {object} [opts] - { title }
 * @returns {Promise<{ok:boolean, html?:string, error?:string, stats?:object}>} 结果
 */
export async function renderDocxHtml(buf, opts = {}) {
  const title = opts.title ?? ''

  // docx-preview 的收尾任务是异步排队的：万一它在 rAF 里抛错，
  // 默认行为会让整个 Node 进程崩掉 —— 一批入库里有一个坏文件就全废。
  // 所以渲染期间临时接管未捕获异常，渲染结束立刻摘掉。
  let asyncError = null
  const onUncaught = (err) => { asyncError = err }
  process.on('uncaughtException', onUncaught)

  try {
    const result = await withTimeout(withDom(async (window) => {
      const { renderAsync } = await import('docx-preview')
      const body = window.document.getElementById('body')
      const style = window.document.getElementById('style')
      await renderAsync(buf, body, style, {
        inWrapper: true,
        useBase64URL: true,   // jsdom 没有 URL.createObjectURL；base64 内联也更便于存成单文件
        breakPages: true,
        renderHeaders: true,
        renderFooters: true,
        // 修订与批注默认不渲染：档案要看的是"最终稿"
        renderChanges: false,
        renderComments: false,
      })
      // 等 docx-preview 的 rAF 后置任务（文本框定位等）跑完再取 DOM
      await new Promise((r) => setTimeout(r, 100))
      return {
        body: body.innerHTML,
        style: style.innerHTML,
      }
    }), RENDER_TIMEOUT_MS, 'Word 渲染')

    if (!result.body) {
      return { ok: false, error: asyncError ? String(asyncError.message ?? asyncError) : '渲染结果为空' }
    }

    // 图片是 data: URL，页面完全自包含，不依赖任何外部请求
    const images = (result.body.match(/<img\b/g) ?? []).length
    const tables = (result.body.match(/<table\b/g) ?? []).length

    const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<style>${result.style}</style>
<style>
  /* 覆盖在 docx-preview 的页面样式之后：只负责画布，不干预文档排版 */
  html, body { margin: 0; padding: 0; }
  body {
    background: #eef1f5; padding: 16px 12px 40px;
    font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  .docx-wrapper { background: transparent !important; padding: 0 !important; }
  .docx-wrapper > section.docx { box-shadow: 0 1px 8px rgba(0,0,0,.16); margin: 0 auto 16px !important; }
  @media (max-width: 720px) {
    body { padding: 8px 4px 24px; }
    .docx-wrapper > section.docx { width: 100% !important; min-width: 0 !important; padding: 18px !important; }
  }
  @media (prefers-color-scheme: dark) {
    body { background: #0f1115; }
  }
</style>
</head>
<body>${result.body}</body></html>`

    const bytes = Buffer.byteLength(html, 'utf8')
    if (bytes > MAX_WEB_VIEW_BYTES) {
      return {
        ok: false,
        error: `文档内容过大（HTML ${(bytes / 1024 / 1024).toFixed(1)}MB，上限 ${Math.round(MAX_WEB_VIEW_BYTES / 1024 / 1024)}MB），已跳过网页视图`,
      }
    }

    return {
      ok: true,
      html,
      stats: {
        bytes,
        images,
        tables,
        note: asyncError ? `渲染期间有非致命异常：${String(asyncError.message ?? asyncError)}` : '',
      },
    }
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) }
  } finally {
    process.off('uncaughtException', onUncaught)
  }
}

/* ============================================================
   PowerPoint → 内联 SVG
   ============================================================ */

/**
 * 渲染 PPTX 为可独立打开的 HTML 页面（每张幻灯片一段内联 SVG）。
 *
 * 用内联 SVG 而不是 `<img src="...svg">`：pagus 把文字放在
 * `<foreignObject>` 里（这样才支持自动换行、行距、两端对齐），
 * 而外链 SVG 作为图片加载时浏览器**不会渲染 foreignObject** ——
 * 文字会整片消失。这是选型时最容易踩的坑。
 *
 * @param {Buffer} buf - pptx 内容
 * @param {object} [opts] - { title }
 * @returns {Promise<{ok:boolean, html?:string, error?:string, stats?:object}>} 结果
 */
export async function renderPptxHtml(buf, opts = {}) {
  const title = opts.title ?? ''

  try {
    const { parse } = await import('@pagus-kit/core')
    const { renderSlide } = await import('@pagus-kit/renderer')

    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    const pres = await withTimeout(parse(ab), RENDER_TIMEOUT_MS, 'PPT 解析')

    const slides = []
    const kinds = {}
    let unsupported = 0

    for (let i = 0; i < pres.slides.length; i++) {
      const slide = pres.slides[i]
      for (const el of slide.elements ?? []) {
        kinds[el.type] = (kinds[el.type] ?? 0) + 1
        // 视频/音频无法在静态页里播，如实记数（页面顶部会说明）
        if (el.type === 'media') unsupported += 1
      }
      const r = renderSlide(slide, pres.slideSize, { scale: 2 })
      slides.push(`<section class="slide" aria-label="第 ${i + 1} 张">
  <div class="no">第 ${i + 1} / ${pres.slides.length} 张</div>
  ${r.svg}
</section>`)
    }

    const w = Math.round(pres.slideSize.width)
    const h = Math.round(pres.slideSize.height)
    const ratio = (w / h).toFixed(4)

    const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<style>
  html, body { margin: 0; padding: 0; }
  body {
    background: #eef1f5; padding: 12px;
    font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  .deck { display: flex; flex-direction: column; gap: 14px; max-width: 1180px; margin: 0 auto; }
  .slide {
    position: relative; background: #fff;
    border-radius: 3px; overflow: hidden;
    box-shadow: 0 1px 8px rgba(0,0,0,.16);
    /* 幻灯片是固定比例：先按比例占位，SVG 加载时不会跳动 */
    aspect-ratio: ${ratio};
  }
  .slide svg { display: block; width: 100%; height: 100%; }
  .no {
    position: absolute; left: 8px; top: 6px; z-index: 2;
    padding: 1px 7px; border-radius: 20px;
    background: rgba(15,17,21,.55); color: #fff;
    font-size: 11px; letter-spacing: .02em;
    opacity: 0; transition: opacity .15s;
  }
  .slide:hover .no { opacity: 1; }
  @media (prefers-color-scheme: dark) { body { background: #0f1115; } }
  @media (max-width: 720px) { body { padding: 6px; } .deck { gap: 10px; } }
</style>
</head>
<body>
<div class="deck">
${slides.join('\n')}
</div>
</body></html>`

    const bytes = Buffer.byteLength(html, 'utf8')
    if (bytes > MAX_WEB_VIEW_BYTES) {
      return {
        ok: false,
        error: `演示文稿过大（SVG ${(bytes / 1024 / 1024).toFixed(1)}MB，上限 ${Math.round(MAX_WEB_VIEW_BYTES / 1024 / 1024)}MB），已跳过网页视图`,
      }
    }

    return {
      ok: true,
      html,
      stats: {
        bytes,
        slideCount: pres.slides.length,
        elements: kinds,
        unsupportedMedia: unsupported,
        fonts: pres.fonts?.usedFontFamilies ?? [],
        size: { w, h },
      },
    }
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) }
  }
}
