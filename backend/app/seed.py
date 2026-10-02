"""初始化基础数据（幂等）：权限目录、部门、角色、账号与示例知识单元。

每次容器启动都会执行；已存在的记录不会重复创建，
因此可以安全地反复 `docker compose up`。
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from sqlalchemy import select

from app.core.config import settings
from app.core.db import SessionLocal, engine
from app.core.security import hash_password
from app.models import (
    Department,
    DocumentChunk,
    KnowledgeDocument,
    KnowledgeGrant,
    Permission,
    Role,
    RolePermission,
    User,
    UserRole,
)
from app.services.document import chunk_text, clean_text, parse_document
from app.services.embeddings import embed_texts
from app.services.ingest import generate_code
from app.services.llm import estimate_tokens

logging.basicConfig(level=logging.INFO, format="%(levelname)-7s [seed] %(message)s")
logger = logging.getLogger("seed")

SEED_DIR = Path(__file__).resolve().parent.parent / "seed_data"

# ---------------------------------------------------------------------
# 功能权限目录（菜单级 + 按钮操作级）
# ---------------------------------------------------------------------
PERMISSIONS: list[dict] = [
    {"code": "menu:dashboard", "name": "运营看板", "kind": "menu", "parent_code": None},
    {"code": "dashboard:view", "name": "查看数据大盘", "kind": "operation", "parent_code": "menu:dashboard"},
    {"code": "menu:chat", "name": "AI 问答工作台", "kind": "menu", "parent_code": None},
    {"code": "ai:chat", "name": "AI 访问", "kind": "operation", "parent_code": "menu:chat"},
    {"code": "menu:knowledge", "name": "知识维护与导入", "kind": "menu", "parent_code": None},
    {"code": "knowledge:view", "name": "查看知识台账", "kind": "operation", "parent_code": "menu:knowledge"},
    {"code": "knowledge:upload", "name": "文档上传/批量导入", "kind": "operation", "parent_code": "menu:knowledge"},
    {"code": "knowledge:manage", "name": "知识单元增删改", "kind": "operation", "parent_code": "menu:knowledge"},
    {"code": "knowledge:grant", "name": "四维数据权限分配", "kind": "operation", "parent_code": "menu:knowledge"},
    {"code": "menu:sedimentation", "name": "知识沉淀与运营", "kind": "menu", "parent_code": None},
    {"code": "faq:manage", "name": "FAQ 审核发布", "kind": "operation", "parent_code": "menu:sedimentation"},
    {"code": "gap:manage", "name": "知识缺口转建任务", "kind": "operation", "parent_code": "menu:sedimentation"},
    {"code": "menu:system", "name": "组织与系统配置", "kind": "menu", "parent_code": None},
    {"code": "system:manage", "name": "组织/角色/账号维护", "kind": "operation", "parent_code": "menu:system"},
]

ROLES: list[dict] = [
    {
        "code": "super_admin",
        "name": "超级管理员",
        "description": "拥有全部功能权限与全部数据权限",
        "is_builtin": True,
        "permissions": [p["code"] for p in PERMISSIONS],
    },
    {
        "code": "knowledge_admin",
        "name": "知识管理员",
        "description": "负责文档导入、切片调整、权限配置与 FAQ 审核",
        "is_builtin": True,
        "permissions": [
            "menu:knowledge",
            "knowledge:view",
            "knowledge:upload",
            "knowledge:manage",
            "knowledge:grant",
            "menu:sedimentation",
            "faq:manage",
            "gap:manage",
            "menu:dashboard",
            "dashboard:view",
            "menu:chat",
            "ai:chat",
        ],
    },
    {
        "code": "normal_user",
        "name": "普通用户",
        "description": "仅可使用 AI 问答工作台提问",
        "is_builtin": True,
        "permissions": ["menu:chat", "ai:chat"],
    },
    {
        "code": "management",
        "name": "管理层",
        "description": "可查看运营看板，并拥有管理层级数据权限",
        "is_builtin": True,
        "permissions": ["menu:chat", "ai:chat", "menu:dashboard", "dashboard:view"],
    },
]

DEPARTMENTS: list[dict] = [
    {"code": "HQ", "name": "总部", "parent": None, "sort_order": 0},
    {"code": "FIN", "name": "财务部", "parent": "HQ", "sort_order": 10},
    {"code": "HR", "name": "人力资源部", "parent": "HQ", "sort_order": 20},
    {"code": "CS", "name": "客户服务中心", "parent": "HQ", "sort_order": 30},
    {"code": "IT", "name": "信息技术部", "parent": "HQ", "sort_order": 40},
]

USERS: list[dict] = [
    {
        "username": "admin",
        "display_name": "系统管理员",
        "dept": "IT",
        "roles": ["super_admin"],
        "superuser": True,
        "password": None,  # 取 BOOTSTRAP_ADMIN_PASSWORD
    },
    {
        "username": "kadmin",
        "display_name": "知识管理员",
        "dept": "IT",
        "roles": ["knowledge_admin"],
        "superuser": False,
        "password": "kadmin123456",
    },
    {
        "username": "finance01",
        "display_name": "财务专员·小李",
        "dept": "FIN",
        "roles": ["normal_user"],
        "superuser": False,
        "password": "demo123456",
    },
    {
        "username": "hr01",
        "display_name": "人力资源专员·小王",
        "dept": "HR",
        "roles": ["normal_user"],
        "superuser": False,
        "password": "demo123456",
    },
    {
        "username": "cs01",
        "display_name": "客服专员·小张",
        "dept": "CS",
        "roles": ["normal_user"],
        "superuser": False,
        "password": "demo123456",
    },
    {
        "username": "sales01",
        "display_name": "业务人员·小赵",
        "dept": "CS",
        "roles": ["normal_user"],
        "superuser": False,
        "password": "demo123456",
    },
    {
        "username": "manager01",
        "display_name": "管理层·刘总",
        "dept": "HQ",
        "roles": ["management"],
        "superuser": False,
        "password": "demo123456",
    },
]

# ---------------------------------------------------------------------
# 示例知识单元：文件 → 四维权限配置
# ---------------------------------------------------------------------
SEED_DOCS: list[dict] = [
    {
        "file": "差旅报销标准.md",
        "title": "差旅报销标准",
        "category": "财务制度",
        "grants": [("global", 0)],
    },
    {
        "file": "员工入职与考勤制度.md",
        "title": "员工入职与考勤管理制度",
        "category": "人事制度",
        "grants": [("global", 0)],
    },
    {
        "file": "生鲜售后与退换货规范.md",
        "title": "生鲜商品售后与退换货处理规范",
        "category": "客服规范",
        "grants": [("role", "role:management"), ("role", "role:knowledge_admin")],
    },
    {
        "file": "财务付款与费用审批授权表.md",
        "title": "财务付款与费用审批授权表",
        "category": "财务制度",
        "grants": [("department", "dept:FIN"), ("role", "role:management")],
    },
    {
        "file": "高管薪酬与股权激励细则.md",
        "title": "高管薪酬与股权激励细则",
        "category": "机密文件",
        "grants": [("department", "dept:HR"), ("role", "role:management")],
    },
]


async def ensure_permissions(session) -> dict[str, int]:
    existing = {row.code for row in (await session.execute(select(Permission))).scalars().all()}
    for index, item in enumerate(PERMISSIONS):
        if item["code"] in existing:
            continue
        session.add(
            Permission(
                code=item["code"],
                name=item["name"],
                kind=item["kind"],
                parent_code=item["parent_code"],
                sort_order=index * 10,
            )
        )
    await session.flush()
    rows = (await session.execute(select(Permission))).scalars().all()
    return {r.code: r.id for r in rows}


async def ensure_roles(session, perm_ids: dict[str, int]) -> dict[str, int]:
    existing = {r.code: r for r in (await session.execute(select(Role))).scalars().all()}
    for item in ROLES:
        role = existing.get(item["code"])
        if role is None:
            role = Role(
                code=item["code"],
                name=item["name"],
                description=item["description"],
                is_builtin=item["is_builtin"],
            )
            session.add(role)
            await session.flush()
            existing[item["code"]] = role
    await session.flush()

    for item in ROLES:
        role = existing[item["code"]]
        current = set(
            (
                await session.execute(
                    select(Permission.code)
                    .join(RolePermission, RolePermission.permission_id == Permission.id)
                    .where(RolePermission.role_id == role.id)
                )
            ).scalars().all()
        )
        for code in item["permissions"]:
            if code in current or code not in perm_ids:
                continue
            session.add(RolePermission(role_id=role.id, permission_id=perm_ids[code]))
    await session.flush()
    return {code: role.id for code, role in existing.items()}


async def ensure_departments(session) -> dict[str, int]:
    existing = {d.code: d for d in (await session.execute(select(Department))).scalars().all()}
    for item in DEPARTMENTS:
        if item["code"] in existing:
            continue
        parent_id = None
        if item["parent"]:
            parent = existing.get(item["parent"])
            parent_id = parent.id if parent else None
        dept = Department(
            code=item["code"],
            name=item["name"],
            parent_id=parent_id,
            sort_order=item["sort_order"],
        )
        session.add(dept)
        await session.flush()
        existing[item["code"]] = dept
    await session.flush()
    return {code: d.id for code, d in existing.items()}


async def ensure_users(session, dept_ids: dict[str, int], role_ids: dict[str, int]) -> None:
    existing = {u.username for u in (await session.execute(select(User))).scalars().all()}
    created: list[str] = []
    for item in USERS:
        if item["username"] in existing:
            continue
        password = item["password"] or settings.BOOTSTRAP_ADMIN_PASSWORD
        user = User(
            username=item["username"],
            display_name=item["display_name"],
            department_id=dept_ids.get(item["dept"]),
            password_hash=hash_password(password),
            is_superuser=item["superuser"],
            enabled=True,
        )
        session.add(user)
        await session.flush()
        for role_code in item["roles"]:
            if role_code in role_ids:
                session.add(UserRole(user_id=user.id, role_id=role_ids[role_code]))
        created.append(f"{item['username']}/{password}")
    await session.flush()
    if created:
        logger.info("已创建账号：%s", "、".join(created))


async def ensure_documents(session, dept_ids: dict[str, int], role_ids: dict[str, int]) -> None:
    existing = {
        d.title for d in (await session.execute(select(KnowledgeDocument))).scalars().all()
    }
    admin_id = (
        await session.execute(select(User.id).where(User.username == "admin"))
    ).scalar_one_or_none()

    for item in SEED_DOCS:
        if item["title"] in existing:
            continue
        path = SEED_DIR / item["file"]
        if not path.exists():
            logger.warning("示例文件缺失：%s", path)
            continue

        data = path.read_bytes()
        parsed = parse_document(path.name, data)
        cleaned = clean_text(parsed.text, "md")
        pieces = chunk_text(cleaned)
        vectors = embed_texts([p["content"] for p in pieces])

        document = KnowledgeDocument(
            code=generate_code(),
            title=item["title"],
            file_type="md",
            category=item["category"],
            source_type="seed",
            stored_path=str(path),
            file_size=len(data),
            status="ready",
            enabled=True,
            chunk_count=len(pieces),
            char_count=len(cleaned),
            created_by=admin_id,
            tags=[item["category"]],
        )
        session.add(document)
        await session.flush()

        for ordinal, (piece, vector) in enumerate(zip(pieces, vectors, strict=True)):
            session.add(
                DocumentChunk(
                    document_id=document.id,
                    ordinal=ordinal,
                    content=piece["content"],
                    char_count=piece["char_count"],
                    token_estimate=estimate_tokens(piece["content"]),
                    embedding=vector,
                    meta={"heading": piece.get("heading", ""), "file_type": "md"},
                )
            )

        for scope, target in item["grants"]:
            if scope == "global":
                subject_id = 0
            elif scope == "department":
                subject_id = dept_ids.get(str(target).replace("dept:", ""), 0)
                if not subject_id:
                    continue
            elif scope == "role":
                subject_id = role_ids.get(str(target).replace("role:", ""), 0)
                if not subject_id:
                    continue
            else:
                continue
            session.add(
                KnowledgeGrant(document_id=document.id, scope=scope, subject_id=subject_id)
            )

        logger.info("已导入示例知识单元《%s》，切片 %s 个", item["title"], len(pieces))

    await session.flush()


async def main() -> None:
    logger.info("开始初始化基础数据 ...")
    async with SessionLocal() as session:
        try:
            perm_ids = await ensure_permissions(session)
            role_ids = await ensure_roles(session, perm_ids)
            dept_ids = await ensure_departments(session)
            await ensure_users(session, dept_ids, role_ids)
            await ensure_documents(session, dept_ids, role_ids)
            await session.commit()
            logger.info("基础数据初始化完成")
        except Exception:
            await session.rollback()
            logger.exception("基础数据初始化失败")
            raise
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
