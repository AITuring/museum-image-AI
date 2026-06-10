# 部署指南（DEPLOY）

三处运行环境，各司其职：

| 位置 | 跑什么 | 用什么 |
| --- | --- | --- |
| **阿里云服务器** | Postgres + 后端（cloud 角色，OSS 入库 / 检索 API） | Docker `docker-compose.cloud.yml` |
| **Vercel** | 图库检索前端（纯静态） | Vercel 项目，Root = `frontend` |
| **本地机器** | 单图/批量识别（通义网页桥 + Chrome）+ 提交云端 | Docker `docker-compose.yml` |

数据流：本地扫描目录 → 通义识别 → 人工核对 → 带 `INGEST_TOKEN` 提交到云端 `/api/ingest/artifacts` → 云端图片入 OSS、元数据入库 → Vercel 前端检索云端。

---

## 一、阿里云服务器（后端 + 数据库）

### 1. 安装 Docker（一次性）

```bash
curl -fsSL https://get.docker.com | bash -s docker --mirror Aliyun
sudo systemctl enable --now docker
docker compose version
```

### 2. 开放端口

- 阿里云控制台 → ECS → 安全组 → 入方向：放行 TCP `8000`（来源 `0.0.0.0/0` 或仅信任 IP）。
- 服务器防火墙（若启用）：`sudo ufw allow 8000/tcp`（或 firewalld 对应命令）。

### 3. 拉代码

```bash
cd /opt
git clone https://github.com/AITuring/museum-image-AI.git museum-image
cd museum-image
```

### 4. 配置 `.env`

```bash
cp .env.example .env
openssl rand -hex 32        # 生成 INGEST_TOKEN，记下来，本地要用同一个
vi .env
```

云端必填项：

```bash
APP_ROLE=cloud
APP_ENV=production

POSTGRES_DB=museum_image_db
POSTGRES_USER=museum
POSTGRES_PASSWORD=改成强密码
DATABASE_URL=postgresql+psycopg://museum:改成强密码@postgres:5432/museum_image_db

BACKEND_PORT=8000
INGEST_TOKEN=粘贴 openssl 生成的串

OSS_ACCESS_KEY_ID=你的AK
OSS_ACCESS_KEY_SECRET=你的SK
OSS_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com   # 改成 bucket 所在地域
OSS_BUCKET=你的bucket名
OSS_KEY_PREFIX=artifacts/

# 仅 Vercel 选项 B（前端直连）才需要：
# CORS_ORIGINS=https://your-app.vercel.app
```

> `DATABASE_URL` 的密码与 `POSTGRES_PASSWORD` 必须一致；主机名固定写 `postgres`。

OSS 准备：建 Bucket（记地域）→ 建 RAM AccessKey 并授权该 Bucket 读写 → Bucket 设「公共读」（否则前端看不到图）→ 若有防盗链白名单，加入 Vercel 域名。

### 5. 启动 / 更新 / 停止

```bash
# 首次启动（构建镜像，约几分钟）
docker compose -f docker-compose.cloud.yml up -d --build

# 查看状态 / 日志
docker compose -f docker-compose.cloud.yml ps
docker compose -f docker-compose.cloud.yml logs -f backend

# 代码更新后重新部署
git pull && docker compose -f docker-compose.cloud.yml up -d --build

# 重启后端
docker compose -f docker-compose.cloud.yml restart backend

# 停止（保留数据库卷）
docker compose -f docker-compose.cloud.yml down
# 停止并删除数据库卷（危险，会清空数据）
docker compose -f docker-compose.cloud.yml down -v
```

### 6. 验证

```bash
curl http://localhost:8000/api/health           # 服务器本机
curl http://<公网IP>:8000/api/health            # 外网，应返回 {"status":"ok",...}
curl -X POST http://<公网IP>:8000/api/ingest/artifacts   # 无 token，应 401/503
```

---

## 二、Vercel（前端）

在 Vercel 新建项目，导入本仓库：

- **Root Directory**：`frontend`
- Framework：Vite（自动识别），Build：`npm run build`，Output：`dist`
- 环境变量：`VITE_CLOUD_ONLY=true`

连接后端二选一：

### 选项 A（推荐：免 CORS、免后端 HTTPS）

```bash
# 在本地仓库里操作，然后提交
cp frontend/vercel.json.example frontend/vercel.json
# 编辑 vercel.json：把 YOUR_BACKEND_HOST 改成  <公网IP>:8000
git add frontend/vercel.json && git commit -m "chore: vercel proxy" && git push
```

Vercel 会在服务端把 `/api`、`/files` 反代到后端，浏览器始终同源。此时 `VITE_API_BASE_URL` 留空（不用设）。

### 选项 B（前端直连后端域名）

- Vercel 环境变量加：`VITE_API_BASE_URL=https://api.你的域名`
- ⚠️ 后端必须是 HTTPS（Vercel 是 HTTPS 页面，调 http 会被浏览器拦），需给后端挂带证书的反向代理。
- 服务器 `.env` 加：`CORS_ORIGINS=https://your-app.vercel.app`，重启后端。

部署：`git push` 后 Vercel 自动构建；打开 Vercel 域名即图库检索页。

---

## 三、本地机器（识别 + 批量入库）

需要本机能看到浏览器扫码登录通义。用默认的 `docker-compose.yml`（含 Chrome/Xvfb）。

### 1. 登录通义（一次性，在宿主机执行）

```bash
# 安装一次性 playwright 环境（或复用 .venv-webtune）
python3 -m venv .venv-webtune && .venv-webtune/bin/pip install playwright && .venv-webtune/bin/playwright install chrome
.venv-webtune/bin/python backend/scripts/web_bridge_login.py --duration 300
# 扫码登录通义，会话保存到 data/qwen_web_state.json
```

### 2. 配置本地 `.env`

```bash
cp .env.example .env
vi .env
```

```bash
APP_ROLE=local
DASHSCOPE_API_KEY=你的key            # 用于把网页答案结构化为入库 JSON
QWEN_WEB_ENABLED=true
WEB_HEADLESS=false
IMPORT_DIR=/absolute/path/to/your/images  # 要批量识别的图片目录，会挂到容器 /data/import

CLOUD_API_BASE_URL=http://<公网IP>:8000   # 云端后端地址（本地→云端是服务端调用，http 即可）
INGEST_TOKEN=与云端完全相同的那串
```

### 3. 启动 / 停止

```bash
docker compose up --build            # 前端 http://localhost:5173 ，后端 :8000
docker compose down
```

### 4. 使用

1. 浏览器开 `http://localhost:5173` → 「批量入库」标签。
2. 目录填 `/data/import`（即上面 `IMPORT_DIR` 挂载点）→ 扫描目录。
3. 「开始识别」顺序跑（每张约 30–60s）。
4. 逐条核对表单 → 「提交云端」。提交成功后 Vercel 图库即可检索到。

---

## 端口与连接速查

| 环节 | 地址 | 说明 |
| --- | --- | --- |
| 云端后端 | `http://<公网IP>:8000` | 安全组+防火墙放行 8000 |
| 健康检查 | `GET /api/health` | 返回 ok |
| 云端入库 | `POST /api/ingest/artifacts` | Bearer `INGEST_TOKEN` |
| Vercel 前端 | `https://<app>.vercel.app` | 选项 A 反代 / 选项 B 直连 |
| 本地前端 | `http://localhost:5173` | 识别 + 批量入库 |
| 本地后端 | `http://localhost:8000` | 同机调用云端 |

`INGEST_TOKEN` 是本地↔云端的唯一写入凭证，两边必须一致。

---

## 安全提醒（重要）

- `.env` 已被 `.gitignore` 忽略，**切勿**提交真实密钥。
- `data/*_web_state.json`（通义登录会话）、Chrome profile 等属于敏感数据，已加入 `.gitignore`。若历史中已误提交，需从 Git 历史移除（见下）并**重新登录刷新会话**：

```bash
git rm --cached data/qwen_web_state.json data/doubao_web_state.json
git commit -m "chore: 移除误提交的登录会话"
# 彻底清历史（可选，需谨慎，会改写历史）：
# git filter-repo --path data/qwen_web_state.json --path data/doubao_web_state.json --invert-paths
git push
```
