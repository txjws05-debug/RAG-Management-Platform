"""向量化适配层：OpenAI 兼容 Embeddings + 内置离线哈希嵌入。

设计目标：
1. 有 key  → 走 EMBEDDING_BASE_URL 的 OpenAI 兼容 /embeddings 接口；
2. 无 key  → 使用本地确定性字符/词 n-gram 哈希嵌入（离线可跑通全流程演示）。
   对中文而言字符 bigram/trigram 是相当有效的相似度代理，
   足以支撑「权限隔离 + 检索 + 聚类 + 缺口识别」的端到端演示。
"""
from __future__ import annotations

import hashlib
import logging
import math
import re
from collections import Counter

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

_WORD_RE = re.compile(r"[A-Za-z0-9_]+")
_CJK_RE = re.compile(r"[\u4e00-\u9fff]")

_embedding_cache: dict[str, list[float]] = {}
_CACHE_LIMIT = 4096


# ---------------------------------------------------------------------
# 本地离线嵌入
# ---------------------------------------------------------------------
def _ngrams(text: str) -> Counter[str]:
    feats: Counter[str] = Counter()
    lowered = text.lower()

    # 英文/数字词
    words = _WORD_RE.findall(lowered)
    for w in words:
        feats[f"w1:{w}"] += 1.0
    for a, b in zip(words, words[1:]):
        feats[f"w2:{a}_{b}"] += 1.2

    # 中日韩字符 n-gram
    chars = [c for c in lowered if _CJK_RE.match(c)]
    for c in chars:
        feats[f"c1:{c}"] += 0.8
    for a, b in zip(chars, chars[1:]):
        feats[f"c2:{a}{b}"] += 1.6
    for a, b, c in zip(chars, chars[1:], chars[2:]):
        feats[f"c3:{a}{b}{c}"] += 1.0

    return feats


def _bucket(token: str, dim: int) -> tuple[int, float]:
    digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
    value = int.from_bytes(digest, "big")
    index = value % dim
    sign = 1.0 if (value >> 63) & 1 else -1.0
    return index, sign


def local_embed(text: str) -> list[float]:
    """确定性哈希嵌入：同文本永远得到同向量，维度 = EMBEDDING_DIM。"""
    dim = settings.EMBEDDING_DIM
    vec = [0.0] * dim
    feats = _ngrams(text or "")
    if not feats:
        return vec
    for token, weight in feats.items():
        idx, sign = _bucket(token, dim)
        vec[idx] += sign * weight

    norm = math.sqrt(sum(v * v for v in vec))
    if norm == 0:
        return vec
    return [v / norm for v in vec]


# ---------------------------------------------------------------------
# 远程 OpenAI 兼容嵌入
# ---------------------------------------------------------------------
def _remote_embed_sync(texts: list[str]) -> list[list[float]]:
    base = settings.EMBEDDING_BASE_URL.rstrip("/")
    headers = {
        "Authorization": f"Bearer {settings.EMBEDDING_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {"model": settings.EMBEDDING_MODEL, "input": texts}
    with httpx.Client(timeout=settings.LLM_TIMEOUT_SECONDS) as client:
        resp = client.post(f"{base}/embeddings", headers=headers, json=payload)
        resp.raise_for_status()
        body = resp.json()
    rows = sorted(body["data"], key=lambda r: r.get("index", 0))
    out: list[list[float]] = []
    for row in rows:
        vec = [float(x) for x in row["embedding"]]
        if len(vec) != settings.EMBEDDING_DIM:
            # 维度与库表不一致时截断/补零，保证写库不炸；建议改 EMBEDDING_DIM 后重建索引
            vec = (vec + [0.0] * settings.EMBEDDING_DIM)[: settings.EMBEDDING_DIM]
        out.append(vec)
    return out


def embedding_mode() -> str:
    return "remote" if settings.remote_embedding_enabled else "local-hash"


def embed_texts(texts: list[str]) -> list[list[float]]:
    """批量向量化，带进程内缓存。"""
    results: list[list[float] | None] = []
    pending: list[str] = []
    pending_idx: list[int] = []

    for t in texts:
        key = t[:512]
        cached = _embedding_cache.get(key)
        if cached is not None:
            results.append(cached)
        else:
            results.append(None)
            pending.append(t)
            pending_idx.append(len(results) - 1)

    if pending:
        computed: list[list[float]] = []
        if settings.remote_embedding_enabled:
            size = max(1, settings.EMBEDDING_BATCH_SIZE)
            for i in range(0, len(pending), size):
                batch = pending[i : i + size]
                try:
                    computed.extend(_remote_embed_sync(batch))
                except Exception as exc:  # noqa: BLE001
                    logger.warning("远程嵌入失败，本批降级为本地嵌入: %s", exc)
                    computed.extend(local_embed(t) for t in batch)
        else:
            computed = [local_embed(t) for t in pending]

        for idx, text, vec in zip(pending_idx, pending, computed, strict=True):
            results[idx] = vec
            if len(_embedding_cache) < _CACHE_LIMIT:
                _embedding_cache[text[:512]] = vec

    return [r if r is not None else local_embed("") for r in results]


def embed_text(text: str) -> list[float]:
    return embed_texts([text])[0]


def char_bigrams(text: str) -> set[str]:
    """中文字符 + 英数字词构成的 bigram 集合，用于词面重合度计算。"""
    normalized = re.sub(r"[\s\u3000，。！？、；：,.!?;:~`\"'（）()\[\]{}<>《》\-—_*#]+", "", text or "")
    chars = [c for c in normalized if _CJK_RE.match(c)]
    words = _WORD_RE.findall(normalized.lower())
    grams: set[str] = set()
    grams.update(f"{a}{b}" for a, b in zip(chars, chars[1:]))
    grams.update(chars)
    grams.update(words)
    return grams


def lexical_overlap(a: str, b: str) -> float:
    """重叠系数（overlap coefficient），对「一方是另一方子串/近似改写」很敏感。

    相比 Jaccard，重叠系数不会被长度差异拖低，因此更适合「短问句 vs 长标准问句」的匹配。
    """
    ga, gb = char_bigrams(a), char_bigrams(b)
    if not ga or not gb:
        return 0.0
    return len(ga & gb) / min(len(ga), len(gb))


# ---------------------------------------------------------------------
# 相似度工具（供聚类与缓存匹配使用）
# ---------------------------------------------------------------------
def cosine(a: list[float], b: list[float]) -> float:
    if not a or not b:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def normalize_question(text: str) -> str:
    """提问归一化：去空白、去标点、统一小写，用于缺口去重键。"""
    cleaned = re.sub(r"[\s\u3000]+", "", text or "")
    cleaned = re.sub(r"[，。！？、；：,.!?;:~`\"'（）()\[\]{}<>《》\-—_*#]", "", cleaned)
    return cleaned.lower()[:200]


def combined_similarity(a_text: str, a_vec: list[float], b_text: str, b_vec: list[float]) -> float:
    """融合相似度：向量余弦 + 词面重叠。

    只用余弦时，本地哈希嵌入对「同义改写」的分值偏低（实测 0.15~0.66），
    而真实语义模型同一对问句能到 0.9 以上。加入词面重叠可显著提升召回，
    同时不牺牲精确性（实测跨主题问句的余弦接近 0，加权后仍远低于阈值）。
    """
    cosine_score = cosine(a_vec, b_vec)
    overlap = lexical_overlap(a_text, b_text)
    return max(cosine_score, 0.55 * cosine_score + 0.45 * overlap)


# ---------------------------------------------------------------------
# 关键词检索辅助：为 PostgreSQL tsvector 构造查询串
# ---------------------------------------------------------------------
def keyword_query_terms(text: str) -> list[str]:
    """把问题拆成可用于 tsquery 的词项：中文 bigram + 英文词。"""
    terms: list[str] = []
    words = _WORD_RE.findall((text or "").lower())
    terms.extend(w for w in words if len(w) > 1)
    chars = [c for c in (text or "") if _CJK_RE.match(c)]
    terms.extend(f"{a}{b}" for a, b in zip(chars, chars[1:]))
    # 去重且保序
    seen: set[str] = set()
    ordered: list[str] = []
    for t in terms:
        if t not in seen:
            seen.add(t)
            ordered.append(t)
    return ordered[:40]
