"""交付自检：Nginx 反代链路、前端静态资源、AI 适配层可配置性。

用法（宿主机，需已 docker compose up）：
    python scripts/selfcheck.py [基址]
"""
from __future__ import annotations

import json
import re
import sys
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8080"
ASSET_RE = re.compile(r"/_next/static/[^\"'<> ]+")


def get(path: str, headers: dict | None = None) -> tuple[int, dict, bytes]:
    req = urllib.request.Request(BASE + path, headers=headers or {})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.status, dict(resp.headers), resp.read()


def post(path: str, payload: dict, headers: dict | None = None) -> tuple[int, dict, bytes]:
    hdrs = {"Content-Type": "application/json", **(headers or {})}
    req = urllib.request.Request(
        BASE + path, method="POST", data=json.dumps(payload).encode(), headers=hdrs
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.status, dict(resp.headers), resp.read()


def main() -> int:
    failures = 0

    print("=" * 68)
    print("一、Nginx 反向代理链路")
    print("=" * 68)
    checks = [
        ("/api/health", "FastAPI 后端"),
        ("/", "Next.js 首页"),
        ("/login", "Next.js 登录路由"),
        ("/docs", "API 文档"),
    ]
    for path, label in checks:
        try:
            status, headers, body = get(path)
            good = status == 200 and len(body) > 0
            failures += 0 if good else 1
            ctype = headers.get("Content-Type", "")[:38]
            print(f"  {'✓' if good else '✗'} {path:14s} {status} {len(body):>7} bytes  {ctype:40s} {label}")
        except Exception as exc:  # noqa: BLE001
            failures += 1
            print(f"  ✗ {path:14s} 请求失败：{exc}")

    print()
    print("=" * 68)
    print("二、前端静态资源经反代可加载")
    print("=" * 68)
    html = get("/")[2].decode("utf-8", "ignore")
    assets = list(dict.fromkeys(ASSET_RE.findall(html)))
    ok = 0
    for asset in assets:
        try:
            status, _, body = get(asset)
            good = status == 200 and len(body) > 0
            ok += 1 if good else 0
            failures += 0 if good else 1
            print(f"  {'✓' if good else '✗'} {status} {len(body):>7} bytes  {asset[:64]}")
        except Exception as exc:  # noqa: BLE001
            failures += 1
            print(f"  ✗ {asset[:64]} 加载失败：{exc}")
    print(f"  → 静态资源可用 {ok}/{len(assets)}")

    print()
    print("=" * 68)
    print("三、AI 适配层（OpenAI 兼容协议，base_url 可配置）")
    print("=" * 68)
    try:
        _, _, body = post("/api/auth/login", {"username": "admin", "password": "admin123456"})
        token = json.loads(body)["data"]["access_token"]
        _, _, body = get("/api/config/model", {"Authorization": f"Bearer {token}"})
        data = json.loads(body)["data"]
        keys = [
            "llm_base_url", "llm_chat_model", "llm_key_configured",
            "embedding_base_url", "embedding_model", "embedding_dim",
            "embedding_key_configured", "embedding_mode",
            "confidence_threshold", "faq_cache_match_threshold",
            "faq_cluster_similarity", "chunk_size", "chunk_overlap",
        ]
        for key in keys:
            print(f"  {key:28s} = {data.get(key)}")
        if not str(data.get("llm_base_url", "")).startswith(("http://", "https://")):
            failures += 1
            print("  ✗ llm_base_url 不是合法 HTTP 端点")
    except Exception as exc:  # noqa: BLE001
        failures += 1
        print(f"  ✗ 读取模型配置失败：{exc}")

    print()
    print("=" * 68)
    print(f"自检完成，失败项：{failures}")
    print("=" * 68)
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
