/**
 * MCP 入站端点（对标 todos.dev `POST /api/mcp`）。
 *
 * 协议：JSON-RPC 2.0 over HTTP（`Content-Type: application/json`），支持的 method：
 *   - `initialize`  → 协议握手，回 serverInfo / capabilities
 *   - `tools/list`  → 列出 key 被授权的工具（MCP `tools` capability）
 *   - `tools/call`  → 调用指定工具；按 key 的 scopes 执行授权
 *   - `ping`        → 健康探针，回 `{ok:true}`
 * 未知 method 返回 JSON-RPC error code -32601，HTTP 仍 200（MCP 规范：
 * transport 必须用 JSON-RPC error 体报错，HTTP 永远 200；4xx 会让客户端
 * 把整个连接判坏并拒绝重连）。
 *
 * ── 对标依据（必读）──
 *   recon/docs/mcp.md 全文
 *     - 「MCP calls act as the key's owner」：调用以 key 所有者身份执行
 *     - 「a client cannot invoke a tool it was not granted」：tools/list 只
 *       返回被授权的工具，tools/call 调未授权工具必须被挡
 *     - 「no confirmation card」：MCP 路径不弹 confirmation card，
 *       即不可逆工具也按调用者的 scope 直发执行（与 Chief 的 confirmation
 *       card 路径不同）。我们在 tools/call 真正执行时不再要二次确认
 *     - 「Set Secret / Delete Secret / Add MCP Server... 所有这些需要
 *       key 所有者是 team admin」：凭据类工具（handlesSecret=true）
 *       额外要求 admin
 *   recon/docs/api-keys.md
 *     - key 属于人，不属于 team；revoked 后即时失效（实查 isNull(apiKey.revokedAt)）
 *     - key 的 scopes 数组定义 MCP 工具选择
 *
 * ── scope 语义（在 CONTRACT 框架内自洽，对照 mcp.md 无出处） ──
 *   scopes 形如：
 *     `tool:<group>` —— 覆盖整个分组的所有工具（如 `tool:todo`）
 *     `tool:<name>`  —— 仅覆盖单个工具（如 `tool:create_todo`）
 *   任何一项匹配即视为该工具被授权。空 scopes = 该 key 没有 MCP 工具可用
 *   → 整个端点回 **HTTP 403**（见 `registerMcpRoutes`；docs/mcp.md 的 403 行）
 *   （docs/mcp.md 「Select only the tools this client needs」+ api-keys.md
 *   「MCP access selects which MCP tools the key may call」。文档没有指定
 *   scope 字符串的具体格式，这里使用 `tool:` 命名空间是因为同一张
 *   api_key.scopes 数组将来可能并存机器凭据 scope（已用 `machine:run`）
 *   与 git scope（`git:read` / `git:write`）—— 命名空间可避免冲突。）
 *
 * ── 凭据类工具的 admin 闸门 ──
 *   handlesSecret=true 的工具额外要求：key 至少在一个 team 中是 admin
 *   角色。这与 mcp.md 「all of these need the key's owner to be a team
 *   admin」一致。注意：admin 是在 member 表里查的，与 permissions.ts 的
 *   Role 重新定义没有共享 type（CONTRACT 允许在本文件内自洽实现）。
 *
 * ── 工具面：MCP 的 31，不是 Chief 的 58 ──
 *   recon/03-app-api.md §8 实测原站 `GET /api/user/mcp-tools` 返回 **31** 项
 *   `{name,label,group}`（read 13 / write 18），并写明「MCP 是 Chief 工具面的
 *   受限投影」。所以 `tools/list`、`tools/call` 的「工具是否存在」与 scope 授权
 *   全部以 `src/mcp-tools.ts` 那张 31 项的表为准。Chief 的 58
 *   （`src/chief/tools.ts`）是 Chief 自己的合同，不拿它当 MCP 的合同。
 *   Chief 有、MCP 没有的 `create_project` / `update_project` / `delete_todos`
 *   在 MCP 上回 `-32002 does not exist`（与未知工具同一条路），不是「未实现」。
 *
 * ── 已实现工具清单（21 / 31）──
 *   读类（连真库）：
 *     todos       → 列出 key 所有者所在团队的项目下的 todo；给 `todoId` 时读
 *                   单条完整上下文（builds / documents）
 *     projects    → 列出项目
 *     agents      → 列出 agent 名册（过滤 `deleted_at`）
 *     machines    → 列出机器名册与在线状态
 *     skills      → 列出技能库（过滤 `deleted_at`，不返回 `storage_path`）
 *     schedules   → 列出该团队的定时规则（跨团队给 `teamId` 时按它筛，
 *                   给别人的团队 → 403，不静默回退成全部）
 *     conversation→ 读某个 build 的对话，支持 `sinceSeq` 增量游标
 *     secrets      → 列出 secret 的名称与描述（**值永不返回**，写阅契约）
 *     mcp_servers  → 列出该团队的 MCP 连接（凭据只回键名，不回值）
 *   写类：
 *     create_todo / update_todo / complete_todos / close_todos / reopen_todos
 *     schedule_todo   → 建定时规则（与 REST 共用 `services/schedules.ts`：
 *                       cron 校验、10 条上限、weekly 拆合同源）
 *     unschedule_todo → 按 id 删规则（同服务层）
 *     set_secret  → 设 secret（值立刻 `seal` 成密文落库；同名要显式 overwrite）
 *     delete_secrets → 按 scope + names 删（无确认卡，立即生效）
 *     add_mcp_server / update_mcp_server / delete_mcp_servers
 *                 → MCP 连接增改删；identifier / kind / transport 建立后不可改，
 *                   凭据按「只覆盖传了的键」合并
 *     run_builds / cancel_builds / confirm_builds / merge_builds / run_review
 *                 → build 生命周期。起 build 要建 `build` + `queued` step 并按
 *                   机器槽探测决定落 `planning` 还是 `queued`；取消会**连带收掉
 *                   未终态的 step**（只推 phase 会被机器的 `POST done` 推翻）；
 *                   confirm / merge 就是两个闸门主按钮，与 REST `/approve`、
 *                   `/complete` 同一个 trigger；`run_review` 用的
 *                   `review_start` / `review_end` 此前零调用方，这里是第一批。
 *     message_todo → 给 todo 发一条消息跑一轮修订。与 REST `/feedback` **同一个**
 *                   服务函数（`services/builds.ts` 的 `messageTodo`）—— 语义就是
 *                   闸门上的 `revision_feedback`：只在 confirm / review 有效、
 *                   **phase 必须不变**。
 *   **MCP 面 31 个工具全部已接线**（2026-10-17 收尾）：上面 26 个之外，最后 5 个是
 *   `attachment`（读 build 消息里的附件元数据；**库里没有附件表、上游也还没接上传
 *   端点，所以现在恒回空数组** —— 那是降级不是 bug，语义与校验规则在
 *   `src/services/attachments.ts`）、`issues` / `pull_requests` / `workflow_runs`
 *   （读 GitHub；凭据走 `repo_credential` 表的 GCM 密文，`repoKind` 非 github 时
 *   明确拒绝而不是回空数组 —— 回空数组会让模型以为「这个仓没有 issue」）。
 *   default 分支的「not implemented in this build」**保留**：`mcpToolSpec` 里
 *   没有的工具名会走到那里，对 MCP 面上不存在的东西如实告知，而不是假实现。
 *
 * ── 为什么这些是「薄壳」而不是第二份实现 ──
 *   `schedules` / `schedule_todo` / `unschedule_todo` 的业务规则全在
 *   `src/services/schedules.ts`；`conversation` 的归属链与查询全在
 *   `src/services/conversations.ts`；凭据类的 `src/services/secrets.ts` 与
 *   `src/services/connections.ts`；build 生命周期与消息的 `src/services/builds.ts`
 *   （其中 `messageTodo` 也被 REST `/feedback` 调用）；附件的
 *   `src/services/attachments.ts`；GitHub 读的 `src/services/github.ts`。
 *   各调用方只做「凭据 → 身份」这一层
 *   （MCP 侧是 key 所有者 + scope，REST 侧是 `actorForTeam`），写侧的 admin 闸门
 *   也共用 `auth.ts` 的 `requireTeamAdmin`（措辞按工具族给：managing schedule
 *   rules / managing secrets / managing connections）。
 *
 * ── 输入契约 ──
 *   每个工具的 `inputSchema` 在 `src/mcp-tools.ts` 里手写：docs/mcp.md 与
 *   docs/api-keys.md 都没有给出权威 JSON Schema，所以只列已知字段，其余一律
 *   `additionalProperties: true` 透传，避免过严校验反把客户端的合法调用挡掉。
 *   不引入 `zod-to-json-schema`：项目已依赖 zod，但加依赖要动 CONTRACT 之外的
 *   package.json，不值当。
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '@tds/db';
import { agents, machines, members, projects, skills, todos } from '@tds/db';
import {
  chiefToolSpec,
  handlesSecret as chiefHandlesSecret,
} from '../chief/tools.js';
import { MCP_TOOLS, mcpToolSpec } from '../mcp-tools.js';
import { authenticateBearer, requireTeamAdmin, type ApiKeyContext } from '../auth.js';
import { HttpError } from '../http.js';
import { firstViolation, quota, isPhase, TODO_PHASES, type Trigger } from '@tds/protocol';
import {
  createSchedule,
  deleteSchedule,
  listSchedules,
} from '../services/schedules.js';
import { listConversationMessages, loadConversationTeamId } from '../services/conversations.js';
import { deleteSecrets, listSecrets, setSecret } from '../services/secrets.js';
import {
  addConnection,
  deleteConnections,
  listConnections,
  updateConnection,
} from '../services/connections.js';
import {
  assertGateTrigger,
  commitPhaseTransition,
  countOpenTodos,
  createTodo,
  loadTodoContext,
  loadTodoTeamId,
  readTodoGateState,
  SPEC_MAX_CHARS,
  updateTodo,
} from '../services/todos.js';
import {
  cancelBuilds,
  confirmBuilds,
  mergeBuilds,
  messageTodo,
  runBuilds,
  runReview,
} from '../services/builds.js';
import { listAttachments, loadBuildTeamId } from '../services/attachments.js';
import {
  assertGithubProject,
  createGitHubClient,
  GitHubClientError,
  loadProjectTeamId,
  loadRepoCredential,
  splitRepoFullName,
} from '../services/github.js';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'tds';
const SERVER_VERSION = '0.1.0';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: unknown;
  method: string;
  params?: unknown;
}

interface JsonRpcError {
  jsonrpc: '2.0';
  id: unknown;
  error: { code: number; message: string; data?: unknown };
}

interface JsonRpcOk {
  jsonrpc: '2.0';
  id: unknown;
  result: unknown;
}

type JsonRpcResponse = JsonRpcOk | JsonRpcError;

/**
 * 标准 JSON-RPC 错误码（spec 2.0）：
 *   -32700 Parse error     -32600 Invalid Request
 *   -32601 Method not found
 *   -32602 Invalid params
 *   -32603 Internal error
 * 应用自定义错误：-32000..-32099
 *   -32000 鉴权失败（key 无效或已撤）
 *   -32002 工具未授权 / 未实现 / 凭据工具要求 admin
 */
const ERR_CODE = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  AuthFailed: -32000,
  ToolNotPermitted: -32002,
} as const;

/**
 * scope → 工具是否被授权。可授权集合 = **MCP 的 31**（`src/mcp-tools.ts`），
 * 不是 Chief 的 58。
 *
 *   key.scopes 数组中任一项匹配即可：
 *     1) `tool:<name>` —— 精确工具
 *     2) `tool:<group>` —— 整个分组。两种 group 都接受：
 *        - `read` / `write` —— MCP 表自己的分组。recon/03-app-api.md §8 写明
 *          「`group` 即 API key 的 scope 粒度」，原站的勾选 UI 就是按它排的
 *        - Chief 的 7 个分组（`todo` / `board` / `infra` …）—— 保留作别名，
 *          因为已发出的 key 与现有测试用的就是它们；T1 收敛的是**可授权集合**，
 *          不是 scope 的措辞
 *   分组别名只覆盖**同时在 MCP 面上**的工具：`tool:board` 不再授予
 *   `create_project` / `update_project`，因为那两个工具根本不在 MCP 面上。
 */
function isAuthorized(scope: string, toolName: string): boolean {
  if (scope !== `tool:${toolName}` && !scope.startsWith('tool:')) {
    return false;
  }
  if (scope === `tool:${toolName}`) return true;
  const group = scope.slice('tool:'.length);
  const mcp = mcpToolSpec(toolName);
  if (!mcp) return false; // 不在 MCP 面上 = 不可授权
  if (mcp.group === group) return true; // read / write
  return chiefToolSpec(toolName)?.group === group; // Chief 分组别名
}

function keyGrantsTool(scopes: readonly string[] | null | undefined, toolName: string): boolean {
  if (!scopes || scopes.length === 0) return false;
  return scopes.some((s) => isAuthorized(s, toolName));
}

/**
 * 找到 key 所有者所属的所有 team id（用于跨团队资源查询）。
 * 文档：「MCP calls act as the key's owner and can reach projects in that
 * user's teams」。
 */
async function listTeamIdsForUser(db: Db, userId: string): Promise<string[]> {
  const rows = await db
    .select({ teamId: members.teamId })
    .from(members)
    .where(and(eq(members.actorId, userId), eq(members.memberType, 'user')));
  return rows.map((r) => r.teamId);
}

/**
 * key 所有者是否在给定 team 中担任 admin。
 * 这是凭据类工具的额外闸门（docs/mcp.md）。
 *
 * 注意：返回一个 boolean 即可；调不到 admin 的真实错误由调用方处理为
 * JSON-RPC error -32002（toolNotPermitted）。
 */
async function isAdminInAnyTeam(db: Db, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: members.id })
    .from(members)
    .where(
      and(
        eq(members.actorId, userId),
        eq(members.memberType, 'user'),
        eq(members.role, 'admin'),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

// ── 工具执行（读类连真库；其它返回 not-implemented） ─────────

interface CallParams {
  readonly [k: string]: unknown;
}

const ParamsShape = z.record(z.unknown()).default({});

/**
 * create_todo 的参数契约。字段与 REST 的 `CreateTodoBody` 同规则 —— 同一份业务、
 * 两处入口必须同一套校验，否则同一个 spec 一边能存一边不能存。
 *
 * 唯一差别：`ownerMemberId` 可省略。MCP 客户端通常不知道 member id，
 * 逼它填等于逼它先多调一次列表工具；这里省略时默认取 **key 所有者** 在该团队的 member。
 */
const CreateTodoArgs = z.object({
  teamId: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1).max(280),
  ownerMemberId: z.string().min(1).optional(),
  agentId: z.string().nullable().optional(),
  spec: z.string().max(SPEC_MAX_CHARS).nullable().optional(),
  tagIds: z.array(z.string()).default([]),
  planFirst: z.boolean().default(true),
  separatePlanBuild: z.boolean().default(false),
  withChecklist: z.boolean().default(false),
});

/** update_todo 的参数契约。`phase` 不在其中 —— case 里显式拒绝并指出替代工具。 */
const UpdateTodoArgs = z.object({
  todoId: z.string().min(1),
  title: z.string().min(1).max(280).optional(),
  spec: z.string().max(SPEC_MAX_CHARS).nullable().optional(),
  tagIds: z.array(z.string()).optional(),
});

/**
 * 三个生命周期工具共用一份参数契约 —— 它们唯一的区别是 trigger，
 * 分成三份 schema 只会让三处校验各自漂移。
 *
 * `todoIds` 允许空数组：批量语义是「逐个尽力」，空输入是合法空操作，
 * 不该报错（客户端清空选择后调用是正常路径）。
 */
const LifecycleArgs = z.object({
  todoIds: z.array(z.string().min(1)),
  /** 只对 complete_todos 有意义；close/reopen 传了会被忽略 */
  merge: z.boolean().default(false),
});

/**
 * schedule_todo 的参数契约 —— 与 REST 的 `CreateBody` 同一套字段、同一套校验
 * （cron 拆合、容量上限都走 `services/schedules.ts`）。这里只做「客户端传来的
 * 形状」这层解析：`createdBy` 不在里面，由 case 填 key 所有者的 userId。
 */
const ScheduleTodoArgs = z.object({
  teamId: z.string().min(1),
  todoId: z.string().min(1),
  kind: z.enum(['hourly', 'daily', 'weekly', 'once']),
  cron: z.string().min(1).max(120),
  timezone: z.string().min(1).max(80),
  weekday: z.number().int().min(0).max(6).optional(),
  agentId: z.string().nullable().optional(),
  machineId: z.string().nullable().optional(),
  automatic: z.boolean().optional(),
});

/** unschedule_todo：按 id 删（soft-delete）。团队归属 + admin 在 case 里判。 */
const UnscheduleTodoArgs = z.object({
  teamId: z.string().min(1),
  scheduleId: z.string().min(1),
});

/**
 * build 类工具的参数契约。
 *
 * 五者都是「批量 todoId + 无 teamId」的形状 —— 归属由 todo 反查 team（服务层
 * `loadTodoTeamId`），所以客户端**不能**传 teamId：传了也没人用，反而会让人误
 * 以为可以指定别的团队。`requireTeamAccess` 拿反查出来的 teamId 判成员资格。
 */
const BuildTodoArgs = z.object({
  todoIds: z.array(z.string().min(1)),
});

/** `confirm_builds` 额外收 `by` —— 谁按的闸门主按钮（Chief 代确认 vs 用户自己点）。 */
const ConfirmBuildsArgs = BuildTodoArgs.extend({
  by: z.enum(['user', 'chief']).default('user'),
});

/** `merge_builds` 额外收 `merge` —— 勾了合并就再跑一轮 merge turn。 */
const MergeBuildsArgs = BuildTodoArgs.extend({
  merge: z.boolean().default(false),
});

/**
 * `message_todo` 的参数契约。
 *
 * **逐 todo 一条消息**，不是一个 todoId 配多条 —— 批量消息没有语义：
 * 「给这三个 todo 各发同一条」不如发三次清楚，而批量形式会让人误以为支持。
 */
const MessageTodoArgs = z.object({
  todoId: z.string().min(1),
  message: z.string().min(1).max(8000),
});

/**
 * `attachment` 的参数契约。`buildId` 而非 `todoId` —— 附件挂在**消息**上，
 * 而消息属于 build；用 todoId 要在服务层反查最近一条 build，那层没有语义。
 */
const AttachmentArgs = z.object({
  buildId: z.string().min(1),
});

/**
 * GitHub 三个读工具的参数契约。
 *
 * **只收 `projectId`，不收 `teamId`** —— 归属由 project 反查（`loadProjectTeamId`
 * 在 `assertGithubProject` 之前调用，见那里的注释：反过来的话无权访问的项目会
 * 通过「repoKind 不是 github」泄露存在性）。
 */
const GithubReadArgs = z.object({
  projectId: z.string().min(1),
  state: z.enum(['open', 'closed', 'all']).default('open'),
  limit: z.number().int().min(1).max(100).default(30),
});

/**
 * set_secret 的参数契约。
 *
 * `value` 是明文 —— 它只被 `services/secrets.ts` 立刻 `seal`，回包只含摘要。
 * `overwrite` 不给时同名 secret 已存在 → 409（文档：只有显式说 overwrite 才替换）。
 */
const SetSecretArgs = z.object({
  teamId: z.string().min(1),
  name: z.string().min(1).max(120),
  value: z.string().min(1),
  description: z.string().nullable().optional(),
  scope: z.enum(['team', 'project']).default('team'),
  projectId: z.string().nullable().optional(),
  overwrite: z.boolean().optional(),
});

/** delete_secrets：按 scope + names 定位。文档：一次可删多个，无确认卡。 */
const DeleteSecretsArgs = z.object({
  teamId: z.string().min(1),
  names: z.array(z.string().min(1)).min(1),
  scope: z.enum(['team', 'project']).default('team'),
  projectId: z.string().nullable().optional(),
});

/**
 * add_mcp_server 的参数契约。
 *
 * `config` 是 headers / env 的键值对 —— 值只进密文，`ConnectionSummary` 只回键名。
 * 原站的 catalog 连接（Linear / Notion …）走浏览器 OAuth 一次性登录，本复刻没有
 * 那个流程，所以这里只真正覆盖 `kind: 'custom'` 那条路（服务层注释里已标注）。
 */
const AddMcpServerArgs = z.object({
  teamId: z.string().min(1),
  identifier: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  transport: z.enum(['http', 'stdio']),
  endpoint: z.string().nullable().optional(),
  kind: z.enum(['catalog', 'custom']).optional(),
  config: z.record(z.string()).nullable().optional(),
});

/** update_mcp_server：identifier / kind / transport 不可改，只能改 label / config / 过期。 */
const UpdateMcpServerArgs = z.object({
  teamId: z.string().min(1),
  connectionId: z.string().min(1),
  label: z.string().min(1).max(120).optional(),
  config: z.record(z.string()).nullable().optional(),
  expiresAt: z.number().int().nullable().optional(),
});

const DeleteMcpServersArgs = z.object({
  teamId: z.string().min(1),
  identifiers: z.array(z.string().min(1)).min(1),
});

/**
 * conversation 的参数契约。`buildId` 即 conversation id（分支名 `tds/conv-<buildId>`
 * 同源）；`sinceSeq` 是增量游标，与 Chief「重复读只回增量」同一语义。
 */
const ConversationArgs = z.object({
  buildId: z.string().min(1),
  sinceSeq: z.number().int().nonnegative().optional(),
});

/** 批量里单项的结果。`ok:false` 不是异常，是「闸门当前不接受这个动作」。 */
interface LifecycleOutcome {
  todoId: string;
  ok: boolean;
  phase?: string;
  reason?: string;
}

/**
 * build 类工具的单项结果。在 `LifecycleOutcome` 之上多了 build / step 定位与
 * `dispatch` —— 起完 build 后模型需要知道去哪个 build 上追问（`conversation`
 * 工具吃的就是 buildId），所以这两个 id 必须回出去。
 */
interface BuildOutcome extends LifecycleOutcome {
  buildId?: string;
  stepId?: string | null;
  /** 是否需要调度一个 step（闸门推进后为 false 就是「不需要再跑」）。 */
  dispatch?: boolean;
  /** `cancel_builds` 实际取消掉的 step 数 —— 0 表示本来就没有在跑的。 */
  cancelledSteps?: number;
}

/**
 * 「逐个尽力」语义下的单项失败：把异常翻译成 reason。
 * 返回 undefined = 这不是可归因的单项失败（例如 DB 连接挂了），调用方必须继续抛，
 * 不能悄悄把它记成「这一项没成功」。
 */
function failureReason(e: unknown): string | undefined {
  if (e instanceof ToolCallError) return e.message;
  if (e instanceof HttpError) return `${e.statusCode}: ${e.message}`;
  return undefined;
}

/**
 * 解析 MCP 工具参数并把 zod 失败转成 ToolCallError。
 *
 * 为什么不是直接 `.parse`：MCP 协议里工具入参错误属于 **tool execution error**，
 * 必须以 `result.content + isError: true` 回给模型（让它能自我纠正重试），
 * 而不是 JSON-RPC error —— 后者会让多数客户端把整条 MCP 连接判为坏了。
 *
 * `toolName` 由调用点显式传入：zod schema 本身不知道自己属于哪个工具，
 * 硬要从 schema 反推名字只会得到无意义的键名。
 */
function toolArgs<T extends z.ZodTypeAny>(
  schema: T,
  raw: unknown,
  toolName: string,
): z.infer<T> {
  const r = schema.safeParse(raw ?? {});
  if (!r.success) {
    throw new ToolCallError(
      `invalid arguments: ${r.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`,
      { toolName },
    );
  }
  return r.data;
}

/**
 * 校验调用方有权操作该 team —— 纯判定，不做查询。
 *
 * MCP 调用**以 key 所有者身份**执行（recon/docs/mcp.md：「MCP calls act as the
 * key's owner and can reach projects in that user's teams」），而 `ApiKeyContext`
 * 里**没有 teamId**。所以任何影响单个团队的写操作都必须先过这道闸 ——
 * 否则「用户 A 的 key 改用户 B 团队的 todo」会直接成功，且完全静默。
 *
 * 抽成纯函数是因为读类工具**已经**查过 `listTeamIdsForUser`（要拿它做过滤范围），
 * 再走下面的 async 版会白跑一次 SELECT。
 */
function assertTeamIn(teamIds: readonly string[], teamId: string): void {
  if (!teamIds.includes(teamId)) {
    throw new ToolCallError(
      `403: team "${teamId}" is not accessible to this key's owner`,
      { teamId },
    );
  }
}

async function requireTeamAccess(db: Db, userId: string, teamId: string): Promise<string> {
  assertTeamIn(await listTeamIdsForUser(db, userId), teamId);
  return teamId;
}

/**
 * MCP 侧的 admin 闸门 —— 直接复用 `auth.ts` 的 `requireTeamAdmin`，不另写一份
 * 成员角色查询（MCP 的 isAdminInAnyTeam 是**任意团队** admin，那是凭据类工具的
 * 旧语义；调度写路径要的是「这个团队」是 admin，两者不能混）。
 */
async function requireTeamAdminForTool(
  db: Db,
  userId: string,
  teamId: string,
  action: string,
): Promise<void> {
  await requireTeamAdmin(db, userId, teamId, action);
}

/**
 * 读类工具的 teamId 解析 —— **给了就必须校验，不许静默放宽**。
 *
 * 原实现是 `wantedTeamId && teamIds.includes(wantedTeamId) ? [wantedTeamId] : teamIds`，
 * 于是传一个不属于调用方的 teamId 会**静默回退成「全部团队」**：调用方以为自己
 * 按团队筛过，实际拿到的是跨团队的全量数据。这比报错更糟 —— 结果是错的，
 * 但没有任何信号。现在改成显式 403。
 */
async function resolveTargetTeams(
  db: Db,
  userId: string,
  args: CallParams,
): Promise<string[]> {
  const teamIds = await listTeamIdsForUser(db, userId);
  if (teamIds.length === 0) return [];
  const wanted = typeof args['teamId'] === 'string' ? (args['teamId'] as string) : null;
  if (!wanted) return teamIds;
  assertTeamIn(teamIds, wanted);
  return [wanted];
}

async function executeTool(
  db: Db,
  userId: string,
  name: string,
  rawParams: unknown,
): Promise<unknown> {
  // 仅在我们实际实现的工具里走 DB
  switch (name) {
    case 'todos': {
      const p = ParamsShape.parse(rawParams ?? {}) as CallParams;
      // 给了 `todoId` 就是「读单条」。原站把「list todos」和「read a todo in full」
      // 写在同一个读类分组（recon/docs/mcp.md:51），而 58 个工具名里**没有**单数
      // `todo`（recon/03-app-api.md §3 实测，`test/chief-tools.test.ts` 把数量锁死）
      // —— 所以单条读取挂在 `todos` 上，不新增工具名去破坏对标。
      const singleTodoId = typeof p['todoId'] === 'string' ? (p['todoId'] as string) : null;
      if (singleTodoId) {
        const teamId = await loadTodoTeamId(db, singleTodoId);
        await requireTeamAccess(db, userId, teamId);
        const ctx = await loadTodoContext(db, singleTodoId);
        // 按 kind 分组，六种 kind 预置空数组：模型接手前必须一次读完，而且拿到稳定
        // 形状 —— 缺 key 会让它以为「这类文档不存在」而不是「这次没查到」。
        const grouped: Record<string, unknown[]> = {
          plan: [], changes: [], question: [], confirm: [], input: [], review: [],
        };
        for (const d of ctx.documents) (grouped[d.kind] ??= []).push(d);
        return { todo: ctx.todo, builds: ctx.builds, documents: grouped };
      }

      const targetTeams = await resolveTargetTeams(db, userId, p);
      if (targetTeams.length === 0) return { todos: [] };
      const projectId = typeof p['projectId'] === 'string' ? (p['projectId'] as string) : null;
      const phase = typeof p['phase'] === 'string' ? (p['phase'] as string) : null;
      // limit 必须有硬上限：实测一个团队全量 418 条，一次几千条会撑爆模型上下文。
      const rawLimit = Number(p['limit']);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), 200)
        : 50;
      const conds = [inArray(projects.teamId, targetTeams)];
      if (projectId) conds.push(eq(todos.projectId, projectId));
      if (phase) {
        // 非法 phase 必须报错，不能静默回空列表：模型传 `phase:'don'` 时会以为
        // 「团队里没有 done 的 todo」，而实际是它自己拼错了。顺带消掉 `as never`。
        if (!isPhase(phase)) {
          throw new HttpError(400, `phase must be one of: ${TODO_PHASES.join(', ')}`);
        }
        conds.push(eq(todos.phase, phase));
      }
      const rows = await db
        .select({
          id: todos.id,
          projectId: todos.projectId,
          seqNum: todos.seqNum,
          title: todos.title,
          phase: todos.phase,
          projectName: projects.name,
          teamId: projects.teamId,
          createdAt: todos.createdAt,
          updatedAt: todos.updatedAt,
        })
        .from(todos)
        .innerJoin(projects, eq(projects.id, todos.projectId))
        .where(and(...conds))
        .orderBy(todos.createdAt)
        .limit(limit);
      return { todos: rows };
    }
    case 'projects': {
      const p = ParamsShape.parse(rawParams ?? {}) as CallParams;
      const targetTeams = await resolveTargetTeams(db, userId, p);
      if (targetTeams.length === 0) return { projects: [] };
      const rows = await db
        .select({
          id: projects.id,
          teamId: projects.teamId,
          name: projects.name,
          provider: projects.provider,
          repoFullName: projects.repoFullName,
          defaultBranch: projects.defaultBranch,
          createdAt: projects.createdAt,
        })
        .from(projects)
        .where(inArray(projects.teamId, targetTeams))
        .orderBy(projects.createdAt);
      return { projects: rows };
    }
    case 'agents': {
      const p = ParamsShape.parse(rawParams ?? {}) as CallParams;
      const targetTeams = await resolveTargetTeams(db, userId, p);
      if (targetTeams.length === 0) return { agents: [] };
      const rows = await db
        .select({
          id: agents.id,
          teamId: agents.teamId,
          displayName: agents.displayName,
          provider: agents.provider,
          modelId: agents.modelId,
          activeTaskCount: agents.activeTaskCount,
          createdAt: agents.createdAt,
        })
        .from(agents)
        .where(and(inArray(agents.teamId, targetTeams), isNull(agents.deletedAt)))
        .orderBy(agents.createdAt);
      return { agents: rows };
    }
    case 'machines': {
      const p = ParamsShape.parse(rawParams ?? {}) as CallParams;
      const targetTeams = await resolveTargetTeams(db, userId, p);
      if (targetTeams.length === 0) return { machines: [] };
      const rows = await db
        .select({
          id: machines.id,
          teamId: machines.teamId,
          name: machines.name,
          isOnline: machines.isOnline,
          buildEnabled: machines.buildEnabled,
          shellEnabled: machines.shellEnabled,
          runtimes: machines.runtimes,
          lastHeartbeatAt: machines.lastHeartbeatAt,
          createdAt: machines.createdAt,
        })
        .from(machines)
        .where(inArray(machines.teamId, targetTeams))
        .orderBy(machines.createdAt);
      return { machines: rows };
    }
    case 'skills': {
      const p = ParamsShape.parse(rawParams ?? {}) as CallParams;
      const targetTeams = await resolveTargetTeams(db, userId, p);
      if (targetTeams.length === 0) return { skills: [] };
      // `deleted_at IS NULL` 必须过滤 —— skills 路由就是这么做的，不滤就会把
      // 已删的技能当活的列给模型，它会去用一个已经不存在的技能。
      const rows = await db
        .select({
          id: skills.id,
          teamId: skills.teamId,
          name: skills.name,
          source: skills.source,
          sourceUrl: skills.sourceUrl,
          sizeBytes: skills.sizeBytes,
          fileCount: skills.fileCount,
          createdBy: skills.createdBy,
          createdAt: skills.createdAt,
        })
        .from(skills)
        .where(and(inArray(skills.teamId, targetTeams), isNull(skills.deletedAt)))
        .orderBy(skills.createdAt);
      // storage_path 不返回：那是服务器本地目录，对模型无意义，还把实现细节泄露出去。
      return { skills: rows };
    }
    case 'schedules': {
      const p = ParamsShape.parse(rawParams ?? {}) as CallParams;
      const targetTeams = await resolveTargetTeams(db, userId, p);
      if (targetTeams.length === 0) return { schedules: [] };
      const rules: Awaited<ReturnType<typeof listSchedules>> = [];
      for (const teamId of targetTeams) rules.push(...(await listSchedules(db, teamId)));
      rules.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      return { schedules: rules };
    }
    case 'conversation': {
      const p = toolArgs(ConversationArgs, rawParams, 'conversation');
      // 归属链 build → todo → project → team，与 REST 共用服务层。
      const teamId = await loadConversationTeamId(db, p.buildId);
      assertTeamIn(await listTeamIdsForUser(db, userId), teamId);
      const messages = await listConversationMessages(db, p.buildId, p.sinceSeq);
      return { buildId: p.buildId, sinceSeq: p.sinceSeq ?? null, messages };
    }
    case 'create_todo': {
      const p = toolArgs(CreateTodoArgs, rawParams, 'create_todo');
      await requireTeamAccess(db, userId, p.teamId);

      // Free 档配额。数字来自 FREE_LIMITS，不在这里硬编码。
      const openCount = await countOpenTodos(db, p.projectId);
      const quotaBad = firstViolation([quota.openTodos(openCount)]);
      if (quotaBad) {
        throw new ToolCallError(`422: ${quotaBad.message}`, { projectId: p.projectId });
      }

      // owner_member_id 是 NOT NULL，不能塞 null。
      // 显式传了就必须属于这个团队：`todo.owner_member_id` **没有 FK**
      // （schema.ts:244），不校验就会把 todo 挂到不存在或别团队的 member 上，
      // 库里完全看不出异常 —— 这是最难查的一类 bug。
      // 省略时**先按 key 所有者身份**定位 member（docs/mcp.md：「MCP calls act as
      // the key's owner」）。之前是「该团队任一 member」的 `limit(1)` 且无
      // `orderBy`：多成员团队里会把 todo 建到别人名下，而且同一份数据两次调用
      // 可能落给不同的人。回退（key 所有者在该团队没有 member 行时）也必须
      // `orderBy`，否则不确定。
      let ownerMemberId = p.ownerMemberId;
      if (ownerMemberId) {
        const explicit = await db
          .select({ id: members.id })
          .from(members)
          .where(and(eq(members.id, ownerMemberId), eq(members.teamId, p.teamId)))
          .limit(1);
        if (!explicit[0]) {
          throw new ToolCallError(
            `403: ownerMemberId "${ownerMemberId}" is not a member of team "${p.teamId}"`,
            { teamId: p.teamId, ownerMemberId },
          );
        }
      } else {
        const mine = await db
          .select({ id: members.id })
          .from(members)
          .where(
            and(
              eq(members.teamId, p.teamId),
              eq(members.actorId, userId),
              eq(members.memberType, 'user'),
            ),
          )
          .limit(1);
        const rows = mine[0]
          ? mine
          : await db
              .select({ id: members.id })
              .from(members)
              .where(eq(members.teamId, p.teamId))
              .orderBy(members.id)
              .limit(1);
        const picked = rows[0];
        if (!picked) {
          throw new ToolCallError('403: team has no member to own todos', { teamId: p.teamId });
        }
        ownerMemberId = picked.id;
      }

      const created = await createTodo(db, {
        teamId: p.teamId,
        projectId: p.projectId,
        ownerMemberId,
        agentId: p.agentId ?? null,
        title: p.title,
        spec: p.spec ?? null,
        tagIds: p.tagIds,
        planFirst: p.planFirst,
        separatePlanBuild: p.separatePlanBuild,
        withChecklist: p.withChecklist,
        // `createdByType: 'agent'`（2026-10-18 新增）—— MCP create_todo 是
        // 模型代发（agent ↔ agent 衔接、Schedule、agent 自主启动任务），
        // 不是 Chief 在用户对话里派工，也不是用户手动建的，记 'agent'。
        createdByType: 'agent',
      });
      return {
        todoId: created.id,
        seqNum: created.seqNum,
        phase: 'todo',
        projectId: p.projectId,
      };
    }
    case 'update_todo': {
      const rawObj = (rawParams ?? {}) as CallParams;
      // phase 只能走闸门。这里**不静默忽略**：静默忽略会让客户端以为
      // 「标记完成成功了」而库里 phase 根本没变 —— 那是最难查的一类 bug。
      if ('phase' in rawObj) {
        throw new ToolCallError(
          'phase cannot be set directly; use complete_todos / close_todos / reopen_todos',
          { toolName: 'update_todo' },
        );
      }
      const p = toolArgs(UpdateTodoArgs, rawObj, 'update_todo');
      if (p.title === undefined && p.spec === undefined && p.tagIds === undefined) {
        throw new ToolCallError(
          'update_todo needs at least one of title / spec / tagIds',
          { toolName: 'update_todo' },
        );
      }
      // teamId 从 todo 反推，**不接受调用方传 teamId 来定位** —— 否则
      // 「A 团队的 todoId + B 团队的 teamId」就能绕过归属校验。
      const teamId = await loadTodoTeamId(db, p.todoId);
      await requireTeamAccess(db, userId, teamId);
      await updateTodo(db, p.todoId, teamId, {
        ...(p.title !== undefined ? { title: p.title } : {}),
        ...(p.spec !== undefined ? { spec: p.spec } : {}),
        ...(p.tagIds !== undefined ? { tagIds: p.tagIds } : {}),
      });
      return { ok: true, todoId: p.todoId };
    }
    case 'complete_todos':
    case 'close_todos':
    case 'reopen_todos': {
      const p = toolArgs(LifecycleArgs, rawParams, name);
      // close_todos 用的是 `cancel`：状态机里只有 `t === 'cancel'` 的分支会落到
      // closed。`Trigger` 联合类型里挂着的 `close` **没有任何分支处理**，用它永远
      // 拿到 ok:false。详见 services/todos.ts 的 assertGateTrigger 注释。
      const trigger: Trigger =
        name === 'complete_todos'
          ? { kind: 'complete', merge: p.merge }
          : name === 'close_todos'
            ? { kind: 'cancel' }
            : { kind: 'reopen' };
      // 三个 trigger 都在白名单内；这一句是防御：以后往这里加错 trigger 会被挡住
      assertGateTrigger(trigger);

      // 批量语义 = **逐个尽力**，不是全或无。理由：
      //   - 回滚要撤销已写的 audit + SSE 事件，代价高且容易出错
      //   - 模型拿到 [{todoId, ok:false, reason}] 会自己去重试那一个，
      //     信息量比「整批失败」大得多
      const outcomes: LifecycleOutcome[] = [];
      for (const todoId of p.todoIds) {
        try {
          const teamId = await loadTodoTeamId(db, todoId);
          await requireTeamAccess(db, userId, teamId);
          const gate = await readTodoGateState(db, todoId);
          const r = await commitPhaseTransition(db, {
            todoId,
            teamId,
            trigger,
            planFirst: gate.planFirst,
          });
          const out: LifecycleOutcome = { todoId, ok: r.ok, phase: r.next };
          if (!r.ok && r.reason !== undefined) out.reason = r.reason;
          outcomes.push(out);
        } catch (e) {
          // 单项失败不影响同批其它项 —— 这是「尽力」语义的全部意义
          const reason = failureReason(e);
          if (reason !== undefined) {
            outcomes.push({ todoId, ok: false, reason });
            continue;
          }
          throw e;
        }
      }
      const succeeded = outcomes.filter((o) => o.ok).length;
      return { results: outcomes, succeeded, failed: outcomes.length - succeeded };
    }
    case 'schedule_todo': {
      const p = toolArgs(ScheduleTodoArgs, rawParams, 'schedule_todo');
      await requireTeamAccess(db, userId, p.teamId);
      // 写路径要求 admin —— 与 REST 的 `managing schedule rules` 同一条闸门
      // （recon/docs/schedules：写操作 reserved for owner/admin）。
      await requireTeamAdminForTool(db, userId, p.teamId, 'managing schedule rules');
      const schedule = await createSchedule(db, {
        teamId: p.teamId,
        todoId: p.todoId,
        kind: p.kind,
        cron: p.cron,
        timezone: p.timezone,
        weekday: p.weekday,
        agentId: p.agentId,
        machineId: p.machineId,
        automatic: p.automatic,
        createdBy: userId,
      });
      return { schedule };
    }
    case 'unschedule_todo': {
      const p = toolArgs(UnscheduleTodoArgs, rawParams, 'unschedule_todo');
      await requireTeamAccess(db, userId, p.teamId);
      await requireTeamAdminForTool(db, userId, p.teamId, 'managing schedule rules');
      const deleted = await deleteSchedule(db, p.teamId, p.scheduleId);
      return { ok: true, deleted };
    }

    // ── build 生命周期 5 个 ─────────────────────────────────────────
    // 批量语义与上面 complete/close/reopen 同款：**逐个尽力**，不是全或无。
    // 回包形状也统一成 `{results, succeeded, failed}`，模型拿到哪一项失败能自己重试。
    case 'run_builds':
    case 'cancel_builds':
    case 'confirm_builds':
    case 'merge_builds':
    case 'run_review': {
      const todoIds = toolArgs(BuildTodoArgs, rawParams, name).todoIds;

      const results: BuildOutcome[] = [];
      for (const todoId of todoIds) {
        try {
          // 归属只能由 todo 反查 —— 客户端传的 teamId 一律不信
          const teamId = await loadTodoTeamId(db, todoId);
          await requireTeamAccess(db, userId, teamId);

          // build 类不要求 admin：起 build / 点闸门是任何成员的日常操作，
          // 与 schedule / secret 的「写路径要 admin」是两类闸门，别混。
          let outcome: BuildOutcome;
          if (name === 'run_builds') {
            const r = await runBuilds(db, todoId);
            outcome = {
              todoId,
              ok: r.ok,
              phase: r.phase,
              ...(r.buildId ? { buildId: r.buildId } : {}),
              ...(r.stepId !== undefined ? { stepId: r.stepId } : {}),
              ...(r.reason ? { reason: r.reason } : {}),
            };
          } else if (name === 'cancel_builds') {
            const r = await cancelBuilds(db, todoId);
            outcome = {
              todoId,
              ok: r.ok,
              phase: r.phase,
              cancelledSteps: r.cancelledSteps,
              ...(r.reason ? { reason: r.reason } : {}),
            };
          } else if (name === 'confirm_builds') {
            // `by` 是这一支独有的字段，就地解析 —— 在循环外解不开（见 TS2339）。
            const { by } = toolArgs(ConfirmBuildsArgs, rawParams, name);
            const r = await confirmBuilds(db, todoId, by);
            outcome = { todoId, ok: r.ok, phase: r.phase, dispatch: r.dispatch, ...(r.reason ? { reason: r.reason } : {}) };
          } else if (name === 'merge_builds') {
            const { merge } = toolArgs(MergeBuildsArgs, rawParams, name);
            const r = await mergeBuilds(db, todoId, merge);
            outcome = { todoId, ok: r.ok, phase: r.phase, dispatch: r.dispatch, ...(r.reason ? { reason: r.reason } : {}) };
          } else {
            const r = await runReview(db, todoId);
            outcome = {
              todoId,
              ok: r.ok,
              phase: r.phase,
              ...(r.buildId ? { buildId: r.buildId } : {}),
              ...(r.stepId !== undefined ? { stepId: r.stepId } : {}),
              ...(r.reason ? { reason: r.reason } : {}),
            };
          }
          results.push(outcome);
        } catch (e) {
          const reason = failureReason(e);
          if (reason !== undefined) {
            results.push({ todoId, ok: false, reason });
            continue;
          }
          throw e;
        }
      }
      const succeeded = results.filter((r) => r.ok).length;
      return { results, succeeded, failed: results.length - succeeded };
    }

    case 'message_todo': {
      const p = toolArgs(MessageTodoArgs, rawParams, 'message_todo');
      // 归属由 todo 反查 —— 客户端传的 teamId 一律不信
      const teamId = await loadTodoTeamId(db, p.todoId);
      await requireTeamAccess(db, userId, teamId);
      // 与 REST `/api/todos/:id/feedback` 同一个服务函数（services/builds.ts 的
      // messageTodo）—— 两条写路径各写一份的话，漂移的后果是「AI 能绕过闸门」。
      const r = await messageTodo(db, p.todoId, p.message);
      return {
        todoId: p.todoId,
        ok: r.ok,
        // phase 必然等于调用前的相位：发消息是修订反馈，不推进闸门
        phase: r.phase,
        revisionDispatched: r.revisionDispatched,
        ...(r.reason ? { reason: r.reason } : {}),
      };
    }

    // ── 附件与 GitHub 读（2026-10-17）─────────────────────────────────
    // 四个都是**只读**工具，入参一律 `projectId` 或 `buildId`，**不收 teamId** ——
    // 归属由资源反查（attachment 走 build→todo→project→team，
    // GitHub 三个走 project→team），客户端传的 teamId 一律不信。
    case 'attachment': {
      const p = toolArgs(AttachmentArgs, rawParams, 'attachment');
      const teamId = await loadBuildTeamId(db, p.buildId);
      await requireTeamAccess(db, userId, teamId);
      const attachments = await listAttachments(db, { buildId: p.buildId });
      // 上游还没接上传端点时这里是空数组 —— 那是正确的降级，不是假实现。
      // 有数据才非空，且**只回元数据**（名字/大小/mime），永不回二进制内容。
      return { attachments };
    }
    case 'issues':
    case 'pull_requests':
    case 'workflow_runs': {
      const p = toolArgs(GithubReadArgs, rawParams, name);
      // 顺序要紧：先确认项目对 key 的 owner 可访问（403），再谈 repoKind 与凭据。
      // 反过来的话，一个无权访问的项目会通过「repoKind 不是 github」这条回包
      // 泄露它存在 —— 403 的存在性语义和 conversation 那套一样。
      const teamId = await loadProjectTeamId(db, p.projectId);
      await requireTeamAccess(db, userId, teamId);

      // repoKind 不是 github → 拒绝（不是返回空数组）。文档写明
      // 「read-only, GitHub-backed projects only」，空数组会让模型以为「没 issue」。
      const project = await assertGithubProject(db, p.projectId);
      // 凭据缺失/吊销各自有独立状态码（404 / 410），与 repoKind 错配（403）区分开，
      // 这样模型能分辨「要去配 token」还是「这个仓不是 GitHub 仓」。
      const cred = await loadRepoCredential(db, p.projectId);
      const { owner, repo } = splitRepoFullName(project.repoFullName);

      const client = createGitHubClient({ token: cred.token });
      try {
        if (name === 'issues') {
          const issues = await client.listIssues({ owner, repo, ...(p.state ? { state: p.state } : {}), ...(p.limit ? { perPage: p.limit } : {}) });
          return { issues };
        }
        if (name === 'pull_requests') {
          const pullRequests = await client.listPullRequests({ owner, repo, ...(p.state ? { state: p.state } : {}), ...(p.limit ? { perPage: p.limit } : {}) });
          return { pullRequests };
        }
        const workflowRuns = await client.listWorkflowRuns({ owner, repo, ...(p.limit ? { perPage: p.limit } : {}) });
        return { workflowRuns };
      } catch (e) {
        // GitHub 的 404/403/429 原样透给模型（含状态码与 message），但**绝不带 token**
        // —— GitHubClientError 的 message 只取响应体里 GitHub 自己的 message 字段。
        if (e instanceof GitHubClientError) {
          return { error: `github ${e.status}: ${e.message}` };
        }
        throw e;
      }
    }

    case 'secrets': {
      const p = ParamsShape.parse(rawParams ?? {}) as CallParams;
      const targetTeams = await resolveTargetTeams(db, userId, p);
      if (targetTeams.length === 0) return { secrets: [] };
      const all: Awaited<ReturnType<typeof listSecrets>> = [];
      for (const teamId of targetTeams) all.push(...(await listSecrets(db, teamId)));
      all.sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name));
      // 返回类型里没有值字段 —— 文档：「Secrets are write-only … nobody can view
      // the plaintext value again, including admins」。这里连 runtime 过滤都不必做。
      return { secrets: all };
    }
    case 'set_secret': {
      const p = toolArgs(SetSecretArgs, rawParams, 'set_secret');
      await requireTeamAccess(db, userId, p.teamId);
      await requireTeamAdminForTool(db, userId, p.teamId, 'managing secrets');
      const secret = await setSecret(db, {
        teamId: p.teamId,
        scope: p.scope,
        projectId: p.projectId,
        name: p.name,
        description: p.description,
        value: p.value,
        overwrite: p.overwrite,
        createdBy: userId,
      });
      return { secret };
    }
    case 'delete_secrets': {
      const p = toolArgs(DeleteSecretsArgs, rawParams, 'delete_secrets');
      await requireTeamAccess(db, userId, p.teamId);
      await requireTeamAdminForTool(db, userId, p.teamId, 'managing secrets');
      const deleted = await deleteSecrets(db, p.teamId, p.scope, p.projectId, p.names);
      return { deleted };
    }
    case 'mcp_servers': {
      const p = ParamsShape.parse(rawParams ?? {}) as CallParams;
      const targetTeams = await resolveTargetTeams(db, userId, p);
      if (targetTeams.length === 0) return { connections: [] };
      const all: Awaited<ReturnType<typeof listConnections>> = [];
      for (const teamId of targetTeams) all.push(...(await listConnections(db, teamId)));
      all.sort((a, b) => a.createdAt - b.createdAt || a.identifier.localeCompare(b.identifier));
      return { connections: all };
    }
    case 'add_mcp_server': {
      const p = toolArgs(AddMcpServerArgs, rawParams, 'add_mcp_server');
      await requireTeamAccess(db, userId, p.teamId);
      await requireTeamAdminForTool(db, userId, p.teamId, 'managing connections');
      const connection = await addConnection(db, {
        teamId: p.teamId,
        kind: p.kind,
        identifier: p.identifier,
        transport: p.transport,
        label: p.label,
        endpoint: p.endpoint,
        config: p.config,
        createdBy: userId,
      });
      return { connection };
    }
    case 'update_mcp_server': {
      const p = toolArgs(UpdateMcpServerArgs, rawParams, 'update_mcp_server');
      await requireTeamAccess(db, userId, p.teamId);
      await requireTeamAdminForTool(db, userId, p.teamId, 'managing connections');
      const connection = await updateConnection(db, {
        teamId: p.teamId,
        connectionId: p.connectionId,
        label: p.label,
        config: p.config,
        expiresAt: p.expiresAt,
      });
      return { connection };
    }
    case 'delete_mcp_servers': {
      const p = toolArgs(DeleteMcpServersArgs, rawParams, 'delete_mcp_servers');
      await requireTeamAccess(db, userId, p.teamId);
      await requireTeamAdminForTool(db, userId, p.teamId, 'managing connections');
      const deleted = await deleteConnections(db, p.teamId, p.identifiers);
      return { deleted };
    }
    default:
      // **MCP 面 31 个工具现已全部实现**（2026-10-17 收尾）。这个 default 只在
      // 调用方报了一个**不在 31 个里**的工具名时才会走到 —— 也就是客户端在
      // 调一个我们根本没提供的工具。
      //
      // 措辞必须区分这两件事，所以说明「不在这个 MCP server 的工具面上」而不是
      // 「还没实现」：后者会让模型以为稍后可用、反复重试。
      // `tools/list` 只列得出 31 个里的工具，所以正常客户端不该走到这里。
      throw new ToolCallError(
        `tool "${name}" does not exist on this MCP server; call tools/list to see the available tools`,
        { toolName: name },
      );
  }
}

/** 自定义错误：toolNotPermitted（未授权 / 未实现 / 凭据工具要求 admin） */
class ToolCallError extends Error {
  constructor(message: string, readonly data?: unknown) {
    super(message);
    this.name = 'ToolCallError';
  }
}

/**
 * 把服务层抛的 `HttpError` 翻译成 MCP 的 tool execution error。
 *
 * `services/todos.ts` 是纯服务层，只认 `HttpError`（REST 路由靠它映射成 4xx）。
 * 但 MCP 侧 404/409/422/403 对模型而言都是「这次调用没成，对话可以继续」，
 * 必须以 `isError` 文本回，不能抛到 Fastify 层 —— 那会变成 HTTP 5xx，
 * 客户端会把整条 MCP 连接判坏。
 *
 * 保留 status 在 data 里，方便客户端/模型区分「不存在」与「状态冲突」。
 */
async function runTool(db: Db, userId: string, name: string, raw: unknown): Promise<unknown> {
  try {
    return await executeTool(db, userId, name, raw);
  } catch (e) {
    if (e instanceof ToolCallError) throw e;
    if (e instanceof HttpError) {
      throw new ToolCallError(`${e.statusCode}: ${e.message}`, { status: e.statusCode });
    }
    throw e;
  }
}

function toolCallEnvelope(
  text: string,
  isError: boolean,
): { content: Array<{ type: 'text'; text: string }>; isError?: true } {
  const env: { content: Array<{ type: 'text'; text: string }>; isError?: true } = {
    content: [{ type: 'text', text }],
  };
  if (isError) env.isError = true;
  return env;
}

/** `tools/call` 单点处理；返回 {result, error?: {code,message,data}} 二元组 */
async function handleToolsCall(
  app: FastifyInstance,
  db: Db,
  ctx: ApiKeyContext,
  params: unknown,
): Promise<{ result?: { content: Array<{ type: 'text'; text: string }> }; error?: { code: number; message: string; data?: unknown } }> {
  const parsed = z
    .object({
      name: z.string().min(1),
      arguments: z.record(z.unknown()).optional(),
    })
    .safeParse(params);
  if (!parsed.success) {
    return {
      error: {
        code: ERR_CODE.InvalidParams,
        message: `tools/call params must be {name,arguments?}: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      },
    };
  }
  const { name, arguments: args } = parsed.data;

  // 工具名是否在 **MCP 面**上（31 个，见 `src/mcp-tools.ts`）。
  // Chief 有而 MCP 没有的 `create_project` / `update_project` / `delete_todos`
  // 在这里与未知工具走同一条路 —— 对 MCP 客户端它们就是「不存在」，
  // 不是「我们还没做」。
  if (!mcpToolSpec(name)) {
    return {
      error: {
        code: ERR_CODE.ToolNotPermitted,
        message: `tool "${name}" does not exist on this MCP server`,
        data: { toolName: name },
      },
    };
  }

  // scope 授权
  if (!keyGrantsTool(ctx.scopes, name)) {
    return {
      error: {
        code: ERR_CODE.ToolNotPermitted,
        message: `tool "${name}" is not granted to this API key`,
        data: { toolName: name, scopes: ctx.scopes },
      },
    };
  }

  // 凭据类工具额外要求 admin。
  // 判据是 **`handlesSecret && needsAdminGrant`**，不是单看 handlesSecret：
  // `secrets`（读名称）是 handlesSecret 但**故意不**限 admin —— 文档
  // 「regular members can see the names and descriptions」，chief/tools.ts 那边
  // 用 `needsAdminGrant` 表达了同一件事（test/chief-tools.test.ts:108 钉住）。
  // 只看 handlesSecret 会把只读工具也挡在 admin 后面，与文档和 Chief 侧都不一致。
  const spec = chiefToolSpec(name);
  if (chiefHandlesSecret(name) && spec?.needsAdminGrant === true) {
    const admin = await isAdminInAnyTeam(db, ctx.userId);
    if (!admin) {
      return {
        error: {
          code: ERR_CODE.ToolNotPermitted,
          message: `tool "${name}" handles credentials and requires the key's owner to be a team admin`,
          data: { toolName: name },
        },
      };
    }
  }

  // 实际执行
  try {
    const data = await runTool(db, ctx.userId, name, args);
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    return { result: toolCallEnvelope(text, false) };
  } catch (e) {
    if (e instanceof ToolCallError) {
      return { result: toolCallEnvelope(e.message, true) };
    }
    // 未预期异常（DB 外键 / 唯一冲突 / 连接错误 / TypeError）：`tools/call` 的契约是
    // **永远 HTTP 200 + JSON-RPC error**（`registerMcpRoutes` 的注释、docs/mcp.md
    // 的「500 → 客户端可重试」）。之前 `throw e` 会变成 HTTP 500
    // `{"error":"internal error"}`，客户端会把整条 MCP 连接判坏。
    // 详情只进服务端日志：SQL、驱动措辞、堆栈一律不回给客户端。
    app.log.error({ err: e, toolName: name }, 'MCP tools/call unexpected failure');
    return {
      error: {
        code: ERR_CODE.InternalError,
        message: `tool "${name}" failed unexpectedly`,
        data: { toolName: name },
      },
    };
  }
}

/** `tools/list` 单点处理；按 scope 过滤 */
function handleToolsList(
  ctx: ApiKeyContext,
  params: unknown,
): { result?: unknown; error?: { code: number; message: string } } {
  const parsed = z
    .object({
      cursor: z.string().optional(),
    })
    .safeParse(params ?? {});
  if (!parsed.success) {
    return {
      error: {
        code: ERR_CODE.InvalidParams,
        message: `tools/list params invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      },
    };
  }
  // cursor 在 MVP 不实现（31 个工具一页足够）
  const tools = MCP_TOOLS.filter((t) => keyGrantsTool(ctx.scopes, t.name)).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
  return { result: { tools } };
}

export function registerMcpRoutes(app: FastifyInstance, db: Db): void {
  /**
   * 单端点处理 JSON-RPC 2.0 请求。**始终 HTTP 200** —— 错误用 JSON-RPC
   * error 体表达（MCP spec：transport 必须始终 2xx；4xx 会让多数客户端
   * 把整条连接判坏）。
   *
   * HTTP 层的错误只有两种：401（Bearer 缺失 / 形态错 / hash 不命中 / key 已 revoke）
   * 与 403（key 有效但一个 MCP 工具都没勾 —— docs/mcp.md「403, no MCP access」）。
   */
  app.post('/api/mcp', async (req, reply) => {
    // 1) 鉴权
    let ctx: ApiKeyContext;
    try {
      ctx = await authenticateBearer(db, req);
    } catch (e) {
      if (e instanceof HttpError) {
        // transport 层错误：401
        return reply.code(401).send({ error: e.message });
      }
      throw e;
    }

    // 2) key 存在但一个 MCP 工具都没勾 → **HTTP 403**。
    //    docs/mcp.md 的 Errors 表：「403, no MCP access — The key has no MCP
    //    tools selected. Enable MCP access and select at least one」。
    //    必须在 method 路由**之前**判：原文说的是「这个 key 根本用不了 MCP」，
    //    不是「某个 method 失败」，所以 `initialize` 同样被挡。
    //    与「未授权某个工具」是两件事 —— 后者是应用层结果，仍回 200 + -32002。
    if (ctx.scopes.length === 0) {
      return reply.code(403).send({
        error:
          'no MCP access: this API key has no MCP tools selected; enable MCP access and select at least one tool',
      });
    }

    // 3) parse JSON-RPC envelope
    const raw = req.body as unknown;
    if (!raw || typeof raw !== 'object') {
      const body: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: null,
        error: { code: ERR_CODE.InvalidRequest, message: 'request body must be a JSON-RPC envelope' },
      };
      return reply.code(200).send(body);
    }
    const env = raw as JsonRpcRequest;
    if (env.jsonrpc !== '2.0') {
      const body: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: (env as { id?: unknown }).id ?? null,
        error: { code: ERR_CODE.InvalidRequest, message: 'jsonrpc must be exactly "2.0"' },
      };
      return reply.code(200).send(body);
    }
    const id: unknown = (env as { id?: unknown }).id ?? null;

    // 4) 路由 method
    let out: { result?: unknown; error?: { code: number; message: string; data?: unknown } };
    switch (env.method) {
      case 'initialize':
        out = {
          result: {
            protocolVersion: PROTOCOL_VERSION,
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            capabilities: { tools: { listChanged: false } },
          },
        };
        break;
      case 'ping':
        out = { result: { ok: true } };
        break;
      case 'tools/list':
        out = handleToolsList(ctx, env.params);
        break;
      case 'tools/call':
        out = await handleToolsCall(app, db, ctx, env.params);
        break;
      default:
        // HTTP transport 规定：**通知**（JSON-RPC 定义 = **没有 id** 的请求）回
        // **202 Accepted + 空体**。之前 `notifications/initialized` 落到 default
        // 变成 `-32601` + 200 —— 官方 SDK 1.32.1 容忍了，但更严格的客户端会把它
        // 当握手失败。**反过来**也不能一律按前缀放行：带了 id 的 `notifications/*`
        // 是请求不是通知，客户端正在等它的响应，202 空体会让它挂住 —— 走 -32601。
        if (env.method.startsWith('notifications/') && !('id' in env)) {
          return reply.status(202).send();
        }
        out = {
          error: {
            code: ERR_CODE.MethodNotFound,
            message: `method "${env.method}" is not supported by this MCP server`,
            data: { supportedMethods: ['initialize', 'tools/list', 'tools/call', 'ping'] },
          },
        };
        break;
    }

    const body: JsonRpcResponse = out.error
      ? {
          jsonrpc: '2.0',
          id,
          error: {
            code: out.error.code,
            message: out.error.message,
            ...(out.error.data !== undefined ? { data: out.error.data } : {}),
          },
        }
      : { jsonrpc: '2.0', id, result: out.result };
    return reply.code(200).send(body);
  });
}
