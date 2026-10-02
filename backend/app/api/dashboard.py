"""运营监控与数据看板：PV/UV、知识量、热榜、Token 趋势、延时分布、审计。"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_permission
from app.core.config import settings
from app.core.db import get_db
from app.models import (
    ChatMessage,
    Conversation,
    Department,
    DocumentChunk,
    FaqEntry,
    KnowledgeDocument,
    KnowledgeGap,
    User,
)
from app.schemas import (
    DashboardOverview,
    DashboardPayload,
    NamedCount,
    TrendPoint,
    ok,
)
from app.services.mining import coverage_ratio

router = APIRouter(tags=["运营看板"])

require_dashboard = require_permission("dashboard:view")

LATENCY_BUCKETS = [
    (0, 500, "<0.5s"),
    (500, 1000, "0.5-1s"),
    (1000, 2000, "1-2s"),
    (2000, 3000, "2-3s"),
    (3000, 5000, "3-5s"),
    (5000, 10**9, ">5s"),
]


def _day_labels(days: int) -> list[str]:
    today = datetime.now(UTC).date()
    return [(today - timedelta(days=days - 1 - i)).isoformat() for i in range(days)]


@router.get("/dashboard/overview", response_model=dict)
async def overview(
    db: AsyncSession = Depends(get_db),
    _=Depends(require_dashboard),
    days: int = Query(default=7, ge=1, le=90),
):
    return ok(await _overview(db, days))


async def _overview(db: AsyncSession, days: int) -> dict:
    since = datetime.now(UTC) - timedelta(days=days)

    pv = (
        await db.execute(
            select(func.count(ChatMessage.id)).where(
                ChatMessage.role == "user", ChatMessage.created_at >= since
            )
        )
    ).scalar_one()
    uv = (
        await db.execute(
            select(func.count(func.distinct(ChatMessage.user_id))).where(
                ChatMessage.role == "user", ChatMessage.created_at >= since
            )
        )
    ).scalar_one()

    document_count = (
        await db.execute(select(func.count(KnowledgeDocument.id)))
    ).scalar_one()
    ready_count = (
        await db.execute(
            select(func.count(KnowledgeDocument.id)).where(KnowledgeDocument.status == "ready")
        )
    ).scalar_one()
    chunk_count = (await db.execute(select(func.count(DocumentChunk.id)))).scalar_one()
    faq_count = (
        await db.execute(select(func.count(FaqEntry.id)).where(FaqEntry.enabled.is_(True)))
    ).scalar_one()
    gap_count = (
        await db.execute(
            select(func.count(KnowledgeGap.id)).where(KnowledgeGap.status != "resolved")
        )
    ).scalar_one()

    latency_rows = (
        await db.execute(
            select(ChatMessage.latency_ms)
            .where(ChatMessage.role == "assistant", ChatMessage.created_at >= since)
            .order_by(ChatMessage.latency_ms)
        )
    ).scalars().all()
    avg_latency = round(sum(latency_rows) / len(latency_rows), 1) if latency_rows else 0.0
    if latency_rows:
        p95_index = min(len(latency_rows) - 1, int(len(latency_rows) * 0.95))
        p95_latency = float(latency_rows[p95_index])
    else:
        p95_latency = 0.0

    total_tokens = (
        await db.execute(
            select(func.coalesce(func.sum(ChatMessage.total_tokens), 0)).where(
                ChatMessage.role == "assistant", ChatMessage.created_at >= since
            )
        )
    ).scalar_one()

    assistant_total = (
        await db.execute(
            select(func.count(ChatMessage.id)).where(
                ChatMessage.role == "assistant", ChatMessage.created_at >= since
            )
        )
    ).scalar_one()
    cache_hit = (
        await db.execute(
            select(func.count(ChatMessage.id)).where(
                ChatMessage.role == "assistant",
                ChatMessage.created_at >= since,
                ChatMessage.answer_source == "faq_cache",
            )
        )
    ).scalar_one()
    # 检索置信度均值：top_score 存的是归一化融合分，需与置信度门槛设置区分开
    avg_top_score = (
        await db.execute(
            select(func.coalesce(func.avg(ChatMessage.top_score), 0)).where(
                ChatMessage.role == "assistant", ChatMessage.created_at >= since
            )
        )
    ).scalar_one()

    payload = DashboardOverview(
        pv=int(pv),
        uv=int(uv),
        question_count=int(pv),
        document_count=int(document_count),
        chunk_count=int(chunk_count),
        ready_document_count=int(ready_count),
        faq_count=int(faq_count),
        faq_cache_hit_rate=round(cache_hit / assistant_total, 4) if assistant_total else 0.0,
        gap_count=int(gap_count),
        avg_latency_ms=avg_latency,
        p95_latency_ms=p95_latency,
        total_tokens=int(total_tokens),
        knowledge_coverage=await coverage_ratio(db, days),
        avg_retrieval_score=round(float(avg_top_score or 0.0), 4),
        confidence_threshold=settings.effective_confidence_threshold,
    )
    return payload.model_dump()


@router.get("/dashboard/trends", response_model=dict)
async def trends(
    db: AsyncSession = Depends(get_db),
    _=Depends(require_dashboard),
    days: int = Query(default=7, ge=1, le=90),
):
    return ok(await _trends(db, days))


async def _trends(db: AsyncSession, days: int) -> dict:
    since = datetime.now(UTC) - timedelta(days=days - 1)
    since = since.replace(hour=0, minute=0, second=0, microsecond=0)
    day_expr = func.date_trunc("day", ChatMessage.created_at)

    visit_rows = (
        await db.execute(
            select(
                day_expr.label("day"),
                func.count(ChatMessage.id).label("pv"),
                func.count(func.distinct(ChatMessage.user_id)).label("uv"),
            )
            .where(ChatMessage.role == "user", ChatMessage.created_at >= since)
            .group_by(day_expr)
            .order_by(day_expr)
        )
    ).all()
    visit_map = {r.day.date().isoformat(): (int(r.pv), int(r.uv)) for r in visit_rows}

    token_rows = (
        await db.execute(
            select(
                day_expr.label("day"),
                func.coalesce(func.sum(ChatMessage.total_tokens), 0).label("tokens"),
                func.coalesce(func.avg(ChatMessage.latency_ms), 0).label("avg_latency"),
            )
            .where(ChatMessage.role == "assistant", ChatMessage.created_at >= since)
            .group_by(day_expr)
            .order_by(day_expr)
        )
    ).all()
    token_map = {
        r.day.date().isoformat(): (int(r.tokens), float(r.avg_latency or 0)) for r in token_rows
    }

    labels = _day_labels(days)
    return {
        "visit_trend": [
            TrendPoint(
                label=label,
                value=float(visit_map.get(label, (0, 0))[0]),
            ).model_dump()
            | {"uv": float(visit_map.get(label, (0, 0))[1])}
            for label in labels
        ],
        "token_trend": [
            TrendPoint(label=label, value=float(token_map.get(label, (0, 0))[0])).model_dump()
            for label in labels
        ],
        "latency_trend": [
            TrendPoint(label=label, value=round(token_map.get(label, (0, 0))[1], 1)).model_dump()
            for label in labels
        ],
    }


@router.get("/dashboard/rankings", response_model=dict)
async def rankings(
    db: AsyncSession = Depends(get_db),
    _=Depends(require_dashboard),
    days: int = Query(default=7, ge=1, le=90),
    limit: int = Query(default=10, ge=1, le=50),
):
    return ok(await _rankings(db, days, limit))


async def _rankings(db: AsyncSession, days: int, limit: int) -> dict:
    since = datetime.now(UTC) - timedelta(days=days)

    top_questions = (
        await db.execute(
            select(ChatMessage.question, func.count(ChatMessage.id).label("cnt"))
            .where(
                ChatMessage.role == "user",
                ChatMessage.created_at >= since,
                ChatMessage.question.isnot(None),
            )
            .group_by(ChatMessage.question)
            .order_by(func.count(ChatMessage.id).desc())
            .limit(limit)
        )
    ).all()

    top_docs: list = []

    # 热门知识单元：统计被引用的文档（从 citations JSONB 展开）
    cite_rows = (
        await db.execute(
            select(ChatMessage.citations).where(
                ChatMessage.role == "assistant",
                ChatMessage.created_at >= since,
                ChatMessage.citations.isnot(None),
            )
        )
    ).scalars().all()
    doc_counter: dict[int, int] = {}
    for citations in cite_rows:
        for cite in citations or []:
            doc_id = cite.get("document_id")
            if doc_id:
                doc_counter[int(doc_id)] = doc_counter.get(int(doc_id), 0) + 1

    titles: dict[int, str] = {}
    if doc_counter:
        rows = (
            await db.execute(
                select(KnowledgeDocument.id, KnowledgeDocument.title).where(
                    KnowledgeDocument.id.in_(list(doc_counter))
                )
            )
        ).all()
        titles = {r.id: r.title for r in rows}

    hot_docs = sorted(doc_counter.items(), key=lambda kv: kv[1], reverse=True)[:limit]

    dept_rows = (
        await db.execute(
            select(Department.name, func.count(ChatMessage.id).label("cnt"))
            .join(User, User.department_id == Department.id)
            .join(ChatMessage, ChatMessage.user_id == User.id)
            .where(ChatMessage.role == "user", ChatMessage.created_at >= since)
            .group_by(Department.name)
            .order_by(func.count(ChatMessage.id).desc())
            .limit(limit)
        )
    ).all()

    return {
        "top_questions": [
            NamedCount(name=r.question or "", value=float(r.cnt)).model_dump()
            for r in top_questions
        ],
        "top_documents": [
            NamedCount(name=titles.get(doc_id, f"#{doc_id}"), value=float(cnt)).model_dump()
            for doc_id, cnt in hot_docs
        ],
        "department_question_rank": [
            NamedCount(name=r.name, value=float(r.cnt)).model_dump() for r in dept_rows
        ],
        "unused_documents": [r[0] for r in top_docs],
    }


async def _latency_distribution(db: AsyncSession, days: int) -> dict:
    since = datetime.now(UTC) - timedelta(days=days)
    rows = (
        await db.execute(
            select(ChatMessage.latency_ms).where(
                ChatMessage.role == "assistant", ChatMessage.created_at >= since
            )
        )
    ).scalars().all()

    buckets = []
    for low, high, label in LATENCY_BUCKETS:
        count = sum(1 for v in rows if low <= (v or 0) < high)
        buckets.append(TrendPoint(label=label, value=float(count)).model_dump())
    return {"buckets": buckets, "sample_size": len(rows)}


@router.get("/dashboard/latency-distribution", response_model=dict)
async def latency_distribution(
    db: AsyncSession = Depends(get_db),
    _=Depends(require_dashboard),
    days: int = Query(default=7, ge=1, le=90),
):
    return ok(await _latency_distribution(db, days))


@router.get("/dashboard/all", response_model=dict)
async def dashboard_all(
    db: AsyncSession = Depends(get_db),
    _=Depends(require_dashboard),
    days: int = Query(default=7, ge=1, le=90),
):
    """一次性返回大盘所需全部数据，减少前端请求数。"""
    ov = await _overview(db, days)
    tr = await _trends(db, days)
    rk = await _rankings(db, days, 10)
    ld = await _latency_distribution(db, days)

    payload = DashboardPayload(
        overview=DashboardOverview(**ov),
        token_trend=[TrendPoint(**x) for x in tr["token_trend"]],
        latency_distribution=[TrendPoint(**x) for x in ld["buckets"]],
        top_questions=[NamedCount(**x) for x in rk["top_questions"]],
        top_documents=[NamedCount(**x) for x in rk["top_documents"]],
        visit_trend=[TrendPoint(**x) for x in tr["visit_trend"]],
        department_question_rank=[NamedCount(**x) for x in rk["department_question_rank"]],
    )
    return ok(payload.model_dump())
