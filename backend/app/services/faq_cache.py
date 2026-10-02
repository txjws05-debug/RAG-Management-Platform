"""FAQ 快速应答缓存：进程内缓存 + FAQ 表向量匹配。

命中逻辑：问题向量与已发布 FAQ 向量做余弦匹配，超过阈值即毫秒级直出标准答案，
不再调用大模型，从而降低调用开销（对应 2.9.4 FAQ 缓存加速规则）。
"""
from __future__ import annotations

import logging
import time

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models import FaqEntry
from app.services.embeddings import combined_similarity, embed_text

logger = logging.getLogger(__name__)

# 问题相似度阈值：按嵌入模式自动取值（真实语义模型 0.92 / 本地哈希嵌入 0.62）
MATCH_THRESHOLD = settings.effective_cache_threshold

_cache: dict[int, dict] = {}
_cache_loaded_at: float = 0.0
_cache_version: int = 0


def bump_cache_version() -> None:
    """FAQ 发布/修改后调用，触发缓存重载。"""
    global _cache_version
    _cache_version += 1
    _cache.clear()
    logger.info("FAQ 缓存已失效，版本 → %s", _cache_version)


async def _load_cache(db: AsyncSession, force: bool = False) -> dict[int, dict]:
    global _cache_loaded_at
    ttl = settings.FAQ_CACHE_TTL_SECONDS
    fresh = _cache and (time.time() - _cache_loaded_at) < ttl
    if fresh and not force:
        return _cache
    if not settings.FAQ_CACHE_ENABLED:
        return {}

    rows = (
        await db.execute(
            select(FaqEntry).where(FaqEntry.enabled.is_(True), FaqEntry.cache_enabled.is_(True))
        )
    ).scalars().all()

    _cache.clear()
    for entry in rows:
        if entry.embedding is None:
            continue
        _cache[entry.id] = {
            "id": entry.id,
            "question": entry.question,
            "answer": entry.answer,
            "category": entry.category,
            "embedding": list(entry.embedding),
        }
    _cache_loaded_at = time.time()
    logger.info("FAQ 缓存装载 %s 条", len(_cache))
    return _cache


async def match_faq(db: AsyncSession, question: str) -> dict | None:
    """返回命中的 FAQ（含相似度），未命中返回 None。"""
    if not settings.FAQ_CACHE_ENABLED:
        return None
    cache = await _load_cache(db)
    if not cache:
        return None

    query_vec = embed_text(question)
    best: dict | None = None
    best_score = 0.0
    for item in cache.values():
        score = combined_similarity(question, query_vec, item["question"], item["embedding"])
        if score > best_score:
            best_score = score
            best = item

    if best is not None and best_score >= MATCH_THRESHOLD:
        result = dict(best)
        result["similarity"] = best_score
        result.pop("embedding", None)
        return result
    return None


async def cache_stats(db: AsyncSession) -> dict:
    cache = await _load_cache(db)
    return {
        "enabled": settings.FAQ_CACHE_ENABLED,
        "cached_entries": len(cache),
        "loaded_at": _cache_loaded_at,
        "version": _cache_version,
        "match_threshold": MATCH_THRESHOLD,
    }
