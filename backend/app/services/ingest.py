"""知识导入服务：文件落盘 → 解析 → 清洗 → 切片 → 向量化 → 入库。"""
from __future__ import annotations

import logging
import secrets
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.db import SessionLocal
from app.models import DocumentChunk, KnowledgeDocument
from app.services.document import chunk_text, clean_text, detect_file_type, parse_document
from app.services.embeddings import embed_texts
from app.services.llm import estimate_tokens

logger = logging.getLogger(__name__)


def generate_code(prefix: str = "KB") -> str:
    return f"{prefix}{datetime.now(UTC).strftime('%Y%m%d')}{secrets.token_hex(3).upper()}"


async def save_upload(filename: str, data: bytes) -> Path:
    safe_name = Path(filename).name
    stored = settings.upload_dir / f"{datetime.now(UTC).strftime('%Y%m%d%H%M%S')}_{secrets.token_hex(4)}_{safe_name}"
    stored.write_bytes(data)
    return stored


async def ingest_document(
    db: AsyncSession,
    document_id: int,
    data: bytes,
    filename: str,
) -> KnowledgeDocument:
    """执行完整解析入库流程；失败时把文档置为 failed 并记录原因。"""
    document = (
        await db.execute(select(KnowledgeDocument).where(KnowledgeDocument.id == document_id))
    ).scalar_one()
    document.status = "parsing"
    document.error_message = None
    await db.flush()

    try:
        file_type = detect_file_type(filename)
        parsed = parse_document(filename, data)
        cleaned = clean_text(parsed.text, file_type)

        if not cleaned.strip():
            raise ValueError(
                "文档未提取到有效文本内容"
                + (f"（{'；'.join(parsed.warnings)}）" if parsed.warnings else "")
            )

        pieces = chunk_text(cleaned)
        if not pieces:
            raise ValueError("文本切片结果为空，请检查文档内容长度")

        vectors = embed_texts([p["content"] for p in pieces])

        # 重建切片（支持重新索引）
        await db.execute(delete(DocumentChunk).where(DocumentChunk.document_id == document.id))
        await db.flush()

        for ordinal, (piece, vector) in enumerate(zip(pieces, vectors, strict=True)):
            db.add(
                DocumentChunk(
                    document_id=document.id,
                    ordinal=ordinal,
                    content=piece["content"],
                    char_count=piece["char_count"],
                    token_estimate=estimate_tokens(piece["content"]),
                    embedding=vector,
                    meta={"heading": piece.get("heading", ""), "file_type": file_type},
                )
            )

        document.chunk_count = len(pieces)
        document.char_count = len(cleaned)
        document.file_type = file_type
        document.status = "ready"
        document.error_message = None
        document.tags = [document.category]
        await db.flush()
        logger.info("知识单元 %s 入库完成，切片 %s 个", document.code, len(pieces))
    except Exception as exc:  # noqa: BLE001
        logger.exception("知识单元 %s 解析失败", document_id)
        document.status = "failed"
        document.chunk_count = 0
        document.error_message = str(exc)[:1000]

    await db.flush()
    return document


async def ingest_in_background(document_id: int, data: bytes, filename: str) -> None:
    """独立会话执行，供 FastAPI BackgroundTasks 调用。"""
    async with SessionLocal() as session:
        try:
            await ingest_document(session, document_id, data, filename)
            await session.commit()
        except Exception:  # noqa: BLE001
            await session.rollback()
            logger.exception("后台入库任务失败 document_id=%s", document_id)


async def reindex_document(db: AsyncSession, document: KnowledgeDocument) -> KnowledgeDocument:
    """对已存在文档重新切片与向量化（例如 EMBEDDING_DIM 变更后）。"""
    if not document.stored_path:
        raise ValueError("该知识单元没有原始文件，无法重建索引")
    path = Path(document.stored_path)
    if not path.exists():
        raise ValueError(f"原始文件已丢失：{path}")
    return await ingest_document(db, document.id, path.read_bytes(), path.name)
