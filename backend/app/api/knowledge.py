"""知识维护与导入中心：台账、上传/批量导入、解析状态、四维数据权限配置。"""
from __future__ import annotations

import logging
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    UploadFile,
    status,
)
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_user_context, require_permission
from app.core.config import settings
from app.core.db import get_db
from app.models import (
    Department,
    DocumentChunk,
    KnowledgeDocument,
    KnowledgeGrant,
    Role,
    User,
)
from app.schemas import (
    ChunkRow,
    DocumentRow,
    DocumentUpdate,
    GrantConfig,
    GrantView,
    UploadResult,
    ok,
)
from app.services.document import detect_file_type
from app.services.ingest import generate_code, ingest_in_background, reindex_document, save_upload
from app.services.permission import (
    SCOPE_DEPARTMENT,
    SCOPE_GLOBAL,
    SCOPE_ROLE,
    SCOPE_USER,
    UserContext,
    allowed_document_ids,
    describe_grants,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["知识维护"])

require_manage = require_permission("knowledge:manage")


async def _build_name_map(db: AsyncSession, grants: list[KnowledgeGrant]) -> dict[tuple[str, int], str]:
    dept_ids = {g.subject_id for g in grants if g.scope == SCOPE_DEPARTMENT}
    role_ids = {g.subject_id for g in grants if g.scope == SCOPE_ROLE}
    user_ids = {g.subject_id for g in grants if g.scope == SCOPE_USER}

    mapping: dict[tuple[str, int], str] = {}
    if dept_ids:
        for d in (await db.execute(select(Department).where(Department.id.in_(dept_ids)))).scalars():
            mapping[(SCOPE_DEPARTMENT, d.id)] = d.name
    if role_ids:
        for r in (await db.execute(select(Role).where(Role.id.in_(role_ids)))).scalars():
            mapping[(SCOPE_ROLE, r.id)] = r.name
    if user_ids:
        for u in (await db.execute(select(User).where(User.id.in_(user_ids)))).scalars():
            mapping[(SCOPE_USER, u.id)] = u.display_name or u.username
    return mapping


async def _document_rows(
    db: AsyncSession, documents: list[KnowledgeDocument]
) -> list[DocumentRow]:
    if not documents:
        return []
    doc_ids = [d.id for d in documents]
    grants = (
        await db.execute(select(KnowledgeGrant).where(KnowledgeGrant.document_id.in_(doc_ids)))
    ).scalars().all()
    name_map = await _build_name_map(db, list(grants))

    grouped: dict[int, list[KnowledgeGrant]] = {}
    for grant in grants:
        grouped.setdefault(grant.document_id, []).append(grant)

    rows: list[DocumentRow] = []
    for doc in documents:
        doc_grants = grouped.get(doc.id, [])
        rows.append(
            DocumentRow(
                id=doc.id,
                code=doc.code,
                title=doc.title,
                file_type=doc.file_type,
                category=doc.category,
                status=doc.status,
                enabled=doc.enabled,
                chunk_count=doc.chunk_count,
                char_count=doc.char_count,
                file_size=doc.file_size,
                error_message=doc.error_message,
                created_at=doc.created_at.isoformat() if doc.created_at else None,
                updated_at=doc.updated_at.isoformat() if doc.updated_at else None,
                grants=[
                    GrantView(
                        scope=g.scope,
                        subject_id=g.subject_id,
                        subject_name=name_map.get((g.scope, g.subject_id), "全员" if g.scope == SCOPE_GLOBAL else ""),
                    )
                    for g in doc_grants
                ],
                grant_summary=describe_grants(doc_grants, name_map),
            )
        )
    return rows


@router.get("/knowledge/documents", response_model=dict)
async def list_documents(
    db: AsyncSession = Depends(get_db),
    ctx: UserContext = Depends(get_user_context),
    keyword: str | None = Query(default=None),
    category: str | None = Query(default=None),
    file_type: str | None = Query(default=None),
    status_filter: str | None = Query(default=None, alias="status"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=200),
):
    stmt = select(KnowledgeDocument)
    if not ctx.is_knowledge_admin:
        # 普通用户只看到自己有权访问的知识单元
        allowed = await allowed_document_ids(db, ctx)
        if not allowed:
            return ok({"items": [], "total": 0, "page": page, "page_size": page_size})
        stmt = stmt.where(KnowledgeDocument.id.in_(allowed))

    if keyword:
        like = f"%{keyword.strip()}%"
        stmt = stmt.where(
            KnowledgeDocument.title.ilike(like) | KnowledgeDocument.code.ilike(like)
        )
    if category:
        stmt = stmt.where(KnowledgeDocument.category == category)
    if file_type:
        stmt = stmt.where(KnowledgeDocument.file_type == file_type)
    if status_filter:
        stmt = stmt.where(KnowledgeDocument.status == status_filter)

    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    docs = (
        await db.execute(
            stmt.order_by(KnowledgeDocument.id.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
    ).scalars().all()

    rows = await _document_rows(db, list(docs))
    return ok(
        {
            "items": [r.model_dump() for r in rows],
            "total": total,
            "page": page,
            "page_size": page_size,
        }
    )


@router.get("/knowledge/categories", response_model=dict)
async def list_categories(db: AsyncSession = Depends(get_db), _=Depends(get_user_context)):
    rows = (
        await db.execute(
            select(KnowledgeDocument.category, func.count(KnowledgeDocument.id)).group_by(
                KnowledgeDocument.category
            )
        )
    ).all()
    return ok([{"name": r[0], "count": int(r[1])} for r in rows])


async def _create_document(
    db: AsyncSession,
    ctx: UserContext,
    file: UploadFile,
    category: str,
) -> KnowledgeDocument:
    filename = file.filename or "untitled.txt"
    ext = Path(filename).suffix.lower()
    if ext not in settings.allowed_extensions:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail=f"不支持的格式 {ext}，仅支持 {sorted(settings.allowed_extensions)}",
        )
    data = await file.read()
    if not data:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=f"{filename} 内容为空")
    if len(data) > settings.max_upload_bytes:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail=f"{filename} 超过 {settings.MAX_UPLOAD_MB}MB 限制",
        )

    stored = await save_upload(filename, data)
    document = KnowledgeDocument(
        code=generate_code(),
        title=Path(filename).stem,
        file_type=detect_file_type(filename),
        category=category or "未分类",
        source_type="upload",
        stored_path=str(stored),
        file_size=len(data),
        status="pending",
        created_by=ctx.user_id,
        tags=[],
    )
    db.add(document)
    await db.flush()
    return document


@router.post("/knowledge/documents/upload", response_model=dict)
async def upload_document(
    background: BackgroundTasks,
    file: Annotated[UploadFile, File(...)],
    category: Annotated[str, Form()] = "未分类",
    db: AsyncSession = Depends(get_db),
    ctx: UserContext = Depends(require_manage),
):
    """单文件上传：入库后台化，接口立即返回，前端轮询解析状态。"""
    document = await _create_document(db, ctx, file, category)
    data = Path(document.stored_path).read_bytes()  # type: ignore[arg-type]
    background.add_task(ingest_in_background, document.id, data, file.filename or document.title)
    return ok(
        UploadResult(
            id=document.id,
            title=document.title,
            file_type=document.file_type,
            status=document.status,
            chunk_count=0,
            char_count=0,
            message="已接收，正在后台解析与向量化",
        ).model_dump()
    )


@router.post("/knowledge/documents/batch-upload", response_model=dict)
async def batch_upload_documents(
    background: BackgroundTasks,
    files: Annotated[list[UploadFile], File(...)],
    category: Annotated[str, Form()] = "未分类",
    db: AsyncSession = Depends(get_db),
    ctx: UserContext = Depends(require_manage),
):
    """批量/文件夹拖拽导入：逐个后台解析，返回逐条受理结果。"""
    results: list[dict] = []
    failures: list[dict] = []
    for file in files:
        try:
            document = await _create_document(db, ctx, file, category)
            data = Path(document.stored_path).read_bytes()  # type: ignore[arg-type]
            background.add_task(
                ingest_in_background, document.id, data, file.filename or document.title
            )
            results.append(
                UploadResult(
                    id=document.id,
                    title=document.title,
                    file_type=document.file_type,
                    status=document.status,
                    chunk_count=0,
                    char_count=0,
                    message="已受理",
                ).model_dump()
            )
        except HTTPException as exc:
            failures.append({"filename": file.filename, "message": str(exc.detail)})
        except Exception as exc:  # noqa: BLE001
            logger.exception("批量导入失败 %s", file.filename)
            failures.append({"filename": file.filename, "message": str(exc)})

    return ok(
        {
            "accepted": results,
            "failed": failures,
            "accepted_count": len(results),
            "failed_count": len(failures),
        }
    )


@router.get("/knowledge/documents/{document_id}", response_model=dict)
async def get_document(
    document_id: int,
    db: AsyncSession = Depends(get_db),
    ctx: UserContext = Depends(get_user_context),
):
    document = (
        await db.execute(select(KnowledgeDocument).where(KnowledgeDocument.id == document_id))
    ).scalar_one_or_none()
    if document is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="知识单元不存在")

    if not ctx.is_knowledge_admin:
        allowed = await allowed_document_ids(db, ctx)
        if document_id not in allowed:
            raise HTTPException(status.HTTP_403_FORBIDDEN, detail="您无权访问该知识单元")

    rows = await _document_rows(db, [document])
    return ok(rows[0].model_dump())


@router.get("/knowledge/documents/{document_id}/chunks", response_model=dict)
async def list_chunks(
    document_id: int,
    db: AsyncSession = Depends(get_db),
    ctx: UserContext = Depends(get_user_context),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=10, ge=1, le=100),
):
    document = (
        await db.execute(select(KnowledgeDocument).where(KnowledgeDocument.id == document_id))
    ).scalar_one_or_none()
    if document is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="知识单元不存在")
    if not ctx.is_knowledge_admin:
        allowed = await allowed_document_ids(db, ctx)
        if document_id not in allowed:
            raise HTTPException(status.HTTP_403_FORBIDDEN, detail="您无权查看该知识单元切片")

    total = (
        await db.execute(
            select(func.count(DocumentChunk.id)).where(DocumentChunk.document_id == document_id)
        )
    ).scalar_one()
    chunks = (
        await db.execute(
            select(DocumentChunk)
            .where(DocumentChunk.document_id == document_id)
            .order_by(DocumentChunk.ordinal)
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
    ).scalars().all()

    return ok(
        {
            "items": [
                ChunkRow(
                    id=c.id, ordinal=c.ordinal, content=c.content, char_count=c.char_count
                ).model_dump()
                for c in chunks
            ],
            "total": total,
            "page": page,
            "page_size": page_size,
        }
    )


@router.put("/knowledge/documents/{document_id}", response_model=dict)
async def update_document(
    document_id: int,
    payload: DocumentUpdate,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_manage),
):
    document = (
        await db.execute(select(KnowledgeDocument).where(KnowledgeDocument.id == document_id))
    ).scalar_one_or_none()
    if document is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="知识单元不存在")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(document, key, value)
    await db.flush()
    return ok({"id": document.id})


@router.post("/knowledge/documents/{document_id}/reindex", response_model=dict)
async def reindex(
    document_id: int,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_manage),
):
    document = (
        await db.execute(select(KnowledgeDocument).where(KnowledgeDocument.id == document_id))
    ).scalar_one_or_none()
    if document is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="知识单元不存在")
    document = await reindex_document(db, document)
    return ok(
        {
            "id": document.id,
            "status": document.status,
            "chunk_count": document.chunk_count,
            "error_message": document.error_message,
        }
    )


@router.delete("/knowledge/documents/{document_id}", response_model=dict)
async def delete_document(
    document_id: int,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_manage),
):
    document = (
        await db.execute(select(KnowledgeDocument).where(KnowledgeDocument.id == document_id))
    ).scalar_one_or_none()
    if document is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="知识单元不存在")

    if document.stored_path:
        try:
            Path(document.stored_path).unlink(missing_ok=True)
        except OSError:
            logger.warning("删除原始文件失败: %s", document.stored_path)

    await db.delete(document)
    await db.flush()
    return ok({"id": document_id, "message": "知识单元已删除"})


# ---------------------------------------------------------------------
# 四维数据权限配置
# ---------------------------------------------------------------------
@router.get("/knowledge/documents/{document_id}/grants", response_model=dict)
async def get_grants(
    document_id: int,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_manage),
):
    grants = (
        await db.execute(select(KnowledgeGrant).where(KnowledgeGrant.document_id == document_id))
    ).scalars().all()
    name_map = await _build_name_map(db, list(grants))
    return ok(
        {
            "global_public": any(g.scope == SCOPE_GLOBAL for g in grants),
            "department_ids": [g.subject_id for g in grants if g.scope == SCOPE_DEPARTMENT],
            "role_ids": [g.subject_id for g in grants if g.scope == SCOPE_ROLE],
            "user_ids": [g.subject_id for g in grants if g.scope == SCOPE_USER],
            "details": [
                GrantView(
                    scope=g.scope,
                    subject_id=g.subject_id,
                    subject_name=name_map.get((g.scope, g.subject_id), "全员" if g.scope == SCOPE_GLOBAL else ""),
                ).model_dump()
                for g in grants
            ],
        }
    )


@router.put("/knowledge/documents/{document_id}/grants", response_model=dict)
async def set_grants(
    document_id: int,
    payload: GrantConfig,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_manage),
):
    """整体覆盖式配置四维权限；规则即时生效（鉴权按 DB 实时判定，无需额外刷新）。"""
    document = (
        await db.execute(select(KnowledgeDocument).where(KnowledgeDocument.id == document_id))
    ).scalar_one_or_none()
    if document is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="知识单元不存在")

    await db.execute(
        KnowledgeGrant.__table__.delete().where(KnowledgeGrant.document_id == document_id)
    )

    created = 0
    if payload.global_public:
        db.add(KnowledgeGrant(document_id=document_id, scope=SCOPE_GLOBAL, subject_id=0))
        created += 1
    for dept_id in set(payload.department_ids):
        db.add(
            KnowledgeGrant(document_id=document_id, scope=SCOPE_DEPARTMENT, subject_id=dept_id)
        )
        created += 1
    for role_id in set(payload.role_ids):
        db.add(KnowledgeGrant(document_id=document_id, scope=SCOPE_ROLE, subject_id=role_id))
        created += 1
    for user_id in set(payload.user_ids):
        db.add(KnowledgeGrant(document_id=document_id, scope=SCOPE_USER, subject_id=user_id))
        created += 1

    await db.flush()
    grants = (
        await db.execute(select(KnowledgeGrant).where(KnowledgeGrant.document_id == document_id))
    ).scalars().all()
    name_map = await _build_name_map(db, list(grants))
    return ok(
        {
            "document_id": document_id,
            "grant_count": created,
            "grant_summary": describe_grants(list(grants), name_map),
            "updated_at": datetime.now(UTC).isoformat(),
        }
    )
