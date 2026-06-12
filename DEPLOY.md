# 部署指南（DEPLOY）

三处运行环境，各司其职：

| 位置 | 跑什么 | 用什么 |
| --- | --- | --- |
| **阿里云服务器** | Postgres + 后端（cloud 角色，OSS 入库 / 检索 API） | Docker `docker-compose.cloud.yml` |
| **Vercel** | 线上图库前端（连云端后端，纯静态） | Vercel 项目，Root = `frontend` |
| **本地机器 · Docker** | 识图服务（识别控制台 + 本地后端 + 本地库），通义网页桥 + Chrome | Docker `docker-compose.yml` |
| **本地机器 · npm** | 线上图库前端的本地预览（连**云端**后端） | `cd frontend && npm run dev` |

> 关键原则：**「识图」永远连本地后端，「图库」永远连云端后端**。
> - Docker（识图控制台 `:5173` + 本地后端 `:8000`）只负责识别和入库到云端，互不掺和图库。
> - 图库（Vercel 线上、本地 `npm run dev` 的 `:7001`）都只读云端后端，且都用「同源 + 服务端反代」的方式连接（Vercel 用 `vercel.json` rewrites，本地用 Vite dev proxy），所以**不需要给云端配 CORS**。

数据流：本地扫描目录 → 通义识别 → 人工核对 → 带 `INGEST_TOKEN` 提交到云端 `/api/ingest/artifacts` → 云端图片入 OSS、元数据入库 → Vercel / 本地 `:7001` 图库检索云端。

---

## 一、阿里云服务器（后端 + 数据库）

### 1. 安装 Docker（一次性）

国内阿里云服务器走官方脚本 `get.docker.com` 常被重置（`curl: (35) Connection reset by peer`），直接用阿里云 apt 源安装最稳：

```bash
# 依赖
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg

# 阿里云 Docker GPG key
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://mirrors.aliyun.com/docker-ce/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# 阿里云 Docker 源（VERSION_CODENAME 自动取系统代号，如 jammy）
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://mirrors.aliyun.com/docker-ce/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# 安装 Docker + compose 插件
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# 启动并验证
sudo systemctl enable --now docker
docker compose version
```

> 镜像加速器（构建时从 Docker Hub 拉 `python`/`postgres` 等基础镜像会快很多）：
>
> ```bash
> sudo mkdir -p /etc/docker
> sudo tee /etc/docker/daemon.json > /dev/null <<'EOF'
> {
>   "registry-mirrors": ["https://docker.1ms.run", "https://docker.mirrors.ustc.edu.cn"]
> }
> EOF
> sudo systemctl daemon-reload && sudo systemctl restart docker
> ```

> **故障排查：`apt-get update` 报 GPG / 仓库未签名错误**
> 多为服务器上残留的无关第三方源（如 MongoDB）公钥缺失导致。先定位并清理：
>
> ```bash
> grep -rl mongodb /etc/apt/sources.list /etc/apt/sources.list.d/ 2>/dev/null
> sudo rm /etc/apt/sources.list.d/mongodb-org-7.0.list   # 用实际输出的文件名
> sudo apt-get update
> ```

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

本地有两件事，互不影响：

- **识图服务（Docker）**：`docker-compose.yml` 起 3 个容器——`postgres`（本地库 `:5432`）、`backend`（识图后端 `:8000`，`APP_ROLE=local`）、`frontend`（识别控制台 `:5173`，跑 `npm run dev:identify`）。控制台连的是**本地** `:8000`。
- **线上图库预览（npm）**：`cd frontend && npm run dev`，在 `:7001` 起一个 cloud-only 图库，连的是**云端**后端（见下「5. 本地预览线上图库」）。

识图服务需要本机能看到浏览器扫码登录通义。用默认的 `docker-compose.yml`（含 Chrome/Xvfb）。

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

### 3. 启动 / 停止（识图服务）

```bash
docker compose up --build            # 识别控制台 http://localhost:5173 ，本地后端 :8000
docker compose down
```

> 容器内前端跑的是 `npm run dev:identify`（端口 5173，完整识别控制台）。这与本地 `npm run dev`（图库 7001）刻意分开，互不抢端口。

### 4. 使用

1. 浏览器开 `http://localhost:5173` → 「批量入库」标签。
2. 目录填 `/data/import`（即上面 `IMPORT_DIR` 挂载点）→ 扫描目录。
3. 「开始识别」顺序跑（每张约 30–60s）。
4. 逐条核对表单 → 「提交云端」。提交成功后 Vercel / 本地 `:7001` 图库即可检索到。

### 5. 本地预览线上图库（可选）

想在本机预览「线上图库」的样子（连的是云端数据，不是本地库）：

```bash
cd frontend
npm install        # 首次
npm run dev        # 图库前端 http://localhost:7001
```

- `npm run dev` 用 `--mode gallery` 启动：`VITE_CLOUD_ONLY=true` 只显示图库检索，固定端口 `7001`。
- 它对 `/api`、`/files` 发**同源**请求，由 Vite dev proxy（`frontend/vite.config.ts`）反代到云端后端 `VITE_CLOUD_BACKEND`（默认 `http://123.57.34.90:8000`，在 `frontend/.env.gallery` 配置）。做法与 Vercel 选项 A 完全一致，因此**无需云端配 CORS**。
- 换云端服务器时只改 `frontend/.env.gallery` 里的 `VITE_CLOUD_BACKEND` 一处。
- 端口为什么是 7001：macOS 的「隔空播放接收器（AirPlay Receiver）」默认占用 `7000`。要改回 7000，先在「系统设置 → 通用 → 隔空投送与接力」关闭隔空播放接收器，再把 `frontend/package.json` 里 `dev` 脚本的 `--port 7001` 改成 `7000`。

---

## 端口与连接速查

| 环节 | 地址 | 连哪个后端 | 说明 |
| --- | --- | --- | --- |
| 云端后端 | `http://<公网IP>:8000` | 自身 | 安全组+防火墙放行 8000 |
| 健康检查 | `GET /api/health` | — | 返回 ok |
| 云端入库 | `POST /api/ingest/artifacts` | — | Bearer `INGEST_TOKEN` |
| Vercel 图库 | `https://<app>.vercel.app` | 云端 | 选项 A 反代 / 选项 B 直连 |
| 本地图库预览 | `http://localhost:7001` | **云端** | `npm run dev`，Vite proxy 反代云端 |
| 本地识别控制台 | `http://localhost:5173` | **本地** | `docker compose up`（识别 + 批量入库） |
| 本地后端 | `http://localhost:8000` | 自身 | 识图后端，并向云端推送入库 |

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
