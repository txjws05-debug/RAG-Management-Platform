"""大模型适配层：OpenAI 兼容 /chat/completions，支持流式；无 key 时走离线兜底。"""
from __future__ import annotations

import json
import logging
import re
from collections.abc import AsyncGenerator
from dataclasses import dataclass, field

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

_WORD_RE = re.compile(r"[A-Za-z0-9_]+")


def estimate_tokens(text: str) -> int:
    """粗略 token 估算：中文约 1 字 ≈ 1 token，英文按词 ≈ 1.3 token。"""
    if not text:
        return 0
    cjk = len(re.findall(r"[\u4e00-\u9fff]", text))
    words = len(_WORD_RE.findall(text))
    return cjk + int(words * 1.3) + 1


@dataclass
class StreamResult:
    """流式生成结束后回填的统计信息。"""

    content: str = ""
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    source: str = "llm"
    error: str | None = None
    extra: dict = field(default_factory=dict)


class LLMService:
    def __init__(self) -> None:
        self.base_url = settings.LLM_BASE_URL.rstrip("/")
        self.model = settings.LLM_CHAT_MODEL

    @property
    def enabled(self) -> bool:
        return settings.llm_enabled

    async def stream_chat(
        self,
        messages: list[dict[str, str]],
        result: StreamResult | None = None,
    ) -> AsyncGenerator[str, None]:
        """逐段产出文本增量；结束时把统计写入 result。"""
        result = result if result is not None else StreamResult()

        if not self.enabled:
            async for piece in self._offline_stream(messages, result):
                yield piece
            return

        headers = {
            "Authorization": f"Bearer {settings.LLM_API_KEY}",
            "Content-Type": "application/json",
        }
        payload: dict = {
            "model": self.model,
            "messages": messages,
            "temperature": settings.LLM_TEMPERATURE,
            "max_tokens": settings.LLM_MAX_TOKENS,
            "stream": True,
            "stream_options": {"include_usage": True},
        }

        try:
            async with httpx.AsyncClient(timeout=settings.LLM_TIMEOUT_SECONDS) as client:
                async with client.stream(
                    "POST", f"{self.base_url}/chat/completions", headers=headers, json=payload
                ) as resp:
                    if resp.status_code >= 400:
                        detail = (await resp.aread()).decode("utf-8", "ignore")[:300]
                        raise RuntimeError(f"模型服务返回 {resp.status_code}: {detail}")

                    async for line in resp.aiter_lines():
                        if not line or not line.startswith("data:"):
                            continue
                        chunk = line[5:].strip()
                        if chunk == "[DONE]":
                            break
                        try:
                            body = json.loads(chunk)
                        except json.JSONDecodeError:
                            continue

                        usage = body.get("usage")
                        if usage:
                            result.prompt_tokens = int(usage.get("prompt_tokens") or 0)
                            result.completion_tokens = int(usage.get("completion_tokens") or 0)
                            result.total_tokens = int(usage.get("total_tokens") or 0)

                        for choice in body.get("choices") or []:
                            delta = choice.get("delta") or {}
                            text = delta.get("content")
                            if text:
                                result.content += text
                                yield text

            result.source = "llm"
            if not result.total_tokens:
                result.prompt_tokens = estimate_tokens(
                    "\n".join(m.get("content", "") for m in messages)
                )
                result.completion_tokens = estimate_tokens(result.content)
                result.total_tokens = result.prompt_tokens + result.completion_tokens
            if not result.content.strip():
                result.error = "模型返回空内容"
                async for piece in self._offline_stream(messages, result, append=False):
                    yield piece

        except Exception as exc:  # noqa: BLE001
            logger.warning("LLM 调用失败，降级离线回答: %s", exc)
            result.error = str(exc)
            if not settings.LLM_OFFLINE_FALLBACK:
                raise
            async for piece in self._offline_stream(messages, result):
                yield piece

    async def _offline_stream(
        self,
        messages: list[dict[str, str]],
        result: StreamResult,
        append: bool = True,
    ) -> AsyncGenerator[str, None]:
        """离线兜底：用已鉴权通过的参考资料拼接严谨回答，并明确标注来源。"""
        if append and result.content:
            result.content = ""
        system = next((m.get("content", "") for m in messages if m.get("role") == "system"), "")
        user = next((m.get("content", "") for m in reversed(messages) if m.get("role") == "user"), "")

        materials = _extract_materials(user)
        question = _extract_question(user)

        if materials:
            text = (
                f"（离线模式回答，未配置大模型 API Key）\n\n"
                f"关于「{question}」，根据知识库中您有权访问的资料，整理如下：\n\n"
            )
            for idx, item in enumerate(materials, start=1):
                text += f"**{idx}. {item['title']}**\n{item['snippet']}\n\n"
            text += "以上结论均来自上述已授权知识单元，引用序号与文末溯源卡片一一对应。"
            if "权限受限" in system:
                pass
        else:
            text = (
                f"（离线模式回答，未配置大模型 API Key）\n\n"
                f"未能在您有权访问的知识库中找到与「{question}」直接相关的资料。\n\n"
                f"建议：确认该问题是否属于您所在部门/角色的授权范围，或联系知识管理员补充对应文档。"
            )

        result.source = "offline"
        result.content = text
        result.prompt_tokens = estimate_tokens("\n".join(m.get("content", "") for m in messages))
        result.completion_tokens = estimate_tokens(text)
        result.total_tokens = result.prompt_tokens + result.completion_tokens

        # 分片下发，模拟打字机效果
        step = 18
        for i in range(0, len(text), step):
            yield text[i : i + step]


def _extract_question(user_prompt: str) -> str:
    match = re.search(r"【用户问题】\s*(.+)", user_prompt)
    if match:
        return match.group(1).strip()[:200]
    return user_prompt.strip()[:200]


def _extract_materials(user_prompt: str) -> list[dict[str, str]]:
    """从 prompt 中解析出已注入的参考片段（离线兜底专用）。"""
    block = re.search(r"【参考资料】\s*(.*?)(?:【用户问题】|\Z)", user_prompt, re.S)
    if not block:
        return []
    items: list[dict[str, str]] = []
    for match in re.finditer(r"\[(\d+)\]\s*来源：(.+?)\n(.*?)(?=\n\[\d+\]|\Z)", block.group(1), re.S):
        snippet = match.group(3).strip()
        items.append(
            {
                "index": match.group(1),
                "title": match.group(2).strip(),
                "snippet": snippet[:400] + ("..." if len(snippet) > 400 else ""),
            }
        )
    return items


llm_service = LLMService()
