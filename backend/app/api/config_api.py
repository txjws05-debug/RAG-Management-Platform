"""底层模型服务参数与系统配置（只读展示 + 运行期可调项）。"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_permission
from app.core.config import settings
from app.core.db import get_db
from app.schemas import ModelConfigView, ok
from app.services.embeddings import embedding_mode

router = APIRouter(tags=["系统配置"])


@router.get("/config/model", response_model=dict)
async def get_model_config(_=Depends(require_permission("system:manage")), db: AsyncSession = Depends(get_db)):
    view = ModelConfigView(
        llm_base_url=settings.LLM_BASE_URL,
        llm_chat_model=settings.LLM_CHAT_MODEL,
        llm_temperature=settings.LLM_TEMPERATURE,
        llm_max_tokens=settings.LLM_MAX_TOKENS,
        llm_key_configured=settings.llm_enabled,
        embedding_base_url=settings.EMBEDDING_BASE_URL,
        embedding_model=settings.EMBEDDING_MODEL,
        embedding_dim=settings.EMBEDDING_DIM,
        embedding_key_configured=settings.remote_embedding_enabled,
        embedding_mode=embedding_mode(),
        retrieve_top_k=settings.RETRIEVE_TOP_K,
        confidence_threshold=settings.effective_confidence_threshold,
        faq_cache_enabled=settings.FAQ_CACHE_ENABLED,
        faq_min_frequency=settings.FAQ_MIN_FREQUENCY,
        faq_cluster_similarity=settings.effective_cluster_similarity,
        faq_cache_match_threshold=settings.effective_cache_threshold,
        chunk_size=settings.CHUNK_SIZE,
        chunk_overlap=settings.CHUNK_OVERLAP,
    )
    return ok(view.model_dump())


@router.get("/config/permissions-catalog", response_model=dict)
async def permissions_catalog(_=Depends(require_permission("system:manage"))):
    """前端按钮级鉴权说明（与后端 require_permission 一一对应）。"""
    return ok(
        {
            "menus": [
                {"code": "menu:dashboard", "name": "运营看板", "permission": "dashboard:view"},
                {"code": "menu:chat", "name": "AI 问答工作台", "permission": "ai:chat"},
                {"code": "menu:knowledge", "name": "知识维护与导入", "permission": "knowledge:view"},
                {"code": "menu:sedimentation", "name": "知识沉淀与运营", "permission": "faq:manage"},
                {"code": "menu:system", "name": "组织与系统配置", "permission": "system:manage"},
            ],
            "operations": [
                {"code": "knowledge:upload", "name": "文档上传/导入"},
                {"code": "knowledge:manage", "name": "知识单元增删改"},
                {"code": "knowledge:grant", "name": "四维数据权限分配"},
                {"code": "faq:manage", "name": "FAQ 审核发布"},
                {"code": "gap:manage", "name": "知识缺口转建任务"},
                {"code": "system:manage", "name": "组织与账号维护"},
                {"code": "ai:chat", "name": "AI 访问"},
                {"code": "dashboard:view", "name": "看板查看"},
            ],
        }
    )
