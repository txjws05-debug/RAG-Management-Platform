"""AI 鉴权问答引擎：检索 → 权限裁剪 → 提示词编排 → 流式生成 → 引用溯源 → 审计落库。"""
from __future__ import annotations

import json
import logging
import time
import uuid
from collections.abc import AsyncGenerator

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models import ChatMessage, Conversation, FaqEntry, User
from app.schemas import Citation
from app.services import faq_cache, mining
from app.services.llm import LLMService, StreamResult, estimate_tokens, llm_service
from app.services.permission import UserContext
from app.services.retrieval import Candidate, attach_permission_flags, hybrid_search

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """你是企业知识库智能问答助手。必须严格遵守以下规则：

1. 只能依据【参考资料】中的内容回答，不得编造事实、不得使用资料之外的知识。
2. 如果参考资料不足以回答，明确说明「知识库中暂无足够资料」，并给出建议。
3. 引用资料时使用 [1]、[2] 这样的序号标注，序号必须与【参考资料】编号一致。
4. 若本次请求带有【权限受限】标注，你**必须**在回答最后另起一段，原样输出下面这句话
   （不得改写、不得省略，即使在已能部分作答的情况下也必须输出）：
   检测到相关制度文档，但您当前所属部门/角色无权查阅该内容。
   同时绝对不得猜测、描述或暗示受限资料的内容。
5. 回答使用简体中文，结构清晰，可使用 Markdown；涉及步骤、对比时使用列表或表格。"""

# 权限受限标准文案（对应 ROG.txt 2.9.4），供提示词、审计留档与兜底逻辑共用
RESTRICTED_MESSAGE = "检测到相关制度文档，但您当前所属部门/角色无权查阅该内容。"


def _truncate(text: str, limit: int) -> str:
    text = text.strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"


def build_messages(
    question: str,
    allowed: list[Candidate],
    blocked_docs: list[int],
    history: list[dict[str, str]],
) -> list[dict[str, str]]:
    """编排提示词：只有通过鉴权的切片才会进入上下文。"""
    parts: list[str] = []
    for idx, cand in enumerate(allowed, start=1):
        parts.append(
            f"[{idx}] 来源：{cand.document_title}（第 {cand.ordinal + 1} 段，相关度 {cand.score:.2f}）\n"
            f"{_truncate(cand.content, 1200)}"
        )
    materials = "\n\n".join(parts) if parts else "（无可用参考资料）"

    restriction = ""
    if blocked_docs:
        restriction = (
            f"\n【权限受限】本次召回中有 {len(blocked_docs)} 个知识单元因当前用户所属部门/角色/个人权限不足被拦截。"
            "这些内容不得出现在回答中；请按规则第 4 条在回答末尾原样输出受限提示。"
        )

    user_prompt = (
        f"【参考资料】\n{materials}\n"
        f"{restriction}\n\n"
        f"【用户问题】{question}\n\n"
        f"请基于以上已授权参考资料作答。"
    )

    messages: list[dict[str, str]] = [{"role": "system", "content": SYSTEM_PROMPT}]
    messages.extend(history)
    messages.append({"role": "user", "content": user_prompt})
    return messages


def _sse(event: str, data: dict | list | str) -> str:
    payload = data if isinstance(data, str) else json.dumps(data, ensure_ascii=False)
    return f"event: {event}\ndata: {payload}\n\n"


async def get_or_create_conversation(
    db: AsyncSession, user: User, session_key: str | None, question: str
) -> Conversation:
    if session_key:
        conv = (
            await db.execute(
                select(Conversation).where(
                    Conversation.session_key == session_key, Conversation.user_id == user.id
                )
            )
        ).scalar_one_or_none()
        if conv is not None:
            return conv

    conv = Conversation(
        session_key=session_key or uuid.uuid4().hex,
        user_id=user.id,
        title=_truncate(question, 40),
    )
    db.add(conv)
    await db.flush()
    return conv


async def _history_messages(db: AsyncSession, conversation_id: int, limit: int = 3) -> list[dict]:
    rows = (
        await db.execute(
            select(ChatMessage)
            .where(
                ChatMessage.conversation_id == conversation_id,
                ChatMessage.role.in_(["user", "assistant"]),
                ChatMessage.answer.isnot(None) | ChatMessage.question.isnot(None),
            )
            .order_by(ChatMessage.id.desc())
            .limit(limit * 2)
        )
    ).scalars().all()

    history: list[dict[str, str]] = []
    for row in reversed(rows):
        if row.role == "user" and row.question:
            history.append({"role": "user", "content": _truncate(row.question, 300)})
        elif row.role == "assistant" and row.answer:
            history.append({"role": "assistant", "content": _truncate(row.answer, 400)})
    return history[-4:]


async def answer_stream(
    db: AsyncSession,
    user: User,
    ctx: UserContext,
    question: str,
    session_key: str | None = None,
    top_k: int | None = None,
    use_faq_cache: bool = True,
    service: LLMService | None = None,
) -> AsyncGenerator[str, None]:
    """SSE 事件流。

    events: meta / citations / restricted / delta / done / error
    """
    service = service or llm_service
    started = time.perf_counter()

    conv = await get_or_create_conversation(db, user, session_key, question)
    history = await _history_messages(db, conv.id)

    db.add(
        ChatMessage(
            conversation_id=conv.id,
            user_id=user.id,
            role="user",
            question=question,
        )
    )
    await db.flush()

    yield _sse(
        "meta",
        {
            "session_key": conv.session_key,
            "conversation_id": conv.id,
            "user": {"id": user.id, "name": user.display_name or user.username},
        },
    )

    # ---------- 1) FAQ 缓存直出 ----------
    if use_faq_cache:
        hit = await faq_cache.match_faq(db, question)
        if hit is not None:
            yield _sse(
                "tool",
                {
                    "stage": "faq_cache",
                    "matched": True,
                    "similarity": round(hit["similarity"], 4),
                    "faq_entry_id": hit["id"],
                },
            )
            citations = [
                Citation(
                    index=1,
                    document_id=0,
                    document_title="FAQ 标准答案库",
                    chunk_id=0,
                    ordinal=0,
                    score=round(hit["similarity"], 4),
                    snippet=_truncate(hit["answer"], 160),
                )
            ]
            yield _sse("citations", [c.model_dump() for c in citations])
            answer = hit["answer"]
            step = 16
            for i in range(0, len(answer), step):
                yield _sse("delta", {"text": answer[i : i + step]})

            entry = hit["id"]
            faq_row = (
                await db.execute(select(FaqEntry).where(FaqEntry.id == entry))
            ).scalar_one_or_none()
            if faq_row is not None:
                faq_row.hit_count += 1

            latency_ms = int((time.perf_counter() - started) * 1000)
            msg = ChatMessage(
                conversation_id=conv.id,
                user_id=user.id,
                role="assistant",
                answer=answer,
                citations=[c.model_dump() for c in citations],
                recalled_chunk_ids=[],
                passed_chunk_ids=[],
                blocked_document_ids=[],
                top_score=round(hit["similarity"], 4),
                latency_ms=latency_ms,
                prompt_tokens=0,
                completion_tokens=estimate_tokens(answer),
                total_tokens=estimate_tokens(answer),
                answer_source="faq_cache",
                faq_hit_id=entry,
            )
            db.add(msg)
            conv.message_count += 2
            await db.flush()
            yield _sse(
                "done",
                {
                    "session_key": conv.session_key,
                    "message_id": msg.id,
                    "answer_source": "faq_cache",
                    "latency_ms": latency_ms,
                    "total_tokens": msg.total_tokens,
                    "top_score": msg.top_score,
                    "faq_hit_id": entry,
                    "faq_similarity": round(hit["similarity"], 4),
                },
            )
            return

    # ---------- 2) 混合检索 ----------
    candidates = await hybrid_search(db, question, top_k=top_k)
    passed, blocked = await attach_permission_flags(db, ctx, candidates)

    citations: list[Citation] = []
    for idx, cand in enumerate(passed, start=1):
        citations.append(
            Citation(
                index=idx,
                document_id=cand.document_id,
                document_title=cand.document_title,
                chunk_id=cand.chunk_id,
                ordinal=cand.ordinal,
                score=round(cand.score, 4),
                snippet=_truncate(cand.content, 160),
            )
        )

    blocked_doc_ids = sorted({c.document_id for c in blocked})
    restricted = bool(blocked_doc_ids)
    restricted_message = RESTRICTED_MESSAGE if restricted else None
    # 展示/审计用的「相关度」采用归一化融合分（0~1 相对量纲，跨嵌入模型可比）；
    # 而「是否命中」的置信度判定必须用归一化前的原始相似度，否则恒为 1.0 永不判缺口。
    top_score = max((c.score for c in candidates), default=0.0)
    raw_top_score = max((c.raw_score for c in candidates), default=0.0)

    yield _sse("citations", [c.model_dump() for c in citations])
    if restricted:
        yield _sse(
            "restricted",
            {
                "blocked_document_count": len(blocked_doc_ids),
                "blocked_chunk_count": len(blocked),
                "message": restricted_message,
            },
        )

    # 鉴权分流明细（供工作台展示与审计复核）
    yield _sse(
        "authz",
        {
            "user_id": ctx.user_id,
            "department_id": ctx.department_id,
            "role_ids": sorted(ctx.role_ids),
            "recalled_document_ids": sorted({c.document_id for c in candidates}),
            "allowed_document_ids": sorted({c.document_id for c in passed}),
            "blocked_document_ids": blocked_doc_ids,
            "recalled_chunk_count": len(candidates),
            "allowed_chunk_count": len(passed),
            "blocked_chunk_count": len(blocked),
            "top_score": round(top_score, 4),
            "raw_top_score": round(raw_top_score, 4),
            "confidence_threshold": settings.effective_confidence_threshold,
        },
    )

    # ---------- 3) 组装 Prompt 并流式生成 ----------
    messages = build_messages(question, passed, blocked_doc_ids, history)
    result = StreamResult()
    try:
        async for piece in service.stream_chat(messages, result):
            yield _sse("delta", {"text": piece})
    except Exception as exc:  # noqa: BLE001
        logger.exception("生成回答失败")
        yield _sse("error", {"message": f"生成回答失败：{exc}"})

    answer = result.content
    # 确定性兜底：受限提示是验收硬要求，不能完全依赖模型自觉遵守提示词。
    # 若模型没输出，则由服务端补上并同步下发给前端，保证「权限缺失提示」不缺失。
    if restricted and RESTRICTED_MESSAGE not in answer:
        suffix = f"\n\n> {RESTRICTED_MESSAGE}\n"
        answer += suffix
        yield _sse("delta", {"text": suffix})
        result.content = answer
        logger.info("模型未输出受限提示，已由服务端补全")

    latency_ms = int((time.perf_counter() - started) * 1000)

    # ---------- 4) 审计落库 ----------
    msg = ChatMessage(
        conversation_id=conv.id,
        user_id=user.id,
        role="assistant",
        answer=answer,
        citations=[c.model_dump() for c in citations],
        recalled_chunk_ids=[c.chunk_id for c in candidates],
        passed_chunk_ids=[c.chunk_id for c in passed],
        blocked_document_ids=blocked_doc_ids,
        top_score=round(top_score, 4),
        latency_ms=latency_ms,
        prompt_tokens=result.prompt_tokens,
        completion_tokens=result.completion_tokens,
        total_tokens=result.total_tokens,
        answer_source=result.source,
        restricted_notice=restricted,
        restricted_message=restricted_message,
    )
    db.add(msg)
    conv.message_count += 2
    if conv.title == "新会话":
        conv.title = _truncate(question, 40)
    await db.flush()

    # ---------- 5) 知识缺口识别 ----------
    if raw_top_score < settings.effective_confidence_threshold or not passed:
        try:
            await mining.record_gap(
                db,
                question,
                max_similarity=raw_top_score,
                department_id=ctx.department_id,
                suggested_category="待分类",
            )
        except Exception:  # noqa: BLE001
            logger.exception("写入知识缺口失败")

    yield _sse(
        "done",
        {
            "session_key": conv.session_key,
            "message_id": msg.id,
            "answer_source": result.source,
            "latency_ms": latency_ms,
            "prompt_tokens": result.prompt_tokens,
            "completion_tokens": result.completion_tokens,
            "total_tokens": result.total_tokens,
            "top_score": round(top_score, 4),
            "raw_top_score": round(raw_top_score, 4),
            "restricted": restricted,
            "recalled": len(candidates),
            "passed": len(passed),
            "blocked": len(blocked),
            "llm_error": result.error,
        },
    )
