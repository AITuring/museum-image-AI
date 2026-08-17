# 部署指南（DEPLOY）

三处运行环境，各司其职：

| 位置 | 跑什么 | 用什么 |
| --- | --- | --- |
| **阿里云服务器** | Postgres + 后端（cloud 角色，OSS 入库 / 检索 API） | Docker `docker-compose.cloud.yml` |
| **Vercel** | 线上图库前端（连云端后端，纯静态） | Vercel 项目，Root = `frontend` |
| **本地机器 · Docker** | 识图服务（识别控制台 + 本地后端 + 本地库），通义网页桥 + Chrome | Docker `docker-compose.yml` |
| **本地机器 · npm** | 线上图库前端的本地预览（连**云端**后端） | `cd frontend && npm run dev` |

> 关键原则：**「识图」永远连本地后端，「图库」永远连云端后端**。 
>
> - Docker（识图控制台 `:5173` + 本地后端 `:8000`）只负责识别和入库到云端，互不掺和图库。
> - 图库（Vercel 线上、本地 `npm run dev` 的 `:7001`）都只读云端后端，且都用「同源 + 服务端反代」的方式连接（Vercel 用 `vercel.json` rewrites，本地用 Vite dev proxy），所以**不需要给云端配 CORS**。

### 修改与发布防护（必须保留）

运行地址不是普通文案，必须按契约修改：

- `CLOUD_API_BASE_URL` 是本地入库后端地址，必须指向云端 `:8000`，不能指向仅用于预览的 `image.aituring.xyz`。
- `frontend/.env.gallery`、`frontend/vite.config.ts` 和 `frontend/vercel.json` 必须保持同一个云端后端地址。
- `image.aituring.xyz` 只承载前端页面；`/api`、`/files` 由 Vercel 服务端转发到云端后端。
- 高德 SDK 是浏览器直连依赖；代理规则应将 `*.amap.com`、`*.autonavi.com` 和云端 IP 设为直连，不要通过改入库地址来解决网络问题。

每次修改上述配置，先运行：

```bash
python3 scripts/check_runtime_contracts.py
```

GitHub Actions 的 `Verify Runtime Contracts` 会在 PR 和 `main` 推送时再次检查，并构建前端；`Deploy Cloud Backend` 在构建镜像前也会执行契约检查。仓库设置还应启用分支保护：禁止直接推送 `main`，要求 PR 通过 `Verify Runtime Contracts / verify`，生产环境保留 reviewer 审批。

数据流：本地扫描目录 → 通义识别 → 人工核对 → 带 `INGEST_TOKEN` 提交到云端 `/api/ingest/artifacts` → 云端图片入 OSS、元数据入库 → Vercel / 本地 `:7001` 图库检索云端。

---

## 一、阿里云服务器（后端 + 数据库 + GitHub Actions 自动部署）

当前线上后端采用：

- GitHub Actions 构建后端镜像
- GHCR（GitHub Container Registry）保存镜像
- 阿里云服务器只执行 `docker compose pull` + `docker compose up -d`
- GitHub Deployments / Job Summary 展示每次部署与回滚

你在 GitHub 网页里主要看 3 个地方：

- `Actions`：查看构建、部署、重部署、回滚日志
- `Environments -> production`：查看生产环境部署记录
- `Actions run summary`：查看本次部署的 commit、镜像 tag、环境、线上地址、回滚入口

### 1. 服务器初始化（一次性）

国内阿里云服务器安装 Docker，用阿里云 apt 源最稳：

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg git

sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://mirrors.aliyun.com/docker-ce/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://mirrors.aliyun.com/docker-ce/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker

docker --version
docker compose version
git --version
```

创建部署目录：

```bash
sudo mkdir -p /opt/museum-image
sudo chown -R "$USER":"$USER" /opt/museum-image
```

开放端口：

- 阿里云安全组放行 TCP `8000`
- 服务器若启用 UFW：`sudo ufw allow 8000/tcp`

### 2. 服务器准备仓库与 `.env`

服务器仍然需要保留一份仓库副本，用来同步：

- `docker-compose.cloud.yml`
- `scripts/deploy_cloud.sh`
- `scripts/rollback_cloud.sh`

首次拉仓库：

```bash
cd /opt
git clone git@github.com:<你的组织或用户名>/<你的仓库名>.git museum-image
cd /opt/museum-image
```

创建云端 `.env`：

```bash
cp .env.example .env
openssl rand -hex 32
vi .env
```

云端最少需要：

```bash
APP_ROLE=cloud
APP_ENV=production
# 发布脚本会在启动容器时覆盖为本次 Git 提交号
APP_REVISION=development

POSTGRES_DB=museum_image_db
POSTGRES_USER=museum
POSTGRES_PASSWORD=改成强密码
DATABASE_URL=postgresql+psycopg://museum:改成强密码@postgres:5432/museum_image_db

BACKEND_PORT=8000
INGEST_TOKEN=与本地完全一致
CLOUD_INGEST_CONCURRENCY=1  # 小规格主机建议保持 1，超出的提交会返回可重试的 429

OSS_ACCESS_KEY_ID=你的AK
OSS_ACCESS_KEY_SECRET=你的SK
OSS_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com
OSS_BUCKET=你的bucket名
OSS_KEY_PREFIX=artifacts/

# 仅当前端直连后端时需要：
# CORS_ORIGINS=https://your-app.vercel.app
```

注意：

- `DATABASE_URL` 的密码必须与 `POSTGRES_PASSWORD` 一致
- `DATABASE_URL` 的主机固定写 `postgres`
- `.env` 只放在服务器，不要提交到 Git

### 3. GitHub Secrets 与权限

仓库需要配置以下 Secrets：

| Secret | 用途 | 示例 |
| --- | --- | --- |
| `SERVER_HOST` | 服务器公网 IP 或域名 | `1.2.3.4` |
| `SERVER_PORT` | SSH 端口 | `22` |
| `SERVER_USER` | 部署用户 | `root` / `ubuntu` |
| `SERVER_SSH_KEY` | Actions 登录服务器的私钥 | 多行 OpenSSH 私钥 |
| `SERVER_APP_PATH` | 服务器仓库目录 | `/opt/museum-image` |
| `BACKEND_HEALTHCHECK_URL` | 健康检查地址 | `http://127.0.0.1:8000/api/health` |
| `REPO_SSH_PRIVATE_KEY` | 服务器拉 GitHub 仓库用私钥 | 多行 OpenSSH 私钥 |
| `GHCR_USERNAME` | 服务器登录 GHCR 的用户名 | GitHub 用户名 |
| `GHCR_TOKEN` | 服务器拉 GHCR 镜像的 token | PAT |
| `PRODUCTION_APP_URL` | 线上后端地址 | `https://api.example.com` |

`GHCR_TOKEN` 建议使用 GitHub Personal Access Token，至少包含：

- `read:packages`
- 私有仓库场景建议再加 `repo`

如果你的 GHCR 包是私有的，服务器端必须能用这个 token 成功执行：

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USERNAME" --password-stdin
```

另外，仓库建议启用：

- `Settings -> Environments -> production`
- 可选：给 `production` 加 reviewer 或分支限制

### 4. GitHub Actions 流程

当前有两个工作流：

- [deploy-cloud.yml](file:///Users/dp/Desktop/my-museun-image/.github/workflows/deploy-cloud.yml)
- [rollback-cloud.yml](file:///Users/dp/Desktop/my-museun-image/.github/workflows/rollback-cloud.yml)

#### 自动部署

当 `main` 分支发生这些文件变更时，会自动触发部署：

- `backend/**`
- `docker-compose.cloud.yml`
- `.github/workflows/deploy-cloud.yml`
- `scripts/deploy_cloud.sh`
- `scripts/rollback_cloud.sh`
- `.env.example`

自动部署会做：

1. 构建后端镜像
2. 推送到 GHCR：
   - `ghcr.io/<owner>/museum-image-backend:sha-<commit_sha>`
   - `ghcr.io/<owner>/museum-image-backend:main`
3. SSH 登录服务器
4. 拉取对应镜像并执行 `docker compose up -d`
5. 调用健康检查：实际执行数据库探测、校验云端入库配置，并确认返回的是本次 Git 提交号
6. 校验 `/api/ingest/artifacts` 与幂等恢复所需路由都已出现在 OpenAPI 中
7. 失败时自动回滚到上一版成功镜像
8. 把 deployment 状态写进 GitHub
9. 在本次 Actions 页面写入 Job Summary

#### 手动重部署

在 GitHub `Actions -> Deploy Cloud Backend -> Run workflow`：

- 不填参数：按当前 commit 重新构建并部署
- 填 `image_tag`：直接重部署已存在镜像
- 可选填 `deploy_ref`：把部署记录绑定到指定 commit / ref

#### 手动回滚

在 GitHub `Actions -> Rollback Cloud Backend -> Run workflow`：

- `previous-successful`
  - 回滚到上一个成功版本
- `last-successful`
  - 重新部署当前记录的最后成功版本
- `custom`
  - 自己填写：
    - `rollback_ref`
    - `image_tag`

服务器上的发布记录保存在：

- `.deploy/current_release.env`
- `.deploy/release_history.tsv`

### 5. 首次上线建议顺序

1. 在本地确认代码已提交并 push
2. 在 GitHub 配好所有 Secrets
3. 在 GitHub 创建 `production` Environment
4. 在服务器放好 `.env`
5. 在服务器验证可以拉仓库
6. 在服务器验证可以登录 GHCR
7. 手动运行一次 `Deploy Cloud Backend`
8. 成功后再手动运行一次 `Rollback Cloud Backend` 做演练

### 6. 日常操作

查看服务器状态：

```bash
cd /opt/museum-image
docker compose -f docker-compose.cloud.yml ps
docker compose -f docker-compose.cloud.yml logs -f backend
docker compose -f docker-compose.cloud.yml logs -f postgres
```

验证后端：

```bash
curl http://127.0.0.1:8000/api/health
curl http://<公网IP>:8000/api/health
```

查看服务器记录的当前发布版本：

```bash
cd /opt/museum-image
cat .deploy/current_release.env
tail -n 20 .deploy/release_history.tsv
```

停止服务：

```bash
cd /opt/museum-image
docker compose -f docker-compose.cloud.yml down
```

危险操作，删除数据库卷：

```bash
cd /opt/museum-image
docker compose -f docker-compose.cloud.yml down -v
```

### 7. Actions 页面里的发布说明模板

每次部署或回滚结束后，当前 run 的 `Summary` 会自动显示：

- 部署状态
- 环境名
- commit / ref
- 镜像 tag
- 线上地址
- 当前 workflow 链接
- 回滚或重部署入口

这样你不用进日志全文，也能快速知道：

- 这次部署了哪个 commit
- 用了哪个镜像
- 部署到哪里
- 下一步该点哪里去重部署或回滚

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
BACKEND_PLATFORM=linux/amd64        # Apple 芯片本机 Docker 需要强制 amd64，Chrome 才能在容器里安装
IMPORT_DIR=/absolute/path/to/your/images  # 要批量识别的图片目录，会挂到容器 /data/import

CLOUD_API_BASE_URL=http://<公网IP>:8000   # 本地后端直连云端 API；不要填写图库预览域名
INGEST_TOKEN=与云端完全相同的那串
```

### 3. 启动 / 停止（识图服务）

```bash
docker compose up --build            # 识别控制台 http://localhost:5173 ，本地后端 :8000
docker compose down
```
> 如果你是 Apple Silicon / Arm64 机器，必须让后端容器以 `linux/amd64` 运行，否则 `playwright install chrome` 会在镜像构建时失败。
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
