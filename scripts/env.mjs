/**
 * 极简 .env 加载器。
 *
 * 不引 dotenv 依赖：本地脚本需要读凭据，而为了读一个 .env
 * 就往这个项目塞一个第三方包并不划算。
 *
 * 规则：**真实环境变量优先** —— 已存在于 process.env 的键不会被 .env 覆盖，
 * 这样 Netlify 注入的值永远压过本地文件。
 *
 * @module scripts/env
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 载入 .env（若存在）。
 * @param {string} [file] - 文件路径，默认项目根 .env
 * @returns {{loaded:boolean, path:string, keys:string[]}} 载入结果（只报键名，不报值）
 */
export function loadEnv(file = join(process.cwd(), '.env')) {
  if (!existsSync(file)) return { loaded: false, path: file, keys: [] }

  const keys = []
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const eq = line.indexOf('=')
    if (eq === -1) continue

    const key = line.slice(0, eq).trim()
    if (!key) continue

    let value = line.slice(eq + 1).trim()
    const quoted = (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    if (quoted && value.length >= 2) value = value.slice(1, -1)

    if (!(key in process.env)) process.env[key] = value
    keys.push(key)
  }
  return { loaded: true, path: file, keys }
}

/**
 * 要求某些环境变量必须存在，否则抛出聚合错误。
 * @param {string[]} names - 必需的键名
 * @param {string} purpose - 用途说明（写进报错）
 * @returns {void}
 */
export function requireEnv(names, purpose) {
  const missing = names.filter((n) => !String(process.env[n] ?? '').trim())
  if (missing.length === 0) return

  const err = new Error(
    `${purpose}需要以下环境变量，但未配置：${missing.join(', ')}\n`
    + '请在项目根目录的 .env 里填写（.env 已被 .gitignore 忽略，不会进 Git）。\n'
    + '可参考 .env.example。',
  )
  err.code = 'MISSING_ENV'
  throw err
}
