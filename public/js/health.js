/**
 * 阶段 0 自检面板：调用 /api/v1/health 并把结果显示出来。
 *
 * 它是「部署是否成功」的可视化验证手段 —— 部署完打开首页，
 * 一眼就能看出 Blobs 通不通、密码配没配、线上注入了哪些环境信号。
 *
 * @module public/js/health
 */

const statusEl = document.getElementById('status')
const reportEl = document.getElementById('report')

/** 转义 HTML，避免把服务端返回值直接当 HTML 插入。 */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 渲染一行键值。 */
function row(key, value, badge) {
  const badgeHtml = badge
    ? ` <span class="badge ${badge.kind}">${esc(badge.text)}</span>`
    : ''
  return `<tr><td>${esc(key)}</td><td>${esc(value)}${badgeHtml}</td></tr>`
}

async function main() {
  let res
  let payload
  try {
    res = await fetch('/api/v1/health')
    payload = await res.json()
  } catch (err) {
    statusEl.innerHTML = `<span class="badge bad">请求失败</span> ${esc(err.message)}`
    return
  }

  if (!payload?.ok) {
    statusEl.innerHTML = `<span class="badge bad">服务异常</span> ${esc(payload?.error?.message ?? res.status)}`
    return
  }

  const d = payload.data
  statusEl.innerHTML = `<span class="badge ok">服务正常</span> ${esc(d.name)} ${esc(d.version)} · ${esc(d.time)}`

  const storeReady = d.store?.ready
  const storeBadge = storeReady === true
    ? { kind: 'ok', text: '可用' }
    : storeReady === false
      ? { kind: 'bad', text: '不可用' }
      : { kind: 'info', text: '已跳过' }

  const authBadge = d.auth?.failClosed
    ? { kind: 'bad', text: '未配密码，已全站拒绝' }
    : d.auth?.configured
      ? { kind: 'ok', text: '已启用' }
      : { kind: 'warn', text: '未配置' }

  const rows = [
    row('存储模式', d.store?.mode ?? '-'),
    row('存储读写', storeReady === null ? '未测试' : (storeReady ? '通过' : '失败'), storeBadge),
    row('访问密码', d.auth?.configured ? '已配置' : '未配置', authBadge),
    row('运行在函数中', d.runtime?.inLambda ? '是' : '否'),
    row('Blobs 上下文', d.runtime?.hasBlobsContext ? '有' : '无'),
    row('Node 版本', d.runtime?.node ?? '-'),
    row('CORS 白名单', (d.allowedOrigins ?? []).join(', ')),
  ]

  const hints = (d.hints ?? []).length
    ? `<div class="hints">${d.hints.map((h) => `<p>⚠ ${esc(h)}</p>`).join('')}</div>`
    : ''

  reportEl.innerHTML = `<table class="kv">${rows.join('')}</table>${hints}`

  if (d.store?.error) {
    reportEl.innerHTML += `<div class="hints"><p>存储错误：${esc(d.store.error)}</p></div>`
  }
}

main()
