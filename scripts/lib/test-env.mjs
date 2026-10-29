/**
 * 测试用子进程的环境构造。
 *
 * ## 为什么需要它
 *
 * 测试要 spawn `ingest.mjs` / `process-pending.mjs` / 隔离实例的 `dev-server.mjs`。
 * 这些脚本会读项目根目录的 `.env` —— 而那正是**开发者本机的真实配置**。
 *
 * 踩过的坑：我一给 `.env` 写上 `DOCS_STORE_MODE=remote`（准备入线上库），
 * 所有 spawn 出来的 ingest 立刻因为"remote 模式缺凭据"退出 1，
 * 于是 markdown / write-api / batch-tags / content-edit / office-views /
 * folder-upload / dom-smoke 七套测试连锁失败 —— 而代码一行没动。
 *
 * 结论：**测试的子进程必须显式钉住本地存储**，不能继承开发者的 `.env`。
 * 真实环境变量优先于 `.env`（见 scripts/env.mjs 的规则），所以这里设的
 * DOCS_STORE_MODE 一定生效。
 *
 * @module scripts/lib/test-env
 */

/**
 * 构造测试子进程的环境变量。
 *
 * @param {object} [extra] - 额外要设的环境变量（会覆盖默认值）
 * @returns {object} 传给 spawn 的 env
 */
export function testChildEnv(extra = {}) {
  return {
    ...process.env,
    // 钉死本地存储：测试永远不该碰线上 Blobs
    DOCS_STORE_MODE: 'local',
    // 别让被测子进程继承这些 —— 它们会把写入引导到线上
    NETLIFY_ACCESS_TOKEN: '',
    SITE_ID: '',
    DOCS_LOCAL_DIR: process.env.DOCS_LOCAL_DIR ?? '',
    ...extra,
  }
}
