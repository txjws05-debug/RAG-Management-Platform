"""等待最新一次 CI 运行结束，并报告结果与失败步骤。"""

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
RETRIES = 6
MAX_WAIT_S = 900
POLL_S = 20


def fetch(url: str) -> dict:
    last: Exception | None = None
    for attempt in range(1, RETRIES + 1):
        try:
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "ci-wait/1.0", "Accept": "application/vnd.github+json"},
            )
            with urllib.request.urlopen(req, timeout=30, context=CTX) as resp:
                return json.load(resp)
        except (urllib.error.URLError, ssl.SSLError, TimeoutError, OSError) as exc:
            last = exc
            if attempt < RETRIES:
                time.sleep(3)
    raise RuntimeError(f"查询失败: {type(last).__name__}: {last}")


def report(run: dict, jobs: list[dict]) -> None:
    print(f"运行 #{run['run_number']}  sha={run['head_sha'][:7]}  "
          f"{run['status']}/{run.get('conclusion') or '-'}")
    for job in jobs:
        mark = {"success": "✓", "failure": "✗", "skipped": "–"}.get(
            job.get("conclusion") or "", "…"
        )
        print(f"  {mark} {job['name'][:52]}  [{job.get('conclusion') or job['status']}]")
        for step in job.get("steps", []):
            if step.get("conclusion") in ("failure", "cancelled"):
                print(f"      ✗ 失败步骤: {step['name']}")
    print(f"  {run['html_url']}")


def main() -> int:
    deadline = time.time() + MAX_WAIT_S
    while True:
        runs = fetch(f"https://api.github.com/repos/{REPO}/actions/runs?per_page=1")["workflow_runs"]
        if not runs:
            print("暂无运行记录")
            return 1
        run = runs[0]
        jobs = fetch(
            f"https://api.github.com/repos/{REPO}/actions/runs/{run['id']}/jobs"
        ).get("jobs", [])

        if run["status"] == "completed":
            report(run, jobs)
            return 0 if run.get("conclusion") == "success" else 1

        # 未结束：打印当前进度，继续等
        progress = "  ".join(
            f"{j['name'].split(' ')[0]}:{j.get('conclusion') or j['status']}" for j in jobs
        )
        print(f"  [{time.strftime('%H:%M:%S')}] #{run['run_number']} 进行中 → {progress}")
        if time.time() > deadline:
            print(f"超过 {MAX_WAIT_S} 秒仍未结束，停止等待（运行仍在继续）")
            return 2
        time.sleep(POLL_S)


if __name__ == "__main__":
    sys.exit(main())
