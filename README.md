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

在 `.env` 中保留这几个最小配置即可：

```bash
QWEN_WEB_ENABLED=true
QWEN_WEB_STORAGE_STATE=/data/qwen_web_state.json
WEB_BRIDGE_REMOTE_URL=http://host.docker.internal:8011   # 可选，推荐本机 Docker 开发时使用
```

### Docker 部署

- 后端镜像已安装真实 Chrome 与 Xvfb（见 `backend/Dockerfile`），`CMD` 通过 `xvfb-run` 启动 uvicorn，有头 Chrome 可在无显示器服务器中运行。
- 把登录得到的 `data/qwen_web_state.json` 挂载/拷贝到容器的 `/data/` 下（与 `QWEN_WEB_STORAGE_STATE` 路径一致）。`data/` 在 compose 中已挂载。

### 宿主机桥接模式（推荐给本机 Docker 开发）

如果 Docker 里的 `Chrome + Xvfb` 无法稳定拉起通义上传入口，可以把网页桥执行挪到宿主机，Docker 后端只通过 HTTP 调它：

```bash
# 宿主机启动 bridge 服务（需先执行过一次 web_bridge_login.py）
.venv-webtune/bin/python backend/scripts/host_web_bridge_server.py --port 8011
```

`.env` 中增加：

```bash
WEB_BRIDGE_REMOTE_URL=http://host.docker.internal:8011
```

然后重启 Docker 后端。此模式下：

- 宿主机 bridge 负责真实 Chrome、登录态和页面自动化。
- Docker 后端只上传图片字节、接收网页回答，再继续走原来的结构化和候选合并逻辑。
- `docker-compose.yml` 已补 `host.docker.internal` 映射，macOS / Docker Desktop 可直接访问宿主机服务。

### 注意事项

- 有头真实 Chrome（Xvfb）比纯 API 占用更多 CPU/内存，识别也更慢（需等网页端 agent 跑完）。
- 网页端 DOM 变化时，抓取可能失效，此时需要调整 `backend/app/web_bridge.py` 中的选择器逻辑。
- 图片上传前会自动做网页桥兼容处理，不会修改你的本地原图。

## 批量识别入库（本地同步 / Google Photos 同步 → 云端 OSS）

面向「本地有大量图片，或需要从 Google Photos 拉图，再批量识别并入云端库」的工作流。两个角色共用同一套代码，靠 `APP_ROLE` 与环境变量区分：

```
本地机器 (APP_ROLE=local)                         阿里云服务器 (APP_ROLE=cloud)
- 本地文件夹上传 / Google Photos 同步              - POST /api/ingest/artifacts (Bearer 鉴权)
- 图片统一进入本地 Postgres「待处理」表   ──HTTPS──▶   - 图片存阿里云 OSS，元数据入云端 Postgres
- 顺序经通义网页桥识别                              - GET /api/artifacts ... 供检索查询
- 逐条人工改表单 → 提交（图片+元数据发云端）
```

### 流程

1. 本地：在前端「批量识别入库」页选择一种入口。
   - 本地文件夹：点「选择文件夹并上传」，浏览器把图片发给后端 `/api/batch/scan-files`。
   - Google Photos：点「连接 Google Photos」并授权后，选择相册和图片，调用 `/api/google-photos/import`。
2. 本地：后端按图片内容 hash 去重，把新增图片统一写入 `pending_artifacts` 暂存表。
3. 本地：点「开始识别」，后端按顺序把每张图喂给通义网页桥（一次一个会话，约 30–60s/张），实时回填名称/年代/馆藏/标签/描述。
4. 本地：逐条核对、修改表单，点「提交云端」。本地把图片字节 + 元数据 POST 到云端 `/api/ingest/artifacts`；云端把图片传 OSS、元数据写云库。
5. 如果某张图之前已经成功入过云端，云端会按图片 hash 识别为重复图片并直接跳过，不会因为重复上传中断流程。
6. 检索：直接查云端 `GET /api/artifacts` / `/api/artifact-images`。

### 本地侧配置（`.env`）

```bash
APP_ROLE=local
IMPORT_DIR=./import
QWEN_WEB_ENABLED=true
QWEN_WEB_STORAGE_STATE=/data/qwen_web_state.json
CLOUD_API_BASE_URL=https://your-aliyun-server
INGEST_TOKEN=<与云端一致的共享令牌>
```

### 本地上传 / Google Photos 同步

前端「批量识别入库」页现在有两个并列入口：

- 本地上传：从浏览器直接选择本地文件夹，后端接收图片后按 hash 去重，写入 `pending_artifacts`。
- Google Photos 同步：授权后读取你的 Google 相册，下载所选原图后按 hash 去重，写入 `pending_artifacts`。

两条入口在“进入待处理池”之后完全共用后续链路：识别、人工确认、提交云端、重复上传跳过。

### 从 Google Photos 导入

适用于你自己的 Google 相册图片，导入后会直接进入本地 `pending_artifacts` 暂存表，再继续走现有的「识别 -> 人工核对 -> 提交云端」链路。

#### 1）Google Cloud Console 配置 OAuth

- 创建一个 OAuth Client（Web application）。
- Authorized redirect URI 填你本地后端回调地址，例如：

```text
http://localhost:8000/api/google-photos/callback
```

#### 2）本地 `.env` 增加

```bash
GOOGLE_PHOTOS_CLIENT_ID=...
GOOGLE_PHOTOS_CLIENT_SECRET=...
GOOGLE_PHOTOS_REDIRECT_URI=http://localhost:8000/api/google-photos/callback
```

#### 3）前端操作

- 打开「批量识别入库」页。
- 点「连接 Google Photos」，在弹窗里完成 Google 授权。
- 选择相册、勾选图片、点「导入所选图片」。
- 导入后的图片会进入当前批量列表，可直接继续点「开始识别」。

#### 4）实现方式

- 后端通过 Google Photos Library API 读取相册和媒体项。
- 导入时会下载原图字节，按文件 hash 去重，写入 `pending_artifacts.image_blob`。
- 后续识别时，Google Photos 导入项不再依赖浏览器本地文件，而是直接走后端暂存记录。
- 如果后面再次导入同一张图，`pending_artifacts` 会先按 hash 跳过；即使后续再次提交到云端，云端也会再次按 hash 做幂等跳过。

### 云端侧配置（阿里云服务器 `.env`）

```bash
APP_ROLE=cloud
INGEST_TOKEN=<与本地相同的字符串>
DATABASE_URL=postgresql+psycopg://...
OSS_ACCESS_KEY_ID=...
OSS_ACCESS_KEY_SECRET=...
OSS_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com
OSS_BUCKET=your-bucket
OSS_PUBLIC_BASE_URL=
```

### 云端部署：后端在阿里云（Docker），前端在 Vercel

前后端分离。云端只跑 **Postgres + 后端**；图库检索前端是纯静态，部署到 Vercel。

#### 1）阿里云服务器（后端 + DB）

`docker-compose.cloud.yml` 只含 Postgres(+pgvector) 与后端(cloud 角色)，不装 Chrome/Xvfb，构建更轻。

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

- 本地：`POST /api/batch/scan`、`POST /api/batch/scan-files`、`POST /api/batch/identify/stream`(SSE)、`GET /api/batch/pending`、`GET /api/batch/pending/{id}/image`、`PATCH /api/batch/pending/{id}`、`POST /api/batch/pending/{id}/submit`、`DELETE /api/batch/pending/{id}`、`GET /api/google-photos/status`、`GET /api/google-photos/albums`、`GET /api/google-photos/media-items`、`POST /api/google-photos/import`
- 云端：`POST /api/ingest/artifacts`（multipart：image + museum_name/name/era/description/tags，Bearer 鉴权）

### 注意

- `pending_artifacts` 是**本地暂存表**，不要部署到云端使用；它支持断点续跑（重扫同目录按 hash 去重）。
- 云端 `artifact_images.image_hash` 也会做一层幂等保护；同一张图再次提交时会被识别为重复图片并跳过，不会报错中断。
- 批量识别串行且慢（网页桥一次一个会话），属预期；可分批跑。
- 原图通过后端 `GET /api/batch/pending/{id}/image` 提供给前端预览（直接读本地源文件，不复制）。

## 环境变量

项目现在只保留最小环境变量集合，完整模板见 `.env.example`。

### 本地开发最少需要

```bash
APP_ENV=development
APP_ROLE=local
DATABASE_URL=postgresql+psycopg://museum:museum123@postgres:5432/museum_image_db
CORS_ORIGINS=http://localhost:5173
VITE_API_BASE_URL=http://localhost:8000
```

### 启用通义网页桥

```bash
QWEN_WEB_ENABLED=true
QWEN_WEB_STORAGE_STATE=/data/qwen_web_state.json
WEB_BRIDGE_REMOTE_URL=http://host.docker.internal:8011
```

### 启用描述生成

```bash
DASHSCOPE_API_KEY=你的 key
WEB_STRUCTURING_MODEL=qwen-plus
```

### 启用 Google Photos 导入

```bash
GOOGLE_PHOTOS_CLIENT_ID=...
GOOGLE_PHOTOS_CLIENT_SECRET=...
GOOGLE_PHOTOS_REDIRECT_URI=http://localhost:8000/api/google-photos/callback
```

### 启用云端提交 / OSS

```bash
CLOUD_API_BASE_URL=https://your-cloud-api
INGEST_TOKEN=your-shared-token
OSS_ACCESS_KEY_ID=...
OSS_ACCESS_KEY_SECRET=...
OSS_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com
OSS_BUCKET=your-bucket
OSS_PUBLIC_BASE_URL=
```

## 联调命令

### 1）准备 `.env`

```bash
cp .env.example .env
```

### 2）检查 compose 配置

```bash
docker compose config
```

### 3）启动本地 Docker

```bash
docker compose up --build
```

### 4）确认服务在线

```bash
curl http://localhost:8000/api/health
curl http://localhost:8000/api/google-photos/status
```

### 5）从浏览器做真实联调

- 打开 `http://localhost:5173`
- 进入「批量识别入库」测试本地上传或 Google Photos
- 进入「EXIF 入库」测试单图上传、名称解析、描述生成、EXIF 回写
- 核对后提交到云端

### 6）检查待处理池

```bash
curl http://localhost:8000/api/batch/pending
```

## Planned Next Steps

- Add batch image upload by museum
- Extract image metadata and file hash
- Integrate a multimodal model for title and summary generation
- Store model output and review status in the database
- Add search, filters, and review pages
