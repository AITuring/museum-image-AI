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

## Planned Next Steps

- Add batch image upload by museum
- Extract image metadata and file hash
- Integrate a multimodal model for title and summary generation
- Store model output and review status in the database
- Add search, filters, and review pages
