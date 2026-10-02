"""FastAPI 依赖：当前用户、功能权限校验。"""
from __future__ import annotations

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.core.security import decode_access_token
from app.models import User
from app.services.permission import UserContext, load_user_context

_UNAUTHORIZED = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="登录态已失效，请重新登录",
    headers={"WWW-Authenticate": "Bearer"},
)


def _extract_token(request: Request) -> str | None:
    header = request.headers.get("Authorization") or ""
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return request.cookies.get("access_token")


async def get_current_user(
    request: Request, db: AsyncSession = Depends(get_db)
) -> User:
    token = _extract_token(request)
    if not token:
        raise _UNAUTHORIZED
    payload = decode_access_token(token)
    if not payload or not payload.get("sub"):
        raise _UNAUTHORIZED
    try:
        user_id = int(payload["sub"])
    except (TypeError, ValueError):
        raise _UNAUTHORIZED from None

    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None or not user.enabled:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="账号不存在或已被禁用")
    return user


async def get_user_context(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> UserContext:
    return await load_user_context(db, user)


def require_permission(*codes: str, any_of: bool = False):
    """按钮/菜单级功能权限校验依赖。

    any_of=False：必须具备全部 codes；
    any_of=True ：具备任意一个即可。
    """

    async def _checker(ctx: UserContext = Depends(get_user_context)) -> UserContext:
        if ctx.is_superuser:
            return ctx
        granted = ctx.permission_codes
        matched = [c for c in codes if c in granted]
        if (any_of and not matched) or (not any_of and len(matched) != len(codes)):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"缺少操作权限：{' / '.join(codes)}",
            )
        return ctx

    return _checker
