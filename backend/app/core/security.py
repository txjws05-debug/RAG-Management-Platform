"""密码哈希、JWT 签发与解析。"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from jose import JWTError, jwt
from passlib.context import CryptContext

from app.core.config import settings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto", bcrypt__rounds=10)


def hash_password(raw: str) -> str:
    # bcrypt 上限 72 字节，超出直接截断，避免 passlib 抛错
    return pwd_context.hash(raw[:72])


def verify_password(raw: str, hashed: str) -> bool:
    try:
        return pwd_context.verify(raw[:72], hashed)
    except Exception:  # noqa: BLE001
        return False


def create_access_token(subject: str, extra: dict[str, Any] | None = None) -> tuple[str, int]:
    """返回 (token, 过期秒数)。"""
    expires_in = settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60
    expire = datetime.now(UTC) + timedelta(seconds=expires_in)
    payload: dict[str, Any] = {"sub": str(subject), "exp": expire, "iat": datetime.now(UTC)}
    if extra:
        payload.update(extra)
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM), expires_in


def decode_access_token(token: str) -> dict[str, Any] | None:
    try:
        return jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
    except JWTError:
        return None
