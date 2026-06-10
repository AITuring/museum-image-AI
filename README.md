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

## Planned Next Steps

- Add batch image upload by museum
- Extract image metadata and file hash
- Integrate a multimodal model for title and summary generation
- Store model output and review status in the database
- Add search, filters, and review pages
