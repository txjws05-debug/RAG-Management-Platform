"""查询指定 CI 运行的 job 与步骤状态，用于定位失败在哪一步。"""

from __future__ import annotations

import json
import ssl
import sys
import time
import urllib.error
import urllib.request

REPO = "txjws05-debug/RAG-Management-Platform"
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

# 网络抖动重试：本机到 GitHub 的连接会间歇性 SSL 握手失败，
# 不重试的话查询脚本本身就成了不可靠的观测工具。
RETRIES = 6


def fetch(url: str) -> dict:
    last: Exception | None = None
    for attempt in range(1, RETRIES + 1):
        try:
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "ci-check/1.0", "Accept": "application/vnd.github+json"},
            )
            with urllib.request.urlopen(req, timeout=30, context=CTX) as resp:
                return json.load(resp)
        except (urllib.error.URLError, ssl.SSLError, TimeoutError, OSError) as exc:
            last = exc
            if attempt < RETRIES:
                time.sleep(3)
    raise RuntimeError(f"查询失败（重试 {RETRIES} 次）: {type(last).__name__}: {last}")


def show(run: dict, label: str) -> None:
    print(f"===== {label}  #{run['run_number']}  {run['head_sha'][:7]}  "
          f"{run['status']}/{run.get('conclusion') or '-'} =====")
    jobs = fetch(
        f"https://api.github.com/repos/{REPO}/actions/runs/{run['id']}/jobs"
    ).get("jobs", [])
    for job in jobs:
        mark = {"success": "✓", "failure": "✗", "skipped": "–"}.get(
            job.get("conclusion") or "", "…"
        )
        print(f"  {mark} {job['name'][:56]}  [{job['status']}/{job.get('conclusion') or '-'}]")
        for step in job.get("steps", []):
            if step.get("conclusion") in ("failure", "cancelled"):
                print(f"      ✗ 失败步骤: {step['name']}")
    print()


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1].isdigit():
        target = int(sys.argv[1])
        runs = fetch(f"https://api.github.com/repos/{REPO}/actions/runs?per_page=10")["workflow_runs"]
        for run in runs:
            if run["run_number"] == target:
                show(run, "指定运行")
                return
        print(f"未找到 #{target}")
        return
    runs = fetch(f"https://api.github.com/repos/{REPO}/actions/runs?per_page=2")["workflow_runs"]
    for i, run in enumerate(runs):
        show(run, "最新" if i == 0 else "上一次")


if __name__ == "__main__":
    main()
