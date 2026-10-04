"""查询 GitHub Actions 最近几次运行状态（公开 API，无需登录）。"""

from __future__ import annotations

import json
import ssl
import urllib.request

REPO = "txjws05-debug/RAG-Management-Platform"
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE


def fetch(url: str) -> dict:
    req = urllib.request.Request(
        url, headers={"User-Agent": "ci-check/1.0", "Accept": "application/vnd.github+json"}
    )
    with urllib.request.urlopen(req, timeout=25, context=CTX) as resp:
        return json.load(resp)


def main() -> None:
    data = fetch(f"https://api.github.com/repos/{REPO}/actions/runs?per_page=5")
    runs = data.get("workflow_runs", [])
    if not runs:
        print("  暂无 workflow 运行记录（刚推送时可能还没注册，稍等再查）")
        return
    for run in runs:
        conclusion = run.get("conclusion") or "-"
        mark = {"success": "✓", "failure": "✗", "cancelled": "·", "-": "…"}.get(conclusion, "?")
        print(
            f"  {mark} #{run['run_number']:<3} {run['name']:<20} "
            f"{run['status']}/{conclusion:<10} sha={run['head_sha'][:7]}"
        )
        print(f"      {run['html_url']}")

    # 打印最近一次运行的各 job 状态，便于定位失败在哪一步
    if runs:
        jobs = fetch(
            f"https://api.github.com/repos/{REPO}/actions/runs/{runs[0]['id']}/jobs"
        ).get("jobs", [])
        if jobs:
            print("\n  最近一次运行的 job：")
            for job in jobs:
                conclusion = job.get("conclusion") or "-"
                mark = {"success": "✓", "failure": "✗", "skipped": "–"}.get(conclusion, "…")
                print(f"    {mark} {job['name']:<28} {job['status']}/{conclusion}")
                for step in job.get("steps", []):
                    if step.get("conclusion") == "failure":
                        print(f"        失败步骤: {step['name']}")


if __name__ == "__main__":
    main()
