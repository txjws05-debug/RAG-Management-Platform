#!/usr/bin/env bash
# 本地端到端演练：用真实 Docker 复现服务器上的部署链路。
#
# 为什么需要它：deploy.sh 的关键假设（能探测到外部 Postgres 的网络、能在既有实例上
# 建库建扩展、能只拉镜像就起服务）只有在真实 Docker 上跑过才算验证。
# 本脚本复用 deploy.sh 的同一套逻辑，但用本地已有的镜像替代 GHCR（CI 还没推送过）。
#
# 用法（在装了 docker 的环境里，repo 根目录）：
#   bash scripts/deploy-dry-run.sh
set -euo pipefail

# REPO_ROOT 可用环境变量覆盖。
# 需要它的原因：容器里跑演练时，compose 的 bind mount（如 ./infra/nginx/nginx.conf）
# 是由**宿主** docker 解析的，因此脚本里的相对路径必须对应宿主上的真实路径。
# 覆盖成宿主同路径即可让两者一致。
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$REPO_ROOT"

TEST_PG="cs-postgres-test"
TEST_NET="rag-deploy-test"
ENV_FILE=".env.prod"
COMPOSE_FILE="docker-compose.prod.yml"
CS_PG_CONTAINER="$TEST_PG"

log()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m  ✓\033[0m %s\n' "$*"; }
die()  { printf '\033[31mxx\033[0m %s\n' "$*" >&2; exit 1; }

cleanup() {
  log "清理演练环境"
  KB_EXTERNAL_NETWORK="$TEST_NET" docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" down -v >/dev/null 2>&1 || true
  docker rm -f "$TEST_PG" >/dev/null 2>&1 || true
  docker network rm "$TEST_NET" >/dev/null 2>&1 || true
  rm -f "$ENV_FILE"
}
trap cleanup EXIT

# 演练开始前先清一次：container_name 是写死的，上一次中断会留下占名容器
docker rm -f kb-api kb-web kb-nginx >/dev/null 2>&1 || true

# ---------- 0. 准备测试用 env ----------
log "准备 $ENV_FILE（演练用密码）"
sed -e 's|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=dryrun_pw|' \
    -e 's|^SECRET_KEY=.*|SECRET_KEY=dryrun_secret_key_for_local_only|' \
    -e 's|^BOOTSTRAP_ADMIN_PASSWORD=.*|BOOTSTRAP_ADMIN_PASSWORD=dryrun_admin_pw|' \
    -e 's|^LLM_API_KEY=.*|LLM_API_KEY=|' \
    -e 's|^HTTP_PORT=.*|HTTP_PORT=18080|' \
    .env.prod.example > "$ENV_FILE"

env_get() { sed -n "s/^$1=//p" "$ENV_FILE" | head -1; }
PG_USER="$(env_get POSTGRES_USER)"; PG_USER="${PG_USER:-kb}"
PG_DB="$(env_get POSTGRES_DB)";     PG_DB="${PG_DB:-kb}"
PG_PASSWORD="$(env_get POSTGRES_PASSWORD)"
CS_SUPERUSER="$(env_get CS_SUPERUSER)"; CS_SUPERUSER="${CS_SUPERUSER:-cs}"
HTTP_PORT="$(env_get HTTP_PORT)";   HTTP_PORT="${HTTP_PORT:-8080}"

# ---------- 1. 模拟客服项目的 Postgres ----------
log "启动模拟的客服项目数据库（$TEST_PG，网络 $TEST_NET）"
docker rm -f "$TEST_PG" >/dev/null 2>&1 || true
docker network rm "$TEST_NET" >/dev/null 2>&1 || true
docker network create "$TEST_NET" >/dev/null
# --network-alias cs-postgres 是关键：compose 里 DATABASE_URL 写的主机名是 cs-postgres，
# 而演练容器叫 cs-postgres-test，不加别名 api 会 gaierror 连不上库。
docker run -d --name "$TEST_PG" --network "$TEST_NET" \
  --network-alias cs-postgres \
  -e POSTGRES_USER="$CS_SUPERUSER" -e POSTGRES_PASSWORD=cs_super_pw -e POSTGRES_DB=customer_service \
  pgvector/pgvector:pg16 >/dev/null
for _ in $(seq 1 30); do
  docker exec "$TEST_PG" pg_isready -U "$CS_SUPERUSER" >/dev/null 2>&1 && break
  sleep 2
done
docker exec "$TEST_PG" pg_isready -U "$CS_SUPERUSER" >/dev/null || die "测试数据库未就绪"
ok "测试数据库就绪"

# ---------- 2. 网络探测（与 deploy.sh 相同的表达式）----------
# 下面那行的单引号是刻意的：这是 Go 模板，不能让 shell 展开 $k/$v。
# shellcheck disable=SC2016
INSPECT_ARGS=(docker inspect "$CS_PG_CONTAINER" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}')
EXTERNAL_NET="$("${INSPECT_ARGS[@]}" | sed '/^$/d' | head -1)"
[[ "$EXTERNAL_NET" == "$TEST_NET" ]] || die "网络探测失败：得到 [$EXTERNAL_NET]，期望 [$TEST_NET]"
ok "网络探测正确：$EXTERNAL_NET"
export KB_EXTERNAL_NETWORK="$EXTERNAL_NET"

# ---------- 3. 建角色 / 库 / 扩展（与 deploy.sh 相同逻辑）----------
psql_cs() { docker exec -i "$CS_PG_CONTAINER" psql -U "$CS_SUPERUSER" -d "$1" -tAc "$2"; }

if [[ "$(psql_cs postgres "SELECT 1 FROM pg_roles WHERE rolname='${PG_USER}'")" != "1" ]]; then
  docker exec -i "$CS_PG_CONTAINER" psql -U "$CS_SUPERUSER" -d postgres \
    -c "CREATE ROLE ${PG_USER} LOGIN PASSWORD '${PG_PASSWORD}'" >/dev/null
fi
ok "角色 ${PG_USER} 就绪"

if [[ "$(psql_cs postgres "SELECT 1 FROM pg_database WHERE datname='${PG_DB}'")" != "1" ]]; then
  psql_cs postgres "CREATE DATABASE ${PG_DB} OWNER ${PG_USER}" >/dev/null
fi
ok "数据库 ${PG_DB} 就绪"

if [[ "$(psql_cs "$PG_DB" "SELECT 1 FROM pg_extension WHERE extname='vector'")" != "1" ]]; then
  docker exec -i "$CS_PG_CONTAINER" psql -U "$CS_SUPERUSER" -d "$PG_DB" \
    -c "CREATE EXTENSION IF NOT EXISTS vector" -c "CREATE EXTENSION IF NOT EXISTS pg_trgm" >/dev/null
fi
ok "扩展 vector / pg_trgm 就绪"

# ---------- 4. 用本地镜像冒充 GHCR 镜像（CI 尚未推送）----------
log "把本地镜像打上 GHCR tag（替代 docker pull）"
docker tag kb-platform-api:latest ghcr.io/txjws05-debug/rag-management-platform-api:latest
docker tag kb-platform-web:latest ghcr.io/txjws05-debug/rag-management-platform-web:latest
ok "镜像就绪"

# ---------- 5. 起服务 ----------
# KB_PULL_POLICY=missing：本地演练用已经 tag 好的镜像，不去访问 GHCR
# （GHCR 上的包默认私有，未登录会返回 denied）。服务器上仍用默认的 always。
log "启动服务（等价于 dc up -d，跳过 pull）"
KB_EXTERNAL_NETWORK="$EXTERNAL_NET" IMAGE_TAG=latest KB_PULL_POLICY=missing \
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --remove-orphans

# ---------- 6. 健康与链路验证 ----------
log "等待 kb-api 健康（最多 150 秒）"
for _ in $(seq 1 30); do
  st="$(docker inspect kb-api --format '{{.State.Health.Status}}' 2>/dev/null || echo unknown)"
  [[ "$st" == "healthy" ]] && break
  [[ "$st" == "unhealthy" ]] && { docker logs --tail 40 kb-api >&2; die "kb-api 不健康"; }
  sleep 5
done
[[ "$(docker inspect kb-api --format '{{.State.Health.Status}}')" == "healthy" ]] || {
  docker logs --tail 40 kb-api >&2; die "kb-api 未在超时内变为 healthy"; }
ok "kb-api 健康"

docker exec kb-api python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health',timeout=5).status==200 else 1)" \
  && ok "api 内部健康检查通过"

if command -v curl >/dev/null 2>&1; then
  curl -fsS "http://127.0.0.1:${HTTP_PORT}/api/health" >/dev/null && ok "nginx → api 链路通过（端口 ${HTTP_PORT}）"
fi

# ---------- 7. 库侧验证 ----------
TABLES="$(psql_cs "$PG_DB" "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
DOCS="$(psql_cs "$PG_DB" "SELECT count(*) FROM knowledge_documents")"
CHUNKS="$(psql_cs "$PG_DB" "SELECT count(*) FROM document_chunks")"
REV="$(psql_cs "$PG_DB" "SELECT version_num FROM alembic_version")"
echo ""
echo "  数据库验证："
echo "    迁移版本   : $REV"
echo "    表数量     : $TABLES"
echo "    示例知识单元: $DOCS"
echo "    切片数量   : $CHUNKS"
[[ "$TABLES" -ge 14 ]] || die "表数量异常（期望 >=14，实际 $TABLES）"
[[ "$DOCS" -ge 5 ]] || die "示例知识单元数量异常（期望 5，实际 $DOCS）"
[[ "$CHUNKS" -ge 5 ]] || die "切片数量异常（期望 >=5，实际 $CHUNKS）"
ok "数据库结构与示例数据正确"

echo ""
echo "========================================="
echo " 本地部署演练全部通过"
echo "========================================="
