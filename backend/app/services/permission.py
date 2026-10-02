"""四维混合数据权限鉴权引擎。

规则（严格按 ROG.txt 2.9.4）：
- 知识单元默认无任何公开访问权限；
- 每个知识单元可独立配置 global / department / role / user 四类权限实体；
- 判定为充分条件（OR）：命中任意一个权限实体即可读；
- 超级管理员与「拥有 knowledge:manage 权限」的知识管理员可读全部（用于维护），
  但在 AI 问答链路上仍严格按四维规则过滤，避免越权泄漏。
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import KnowledgeGrant, User

logger = logging.getLogger(__name__)

SCOPE_GLOBAL = "global"
SCOPE_DEPARTMENT = "department"
SCOPE_ROLE = "role"
SCOPE_USER = "user"

SCOPE_LABELS = {
    SCOPE_GLOBAL: "全局公开",
    SCOPE_DEPARTMENT: "部门共享",
    SCOPE_ROLE: "角色可见",
    SCOPE_USER: "个人专属",
}


@dataclass
class UserContext:
    """当前会话用户身份：用户 ID、直属部门、所属角色集合。"""

    user_id: int
    username: str
    department_id: int | None
    role_ids: set[int] = field(default_factory=set)
    permission_codes: set[str] = field(default_factory=set)
    is_superuser: bool = False

    @property
    def is_knowledge_admin(self) -> bool:
        return self.is_superuser or "knowledge:manage" in self.permission_codes

    @property
    def is_system_admin(self) -> bool:
        return self.is_superuser or "system:manage" in self.permission_codes


@dataclass
class AuthFilterResult:
    allowed_document_ids: set[int]
    blocked_document_ids: set[int]
    allowed_chunk_ids: set[int]
    blocked_chunk_ids: set[int]

    @property
    def has_blocked(self) -> bool:
        return bool(self.blocked_chunk_ids)


def build_grant_condition(ctx: UserContext):
    """构造「OR 逻辑」的 SQL 条件：满足任一权限实体即放行。"""
    clauses = [and_(KnowledgeGrant.scope == SCOPE_GLOBAL)]
    if ctx.department_id is not None:
        clauses.append(
            and_(
                KnowledgeGrant.scope == SCOPE_DEPARTMENT,
                KnowledgeGrant.subject_id == ctx.department_id,
            )
        )
    if ctx.role_ids:
        clauses.append(
            and_(KnowledgeGrant.scope == SCOPE_ROLE, KnowledgeGrant.subject_id.in_(ctx.role_ids))
        )
    clauses.append(and_(KnowledgeGrant.scope == SCOPE_USER, KnowledgeGrant.subject_id == ctx.user_id))
    return or_(*clauses)


async def allowed_document_ids(db: AsyncSession, ctx: UserContext) -> set[int]:
    """返回当前用户有权访问的知识单元 ID 集合。"""
    stmt = select(KnowledgeGrant.document_id).where(build_grant_condition(ctx)).distinct()
    rows = await db.execute(stmt)
    return {r[0] for r in rows.all()}


async def filter_documents(
    db: AsyncSession, ctx: UserContext, document_ids: list[int]
) -> tuple[set[int], set[int]]:
    """把候选知识单元分成（放行, 受限）两组。"""
    if not document_ids:
        return set(), set()
    allowed = await allowed_document_ids(db, ctx)
    candidates = set(document_ids)
    passed = candidates & allowed
    blocked = candidates - passed
    return passed, blocked


async def is_document_allowed(db: AsyncSession, ctx: UserContext, document_id: int) -> bool:
    allowed = await allowed_document_ids(db, ctx)
    return document_id in allowed


def describe_grants(grants: list[KnowledgeGrant], name_map: dict[tuple[str, int], str]) -> str:
    """生成权限标签文案，用于台账列表展示。"""
    if not grants:
        return "无任何权限（仅管理员可见）"
    parts: list[str] = []
    for scope in (SCOPE_GLOBAL, SCOPE_DEPARTMENT, SCOPE_ROLE, SCOPE_USER):
        subjects = [g for g in grants if g.scope == scope]
        if not subjects:
            continue
        if scope == SCOPE_GLOBAL:
            parts.append(SCOPE_LABELS[scope])
            continue
        names = [name_map.get((scope, g.subject_id), f"#{g.subject_id}") for g in subjects]
        parts.append(f"{SCOPE_LABELS[scope]}({'、'.join(names[:3])}{'…' if len(names) > 3 else ''})")
    return " + ".join(parts)


async def load_user_context(db: AsyncSession, user: User) -> UserContext:
    """从 ORM 用户对象加载完整鉴权上下文。"""
    from app.models import Permission, RolePermission, UserRole

    role_rows = await db.execute(select(UserRole.role_id).where(UserRole.user_id == user.id))
    role_ids = {r[0] for r in role_rows.all()}

    perm_codes: set[str] = set()
    if user.is_superuser:
        perm_rows = await db.execute(select(Permission.code))
        perm_codes = {r[0] for r in perm_rows.all()}
    elif role_ids:
        perm_rows = await db.execute(
            select(Permission.code)
            .join(RolePermission, RolePermission.permission_id == Permission.id)
            .where(RolePermission.role_id.in_(role_ids))
            .distinct()
        )
        perm_codes = {r[0] for r in perm_rows.all()}

    return UserContext(
        user_id=user.id,
        username=user.username,
        department_id=user.department_id,
        role_ids=role_ids,
        permission_codes=perm_codes,
        is_superuser=user.is_superuser,
    )
