"""组织架构、角色功能权限与用户账号管理（系统管理员）。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_user_context, require_permission
from app.core.db import get_db
from app.core.security import hash_password
from app.models import (
    Department,
    Permission,
    Role,
    RolePermission,
    User,
    UserRole,
)
from app.schemas import (
    DepartmentBrief,
    DepartmentCreate,
    DepartmentNode,
    DepartmentUpdate,
    PermissionNode,
    RoleBrief,
    RoleCreate,
    RoleDetail,
    RoleUpdate,
    UserCreate,
    UserRow,
    UserUpdate,
    ok,
)

router = APIRouter(tags=["组织与权限"])

require_system = require_permission("system:manage")


# ---------------------------------------------------------------------
# 部门树
# ---------------------------------------------------------------------
def _build_tree(rows: list[dict], parent_id: int | None) -> list[DepartmentNode]:
    nodes: list[DepartmentNode] = []
    for row in rows:
        if row["parent_id"] != parent_id:
            continue
        node = DepartmentNode(
            id=row["id"],
            name=row["name"],
            code=row["code"],
            parent_id=row["parent_id"],
            sort_order=row["sort_order"],
            enabled=row["enabled"],
            user_count=row["user_count"],
            children=_build_tree(rows, row["id"]),
        )
        nodes.append(node)
    return nodes


@router.get("/departments/tree", response_model=dict)
async def department_tree(
    db: AsyncSession = Depends(get_db),
    ctx=Depends(get_user_context),
):
    """部门树：所有登录用户可读（用于权限选择器）。"""
    dept_rows = (
        await db.execute(select(Department).order_by(Department.sort_order, Department.id))
    ).scalars().all()
    counts = dict(
        (
            await db.execute(
                select(User.department_id, func.count(User.id)).group_by(User.department_id)
            )
        ).all()
    )
    rows = [
        {
            "id": d.id,
            "name": d.name,
            "code": d.code,
            "parent_id": d.parent_id,
            "sort_order": d.sort_order,
            "enabled": d.enabled,
            "user_count": int(counts.get(d.id, 0)),
        }
        for d in dept_rows
    ]
    return ok([node.model_dump() for node in _build_tree(rows, None)])


@router.post("/departments", response_model=dict)
async def create_department(
    payload: DepartmentCreate,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_system),
):
    exists = (
        await db.execute(select(Department).where(Department.code == payload.code))
    ).scalar_one_or_none()
    if exists is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, detail=f"部门编码 {payload.code} 已存在")
    dept = Department(**payload.model_dump())
    db.add(dept)
    await db.flush()
    return ok({"id": dept.id, "name": dept.name})


@router.put("/departments/{dept_id}", response_model=dict)
async def update_department(
    dept_id: int,
    payload: DepartmentUpdate,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_system),
):
    dept = (await db.execute(select(Department).where(Department.id == dept_id))).scalar_one_or_none()
    if dept is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="部门不存在")

    data = payload.model_dump(exclude_unset=True)
    if data.get("parent_id") == dept_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="上级部门不能是自己")
    if "code" in data and data["code"] != dept.code:
        dup = (
            await db.execute(select(Department).where(Department.code == data["code"]))
        ).scalar_one_or_none()
        if dup is not None:
            raise HTTPException(status.HTTP_409_CONFLICT, detail="部门编码已存在")
    for key, value in data.items():
        setattr(dept, key, value)
    await db.flush()
    return ok({"id": dept.id})


@router.delete("/departments/{dept_id}", response_model=dict)
async def delete_department(
    dept_id: int,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_system),
):
    dept = (await db.execute(select(Department).where(Department.id == dept_id))).scalar_one_or_none()
    if dept is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="部门不存在")

    child = (
        await db.execute(select(func.count(Department.id)).where(Department.parent_id == dept_id))
    ).scalar_one()
    if child:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="请先删除或迁移下级部门")

    used = (
        await db.execute(select(func.count(User.id)).where(User.department_id == dept_id))
    ).scalar_one()
    if used:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=f"该部门下还有 {used} 个用户，无法删除")

    await db.delete(dept)
    await db.flush()
    return ok({"id": dept_id})


# ---------------------------------------------------------------------
# 功能权限点
# ---------------------------------------------------------------------
@router.get("/permissions/tree", response_model=dict)
async def permission_tree(db: AsyncSession = Depends(get_db), _=Depends(require_system)):
    rows = (
        await db.execute(select(Permission).order_by(Permission.sort_order, Permission.id))
    ).scalars().all()

    def build(parent_code: str | None) -> list[PermissionNode]:
        nodes: list[PermissionNode] = []
        for p in rows:
            if p.parent_code != parent_code:
                continue
            nodes.append(
                PermissionNode(
                    code=p.code,
                    name=p.name,
                    kind=p.kind,
                    parent_code=p.parent_code,
                    children=build(p.code),
                )
            )
        return nodes

    return ok([n.model_dump() for n in build(None)])


@router.get("/permissions/flat", response_model=dict)
async def permission_flat(db: AsyncSession = Depends(get_db), _=Depends(require_system)):
    rows = (
        await db.execute(select(Permission).order_by(Permission.sort_order, Permission.id))
    ).scalars().all()
    return ok(
        [
            {"code": p.code, "name": p.name, "kind": p.kind, "parent_code": p.parent_code}
            for p in rows
        ]
    )


# ---------------------------------------------------------------------
# 角色
# ---------------------------------------------------------------------
@router.get("/roles", response_model=dict)
async def list_roles(db: AsyncSession = Depends(get_db), _=Depends(require_system)):
    roles = (await db.execute(select(Role).order_by(Role.id))).scalars().all()
    perm_rows = (
        await db.execute(
            select(RolePermission.role_id, Permission.code).join(
                Permission, Permission.id == RolePermission.permission_id
            )
        )
    ).all()
    by_role: dict[int, list[str]] = {}
    for role_id, code in perm_rows:
        by_role.setdefault(role_id, []).append(code)

    return ok(
        [
            RoleDetail(
                id=r.id,
                name=r.name,
                code=r.code,
                description=r.description,
                enabled=r.enabled,
                is_builtin=r.is_builtin,
                permission_codes=sorted(by_role.get(r.id, [])),
            ).model_dump()
            for r in roles
        ]
    )


async def _sync_role_permissions(db: AsyncSession, role_id: int, codes: list[str]) -> None:
    await db.execute(RolePermission.__table__.delete().where(RolePermission.role_id == role_id))
    if not codes:
        return
    perm_ids = (
        await db.execute(select(Permission.id).where(Permission.code.in_(codes)))
    ).scalars().all()
    for perm_id in perm_ids:
        db.add(RolePermission(role_id=role_id, permission_id=perm_id))
    await db.flush()


@router.post("/roles", response_model=dict)
async def create_role(
    payload: RoleCreate, db: AsyncSession = Depends(get_db), _=Depends(require_system)
):
    dup = (await db.execute(select(Role).where(Role.code == payload.code))).scalar_one_or_none()
    if dup is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, detail=f"角色编码 {payload.code} 已存在")
    role = Role(
        name=payload.name,
        code=payload.code,
        description=payload.description,
        enabled=payload.enabled,
    )
    db.add(role)
    await db.flush()
    await _sync_role_permissions(db, role.id, payload.permission_codes)
    return ok({"id": role.id})


@router.put("/roles/{role_id}", response_model=dict)
async def update_role(
    role_id: int,
    payload: RoleUpdate,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_system),
):
    role = (await db.execute(select(Role).where(Role.id == role_id))).scalar_one_or_none()
    if role is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="角色不存在")

    data = payload.model_dump(exclude_unset=True)
    codes = data.pop("permission_codes", None)
    for key, value in data.items():
        setattr(role, key, value)
    if codes is not None:
        await _sync_role_permissions(db, role_id, codes)
    await db.flush()
    return ok({"id": role.id})


@router.delete("/roles/{role_id}", response_model=dict)
async def delete_role(
    role_id: int, db: AsyncSession = Depends(get_db), _=Depends(require_system)
):
    role = (await db.execute(select(Role).where(Role.id == role_id))).scalar_one_or_none()
    if role is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="角色不存在")
    if role.is_builtin:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="内置角色不允许删除")

    bound = (
        await db.execute(select(func.count(UserRole.id)).where(UserRole.role_id == role_id))
    ).scalar_one()
    if bound:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=f"仍有 {bound} 个用户绑定该角色")
    await db.delete(role)
    await db.flush()
    return ok({"id": role_id})


# ---------------------------------------------------------------------
# 用户
# ---------------------------------------------------------------------
@router.get("/users", response_model=dict)
async def list_users(
    db: AsyncSession = Depends(get_db),
    _=Depends(require_system),
    keyword: str | None = Query(default=None),
    department_id: int | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=200),
):
    stmt = select(User)
    if keyword:
        like = f"%{keyword.strip()}%"
        stmt = stmt.where(User.username.ilike(like) | User.display_name.ilike(like))
    if department_id:
        stmt = stmt.where(User.department_id == department_id)

    total = (
        await db.execute(select(func.count()).select_from(stmt.subquery()))
    ).scalar_one()
    rows = (
        await db.execute(
            stmt.order_by(User.id).offset((page - 1) * page_size).limit(page_size)
        )
    ).scalars().all()

    dept_ids = {u.department_id for u in rows if u.department_id}
    depts: dict[int, DepartmentBrief] = {}
    if dept_ids:
        dept_rows = (
            await db.execute(select(Department).where(Department.id.in_(dept_ids)))
        ).scalars().all()
        depts = {d.id: DepartmentBrief(id=d.id, name=d.name, code=d.code) for d in dept_rows}

    user_ids = [u.id for u in rows]
    role_map: dict[int, list[RoleBrief]] = {}
    if user_ids:
        role_rows = (
            await db.execute(
                select(UserRole.user_id, Role.id, Role.name, Role.code)
                .join(Role, Role.id == UserRole.role_id)
                .where(UserRole.user_id.in_(user_ids))
            )
        ).all()
        for uid, rid, rname, rcode in role_rows:
            role_map.setdefault(uid, []).append(RoleBrief(id=rid, name=rname, code=rcode))

    items = [
        UserRow(
            id=u.id,
            username=u.username,
            display_name=u.display_name or u.username,
            email=u.email,
            department=depts.get(u.department_id) if u.department_id else None,
            roles=role_map.get(u.id, []),
            enabled=u.enabled,
            is_superuser=u.is_superuser,
            created_at=u.created_at.isoformat() if u.created_at else None,
        ).model_dump()
        for u in rows
    ]
    return ok({"items": items, "total": total, "page": page, "page_size": page_size})


async def _sync_user_roles(db: AsyncSession, user_id: int, role_ids: list[int]) -> None:
    await db.execute(UserRole.__table__.delete().where(UserRole.user_id == user_id))
    for role_id in set(role_ids):
        db.add(UserRole(user_id=user_id, role_id=role_id))
    await db.flush()


@router.post("/users", response_model=dict)
async def create_user(
    payload: UserCreate, db: AsyncSession = Depends(get_db), _=Depends(require_system)
):
    dup = (
        await db.execute(select(User).where(User.username == payload.username))
    ).scalar_one_or_none()
    if dup is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, detail=f"用户名 {payload.username} 已存在")

    user = User(
        username=payload.username,
        display_name=payload.display_name or payload.username,
        email=payload.email,
        department_id=payload.department_id,
        password_hash=hash_password(payload.password),
        enabled=payload.enabled,
    )
    db.add(user)
    await db.flush()
    await _sync_user_roles(db, user.id, payload.role_ids)
    return ok({"id": user.id})


@router.put("/users/{user_id}", response_model=dict)
async def update_user(
    user_id: int,
    payload: UserUpdate,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_system),
):
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="用户不存在")

    data = payload.model_dump(exclude_unset=True)
    role_ids = data.pop("role_ids", None)
    password = data.pop("password", None)
    if password:
        user.password_hash = hash_password(password)
    for key, value in data.items():
        setattr(user, key, value)
    if role_ids is not None:
        await _sync_user_roles(db, user_id, role_ids)
    await db.flush()
    return ok({"id": user.id})


@router.delete("/users/{user_id}", response_model=dict)
async def delete_user(
    user_id: int, db: AsyncSession = Depends(get_db), ctx=Depends(require_system)
):
    """物理删除账号（CASCADE 解除角色绑定）；如需保留审计痕迹请先停用。"""
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="用户不存在")
    if user.id == ctx.user_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="不能删除当前登录账号")
    if user.is_superuser:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="超级管理员账号不允许删除")
    await db.delete(user)
    await db.flush()
    return ok({"id": user_id, "message": "账号已删除"})
