"""抓取 GitHub Actions 某次运行的部署日志，用于定位失败原因。

公开仓库的 Actions 日志可通过 API 下载（zip 包），不登录也能取。
"""
from __future__ import annotations

import io
import json
import ssl
import sys
import time
import urllib.error
import urllib.request
import zipfile

REPO = "txjws05-debug/RAG-Management-Platform"
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE
RETRIES = 6


def fetch_bytes(url: str) -> bytes:
    last: Exception | None = None
    for attempt in range(1, RETRIES + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "ci-logs/1.0"})
            with urllib.request.urlopen(req, timeout=60, context=CTX) as resp:
                return resp.read()
        except (urllib.error.URLError, ssl.SSLError, TimeoutError, OSError) as exc:
            last = exc
            if attempt < RETRIES:
                time.sleep(3)
    raise RuntimeError(f"下载失败: {type(last).__name__}: {last}")


def fetch_json(url: str) -> dict:
    return json.loads(fetch_bytes(url).decode("utf-8"))


def main() -> int:
    run_number = sys.argv[1] if len(sys.argv) > 1 else None
    runs = fetch_json(f"https://api.github.com/repos/{REPO}/actions/runs?per_page=10")["workflow_runs"]
    run = next((r for r in runs if str(r["run_number"]) == str(run_number)), runs[0])
    print(f"运行 #{run['run_number']}  {run['head_sha'][:7]}  {run.get('conclusion')}")
    print(f"{run['html_url']}\n")

    data = fetch_bytes(
        f"https://api.github.com/repos/{REPO}/actions/runs/{run['id']}/logs"
    )
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = archive.namelist()
        # 只看 deploy 那个 job 的日志
        targets = [n for n in names if "deploy" in n.lower()]
        if not targets:
            targets = names
        for name in targets:
            print("=" * 70)
            print(f"### {name}")
            print("=" * 70)
            text = archive.read(name).decode("utf-8", errors="replace")
            for line in text.splitlines():
                # 去掉 GitHub 的时间戳前缀，保留可读内容
                print("  " + line[:220])
    return 0


if __name__ == "__main__":
    sys.exit(main())
