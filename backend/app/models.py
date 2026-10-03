"""SQLAlchemy 2.0 数据模型。

覆盖 ROG.txt 要求的全部实体：
组织（部门/用户/角色/菜单操作权限）、知识单元（文档/切片）、
四维数据权限、问答审计日志、FAQ 沉淀、知识缺口。
"""
from __future__ import annotations

from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from app.core.config import settings

EMBEDDING_DIM = settings.EMBEDDING_DIM


class Base(DeclarativeBase):
    pass


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


# =====================================================================
# 组织架构与权限
# =====================================================================
class Department(Base, TimestampMixin):
    """部门树形架构。parent_id 为空表示根部门。"""

    __tablename__ = "departments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    code: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("departments.id", ondelete="SET NULL"), nullable=True
    )
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    parent: Mapped[Department | None] = relationship(remote_side=[id], backref="children")
    users: Mapped[list[User]] = relationship(back_populates="department")


class Role(Base, TimestampMixin):
    """角色：既承载数据权限（四维中的 role），也承载功能权限。"""

    __tablename__ = "roles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    code: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    description: Mapped[str | None] = mapped_column(String(255))
    is_builtin: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    users: Mapped[list[User]] = relationship(secondary="user_roles", back_populates="roles")


class Permission(Base, TimestampMixin):
    """功能权限点：菜单级 + 按钮操作级（含 AI 访问）。"""

    __tablename__ = "permissions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    # menu | operation
    kind: Mapped[str] = mapped_column(String(16), default="operation", nullable=False)
    parent_code: Mapped[str | None] = mapped_column(String(128))
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class RolePermission(Base):
    __tablename__ = "role_permissions"
    __table_args__ = (UniqueConstraint("role_id", "permission_id", name="uq_role_permission"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    role_id: Mapped[int] = mapped_column(ForeignKey("roles.id", ondelete="CASCADE"))
    permission_id: Mapped[int] = mapped_column(ForeignKey("permissions.id", ondelete="CASCADE"))


class UserRole(Base):
    __tablename__ = "user_roles"
    __table_args__ = (UniqueConstraint("user_id", "role_id", name="uq_user_role"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    role_id: Mapped[int] = mapped_column(ForeignKey("roles.id", ondelete="CASCADE"))


class User(Base, TimestampMixin):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    display_name: Mapped[str] = mapped_column(String(128), default="", nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    email: Mapped[str | None] = mapped_column(String(160))
    department_id: Mapped[int | None] = mapped_column(
        ForeignKey("departments.id", ondelete="SET NULL"), nullable=True
    )
    is_superuser: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    # 界面主题偏好：system（跟随系统）| light | dark
    # 存服务端是为了跨设备/换浏览器保持一致；前端仍会在 localStorage 缓存一份，
    # 因为首帧渲染前拿不到接口数据，必须靠本地值避免主题闪烁。
    theme_preference: Mapped[str] = mapped_column(
        String(16), default="system", server_default="system", nullable=False
    )

    department: Mapped[Department | None] = relationship(back_populates="users")
    roles: Mapped[list[Role]] = relationship(secondary="user_roles", back_populates="users")


# =====================================================================
# 知识单元
# =====================================================================
class KnowledgeDocument(Base, TimestampMixin):
    """知识单元台账（一份上传文档 = 一个知识单元）。"""

    __tablename__ = "knowledge_documents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    # 文件格式：pdf / md / docx / txt
    file_type: Mapped[str] = mapped_column(String(16), nullable=False)
    category: Mapped[str] = mapped_column(String(64), default="未分类", nullable=False)
    source_type: Mapped[str] = mapped_column(String(16), default="upload", nullable=False)
    stored_path: Mapped[str | None] = mapped_column(String(512))
    file_size: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    # pending | parsing | ready | failed
    status: Mapped[str] = mapped_column(String(16), default="pending", nullable=False)
    error_message: Mapped[str | None] = mapped_column(Text)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    chunk_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    char_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    tags: Mapped[list | None] = mapped_column(JSONB, default=list)

    chunks: Mapped[list[DocumentChunk]] = relationship(
        back_populates="document", cascade="all, delete-orphan"
    )
    grants: Mapped[list[KnowledgeGrant]] = relationship(
        back_populates="document", cascade="all, delete-orphan"
    )


class DocumentChunk(Base, TimestampMixin):
    """切片：混合检索的基本单元。"""

    __tablename__ = "document_chunks"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    document_id: Mapped[int] = mapped_column(
        ForeignKey("knowledge_documents.id", ondelete="CASCADE"), index=True
    )
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    char_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    token_estimate: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    embedding: Mapped[list[float] | None] = mapped_column(Vector(EMBEDDING_DIM))
    # 关键词检索用的 jieba-free 倒排（PostgreSQL 简单分词 tsvector 由迁移生成列维护）
    meta: Mapped[dict | None] = mapped_column(JSONB, default=dict)

    document: Mapped[KnowledgeDocument] = relationship(back_populates="chunks")

    __table_args__ = (
        UniqueConstraint("document_id", "ordinal", name="uq_chunk_doc_ordinal"),
        Index("ix_chunk_document_ordinal", "document_id", "ordinal"),
    )


class KnowledgeGrant(Base, TimestampMixin):
    """四维混合数据权限实体（OR 逻辑）。

    scope = global  → subject_id 恒为 0，表示全员公开
    scope = department / role / user → subject_id 指向对应主体
    """

    __tablename__ = "knowledge_grants"
    __table_args__ = (
        UniqueConstraint("document_id", "scope", "subject_id", name="uq_grant_doc_scope_subject"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    document_id: Mapped[int] = mapped_column(
        ForeignKey("knowledge_documents.id", ondelete="CASCADE"), index=True
    )
    scope: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    subject_id: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)

    document: Mapped[KnowledgeDocument] = relationship(back_populates="grants")


# =====================================================================
# 问答与审计
# =====================================================================
class Conversation(Base, TimestampMixin):
    __tablename__ = "conversations"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    session_key: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    title: Mapped[str] = mapped_column(String(255), default="新会话", nullable=False)
    message_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    messages: Mapped[list[ChatMessage]] = relationship(
        back_populates="conversation", cascade="all, delete-orphan"
    )


class ChatMessage(Base, TimestampMixin):
    """单次问答审计记录（对应 2.9.8 单次问答审计记录）。"""

    __tablename__ = "chat_messages"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    conversation_id: Mapped[int] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(16), nullable=False)  # user | assistant

    question: Mapped[str | None] = mapped_column(Text)
    answer: Mapped[str | None] = mapped_column(Text)

    # 召回 / 鉴权结果明细
    recalled_chunk_ids: Mapped[list | None] = mapped_column(JSONB, default=list)
    passed_chunk_ids: Mapped[list | None] = mapped_column(JSONB, default=list)
    blocked_document_ids: Mapped[list | None] = mapped_column(JSONB, default=list)
    citations: Mapped[list | None] = mapped_column(JSONB, default=list)

    top_score: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    completion_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    total_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # llm | faq_cache | offline | blocked
    answer_source: Mapped[str] = mapped_column(String(16), default="llm", nullable=False)
    faq_hit_id: Mapped[int | None] = mapped_column(BigInteger)
    restricted_notice: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # 原文案留档，供历史会话回放展示与审计复核
    restricted_message: Mapped[str | None] = mapped_column(Text)

    conversation: Mapped[Conversation] = relationship(back_populates="messages")

    __table_args__ = (
        Index("ix_chat_message_user_created", "user_id", "created_at"),
        Index("ix_chat_message_created", "created_at"),
    )


# =====================================================================
# FAQ 沉淀与知识缺口
# =====================================================================
class FaqCandidate(Base, TimestampMixin):
    """由历史提问聚类产生的候选 FAQ（对应 2.9.8 FAQ 推荐候选卡片）。"""

    __tablename__ = "faq_candidates"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    cluster_key: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    canonical_question: Mapped[str] = mapped_column(Text, nullable=False)
    sample_questions: Mapped[list | None] = mapped_column(JSONB, default=list)
    frequency: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    suggested_answer: Mapped[str | None] = mapped_column(Text)
    related_document_ids: Mapped[list | None] = mapped_column(JSONB, default=list)
    confidence: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    # pending | approved | rejected
    status: Mapped[str] = mapped_column(String(16), default="pending", nullable=False, index=True)
    reviewed_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    center_embedding: Mapped[list[float] | None] = mapped_column(Vector(EMBEDDING_DIM))


class FaqEntry(Base, TimestampMixin):
    """审核通过并上线的高速应答缓存条目。"""

    __tablename__ = "faq_entries"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    candidate_id: Mapped[int | None] = mapped_column(
        ForeignKey("faq_candidates.id", ondelete="SET NULL")
    )
    question: Mapped[str] = mapped_column(Text, nullable=False)
    answer: Mapped[str] = mapped_column(Text, nullable=False)
    category: Mapped[str] = mapped_column(String(64), default="通用", nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    cache_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    hit_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    embedding: Mapped[list[float] | None] = mapped_column(Vector(EMBEDDING_DIM))
    published_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class KnowledgeGap(Base, TimestampMixin):
    """知识缺口诊断清单（对应 2.9.8 知识缺口诊断清单）。"""

    __tablename__ = "knowledge_gaps"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    question_norm: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    question_text: Mapped[str] = mapped_column(Text, nullable=False)
    department_id: Mapped[int | None] = mapped_column(
        ForeignKey("departments.id", ondelete="SET NULL")
    )
    frequency: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    max_similarity: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    suggested_category: Mapped[str] = mapped_column(String(64), default="待分类", nullable=False)
    # open | task_created | resolved
    status: Mapped[str] = mapped_column(String(16), default="open", nullable=False, index=True)
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    task_note: Mapped[str | None] = mapped_column(Text)
