/**
 * 悬浮提示：界面上不摆任何说明文字，全部收进 `?` 或 `[data-tip]` 元素，
 * 鼠标悬停 / 键盘聚焦 / 点按时以一枚纸色气泡显示。
 *
 * 为什么不用纯 CSS 的 `::after`：
 * 列表与侧栏都是 `overflow: auto` 的独立滚动盒，伪元素气泡会被裁掉。
 * 这里统一挂在 body 上一个 position: fixed 的气泡里，滚到哪儿都不会切边。
 *
 * @module public/js/hint
 */

/** 气泡最大宽度（与 style.css 的 .tip-bubble 保持一致）。 */
const MAX_W = 320

/** 单例气泡。 */
let bubble = null

/** 当前正在提示的目标元素。 */
let current = null

/**
 * 取（或惰性创建）气泡节点。
 * @returns {HTMLElement} 气泡
 */
function bubbleEl() {
  if (!bubble) {
    bubble = document.createElement('div')
    bubble.className = 'tip-bubble'
    bubble.setAttribute('role', 'tooltip')
    document.body.appendChild(bubble)
  }
  return bubble
}

/**
 * 把气泡摆到目标附近，空间不够就翻到上方，左右不出屏。
 * @param {HTMLElement} target - 提示目标
 * @param {HTMLElement} box - 气泡
 * @returns {void}
 */
function place(target, box) {
  const r = target.getBoundingClientRect()
  const b = box.getBoundingClientRect()
  const gap = 9

  let left = r.left + r.width / 2 - b.width / 2
  left = Math.min(Math.max(8, left), window.innerWidth - b.width - 8)

  let top = r.bottom + gap
  let below = true
  if (top + b.height > window.innerHeight - 8) {
    const up = r.top - b.height - gap
    if (up >= 8) {
      top = up
      below = false
    } else {
      top = Math.max(8, window.innerHeight - b.height - 8)
    }
  }

  box.style.left = `${Math.round(left)}px`
  box.style.top = `${Math.round(top)}px`
  box.dataset.side = below ? 'below' : 'above'
}

/**
 * 显示提示。
 * @param {HTMLElement} target - 带 data-tip 的元素
 * @returns {void}
 */
function show(target) {
  const text = String(target.getAttribute('data-tip') ?? '')
  if (!text) return

  const box = bubbleEl()
  box.textContent = text
  box.style.maxWidth = `${MAX_W}px`
  box.style.visibility = 'hidden'
  box.classList.add('show')
  place(target, box)
  box.style.visibility = ''
  current = target
}

/** 收起提示。 */
function hide() {
  if (!bubble) return
  bubble.classList.remove('show')
  current = null
}

/**
 * 从事件目标往上找带提示的宿主。
 *
 * 刻意不用 `instanceof Element`：这段代码在 jsdom 测试里跑的是 Node 的
 * 全局作用域，`Element` 未必存在，用鸭子类型最稳。
 *
 * @param {EventTarget|null} node - 事件目标
 * @returns {Element|null} 宿主
 */
function hostOf(node) {
  if (!node || node.nodeType !== 1 || typeof node.closest !== 'function') return null
  return node.closest('[data-tip]')
}

/**
 * 设置（或清除）某个元素的提示文案。
 *
 * 提示为空时顺手把 `?` 图标藏起来 —— 没有内容就不要摆一个点不动的问号。
 *
 * @param {HTMLElement|null} el - 目标元素
 * @param {string|string[]|null} text - 文案；数组按行拼接
 * @returns {void}
 */
export function setTip(el, text) {
  if (!el) return
  const lines = (Array.isArray(text) ? text : [text]).filter((s) => s != null && String(s).trim() !== '')
  if (lines.length === 0) {
    el.removeAttribute('data-tip')
    el.hidden = true
    el.setAttribute('aria-hidden', 'true')
    return
  }
  el.hidden = false
  el.removeAttribute('aria-hidden')
  el.setAttribute('data-tip', lines.map(String).join('\n'))
}

/* ---- 全局委托 ---- */

document.addEventListener('pointerover', (e) => {
  const host = hostOf(e.target)
  if (!host) {
    if (current) hide()
    return
  }
  if (host !== current) show(host)
})

document.addEventListener('pointerout', (e) => {
  const host = hostOf(e.target)
  if (!host || host !== current) return
  // 在同一个宿主内部挪动不算离开
  if (hostOf(e.relatedTarget) === host) return
  hide()
})

document.addEventListener('focusin', (e) => {
  const host = hostOf(e.target)
  if (host) show(host)
})

document.addEventListener('focusout', () => hide())

// 触屏：点一下也能看，再点收起，点别处也收起
document.addEventListener('click', (e) => {
  const host = hostOf(e.target)
  if (!host) {
    if (current) hide()
    return
  }
  // ? 常被放在 <label> 里，阻止默认行为以免顺带聚焦到表单控件
  if (host.classList.contains('tip')) e.preventDefault()
  if (current === host) hide()
  else show(host)
})

// 滚动/缩放后位置就不对了，直接收起（下次悬停会重新摆）
window.addEventListener('scroll', () => { if (current) hide() }, true)
window.addEventListener('resize', () => { if (current) hide() })
