# 知识库管理平台

一个开箱可跑的企业级知识库平台：文档多格式解析切片、**四维细粒度数据权限**、AI 鉴权检索问答、运营数据看板、FAQ 自动沉淀与知识缺口闭环。

后端 FastAPI + PostgreSQL 16/pgvector，前端 Next.js 16 控制台，四容器 Docker Compose 一键启动，**不配任何 API Key 也能完整跑通**。

---

## 目录

- [核心能力](#核心能力)
- [技术栈](#技术栈)
- [界面设计系统](#界面设计系统)
- [快速启动](#快速启动)
- [演示账号](#演示账号)
- [接入大模型](#接入大模型)
- [核心设计](#核心设计)
- [端到端验收](#端到端验收)
- [目录结构](#目录结构)
- [常见问题](#常见问题)
- [已知限制](#已知限制)

---

## 核心能力

### 知识多源维护

- 支持 **PDF / Word(docx) / Markdown / TXT** 单文件上传与批量、文件夹拖拽导入
- 自动清洗（去控制字符、HTML 标签、Markdown 语法噪音）→ 语义切片（带重叠、保留标题上下文）→ 向量化入库
- 知识单元台账：编号、标题、格式、分类、切片数、解析状态、启用开关
- 切片可视化查看，支持重新索引

### 四维细粒度数据权限

每个知识单元可**独立混合配置**四类权限实体，判定采用 **OR 逻辑**（满足任一即放行）：

| 维度 | 说明 |
| --- | --- |
| `global` | 全局公开，全员可读 |
| `department` | 部门共享，按部门树授权 |
| `role` | 角色可见 |
| `user` | 个人专属 |

默认状态下知识单元**无任何访问权限**（白名单模型）。AI 问答链路上同样严格过滤，绝不使用管理员特权拼装上下文。

### AI 鉴权检索问答

- **混合检索**：pgvector HNSW 余弦召回 + PostgreSQL 全文/三元组关键词召回，加权融合
- **检索后鉴权**：召回候选先过四维权限过滤，只有放行的切片才进入提示词
- **权限缺失提示**：召回命中无权文档时，明确提示「检测到相关制度文档，但您当前所属部门/角色无权查阅该内容」，且**不泄漏任何受限内容**
- **SSE 流式输出**：打字机渲染、Markdown 与代码高亮、多轮上下文、历史会话侧栏、智能联想提问
- **引用溯源**：每条回答附带来源文档、相关度、原文片段卡片
- **完整审计**：每轮问答记录召回/放行/拦截清单、Token 用量、响应耗时

### 运营数据看板

PV/UV 提问量、独立提问人数、知识单元与切片总量、FAQ 数量、缓存命中率、知识覆盖率、平均与 P95 响应延时、Token 消耗趋势、常见问题 TOP 榜、高频引用知识 TOP 榜、部门提问排行，支持 7/14/30 天切换。

### 知识自进化闭环

- **FAQ 挖掘**：对历史提问做语义聚类，达到频次阈值自动生成候选 FAQ（含问题簇、聚合频次、关联知识单元、推荐答案、置信度）
- **人工审核**：在线编辑后采纳发布或驳回
- **缓存加速**：发布后写入快速应答缓存，**同类新问法毫秒级直出**，不再调用大模型
- **知识缺口**：检索未命中或置信度偏低的提问自动入池，按提问频次聚合，支持一键转建知识补充任务

---

## 技术栈

| 层 | 选型 |
| --- | --- |
| 向量数据库 | PostgreSQL **16** + **pgvector**（HNSW 余弦索引 + GIN 全文/三元组索引） |
| 后端 | Python **3.12** · FastAPI · Pydantic v2 · SQLAlchemy 2.0（async）· Alembic · asyncpg |
| 前端 | Next.js **16**（App Router）· React **19** · TypeScript（strict）· Tailwind CSS 4 · SWR · ECharts |
| AI 适配 | **OpenAI 兼容协议**，`base_url` 可配置（OpenAI / DeepSeek / 通义 / vLLM / Ollama 均可） |
| 反向代理 | Nginx（`/` → Next.js，`/api` → FastAPI，SSE 关闭缓冲） |
| 编排 | Docker Compose（db / api / web / nginx 四服务） |

---

## 界面设计系统

前端遵循一套**语义化颜色角色 + 明暗双主题 + 移动端优先**的设计规范。

### 颜色是角色，不是色阶

组件引用语义角色（`bg-canvas`、`text-body`、`border-line`），而不是具体色阶（`bg-slate-50`、`text-slate-700`）。原因很直接：**一个在白底上读起来正确的色阶，放到近黑底上通常是错的**。

所有 token 在 `frontend/src/app/globals.css` 的 `@theme` 中定义，并在 `[data-theme="dark"]` 下重新解析：

| 角色 | 用途 |
| --- | --- |
| `canvas` / `subtle` / `muted-surface` / `raised` | 页面底、内陷面板、芯片、选中态 |
| `strong` / `body` / `muted` / `faint` | 标题、正文、次要文字、占位符 |
| `line` / `line-strong` | 边框分隔线、控件边框 |
| `brand` / `brand-soft` / `brand-ink` | 品牌填充、品牌浅底与其上的文字（成对移动） |

**按 token 写的组件不需要任何 `dark:` 变体** —— 主题由 token 承担。只有"固定色在暗色下确实不可读"的少数例外才用 `dark:` 显式说明，让这些刻意选择保持可见。

品牌色与状态色**刻意不参与主题反转**：`bg-indigo-600 text-white` 是一对搭档，为暗色把 indigo 调亮就会得到浅蓝底白字、主按钮不可读。

### 主题由 `data-theme` 单一来源驱动

- `<html data-theme="light|dark">` 是唯一真相来源；Tailwind 的 `dark:` 变体被重定义为属性选择器，因此系统设置与用户显式选择走同一条路径。
- 一段**同步内联脚本**在 `<head>` 中于首帧绘制前设定该属性 —— 不用 `next/script` 的 `beforeInteractive`，因为它会把脚本排队到首帧之后，造成可见的浅色闪屏。
- 任何读 `localStorage` 的组件都必须用 `useHydrated()` 兜住，否则服务端 HTML 与客户端首帧不一致会让 React 丢弃整棵组件树。
- 顶栏提供一键明暗切换；**偏好同时写入 localStorage 与服务端**：本地那份保证首帧不闪烁，服务端那份保证换设备/换浏览器后仍然生效。本地已有显式选择时，服务端值不会覆盖它。

### ECharts 的主题桥接

ECharts 把颜色画进 canvas，**读不到 CSS 变量**。因此图表配置里用 `'@token:label'` 这样的语义占位符，由 `src/lib/chartTheme.ts` 在渲染时（并随主题变化重算）解析成当前主题的实际色值。这样图表轴线与标签会跟页面一起切换，而不是停留在亮色配色。

### 移动端适配

- 控制台外壳：`lg` 及以上为固定侧栏，`lg` 以下变为**抽屉 + 遮罩**，汉堡按钮唤出，路由变化自动关闭，抽屉打开时锁定 body 滚动并支持 Esc 关闭。
- 表格：外层 `overflow-x-auto`，窄屏收起次级列，标题列 `min-w-0 truncate`，操作按钮换行 —— 靠容器横向滚动兜住，**不给页面制造横向溢出**。
- 弹窗/抽屉：手机上是底部弹出抽屉、桌面恢复居中卡片；高度用 `dvh` 而非 `vh`（移动浏览器地址栏会让 `vh` 算错，导致底部按钮被裁掉）。
- 触屏：可点击元素使用 `touch-target`（触屏下保证 ≥44px 可点区），输入框在手机上不小于 40px 且字号 `text-base`（iOS 上小于 16px 会在聚焦时自动放大页面），底部固定元素用 `pb-safe` 避让 iPhone 横条。
- 有专门的浏览器实测脚本（`scripts/verify-design.mjs`）在 375px 视口下逐页断言**页面无横向溢出**，并覆盖亮暗两套主题与抽屉交互。

---

## 快速启动

```bash
git clone <仓库地址>
cd RAG-Management-Platform

# 可选：从模板生成 .env（不生成也能用内置默认值启动）
cp .env.example .env

docker compose up -d --build
```

启动后访问：

| 入口 | 地址 |
| --- | --- |
| 平台前端 | http://localhost:8080 |
| API 文档（Swagger） | http://localhost:8080/docs |
| 健康检查 | http://localhost:8080/api/health |

首次启动自动完成：创建 `vector` / `pg_trgm` 扩展 → Alembic 迁移建表 → 初始化权限目录、部门树、角色、账号与 5 份示例知识文档（含解析、切片、向量化与四维权限配置）。初始化是**幂等**的，可安全反复启动。

> **镜像源说明**：默认把基础镜像源指向国内可达镜像（`docker.m.daocloud.io` + `registry.npmmirror.com`），因为部分网络环境无法直达 Docker Hub，`auth.docker.io` 超时会导致构建直接失败。若你的网络可直连 Docker Hub：
>
> ```bash
> docker compose build --build-arg PY_REGISTRY=docker.io --build-arg NODE_REGISTRY=docker.io \
>                      --build-arg NPM_REGISTRY=https://registry.npmjs.org
> ```

停止与清理：

```bash
docker compose down        # 停止，数据保留
docker compose down -v     # 停止并清空数据（示例数据会重新导入）
```

---

## 演示账号

| 账号 | 密码 | 部门 | 角色 | 用途 |
| --- | --- | --- | --- | --- |
| `admin` | `admin123456` | 信息技术部 | 超级管理员 | 全部权限 |
| `kadmin` | `kadmin123456` | 信息技术部 | 知识管理员 | 导入、切片、权限配置、FAQ 审核 |
| `finance01` | `demo123456` | 财务部 | 普通用户 | 可读财务部共享知识 |
| `hr01` | `demo123456` | 人力资源部 | 普通用户 | 可读人力资源部共享知识 |
| `cs01` | `demo123456` | 客户服务中心 | 普通用户 | 客服场景 |
| `sales01` | `demo123456` | 客户服务中心 | 普通用户 | 配合演示「个人专属」授权 |
| `manager01` | `demo123456` | 总部 | 管理层 | 命中角色授权，可查看看板 |

### 推荐的权限隔离演示

用 `sales01` 登录 AI 问答工作台：

1. 问「**差旅报销标准里，一线城市住宿费上限是多少？**」→ 正常回答，附引用溯源卡片
2. 同一会话追问「**高管薪酬与股权激励细则里，基本年薪 M5 是多少？**」→ 回答中出现「检测到相关制度文档，但您当前所属部门/角色无权查阅该内容」，且不泄漏正文

换 `manager01` 问第 2 个问题，因为命中「管理层」角色授权，可正常获得内容 —— 一组对照即可说明四维权限的 OR 判定与鉴权过滤。

---

## 接入大模型

**不配置任何 Key 时平台仍可完整跑通**：`EMBEDDING_API_KEY` 为空时启用内置确定性哈希嵌入，`LLM_API_KEY` 为空时启用离线兜底回答（用已鉴权通过的切片拼装摘要，链路与 SSE 事件完全一致）。

接入真实模型只需编辑 `.env` 后重启 api：

```env
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=sk-xxxxxxxx
LLM_CHAT_MODEL=deepseek-chat
```

```bash
docker compose up -d --force-recreate api
```

验证是否生效：

```bash
curl http://localhost:8080/api/health
# "llm_key_configured": true 即表示已接入
```

切换供应商只需改 `LLM_BASE_URL` 与 `LLM_CHAT_MODEL`，例如：

| 供应商 | base_url | 模型示例 |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| 本地 Ollama | `http://host.docker.internal:11434/v1` | `qwen2.5:7b` |

> **关于向量化**：`EMBEDDING_API_KEY` 是独立开关。启用远程嵌入后检索质量会明显提升，但**必须重建索引**，且 `EMBEDDING_DIM` 需与库表向量维度一致（建表时按 `EMBEDDING_DIM` 固化）。修改维度后请执行 `docker compose down -v && docker compose up -d --build` 重建，或对已有文档调用 `POST /api/knowledge/documents/{id}/reindex`。

---

## 核心设计

### 四维权限的 OR 判定

判定条件由 `backend/app/services/permission.py::build_grant_condition` 构造，命中任一实体即放行：

```python
clauses = [KnowledgeGrant.scope == "global"]
if ctx.department_id:                      # 部门维度
    clauses.append(and_(scope == "department", subject_id == ctx.department_id))
if ctx.role_ids:                           # 角色维度
    clauses.append(and_(scope == "role", subject_id.in_(ctx.role_ids)))
clauses.append(and_(scope == "user", subject_id == ctx.user_id))   # 个人维度
return or_(*clauses)
```

权限配置即时生效：鉴权按数据库实时判定，无需额外刷新缓存。

### 混合检索与打分

`pgvector` HNSW 余弦召回（权重 0.65）+ PostgreSQL 全文/三元组关键词召回（权重 0.35）融合打分。

中文关键词侧由字符 bigram 生成 `tsquery` 词项，规避中文分词器依赖。

### 阈值按嵌入模式自适应

本地哈希嵌入与真实语义嵌入的**余弦分布尺度完全不同**。若统一使用 `0.86` 这类高阈值，会出现「聚类不出高频问题」与「FAQ 缓存永不命中」两个故障同时发生。因此按嵌入模式自动取值（可用环境变量覆盖）：

| 参数 | 本地哈希嵌入 | 远程语义嵌入 |
| --- | --- | --- |
| 置信度阈值（未命中判定） | 0.14 | 0.30 |
| FAQ 聚类相似度 | 0.45 | 0.86 |
| FAQ 缓存命中相似度 | 0.55 | 0.92 |

FAQ 缓存命中分不是单纯余弦，而是 `max(余弦, 0.55×余弦 + 0.45×词面重叠系数)`。加入词面信号后，同义改写的召回明显改善（实测同义问句 0.44~0.98，跨主题问句全部 ≤0.05）。

### 检索精度的三层收紧

混合检索做了三层防护，缺一层就会出问题：

1. **关键词相关性门槛**：`simple` 分词器会把中文标题当作**一个词元**，查询侧拆成字符 bigram 后往往只命中 1 个词元；若把「命中 1 个词元」当噪声丢掉，正相关文档也会被误杀。现采用「整句 trigram > 0.12」**或**「命中词元数 ≥2 且 ≥ 最佳命中的 15%」双条件。
2. **两路分数各自归一化**：向量相似度的绝对值依赖嵌入模型（同样相关内容，本地哈希嵌入约 0.2，真实语义模型约 0.7），用绝对阈值裁剪会让本地模式整批丢结果。
3. **相对 + 绝对双重截断**：融合分低于「最高分 × 0.35」的候选丢弃，但**保留**原始相似度仍达标（本地 0.08 / 远程 0.30）的候选。

第 3 条是必需的：只按相对分截断会误伤「确实高度相关、但当前用户无权访问」的候选，用户就再也收不到权限受限提示了；反过来说，若不截断，召回集里混进一篇无关的无权文档，就会让正常提问也弹出权限提示（误报）。

### SSE 与数据库会话的生命周期

流式问答接口**刻意不使用 `Depends(get_db)`**：FastAPI 的依赖清理（yield 之后的 commit）发生在响应发送完毕之后，而 `StreamingResponse` 的生成器是在响应期间被消费的 —— 那样写会在流结束前就收走会话，导致审计落库丢失或生成器中途报错。因此 `backend/app/api/chat.py` 在生成器内部 `async with SessionLocal()` 自行提交、自行回滚、自行关闭。

### 流式问答的 SSE 事件

`POST /api/chat/ask` 返回标准 SSE 流：

| 事件 | 载荷 |
| --- | --- |
| `meta` | 会话 ID 与用户信息 |
| `tool` | FAQ 缓存命中明细（命中时） |
| `citations` | 引用溯源列表（文档、相关度、片段） |
| `restricted` | 权限受限明细与提示文案 |
| `authz` | 召回/放行/拦截的完整鉴权明细 |
| `delta` | 回答文本增量（多次） |
| `done` | Token 用量、耗时、命中来源等汇总 |
| `error` | 异常信息 |

---

## 端到端验收

项目内置覆盖全部验收标准的自动化脚本：

```bash
docker compose exec api python -m app.verify
```

脚本会真实登录各角色账号、上传文档、配置四维权限、验证 OR 判定与鉴权拦截、审核发布 FAQ、验证缓存直出与知识缺口闭环，逐项打印 ✓/✗，退出码 0 表示全部通过。脚本可重复执行（内含幂等清理）。

另有交付自检脚本（反代链路、前端静态资源、AI 配置）：

```bash
python scripts/selfcheck.py http://localhost:8080
```

---

## 目录结构

```
RAG-Management-Platform
├─ docker-compose.yml              四服务编排
├─ .env.example                    全部可调参数
├─ infra/
│  ├─ db/init/01-extensions.sql    pgvector + pg_trgm
│  └─ nginx/nginx.conf             反代 + SSE 关闭缓冲
├─ backend/                        FastAPI 服务（Python 3.12）
│  ├─ Dockerfile / entrypoint.sh   等待 DB → 迁移 → 种子 → 启动
│  ├─ alembic/versions/            建表 + HNSW/GIN 索引
│  ├─ seed_data/                   5 份示例知识文档
│  └─ app/
│     ├─ main.py                   应用入口 / 健康检查
│     ├─ models.py                 数据模型
│     ├─ schemas.py                请求响应模型
│     ├─ seed.py                   幂等初始化
│     ├─ verify.py                 端到端验收脚本
│     ├─ api/                      auth · admin · knowledge · chat · dashboard · faq · config
│     ├─ core/                     config · db · security
│     └─ services/                 document 解析切片 · embeddings · retrieval 检索 ·
│                                  permission 鉴权 · chat 问答 · mining 挖掘 · faq_cache 缓存
├─ frontend/                       Next.js 16 控制台
│  └─ src/
│     ├─ app/(console)/            dashboard · chat · knowledge · sedimentation · system
│     ├─ components/               表格 · 抽屉 · 权限弹窗 · 引用卡片 · 图表 · Markdown
│     └─ lib/                      api 客户端 · auth · SSE 解析器 · 权限工具
└─ scripts/                        环境初始化 · 交付自检 · 界面截图
```

---

## 常见问题

**Q：8080 打不开。**
先确认四个容器都是 `Up`：`docker compose ps`。`kb-api` 处于 `health: starting` 时再等 20 秒（它需要先连上数据库）。仍然失败就看日志：`docker compose logs api --tail 50`。

**Q：改了 `.env` 为什么不生效。**
`.env` 是容器启动时注入的环境变量，`restart` 不一定重新读取，用 `docker compose up -d --force-recreate api`。

**Q：必须配 API Key 吗。**
不必须。不配 Key 时平台用内置离线模式，权限隔离、检索、鉴权、FAQ 沉淀等全部功能均为真实执行，只是答案是模板化摘要。

**Q：`git push` 提示认证失败。**
GitHub 已不接受账号密码。使用 SSH 地址（`git@github.com:...`）并确保本机 SSH key 已添加到 GitHub，或改用 Personal Access Token。

---

## 已知限制

1. **中文关键词召回偏弱**：`simple` 分词器不切分中文，词项侧主要依赖字符 bigram，长标题常整段成为一个词元。生产环境建议安装 `zhparser` / `pg_jieba` 扩展或改用真正的语义嵌入模型。
2. **部门数据权限仅含直属部门**：用户只继承自己所属部门的授权，不含上级部门继承。若需要「本部可读下级部门」语义，需在 `build_grant_condition` 中补上部门闭包。
3. **离线回答的表格是原样拼接**：离线兜底直接引用切片原文，切片里的 Markdown 表格是 `| a | b |` 单行形式，渲染观感不如模型整理过的结果。
4. **未做并发压测**：未验证 HNSW 索引在十万级切片下的召回率与延迟表现。
5. **未内置单元测试**：后端验证主要依靠端到端验收脚本；前端验证方式是 TypeScript 严格类型检查、生产构建与真实浏览器渲染。

---

## License

[MIT](LICENSE)
