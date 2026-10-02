#!/usr/bin/env bash
set -euo pipefail

echo "[entrypoint] 等待数据库就绪 ..."
python - <<'PY'
import asyncio, os, sys
import asyncpg

url = os.environ["DATABASE_URL"].replace("postgresql+asyncpg://", "postgresql://")

async def wait():
    for i in range(60):
        try:
            conn = await asyncpg.connect(url)
            await conn.close()
            print("[entrypoint] 数据库已就绪")
            return
        except Exception as exc:  # noqa: BLE001
            print(f"[entrypoint] 第 {i+1} 次连接失败: {exc.__class__.__name__}", flush=True)
            await asyncio.sleep(2)
    print("[entrypoint] 数据库连接超时", file=sys.stderr)
    sys.exit(1)

asyncio.run(wait())
PY

echo "[entrypoint] 执行 Alembic 迁移 ..."
alembic upgrade head

echo "[entrypoint] 初始化基础数据（幂等）..."
python -m app.seed

echo "[entrypoint] 启动 API 服务 ..."
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips='*' "$@"
