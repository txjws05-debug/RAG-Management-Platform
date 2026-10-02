"""业务 API 路由汇总。"""
from __future__ import annotations

from fastapi import APIRouter

from app.api import admin, auth, chat, config_api, dashboard, faq, knowledge

api_router = APIRouter()
api_router.include_router(auth.router)
api_router.include_router(admin.router)
api_router.include_router(knowledge.router)
api_router.include_router(chat.router)
api_router.include_router(dashboard.router)
api_router.include_router(faq.router)
api_router.include_router(config_api.router)

__all__ = ["api_router"]
