# museum-image-db

A local-first starter for building a museum artifact image library with React, FastAPI, PostgreSQL, and pgvector.

## Stack

- Frontend: React + TypeScript + Vite
- Backend: FastAPI + SQLAlchemy
- Database: PostgreSQL 16 + pgvector
- Runtime: Docker Compose

## Project Structure

```text
museum-image-db/
  frontend/          # React app
  backend/           # FastAPI app
  data/              # Local uploaded files and thumbnails
  docker-compose.yml
  .env.example
```

## Quick Start
运行命令

```bash
cp .env.example .env
docker compose up --build
```

Frontend: <http://localhost:5173\>

Backend health: <http://localhost:8000/api/health\>

## Current Scope

- Local development scaffold
- PostgreSQL connection and basic tables
- Museum, artifact, tag, and multi-image APIs
- Frontend dashboard to confirm the stack is wired up

## Data Model

- `museums`: 博物馆基础信息
- `artifacts`: 文物主表，包含 `id`、`name`、`era`、`museum_id`、`description`
- `artifact_tags`: 文物标签表，一个文物可关联多个标签
- `artifact_images`: 图片表，一个文物可关联多张图片，图片记录包含 `id`、`url`、`artifact_id`

接口返回时支持两种视角：

- 文物视角：返回文物基础信息、所属博物馆、标签数组、图片数组
- 图片视角：返回图片信息，并附带所属文物名称、博物馆、时代信息

## API Examples

创建文物（带多张图片和标签）：

```json
{
  "museum_id": 1,
  "name": "青铜鼎",
  "era": "商代",
  "description": "青铜礼器",
  "tags": ["青铜器", "礼器"],
  "images": [
    { "url": "https://example.com/ding-1.jpg" },
    { "url": "https://example.com/ding-2.jpg" }
  ]
}
```

文物视角返回结构：

```json
{
  "id": 1,
  "museum_id": 1,
  "name": "青铜鼎",
  "era": "商代",
  "description": "青铜礼器",
  "museum_name": "中国国家博物馆",
  "tags": ["青铜器", "礼器"],
  "images": [
    {
      "id": 11,
      "artifact_id": 1,
      "url": "https://example.com/ding-1.jpg",
      "artifact_name": "青铜鼎",
      "museum_name": "中国国家博物馆",
      "era": "商代"
    }
  ]
}
```

如果你之前已经启动过旧版本并创建了旧表结构，`create_all` 不会自动修改旧表；这时需要手动重建数据库，或后续接入迁移工具（如 Alembic）。

## 通义网页桥（相似图检索 / 以图搜图）

文物识别的准确度瓶颈在于「以图搜图」：模型只凭看图猜测时容易跑偏，而通义网页端（qianwen.com）内置了相似图检索 agent。`backend/app/web_bridge.py` 用 Playwright 驱动通义网页端：上传图片 → 提问 → 等待出答案 → 抓取并结构化为入库 JSON，作为额外的候选来源参与识别。

### 关键约束

- 必须驱动**真实的 Google Chrome**（`channel="chrome"`），并以**有头模式**运行（服务器上用 Xvfb 提供虚拟显示）。消费级站点会对自动化做校验，自带的 headless Chromium 上传会被拦截。
- 需要一次性**手动登录**，会话 cookie 保存到 `data/qwen_web_state.json`，运行时注入。
- 豆包（doubao）**不支持**：即便真实 Chrome + 已登录会话 + 可信点击，它的上传入口也不响应自动化，因此未接入。

### 一次性登录（在你能看到浏览器、可扫码的机器上）

```bash
# 该脚本依赖 playwright + 真实 Chrome
.venv-webtune/bin/python backend/scripts/web_bridge_login.py --duration 300
```

窗口打开后扫码/验证码完成登录即可，脚本会持续把会话保存到 `data/qwen_web_state.json`。

### 启用

在 `.env` 中设置（参见 `.env.example`）：

```bash
QWEN_WEB_ENABLED=true
WEB_HEADLESS=false                       # 有头模式（Docker 里走 Xvfb）
WEB_BROWSER_CHANNEL=chrome               # 真实 Google Chrome
WEB_USER_DATA_DIR=/data/web_chrome_profile
QWEN_WEB_STORAGE_STATE=/data/qwen_web_state.json
```

### Docker 部署

- 后端镜像已安装真实 Chrome 与 Xvfb（见 `backend/Dockerfile`），`CMD` 通过 `xvfb-run` 启动 uvicorn，有头 Chrome 可在无显示器服务器中运行。
- 把登录得到的 `data/qwen_web_state.json` 挂载/拷贝到容器的 `/data/` 下（与 `QWEN_WEB_STORAGE_STATE` 路径一致）。`data/` 在 compose 中已挂载，`WEB_USER_DATA_DIR` 的持久化 profile 也写在这里。

### 注意事项

- 有头真实 Chrome（Xvfb）比纯 API 占用更多 CPU/内存，识别也更慢（需等网页端 agent 跑完）。
- `WEB_USER_DATA_DIR` 持久化目录同一时刻只能被一个进程占用：后端单进程没问题，但**不要在后端运行时用同一个 profile 跑登录脚本**。
- 网页端 DOM 变化时，抓取可能失效：可调 `QWEN_WEB_ANSWER_SELECTOR`，或更新 `web_bridge.py` 里的输入框/发送按钮选择器。

## 批量识别入库（本地 → 云端 OSS）

面向「本地有大量图片，批量识别后入云端库」的工作流。两个角色共用同一套代码，靠 `APP_ROLE` 与环境变量区分：

```
本地机器 (APP_ROLE=local)                         阿里云服务器 (APP_ROLE=cloud)
- 选目录递归扫描图片                               - POST /api/ingest/artifacts (Bearer 鉴权)
- 顺序经通义网页桥识别                  ──HTTPS──▶   - 图片存阿里云 OSS，元数据入云端 Postgres
- 结果存本地 Postgres「待审核」表                   - GET /api/artifacts ... 供检索查询
- 逐条人工改表单 → 提交（图片+元数据发云端）
```

### 流程

1. 本地：在前端「批量入库」标签页填入要扫描的目录（容器内路径，默认挂载点 `/data/import`），点「扫描目录」。后端递归找出图片、按文件 hash 去重，写入 `pending_artifacts` 暂存表。
2. 本地：点「开始识别」，后端按顺序把每张图喂给通义网页桥（一次一个会话，约 30–60s/张），实时回填名称/年代/馆藏/标签/描述。
3. 本地：逐条核对、修改表单，点「提交云端」。本地把图片字节 + 元数据 POST 到云端 `/api/ingest/artifacts`；云端把图片传 OSS、元数据写云库，返回 artifact id。
4. 检索：直接查云端 `GET /api/artifacts` / `/api/artifact-images`。

### 本地侧配置（`.env`）

```bash
APP_ROLE=local
IMPORT_DIR=/abs/path/to/your/images   # 会被挂载到容器内 /data/import
QWEN_WEB_ENABLED=true                  # 见上一节，需先登录
CLOUD_API_BASE_URL=https://your-aliyun-server   # 云端地址
INGEST_TOKEN=<一段随机长字符串>        # 与云端保持一致
```

### 云端侧配置（阿里云服务器 `.env`）

```bash
APP_ROLE=cloud
INGEST_TOKEN=<与本地相同的字符串>
OSS_ACCESS_KEY_ID=...
OSS_ACCESS_KEY_SECRET=...
OSS_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com
OSS_BUCKET=your-bucket
# DATABASE_URL 指向云端 Postgres
```

### 云端部署：后端在阿里云（Docker），前端在 Vercel

前后端分离。云端只跑 **Postgres + 后端**；图库检索前端是纯静态，部署到 Vercel。

#### 1）阿里云服务器（后端 + DB）

`docker-compose.cloud.yml` 只含 Postgres(+pgvector) 与后端(cloud 角色)，不装 Chrome/Xvfb（`INSTALL_BROWSER=false`，构建精简）。

```bash
git pull
cp .env.example .env   # 首次：填 APP_ROLE=cloud / INGEST_TOKEN / OSS_* / POSTGRES_*
docker compose -f docker-compose.cloud.yml up -d --build
```

后端监听 `${BACKEND_PORT:-8000}`。以后更新：`git pull && docker compose -f docker-compose.cloud.yml up -d --build`。

#### 2）Vercel（前端）

在 Vercel 新建项目，指向本仓库：

- Root Directory：`frontend`
- Framework：Vite（自动识别）；Build：`npm run build`，Output：`dist`
- 环境变量：`VITE_CLOUD_ONLY=true`（只显示图库检索页）

前端如何连到后端，二选一：

- **A（推荐，免 CORS / 免后端 HTTPS）**：把 `frontend/vercel.json.example` 复制为 `frontend/vercel.json`，把 `YOUR_BACKEND_HOST` 换成你的服务器（如 `1.2.3.4:8000`）。Vercel 会在服务端把 `/api`、`/files` 反代到后端，浏览器始终同源。此时 `VITE_API_BASE_URL` 留空。
- **B（前端直连后端域名）**：设 `VITE_API_BASE_URL=https://api.你的域名`。⚠️ Vercel 是 HTTPS 页面，**后端必须也是 HTTPS**（否则浏览器拦截 mixed content），并在服务器 `.env` 的 `CORS_ORIGINS` 加上你的 Vercel 域名（逗号分隔）。给后端上 HTTPS 最省事的是在服务器前面挂一层带证书的反向代理（如 Caddy 自动签发）。

> 说明：文物图片走阿里云 OSS（绝对 https URL），前端直接从 OSS 加载，不依赖后端转发。

本地机器仍用默认的 `docker-compose.yml`（带 Chrome/Xvfb 跑识别 + 批量入库）。

### 接口一览

- 本地：`POST /api/batch/scan`、`POST /api/batch/identify/stream`(SSE)、`GET /api/batch/pending`、`GET /api/batch/pending/{id}/image`、`PATCH /api/batch/pending/{id}`、`POST /api/batch/pending/{id}/submit`、`DELETE /api/batch/pending/{id}`
- 云端：`POST /api/ingest/artifacts`（multipart：image + museum_name/name/era/description/tags，Bearer 鉴权）

### 注意

- `pending_artifacts` 是**本地暂存表**，不要部署到云端使用；它支持断点续跑（重扫同目录按 hash 去重）。
- 批量识别串行且慢（网页桥一次一个会话），属预期；可分批跑。
- 原图通过后端 `GET /api/batch/pending/{id}/image` 提供给前端预览（直接读本地源文件，不复制）。

## Planned Next Steps

- Add batch image upload by museum
- Extract image metadata and file hash
- Integrate a multimodal model for title and summary generation
- Store model output and review status in the database
- Add search, filters, and review pages
