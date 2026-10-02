"""FastAPI 应用入口。"""
from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text as sql_text

from app.api import api_router
from app.api.errors import register_exception_handlers
from app.core.config import settings
from app.core.db import engine
from app.services.embeddings import embedding_mode

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s [%(name)s] %(message)s",
)
logger = logging.getLogger("app")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("启动 %s | 嵌入模式=%s | LLM=%s", settings.APP_NAME, embedding_mode(), settings.LLM_CHAT_MODEL)
    try:
        async with engine.connect() as conn:
            await conn.execute(sql_text("SELECT 1"))
        logger.info("数据库连接正常")
    except Exception as exc:  # noqa: BLE001
        logger.error("数据库连接失败：%s", exc)
    yield
    await engine.dispose()
    logger.info("服务已关闭")


app = FastAPI(
    title=settings.APP_NAME,
    description="知识多源维护 · 四维细粒度权限鉴权 · AI 鉴权检索问答 · 运营看板 · 知识自动沉淀",
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url=None,
    openapi_url="/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"],
)

register_exception_handlers(app)


@app.middleware("http")
async def add_process_time_header(request: Request, call_next):
    started = time.perf_counter()
    response = await call_next(request)
    response.headers["X-Process-Time-Ms"] = f"{(time.perf_counter() - started) * 1000:.1f}"
    return response


@app.get("/api/health", tags=["系统"], summary="健康检查")
async def health():
    db_ok = True
    try:
        async with engine.connect() as conn:
            await conn.execute(sql_text("SELECT 1"))
    except Exception:  # noqa: BLE001
        db_ok = False
    return {
        "code": 0,
        "message": "ok",
        "data": {
            "status": "healthy" if db_ok else "degraded",
            "database": db_ok,
            "app": settings.APP_NAME,
            "embedding_mode": embedding_mode(),
            "llm_key_configured": settings.llm_enabled,
        },
    }


app.include_router(api_router, prefix=settings.API_PREFIX)
