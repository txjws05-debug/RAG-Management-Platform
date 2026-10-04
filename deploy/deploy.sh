#!/usr/bin/env bash
# ============================================================
# 服务器端：拉取 GHCR 镜像并（重）启动知识库管理平台
#
# 由 GitHub Actions 通过 SSH 调用：IMAGE_TAG=<commit-sha> bash deploy/deploy.sh
# 也可以手动执行：            bash deploy/deploy.sh
#
# 前置条件（只需做一次，见 deploy/README.md）：
#   1. 客服项目（customer_service）已在同一台机器上运行 —— 本平台复用它的 Postgres
#   2. 已创建 .env.prod（可从 .env.prod.example 复制）
#   3. 已放行 HTTP_PORT（默认 8080）
# ============================================================
set -euo pipefail

cd "$(dirname "$0")/.."

TAG="${IMAGE_TAG:-latest}"
ENV_FILE=".env.prod"
COMPOSE_FILE="docker-compose.prod.yml"

log()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31mxx\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- 0. 前置检查 ----------
[[ -f "$ENV_FILE" ]] || die "缺少 $ENV_FILE，请先： cp .env.prod.example $ENV_FILE 并填写数据库密码与 LLM Key"
[[ -f "$COMPOSE_FILE" ]] || die "缺少 $COMPOSE_FILE"

# 读取 .env.prod 里的键（不 source，避免把带空格的值当命令执行）
env_get() { sed -n "s/^$1=//p" "$ENV_FILE" | head -1; }

PG_USER="$(env_get POSTGRES_USER)"; PG_USER="${PG_USER:-kb}"
PG_DB="$(env_get POSTGRES_DB)";     PG_DB="${PG_DB:-kb}"
HTTP_PORT="$(env_get HTTP_PORT)";   HTTP_PORT="${HTTP_PORT:-8080}"
PG_PASSWORD="$(env_get POSTGRES_PASSWORD)"
# 建角色/建库/建扩展需要超级用户，用客服项目实例的超级用户账号
CS_SUPERUSER="$(env_get CS_SUPERUSER)"; CS_SUPERUSER="${CS_SUPERUSER:-cs}"

[[ -n "$PG_PASSWORD" ]] || die "在 $ENV_FILE 中找不到 POSTGRES_PASSWORD"

# 复用的数据库容器名。默认 cs-postgres（客服项目的实例）；
# 可用环境变量覆盖，便于本地演练或在服务器上改名。
CS_PG_CONTAINER="${CS_PG_CONTAINER:-cs-postgres}"

# ---------- 1. 确认复用的数据库容器在运行 ----------
# 本平台不自己起 Postgres，因此必须先确认客服项目的实例已就绪。
if ! docker ps --format '{{.Names}}' | grep -qx "$CS_PG_CONTAINER"; then
  die "未发现运行中的 ${CS_PG_CONTAINER} 容器。本平台复用它的 Postgres，请先启动客服项目（cd <customer_service> && docker compose -f docker-compose.prod.yml up -d）"
fi
log "已发现 ${CS_PG_CONTAINER}"

# ---------- 2. 动态探测数据库容器所在的 Docker 网络 ----------
# 不硬编码网络名：客服项目的 compose 没设 name:，网络名取决于服务器上的目录名，
# 写死会在目录改名后静默失效（表现为 api 连不上库）。
# 用数组传参而不是行内引号 + 管道：Go 模板里的 \n 在双引号内会先被 shell 解释，
# 拆成数组后转义层级清晰，也不会因为续行与管道混用而报语法错误。
# 下面那行的单引号是刻意的：这是 Go 模板，不能让 shell 展开 $k/$v。
# shellcheck disable=SC2016
INSPECT_ARGS=(docker inspect "$CS_PG_CONTAINER" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}')
EXTERNAL_NET="$("${INSPECT_ARGS[@]}" | sed '/^$/d' | head -1)"

[[ -n "$EXTERNAL_NET" ]] || die "无法探测 ${CS_PG_CONTAINER} 的网络，请手动设置 KB_EXTERNAL_NETWORK"
export KB_EXTERNAL_NETWORK="$EXTERNAL_NET"
log "${CS_PG_CONTAINER} 所在网络：${EXTERNAL_NET}"

# 持久化到 .env.network。
# 必要性：compose 的变量插值只读「项目目录 .env」或 --env-file，不读服务里的 env_file，
# 因此如果只在本脚本内 export，用户之后手动执行 docker compose ps 就会直接报
# "required variable KB_EXTERNAL_NETWORK is missing" —— 这条报错完全不像"少了一个环境变量"，
# 第一次遇到很费解。写进文件后配合 ./dc 包装脚本即可无感使用。
NET_FILE=".env.network"
if [[ ! -f "$NET_FILE" ]] || [[ "$(sed -n 's/^KB_EXTERNAL_NETWORK=//p' "$NET_FILE" | head -1)" != "$EXTERNAL_NET" ]]; then
  printf 'KB_EXTERNAL_NETWORK=%s\n' "$EXTERNAL_NET" > "$NET_FILE"
  log "已写入 ${NET_FILE}（供 ./dc 与手动 compose 命令使用）"
else
  log "${NET_FILE} 已是最新"
fi

# ---------- 3. 在既有 Postgres 上准备独立角色、库与扩展（幂等） ----------
# 只在第一次部署时真的做事；后续运行只做快速查询。
# pgvector 扩展必须显式创建：既有实例的初始化脚本只在数据卷首次创建时执行过，
# 不会为后加入的库再跑一遍。
psql_cs() { docker exec -i "$CS_PG_CONTAINER" psql -U "$CS_SUPERUSER" -d "$1" -tAc "$2"; }

# 3.1 独立角色：本平台不共用客服项目的账号，避免一方改密码把另一方弄挂
#     （客服项目的部署脚本会在每次部署时重写 DATABASE_URL，共用账号风险实打实）
if [[ -n "$PG_PASSWORD" ]]; then
  ROLE_EXISTS="$(psql_cs postgres "SELECT 1 FROM pg_roles WHERE rolname='${PG_USER}'")"
  if [[ "$ROLE_EXISTS" != "1" ]]; then
    log "创建数据库角色 ${PG_USER}"
    docker exec -i "$CS_PG_CONTAINER" psql -U "$CS_SUPERUSER" -d postgres \
      -c "CREATE ROLE ${PG_USER} LOGIN PASSWORD '${PG_PASSWORD}'" >/dev/null
  else
    # 每次部署同步密码，保证 .env.prod 是唯一事实来源
    docker exec -i "$CS_PG_CONTAINER" psql -U "$CS_SUPERUSER" -d postgres \
      -c "ALTER ROLE ${PG_USER} WITH LOGIN PASSWORD '${PG_PASSWORD}'" >/dev/null
    log "角色 ${PG_USER} 已存在，密码已同步"
  fi
fi

# 3.2 独立库
EXISTS="$(psql_cs postgres "SELECT 1 FROM pg_database WHERE datname='${PG_DB}'")"
if [[ "$EXISTS" != "1" ]]; then
  log "创建数据库 ${PG_DB}（owner=${PG_USER}）"
  psql_cs postgres "CREATE DATABASE ${PG_DB} OWNER ${PG_USER}" >/dev/null
else
  log "数据库 ${PG_DB} 已存在，跳过创建"
fi

# 3.3 扩展（需要超级用户，因此这里用 CS_SUPERUSER 而不是业务角色）
VEC="$(psql_cs "$PG_DB" "SELECT 1 FROM pg_extension WHERE extname='vector'")"
if [[ "$VEC" != "1" ]]; then
  log "在 ${PG_DB} 中创建 vector / pg_trgm 扩展"
  docker exec -i "$CS_PG_CONTAINER" psql -U "$CS_SUPERUSER" -d "$PG_DB" \
    -c "CREATE EXTENSION IF NOT EXISTS vector" \
    -c "CREATE EXTENSION IF NOT EXISTS pg_trgm" >/dev/null
else
  log "扩展已就绪"
fi

# 3.4 把库内 schema 的权限交给业务角色（库是它 owner 时通常已够，这里兜住重建过的库）
docker exec -i "$CS_PG_CONTAINER" psql -U "$CS_SUPERUSER" -d "$PG_DB" \
  -c "GRANT ALL ON SCHEMA public TO ${PG_USER}" >/dev/null 2>&1 || true

# ---------- 4. 写入镜像 tag ----------
if grep -q '^IMAGE_TAG=' "$ENV_FILE"; then
  sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=${TAG}|" "$ENV_FILE"
else
  printf '\nIMAGE_TAG=%s\n' "$TAG" >> "$ENV_FILE"
fi
log "部署镜像 tag：${TAG}"

# ---------- 5. 拉取并启动 ----------
# 两个 --env-file：配置来自 .env.prod，外部网络名来自上一步写入的 .env.network。
dc() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" --env-file "$NET_FILE" "$@"; }

log "拉取镜像…"
if ! dc pull --quiet 2>/dev/null && ! dc pull; then
  warn "拉取失败。常见原因："
  warn "  1) GHCR 上的包是私有的 —— 在 GitHub Packages 页面把两个包设为 public，"
  warn "     或执行 docker login ghcr.io -u <用户名> -p <只含 read:packages 的 PAT>"
  warn "  2) CI 尚未成功构建过镜像 —— 检查 Actions 里 build 的状态"
  exit 1
fi

log "启动服务…"
dc up -d --remove-orphans

# ---------- 6. 等待健康并验证 ----------
# 最多等 150 秒（30 轮 × 5 秒）。计数变量用 `_` 而不是具名变量：
# 它不参与任何逻辑，具名会被静态检查报"变量未使用"。
log "等待 api 健康检查通过（最多 150 秒）…"
for _ in $(seq 1 30); do
  STATUS="$(docker inspect kb-api --format '{{.State.Health.Status}}' 2>/dev/null || echo unknown)"
  if [[ "$STATUS" == "healthy" ]]; then break; fi
  if [[ "$STATUS" == "unhealthy" ]]; then
    warn "kb-api 不健康，日志末尾："
    docker logs --tail 40 kb-api >&2 || true
    exit 1
  fi
  sleep 5
done

if [[ "$(docker inspect kb-api --format '{{.State.Health.Status}}' 2>/dev/null || echo unknown)" != "healthy" ]]; then
  warn "kb-api 在超时内未变为 healthy，日志末尾："
  docker logs --tail 40 kb-api >&2 || true
  exit 1
fi
log "kb-api 健康"

# ---------- 7. 可选：接入客服项目已有的 Caddy，走域名 + 自动 HTTPS ----------
# 只在 .env.prod 设了 RAG_DOMAIN 时启用。设了就必须成功，否则静默半配置状态
# （容器都起来了但域名访问不了）比直接失败更难排查，所以失败即退出。
CADDY_CONTAINER="${CADDY_CONTAINER:-cs-caddy}"
CADDYFILE=""
for candidate in \
  /opt/customer_service/deploy/Caddyfile \
  /root/customer_service/deploy/Caddyfile \
  "$(docker inspect "$CADDY_CONTAINER" \
      --format '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}' 2>/dev/null)"
do
  if [[ -n "$candidate" && -f "$candidate" ]]; then CADDYFILE="$candidate"; break; fi
done

if [[ -n "${RAG_DOMAIN:-}" ]]; then
  log "接入 Caddy：${RAG_DOMAIN} → kb-nginx:80"

  if [[ -z "$CADDYFILE" ]]; then
    # 不自动修改未知路径的文件：先让人确认，而不是猜一个可能错的
    warn "设置了 RAG_DOMAIN，但找不到 Caddyfile。请手动在 Caddyfile 中加入："
    warn "    ${RAG_DOMAIN} {"
    warn "        encode zstd gzip"
    warn "        reverse_proxy kb-nginx:80"
    warn "    }"
    warn "然后： docker exec ${CADDY_CONTAINER} caddy reload --config /etc/caddy/Caddyfile"
    exit 1
  fi
  log "Caddyfile：${CADDYFILE}"

  if grep -qF "$RAG_DOMAIN" "$CADDYFILE" 2>/dev/null; then
    log "Caddyfile 中已存在 ${RAG_DOMAIN}，跳过写入"
  else
    cp "$CADDYFILE" "${CADDYFILE}.bak.$(date +%Y%m%d%H%M%S)"
    {
      printf '\n# 知识库管理平台（由 RAG 的 deploy/deploy.sh 自动追加）\n'
      printf '%s {\n' "$RAG_DOMAIN"
      printf '        encode zstd gzip\n'
      printf '        reverse_proxy kb-nginx:80\n'
      printf '}\n'
    } >> "$CADDYFILE"
    log "已追加站点块（原文件已备份为 ${CADDYFILE}.bak.*）"
  fi

  if docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile 2>&1; then
    log "Caddy 配置已重载"
  else
    warn "Caddy 重载失败，日志末尾："
    docker logs --tail 30 "$CADDY_CONTAINER" >&2 || true
    exit 1
  fi

  # 首次签发证书需要几秒；这里只做提示，未通过不判失败 ——
  # 证书签发依赖 DNS 已生效 + 80/443 对公网放行，属外部条件，脚本无法自证。
  log "等待证书签发（首次通常 5～20 秒）…"
  sleep 8
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS --max-time 20 "https://${RAG_DOMAIN}/api/health" >/dev/null 2>&1; then
      log "HTTPS 链路验证通过：https://${RAG_DOMAIN}"
    else
      warn "https://${RAG_DOMAIN} 暂时访问不通。逐项检查："
      warn "  1) DNS：${RAG_DOMAIN} 是否已解析到本机公网 IP（dig +short ${RAG_DOMAIN}）"
      warn "  2) 云防火墙/安全组是否放行 80 与 443（Let's Encrypt 要从公网回连做验证）"
      warn "  3) 证书签发日志： docker logs --tail 50 ${CADDY_CONTAINER}"
      warn "端口 ${HTTP_PORT} 的直连方式仍然可用，域名稍后会自动恢复。"
    fi
  fi
fi

# 真正打一次接口：健康检查只证明进程活着，这里证明整条链路（nginx → api → 库）可用
if command -v curl >/dev/null 2>&1; then
  if curl -fsS "http://127.0.0.1:${HTTP_PORT}/api/health" >/dev/null; then
    log "nginx → api 链路验证通过（http://127.0.0.1:${HTTP_PORT}/api/health）"
  else
    warn "后端健康但经 nginx 访问失败，请检查 kb-nginx 与端口 $HTTP_PORT"
    docker logs --tail 20 kb-nginx >&2 || true
    exit 1
  fi
fi

echo ""
echo "========================================="
echo " 部署完成"
echo "   镜像 tag : ${TAG}"
if [[ -n "${RAG_DOMAIN:-}" ]]; then
  echo "   访问地址 : https://${RAG_DOMAIN}   （备用：http://<服务器IP>:${HTTP_PORT}）"
else
  echo "   访问地址 : http://<服务器IP>:${HTTP_PORT}"
  echo "   想走域名 + HTTPS：在 .env.prod 里设 RAG_DOMAIN=<子域名> 后重跑本脚本"
fi
echo "   数据库   : cs-postgres / ${PG_DB}（复用客服项目的实例）"
echo "   网络     : ${EXTERNAL_NET}"
echo "========================================="
