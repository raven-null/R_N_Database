/**
 * 环境探测 —— 阶段 0 用。
 *
 * 回答三个问题，且**不打印任何密钥值**（只报是否配置）：
 *   ① 本地凭据是否齐备（SITE_ID / Access Token）
 *   ② 目标存储（local 或 Netlify Blobs）是否真的读写得通
 *   ③ 可选工具（LibreOffice）是否可用
 *
 * 用法：
 *   node scripts/probe.mjs             # 探测当前配置
 *   DOCS_STORE_MODE=remote node scripts/probe.mjs   # 强制探测线上 Blobs
 *
 * @module scripts/probe
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadEnv } from './env.mjs'

const ROOT = process.cwd()

/** 打印一行带状态的检查项。 */
function line(label, value, status = 'info') {
  const mark = status === 'ok' ? '✓' : status === 'bad' ? '✗' : status === 'warn' ? '⚠' : '·'
  console.log(`  ${mark} ${label.padEnd(30)} ${value}`)
}

async function main() {
  console.log('▸ R_N_Database 环境探测\n')

  // ---- .env ----
  const env = loadEnv()
  console.log('【本地配置】')
  line('.env 文件', env.loaded ? `已加载（${env.keys.length} 个键）` : '不存在（可选）')
  line('SITE_ID', process.env.SITE_ID ? '已配置' : '未配置', process.env.SITE_ID ? 'ok' : 'info')
  line('NETLIFY_ACCESS_TOKEN', process.env.NETLIFY_ACCESS_TOKEN ? '已配置' : '未配置',
    process.env.NETLIFY_ACCESS_TOKEN ? 'ok' : 'info')
  line('ADMIN_TOKEN', process.env.ADMIN_TOKEN ? '已配置' : '未配置', process.env.ADMIN_TOKEN ? 'ok' : 'info')
  line('ZHIPU_API_KEY', process.env.ZHIPU_API_KEY ? '已配置' : '未配置（AI 功能将降级）')
  line('DOCS_STORE_MODE', process.env.DOCS_STORE_MODE || '（未设，按环境推断）')

  // ---- 运行时信号 ----
  const { runtimeInfo, resolveStoreMode, probeStore, STORES } = await import(
    new URL('../netlify/functions/_lib/store.mjs', import.meta.url).href
  )
  const rt = runtimeInfo()
  console.log('\n【运行时信号】')
  for (const [k, v] of Object.entries(rt)) line(k, String(v))

  const mode = resolveStoreMode()
  console.log(`\n【存储】目标模式：${mode}`)

  if (mode === 'remote' && !(rt.hasSiteId && rt.hasToken)) {
    line('凭据检查', 'remote 模式需要 SITE_ID + NETLIFY_ACCESS_TOKEN', 'bad')
    console.log('\n  提示：把凭据填进项目根目录的 .env（参考 .env.example）。')
    console.log('        Access Token 在 Netlify → User settings → Applications 生成。')
  }

  const probe = await probeStore()
  if (probe.ready) {
    line('读写往返测试', `通过（${probe.mode}）`, 'ok')
  } else {
    line('读写往返测试', `失败：${probe.error}`, 'bad')
  }

  console.log('\n【Blobs store 规划】')
  for (const [name, store] of Object.entries(STORES)) {
    console.log(`  · ${name.padEnd(9)} → ${store}`)
  }

  // ---- 可选工具 ----
  const lo = [
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  ].find((p) => existsSync(p))

  console.log('\n【可选工具】')
  if (lo) line('LibreOffice', lo, 'ok')
  else line('LibreOffice', '未安装 → Office 预览将走 HTML 降级', 'warn')

  console.log('')
  console.log(probe.ready ? '✓ 探测完成，存储可用' : '✗ 探测完成，存储不可用（见上方提示）')
  process.exit(probe.ready ? 0 : 1)
}

main().catch((err) => {
  console.error('探测脚本出错：', err)
  process.exit(1)
})
