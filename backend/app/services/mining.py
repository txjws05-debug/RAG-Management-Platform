"""知识沉淀挖掘：高频提问语义聚类 → 候选 FAQ；未命中提问 → 知识缺口。"""
from __future__ import annotations

import hashlib
import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models import (
    ChatMessage,
    Conversation,
    FaqCandidate,
    KnowledgeDocument,
    KnowledgeGap,
    User,
)
from app.services.embeddings import cosine, embed_text, normalize_question

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------
# 聚类
# ---------------------------------------------------------------------
def cluster_questions(
    items: list[tuple[str, list[float]]], threshold: float
) -> list[list[int]]:
    """贪心增量聚类：返回每个簇的成员下标列表。"""
    clusters: list[dict] = []
    for idx, (_, vec) in enumerate(items):
        best_pos, best_sim = -1, 0.0
        for pos, cluster in enumerate(clusters):
            sim = cosine(vec, cluster["centroid"])
            if sim > best_sim:
                best_sim, best_pos = sim, pos
        if best_pos >= 0 and best_sim >= threshold:
            cluster = clusters[best_pos]
            cluster["members"].append(idx)
            n = len(cluster["members"])
            centroid = cluster["centroid"]
            cluster["centroid"] = [
                (c * (n - 1) + v) / n for c, v in zip(centroid, vec, strict=True)
            ]
            cluster["intra_sim"].append(best_sim)
        else:
            clusters.append({"members": [idx], "centroid": list(vec), "intra_sim": []})
    return [c["members"] for c in clusters]


async def mine_faqs(
    db: AsyncSession,
    days: int = 30,
    min_frequency: int | None = None,
    threshold: float | None = None,
) -> dict:
    """扫描历史提问日志，聚类生成候选 FAQ（幂等：同簇更新而非重复插入）。"""
    min_frequency = min_frequency or settings.FAQ_MIN_FREQUENCY
    threshold = threshold or settings.effective_cluster_similarity
    since = datetime.now(UTC) - timedelta(days=days)

    # 1) 取出提问日志，并带上该问之后的助手回答/引用（用于推荐标准答案）
    rows = (
        await db.execute(
            select(ChatMessage.id, ChatMessage.conversation_id, ChatMessage.question)
            .where(ChatMessage.role == "user", ChatMessage.created_at >= since)
            .where(ChatMessage.question.isnot(None))
            .order_by(ChatMessage.created_at)
        )
    ).all()

    answers: dict[int, dict] = {}
    conv_ids = list({r.conversation_id for r in rows})
    if conv_ids:
        ans_rows = (
            await db.execute(
                select(
                    ChatMessage.conversation_id,
                    ChatMessage.answer,
                    ChatMessage.citations,
                    ChatMessage.answer_source,
                    ChatMessage.id,
                )
                .where(
                    ChatMessage.role == "assistant",
                    ChatMessage.conversation_id.in_(conv_ids),
                    ChatMessage.answer.isnot(None),
                )
                .order_by(ChatMessage.id)
            )
        ).all()
        for r in ans_rows:
            answers.setdefault(r.conversation_id, {})  # 保留最早一条
            if not answers[r.conversation_id]:
                answers[r.conversation_id] = {
                    "answer": r.answer,
                    "citations": r.citations or [],
                    "source": r.answer_source,
                }

    questions: list[tuple[str, list[float], int]] = []
    for r in rows:
        text = (r.question or "").strip()
        if len(text) < 4:
            continue
        questions.append((text, embed_text(text), r.conversation_id))

    if not questions:
        return {
            "scanned_questions": 0,
            "clusters": 0,
            "new_candidates": 0,
            "updated_candidates": 0,
            "new_gaps": 0,
            "message": "所选时间范围内没有可用于挖掘的提问日志",
        }

    members_list = cluster_questions([(q[0], q[1]) for q in questions], threshold)

    new_candidates = 0
    updated_candidates = 0
    for members in members_list:
        frequency = len(members)
        if frequency < min_frequency:
            continue

        texts = [questions[i][0] for i in members]
        # 规范问句：选与其他成员平均相似度最高的一条
        best_text, best_avg = texts[0], -1.0
        for i in members:
            sims = [cosine(questions[i][1], questions[j][1]) for j in members if j != i]
            avg = sum(sims) / len(sims) if sims else 1.0
            if avg > best_avg:
                best_avg, best_text = avg, questions[i][0]

        cluster_key = hashlib.blake2b(
            normalize_question(best_text).encode("utf-8"), digest_size=12
        ).hexdigest()

        samples = sorted(set(texts))[:8]
        # 推荐答案：取簇内某条助手回答；关联知识单元来自引用
        suggested_answer, related_docs = None, set()
        for i in members:
            info = answers.get(questions[i][2])
            if not info:
                continue
            for cite in info.get("citations") or []:
                if cite.get("document_id"):
                    related_docs.add(int(cite["document_id"]))
            if suggested_answer is None and info.get("source") != "offline":
                suggested_answer = info["answer"]

        if suggested_answer is None:
            suggested_answer = (
                f"【待人工补充】针对高频问题「{best_text}」，"
                f"近 {days} 天已被 {frequency} 次提问，但知识库中尚未给出充分答案，建议补充标准答复。"
            )

        confidence = round(min(0.99, best_avg if best_avg > 0 else 0.5), 4)
        centroid = [0.0] * settings.EMBEDDING_DIM
        for i in members:
            vec = questions[i][1]
            centroid = [c + v for c, v in zip(centroid, vec, strict=True)]
        centroid = [c / frequency for c in centroid]

        existing = (
            await db.execute(select(FaqCandidate).where(FaqCandidate.cluster_key == cluster_key))
        ).scalar_one_or_none()

        if existing is None:
            db.add(
                FaqCandidate(
                    cluster_key=cluster_key,
                    canonical_question=best_text,
                    sample_questions=samples,
                    frequency=frequency,
                    suggested_answer=suggested_answer,
                    related_document_ids=sorted(related_docs),
                    confidence=confidence,
                    status="pending",
                    center_embedding=centroid,
                )
            )
            new_candidates += 1
        else:
            existing.frequency = frequency
            existing.sample_questions = samples
            existing.related_document_ids = sorted(related_docs)
            existing.confidence = confidence
            existing.center_embedding = centroid
            if existing.status != "approved":
                existing.suggested_answer = suggested_answer
            updated_candidates += 1

    await db.flush()
    return {
        "scanned_questions": len(questions),
        "clusters": len([m for m in members_list if len(m) >= min_frequency]),
        "new_candidates": new_candidates,
        "updated_candidates": updated_candidates,
        "new_gaps": 0,
        "message": (
            f"扫描 {len(questions)} 条提问，命中 {len([m for m in members_list if len(m) >= min_frequency])} 个高频簇；"
            f"新增候选 FAQ {new_candidates} 条，更新 {updated_candidates} 条"
        ),
    }


async def record_gap(
    db: AsyncSession,
    question: str,
    max_similarity: float,
    department_id: int | None,
    suggested_category: str = "待分类",
) -> None:
    """把未命中/低置信度的提问写入知识缺口池（按归一化问题聚合频次）。"""
    norm = normalize_question(question)[:240]
    if len(norm) < 3:
        return
    now = datetime.now(UTC)
    existing = (
        await db.execute(select(KnowledgeGap).where(KnowledgeGap.question_norm == norm))
    ).scalar_one_or_none()

    if existing is None:
        db.add(
            KnowledgeGap(
                question_norm=norm,
                question_text=question.strip()[:500],
                department_id=department_id,
                frequency=1,
                max_similarity=round(max_similarity, 4),
                suggested_category=suggested_category,
                status="open",
                last_seen_at=now,
            )
        )
    else:
        existing.frequency += 1
        existing.max_similarity = max(existing.max_similarity, round(max_similarity, 4))
        existing.last_seen_at = now
        if existing.status == "resolved":
            existing.status = "open"
    await db.flush()


async def mine_gaps(db: AsyncSession, days: int = 30, min_frequency: int = 1) -> dict:
    """从问答日志中补充识别缺口（针对此前未落库的低置信度提问）。"""
    since = datetime.now(UTC) - timedelta(days=days)
    rows = (
        await db.execute(
            select(
                ChatMessage.question,
                ChatMessage.top_score,
                User.department_id,
            )
            .join(Conversation, Conversation.id == ChatMessage.conversation_id)
            .join(User, User.id == ChatMessage.user_id)
            .where(ChatMessage.role == "user", ChatMessage.created_at >= since)
            .where(ChatMessage.top_score < settings.effective_confidence_threshold)
            .where(ChatMessage.question.isnot(None))
        )
    ).all()

    created = 0
    for r in rows:
        before = (
            await db.execute(
                select(KnowledgeGap.id).where(
                    KnowledgeGap.question_norm == normalize_question(r.question or "")[:240]
                )
            )
        ).scalar_one_or_none()
        await record_gap(db, r.question or "", float(r.top_score or 0.0), r.department_id)
        if before is None:
            created += 1

    await db.flush()
    return {"scanned_low_confidence": len(rows), "new_gaps": created}


async def coverage_ratio(db: AsyncSession, days: int = 7) -> float:
    """知识库覆盖率：有命中（top_score 达标）的提问占比。"""
    since = datetime.now(UTC) - timedelta(days=days)
    total = (
        await db.execute(
            select(func.count(ChatMessage.id)).where(
                ChatMessage.role == "user", ChatMessage.created_at >= since
            )
        )
    ).scalar_one()
    if not total:
        return 0.0
    hit = (
        await db.execute(
            select(func.count(ChatMessage.id))
            .where(ChatMessage.role == "user", ChatMessage.created_at >= since)
            .where(ChatMessage.top_score >= settings.effective_confidence_threshold)
        )
    ).scalar_one()
    return round(hit / total, 4)


async def document_title_map(db: AsyncSession, ids: list[int]) -> dict[int, str]:
    if not ids:
        return {}
    rows = (
        await db.execute(
            select(KnowledgeDocument.id, KnowledgeDocument.title).where(
                KnowledgeDocument.id.in_(ids)
            )
        )
    ).all()
    return {r.id: r.title for r in rows}
