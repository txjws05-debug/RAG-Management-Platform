"""检查域名的 NS 委派与解析来源，定位「改回 DigitalPlat 但仍被 Cloudflare 接管」的原因。

用 DNS-over-HTTPS 直接问权威与公共解析器，避免受本机 DNS 缓存/运营商劫持影响。
"""
from __future__ import annotations

import json
import ssl
import time
import urllib.parse
import urllib.request

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

TYPE_NAMES = {1: "A", 2: "NS", 5: "CNAME", 6: "SOA", 15: "MX", 16: "TXT", 28: "AAAA"}


def doh(name: str, qtype: str, resolver: str = "dns.google") -> dict:
    """查 DNS-over-HTTPS。resolver 可选 dns.google / cloudflare-dns.com。"""
    url = f"https://{resolver}/resolve?name={urllib.parse.quote(name)}&type={qtype}"
    for _ in range(5):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "dnscheck/1.0"})
            with urllib.request.urlopen(req, timeout=25, context=CTX) as resp:
                return json.load(resp)
        except Exception:  # noqa: BLE001
            time.sleep(2)
    return {"Status": -1, "Answer": []}


def describe(name: str, qtype: str, resolver: str) -> str:
    data = doh(name, qtype, resolver)
    status = data.get("Status")
    answers = data.get("Answer", [])
    authority = data.get("Authority", [])

    if status == 3:
        return "NXDOMAIN（该域名/记录不存在）"
    if status != 0:
        return f"查询失败 Status={status}"

    if answers:
        parts = []
        for a in answers:
            t = TYPE_NAMES.get(a.get("type"), str(a.get("type")))
            parts.append(f"{t}={a.get('data')}")
        return "  ".join(parts)

    if authority:
        # 没有答案但有 SOA，说明域名存在但该类型无记录
        soa = [a for a in authority if a.get("type") == 6]
        if soa:
            return f"无 {qtype} 记录（域名存在，SOA 权威={soa[0].get('data','').split()[0] if soa[0].get('data') else '?'}）"
    return f"无 {qtype} 记录"


def main() -> None:
    domain = "txjws05.dpdns.org"
    print(f"===== {domain} 的 NS 委派 =====")
    for resolver, label in [("dns.google", "Google DNS"), ("cloudflare-dns.com", "Cloudflare DoH")]:
        print(f"  NS 记录（{label}）: {describe(domain, 'NS', resolver)}")

    print(f"\n===== 各名称的实际解析（Google DNS）=====")
    for name in [domain, f"rag.{domain}", f"www.{domain}"]:
        print(f"  {name:34s} A  -> {describe(name, 'A', 'dns.google')}")

    print(f"\n===== 各名称的实际解析（Cloudflare DoH，模拟 Cloudflare 视角）=====")
    for name in [domain, f"rag.{domain}"]:
        print(f"  {name:34s} A  -> {describe(name, 'A', 'cloudflare-dns.com')}")

    print("\n===== 结论判读 =====")
    ns_google = describe(domain, "NS", "dns.google")
    if "digitalplat" in ns_google.lower():
        print("  NS 已指向 DigitalPlat —— 若仍看到 Cloudflare 页面，那是浏览器/本机 DNS 缓存")
    elif "cloudflare" in ns_google.lower():
        print("  NS 仍指向 Cloudflare —— 域名的解析权威还在 Cloudflare，")
        print("  DigitalPlat 面板里加的记录不会生效，必须在 Cloudflare 里加记录，")
        print("  或在域名注册处把 NS 改成 DigitalPlat 的 dns1/dns2.digitalplat.org")
    else:
        print(f"  NS 为: {ns_google}")


if __name__ == "__main__":
    main()
