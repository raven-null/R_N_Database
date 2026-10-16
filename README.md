# R_N_Database · 个人数据资料库

存放个人文档资料的私有数据中心。部署在 Netlify，通过公用 API 对接
[智能工作站](../01-smart-workstation) 与 [个人博客](../01-personal-blog)。

## 三个目标

1. **看得流畅** —— 网页打开即读，支持下载
2. **接得出去** —— 带版本的只读 API，供工作站（含 MCP 工具）与博客消费
3. **找得到** —— AI 自动分类打标 + 全文检索 + 拼音搜索

## 技术选型

沿用本项目群已验证的架构（见 `01-private-gallery` / `01-personal-blog`）：
Netlify 静态站 + Functions v2 + **Netlify Blobs** 作存储，零构建、无框架。

资料原件只进 Blobs，**永不进 Git**。

## 快速开始（本地）

```bash
npm install                     # 装依赖（首次）
node scripts/ingest.mjs         # 把 inbox/ 里的文档入库
node scripts/dev-server.mjs     # 启动 → http://127.0.0.1:8899
```

打开 <http://127.0.0.1:8899/>：左侧按分类/格式/标签筛选，顶部搜索框即时筛选，
**按回车则全文检索正文**；点任意文档进入阅读页，可直接内嵌预览与下载。

入库指定目录（不必先拷进 `inbox/`）：

```bash
node scripts/ingest.mjs "D:\我的文档"       # 递归扫描
node scripts/ingest.mjs "D:\我的文档" --dry-run   # 只看会入库什么
node scripts/ingest.mjs --force            # 忽略去重强制重入
node scripts/ingest.mjs --no-ai            # 只用规则分类，跳过 AI
```

改过分类词表或分词策略后重建索引（**不重新抽取文档**）：

```bash
node scripts/reindex.mjs         # 重建检索索引
node scripts/reclassify.mjs      # 只重跑分类（改词表/打分模型后）
node scripts/reclassify.mjs --dry-run   # 只看会怎么变
```

清库（预演默认不删）：

```bash
node scripts/reset.mjs           # 报告将删除什么
node scripts/reset.mjs --yes     # 真删（只删库内副本，源文件不受影响）
```

其他命令：

```bash
node scripts/check.mjs           # 构建校验（含密钥泄漏扫描）
node scripts/probe.mjs           # 环境探测
npm run test:classify            # 分类回归（16 项，语料无关）
npm run test:api                 # 写操作回归（30 项，自造临时文档）
npm run test:dom                 # 前端冒烟（需 dev-server 在跑）
npm run test:render              # 真实浏览器渲染检查（需 Chrome）
```

本地默认使用 `.local-data/` 文件存储，**不会碰线上数据**。

## 开启 AI 打标（可选）

不配也能用 —— 规则层会给出分类与标签，只是没有 AI 摘要、标签偏粗。
要开启，`.env` 里任选一种：

```bash
# 方式一：智谱（沿用图库 ai-proxy 的配置）
ZHIPU_API_KEY=你的key

# 方式二：任意 OpenAI 兼容端点
AI_BASE_URL=https://token-plan-cn.xiaomimimo.com/v1
AI_API_KEY=你的key
AI_MODEL=mimo-v2.5

# 方式三：直接复用工作站已有的密钥文件（不写这行就绝不会去读）
DOCS_AI_ENV=E:\01-smart-workstation\.env
```

密钥来源优先级：`AI_API_KEY` → `ZHIPU_API_KEY` → `STATION_LLM_API_KEY`。

## 入库流水线

```
扫描目录
  → SHA-256 去重（同内容自动识别；同路径不同内容删旧迎新）
  → 抽元数据（标题/作者/页数/创建时间）
  → 抽正文：pdfjs-dist(PDF) · mammoth(docx) · exceljs(xlsx) · JSZip(pptx)
  → 分类打标：规则层始终跑；配了 ZHIPU_API_KEY 再叠 AI 层
  → 生成预览件：PDF 直接用原件；Office 装 LibreOffice 则转 PDF，否则 HTML 降级
  → 直写存储 → 重建倒排索引
```

**标题处理有个坑值得说明**：PDF/PPTX 的内嵌 Title 常是 `about:blank`、
`空白演示` 这类垃圾值。若直接采信，列表页会显示一串无意义标题，
而且会顶掉文件名 —— 分类规则就拿不到「简历」「发票」这类关键线索。
实测一份简历因内嵌标题是 `about:blank` 被误分到「项目文档」。
现在垃圾标题会被丢弃并回退到文件名。

## 分类与检索

### 分类：受控词表

`config/taxonomy.json` 定义 10 个一级分类 + 起始标签集。
**AI 只能从词表里选，不允许自由造分类**；新建标签会自动追加「待整理」
提醒复查 —— 不加这条约束，分类迟早腐烂成一堆同义词。

规则打分的关键设计：**标题命中权重 10 倍于正文**，且对跨分类的歧义词降权。
初版让标题与正文同权，结果一份文件名含「简历」的 PDF 被正文里的「设计」
和「指标」反超，分到了「项目文档」。

### 检索：BM25 + 中英混排分词

- **分词用 `Intl.Segmenter`**（Node 20+ 与浏览器原生支持），零依赖
- 索引同时写**分词结果**与 **CJK 二元组**：后者用于召回兜底
- 打分用 **BM25**（词频饱和 + 文档长度归一化）

第一版只按「命中词条数 × idf」打分，缺陷明显：搜「操作系统」时，
一份**只在技能栏提了一次**「操作系统」的简历，与整篇讲操作系统的课件
拿到完全相同的 2.30 分。改用 BM25 后变成 0.87 / 0.76 / 0.41，排序正确 ——
「提一次」和「通篇都是」终于被区分开了。

前端筛选与即时搜索走本地（manifest 一次拉全库），只有按回车查正文时才打接口。

## 部署流程（GitHub → Netlify 自动部署）

```
① 本地建仓（已完成）
   git init -b main && git add -A && git commit
② 推上 GitHub
   git remote add origin git@github.com:raven-null/R_N_Database.git
   git push -u origin main
③ Netlify 接入
   Add new site → Import an existing project → GitHub → 选 R_N_Database
   （构建命令与发布目录由仓库里的 netlify.toml 决定）
④ 开启 Blobs
   站点 Settings → Data collection → 启用
   ★ 不做这步线上会明确报错（本项目刻意禁止静默回退，见下）
⑤ 配置环境变量（Site settings → Environment variables）
   ADMIN_TOKEN     必填，首次访问密码
   ALLOWED_ORIGIN  必填，CORS 白名单（如 https://ravennull.work）
   ZHIPU_API_KEY   可选，AI 打标；不填则自动降级为纯规则
   ⚠ 绝不要配 SITE_ID / NETLIFY_ACCESS_TOKEN —— 见下方说明
⑥ 本地 .env 填 SITE_ID + Access Token（供入库脚本直写 Blobs）
⑦ 验证：访问 /api/v1/health
```

日常使用：**入库不需要 push**（数据在 Blobs 里），只有改代码才需要。

## 几个刻意的设计决定

### 1. 线上禁止静默回退到本地文件

`01-private-gallery` 的做法是：Blobs 不可用时退回本地文件存储。
本地开发很贴心，但套到 Git 自动部署上是隐患 —— 线上万一 Blobs 没启用，
函数会静默往临时目录写文件，**入库看着成功、数据在冷启动后蒸发，且不报错**。

本项目改为：检测到运行在 Netlify 函数里就直接抛明确错误，
提示你去开启 Blobs。参见 `netlify/functions/_lib/store.mjs`。

### 2. 线上未配密码 = 拒绝所有访问

图库在「未设访问密码」时是**放行**的（避免把自己锁在外面）。
这对公开站点合理，但对私有资料库是危险的默认值。

本项目改为 fail-closed：线上没配 `ADMIN_TOKEN` 就一律拒绝，
并在 `/api/v1/health` 里明确报出来。本地开发仍然放行，方便调试。

### 3. 绝不在 Netlify 配 SITE_ID / Access Token

Netlify Functions 运行时**自动注入** Blobs 凭据，零配置即可读写。
显式配置反而会把一把长期有效的全站令牌塞进构建环境，
一旦泄露等于交出整个站点数据。

那把令牌只放本地 `.env`（已 gitignore），供入库脚本直写 Blobs 用。
入库走直写而非 HTTP 上传接口，是因为图库项目评审记录过 base64 上传
导致峰值内存放大到约 55MB（15MB 文件）的问题。

### 4. 构建命令不是 echo 占位

图库和博客都用 `echo '静态站，无需构建'`。但 Git 自动部署意味着
每次 push 都直接影响线上，一个语法错误就会把站点打挂。

本项目改为 `node scripts/check.mjs`，做四类校验（结构 / 函数可加载 /
配置 / **密钥泄漏扫描**），失败则构建失败、线上保持上一个正常版本。

因为仓库是**公开**的，`check.mjs` 里的密钥扫描是重点：
它会拦住 `.gitignore` 漏项、代码里硬编码的密钥、`nfp_` 开头的
Netlify Token 等。push 前跑一次即可。

## 目录结构

```
├─ netlify.toml              Netlify 配置（Node 版本钉死、安全头、缓存策略）
├─ netlify/functions/        Functions v2（ESM，各自声明 config.path）
│  ├─ health.mjs             GET /api/v1/health
│  └─ _lib/                  store · auth · cors · respond
├─ public/                   静态站（零构建，ES 模块）
├─ scripts/                  check · dev-server · probe · env ·（后续 ingest）
└─ docs/                     方案与 API 契约
```

## 分阶段

| 阶段 | 内容 | 状态 |
|---|---|---|
| 0 | 地基：骨架、存储层、鉴权层、探活、构建护栏 | ✅ |
| 1 | 入库流水线、预览生成、列表页、阅读页、检索 | ✅ |
| 2 | 公用 API 冻结、工作站 MCP 工具、博客资料页 | API 已完成，待接入 |
| 3 | AI 自动分类打标（需配 ZHIPU_API_KEY 验证效果） | 代码就绪，待验证 |
| 4 | 密码门禁 UI、备份导出、CI、容量审计 | 待办 |

### 已实现的 API（`/api/v1`）

```
GET  /api/v1/health              探活与自检（免鉴权，不泄密）
GET  /api/v1/docs                列表（q/category/tag/type/sort/page/limit）
GET  /api/v1/docs/{id}           元数据
GET  /api/v1/docs/{id}/text      抽取正文（给 AI 用，支持 ?maxChars=）
GET  /api/v1/docs/{id}/file      原件（支持 Range，附件下载）
GET  /api/v1/docs/{id}/preview   预览件（内联，PDF/HTML）
GET  /api/v1/search?q=           全文检索（BM25，带命中片段与页码）
GET  /api/v1/taxonomy            分类树 + 标签表（含计数）
GET  /api/v1/manifest            全量清单 + 索引版本（支持 ETag → 304）
POST /api/v1/auth/login          密码换角色
GET  /api/v1/auth/status         当前鉴权状态
```

统一响应：成功 `{ ok:true, data }`，失败 `{ ok:false, error:{code,message} }`。
鉴权三通道：`X-Auth-Token` 头、`?token=`、`?exp=&sig=` 短期签名 URL。

详见 `docs/方案.md`。
