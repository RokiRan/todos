# 并行开发契约（2026-10-16）

> 三个并行任务共享的**冻结签名**。子代理不得改动本文件。
> 起因：`parallel-module-type-freeze` —— 上次并行开发时子代理引用了我后加的
> 函数导致 TS2345（readonly 数组传给可变参数）。所以共享签名先定死。

---

## 1. 现有可复用导出（各任务直接 import，不要重写）

### `apps/server/src/chief/tools.ts`
```ts
export type ChiefToolGroup = 'todo' | 'board' | 'team' | 'skill' | 'infra' | 'memory' | 'schedule' | 'interaction';
export interface ChiefToolSpec {
  name: string;
  group: ChiefToolGroup;
  irreversible?: boolean;
  needsAdminGrant?: boolean;
  handlesSecret?: boolean;
  summary: string;
}
export const CHIEF_TOOLS: ChiefToolSpec[];      // 58 个
export function chiefToolSpec(name: string): ChiefToolSpec | undefined;
export function requiresConfirmation(name: string): boolean;
export function handlesSecret(name: string): boolean;
export const CHIEF_TOOL_COUNT: number;
```

### `apps/server/src/http.ts`（已收敛的错误处理，**必须**用它抛错）
```ts
export class HttpError extends Error {
  constructor(public readonly statusCode: number, message: string);
}
export function isHttpError(err: unknown): err is Error & { statusCode: number };
export function installErrorHandlers(app: FastifyInstance): void;  // main.ts 已在路由注册后调用
```

### `apps/server/src/ids.ts`
```ts
export function newId(): string;
export function now(): number;
```

### `apps/server/src/crypto.ts`
```ts
export interface Sealed { cipher: string; nonce: string; tag: string }
export function seal(plaintext: string, kek?: Buffer): Sealed;
export function open(sealed: Sealed, kek?: Buffer): string;
export function hashApiKey(key: string, kek?: Buffer): string;
export function generateApiKey(kek?: Buffer): { key: string; prefix: string; hash: string };
```

### `apps/server/src/permissions.ts`（**已核对真实导出名**）
```ts
export const CORE_TOOLS: CoreTool[];
export const ELEVATED_TOOLS: ElevatedTool[];
export function canUseCoreTool(tool: CoreTool): Decision;
export function canUseElevatedTool(...): Decision;
export function canUseConnection(...): Decision;
export function canRunOn(...): Decision;
export function hasCapability(role: Role, cap: Capability): boolean;
export function canManageTodoSchedule(...): Decision;
```
若需要新的判定，**在自己的任务文件里加**，不要改这个文件。

### 路由注册函数签名（三方一致，统一照抄）
```ts
export function registerXxxRoutes(app: FastifyInstance, db: Db): void
```
（`Db` 从 `@tds/db` import type）

### `packages/db` 的相关表
```
skill:      id, teamId, name, source, sourceUrl, storagePath, sizeBytes, fileCount, createdBy, createdAt, deletedAt
schedule:   id, teamId, todoId, kind, cron, timezone, agentId, machineId, automatic, lastFiredAt, lastOutcome, createdBy, createdAt
api_key:    id, userId, name, keyPrefix, keyHash, scopes(text[]), revokedAt, lastUsedAt, createdAt
```

---

## 2. 各任务的独占文件（严禁越界）

| 任务 | 只允许新建/修改这些文件 |
|---|---|
| **MCP 入站** | `apps/server/src/routes/mcp.ts`、`apps/server/src/mcp-tools.ts`、`apps/server/test/mcp-api.test.ts`、`apps/server/test/mcp-write-tools.test.ts` |
| **skill CRUD** | `apps/server/src/routes/skills.ts`、`apps/server/test/skills-api.test.ts` |
| **schedule CRUD** | `apps/server/src/routes/schedules.ts`、`apps/server/test/schedules-api.test.ts` |

**共享服务层**（REST 与 MCP 都必须调它，禁止在路由或 MCP 里另写一份业务规则）：
- `apps/server/src/services/todos.ts` —— todo 的唯一写入口（闸门 / 审计 / SSE 双发）
- `apps/server/src/services/schedules.ts` —— schedule 的 cron 校验、10 条上限、weekly 拆合、增删改查
- `apps/server/src/services/conversations.ts` —— build 对话的归属链与消息查询（含 `sinceSeq` 增量）
- `apps/server/src/services/secrets.ts` —— secret 的密文落库（值只进 `seal`）、scope/name 校验、显式覆盖、每 scope ≤50
- `apps/server/src/services/connections.ts` —— MCP 连接；`identifier` 建立后不可改、凭据按键合并、每 team ≤20、删除 soft-delete
- `apps/server/src/services/api-keys.ts` —— **按 user_id 鉴权**（key 属于人不属于团队）；明文只在创建响应出现一次、scope 默认全关、revoke 幂等且不动 machine 行
- `apps/server/src/services/builds.ts` —— build 生命周期（`runBuilds` / `cancelBuilds` / `confirmBuilds` / `mergeBuilds` / `runReview`）；建 build 规则与 Chief `dispatchTodo` 同源。**另有两个跨入口共用点**：`messageTodo`（MCP `message_todo` 与 REST `/feedback` 同源）、`settleBuildPhase`（机器 `POST done` 的相位落点真源）
- `apps/server/src/services/attachments.ts` —— 附件元数据（从 `build_message.content` 的 `user_attachments` 信封解析）+ 校验（每条 ≤5、图片 ≤5MB、文档 ≤20MB）+ `loadBuildTeamId`（403 存在性语义）。**库里没有附件表、上游没接上传端点，故无信封时回空数组 —— 降级不是假实现**
- `apps/server/src/services/github.ts` —— 极薄 GitHub REST 客户端（Node 20+ 内置 fetch，无 octokit）+ `loadRepoCredential`（GCM 密文）+ `assertGithubProject` + `loadProjectTeamId` + `splitRepoFullName`。`setGitHubFetchImpl` 是**测试专用**注入点
- 授权判定统一走 `apps/server/src/auth.ts`：`resolveContext`（凭据 → 身份）、
  `requireTeamMembership`、`requireTeamAdmin(db,userId,teamId,action)`、`actorForTeam`

**GitHub 读的三个易错点**：
① **上游响应形状不统一** —— `/issues` 与 `/pulls` 回裸数组，`/actions/runs` 回**对象** `{total_count, workflow_runs:[...]}`。按数组解会 `wire.map is not a function`。**测试 fixture 必须照真实形状喂**，按自己实现反推的 fixture 会把解包 bug 一起盖住；
② **repoKind 非 github 要明确拒绝而不是回空数组** —— 回空数组会让模型以为「这个仓没有 issue」，那是谎报；
③ **先 `loadProjectTeamId` 再 `assertGithubProject`** —— 反过来的话，无权访问的项目会通过「repoKind 不对」这条回包泄露存在性。

**build 生命周期的五条易错点**：
① **先问状态机再写库** —— 顺序反了会在拒绝路径上留下一条永远没人认领的 build + queued step；
② **无在线机器时不能问状态机** —— `transition(todo, claim)` 恒回 `planning`，状态机里没有「机器」这个概念，产品语义是落 `queued` 等上线（Chief 同样绕过 transition）；
③ **取消必须连带收 step 与 build** —— 只推 phase 的话，机器跑完 `POST done` 会把 `closed` 推翻成 `failed`；
④ **`review_start` 的落点不是闸门主按钮的落点** —— `gateDecision` 为此加了第三种判定 `branch`（`advance` 的落点由 gate 类型写死，评审要落瞬态 `reviewing`）；
⑤ **`POST done` 的落点不许自己发明** —— 原来按 `body.status` 硬编码 `succeeded → review`，不看 todo 当时的相位，于是 `reviewing` 跑完被硬写成 `review`、**跳过 Confirm 闸门**。现在一律走 `settleBuildPhase` → `transition`：成功时按当前相位选 trigger（`reviewing`→`review_end`、`implement`→`changes_ready`、其余→`plan_ready`）。状态机拒绝就**不写相位**（保持原相位）并把 reason 记进审计。

**闸门上 `fail` 的放行不是放松铁律**：闸门上会跑的只有主按钮与 `revision_feedback`，两者都 `dispatch` 一个 step；那个 step 失败时 `POST done(status:'failed')` 收成 `fail` —— 闸门若不接受，todo 永远停在那儿、`build.finishedAt` 已落终态却再没人推进。「只认主按钮」约束的是**推进**（approve/complete），失败与取消是**收敛**，方向相反。

**API key 的三条易错点**：
① 归属维度是 `user_id` 而不是 `team_id` —— 复用 `actorForTeam` 会把「key 属于人」错判成「key 属于团队」；
② 机器凭据（`name` 以 `machine:` 开头）与用户 key 同表，列表必须过滤、撤销必须拒绝，否则 Settings 会显示并误撤销机器凭据；
③ revoke 回包里的 `revokedAt` 必须取**库里那个**时间戳，重复撤销时 DB 没变、回包也不能变。

**凭据类工具的两层 admin 闸门**（不要合并成一层）：
① `handlesSecret && needsAdminGrant` → owner 在**任意**团队都不是 admin 就拒（`-32002`）；
② case 内 per-team `requireTeamAdmin` → owner 在别的团队当 admin 不能写这个团队的凭据。
`secrets` 是只读工具，`needsAdminGrant` 为 false，**不应**被①拦住。

**密文列形状**：表里只有 `enc_value` / `enc_nonce`（connection 是 `enc_config` / `enc_nonce`），
GCM 的 tag 以 `<cipher>.<tag>` 拼在 cipher 后面，反解按 `lastIndexOf('.')` 切开 ——
与 `routes/providers.ts` 的 `sealForColumn` 同一套，不要为了多一段 tag 改表结构。

**主代理保留**（子代理一律不得碰）：
`apps/server/src/main.ts`、`packages/**`、`apps/server/src/http.ts`、
`apps/server/src/ids.ts`、`apps/server/src/crypto.ts`、
`apps/server/src/permissions.ts`、`apps/server/src/routes/{machine,todos,chief,providers}.ts`、
`apps/server/src/chief/**`、`apps/daemon/**`、`apps/web/**`

主代理在三个任务全部交付后，统一：
1. 在 `main.ts` 里 import 并注册三个 `registerXxxRoutes(app, db)`
2. 跑全量 typecheck + 全量测试
3. 修跨任务冲突

---

## 3. 通用约束（三方一致）

### TypeScript（项目既有规则）
- `strict` + `noUncheckedIndexedAccess`
- ESM，Node ≥22.19，import 路径必须带 `.js` 后缀
- **禁止** `new Promise((resolve, reject) => ...)` —— 用 `Promise.withResolvers()`
- **禁止** `ReturnType<typeof fn>` —— 要写就写显式 interface
- 类型依赖必须顶层 `import type`
- **禁止**动态 `await import()`
- 静态字符串表用 `Record`，不用 `Map`/`Set`
- 禁止无意义的小函数

### 数据库
- 真实 PostgreSQL：`postgres://tds@127.0.0.1:5433/tds`
- 写测试时 **必须先查 `information_schema.columns` 确认真实列名**，不要凭猜
- sql`` 模板里不能出现 `::type` 或嵌套反引号 —— 先取到变量再用 `${}`
- `(project_id, seq_num)` 这类唯一约束要处理

### HTTP 约定
- 抛错**只用** `throw new HttpError(status, message)`，不要 `reply.status()`
- 错误处理已由 `installErrorHandlers` 统一接管（在 main.ts，路由注册后调用）
- 业务校验失败用 422，权限不足 403，不存在 404，状态冲突 409

### 测试
- `node:test` + `node:assert/strict`
- 用真实数据库 + `app.inject`
- 每个测试用独立 fixture，`after` 里按 FK 依赖顺序清理
- 断言**可观察行为**，不读源码文件、不断言内部实现
- 清理顺序（FK）：step → build.pinned_machine_id → document/build_message → build → todo → audit → project → provider → api_key → agent → machine → member → team → user

### 纪律
- **不要**跑全量测试（主代理最后统一跑）
- **不要**改 `main.ts`
- **不要**碰别人的文件
- 遇到类型冲突先在自己文件内解决；跨任务的冲突**报告但不要擅自改别人的文件**
- 交付时列出：改了哪些文件、测试数、实现要点、已知限制

---

## 4. 对标依据（`D:/AI/todos/recon/docs/`，非推测）

| 任务 | 必读文档 |
|---|---|
| MCP 入站 | `mcp.md`（工具分组 + **按 key 授权** + 无确认卡语义）、`api-keys.md` |
| skill CRUD | `skills.md`、`agents.md`（default skill ≤10） |
| schedule CRUD | `schedules.md` |

**每条业务规则都要能在这些文档里找到出处**。文档没写的不要臆造。
