"""init schema with pgvector

Revision ID: 0001_init
Revises:
Create Date: 2025-01-01
"""
from __future__ import annotations

from collections.abc import Sequence

import pgvector.sqlalchemy
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001_init"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

DIM = 1024


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")

    # ---------------- 组织 ----------------
    op.create_table(
        "departments",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("code", sa.String(64), nullable=False, unique=True),
        sa.Column("parent_id", sa.Integer(), sa.ForeignKey("departments.id", ondelete="SET NULL")),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )

    op.create_table(
        "roles",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("code", sa.String(64), nullable=False, unique=True),
        sa.Column("description", sa.String(255)),
        sa.Column("is_builtin", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )

    op.create_table(
        "permissions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("code", sa.String(128), nullable=False, unique=True),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False, server_default="operation"),
        sa.Column("parent_code", sa.String(128)),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )

    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("username", sa.String(64), nullable=False, unique=True),
        sa.Column("display_name", sa.String(128), nullable=False, server_default=""),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("email", sa.String(160)),
        sa.Column("department_id", sa.Integer(), sa.ForeignKey("departments.id", ondelete="SET NULL")),
        sa.Column("is_superuser", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_users_username", "users", ["username"])

    op.create_table(
        "role_permissions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("role_id", sa.Integer(), sa.ForeignKey("roles.id", ondelete="CASCADE"), nullable=False),
        sa.Column("permission_id", sa.Integer(), sa.ForeignKey("permissions.id", ondelete="CASCADE"), nullable=False),
        sa.UniqueConstraint("role_id", "permission_id", name="uq_role_permission"),
    )

    op.create_table(
        "user_roles",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("role_id", sa.Integer(), sa.ForeignKey("roles.id", ondelete="CASCADE"), nullable=False),
        sa.UniqueConstraint("user_id", "role_id", name="uq_user_role"),
    )

    # ---------------- 知识单元 ----------------
    op.create_table(
        "knowledge_documents",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("code", sa.String(64), nullable=False, unique=True),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("file_type", sa.String(16), nullable=False),
        sa.Column("category", sa.String(64), nullable=False, server_default="未分类"),
        sa.Column("source_type", sa.String(16), nullable=False, server_default="upload"),
        sa.Column("stored_path", sa.String(512)),
        sa.Column("file_size", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("error_message", sa.Text()),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("chunk_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("char_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("tags", postgresql.JSONB(), server_default="[]"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )

    op.create_table(
        "document_chunks",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("document_id", sa.Integer(), sa.ForeignKey("knowledge_documents.id", ondelete="CASCADE"), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("char_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("token_estimate", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("embedding", pgvector.sqlalchemy.Vector(DIM)),
        sa.Column("meta", postgresql.JSONB(), server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("document_id", "ordinal", name="uq_chunk_doc_ordinal"),
    )
    op.create_index("ix_document_chunks_document_id", "document_chunks", ["document_id"])
    op.create_index("ix_chunk_document_ordinal", "document_chunks", ["document_id", "ordinal"])
    # 向量近似检索（余弦）
    op.execute(
        "CREATE INDEX ix_chunk_embedding_hnsw ON document_chunks "
        "USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)"
    )
    # 关键词检索：中文按 bigram 拆解后写入 tsvector 生成列
    op.execute(
        "ALTER TABLE document_chunks ADD COLUMN content_tsv tsvector "
        "GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED"
    )
    op.execute("CREATE INDEX ix_chunk_content_tsv ON document_chunks USING gin (content_tsv)")
    op.execute("CREATE INDEX ix_chunk_content_trgm ON document_chunks USING gin (content gin_trgm_ops)")

    op.create_table(
        "knowledge_grants",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("document_id", sa.Integer(), sa.ForeignKey("knowledge_documents.id", ondelete="CASCADE"), nullable=False),
        sa.Column("scope", sa.String(16), nullable=False),
        sa.Column("subject_id", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("document_id", "scope", "subject_id", name="uq_grant_doc_scope_subject"),
    )
    op.create_index("ix_knowledge_grants_document_id", "knowledge_grants", ["document_id"])
    op.create_index("ix_knowledge_grants_scope", "knowledge_grants", ["scope"])

    # ---------------- 问答与审计 ----------------
    op.create_table(
        "conversations",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("session_key", sa.String(64), nullable=False, unique=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("title", sa.String(255), nullable=False, server_default="新会话"),
        sa.Column("message_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_conversations_session_key", "conversations", ["session_key"])
    op.create_index("ix_conversations_user_id", "conversations", ["user_id"])

    op.create_table(
        "chat_messages",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("conversation_id", sa.BigInteger(), sa.ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("role", sa.String(16), nullable=False),
        sa.Column("question", sa.Text()),
        sa.Column("answer", sa.Text()),
        sa.Column("recalled_chunk_ids", postgresql.JSONB(), server_default="[]"),
        sa.Column("passed_chunk_ids", postgresql.JSONB(), server_default="[]"),
        sa.Column("blocked_document_ids", postgresql.JSONB(), server_default="[]"),
        sa.Column("citations", postgresql.JSONB(), server_default="[]"),
        sa.Column("top_score", sa.Float(), nullable=False, server_default="0"),
        sa.Column("latency_ms", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("prompt_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("completion_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("answer_source", sa.String(16), nullable=False, server_default="llm"),
        sa.Column("faq_hit_id", sa.BigInteger()),
        sa.Column("restricted_notice", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("restricted_message", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_chat_messages_conversation_id", "chat_messages", ["conversation_id"])
    op.create_index("ix_chat_messages_user_id", "chat_messages", ["user_id"])
    op.create_index("ix_chat_message_user_created", "chat_messages", ["user_id", "created_at"])
    op.create_index("ix_chat_message_created", "chat_messages", ["created_at"])

    # ---------------- FAQ 沉淀与知识缺口 ----------------
    op.create_table(
        "faq_candidates",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("cluster_key", sa.String(64), nullable=False, unique=True),
        sa.Column("canonical_question", sa.Text(), nullable=False),
        sa.Column("sample_questions", postgresql.JSONB(), server_default="[]"),
        sa.Column("frequency", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("suggested_answer", sa.Text()),
        sa.Column("related_document_ids", postgresql.JSONB(), server_default="[]"),
        sa.Column("confidence", sa.Float(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("reviewed_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("reviewed_at", sa.DateTime(timezone=True)),
        sa.Column("center_embedding", pgvector.sqlalchemy.Vector(DIM)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_faq_candidates_status", "faq_candidates", ["status"])

    op.create_table(
        "faq_entries",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("candidate_id", sa.BigInteger(), sa.ForeignKey("faq_candidates.id", ondelete="SET NULL")),
        sa.Column("question", sa.Text(), nullable=False),
        sa.Column("answer", sa.Text(), nullable=False),
        sa.Column("category", sa.String(64), nullable=False, server_default="通用"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("cache_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("hit_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("embedding", pgvector.sqlalchemy.Vector(DIM)),
        sa.Column("published_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("published_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )

    op.create_table(
        "knowledge_gaps",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("question_norm", sa.String(255), nullable=False, unique=True),
        sa.Column("question_text", sa.Text(), nullable=False),
        sa.Column("department_id", sa.Integer(), sa.ForeignKey("departments.id", ondelete="SET NULL")),
        sa.Column("frequency", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("max_similarity", sa.Float(), nullable=False, server_default="0"),
        sa.Column("suggested_category", sa.String(64), nullable=False, server_default="待分类"),
        sa.Column("status", sa.String(16), nullable=False, server_default="open"),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("task_note", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_knowledge_gaps_status", "knowledge_gaps", ["status"])


def downgrade() -> None:
    for table in (
        "knowledge_gaps",
        "faq_entries",
        "faq_candidates",
        "chat_messages",
        "conversations",
        "knowledge_grants",
        "document_chunks",
        "knowledge_documents",
        "user_roles",
        "role_permissions",
        "users",
        "permissions",
        "roles",
        "departments",
    ):
        op.drop_table(table)
    op.execute("DROP EXTENSION IF EXISTS vector")
