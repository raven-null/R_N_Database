/**
 * 纯文本类（md / txt / csv / code）的正文规整。
 *
 * ## 为什么在 _lib 里
 *
 * 这份逻辑有两个使用方，而且必须严格一致：
 *   1. 入库脚本 scripts/lib/extract.mjs —— 文件**第一次进来**时算正文；
 *   2. 网页编辑接口 routes/docs.mjs —— 内容**被改写**后重算正文。
 *
 * 如果两边各写一份，编辑过一次的文档正文就与入库算法不同了：
 * textChars 对不上、检索的词频也悄悄变了，而这种偏差极难发现。
 * 因此算法放在函数侧共享模块，脚本反过来引用（项目一贯的依赖方向）。
 *
 * ## 为什么 code 不清洗
 *
 * `cleanText` 会压缩连续空格、去掉行首缩进、合并多余空行 —— 对检索无害，
 * 但对代码是**毁灭性**的：缩进就是语法（Python）、行尾空白可能是有意义的
 * （Makefile 的 tab、Markdown 的强制换行）。所以代码只统一换行符。
 *
 * @module netlify/functions/_lib/plain-text
 */

/**
 * 清洗抽取到的文本：统一空白、去掉零宽字符、压缩多余空行。
 *
 * @param {string} raw - 原始文本
 * @returns {string} 清洗后文本
 */
export function cleanText(raw) {
  return String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')   // 零宽字符
    .replace(/[ \t\u00A0]+/g, ' ')            // 连续空格/不换行空格
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 把纯文本类文件的原始内容转成「入库用正文」。
 *
 * @param {Buffer|string|ArrayBuffer} raw - 原始内容
 * @param {string} type - 规范化类型（code / md / txt / csv）
 * @returns {string} 正文
 */
export function plainTextOf(raw, type) {
  const s = typeof raw === 'string'
    ? raw
    : Buffer.from(raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw).toString('utf8')
  const lf = s.replace(/\r\n?/g, '\n')
  // 代码保留原样（缩进/空行是内容的一部分），其余按抽取规则清洗
  return type === 'code' ? lf : cleanText(lf)
}

/**
 * 数行数 —— 行尾的换行符是**终止符**，不该多算一行。
 *
 * 这个细节很容易写错：`'a\nb\n'.split('\n').length === 3`，但文件就是 2 行。
 * 用错的地方会立刻看出来 —— 代码预览页的行号列会多出一个孤零零的尾号，
 * 而代码块里没有对应的那一行（行号列比代码块高一个行高）。
 *
 * @param {string} s - 文本
 * @returns {number} 行数（空文本记为 1 行，与编辑器一致）
 */
export function countLines(s) {
  const t = String(s ?? '')
  if (t === '') return 1
  return t.replace(/\n$/, '').split('\n').length
}
