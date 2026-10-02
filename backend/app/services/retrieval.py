"""混合检索：pgvector 向量召回 + PostgreSQL 全文/三元组关键词召回，按权重融合。

精度要点（实测踩过的坑）：
1. 候选池不能无限放大。若把全部文档都召回，鉴权过滤会把「有权/无权」两类都带出来，
   于是连正常的「差旅报销」提问也会弹出「部分资料权限受限」的误报。
2. 关键词侧必须做相关性判定。中文短词（如「一线」「城市」）在 pg_trgm 下会产生
   噪声命中，把无关文档拉进候选集。
3. trigram 阈值不能过低（0.05 会误召回，0.12 才干净）。
因此本模块同时使用「词项命中数相对门槛」与「整句 trigram 门槛」双重过滤。
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from sqlalchemy import case, func, select, text as sql_text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models import DocumentChunk, KnowledgeDocument, KnowledgeGrant
from app.services.embeddings import embed_text, keyword_query_terms
from app.services.permission import UserContext, build_grant_condition

logger = logging.getLogger(__name__)

# 整句 trigram 相似度门槛
TRIGRAM_MIN_SIMILARITY = 0.12
# 关键词召回的相对相关性门槛：命中词项数须达到最佳命中的该比例
KEYWORD_RELEVANCE_RATIO = 0.15
# 独立词项命中数的绝对下限
KEYWORD_MIN_TERM_MATCHES = 2
# 相对相关性截断：融合分低于「最高分 × 该系数」的候选直接丢弃。
# 用相对比例而非绝对阈值，才能在不同嵌入模型（分值尺度差别很大）下都成立。
# 实测：差旅提问最高分 0.650、第二名 0.143（比值 0.22），截断后只剩真正相关的那一篇，
# 从而避免「召回集里混进 1 篇无权文档 → 正常提问也弹出权限受限」的误报。
RELEVANCE_KEEP_RATIO = 0.35
# 绝对相关性下限：原始相似度本身达到该值也算相关，用于保住
# 「高度相关但用户无权访问」的候选，使权限受限提示不会漏报。
# 实测本地哈希嵌入下，正确文档的原始余弦约 0.19~0.24，跑题文档 < 0.05。
ABSOLUTE_RAW_FLOOR_LOCAL = 0.08
ABSOLUTE_RAW_FLOOR_REMOTE = 0.30


@dataclass
class Candidate:
    chunk_id: int
    document_id: int
    document_title: str
    ordinal: int
    content: str
    vector_score: float = 0.0
    keyword_score: float = 0.0
    # 归一化前的原始分（保留，用于绝对相关性判定）
    raw_vector_score: float = 0.0
    raw_keyword_score: float = 0.0
    # 归一化后的融合分，仅用于排序与前端展示「相关度」
    score: float = 0.0
    # 归一化前的最高原始相似度，用于「是否命中」的置信度判定
    raw_score: float = 0.0

    def as_dict(self) -> dict:
        return {
            "chunk_id": self.chunk_id,
            "document_id": self.document_id,
            "document_title": self.document_title,
            "ordinal": self.ordinal,
            "content": self.content,
            "vector_score": round(self.vector_score, 4),
            "keyword_score": round(self.keyword_score, 4),
            "score": round(self.score, 4),
            "raw_score": round(self.raw_score, 4),
        }


def _term_list(question: str) -> list[str]:
    """查询词项：中文 bigram + 英文词，已去重保序，并做 tsquery 转义。"""
    return [
        t.replace("'", "").replace("\\", "")
        for t in keyword_query_terms(question)
        if t.strip()
    ]


def _tsquery_string(question: str) -> str:
    """把问题转成安全 tsquery：词项之间用 | 连接。"""
    terms = _term_list(question)
    if not terms:
        return ""
    return " | ".join(f"'{t}'" for t in terms)


async def vector_search(db: AsyncSession, question: str, limit: int) -> list[Candidate]:
    """向量召回：cosine 距离转成 0~1 相似度。"""
    query_vec = embed_text(question)
    distance = DocumentChunk.embedding.cosine_distance(query_vec).label("distance")
    stmt = (
        select(
            DocumentChunk.id,
            DocumentChunk.document_id,
            DocumentChunk.ordinal,
            DocumentChunk.content,
            KnowledgeDocument.title,
            distance,
        )
        .join(KnowledgeDocument, KnowledgeDocument.id == DocumentChunk.document_id)
        .where(DocumentChunk.embedding.isnot(None))
        .where(KnowledgeDocument.enabled.is_(True))
        .where(KnowledgeDocument.status == "ready")
        .order_by(distance)
        .limit(limit * 3)
    )
    rows = (await db.execute(stmt)).all()

    results: list[Candidate] = []
    for row in rows:
        sim = 1.0 - float(row.distance if row.distance is not None else 1.0)
        sim = max(0.0, min(1.0, sim))
        results.append(
            Candidate(
                chunk_id=row.id,
                document_id=row.document_id,
                document_title=row.title,
                ordinal=row.ordinal,
                content=row.content,
                vector_score=sim,
            )
        )
    return results[: limit * 2]


async def keyword_search(db: AsyncSession, question: str, limit: int) -> list[Candidate]:
    """关键词召回：词项命中数 + 整句 trigram，取较大者作为分数。

    相关性判定（满足其一即算有效命中）：
      a) 整句 trigram 相似度 > 0.12；
      b) 命中的不同词项数 >= 2 且 >= 最佳命中的 35%。
    """
    terms = _term_list(question)
    tsquery = _tsquery_string(question)
    if not tsquery or not terms:
        return []

    tsvector_expr = func.to_tsvector(sql_text("'simple'"), DocumentChunk.content)
    tsquery_expr = func.to_tsquery(sql_text("'simple'"), tsquery)
    rank_expr = func.ts_rank_cd(tsvector_expr, tsquery_expr)
    trgm_expr = func.similarity(DocumentChunk.content, question)
    term_hits_expr = sum(
        case(
            (
                tsvector_expr.op("@@")(func.to_tsquery(sql_text("'simple'"), f"'{t}'")),
                1,
            ),
            else_=0,
        )
        for t in terms
    )

    stmt = (
        select(
            DocumentChunk.id,
            DocumentChunk.document_id,
            DocumentChunk.ordinal,
            DocumentChunk.content,
            KnowledgeDocument.title,
            rank_expr.label("rank"),
            trgm_expr.label("trgm"),
            term_hits_expr.label("term_hits"),
        )
        .join(KnowledgeDocument, KnowledgeDocument.id == DocumentChunk.document_id)
        .where(KnowledgeDocument.enabled.is_(True))
        .where(KnowledgeDocument.status == "ready")
        .where(tsvector_expr.op("@@")(tsquery_expr) | (trgm_expr > TRIGRAM_MIN_SIMILARITY))
        .order_by(rank_expr.desc(), trgm_expr.desc())
        .limit(limit * 3)
    )
    rows = (await db.execute(stmt)).all()
    if not rows:
        return []

    best_term_hits = max((int(r.term_hits or 0) for r in rows), default=0) or 1
    max_rank = max((float(r.rank or 0) for r in rows), default=0.0) or 1.0

    results: list[Candidate] = []
    for row in rows:
        term_hits = int(row.term_hits or 0)
        trgm = max(0.0, min(1.0, float(row.trgm or 0)))
        relevant = trgm > TRIGRAM_MIN_SIMILARITY or (
            term_hits >= KEYWORD_MIN_TERM_MATCHES
            and term_hits / best_term_hits >= KEYWORD_RELEVANCE_RATIO
        )
        if not relevant:
            continue
        score = max(float(row.rank or 0) / max_rank, trgm)
        if score <= 0:
            continue
        results.append(
            Candidate(
                chunk_id=row.id,
                document_id=row.document_id,
                document_title=row.title,
                ordinal=row.ordinal,
                content=row.content,
                keyword_score=round(score, 4),
            )
        )
    return results[: limit * 2]


async def hybrid_search(
    db: AsyncSession, question: str, top_k: int | None = None
) -> list[Candidate]:
    """混合召回并融合打分。

    打分前对两路分数各自做**相对归一化**（除以本路最高分）：
    向量相似度的绝对值高度依赖嵌入模型（本地哈希嵌入的同类文档通常只有 0.2 左右，
    真实语义模型能到 0.7），若用绝对阈值裁剪，本地嵌入模式下正常提问会被整批丢掉，
    反而让「召回为空 → 误报权限受限」这类问题更容易发生。
    归一化后排名信息完整保留，同时最高分恒为 1.0，便于用统一阈值判「是否命中」。
    """
    top_k = top_k or settings.RETRIEVE_TOP_K
    pool = max(top_k * 3, 20)

    vector_hits = await vector_search(db, question, pool)
    keyword_hits = await keyword_search(db, question, pool)
    if not vector_hits and not keyword_hits:
        logger.info("检索无有效命中：%s", question[:60])
        return []

    v_max = max((c.vector_score for c in vector_hits), default=0.0) or 1.0
    k_max = max((c.keyword_score for c in keyword_hits), default=0.0) or 1.0

    # 记录原始（未归一化）分，供绝对相关性判定与置信度判定使用
    for cand in vector_hits:
        cand.raw_vector_score = cand.vector_score
        cand.raw_score = max(cand.raw_score, cand.vector_score)
    for cand in keyword_hits:
        cand.raw_keyword_score = cand.keyword_score
        cand.raw_score = max(cand.raw_score, cand.keyword_score)

    merged: dict[int, Candidate] = {}
    for cand in vector_hits:
        cand.vector_score = round(cand.vector_score / v_max, 6)
        merged[cand.chunk_id] = cand
    for cand in keyword_hits:
        normalized = round(cand.keyword_score / k_max, 6)
        if cand.chunk_id in merged:
            existing = merged[cand.chunk_id]
            existing.keyword_score = normalized
            existing.raw_keyword_score = cand.raw_keyword_score
            existing.raw_score = max(existing.raw_score, cand.raw_score)
        else:
            cand.keyword_score = normalized
            merged[cand.chunk_id] = cand

    vw = settings.HYBRID_VECTOR_WEIGHT
    kw = settings.HYBRID_KEYWORD_WEIGHT
    total = vw + kw or 1.0

    ranked: list[Candidate] = []
    for cand in merged.values():
        cand.score = round((cand.vector_score * vw + cand.keyword_score * kw) / total, 6)
        ranked.append(cand)

    ranked.sort(key=lambda c: c.score, reverse=True)

    # 相关性截断分两档，必须同时考虑「相对」与「绝对」：
    #   - 相对档：与最高分同量级（过滤明显跑题的尾部候选）；
    #   - 绝对档：原始相似度本身足够高。
    # 只留相对档会误伤「确实高度相关但当前用户无权访问」的候选，
    # 那样用户就收不到「检测到相关制度文档但您无权查阅」的正确提示了。
    if ranked:
        keep_line = ranked[0].score * RELEVANCE_KEEP_RATIO
        raw_floor = (
            ABSOLUTE_RAW_FLOOR_REMOTE
            if settings.remote_embedding_enabled
            else ABSOLUTE_RAW_FLOOR_LOCAL
        )
        kept = [
            c
            for c in ranked
            if c.score >= keep_line
            or (c.raw_vector_score >= raw_floor or c.raw_keyword_score >= raw_floor)
        ]
        dropped = len(ranked) - len(kept)
        if dropped:
            logger.info(
                "相关性截断丢弃 %s/%s 个低分候选（最高分 %.3f，相对线 %.3f，绝对线 %.3f）",
                dropped,
                len(ranked),
                ranked[0].score,
                keep_line,
                raw_floor,
            )
        ranked = kept

    return ranked[:pool]


async def attach_permission_flags(
    db: AsyncSession, ctx: UserContext, candidates: list[Candidate]
) -> tuple[list[Candidate], list[Candidate]]:
    """对候选切片执行四维鉴权过滤，返回（放行, 受限）。"""
    if not candidates:
        return [], []

    doc_ids = list({c.document_id for c in candidates})
    stmt = (
        select(KnowledgeGrant.document_id)
        .where(KnowledgeGrant.document_id.in_(doc_ids))
        .where(build_grant_condition(ctx))
    )
    rows = await db.execute(stmt)
    allowed_docs = {r[0] for r in rows.all()}

    passed = [c for c in candidates if c.document_id in allowed_docs]
    blocked = [c for c in candidates if c.document_id not in allowed_docs]
    return passed, blocked
