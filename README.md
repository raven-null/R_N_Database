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

无需安装任何依赖即可跑通：

```bash
node scripts/check.mjs        # 构建校验（含密钥泄漏扫描）
node scripts/probe.mjs        # 环境探测
node scripts/dev-server.mjs   # 本地服务器 → http://127.0.0.1:8899
```

打开 <http://127.0.0.1:8899/> 可看到自检面板；API 探活见
<http://127.0.0.1:8899/api/v1/health>。

本地默认使用 `.local-data/` 文件存储，**不会碰线上数据**。

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
| 1 | 入库流水线、预览生成、列表页、阅读页、门禁 | 待办 |
| 2 | 公用 API、工作站 MCP 工具、博客资料页 | 待办 |
| 3 | AI 分类打标、全文检索、拼音搜索 | 待办 |
| 4 | 备份导出、CI、容量审计 | 待办 |

详见 `docs/方案.md`。
