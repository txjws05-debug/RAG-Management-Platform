"""知识沉淀与运营管理：FAQ 聚类挖掘、审核发布、缓存、知识缺口闭环。"""
from __future__ import annotations

import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_permission
from app.core.config import settings
from app.core.db import get_db
from app.models import FaqCandidate, FaqEntry, KnowledgeGap
from app.schemas import (
    FaqCandidateRow,
    FaqEntryRow,
    FaqEntryUpdate,
    FaqReviewRequest,
    GapRow,
    GapTaskRequest,
    MiningResult,
    ok,
)
from app.services import faq_cache, mining
from app.services.embeddings import embed_text

logger = logging.getLogger(__name__)

router = APIRouter(tags=["知识沉淀"])

require_faq = require_permission("faq:manage")
require_all = require_permission("faq:manage", "dashboard:view", any_of=True)


# ---------------------------------------------------------------------
# 挖掘
# ---------------------------------------------------------------------
@router.post("/mining/run", response_model=dict)
async def run_mining(
    db: AsyncSession = Depends(get_db),
    _=Depends(require_faq),
    days: int = Query(default=30, ge=1, le=365),
    min_frequency: int | None = Query(default=None, ge=1),
    threshold: float | None = Query(default=None, gt=0, le=1),
):
    """执行一次沉淀挖掘：高频问题聚类 + 知识缺口识别。"""
    faq_result = await mining.mine_faqs(db, days=days, min_frequency=min_frequency, threshold=threshold)
    gap_result = await mining.mine_gaps(db, days=days)
    payload = MiningResult(
        scanned_questions=faq_result["scanned_questions"],
        clusters=faq_result["clusters"],
        new_candidates=faq_result["new_candidates"],
        updated_candidates=faq_result["updated_candidates"],
        new_gaps=gap_result["new_gaps"],
        message=(
            f"{faq_result['message']}；"
            f"另从 {gap_result['scanned_low_confidence']} 条低置信度提问中补充 {gap_result['new_gaps']} 条知识缺口"
        ),
    )
    return ok(payload.model_dump())


# ---------------------------------------------------------------------
# 候选 FAQ
# ---------------------------------------------------------------------
@router.get("/faq/candidates", response_model=dict)
async def list_candidates(
    db: AsyncSession = Depends(get_db),
    _=Depends(require_faq),
    status_filter: str | None = Query(default="pending", alias="status"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
):
    stmt = select(FaqCandidate)
    if status_filter and status_filter != "all":
        stmt = stmt.where(FaqCandidate.status == status_filter)
    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = (
        await db.execute(
            stmt.order_by(FaqCandidate.frequency.desc(), FaqCandidate.id.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
    ).scalars().all()

    doc_ids: set[int] = set()
    for row in rows:
        for doc_id in row.related_document_ids or []:
            doc_ids.add(int(doc_id))
    title_map = await mining.document_title_map(db, list(doc_ids))

    items = [
        FaqCandidateRow(
            id=row.id,
            canonical_question=row.canonical_question,
            sample_questions=list(row.sample_questions or []),
            frequency=row.frequency,
            suggested_answer=row.suggested_answer,
            confidence=row.confidence,
            status=row.status,
            related_documents=[title_map.get(int(i), f"#{i}") for i in (row.related_document_ids or [])],
            created_at=row.created_at.isoformat() if row.created_at else None,
        ).model_dump()
        for row in rows
    ]
    return ok({"items": items, "total": total, "page": page, "page_size": page_size})


@router.delete("/faq/candidates/{candidate_id}", response_model=dict)
async def delete_candidate(
    candidate_id: int, db: AsyncSession = Depends(get_db), _=Depends(require_faq)
):
    """删除候选 FAQ（已发布上线的不受影响，faq_entries.candidate_id 置空）。"""
    candidate = (
        await db.execute(select(FaqCandidate).where(FaqCandidate.id == candidate_id))
    ).scalar_one_or_none()
    if candidate is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="候选 FAQ 不存在")
    await db.delete(candidate)
    await db.flush()
    return ok({"id": candidate_id})


@router.post("/faq/candidates/{candidate_id}/review", response_model=dict)
async def review_candidate(
    candidate_id: int,
    payload: FaqReviewRequest,
    db: AsyncSession = Depends(get_db),
    ctx=Depends(require_faq),
):
    """人工审核：采纳并发布上线（同步写缓存）或驳回。"""
    candidate = (
        await db.execute(select(FaqCandidate).where(FaqCandidate.id == candidate_id))
    ).scalar_one_or_none()
    if candidate is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="候选 FAQ 不存在")

    now = datetime.now(UTC)
    if payload.action == "reject":
        candidate.status = "rejected"
        candidate.reviewed_by = ctx.user_id
        candidate.reviewed_at = now
        await db.flush()
        return ok({"id": candidate.id, "status": "rejected"})

    question = (payload.question or candidate.canonical_question).strip()
    answer = (payload.answer or candidate.suggested_answer or "").strip()
    if not answer:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="请填写标准答案后再发布")

    candidate.status = "approved"
    candidate.reviewed_by = ctx.user_id
    candidate.reviewed_at = now
    candidate.canonical_question = question
    candidate.suggested_answer = answer

    entry = FaqEntry(
        candidate_id=candidate.id,
        question=question,
        answer=answer,
        category=payload.category or "通用",
        enabled=True,
        cache_enabled=True,
        embedding=embed_text(question),
        published_by=ctx.user_id,
        published_at=now,
    )
    db.add(entry)
    await db.flush()

    faq_cache.bump_cache_version()
    await faq_cache.match_faq(db, question)  # 触发重载，确认可命中
    return ok(
        {
            "id": candidate.id,
            "status": "approved",
            "faq_entry_id": entry.id,
            "cache": await faq_cache.cache_stats(db),
        }
    )


# ---------------------------------------------------------------------
# 已发布 FAQ
# ---------------------------------------------------------------------
@router.get("/faq/entries", response_model=dict)
async def list_entries(
    db: AsyncSession = Depends(get_db),
    _=Depends(require_faq),
    keyword: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
):
    stmt = select(FaqEntry)
    if keyword:
        like = f"%{keyword.strip()}%"
        stmt = stmt.where(FaqEntry.question.ilike(like) | FaqEntry.answer.ilike(like))
    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = (
        await db.execute(
            stmt.order_by(FaqEntry.id.desc()).offset((page - 1) * page_size).limit(page_size)
        )
    ).scalars().all()

    items = [
        FaqEntryRow(
            id=r.id,
            question=r.question,
            answer=r.answer,
            category=r.category,
            enabled=r.enabled,
            cache_enabled=r.cache_enabled,
            hit_count=r.hit_count,
            published_at=r.published_at.isoformat() if r.published_at else None,
        ).model_dump()
        for r in rows
    ]
    return ok(
        {
            "items": items,
            "total": total,
            "page": page,
            "page_size": page_size,
            "cache": await faq_cache.cache_stats(db),
        }
    )


@router.put("/faq/entries/{entry_id}", response_model=dict)
async def update_entry(
    entry_id: int,
    payload: FaqEntryUpdate,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_faq),
):
    entry = (await db.execute(select(FaqEntry).where(FaqEntry.id == entry_id))).scalar_one_or_none()
    if entry is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="FAQ 不存在")

    data = payload.model_dump(exclude_unset=True)
    if "question" in data and data["question"]:
        entry.embedding = embed_text(data["question"])
    for key, value in data.items():
        setattr(entry, key, value)
    await db.flush()
    faq_cache.bump_cache_version()
    return ok({"id": entry.id, "cache": await faq_cache.cache_stats(db)})


@router.delete("/faq/entries/{entry_id}", response_model=dict)
async def delete_entry(
    entry_id: int, db: AsyncSession = Depends(get_db), _=Depends(require_faq)
):
    entry = (await db.execute(select(FaqEntry).where(FaqEntry.id == entry_id))).scalar_one_or_none()
    if entry is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="FAQ 不存在")
    await db.delete(entry)
    await db.flush()
    faq_cache.bump_cache_version()
    return ok({"id": entry_id})


@router.post("/faq/cache/refresh", response_model=dict)
async def refresh_cache(db: AsyncSession = Depends(get_db), _=Depends(require_faq)):
    faq_cache.bump_cache_version()
    await faq_cache.match_faq(db, "__warmup__")
    return ok(await faq_cache.cache_stats(db))


# ---------------------------------------------------------------------
# 知识缺口
# ---------------------------------------------------------------------
@router.get("/gaps", response_model=dict)
async def list_gaps(
    db: AsyncSession = Depends(get_db),
    _=Depends(require_all),
    status_filter: str | None = Query(default=None, alias="status"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
):
    from app.models import Department

    stmt = select(KnowledgeGap)
    if status_filter and status_filter != "all":
        stmt = stmt.where(KnowledgeGap.status == status_filter)
    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = (
        await db.execute(
            stmt.order_by(KnowledgeGap.frequency.desc(), KnowledgeGap.last_seen_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
    ).scalars().all()

    dept_ids = {r.department_id for r in rows if r.department_id}
    depts: dict[int, str] = {}
    if dept_ids:
        dept_rows = (
            await db.execute(select(Department.id, Department.name).where(Department.id.in_(dept_ids)))
        ).all()
        depts = {r.id: r.name for r in dept_rows}

    items = [
        GapRow(
            id=r.id,
            question_text=r.question_text,
            department_name=depts.get(r.department_id) if r.department_id else None,
            frequency=r.frequency,
            max_similarity=r.max_similarity,
            suggested_category=r.suggested_category,
            status=r.status,
            last_seen_at=r.last_seen_at.isoformat() if r.last_seen_at else None,
            task_note=r.task_note,
        ).model_dump()
        for r in rows
    ]
    return ok({"items": items, "total": total, "page": page, "page_size": page_size})


@router.post("/gaps/{gap_id}/task", response_model=dict)
async def create_gap_task(
    gap_id: int,
    payload: GapTaskRequest,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_faq),
):
    """一键转建知识补充任务。"""
    gap = (
        await db.execute(select(KnowledgeGap).where(KnowledgeGap.id == gap_id))
    ).scalar_one_or_none()
    if gap is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="知识缺口不存在")

    gap.status = "task_created"
    if payload.category:
        gap.suggested_category = payload.category
    gap.task_note = payload.note or (
        f"知识补充任务：请针对「{gap.question_text}」补充对应文档"
        f"（近期出现 {gap.frequency} 次，最高相似度 {gap.max_similarity:.2f}）"
    )
    await db.flush()
    return ok({"id": gap.id, "status": gap.status, "task_note": gap.task_note})


@router.post("/gaps/{gap_id}/resolve", response_model=dict)
async def resolve_gap(
    gap_id: int, db: AsyncSession = Depends(get_db), _=Depends(require_faq)
):
    gap = (
        await db.execute(select(KnowledgeGap).where(KnowledgeGap.id == gap_id))
    ).scalar_one_or_none()
    if gap is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="知识缺口不存在")
    gap.status = "resolved"
    await db.flush()
    return ok({"id": gap.id, "status": gap.status})


@router.get("/mining/config", response_model=dict)
async def mining_config(_=Depends(require_faq)):
    return ok(
        {
            "cluster_similarity": settings.effective_cluster_similarity,
            "min_frequency": settings.FAQ_MIN_FREQUENCY,
            "cache_enabled": settings.FAQ_CACHE_ENABLED,
            "cache_ttl_seconds": settings.FAQ_CACHE_TTL_SECONDS,
            "confidence_threshold": settings.effective_confidence_threshold,
            "cache_match_threshold": settings.effective_cache_threshold,
        }
    )
