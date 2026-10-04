"""探测 Caddy 对各个 Host 的实际路由。

原理：直接连服务器 80 端口，用不同的 Host 头请求，看返回的是哪个项目的内容。
这等价于浏览器访问，但不受本机 DNS 缓存影响，能确定问题出在 DNS 还是 Caddy 路由。
"""
from __future__ import annotations

import ssl
import time
import urllib.error
import urllib.request

SERVER = "8.148.7.238"


def probe(host: str, path: str = "/", port: int | None = None, scheme: str = "http"):
    netloc = f"{SERVER}:{port}" if port else SERVER
    url = f"{scheme}://{netloc}{path}"
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(url, headers={"Host": host, "User-Agent": "probe/1.0"})
    last = None
    for _ in range(3):
        try:
            with urllib.request.urlopen(req, timeout=20, context=ctx) as resp:
                return resp.status, resp.read(6000).decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read(3000).decode("utf-8", "replace")
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(1)
    return None, f"{type(last).__name__}: {str(last)[:120]}"


def identify(status, body: str) -> str:
    if status is None:
        return f"连接失败 -> {body}"
    marks = []
    if "知识库管理平台" in body:
        marks.append("**RAG 平台**")
    elif "知识库" in body:
        marks.append("含“知识库”")
    for token in ("商城", "购物车", "电商", "客服", "订单", "商品"):
        if token in body:
            marks.append(f"含“{token}”(客服/商城项目)")
            break
    if "<title>" in body:
        import re

        m = re.search(r"<title>(.*?)</title>", body, re.S)
        if m:
            marks.append(f"title={m.group(1).strip()[:30]}")
    return f"HTTP {status}  {' / '.join(marks) if marks else '(未识别)'}"


def main() -> None:
    print("=== 80 端口 + 不同 Host（等同浏览器访问，绕过本机 DNS）===")
    for host in ("txjws05.dpdns.org", "rag.txjws05.dpdns.org", "nothing.example.com"):
        st, body = probe(host, "/", port=80)
        print(f"  {host:26s} -> {identify(st, body)}")

    print("\n=== 服务器 8080 端口（kb-nginx 直连，不经过 Caddy）===")
    st, body = probe("any", "/", port=8080)
    print(f"  {'(任意 Host)':26s} -> {identify(st, body)}")

    print("\n=== 80 端口上 /api/health 的归属 ===")
    for host in ("txjws05.dpdns.org", "rag.txjws05.dpdns.org"):
        st, body = probe(host, "/api/health", port=80)
        snippet = body[:120].replace("\n", " ")
        print(f"  {host:26s} -> HTTP {st}  {snippet}")

    print("\n=== 判读 ===")
    print("  若 txjws05.dpdns.org 在 80 上返回客服/商城内容 → Caddy 里还没有 RAG 的站点块，")
    print("  说明 deploy.sh 的第 7 步（接入 Caddy）尚未执行过，需要设 RAG_DOMAIN 后重跑 CI。")


if __name__ == "__main__":
    main()
