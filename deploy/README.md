# 部署说明（部署到已有 customer_service 的同一台服务器）

本平台与客服项目（`customer_service`）**共用一台服务器**。下面的方案是照着客服项目**已经跑通的做法**设计的，不是另起一套。

---

## 一、服务器现状（来自 customer_service 的实际配置）

| 项 | 现状 | 对本平台的影响 |
| --- | --- | --- |
| 内存 | 约 1.75～2 GB | **不能在服务器上构建**，Next.js 构建会 OOM |
| 部署方式 | GitHub Actions → 构建镜像 → push GHCR → SSH 拉取重启 | 本平台沿用同一套 |
| 反向代理 | Caddy（`cs-caddy`），占用 **80 / 443** | 本平台不碰这两个端口 |
| 数据库 | Postgres 16 + pgvector（`cs-postgres`） | **复用**，在其上建独立库 `kb` |
| 缓存 | Redis（`cs-redis`） | 本平台不需要 |
| 已有容器 | `cs-postgres` `cs-redis` `cs-ecommerce` `cs-backend` `cs-frontend` `cs-caddy` | 本平台新增 `kb-api` `kb-web` `kb-nginx` |
| 密钥 | GitHub Secrets：`SERVER_HOST` `SERVER_USER` `SERVER_SSH_KEY` `SERVER_PORT` `SERVER_APP_DIR` | 复用同名 Secrets |

**本平台占用的端口只有一个：`8080`（对外）。**

---

## 二、为什么复用数据库而不是自建

服务器只有约 2 GB 内存。再起一个 Postgres 进程（即使限制 `shared_buffers`）也要多吃 100～150 MB，而现有 `cs-postgres` 已经装好 `pgvector`，直接建一个库更划算。

代价与规避：

- **代价**：两个项目共享一个数据库进程。
- **规避**：本平台使用**独立的角色 `kb` 与独立的库 `kb`**，不碰 `cs` 角色也不碰 `customer_service` / `commerce` 库。客服项目的部署脚本每次会改写它自己的 `DATABASE_URL`，独立角色可以确保那种改写不会波及本平台。

---

## 三、部署架构

```
公网 :8080
   └─ kb-nginx（nginx:alpine）
        ├─ /api/*  → kb-api:8000  ──┐
        └─ 其余     → kb-web:3000    │
                                     │  Docker 网络 cs_backend（复用客服项目的网络）
                                     └─→ cs-postgres:5432 / 库 kb
                                                （由客服项目提供）
公网 :80/:443
   └─ cs-caddy（客服项目，不受本平台影响）
```

- `kb-api` 同时接入 `rag_kb`（本项目内部）与 `cs_backend`（外部，用于访问 `cs-postgres`）。
- `kb-nginx` 只绑 `8080`，与 Caddy 的 80/443 互不干扰。

---

## 四、需要你做的事（一次性）

### 1. 放行端口

服务器防火墙 / 云安全组放行 **8080/tcp**。

```bash
# 服务器上，若用 ufw
ufw allow 8080/tcp
```

### 2. 创建项目目录并拉代码

```bash
sudo mkdir -p /opt/rag
sudo chown "$USER":"$USER" /opt/rag
git clone https://github.com/txjws05-debug/RAG-Management-Platform.git /opt/rag
cd /opt/rag
```

> 若服务器无法访问 GitHub，也可以本地 `scp -r` 上传（客服项目的 `setup.sh` 就是这种用法）。

### 3. 创建生产配置

```bash
cd /opt/rag
cp .env.prod.example .env.prod
```

编辑 `.env.prod`，**必须修改**这三项：

| 键 | 说明 |
| --- | --- |
| `POSTGRES_PASSWORD` | 强随机值；部署脚本会据此创建/同步 `kb` 角色密码 |
| `SECRET_KEY` | `python3 -c "import secrets;print(secrets.token_urlsafe(48))"` |
| `BOOTSTRAP_ADMIN_PASSWORD` | 首次启动的管理员密码，登录后请立刻改 |

可选（不填也能跑通，走内置离线模式）：

| 键 | 说明 |
| --- | --- |
| `LLM_API_KEY` | 填了才是真实大模型回答，否则是离线兜底摘要 |
| `LLM_BASE_URL` / `LLM_CHAT_MODEL` | 换供应商只改这两行 |

### 4. 配置 GitHub Secrets

在仓库 `Settings → Secrets and variables → Actions` 里加（与客服项目同名，若已存在则无需重复添加）：

| Secret | 说明 |
| --- | --- |
| `SERVER_HOST` | 服务器 IP 或域名 |
| `SERVER_USER` | SSH 用户名 |
| `SERVER_SSH_KEY` | SSH 私钥全文 |
| `SERVER_PORT` | 可选，默认 22 |
| `SERVER_APP_DIR` | `/opt/rag` |

> 数据库密码、`SECRET_KEY`、LLM Key **不要**放进 CI。它们只存在服务器上的 `.env.prod`，CI 只负责构建镜像。

### 5. 让 GHCR 镜像可拉取

CI 会推送两个包：

```
ghcr.io/txjws05-debug/rag-management-platform-api
ghcr.io/txjws05-debug/rag-management-platform-web
```

两种方式二选一：

- **设为 public**（推荐，客服项目就是这么做的）：GitHub → 个人头像 → Packages → 选中包 → Package settings → Change visibility → Public
- **保持私有**：在服务器执行一次
  ```bash
  docker login ghcr.io -u txjws05-debug -p <只含 read:packages 的 PAT>
  ```

### 6. 首次部署

推送代码到 `main` 即自动触发。也可以手动：

```bash
# GitHub 网页 → Actions → Build and deploy → Run workflow
```

或在服务器手动执行：

```bash
cd /opt/rag
IMAGE_TAG=latest bash deploy/deploy.sh
```

`deploy.sh` 会自动完成：

1. 确认 `cs-postgres` 在运行（不在则报错提示先启动客服项目）
2. **动态探测** `cs-postgres` 所在的 Docker 网络（不硬编码，避免目录改名后失效）
3. 创建角色 `kb`、库 `kb`，启用 `vector` / `pg_trgm` 扩展（全部幂等）
4. 拉取镜像并启动 3 个容器
5. 等 `kb-api` 健康，再经 nginx 打一次 `/api/health` 验证整条链路

---

## 五、部署后验证

```bash
# 容器状态
docker compose -f /opt/rag/docker-compose.prod.yml --env-file /opt/rag/.env.prod ps

# 健康检查（服务器本机）
curl -s http://127.0.0.1:8080/api/health

# 外网访问
# 浏览器打开 http://<服务器IP>:8080
```

期望 `docker ps` 看到：

```
kb-api      Up (healthy)
kb-nginx    Up   0.0.0.0:8080->80/tcp
kb-web      Up
```

数据库侧确认：

```bash
docker exec cs-postgres psql -U cs -d kb -c "\dx"          # 应看到 vector 与 pg_trgm
docker exec cs-postgres psql -U cs -d kb -c "\dt"          # 迁移后应有 10 张表
docker exec cs-postgres psql -U cs -d kb -c "select version_num from alembic_version"
```

---

## 六、回滚

镜像同时打了 `latest` 和 `sha` 两个 tag，因此可以精确回滚到某个 commit：

```bash
cd /opt/rag
IMAGE_TAG=<某个 commit sha> bash deploy/deploy.sh
```

---

## 七、日常运维

```bash
cd /opt/rag

# 日志
docker compose -f docker-compose.prod.yml --env-file .env.prod logs -f kb-api

# 只重启后端（例如改了 .env.prod）
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --force-recreate kb-api

# 停止本平台（不影响客服项目）
docker compose -f docker-compose.prod.yml --env-file .env.prod down

# 注意：不要用 down -v，那会删掉上传文档的数据卷
```

---

## 八、已知限制与风险

1. **8080 是明文 HTTP。** 登录密码与 JWT 在公网以明文传输，存在被截获的风险。当前按「单独开端口」的方案部署；如需 HTTPS，最省事的做法是把 Caddyfile 里加一条反向代理到 `kb-nginx:80`，并给一个子域名（Caddy 会自动签发证书），我可以补这段配置。
2. **两个项目共享数据库进程。** 若客服项目重建 `cs-postgres`（例如换机器或重置数据卷），本平台的 `kb` 库会一起消失。两个库建议分别备份。
3. **内存余量有限。** 本平台 3 个容器（api / web / nginx）日常约 300～450 MB。启动瞬间（Alembic 迁移 + 种子向量化）会更高，若与客服项目同时重建可能吃紧。
4. **首次启动会导入 5 份示例知识文档。** 生产环境若不需要，可清空 `kb` 库后重跑，或后续在界面里删除。
5. **`kb-nginx` 使用官方 `nginx:alpine` + 挂载仓库里的配置**，因此配置更新只需 `git pull` 后重建该容器，不需要额外构建镜像。
