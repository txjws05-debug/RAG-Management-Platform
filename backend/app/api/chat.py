"""AI 智能问答工作台：SSE 流式问答、多轮上下文、历史会话、审计记录。"""
from __future__ import annotations

import json
import logging
from collections.abc import AsyncGenerator

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_user_context, require_permission
from app.core.db import SessionLocal, get_db
from app.models import ChatMessage, Conversation, FaqEntry, KnowledgeDocument, User
from app.schemas import (
    ChatAskRequest,
    Citation,
    ConversationRow,
    MessageRow,
    ok,
)
from app.services.chat import answer_stream
from app.services.permission import UserContext, allowed_document_ids

logger = logging.getLogger(__name__)

router = APIRouter(tags=["智能问答"])

SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "Content-Type": "text/event-stream; charset=utf-8",
}


def _citations(raw) -> list[Citation]:
    items: list[Citation] = []
    for row in raw or []:
        try:
            items.append(Citation(**row))
        except Exception:  # noqa: BLE001
            continue
    return items


@router.post("/chat/ask")
async def ask(
    payload: ChatAskRequest,
    user: User = Depends(get_current_user),
    ctx: UserContext = Depends(require_permission("ai:chat")),
):
    """流式问答：SSE 事件 meta / citations / restricted / authz / delta / done / error。

    注意：这里刻意不使用 `Depends(get_db)`。
    FastAPI 的依赖清理（yield 之后的 commit）发生在响应发送完毕之后，
    而 StreamingResponse 的生成器是在响应期间消费的 —— 那样写会在流结束前
    就把会话收走，导致「审计落库丢失」或「生成器中途报错」。
    因此改为在生成器内部自行提交、自行关闭。
    """
    question = payload.question.strip()

    async def event_stream() -> AsyncGenerator[str, None]:
        async with SessionLocal() as session:
            try:
                async for event in answer_stream(
                    db=session,
                    user=user,
                    ctx=ctx,
                    question=question,
                    session_key=payload.session_key,
                    top_k=payload.top_k,
                    use_faq_cache=payload.use_faq_cache,
                ):
                    yield event
                await session.commit()
            except Exception as exc:  # noqa: BLE001
                await session.rollback()
                logger.exception("流式问答失败")
                yield f'event: error\ndata: {json.dumps({"message": f"服务异常：{exc}"}, ensure_ascii=False)}\n\n'

    return StreamingResponse(event_stream(), headers=SSE_HEADERS, media_type="text/event-stream")


@router.post("/chat/ask-sync", response_model=dict)
async def ask_sync(
    payload: ChatAskRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    ctx: UserContext = Depends(require_permission("ai:chat")),
):
    """非流式版本，便于脚本化验收与自动化测试。"""
    answer_parts: list[str] = []
    citations: list[Citation] = []
    restricted = False
    done_payload: dict = {}

    async for event in answer_stream(
        db=db,
        user=user,
        ctx=ctx,
        question=payload.question.strip(),
        session_key=payload.session_key,
        top_k=payload.top_k,
        use_faq_cache=payload.use_faq_cache,
    ):
        for block in event.strip().split("\n\n"):
            if not block.startswith("event:"):
                continue
            lines = block.split("\n")
            name = lines[0][6:].strip()
            # 按前缀剥离，而不是按固定长度切片：
            # 本项目的 SSE 帧是 `data:{...}`（冒号后无空格），若写死 [4:] 会把冒号
            # 并进 JSON 导致解析失败；而遵循规范的服务器会发 `data: {...}`。
            # 两种写法都要能正确取到载荷。
            raw = "\n".join(lines[1:]).strip()
            body = raw[5:].strip() if raw.startswith("data:") else raw
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                data = body
            if name == "delta" and isinstance(data, dict):
                answer_parts.append(data.get("text", ""))
            elif name == "citations" and isinstance(data, list):
                citations = _citations(data)
            elif name == "restricted":
                restricted = True
            elif name == "done" and isinstance(data, dict):
                done_payload = data

    return ok(
        {
            "answer": "".join(answer_parts),
            "citations": [c.model_dump() for c in citations],
            "restricted_notice": restricted,
            **(done_payload or {}),
        }
    )


@router.get("/chat/conversations", response_model=dict)
async def list_conversations(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    _=Depends(require_permission("ai:chat")),
    limit: int = Query(default=30, ge=1, le=100),
):
    rows = (
        await db.execute(
            select(Conversation)
            .where(Conversation.user_id == user.id)
            .order_by(Conversation.updated_at.desc())
            .limit(limit)
        )
    ).scalars().all()
    return ok(
        [
            ConversationRow(
                session_key=c.session_key,
                title=c.title,
                message_count=c.message_count,
                updated_at=c.updated_at.isoformat() if c.updated_at else None,
            ).model_dump()
            for c in rows
        ]
    )


@router.get("/chat/conversations/{session_key}", response_model=dict)
async def get_conversation(
    session_key: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    _=Depends(require_permission("ai:chat")),
):
    conv = (
        await db.execute(
            select(Conversation).where(
                Conversation.session_key == session_key, Conversation.user_id == user.id
            )
        )
    ).scalar_one_or_none()
    if conv is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="会话不存在")

    rows = (
        await db.execute(
            select(ChatMessage)
            .where(ChatMessage.conversation_id == conv.id)
            .order_by(ChatMessage.id)
        )
    ).scalars().all()

    messages: list[dict] = []
    for row in rows:
        if row.role == "user":
            if not row.question:
                continue
            messages.append(
                MessageRow(
                    id=row.id,
                    role="user",
                    content=row.question,
                    created_at=row.created_at.isoformat() if row.created_at else None,
                ).model_dump()
            )
        else:
            if not row.answer:
                continue
            messages.append(
                MessageRow(
                    id=row.id,
                    role="assistant",
                    content=row.answer,
                    citations=_citations(row.citations),
                    restricted_notice=row.restricted_notice,
                    restricted_message=row.restricted_message,
                    answer_source=row.answer_source,
                    latency_ms=row.latency_ms,
                    total_tokens=row.total_tokens,
                    top_score=row.top_score,
                    created_at=row.created_at.isoformat() if row.created_at else None,
                ).model_dump()
            )

    return ok(
        {
            "session_key": conv.session_key,
            "title": conv.title,
            "messages": messages,
        }
    )


@router.delete("/chat/conversations/{session_key}", response_model=dict)
async def delete_conversation(
    session_key: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    _=Depends(require_permission("ai:chat")),
):
    conv = (
        await db.execute(
            select(Conversation).where(
                Conversation.session_key == session_key, Conversation.user_id == user.id
            )
        )
    ).scalar_one_or_none()
    if conv is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="会话不存在")
    await db.delete(conv)
    await db.flush()
    return ok({"session_key": session_key})


@router.get("/chat/suggestions", response_model=dict)
async def suggestions(
    db: AsyncSession = Depends(get_db),
    ctx: UserContext = Depends(get_user_context),
    keyword: str | None = Query(default=None),
):
    """智能联想提问：来自已发布 FAQ 与有权访问的知识单元标题。"""
    items: list[str] = []

    faq_rows = (
        await db.execute(
            select(FaqEntry.question)
            .where(FaqEntry.enabled.is_(True))
            .order_by(FaqEntry.hit_count.desc())
            .limit(12)
        )
    ).scalars().all()
    items.extend(faq_rows)

    stmt = select(KnowledgeDocument.title).where(
        KnowledgeDocument.enabled.is_(True), KnowledgeDocument.status == "ready"
    )
    if not ctx.is_knowledge_admin:
        allowed = await allowed_document_ids(db, ctx)
        if not allowed:
            allowed = {-1}
        stmt = stmt.where(KnowledgeDocument.id.in_(allowed))
    if keyword:
        stmt = stmt.where(KnowledgeDocument.title.ilike(f"%{keyword.strip()}%"))
    doc_rows = (await db.execute(stmt.limit(12))).scalars().all()
    items.extend(f"《{t}》主要讲了什么？" for t in doc_rows)

    if not keyword:
        items.extend(
            [
                "差旅报销标准是多少？",
                "生鲜食品破损如何申请退款？",
                "海外直邮保税仓清关延误怎么处理？",
            ]
        )

    seen: set[str] = set()
    unique = [x for x in items if x and not (x in seen or seen.add(x))]
    return ok(unique[:20])


@router.get("/chat/audit", response_model=dict)
async def audit_records(
    db: AsyncSession = Depends(get_db),
    _=Depends(require_permission("dashboard:view")),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=200),
):
    """单次问答审计记录：召回 / 鉴权通过 / 鉴权拦截 / Token / 耗时。"""
    stmt = select(ChatMessage).where(ChatMessage.role == "assistant")
    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = (
        await db.execute(
            stmt.order_by(ChatMessage.id.desc()).offset((page - 1) * page_size).limit(page_size)
        )
    ).scalars().all()

    user_ids = {r.user_id for r in rows}
    users = {}
    if user_ids:
        user_rows = (await db.execute(select(User).where(User.id.in_(user_ids)))).scalars().all()
        users = {u.id: (u.display_name or u.username) for u in user_rows}

    conv_ids = {r.conversation_id for r in rows}
    convs = {}
    if conv_ids:
        conv_rows = (
            await db.execute(select(Conversation).where(Conversation.id.in_(conv_ids)))
        ).scalars().all()
        convs = {c.id: c.session_key for c in conv_rows}

    items = []
    for row in rows:
        items.append(
            {
                "id": row.id,
                "session_key": convs.get(row.conversation_id, ""),
                "user_id": row.user_id,
                "user_name": users.get(row.user_id, ""),
                "question": row.question or "",
                "asked_at": row.created_at.isoformat() if row.created_at else None,
                "recalled": row.recalled_chunk_ids or [],
                "passed": row.passed_chunk_ids or [],
                "blocked": row.blocked_document_ids or [],
                "total_tokens": row.total_tokens,
                "latency_ms": row.latency_ms,
                "top_score": row.top_score,
                "answer_source": row.answer_source,
                "restricted_notice": row.restricted_notice,
                "answer_preview": (row.answer or "")[:120],
            }
        )
    return ok({"items": items, "total": total, "page": page, "page_size": page_size})


@router.get("/chat/search-log", response_model=dict)
async def search_log(
    db: AsyncSession = Depends(get_db),
    ctx: UserContext = Depends(get_user_context),
    _=Depends(require_permission("ai:chat")),
    keyword: str | None = Query(default=None),
    limit: int = Query(default=15, ge=1, le=50),
):
    """当前用户的提问历史，用于工作台侧栏快速回溯。"""
    stmt = (
        select(ChatMessage)
        .where(ChatMessage.user_id == ctx.user_id, ChatMessage.role == "user")
        .where(ChatMessage.question.isnot(None))
    )
    if keyword:
        stmt = stmt.where(
            or_(ChatMessage.question.ilike(f"%{keyword}%"), ChatMessage.answer.is_(None))
        )
    rows = (
        await db.execute(stmt.order_by(ChatMessage.id.desc()).limit(limit))
    ).scalars().all()
    return ok(
        [
            {"id": r.id, "question": r.question, "at": r.created_at.isoformat() if r.created_at else None}
            for r in rows
        ]
    )
