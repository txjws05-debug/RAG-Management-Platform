"""add user theme preference

界面偏好需要跨设备保持一致，因此把主题选择持久化到用户档案。
前端仍会同时在 localStorage 缓存一份 —— 首帧渲染前拿不到接口数据，
必须靠本地值避免主题闪烁，服务端这份用于换设备 / 换浏览器后恢复。

Revision ID: 0002_user_theme_preference
Revises: 0001_init
Create Date: 2026-01-01
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002_user_theme_preference"
down_revision: str | None = "0001_init"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # server_default 保证已有行立即获得合法值，随后可安全保留该默认值
    op.add_column(
        "users",
        sa.Column(
            "theme_preference",
            sa.String(length=16),
            nullable=False,
            server_default="system",
        ),
    )
    # 只为合法取值建立约束，避免脏数据让前端的主题解析陷入未定义分支
    op.create_check_constraint(
        "ck_users_theme_preference",
        "users",
        "theme_preference IN ('system', 'light', 'dark')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_users_theme_preference", "users", type_="check")
    op.drop_column("users", "theme_preference")
