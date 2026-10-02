"""登录认证与当前用户信息。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.db import get_db
from app.core.security import create_access_token, verify_password
from app.models import User
from app.schemas import (
    DepartmentBrief,
    LoginRequest,
    LoginResponse,
    RoleBrief,
    UserProfile,
    ok,
)
from app.services.permission import UserContext, load_user_context

router = APIRouter(tags=["认证"])


async def build_profile(db: AsyncSession, user: User) -> UserProfile:
    from app.models import Department, Role, UserRole

    department = None
    if user.department_id:
        dept = (
            await db.execute(select(Department).where(Department.id == user.department_id))
        ).scalar_one_or_none()
        if dept is not None:
            department = DepartmentBrief(id=dept.id, name=dept.name, code=dept.code)

    role_rows = (
        await db.execute(
            select(Role.id, Role.name, Role.code)
            .join(UserRole, UserRole.role_id == Role.id)
            .where(UserRole.user_id == user.id, Role.enabled.is_(True))
        )
    ).all()
    roles = [RoleBrief(id=r.id, name=r.name, code=r.code) for r in role_rows]

    ctx: UserContext = await load_user_context(db, user)
    return UserProfile(
        id=user.id,
        username=user.username,
        display_name=user.display_name or user.username,
        email=user.email,
        is_superuser=user.is_superuser,
        department=department,
        roles=roles,
        permissions=sorted(ctx.permission_codes),
    )


@router.post("/auth/login", response_model=dict)
async def login(payload: LoginRequest, response: Response, db: AsyncSession = Depends(get_db)):
    user = (
        await db.execute(select(User).where(User.username == payload.username))
    ).scalar_one_or_none()
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="用户名或密码错误")
    if not user.enabled:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="账号已被禁用")

    token, expires_in = create_access_token(user.id, {"username": user.username})
    # 同时写 HttpOnly Cookie，便于 Nginx 同源部署下的直接访问
    response.set_cookie(
        "access_token",
        token,
        httponly=True,
        samesite="lax",
        max_age=expires_in,
        path="/",
    )
    profile = await build_profile(db, user)
    return ok(LoginResponse(access_token=token, expires_in=expires_in, user=profile).model_dump())


@router.post("/auth/logout", response_model=dict)
async def logout(response: Response):
    response.delete_cookie("access_token", path="/")
    return ok({"message": "已退出登录"})


@router.get("/auth/me", response_model=dict)
async def me(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    return ok((await build_profile(db, user)).model_dump())
