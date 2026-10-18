# todos.dev 复刻 · Free 档

多智能体协作控制平面的功能复刻。**不含任何收费功能**。

侦察材料：
- `../recon-live/` —— **当前事实源**。25 篇从 `https://todos.dev/docs/*` 实抓的正文、
  `DESIGN-TOKENS.md`（`getComputedStyle` 实测的设计令牌）、
  `GAP-ANALYSIS.md`（逐项缺口对照与交付记录）。
- `../recon/` —— **历史快照**，已过时且不完整（曾据此把主题方向搞反）。

本目录是可运行的实现。

---

## 当前进度

| 阶段 | 状态 | 说明 |
|---|---|---|
| 0 脚手架 | ✅ | monorepo / Postgres 16 / TS strict |
| 1 Auth + Team | ⬜ | Google OAuth |
| **2 机器协议** | ✅ | enroll / claim / heartbeat / changes / done / token / tool / presence / recover / stream |
| **3 Claude Code driver** | ✅ | stream-json 解析 + 流式帧 + 中断 + safe-mode 隔离 |
| **omp driver** | ✅ | `--mode=json` NDJSON，协议实测确证（v18.2.11） |
| codex driver | 🟡 | **诚实 stub** —— 本机未装 codex，协议未实测，run 返回明确错误 |
| **4 Project + Todo + 双闸门** | ✅ | 状态机 + 持久层 + 业务 REST 端点（闸门强制走 transition）|
| **git 隔离执行** | ✅ | mirror clone → build 分支 → 独立工作区 → commit → diff → **push 到真远端**（两跳：工作区→镜像缓存→真 URL，用 `git ls-remote` 读远端 tip 与 HEAD 对账，**退出码 0 不算成功**；非 fast-forward 如实报 `push_error` 不 force。见 `apps/daemon/src/git.ts` 的 `pushBranch`，4 条集成测试）|
| **Web 看板** | ✅ | Next.js 15；**卡片可拖拽改相位**（乐观更新 + 失败回滚 + 中文原因）；SSE 实时；两道闸门视觉突出（2026-10-18 补齐拖拽） |
| **Web 设置区** | ✅ | 团队切换外壳 + **18 页全部浏览器实测**（2026-10-18）。补页根因是 `services/{agents-admin,projects-admin,secrets,connections}.ts` 的 CRUD 早已写好但**只有 MCP 侧调用、没有 REST 入口**。身份统一走 `GET /api/user/context`；写路径的 `userId` **由 BFF 从 cookie 注入**，前端不发（见 `apps/web/web-ui.md`） |
| **Needs you 待决** | ✅ | 原站看板第三列（Backlog / In progress / **Needs you** / Done）的语义是「所有等你决策的事」：plan 确认、changes 验收、failed run、有回复/有提问的任务。端点 + 专视图页 + 侧栏 Workspace 角标（2026-10-18）。⚠️ 不是通知中心 |
| **生命周期** | ✅ | reopen / rerun（Start over）/ **Continue**（同一 build 重试失败轮）/ **Reuse plan**（复用上次计划）+ 构建历史（2026-10-18） |
| **实时对话** | 🟡 | composer + **steering 队列**（投递顺序编号、可编辑/撤回、已送达标记）。⚠️ 服务端无消息级 SSE 事件，当前 4s 增量轮询兜底，UI 已如实标注 |
| **Connections 目录** | ✅ | 23 条官方应用目录（21 远程 + 2 本地预设）+ 分类筛选。⚠️ 5 条 endpoint 未经厂商文档核实（UI 已标注）；一键 OAuth 未接通（UI 已标注） |
| **Agent Memory** | ✅ | CRUD 三端点 + agent 详情页 Memory tab。修掉「agent 没有 chief 行 → 404」导致 Web 建的所有 agent 上 Memory tab 必然不可用的 bug |
| **Chief 并排 Workspace** | ✅ | 原站首页主形态：对话左 / 看板右 / **可拖分割线**（鼠标 + 方向键 + localStorage）。看板从 9 个内部相位列**改回原站的 4 列**（Backlog / In progress / Needs you / Done）。快捷键 ⌘⌥B 显隐看板、⌘⇧Enter 折叠对话（2026-10-18） |
| **rewind / restore** | ✅ | 写 `builds.pending_restore`（该字段此前**在 schema 里但零读写方**）。只在 confirm/review/failed 可用、turn 运行中不可、仅 owner。⚠️ 只入库不真回滚 —— worktree/session 要 daemon 支持，UI 如实说明（2026-10-18） |
| **机器管理** | ✅ | 机器列表 + 接活/远端 Shell 开关 + 并发上限 + 删除（级联后果写进确认框）。⚠️ enroll 要求入网凭据**名字字面等于 team id**，已写进空状态提示 |
| 配额校验 | ✅ | Free 档 12 项上限 + memory 注入预算裁剪 |
| 调度器求值 | ✅ | 4 种规则 + 时区 + 错过不补跑 + 跳过条件 |
| 通知策略 | ✅ | 收件人恒为 owner，Chief 不重复推 |
| 权限模型 | ✅ | 核心工具免授权 + 高影响工具逐项开关 + Chief 不自行授予 |
| **6 Chief** | ✅ | prompt 三段式 + 58 工具 + 派工/看门 + 8 个 REST 端点 |
| **内置 pi runtime** | ✅ | driver + provider 目录 + claim 下发全打通；**真跑一轮 turn**（本地 Ollama qwen3:14b，读文件→写文件→结果正确） |
| **8 MCP 入站** | ✅ | JSON-RPC 2.0 + 按 key 的工具授权；MCP 面 **31 个工具**（读 13 / 写 18，全部是 Chief 58 的子集）—— **31 个现已全部接线**（2026-10-17 收尾：read 9 `agents` `machines` `projects` `todos` `skills` `schedules` `secrets` `mcp_servers` `conversation` + todo 生命周期 5 + 调度 2 + 凭据 7 + build 生命周期 5 + 消息 1 + 附件 1 + GitHub 3）。薄壳与 REST / Chief / 机器协议**共用服务层**（`services/{schedules,conversations,secrets,connections,builds,attachments,github}.ts`），所以 cron 校验、10 条上限、20 条连接上限、secret 50 条/scope、admin 闸门、闸门铁律、写阅契约、token 不泄漏两边必然一致。**未实现的工具返回已消失**：调一个不在 31 个里的名字，措辞是「does not exist on this MCP server」而不是「还没实现」 |
| **skill 管理** | ✅ | CRUD + 磁盘落盘 + agent 绑定 ≤10（15 测试） |
| **schedule** | ✅ | CRUD + 复用 cron/时区校验（14 测试） |
| **Web PWA** | ✅ | manifest 逐字一致 + 46 张 splash + sw.js 还原 + 图标字节一致 |
| **Web token 认证** | ✅ | httpOnly cookie + BFF 守卫（单人简化版） |
| **SSE 实时层** | ✅ | 原站双路径 + seq 断线续传 + team/todo 双发；浏览器实测收到 `phase_changed` |

> ⚠️ **架构纠错（2026-10-16）**：先前 SPEC §7 写「Free 下没有内置 runtime，只能外部 runtime」是**错的**。
> 原站 `docs/runtimes.md` 首段：「The default is Todos' **built-in runtime (pi)**, with models from
> **the team's providers**: the team's own API keys and subscriptions are billed by their vendor,
> and only **Pro's built-in models** draw team credits.」
> 被砍的应是「平台赠送模型（消耗 credits，Pro）」，**不是**「pi 内置 runtime + 自有 key（Free 可用）」。
> 完整依据与执行顺序见 `D:/AI/todos/ROADMAP.md`。

### 已验证的端到端链路（真实执行，非 mock）

```
daemon claim
  → Claude Code 在隔离 git worktree 真实写文件
  → commit bce130fd
  → diff 抓取落库（Changes 文档，版本化）
  → todo 自动进入 review 闸门
  → 审计双轨记录 + 7 类 SSE 事件
  → Web 看板实时显示，闸门列橙色高亮
```

**分支隔离已验证**：build 跑在 `tds/conv-<buildId>` 分支，源仓库始终干净。

### 真实模型跑一轮 build（2026-10-17 实测，非 mock）

用本机 Strata（`127.0.0.1:8080`，`qwen3.8-flash-next-iq2_xs`）真跑，**连跑两遍结果一致**：

```
MCP run_builds → phase=planning
daemon claim → workspace ready（分支 tds/conv-<buildId>）
pi runtime 调模型 62s → 真写 hello.js
git commit 5279dd16 — 1 files, +1/-0
POST done → todo 落 confirm（plan-first 语义：先批计划才实施）
changes 文档 v1 带完整 diff；源仓库 status='' head='6f4732c init'（干净）
```

脚本：`apps/server/test/e2e-daemon-turn.ts`（自清理）。配套的
`e2e-review-settle.ts` 验的是本次修掉的那个 bug（`reviewing` 跑完回 `confirm` 而不是 `review`）。

**一个实测观察**：这一档模型**经常回空 `text`** —— 预算花在 `reasoning_content` 与写文件上，
总结那句没写出来，于是 `build_message` 是 0 条。但 commit / diff / changes 文档 / done 全都到位，
**断链不在链路，在模型没写总结**。所以 e2e 断言的是「文件真被创建」，不是「模型一定写总结」。

### 前端浏览器实测（2026-10-17，非 curl 断言）

真实 Chromium 登录 `devtok`，对着真 Postgres 逐项点：

| 动作 | 结果 | 库内核对 |
|---|---|---|
| 看板 | 9 列全有数据，SSE「● 实时连接已建立」 | — |
| 设置区四页 | 全部渲染出真实数据，**0 条页面错误** | — |
| 新建 todo | 表单提交 → 跳 `/todo/{id}` | `todo.seq_num=100`，`created_by` 正确 |
| 点「批准」 | `confirm` → `implement` | `todo.phase='implement'` |
| 闸门内打 `confirm` 提交反馈 | 显示「反馈已提交」，**无**「已推进」提示 | `phase` 仍为 `review`，`build_message` 落 1 条 |
| 建 skill | 表单提交成功 | `skill` 落库 + `SKILL.md` 真落磁盘 |
| 建 provider（BFF 注入 userId） | 浏览器不发 userId 仍写入成功 | `provider.created_by` = cookie 身份 |
| 停掉后端 | 侧栏 + 内容区各给一条可执行提示，**不白屏** | — |

降级与身份两条契约也各自实测过：`userId:''` → 422，浏览器不发 → BFF 注入 → 200。

---

## 测试：1054 个，1053 通过 + 1 skipped（Codex 未装），0 失败

> 2026-10-18 实测重测：server **962/962**、protocol **39/39**、daemon **53**（52 pass +
> 1 skipped）。上一行那句「1006 / server 911 / protocol 46 / daemon 49」是 2026-10-18
> 早先一次统计，已过期 —— 下方分模块明细按当次口径保留为历史账，不覆盖。
>
> 相比上一轮的变化：server 911 → 962（新增 todo 端点切片的 documents 单文档 3 条 +
> 其余切片补齐）、daemon 49 → 53（新增 `pushBranch` 四条集成测试：真仓库 tip 对账、
> 重复 push、非 fast-forward 不覆盖、远端不可达如实报错）、protocol 46 → 39
> （测试合并/重命名，断言数不变）。

```
packages/protocol   46  状态机闸门铁律 29（含 AI 交叉评审 5 + 闸门 fail/cancel 2）+ Free 档配额 17
apps/server        801  Chief 143（cards 22 + dispatch 52 + prompt 32 + routes 22 + tools 15）
                       + MCP 入站 33 + MCP 写类工具 96 + skill CRUD 18 + schedule CRUD 17
                       + **SSE 事件层 13** + todo 创建三路径 14 + phase 拒绝 10 + todo 路由 16
                       + provider 目录 21 + provider→claim 3 + **API keys 14** + **secret 注入 6** + **build 生命周期与消息 34** + **机器 done 收敛 10** + **GitHub 服务层 20** + **GitHub MCP 入口 14**
                       + **attachment 服务层 16** + **attachment 入口 9**
                       + **Chief 执行器闸门 12** + **Chief registry 接线 5** + **Chief HTTP 入口 9**
                       + **Chief agents 20** + **Chief projects 10** + **Chief memory 14**
                       + **Chief interaction 8** + **skill 删除 7** + **路径防御 7**
                       + **Chief 模型调用 25** + **Chief tool-calling 循环 12**
                       + **Chief turn 持久化 13** + **Chief turn 端点 10**
                       + **Chief provider 工具 19** + **Chief 连接工具 14** + **Chief todo 生命周期 8**
                       + 错误处理 9 + 凭据加密 18
                       + 调度器 19 + 记忆 19 + 通知 15 + 权限 20
apps/daemon         49  pi 内置 runtime 12 + cmd 转义 11 + shell 绕行 9 + git 隔离 13
                       + 状态机（共享）+ 1 skipped（Codex 未装）
```

```bash
cd packages/protocol && npx tsx --test test/*.test.ts
cd apps/server     && npx tsx --test test/*.test.ts
cd apps/daemon     && TDS_HOME="$(pwd)/.test-tds-home" npx tsx --test test/*.test.ts
```

### Chief 专项验证（需先启动 server + PostgreSQL）

```bash
cd apps/server
npx tsx test/chief-smoke.ts   # 工具面 / prompt 体积 / 授权解析 / 卡片 / 表结构
npx tsx test/chief-e2e.ts     # 真实 HTTP 建 Chief → 建 topic → 派工 → 校验分支命名（自清理）
npx tsx test/diff-document-e2e.ts  # 机器上报 → diff 落 changes 文档 → 版本递增（自清理）
npx tsx test/gate-law-e2e.ts  # 闸门铁律端到端：越权试探 + 主按钮推进（自清理）
```

---

## 跑起来

### 数据库
```bash
# 本机便携 Postgres（仓库 .local/pgsql 有 16.10）
# 数据目录 C:/Users/<user>/tds-pgdata，端口 5433
# 或用 Docker: docker compose -f infra/docker-compose.yml up -d postgres

cd packages/db
DATABASE_URL="postgres://tds@127.0.0.1:5433/tds" npx drizzle-kit generate
# 依次应用 drizzle/*.sql
```

### server
```bash
cd apps/server
DATABASE_URL="postgres://tds@127.0.0.1:5433/tds" npx tsx src/main.ts
# → http://127.0.0.1:4000
```

### daemon
```bash
cd apps/daemon
npx tsx src/cli.ts status                       # 注册状态 + runtime 探测
npx tsx src/cli.ts start --api-key <tds_...> --team <id>   # 首次入队
npx tsx src/cli.ts start                        # 复用注册
npx tsx src/cli.ts logout                       # 清除注册（保留设备指纹）
```

### e2e 冒烟
```bash
cd apps/server
npx tsx test/seed-git-e2e.ts          # 建 team/project/todo/build/step
# 用返回的 enrollKey + teamId 启动 daemon
# 观察 diff 落库：
node -e "const p=require('postgres');(async()=>{const s=p('postgres://tds@127.0.0.1:5433/tds');
console.log((await s\`SELECT payload FROM document WHERE kind='changes'\`)[0].payload)})()"
```

## 鉴权现状（读代码前先看这条）

- **REST 层已鉴权（2026-10-17 落地）**：`apps/server/src/main.ts` 装了一条全局
  `preHandler`，除 `/api/health`、`/api/mcp`（自己按 key 鉴权）与 `/api/machine/*`
  （machine token，另一套体系）之外，所有 `/api/*` 都必须带凭据；身份写进 `req.ctx`，
  各路由再用 `src/auth.ts` 的 `requireTeamMembership` / `requireTeamAdmin` /
  `actorForTeam` 判归属 —— **不再无条件信 `body.teamId` / `body.userId` /
  `body.ownerMemberId`**。SSE 的 scope 同样按团队归属校验（`src/sse.ts`
  `authorizeScope`），缺 `?scope=` 直接 400（以前默认订阅字面量 `'team'`，
  那是个没人 publish 的 scope，连上去永远只收到 ping）。
- **两种凭据**：`Authorization: Bearer tds_...`（API key → `userId` + scopes）与
  `TDS_WEB_TOKEN`（cookie `tds_token` 或 `?token=`，映射到 `TDS_WEB_USER` 指定的
  email，没配就取库里最早的用户）。SSE 发不了 header，只能走后者。
- **401 / 403 的界**：凭据缺失或错误 → 401；凭据有效但团队不是他的 → 403
  （`team "<teamId>" is not accessible to this key's owner`，与 MCP 的
  `assertTeamIn` 同措辞）；客户端显式传的 `userId` 必须等于 key 所有者，否则
  403（`userId "<x>" is not this key's owner`）—— 以前这些端点判的是「这个随便填的
  userId 在不在团队里」，A 团队的 key 传 `userId=B` 就能借 B 的 admin 角色去写。
- **实测证据**（同机两进程，`TDS_WEB_TOKEN=devtok`）：后端 `GET /api/todos` 无凭据 →
  `401 {"error":"invalid or missing web token"}`，带 `Cookie: tds_token=devtok` →
  `200 {"todos":[]}`；`/api/health` 无凭据 → `200`（skip-list 契约）；经 BFF
  `http://127.0.0.1:3000/api/todos` 无 cookie → `401 {"ready":false,"reason":"unauthorized"}`，
  带 cookie → `200 {"ready":true,"data":[]}`。`apps/server` 测试 425 → **443/443**，
  新增的 18 条都是「无凭据 → 401」「A 团队的 key 打 B 团队的资源 → 403 且库里没写」
  这类，且做过变异验证（把 `requireTeamMembership` 改成空操作后 6 个测试文件各至少
  红 1 条，skills 红 2）。
- `HOST` 绑到非 loopback 且**没配** `TDS_WEB_TOKEN` 时 `main.ts` 启动打 warning：
  只有 Bearer key 能过，Web 客户端会 401。

---

## 结构

```
clone/
├── packages/
│   ├── protocol/          契约层
│   │   ├── enums.ts            全部枚举（实测对齐）
│   │   ├── state-machine.ts    todo 状态机 + 闸门铁律
│   │   ├── machine-api.ts      机器协议 schema + 端点
│   │   ├── runtime-ids.ts      17 个 runtime 注册表
│   │   ├── entities.ts         领域实体 + FREE_LIMITS
│   │   └── quota.ts            Free 档配额 + memory 预算裁剪
│   └── db/                Drizzle schema（29 张表）
├── apps/
│   ├── server/            Fastify
│   │   ├── routes/machine.ts   机器协议端点
│   │   ├── sse.ts              SSE 事件层
│   │   ├── crypto.ts           AES-256-GCM + API key
│   │   └── schedule.ts         调度求值
│   └── daemon/            tds CLI
│       ├── git.ts               隔离工作区：clone/branch/commit/diff
│       ├── worker.ts            claim → 执行 → commit → 上报
│       └── drivers/             Runtime 契约 + Claude Code
└── infra/docker-compose.yml
```

---

## 踩过的坑（都已加回归测试）

**0. Fastify 错误处理器的注册顺序** —— `setErrorHandler` 只作用于「调用时刻
已存在的路由」。写在路由注册之前会**静默失效**，所有 404/409/422 全变成
500 `{"error":"internal error"}`。已收敛到 `src/http.ts` 的
`installErrorHandlers()`，在全部路由注册后调用；`test/error-handling.test.ts`
同时锁死状态码行为和顺序契约。

**1. 闸门铁律** —— 输入框打 `confirm` 也只是修订反馈，必须点主按钮。
`packages/protocol/test/state-machine.test.ts` 锁死，
`test/gate-law-e2e.ts` 走真实 HTTP 再验一遍（含越权试探）。

**2. Windows shell 会毁掉参数** —— `shell: true` 时 cmd.exe 二次解析命令行，
把 prompt 里的引号/换行/`& | >` 全部吃掉。agent 收到残缺任务**却报 succeeded**。
解法：`whichCommand()` 拿绝对路径 + `shell: false` 直接 spawn。
`apps/daemon/test/shell-bypass.test.ts` + `quoting.test.ts` 锁死。

**3. 未跟踪文件会污染 rerun** —— `git reset --hard` 不清 untracked，
上个 build 的残留会进到新 build。必须 `git clean -fdx`。
`apps/daemon/test/git.test.ts` 锁死。

**4. 凭据永不落机器磁盘** —— claim 响应带一次性凭据，用完即弃。
API key 只存 HMAC-SHA256。`apps/server/test/crypto.test.ts` 锁死。

**5. buildId 就是分支名** —— 实测原站 `branch === "tds/conv-" + buildId`，无 slug。

---

## 与原站的实测差异

侦察发现的 12 处文档未提及事实见 `../recon/03-app-api.md` §4。
影响实现的三个：

| 项 | 文档 | 实测 |
|---|---|---|
| 实时层 | 未说明 | **SSE，不是 WebSocket** |
| 内部相位 | `Building`/`To Do` | `implement`/`todo` |
| 前端形态 | 暗示 Next.js | 应用本体是 Expo/RN-web 单页应用 |

---

## 三轮补齐（2026-10-17/18）修掉的真 bug

这些**都是实测发现的**，不是靠读代码想出来的。每条都有对应的回归断言或浏览器实测记录。

| # | bug | 症状 | 为什么测试全绿时仍漏了 |
|---|---|---|---|
| 1 | `.strict()` zod schema 未声明 `userId` | 机器页每次开关都报「写入被拒」 | `proxyWrite` 是 BFF 行为，服务端测试不走 BFF |
| 2 | 「agent 没有 chief 行 → 404」 | Web 建的所有 agent 上 Memory tab 必然不可用 | 服务端测试的 fixture 每个 agent 都配了 chief |
| 3 | 侧栏 Workspace 折叠是 no-op | 点折叠按钮没反应 | `setCollapsed((c) => c)` 语法合法、无报错 |
| 4 | ⌘B 双监听互相抵消 | 按快捷键完全没反应，**零报错** | 合成事件测不出「两个监听器」；必须真实 `page.keyboard` |
| 5 | 三个页面在侧栏没有入口 | machines / connections / needs-you 只能手敲 URL | 页面存在即「已实现」，但没人能从 UI 到达 |
| 6 | enroll 凭据必须「名字字面等于 team id」 | 正常命名 → 401，错误信息不提名字 | 约束藏在服务端 SQL 谓词里，文档没写 |
| 7 | Chief topic 未派工时 messages 返 403 | 对话面板对所有新 topic 显示「数据未就绪：http-403」 | 既有文档写的是「返空不 500」，实现与文档相反 |
| 8 | `chief.charter` 是 null 但类型写成 string | `/settings/chief` 整页白屏 | **tsc 0 错误 + 911 个服务端测试全绿，该页面照样崩** |

第 8 条最值得记：**「tsc 通过」只证明前后端类型一致，不证明类型与真实响应一致。**
声明可以是错的 —— 凡是可选字段都要真打一次后端看形状。本仓库的 `ChiefInfo.charter`
就是照 schema 想当然写成 `string`，而 API 对没写过 charter 的团队返回 `null`。

第 7 条的修法值得记：放宽「查不到」时**必须同时加一条「查到但跨团队仍 403」的测试**，
否则放宽会悄悄变成鉴权洞。

另外两处**我自己的错误**（已记录在 `../recon-live/GAP-ANALYSIS.md` 顶部）：
把「Needs you」误读成 Inbox 通知中心（实为看板第三列）；
brief 里说 `withPlan` 能表示「产出过计划」（实为 `planFirst` 的透传，真信号是 `builds.planDocId`），
错误前提传导到了子代理的实现里。

### 一个值得记住的排查手法

**「按了没反应」类问题必须用真实按键测**：

```ts
// ❌ 测不出「两个监听器各翻一次 state」
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }));

// ✅ 真实 CDP 按键
await page.keyboard.down('Control');
await page.keyboard.press('KeyB');
await page.keyboard.up('Control');
```
