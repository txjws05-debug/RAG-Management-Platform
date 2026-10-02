"""HTTP 异常与请求校验的统一响应包装，保证前端只处理一种结构。"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.schemas import CODE_BAD_REQUEST, CODE_FORBIDDEN, CODE_INTERNAL, CODE_NOT_FOUND, CODE_UNAUTHORIZED

logger = logging.getLogger(__name__)

_STATUS_TO_CODE = {
    400: CODE_BAD_REQUEST,
    401: CODE_UNAUTHORIZED,
    403: CODE_FORBIDDEN,
    404: CODE_NOT_FOUND,
    409: 40900,
    422: CODE_BAD_REQUEST,
}


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(StarletteHTTPException)
    async def http_exception_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = _STATUS_TO_CODE.get(exc.status_code, CODE_INTERNAL)
        return JSONResponse(
            status_code=exc.status_code,
            content={"code": code, "message": str(exc.detail), "data": None},
            headers=getattr(exc, "headers", None),
        )

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        first: dict[str, Any] = (exc.errors() or [{}])[0]
        location = ".".join(str(x) for x in first.get("loc", []) if x != "body")
        message = f"参数校验失败：{location} {first.get('msg', '')}".strip()
        return JSONResponse(
            status_code=422, content={"code": CODE_BAD_REQUEST, "message": message, "data": None}
        )

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("未处理异常 %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=500,
            content={"code": CODE_INTERNAL, "message": f"服务内部错误：{exc}", "data": None},
        )
