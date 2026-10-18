# Web UI 交付说明

> **2026-10-18 更新（三轮补齐后）**：第一轮设置区 + Agents + Projects；
> 第二轮补完拖拽改相位、生命周期（reopen/rerun）、机器页、Agent Memory；
> 第三轮补完 Needs you、composer + steering 队列、Continue/Reuse plan、
> Connections 应用目录、合并确认框 + 文档预览 + 版本对比。
> 下列内容与仓库现状逐条对齐，**不是设计稿**。

## 页面清单（2026-10-18 实测，18 页）

```
apps/web/src/app/
├── layout.tsx                    根布局（PWA 元数据 + AuthGate + AppShell）
├── AuthGate.tsx                  全局登录守卫：未登录不渲染任何业务内容
├── page.tsx                      Workspace 首页（Chief 对话 + 看板 + 可拖分割线）
├── login/page.tsx                单人 token 登录（支持 ?next= 站内回跳）
├── new-todo/page.tsx             新建 todo（项目/agent 下拉 + planFirst 等开关）
├── needs-you/page.tsx            待你处理（Needs you 列的专视图，按闸门/失败分组）
├── todo/[id]/page.tsx            todo 详情（头部 / 闸门区 / 消息流 / 终态横幅 /
│                                 Continue·Reuse plan / 构建历史 / Plan·Changes 文档 /
│                                 版本对比 / composer + steering 队列 / 验收清单）
├── agents/                       ← 顶层路由，原站把 agent 放团队页而非设置页
│   ├── layout.tsx                复用 settings/team-shell.tsx
│   ├── page.tsx                  agent 名册（卡片 + 新建）
│   └── [agentId]/page.tsx        agent 详情（profile / Overview / Access / Memory 三 tab）
└── settings/
    ├── layout.tsx                只 default 导出，内包 <TeamShell>
    ├── team-shell.tsx            团队切换 + 导航（与 /agents 共用）
    ├── settings-placeholder.tsx  「未就绪」占位 + teamNeedsPlaceholder 布尔判定
    ├── api-keys/                 API keys
    ├── projects/                 项目 CRUD（新建 todo 依赖它）
    ├── providers/                Providers（增删改 + 模型目录）
    ├── skills/                   Skills（增删改 + 分配给 agent）
    ├── connections/              应用目录（23 条：21 远程 + 2 本地预设）
    ├── mcp-servers/              自定义 MCP 连接（identifier 即工具名前缀）
    ├── secrets/                  团队凭据（值永不回传）
    ├── machines/                 机器管理（接活/远端 Shell 开关 + 并发上限 + 删除）
    ├── schedules/                定时规则（四种 kind + 时区 + 上下限提示）
    └── chief/
        ├── page.tsx              Chief 设置（charter + topics + 工具面 58 项）
        └── [threadId]/page.tsx   单 topic 设置页（消息流 + watch 列表）
```

`apps/web/src/app/api/` 下是 BFF 层（**56 条路由**），见下方「BFF 信封」表。

`apps/web/src/components/`：`AppShell`（全局外壳 + N/⌘J/⌘B/⌘⌥B/⌘⇧Enter 快捷键）、
`GlobalSidebar`（240px 固定侧栏 + Needs you 角标 + 受控折叠）、
`CommandPalette`（⌘K）、`ConfirmDialog`、`DocPreview`。

`apps/web/src/app/api/` 下是 BFF 层（33 条路由），见下方「BFF 信封」表。

## 三条不可绕过的约定

### 1. 身份从 cookie 推导，前端**不发 userId**

后端写路径的 zod schema（`CreateProviderBody` 等）把 `userId` 声明成必填，
但 `userId` 又是不可信输入 —— `actorForTeam` 会拿它与凭据所有者比对，不等就 403。
所以形状只能是：**浏览器不发 userId，BFF 的 `proxyWrite` 从 cookie 解析后注入**
（见 `apps/web/src/lib/bff-proxy.ts`）。

前端传 `userId: ''` 会得到 422 `String must contain at least 1 character(s)`；
传别人的 id 会得到 403。两者都已实测。

### 2. 占位用**布尔判定**，不要写成 JSX 元素

```tsx
// 对
if (teamNeedsPlaceholder(status, activeTeam)) {
  return <main><SettingsPlaceholder status={status} activeTeam={activeTeam} /></main>;
}
// 错：JSX 元素是对象，if (ph) 恒为真，页面永远停在空占位（且控制台无任何报错）
const ph = <SettingsPlaceholder status={status} activeTeam={activeTeam} />;
if (ph) return <main>{ph}</main>;
```

第二种写法在本项目真实发生过：SSR HTML 里有内容、客户端也成功拉到团队，
但 `<main>` 一直是空的。这个坑的成因与修复写在 `settings-placeholder.tsx` 头部。

`SettingsPlaceholder` 放在**共用模块**而不是 `layout.tsx`：Next App Router 的
layout 只允许框架保留的具名导出，多导一个会让 `.next/types/app/settings/layout.ts`
报 TS2344（该类型文件自动生成，只有 `next build` 才会暴露）。

### 3. BFF 信封必须与上游返回形状对齐

`proxyRead` 的 `pick` 要剥掉上游的外层包装：

| BFF 路由 | 上游返回 | `pick` 取 | 客户端拿到 |
|---|---|---|---|
| `/api/todos` | `{ todos: [...] }` | `todos` | `Todo[]` |
| `/api/todos/[id]` | `{ todo: {...} }` | `todo` | `Todo` |
| `/api/todos/[id]/builds` | `{ builds: [...] }` | `builds` | `Build[]` |
| `/api/teams/[t]/providers` | `{ providers: [...] }` | `providers` | `Provider[]` |
| `/api/teams/[t]/skills` | `{ skills: [...] }` | `skills` | `Skill[]` |
| `/api/teams/[t]/schedules` | `{ schedules: [...] }` | `schedules` | `Schedule[]` |
| `/api/projects` | `{ projects: [...] }` | `projects` | `Project[]` |

漏剥一层的症状很有迷惑性：页面不报错、不白屏，只是某个区域永远空
（详情页少了 `title` 与整个闸门区，因为渲染条件读的是 `todo.phase`）。

## 团队上下文

所有设置页的 URL 是 `/api/teams/:teamId/...`，而此前前端唯一的 teamId 来源是
`GET /api/todos` 里顺带返回的一列 —— **空看板时整个设置区进不去**。因此新增：

- 服务端 `GET /api/user/context`（`apps/server/src/routes/user-context.ts`）
  → `{ userId, email, teams: [{ teamId, name, memberId, role }], agents: [...] }`
  `memberId` 就是写路径要的 `ownerMemberId`（`member.id`，不是 user id）。
  只列 `member_type='user'` 的行 —— agent 身份的行不是「你可切换的团队」。
- 前端 `lib/team-context.tsx` 的 `TeamProvider` + `useTeamContext()`，
  选中态存 localStorage。Provider 只挂在 `settings/layout.tsx`（看板不需要它，
  挂根布局会让首屏多一次请求）。

## 闸门铁律（UI 必须如实表达）

`approve` / `complete` 只在对应闸门有效，`feedback` 只在闸门内有效。
**在闸门输入框里打任何字（包括打「confirm」）都只是修订反馈，相位永不推进**
（依据 `services/builds.ts` 的 `messageTodo`）。详情页输入框旁必须显示这句话，
否则用户会以为打完字就放行了。

实测：`POST /api/todos/:id/feedback {message:"confirm"}` 返回
`{ok:true, phase:"confirm", advanced:false, revisionDispatched:true}`，
phase 前后不变。

`failed` 相位**不画重试按钮** —— `approve`/`complete` 在非闸门相位必然 409，
画一个必然失败的按钮只会让人以为是按钮坏了。

## 降级策略

- **只读**：`proxyRead` 恒返回 HTTP 200 + `{ready, data|reason}`。
  404 → `reason:'endpoint-not-implemented'`，页面渲染占位而非白屏。
- **写**：`proxyWrite` 原样透出上游状态码与响应体，页面据此分辨
  403（无权）/ 409（状态已变）/ 422（参数错）。折成 `ready:false` 会把原因吃掉。
- **团队上下文不可达**：侧栏与内容区各给一条可执行提示（实测停掉后端时，
  页面显示「读不到团队信息…」并指明要查 server 与 token，不是白屏）。
- 「没有团队」与「后端不可达」是**两件事**：前者要引导去加成员，查服务没用。

## 已知未覆盖

- **成员管理 / 邀请 / 角色矩阵**：Auth 仍是单人简化版（单 token + httpOnly cookie）。
- **agent Memory**：agent 详情页有 Memory tab，但**服务端没有 memory 的 REST 端点**
  （只有 Chief 工具 `save_memory` / MCP 工具 `memories` 能用），所以该 tab 显示
  「尚未提供 UI」并注明原因，**没有画假界面**。
- **GitHub 集成**：无 OAuth、无 `github_*` 表、无端点。`recon/docs/github.md` 描述的
  「装 GitHub App → 选仓库 → 建 PR」整条链路未开始。
- **机器入网向导**：机器协议端点（`/api/machine/*`）与 `machine` 表都在，
  但没有面向用户的机器列表页与入网引导（`recon/docs/machines.md` 的卡片 + Info/Builds 两个 tab）。
  目前只能手工调协议端点入网。
- `builds/[buildId]/messages` 与 `documents/[docId]` 的**上游端点仍不存在**
  （`apps/server` 只实现了 `/api/todos/:id/documents` 这类团队路径）。
  两页因此走 `ready:false` 分支显示占位 —— 这是设计中的优雅降级，不是 bug。

## SSE 接入

后端帧格式（`apps/server/src/sse.ts`，与原站一致）：

```
data: {"type":"ping","seq":0}\n\n
data: {"type":"todo_phase_changed","seq":42,"payload":{...}}\n\n
```

客户端封装在 `lib/api.ts`：

- `subscribe(scope, handler)` —— 同 scope 复用一条 `EventSource`
- `unsubscribe(scope, handler)` —— 最后一个订阅者离开时关闭连接
- 手动维护每 scope 的 `seq` 游标做断线续传（服务端帧不带 `id:` 行，
  浏览器原生 `Last-Event-ID` 用不上）
- scope 字面量必须是 `team:<teamId>` / `todo:<id>` / `conv:<id>`，
  与服务端 publish 一致（写死 `'team'` 会导致连接建立了但收不到业务事件）

## Phase → 列映射

| 列名 | phase | 闸门视觉 |
|------|-------|---------|
| 待办 | `todo` | — |
| 规划中 | `planning` | — |
| **计划确认** | `confirm` | 橙色双线边框 + 浅黄背景 + 「闸门」徽章 |
| 实现中 | `implement` | — |
| **变更确认** | `review` | 橙色双线边框 + 浅黄背景 + 「闸门」徽章 |
| 复核中 | `reviewing` | — |
| 已完成 | `done` | — |
| 失败 | `failed` | — |
| 已关闭 | `closed` | — |

定义集中在 `lib/api.ts` 的 `PHASE_COLUMNS`，看板直接 map，详情页的 watch 列表
也复用它做中文映射 —— 不写第二份。

## 本地跑起来

```bash
# 后端（需要 Postgres 已在 127.0.0.1:5433）
cd apps/server
DATABASE_URL="postgres://tds@127.0.0.1:5433/tds" TDS_WEB_TOKEN=devtok \
  node node_modules/tsx/dist/cli.mjs src/main.ts

# 前端
cd apps/web
NEXT_PUBLIC_API_BASE=http://127.0.0.1:4000 TDS_WEB_TOKEN=devtok \
  node node_modules/next/dist/bin/next dev -p 3000
```

浏览器打开 `http://127.0.0.1:3000/login`，用 `devtok` 登录。

### 两个会浪费时间的坑

**① 跑 `next build` 之前先停掉 dev server。**
两者共用 `.next/`：build 会把 dev 的增量产物覆盖掉，于是运行中的 dev server
开始报 `Cannot find module './9223.js'` 与 `GET /sw.js 500` —— 看起来像代码坏了，
实际只是产物目录被另一个进程重写。恢复方式：`rm -rf .next` 再重启 dev。

**② `TDS_WEB_USER` 必须是库里真实存在的 email，或者干脆不设。**
`apps/server/src/auth.ts` 的 `resolveWebUser` 会按它精确匹配；匹配不到就 401，
措辞很明确：`TDS_WEB_USER "..." does not match any user`。
不设时退化为「库里最早的用户」—— 适合本机开发，但库里数据变动后最早的用户也会变。
注意：把它设成一个**占位值**（例如 `x`）来「表示不启用」是错的 —— 空的才算不启用，
设了就会真的去查库并失败。


---

## 2026-10-18 三轮补齐新增的约定

### 4. 主题：深色是实测事实，不是审美选择

原站 `https://todos.dev` 的实测计算样式：

| 令牌 | 值 | 用途 |
|---|---|---|
| `C.bg` | `#18181b` | 页面与侧栏底色 |
| `C.text` | `#fafaf9` | 主文本 |
| `C.textDim` / `C.textFaint` / `C.textGhost` | `#d4d4d8` / `#71717a` / `#52525b` | 三级次文本 |
| `C.accent` | `#818cf8` | 强调（按钮、链接、mention chip） |
| `C.warn` | `#fbbf24` | **仅**用于闸门 —— 「这里需要人决策」 |
| `C.code` | `#27272a` | 代码块底色 |

这些值集中在 `lib/design-tokens.ts`。**禁止**在页面里写字面量：此前 14 个文件里
散落着 308 处浅色硬编码（`#fff` / `#f6f8fa` / `#d0d7de`），改主题要改 14 个文件，
且同一档灰有 4 种不同写法。

⚠️ `C.warn` 的语义边界：它表示「等待人类决策」。终态横幅里的
「继续 / 重跑 / 重新打开」都**不是**闸门，用 warn 会误导 —— 这是实测截图里发现的问题。

### 5. `.strict()` schema 必须声明 `userId`

`proxyWrite` 会**无条件**往写路径 body 注入 `userId`（`bff-proxy.ts`）。
新写 `.strict()` 的 zod schema 若不声明它，**每一次写操作都会被 422 拒**，
症状是页面报「写入被拒」而服务端测试全绿（测试不走 BFF）。

### 6. 同一份 state 只能有一个快捷键监听

⚠️ 实测踩过：侧栏折叠提升为受控 prop 后，`AppShell` 与 `GlobalSidebar` 各注册
一个 ⌘B 监听，各翻一次同一份 state，净效果为零 —— **按键派发了、preventDefault
调了、setState 调了，UI 不动，且没有任何报错**。

排查这类问题**必须用真实按键**（`page.keyboard.down('Control'); press('KeyB')`），
合成 `dispatchEvent(new KeyboardEvent(...))` 测不出监听器数量问题。

### 7. 乐观更新的失败必须回滚

看板拖拽改相位是乐观更新（先动 UI，再发请求）。失败时必须：
1. 用请求前的快照回滚卡片位置；
2. 显示**后端返回的真实 reason**（状态机拒绝时会说明「这个跳转需要新的 trigger」）；
3. **不能**把请求的相位当最终相位 —— 服务端落点可能不同，以响应里的 `phase` 为准。

### 8. 诚实标注的边界

以下几处是**刻意不做**，UI 上如实说明，不假装支持：

| 功能 | 现状 | UI 怎么说的 |
|---|---|---|
| 一键 OAuth 连接 | 未实现 | 「一键登录（OAuth）尚未接通」 |
| 5 条 catalog endpoint | 未经厂商文档核实 | 「endpoint 未核实，接入前请对照厂商官方文档」 |
| Continue（同一 build 重试） | 只入库，daemon 是否拾取未验证 | 「已入库…这一步不会自动推进 phase」 |
| SSE 消息推送 | 服务端无消息级事件 | 「实时推送端到端事件尚未接通，当前每 4 秒轮询一次增量」 |
| research 任务待决 | `doc_kind` 枚举不支持 | 「schema 不支持识别这类任务」 |
| 缺失的侧栏入口 | 已修（16 项入口） | — |

---

## 2026-10-18 第四轮补充：结构化引用（mentions）

原站语义（`recon-live/docs-conversation.md:34`）：

> "A mention inserts a **structured reference chip rather than plain text**, so the
> agent **resolves the exact ID instead of guessing**. A referenced todo or project
> **can belong to another project on your team**: the agent reads its spec, build
> conversation, and repository code **read-only without modifying** the referenced
> project."

五种前缀与类目：

| 前缀 | 类目 | 用途 |
|---|---|---|
| `@` | Agents / Members | 指向某个 agent 或人类成员 |
| `#` | Todos | 引用另一个 todo（**可跨项目，只要同 team**） |
| `/` | Skills | 把技能带进本轮（**不**设为 agent 默认） |
| `~` | Projects | 引用团队里另一个项目 |
| `&` | Machines | 指定某台机器（远程 shell 或派工） |

三条易错点：

1. **`/` 前缀会误触**。用户正常打字就打 `/`（比如 `/usr/local`）。触发规则必须是
   「行首或空白之后 + 后面至少跟 1 个字符」，`/` 尤其要谨慎。
2. **引用要校验，不能只存文本**。写 mentions 时必须逐个校验 `refId` 存在且**同 team**，
   否则就是「让 agent 去猜 id」。
3. **card 的拖拽有两个语义**（第四轮引入的冲突，原站没有这个区分）：
   - 拖到**看板列** = 改相位（第一批的功能）
   - 拖到**对话输入框** = 插入 todo 引用 chip（第四轮）
   
   两者必须能区分。代码里用不同的 hover 高亮区分：列用虚线描边（原本的闸门高亮语义
   不受影响），输入框用实线强调边。
