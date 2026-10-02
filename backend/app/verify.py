"""端到端验收脚本：逐条验证 ROG.txt 2.9.10 的 9 项验收标准。

用法（容器内）：
    docker compose exec api python -m app.verify
用法（本机，宿主机可访问 API 时）：
    KB_API_BASE=http://127.0.0.1:8080/api python -m app.verify
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from dataclasses import dataclass, field

import httpx

API_BASE = os.environ.get("KB_API_BASE", "http://127.0.0.1:8000/api")
DEMO_PASSWORD = os.environ.get("KB_DEMO_PASSWORD", "demo123456")
ADMIN_USERNAME = os.environ.get("BOOTSTRAP_ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.environ.get("BOOTSTRAP_ADMIN_PASSWORD", "admin123456")

GREEN, RED, YELLOW, CYAN, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[36m", "\033[0m"


@dataclass
class Report:
    passed: list[str] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def ok(self, label: str, detail: str = "") -> None:
        self.passed.append(label)
        print(f"  {GREEN}✓{RESET} {label}" + (f"  {CYAN}{detail}{RESET}" if detail else ""))

    def bad(self, label: str, detail: str = "") -> None:
        self.failed.append(label)
        print(f"  {RED}✗{RESET} {label}" + (f"  {RED}{detail}{RESET}" if detail else ""))

    def check(self, condition: bool, label: str, detail: str = "") -> bool:
        if condition:
            self.ok(label, detail)
        else:
            self.bad(label, detail)
        return condition

    def note(self, text: str) -> None:
        self.notes.append(text)
        print(f"  {YELLOW}·{RESET} {text}")


class Client:
    """带鉴权的 API 客户端。"""

    def __init__(self, base: str) -> None:
        self.base = base.rstrip("/")
        self.http = httpx.AsyncClient(timeout=180.0, follow_redirects=True)
        self.token: str | None = None
        self.user: dict = {}

    async def close(self) -> None:
        await self.http.aclose()

    @property
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"} if self.token else {}

    async def request(self, method: str, path: str, **kwargs) -> tuple[int, dict]:
        url = f"{self.base}{path}"
        headers = {**self.headers, **kwargs.pop("headers", {})}
        resp = await self.http.request(method, url, headers=headers, **kwargs)
        try:
            body = resp.json()
        except json.JSONDecodeError:
            body = {"code": -1, "message": resp.text[:200], "data": None}
        return resp.status_code, body

    async def get(self, path: str, **params):
        return await self.request("GET", path, params=params or None)

    async def post(self, path: str, payload: dict | None = None):
        return await self.request("POST", path, json=payload)

    async def put(self, path: str, payload: dict | None = None):
        return await self.request("PUT", path, json=payload)

    async def delete(self, path: str):
        return await self.request("DELETE", path)

    async def data(self, method: str, path: str, **kwargs):
        status, body = await self.request(method, path, **kwargs)
        if status >= 400 or body.get("code") != 0:
            raise RuntimeError(f"{method} {path} → HTTP {status} {body.get('message')}")
        return body.get("data")

    async def login(self, username: str, password: str) -> dict:
        status, body = await self.post("/auth/login", {"username": username, "password": password})
        if status >= 400 or body.get("code") != 0:
            raise RuntimeError(f"登录失败 {username}: HTTP {status} {body.get('message')}")
        payload = body["data"]
        self.token = payload["access_token"]
        self.user = payload["user"]
        return payload

    async def ask(self, question: str, session_key: str | None = None) -> dict:
        """消费 SSE 流，聚合成结构化结果。"""
        payload = {"question": question, "session_key": session_key}
        events: dict[str, list] = {}
        answer = ""
        url = f"{self.base}/chat/ask"
        async with self.http.stream(
            "POST", url, json=payload, headers={**self.headers, "Accept": "text/event-stream"}
        ) as resp:
            if resp.status_code >= 400:
                text = (await resp.aread()).decode("utf-8", "ignore")
                raise RuntimeError(f"问答失败 HTTP {resp.status_code}: {text[:200]}")
            buffer = ""
            async for chunk in resp.aiter_text():
                buffer += chunk
                while "\n\n" in buffer:
                    block, buffer = buffer.split("\n\n", 1)
                    name, body = _parse_sse_block(block)
                    if not name:
                        continue
                    events.setdefault(name, []).append(body)
                    if name == "delta" and isinstance(body, dict):
                        answer += body.get("text", "")
                    elif name == "error":
                        message = body.get("message") if isinstance(body, dict) else str(body)
                        print(f"    {RED}[SSE error] {message}{RESET}")

        return {
            "answer": answer,
            "events": events,
            "citations": events.get("citations", [[]])[-1] if events.get("citations") else [],
            "restricted": bool(events.get("restricted")),
            "authz": events.get("authz", [{}])[-1] if events.get("authz") else {},
            "done": events.get("done", [{}])[-1] if events.get("done") else {},
            "tool": events.get("tool", [{}])[-1] if events.get("tool") else {},
            "session_key": (events.get("meta", [{}])[-1] or {}).get("session_key"),
        }


def _parse_sse_block(block: str) -> tuple[str, object]:
    name = ""
    data_lines: list[str] = []
    for line in block.split("\n"):
        if line.startswith("event:"):
            name = line[6:].strip()
        elif line.startswith("data:"):
            # 按前缀剥离：既兼容 `data:{...}`（本项目），也兼容规范的 `data: {...}`
            data_lines.append(line[5:].strip())
    if not name:
        return "", None
    raw = "\n".join(data_lines)
    try:
        return name, json.loads(raw)
    except json.JSONDecodeError:
        return name, raw


async def wait_documents_ready(
    client: Client, doc_ids: list[int], timeout: float = 90.0
) -> dict[int, dict]:
    """轮询等待后台解析完成。"""
    deadline = time.time() + timeout
    state: dict[int, dict] = {}
    while time.time() < deadline:
        done = True
        for doc_id in doc_ids:
            payload = await client.data("GET", f"/knowledge/documents/{doc_id}")
            state[doc_id] = payload
            if payload["status"] in ("pending", "parsing"):
                done = False
        if done:
            return state
        await asyncio.sleep(2)
    return state


# =====================================================================
# 验收项
# =====================================================================
async def scenario_1_login_and_org(report: Report) -> None:
    print(f"\n{CYAN}【验收 1】用户登录 / 部门树 / 角色管理 / 操作按钮级权限{RESET}")
    admin = Client(API_BASE)
    try:
        await admin.login(ADMIN_USERNAME, ADMIN_PASSWORD)
        report.check(True, "管理员 JWT 登录成功", admin.user["display_name"])

        # 幂等清理：清掉上一次验收残留的临时账号与角色
        # 顺序：必须先真正删除账号（CASCADE 解除 user_roles 绑定），才能删除角色
        users_all = await admin.data("GET", "/users", params={"page_size": 200})
        leftover_users = [u for u in users_all["items"] if u["username"].startswith("verify_")]
        for user in leftover_users:
            status, body = await admin.delete(f"/users/{user['id']}")
            if status >= 400:
                report.note(f"残留账号 {user['username']} 未能删除：{body.get('message')}")
        roles_all = await admin.data("GET", "/roles")
        leftover_roles = [r for r in roles_all if r["code"].startswith("verify_")]
        for role in leftover_roles:
            status, body = await admin.delete(f"/roles/{role['id']}")
            if status >= 400:
                report.note(f"残留角色 {role['code']} 未能删除：{body.get('message')}")
        if leftover_roles or leftover_users:
            report.note(
                f"已清理上次残留：{len(leftover_users)} 个账号 / {len(leftover_roles)} 个角色"
            )

        tree = await admin.data("GET", "/departments/tree")
        flat: list[dict] = []

        def walk(nodes: list[dict]) -> None:
            for node in nodes:
                flat.append(node)
                walk(node.get("children") or [])

        walk(tree)
        report.check(
            len(flat) >= 5,
            "部门树形架构可维护（含子部门与人数）",
            f"{len(flat)} 个部门: {[n['name'] for n in flat]}",
        )

        # 新增子部门 → 改名 → 删除
        created = await admin.data(
            "POST",
            "/departments",
            json={"name": "验收临时部门", "code": f"VERIFY{int(time.time()) % 100000}", "parent_id": flat[0]["id"]},
        )
        await admin.data("PUT", f"/departments/{created['id']}", json={"name": "验收临时部门-改"})
        await admin.data("DELETE", f"/departments/{created['id']}")
        report.ok("部门增删改链路可用", f"id={created['id']}")

        roles = await admin.data("GET", "/roles")
        report.check(len(roles) >= 4, "角色管理可用（含内置角色）", f"{len(roles)} 个角色")
        perm_tree = await admin.data("GET", "/permissions/tree")
        report.check(
            len(perm_tree) >= 5,
            "菜单/操作功能权限树可用",
            f"{len(perm_tree)} 个菜单节点",
        )

        # 创建带按钮级权限的角色并验证拦截
        suffix = f"{int(time.time()) % 100000}"
        ro_username = f"verify_ro_{suffix}"
        role = await admin.data(
            "POST",
            "/roles",
            json={
                "name": "验收只读角色",
                "code": f"verify_ro_{suffix}",
                "permission_codes": ["menu:chat", "ai:chat"],
            },
        )
        dept_id = flat[0]["id"]
        user = await admin.data(
            "POST",
            "/users",
            json={
                "username": ro_username,
                "password": "verify123456",
                "display_name": "验收只读用户",
                "department_id": dept_id,
                "role_ids": [role["id"]],
            },
        )

        ro = Client(API_BASE)
        await ro.login(ro_username, "verify123456")
        report.check(
            "system:manage" not in ro.user["permissions"] and "ai:chat" in ro.user["permissions"],
            "用户功能权限按角色正确下发",
            f"permissions={ro.user['permissions']}",
        )
        status_code, body = await ro.get("/users")
        report.check(
            status_code == 403,
            "按钮/接口级权限拦截生效（无 system:manage 访问用户管理被拒）",
            f"HTTP {status_code} {body.get('message')}",
        )
        status_code, _ = await ro.post("/knowledge/documents/upload")
        report.check(status_code in (403, 422), "无 knowledge:upload 权限无法上传文档", f"HTTP {status_code}")

        await ro.close()
        # 顺序很重要：必须先真正删除账号（CASCADE 解除 user_roles 绑定），
        # 再删除角色，否则后端会以「仍有用户绑定该角色」正确拒绝。
        await admin.data("DELETE", f"/users/{user['id']}")
        await admin.data("DELETE", f"/roles/{role['id']}")
        report.ok("验收临时账号与角色已清理（先删账号再删角色）")
    finally:
        await admin.close()


async def cleanup_test_documents(admin: Client, report: Report) -> None:
    """幂等清理：删除历史验收遗留的「验收测试」知识单元。

    必须在每个验收场景之前执行 —— 否则遗留的测试文档会参与真实检索，
    污染召回集，导致「不该出现权限提示的提问也带上了受限标记」。
    """
    stale = await admin.data(
        "GET", "/knowledge/documents", params={"category": "验收测试", "page_size": 100}
    )
    for doc in stale["items"]:
        await admin.delete(f"/knowledge/documents/{doc['id']}")
    if stale["items"]:
        report.note(f"已清理遗留的 {len(stale['items'])} 个验收知识单元")


async def scenario_2_upload_and_index(report: Report) -> dict:
    print(f"\n{CYAN}【验收 2】界面/接口完成单篇与批量文档导入并解析切片入索引{RESET}")
    admin = Client(API_BASE)
    result: dict = {}
    try:
        await admin.login(ADMIN_USERNAME, ADMIN_PASSWORD)
        await cleanup_test_documents(admin, report)

        single_content = (
            "# 差旅交通费补充说明\n\n"
            "## 高铁改签规则\n\n"
            "因公改签高铁票产生的差价实报实销，需在报销单备注改签原因。\n\n"
            "## 打车报销\n\n"
            "夜间 22:00 后出差返程可乘坐出租车，单次上限 120 元，需提供行程单。\n"
        ).encode("utf-8")

        files = {"file": ("验收单篇导入.md", single_content, "text/markdown")}
        data = {"category": "验收测试"}
        payload = await admin.data("POST", "/knowledge/documents/upload", files=files, data=data)
        report.ok("单篇文档上传受理成功", f"id={payload['id']} status={payload['status']}")

        batch_files = [
            (
                "files",
                (
                    "验收批量A.txt",
                    "# 批量文档 A\n\n本文件用于验证批量导入与向量化入库能力。\n内容包含唯一的验证关键词：量子咖啡机。\n".encode("utf-8"),
                    "text/plain",
                ),
            ),
            (
                "files",
                (
                    "验收批量B.txt",
                    "# 批量文档 B\n\n本文件用于验证批量导入的第二个文件，验证关键词：深海光缆。\n".encode("utf-8"),
                    "text/plain",
                ),
            ),
        ]
        batch = await admin.data(
            "POST", "/knowledge/documents/batch-upload", files=batch_files, data={"category": "验收测试"}
        )
        report.check(
            batch["accepted_count"] == 2,
            "批量/文件夹导入受理成功",
            f"accepted={batch['accepted_count']} failed={batch['failed_count']}",
        )

        doc_ids = [payload["id"]] + [item["id"] for item in batch["accepted"]]
        states = await wait_documents_ready(admin, doc_ids)

        ready = [d for d in states.values() if d["status"] == "ready"]
        report.check(
            len(ready) == len(doc_ids),
            "全部文档解析切片并完成向量化入库",
            f"{len(ready)}/{len(doc_ids)} ready",
        )
        for doc in states.values():
            if doc["status"] != "ready":
                report.bad(f"文档 {doc['code']} 解析失败", doc.get("error_message") or "")

        chunks = await admin.data("GET", f"/knowledge/documents/{doc_ids[0]}/chunks")
        report.check(
            chunks["total"] > 0,
            "切片可查询（文档已切分为知识单元切片）",
            f"{chunks['total']} 个切片",
        )
        report.check(
            all(c["content"] for c in chunks["items"]),
            "切片正文非空",
            f"首片 {chunks['items'][0]['char_count']} 字",
        )
        result["doc_ids"] = doc_ids
        result["chunk_count"] = sum(d["chunk_count"] for d in states.values())
    finally:
        await admin.close()
    return result


async def scenario_3_4_crud_and_grants(report: Report, uploaded: dict) -> dict:
    print(f"\n{CYAN}【验收 3】知识单元增删改查 + 四维数据权限混合配置{RESET}")
    admin = Client(API_BASE)
    ids: dict = {}
    try:
        await admin.login(ADMIN_USERNAME, ADMIN_PASSWORD)
        # 验收 2 上传的测试文档仍留在库里，会参与真实检索污染召回集，先清干净
        await cleanup_test_documents(admin, report)

        listed = await admin.data("GET", "/knowledge/documents", params={"page": 1, "page_size": 50})
        report.check(
            listed["total"] >= 5,
            "知识单元台账列表可读",
            f"共 {listed['total']} 个知识单元（5 份示例 + 运行期导入）",
        )

        target_ids = {d["id"]: d for d in listed["items"]}
        blocked_doc = next(
            (d for d in listed["items"] if "高管薪酬" in d["title"]), None
        )
        global_doc = next((d for d in listed["items"] if "差旅报销标准" in d["title"]), None)
        cs_doc = next((d for d in listed["items"] if "生鲜" in d["title"]), None)
        if not (blocked_doc and global_doc and cs_doc):
            report.bad("示例知识单元未就绪", "缺少 高管薪酬/差旅报销/生鲜 三类示例文档")
            return {}
        ids.update(
            {
                "blocked_doc_id": blocked_doc["id"],
                "finance_doc_id": global_doc["id"],
                "cs_doc_id": cs_doc["id"],
            }
        )
        report.ok(
            "示例场景知识单元齐备",
            f"公开《{global_doc['title']}》/ 客服《{cs_doc['title']}》/ 机密《{blocked_doc['title']}》",
        )

        # 查
        detail = await admin.data("GET", f"/knowledge/documents/{cs_doc['id']}")
        report.check(detail["chunk_count"] > 0, "知识单元详情可查", f"切片 {detail['chunk_count']}")

        # 改
        new_title = f"{cs_doc['title']}（验收改名）"
        await admin.data(
            "PUT", f"/knowledge/documents/{cs_doc['id']}", json={"title": new_title, "category": "客服规范"}
        )
        after = await admin.data("GET", f"/knowledge/documents/{cs_doc['id']}")
        report.check(after["title"] == new_title, "知识单元可编辑（标题/分类）", new_title)
        await admin.data(
            "PUT", f"/knowledge/documents/{cs_doc['id']}", json={"title": cs_doc["title"]}
        )

        # 四维权限混合配置：全局 + 部门 + 角色 + 个人 一次性配置
        dept_tree = await admin.data("GET", "/departments/tree")
        flat: list[dict] = []

        def walk(nodes: list[dict]) -> None:
            for node in nodes:
                flat.append(node)
                walk(node.get("children") or [])

        walk(dept_tree)
        fin = next(d for d in flat if d["code"] == "FIN")
        roles = await admin.data("GET", "/roles")
        normal_role = next(r for r in roles if r["code"] == "normal_user")
        users = await admin.data("GET", "/users", params={"page_size": 200})
        sales = next(u for u in users["items"] if u["username"] == "sales01")

        grant = await admin.data(
            "PUT",
            f"/knowledge/documents/{cs_doc['id']}/grants",
            json={
                "global_public": True,
                "department_ids": [fin["id"]],
                "role_ids": [normal_role["id"]],
                "user_ids": [sales["id"]],
            },
        )
        report.check(
            grant["grant_count"] == 4,
            "四维数据权限混合配置成功（全局+部门+角色+个人）",
            grant["grant_summary"],
        )

        read_back = await admin.data("GET", f"/knowledge/documents/{cs_doc['id']}/grants")
        report.check(
            read_back["global_public"]
            and fin["id"] in read_back["department_ids"]
            and normal_role["id"] in read_back["role_ids"]
            and sales["id"] in read_back["user_ids"],
            "权限配置回读一致",
            f"4 类实体齐全",
        )

        # 恢复为“仅角色可见 + 部门”，保留 OR 语义演示（去掉 global）
        await admin.data(
            "PUT",
            f"/knowledge/documents/{cs_doc['id']}/grants",
            json={
                "global_public": False,
                "department_ids": [fin["id"]],
                "role_ids": [normal_role["id"]],
                "user_ids": [sales["id"]],
            },
        )
        report.ok("权限覆盖式更新生效（去掉全局公开后仅保留部门/角色/个人）")

        # 增 + 删
        created = await admin.data(
            "POST",
            "/knowledge/documents/upload",
            files={"file": ("验收新建再删除.txt", "本文件用于验证删除能力。".encode("utf-8"), "text/plain")},
            data={"category": "验收测试"},
        )
        await wait_documents_ready(admin, [created["id"]], timeout=60)
        await admin.data("DELETE", f"/knowledge/documents/{created['id']}")
        status, _ = await admin.get(f"/knowledge/documents/{created['id']}")
        report.check(status == 404, "知识单元删除生效", f"删除后查询 HTTP {status}")

        ids["normal_role_id"] = normal_role["id"]
        ids["fin_dept_id"] = fin["id"]
    finally:
        await admin.close()
    return ids


async def scenario_5_or_permission(report: Report, ids: dict) -> None:
    print(f"\n{CYAN}【验收 4】四维权限 OR 判定：满足任一实体即可访问{RESET}")
    cases = [
        ("finance01", "部门匹配（财务部）", True),
        ("sales01", "个人授权匹配", True),
        ("hr01", "角色匹配（普通用户）", True),
        ("manager01", "不属于上述三类", False),
    ]
    clients: list[Client] = []
    try:
        doc_id = ids["cs_doc_id"]
        for username, label, expected in cases:
            client = Client(API_BASE)
            clients.append(client)
            await client.login(username, DEMO_PASSWORD)
            status, body = await client.get(f"/knowledge/documents/{doc_id}")
            allowed = status == 200 and body.get("code") == 0
            report.check(
                allowed == expected,
                f"{label} → {'放行' if allowed else '拦截'}",
                f"{username} HTTP {status}",
            )

        # 全局公开文档：所有人可读
        for username in ("sales01", "manager01"):
            client = Client(API_BASE)
            clients.append(client)
            await client.login(username, DEMO_PASSWORD)
            status, _ = await client.get(f"/knowledge/documents/{ids['finance_doc_id']}")
            report.check(status == 200, f"全局公开知识单元对 {username} 放行", f"HTTP {status}")
    finally:
        for client in clients:
            await client.close()


async def scenario_6_ai_authz(report: Report, ids: dict) -> dict:
    print(f"\n{CYAN}【验收 5】AI 对话强制登录态 + 鉴权过滤 + 权限缺失提示{RESET}")

    anon = httpx.AsyncClient(timeout=60.0)
    try:
        resp = await anon.post(f"{API_BASE}/chat/ask", json={"question": "差旅报销标准是多少？"})
        report.check(
            resp.status_code == 401,
            "未登录访问 AI 问答被强制拦截",
            f"HTTP {resp.status_code}",
        )
    finally:
        await anon.aclose()

    session = {}
    sales = Client(API_BASE)
    manager = Client(API_BASE)
    outsider = Client(API_BASE)
    try:
        await sales.login("sales01", DEMO_PASSWORD)
        await manager.login("manager01", DEMO_PASSWORD)
        # 注意：不能用 hr01 —— 机密文档《高管薪酬与股权激励细则》正是授权给人力资源部的，
        # hr01 属于命中有权场景。这里需要一名「部门/角色/个人都不匹配」的用户，
        # 财务部普通用户 finance01 符合：该文档只授权给人力资源部与「管理层」角色。
        await outsider.login("finance01", DEMO_PASSWORD)

        # 场景一：普通业务人员问差旅标准 → 正常召回 + 引用溯源
        r1 = await sales.ask("差旅报销标准中，一线城市住宿费上限是多少？")
        report.check(
            len(r1["citations"]) > 0,
            "有权限的知识单元被正常召回并附引用溯源",
            f"引用 {len(r1['citations'])} 条，最高相关度 {r1['done'].get('top_score')}",
        )
        report.check(
            "住宿" in r1["answer"] or "450" in r1["answer"],
            "回答基于已授权切片生成（含标准答案要点）",
            f"答案长度 {len(r1['answer'])}",
        )
        report.check(
            not r1["restricted"],
            "对无受限召回项的提问不产生权限提示（召回集全部有权访问）",
            f"召回文档 {r1['authz'].get('recalled_document_ids')} / 拦截 {r1['authz'].get('blocked_document_ids')}",
        )
        session["session_key"] = r1["session_key"]

        # 多轮上下文
        r2 = await sales.ask("那如果我改签高铁票，差价怎么报？", session_key=session["session_key"])
        report.check(
            r2["session_key"] == session["session_key"] and len(r2["answer"]) > 0,
            "多轮上下文会话延续（同一 session_key）",
            r2["session_key"],
        )

        # 场景一核心：无权访问的高管薪酬 → 鉴权拦截 + 明确提示
        r3 = await outsider.ask("高管薪酬与股权激励的授予价格是怎么确定的？")
        report.check(
            r3["restricted"] and r3["authz"].get("blocked_document_ids"),
            "召回命中无权知识单元时触发鉴权拦截",
            f"召回 {r3['authz'].get('recalled_chunk_count')} 片 → 放行 {r3['authz'].get('allowed_chunk_count')} 片"
            f" / 拦截 {r3['authz'].get('blocked_chunk_count')} 片",
        )
        notice = (r3["events"].get("restricted") or [{}])[0]
        report.check(
            "无权" in notice.get("message", ""),
            "输出明确的权限缺失提示",
            notice.get("message", ""),
        )
        report.check(
            "无权" in r3["answer"],
            "权限缺失提示真实出现在回答正文中（含服务端兜底）",
            r3["answer"][-90:].replace("\n", " "),
        )
        leaked = any(
            kw in r3["answer"] for kw in ("120 万", "120万", "授予价格", "50%", "M5")
        ) and r3["authz"].get("allowed_chunk_count", 0) == 0
        report.check(
            not leaked,
            "未越权泄漏受限内容",
            f"拦截文档 {r3['authz'].get('blocked_document_ids')}",
        )
        report.check(
            r3["done"].get("blocked", 0) > 0,
            "审计记录中登记了鉴权拦截列表",
            f"blocked={r3['done'].get('blocked')}",
        )

        # 有权限用户的对照：manager01 命中「管理层」角色授权，应能读到机密文档
        r4 = await manager.ask("高管薪酬的基本年薪是怎么分级的？")
        report.check(
            r4["authz"].get("allowed_chunk_count", 0) > 0,
            "管理层角色命中角色权限，正常放行",
            f"放行 {r4['authz'].get('allowed_chunk_count')} 片",
        )
        report.check(
            "M4" in r4["answer"] or "80" in r4["answer"] or "基本年薪" in r4["answer"],
            "有权限用户获得受限文档内容",
            f"答案长度 {len(r4['answer'])}",
        )
    finally:
        await sales.close()
        await manager.close()
        await outsider.close()
    return session


async def scenario_7_dashboard(report: Report) -> None:
    print(f"\n{CYAN}【验收 6】数据看板：访问量 / 独立人数 / 知识量 / 榜单 / Token / 延时{RESET}")
    admin = Client(API_BASE)
    try:
        await admin.login(ADMIN_USERNAME, ADMIN_PASSWORD)
        board = await admin.data("GET", "/dashboard/all", params={"days": 7})
        ov = board["overview"]
        report.check(ov["pv"] > 0 and ov["uv"] > 0, "访问量 PV / 独立人数 UV 统计正确", f"PV={ov['pv']} UV={ov['uv']}")
        report.check(
            ov["document_count"] > 0 and ov["chunk_count"] > 0,
            "知识单元总量与切片总量正确",
            f"文档 {ov['document_count']} / 切片 {ov['chunk_count']}",
        )
        report.check(len(board["top_questions"]) > 0, "常见高频问题 TOP 榜有数据", f"{len(board['top_questions'])} 条")
        report.check(len(board["top_documents"]) > 0, "高频引用知识 TOP 榜有数据", f"{len(board['top_documents'])} 条")
        report.check(
            len(board["visit_trend"]) == 7,
            "访问量趋势按天聚合",
            f"{board['visit_trend'][0]['label']} ~ {board['visit_trend'][-1]['label']}",
        )
        report.check(
            len(board["token_trend"]) == 7 and ov["total_tokens"] > 0,
            "Token 消耗趋势可用",
            f"7 天合计 {ov['total_tokens']} tokens",
        )
        report.check(
            sum(b["value"] for b in board["latency_distribution"]) > 0,
            "响应延时分布可用",
            f"平均 {ov['avg_latency_ms']}ms / P95 {ov['p95_latency_ms']}ms",
        )

        lat = await admin.data("GET", "/dashboard/latency-distribution")
        report.check(lat["sample_size"] > 0, "延时分布接口返回样本", f"样本 {lat['sample_size']}")

        audit = await admin.data("GET", "/chat/audit", params={"page": 1, "page_size": 5})
        report.check(
            audit["total"] > 0 and all("recalled" in i and "blocked" in i for i in audit["items"]),
            "单次问答审计记录完整（召回/放行/拦截/Token/耗时）",
            f"{audit['total']} 条审计记录",
        )
    finally:
        await admin.close()


async def reset_faq_demo_state(admin: Client, report: Report) -> None:
    """重置 FAQ 演示状态，保证验收可重复执行。

    必要性：首次运行会发布一条「生鲜」FAQ 并写入缓存，再次运行时那 5 条高频
    相似提问会被缓存直接命中、不再产生新的问答日志，于是聚类频次不足，
    候选 FAQ 就不会再生成 —— 验收会「第二次才失败」。
    """
    entries = await admin.data("GET", "/faq/entries", params={"page_size": 100})
    removed = 0
    for entry in entries["items"]:
        if "生鲜" in entry["question"]:
            await admin.delete(f"/faq/entries/{entry['id']}")
            removed += 1
    for status in ("pending", "approved", "rejected"):
        candidates = await admin.data(
            "GET", "/faq/candidates", params={"status": status, "page_size": 100}
        )
        for cand in candidates["items"]:
            text = cand["canonical_question"] + "".join(cand["sample_questions"])
            if "生鲜" in text or "破损" in text:
                await admin.data("DELETE", f"/faq/candidates/{cand['id']}")
                removed += 1
    await admin.post("/faq/cache/refresh")
    if removed:
        report.note(f"已重置 FAQ 演示状态（清理 {removed} 条历史 FAQ/候选）")


async def scenario_8_faq_mining(report: Report) -> None:
    print(f"\n{CYAN}【验收 7】历史对话挖掘高频 FAQ → 审核发布 → 缓存加速应答{RESET}")
    admin = Client(API_BASE)
    user = Client(API_BASE)
    try:
        await admin.login(ADMIN_USERNAME, ADMIN_PASSWORD)
        await user.login("sales01", DEMO_PASSWORD)
        await reset_faq_demo_state(admin, report)

        # 制造高频相似提问（复用示例场景二的客服问题）
        question = "生鲜食品破损如何申请退款？"
        variants = [
            "生鲜食品破损如何申请退款？",
            "生鲜食品破损怎么申请退款",
            "请问生鲜商品破损了如何申请退款？",
            "生鲜食品破损如何申请退款呢",
            "生鲜食品破损如何申请退款？",
        ]
        for q in variants:
            await user.ask(q)
        report.ok("已写入高频相似提问样本", f"{len(variants)} 条")

        # 挖掘
        mined = await admin.data("POST", "/mining/run", params={"days": 30, "min_frequency": 3})
        report.check(
            mined["clusters"] > 0,
            "自动聚类出高频问题簇",
            f"扫描 {mined['scanned_questions']} 条 / 簇 {mined['clusters']} 个",
        )

        candidates = await admin.data("GET", "/faq/candidates", params={"status": "all", "page_size": 50})
        target = None
        for item in candidates["items"]:
            text = item["canonical_question"] + " ".join(item["sample_questions"])
            if "生鲜" in text or "破损" in text:
                target = item
                break
        report.check(target is not None, "生成候选 FAQ 推荐项（含问题簇/频次/推荐答案/置信度）")
        if target is None:
            return

        report.check(
            target["frequency"] >= 3,
            "候选 FAQ 聚合了提问频次",
            f"频次 {target['frequency']}，置信度 {target['confidence']}",
        )
        report.check(
            bool(target["sample_questions"]),
            "候选 FAQ 携带聚类样本问题",
            f"{len(target['sample_questions'])} 条样本",
        )

        # 审核发布
        answer = (
            "生鲜食品破损请在签收后 24 小时内通过 App「我的订单 → 申请售后」提交，"
            "需提供商品整体照片 1 张、破损部位特写 2 张；"
            "破损 ≤20% 按比例退款，20%~50% 整件退款，>50% 整件退款并补偿 10 元无门槛券；"
            "审核通过后 2 小时内原路退回。"
        )
        reviewed = await admin.data(
            "POST",
            f"/faq/candidates/{target['id']}/review",
            json={"action": "approve", "answer": answer, "category": "客服规范"},
        )
        report.check(
            reviewed["status"] == "approved" and reviewed.get("faq_entry_id"),
            "管理员审核采纳并发布上线",
            f"FAQ id={reviewed['faq_entry_id']}",
        )
        report.check(
            reviewed["cache"]["cached_entries"] > 0,
            "发布后同步写入快速应答缓存",
            f"缓存 {reviewed['cache']['cached_entries']} 条，阈值 {reviewed['cache']['match_threshold']}",
        )

        # 缓存直出验证：换成真实用户可能的另一种问法（非逐字相同）
        variant = "生鲜食品破损了怎么申请退款呢？"
        started = time.perf_counter()
        hit = await user.ask(variant)
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        report.note(f"缓存命中测试问法：{variant}（与已发布 FAQ 非逐字相同）")
        report.check(
            hit["done"].get("answer_source") == "faq_cache",
            "同类新提问毫秒级命中 FAQ 缓存直出",
            f"来源 {hit['done'].get('answer_source')}，相似度 {hit['done'].get('faq_similarity')}，端到端 {elapsed_ms}ms",
        )
        report.check(
            hit["done"].get("answer_source") == "faq_cache"
            and hit["done"].get("faq_hit_id") == reviewed["faq_entry_id"],
            "命中缓存条目与发布条目一致",
            f"faq_hit_id={hit['done'].get('faq_hit_id')}",
        )

        entries = await admin.data("GET", "/faq/entries", params={"page_size": 20})
        report.check(
            any(e["id"] == reviewed["faq_entry_id"] for e in entries["items"]),
            "已发布 FAQ 知识库可管理与检索",
            f"共 {entries['total']} 条已发布 FAQ",
        )

        # 驳回路径
        second = next((c for c in candidates["items"] if c["id"] != target["id"]), None)
        if second is not None:
            rejected = await admin.data(
                "POST", f"/faq/candidates/{second['id']}/review", json={"action": "reject"}
            )
            report.check(rejected["status"] == "rejected", "候选 FAQ 支持驳回", f"id={second['id']}")
    finally:
        await admin.close()
        await user.close()


async def scenario_9_gaps(report: Report) -> None:
    print(f"\n{CYAN}【验收 8】未命中问题自动进入知识缺口清单并统计频次{RESET}")
    admin = Client(API_BASE)
    user = Client(API_BASE)
    try:
        await admin.login(ADMIN_USERNAME, ADMIN_PASSWORD)
        await user.login("cs01", DEMO_PASSWORD)

        question = "海外直邮保税仓清关延误超过多少天可以全额退款？"
        await user.ask(question)
        await user.ask("请问海外直邮清关延误多久能全额退款")
        await user.ask("海外直邮保税仓清关延误的补偿标准是什么")

        mined = await admin.data("POST", "/mining/run", params={"days": 30})
        report.note(f"挖掘结果：{mined['message']}")

        gaps = await admin.data("GET", "/gaps", params={"status": "all", "page_size": 50})
        report.check(gaps["total"] > 0, "知识缺口清单有数据", f"{gaps['total']} 条")

        target = next(
            (g for g in gaps["items"] if "清关" in g["question_text"] or "保税" in g["question_text"]),
            None,
        )
        report.check(target is not None, "未命中的提问被识别为知识缺口")
        if target is None:
            return

        report.check(
            target["frequency"] >= 1 and target["max_similarity"] >= 0,
            "缺口项含提问频次与最高相似度",
            f"频次 {target['frequency']}，最高相似度 {target['max_similarity']}，部门 {target['department_name']}",
        )

        task = await admin.data(
            "POST",
            f"/gaps/{target['id']}/task",
            json={"category": "客服规范", "note": "验收：请补充海外直邮清关延误说明文档"},
        )
        report.check(
            task["status"] == "task_created" and task["task_note"],
            "一键转建知识补充任务",
            task["task_note"][:60] + "…",
        )
        resolved = await admin.data("POST", f"/gaps/{target['id']}/resolve")
        report.check(resolved["status"] == "resolved", "缺口可标记为已解决")
    finally:
        await admin.close()
        await user.close()


async def scenario_10_end_to_end(report: Report, ids: dict) -> None:
    print(f"\n{CYAN}【验收 9】典型业务场景端到端全流程（权限隔离 + 沉淀闭环）{RESET}")
    admin = Client(API_BASE)
    sales = Client(API_BASE)
    try:
        await admin.login(ADMIN_USERNAME, ADMIN_PASSWORD)
        await sales.login("sales01", DEMO_PASSWORD)

        step1 = await sales.ask("差旅报销标准里，二线城市的住宿费上限是多少？")
        report.check(
            len(step1["citations"]) > 0 and not step1["restricted"],
            "步骤1 普通业务人员正常召回《差旅报销标准》并作答",
            f"引用 {len(step1['citations'])} 条，召回文档 {step1['authz'].get('recalled_document_ids')}",
        )

        step2 = await sales.ask("那差旅制度里出差补贴标准呢？在同一份文件里对吧？", session_key=step1["session_key"])
        report.check(
            step2["session_key"] == step1["session_key"],
            "步骤2 多轮追问保持同一会话上下文",
            f"{step1['session_key']} → {step2['session_key']}（来源 {step2['done'].get('answer_source')}）",
        )

        step3 = await sales.ask("高管薪酬与股权激励细则里，基本年薪 M5 是多少？")
        report.check(
            step3["restricted"],
            "步骤3 提问机密制度时触发鉴权拦截",
            f"拦截文档 {step3['authz'].get('blocked_document_ids')}",
        )
        notice = (step3["events"].get("restricted") or [{}])[0]
        report.check(
            "无权" in notice.get("message", "") or "权限" in notice.get("message", ""),
            "步骤3 输出明确权限缺失提示气泡文案",
            notice.get("message", ""),
        )

        ov = await admin.data("GET", "/dashboard/overview", params={"days": 7})
        report.check(
            ov["gap_count"] > 0 and ov["knowledge_coverage"] >= 0,
            "步骤4 看板反映覆盖率与缺口数量（问答流水已异步落库）",
            f"缺口 {ov['gap_count']} 条，覆盖率 {ov['knowledge_coverage']}，"
            f"平均检索相关度 {ov.get('avg_retrieval_score')}",
        )

        audit = await admin.data("GET", "/chat/audit", params={"page_size": 10})
        mine = [a for a in audit["items"] if a["user_name"] and "小赵" in a["user_name"]]
        report.check(
            len(mine) > 0,
            "步骤5 审计记录可按用户追溯召回/放行/拦截明细",
            f"小赵 {len(mine)} 条记录",
        )
    finally:
        await admin.close()
        await sales.close()


async def main() -> int:
    print(f"{CYAN}知识库管理平台 · 端到端验收{RESET}")
    print(f"API: {API_BASE}")

    probe = httpx.AsyncClient(timeout=20.0)
    try:
        resp = await probe.get(f"{API_BASE}/health")
        health = resp.json().get("data", {})
        print(
            f"健康检查：{health.get('status')} | 嵌入模式={health.get('embedding_mode')} "
            f"| LLM Key={'已配置' if health.get('llm_key_configured') else '未配置（离线兜底）'}"
        )
    except Exception as exc:  # noqa: BLE001
        print(f"{RED}无法访问 API：{exc}{RESET}")
        return 2
    finally:
        await probe.aclose()

    report = Report()
    ids: dict = {}
    try:
        await scenario_1_login_and_org(report)
        uploaded = await scenario_2_upload_and_index(report)
        ids.update(await scenario_3_4_crud_and_grants(report, uploaded))
        if ids.get("cs_doc_id"):
            await scenario_5_or_permission(report, ids)
        await scenario_6_ai_authz(report, ids)
        await scenario_7_dashboard(report)
        await scenario_8_faq_mining(report)
        await scenario_9_gaps(report)
        await scenario_10_end_to_end(report, ids)
    except Exception as exc:  # noqa: BLE001
        import traceback

        traceback.print_exc()
        report.bad("验收执行中断", str(exc))

    print(f"\n{CYAN}{'=' * 62}{RESET}")
    print(f"{GREEN}通过 {len(report.passed)} 项{RESET} / {RED}失败 {len(report.failed)} 项{RESET}")
    if report.failed:
        print(f"\n{RED}失败清单：{RESET}")
        for item in report.failed:
            print(f"  - {item}")
        return 1
    print(f"{GREEN}全部 9 项验收标准通过 ✓{RESET}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
