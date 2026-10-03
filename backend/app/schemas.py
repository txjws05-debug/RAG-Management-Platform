"""统一响应体：{code, message, data}。"""
from __future__ import annotations

from typing import Any, Generic, TypeVar

from pydantic import BaseModel, Field

T = TypeVar("T")

CODE_OK = 0
CODE_BAD_REQUEST = 40000
CODE_UNAUTHORIZED = 40100
CODE_FORBIDDEN = 40300
CODE_NOT_FOUND = 40400
CODE_CONFLICT = 40900
CODE_INTERNAL = 50000


class Envelope(BaseModel, Generic[T]):
    code: int = Field(default=CODE_OK, description="0 表示成功")
    message: str = Field(default="ok")
    data: T | None = None


def ok(data: Any = None, message: str = "ok") -> dict[str, Any]:
    return {"code": CODE_OK, "message": message, "data": data}


def fail(code: int, message: str, data: Any = None) -> dict[str, Any]:
    return {"code": code, "message": message, "data": data}


class PageMeta(BaseModel):
    total: int
    page: int
    page_size: int


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    page: int
    page_size: int


# =====================================================================
# 鉴权与组织
# =====================================================================
class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=128)


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    user: "UserProfile"


class DepartmentBrief(BaseModel):
    id: int
    name: str
    code: str


class RoleBrief(BaseModel):
    id: int
    name: str
    code: str


class UserProfile(BaseModel):
    id: int
    username: str
    display_name: str
    email: str | None = None
    is_superuser: bool = False
    department: DepartmentBrief | None = None
    roles: list[RoleBrief] = Field(default_factory=list)
    permissions: list[str] = Field(default_factory=list)
    # 界面主题偏好：system | light | dark（存服务端以跨设备保持一致）
    theme_preference: str = "system"


class ThemePreferenceUpdate(BaseModel):
    theme_preference: str = Field(pattern="^(system|light|dark)$")


class DepartmentNode(BaseModel):
    id: int
    name: str
    code: str
    parent_id: int | None = None
    sort_order: int = 0
    enabled: bool = True
    user_count: int = 0
    children: list["DepartmentNode"] = Field(default_factory=list)


class DepartmentCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    code: str = Field(min_length=1, max_length=64)
    parent_id: int | None = None
    sort_order: int = 0
    enabled: bool = True


class DepartmentUpdate(BaseModel):
    name: str | None = None
    code: str | None = None
    parent_id: int | None = None
    sort_order: int | None = None
    enabled: bool | None = None


class RoleCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    code: str = Field(min_length=1, max_length=64)
    description: str | None = None
    enabled: bool = True
    permission_codes: list[str] = Field(default_factory=list)


class RoleUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    enabled: bool | None = None
    permission_codes: list[str] | None = None


class RoleDetail(BaseModel):
    id: int
    name: str
    code: str
    description: str | None = None
    enabled: bool = True
    is_builtin: bool = False
    permission_codes: list[str] = Field(default_factory=list)


class PermissionNode(BaseModel):
    code: str
    name: str
    kind: str
    parent_code: str | None = None
    children: list["PermissionNode"] = Field(default_factory=list)


class UserCreate(BaseModel):
    username: str = Field(min_length=2, max_length=64)
    password: str = Field(min_length=6, max_length=128)
    display_name: str = ""
    email: str | None = None
    department_id: int | None = None
    role_ids: list[int] = Field(default_factory=list)
    enabled: bool = True


class UserUpdate(BaseModel):
    password: str | None = Field(default=None, min_length=6, max_length=128)
    display_name: str | None = None
    email: str | None = None
    department_id: int | None = None
    role_ids: list[int] | None = None
    enabled: bool | None = None


class UserRow(BaseModel):
    id: int
    username: str
    display_name: str
    email: str | None = None
    department: DepartmentBrief | None = None
    roles: list[RoleBrief] = Field(default_factory=list)
    enabled: bool = True
    is_superuser: bool = False
    theme_preference: str = "system"
    created_at: str | None = None


# =====================================================================
# 知识单元
# =====================================================================
class GrantItem(BaseModel):
    scope: str = Field(pattern="^(global|department|role|user)$")
    subject_id: int = 0


class GrantView(BaseModel):
    scope: str
    subject_id: int
    subject_name: str = ""


class GrantConfig(BaseModel):
    global_public: bool = False
    department_ids: list[int] = Field(default_factory=list)
    role_ids: list[int] = Field(default_factory=list)
    user_ids: list[int] = Field(default_factory=list)


class DocumentRow(BaseModel):
    id: int
    code: str
    title: str
    file_type: str
    category: str
    status: str
    enabled: bool
    chunk_count: int
    char_count: int
    file_size: int
    error_message: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    grants: list[GrantView] = Field(default_factory=list)
    grant_summary: str = "无任何权限（仅管理员可见）"


class DocumentUpdate(BaseModel):
    title: str | None = None
    category: str | None = None
    enabled: bool | None = None


class ChunkRow(BaseModel):
    id: int
    ordinal: int
    content: str
    char_count: int


class UploadResult(BaseModel):
    id: int
    title: str
    file_type: str
    status: str
    chunk_count: int
    char_count: int
    message: str = ""


# =====================================================================
# 检索与问答
# =====================================================================
class RetrievedChunk(BaseModel):
    chunk_id: int
    document_id: int
    document_title: str
    ordinal: int
    score: float
    vector_score: float = 0.0
    keyword_score: float = 0.0
    allowed: bool = False
    content: str = ""


class Citation(BaseModel):
    index: int
    document_id: int
    document_title: str
    chunk_id: int
    ordinal: int
    score: float
    snippet: str


class ChatAskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    session_key: str | None = None
    top_k: int | None = None
    use_faq_cache: bool = True


class ChatAskResponse(BaseModel):
    session_key: str
    message_id: int | None = None
    answer: str
    citations: list[Citation] = Field(default_factory=list)
    restricted_notice: bool = False
    answer_source: str = "llm"
    top_score: float = 0.0
    latency_ms: int = 0
    total_tokens: int = 0


class ConversationRow(BaseModel):
    session_key: str
    title: str
    message_count: int
    updated_at: str | None = None


class MessageRow(BaseModel):
    id: int
    role: str
    content: str
    citations: list[Citation] = Field(default_factory=list)
    restricted_notice: bool = False
    restricted_message: str | None = None
    answer_source: str = "llm"
    latency_ms: int = 0
    total_tokens: int = 0
    top_score: float = 0.0
    created_at: str | None = None


# =====================================================================
# 运营看板
# =====================================================================
class TrendPoint(BaseModel):
    label: str
    value: float


class NamedCount(BaseModel):
    name: str
    value: float


class DashboardOverview(BaseModel):
    pv: int
    uv: int
    question_count: int
    document_count: int
    chunk_count: int
    ready_document_count: int
    faq_count: int
    faq_cache_hit_rate: float
    gap_count: int
    avg_latency_ms: float
    p95_latency_ms: float
    total_tokens: int
    knowledge_coverage: float
    # 检索置信度均值（归一化融合分）与当前生效的未命中判定门槛
    avg_retrieval_score: float = 0.0
    confidence_threshold: float = 0.14


class DashboardPayload(BaseModel):
    overview: DashboardOverview
    token_trend: list[TrendPoint]
    latency_distribution: list[TrendPoint]
    top_questions: list[NamedCount]
    top_documents: list[NamedCount]
    visit_trend: list[TrendPoint]
    department_question_rank: list[NamedCount]


# =====================================================================
# FAQ 与知识缺口
# =====================================================================
class FaqCandidateRow(BaseModel):
    id: int
    canonical_question: str
    sample_questions: list[str] = Field(default_factory=list)
    frequency: int
    suggested_answer: str | None = None
    confidence: float
    status: str
    related_documents: list[str] = Field(default_factory=list)
    created_at: str | None = None


class FaqReviewRequest(BaseModel):
    action: str = Field(pattern="^(approve|reject)$")
    answer: str | None = None
    category: str | None = None
    question: str | None = None


class FaqEntryRow(BaseModel):
    id: int
    question: str
    answer: str
    category: str
    enabled: bool
    cache_enabled: bool
    hit_count: int
    published_at: str | None = None


class FaqEntryUpdate(BaseModel):
    question: str | None = None
    answer: str | None = None
    category: str | None = None
    enabled: bool | None = None
    cache_enabled: bool | None = None


class GapRow(BaseModel):
    id: int
    question_text: str
    department_name: str | None = None
    frequency: int
    max_similarity: float
    suggested_category: str
    status: str
    last_seen_at: str | None = None
    task_note: str | None = None


class GapTaskRequest(BaseModel):
    note: str | None = None
    category: str | None = None


class MiningResult(BaseModel):
    scanned_questions: int
    clusters: int
    new_candidates: int
    updated_candidates: int
    new_gaps: int
    message: str = ""


# =====================================================================
# 配置
# =====================================================================
class ModelConfigView(BaseModel):
    llm_base_url: str
    llm_chat_model: str
    llm_temperature: float
    llm_max_tokens: int
    llm_key_configured: bool
    embedding_base_url: str
    embedding_model: str
    embedding_dim: int
    embedding_key_configured: bool
    embedding_mode: str
    retrieve_top_k: int
    confidence_threshold: float
    faq_cache_enabled: bool
    faq_min_frequency: int
    faq_cluster_similarity: float = 0.0
    faq_cache_match_threshold: float = 0.0
    chunk_size: int
    chunk_overlap: int


LoginResponse.model_rebuild()
DepartmentNode.model_rebuild()
PermissionNode.model_rebuild()
