import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  isGate,
  isSettled,
  quota,
  TODO_PHASES,
  transition,
  type QuotaCheck,
  type TodoPhase,
  type Trigger,
} from '@tds/protocol';
import type { Db } from '@tds/db';
import {
  agents,
  auditEvents,
  builds,
  buildMessageMentions,
  buildMessages,
  documents,
  machines,
  machinePendingActions,
  members,
  projects,
  skills,
  sseEvents,
  steps,
  todos,
} from '@tds/db';
import { newId, now } from '../ids.js';
import { deliverEvent, publish } from '../sse.js';
import { HttpError } from '../http.js';
import {
  assertGateTrigger,
  commitPhaseTransition,
  countOpenTodos,
  createTodo,
  deleteTodo,
  loadTodoContext,
  loadTodoTeamId,
  updateTodo,
  SPEC_MAX_CHARS,
} from '../services/todos.js';
import { messageTodo } from '../services/builds.js';
import { requireTeamMembership, resolveContext, teamIdsForUser } from '../auth.js';

/**
 * Todo 业务 REST 路由。
 *
 * 鉴权（2026-10-17 落地）：每个 handler 第一行 `resolveContext(db, req)`，再按
 *   「资源所属 team」判归属 —— 不再信 body 里的 `teamId` / `ownerMemberId`。
 *   - 401 = 凭据不对；403 = 凭据对但那个 team 不是他的（`auth.ts` 的
 *     `requireTeamMembership`），与 `recon/docs/mcp.md` 的 Errors 表一致
 *   - `/api/machine/*`（机器凭据）与 `/api/mcp`（自己按 key 鉴权）不在这条链上
 *
 * 闸门铁律（双重保证）：
 *   1. 路由层只允许 approve / complete / revision_feedback 三类 trigger，
 *      闸门外的 trigger 直接 409 挡掉 —— 把不该进入 transition 的请求提前隔离
 *   2. 真正推进时一律走 `transition()`，**绝不**手写 phase 判断；
 *      transition 是产品里最容易写错的地方，铁律由 packages/protocol/test
 *      锁死，这里不重复判断，只断言 transition 的产物符合预期
 *
 * 容量校验：用 packages/protocol/quota.quota.openTodos() 等显式函数，
 *   避免在本文件硬编码 FREE_LIMITS 数字。
 */

/**
 * 把 quota 检查转成 422 抛错。SPEC_MAX_CHARS 不读 FREE_LIMITS.entities 里硬数 800，
 * 而是走 quota.roleDescription()（其内部硬上限就是 800）—— 这样跨产品都能走同一条闸门，
 * 也与 agent description 共用同一 message 风格。
 */
function enforceQuota(check: QuotaCheck): void {
  if (!check.ok) {
    throw new HttpError(422, check.message);
  }
}

const CreateTodoBody = z.object({
  teamId: z.string(),
  projectId: z.string(),
  ownerMemberId: z.string(),
  agentId: z.string().nullable().default(null),
  title: z.string().min(1).max(280),
  spec: z.string().max(SPEC_MAX_CHARS).nullable().default(null),
  tagIds: z.array(z.string()).default([]),
  planFirst: z.boolean().default(true),
  separatePlanBuild: z.boolean().default(false),
  withChecklist: z.boolean().default(false),
});

const ApproveBody = z.object({
  by: z.enum(['user', 'chief']).default('user'),
});

const CompleteBody = z.object({
  merge: z.boolean().default(false),
});

const FeedbackBody = z.object({
  message: z.string().min(1).max(8000),
});

const MoveBody = z.object({
  phase: z.enum(TODO_PHASES),
});

const ReopenBody = z.object({}).strict();

const RerunBody = z.object({}).strict();

/**
 * `ResetBody` —— 把 todo 「重置回 todo 相位」
 * （契约 §3.3 / 第 3.3 段，2026-10-18 看板新增）
 *
 * 当前 schema 留 `{}`：`reset` 不带参数。但保留 strict + 留 `userId` 兜底
 * 与本文件其它路线同源 —— 同 RestoreBody 的注释。
 */
const ResetBody = z
  .object({
    userId: z.string().optional(),
  })
  .strict();

/**
 * `CancelBody` —— 关闭 todo（→ closed），状态机 trigger `cancel` 同源（同
 * `assertGateTrigger` 白名单）。无字段；保留 strict 与 userId 兜底（同源）。
 */
const CancelBody = z
  .object({
    userId: z.string().optional(),
  })
  .strict();

/**
 * `PatchTodoBody` —— 改 todo 的可变字段（除 phase 之外）。
 *
 * 跟 `routes/mcp.ts` 的 `update_todo` 共一份语义：
 *   - `title` 可选，1..280
 *   - `spec`  可选，nullable（明确传 null 表示「清空 spec」）；≤ SPEC_MAX_CHARS
 *   - 必须至少传一个字段，否则 422 —— 服务层 updateTodo 不接受空 patch
 *     （静默放过会让客户端以为「什么都没改也成功」）
 *   - 不接 `phase`：phase 由状态机唯一决定，不是用户可改字段
 *
 * 留 `userId` 兜底 BFF proxyWrite 注入（同 RestoreBody 注释）。
 */
const PatchTodoBody = z
  .object({
    title: z.string().min(1).max(280).optional(),
    spec: z.string().max(SPEC_MAX_CHARS).nullable().optional(),
    userId: z.string().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.title === undefined && v.spec === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'patch todo requires at least one of title / spec',
      });
    }
  });

/**
 * `SyncToMachineBody` —— 选机器同步分支。机器归属、在线状态、工作目录都在
 * 下面 handler 里逐项校验（2026-10-18 接通了 ok:true 路径）。这里只校验 body
 * 字面形态。`userId` 是 BFF 注入位，见 `ContinueBody` 的同款说明。
 */
const SyncToMachineBody = z
  .object({
    machineId: z.string().min(1),
    userId: z.string().optional(),
  })
  .strict();

/**
 * `Continue` —— 「failed」相位上「在原 build 上重试失败的那一轮」。
 *
 * `buildId` 缺省 → 取 todo 最新一个 build 行（用户从终态横幅点 Continue 不会
 * 传 buildId，所以默认行为必须够用）。
 *
 * 字段全部可选；保留 strict 是为了以后有人改用 `proxyWrite`（BFF 会注入
 * `userId`）时不被拒成 `Unrecognized key(s) in object: 'userId'` —— 第一批
 * 真实踩过。本路由当前的 BFF 是手写转发（不带 teamId），不注入 userId，
 * 但声明只是加一行字段，避免日后被打回。
 */
const ContinueBody = z
  .object({
    buildId: z.string().optional(),
    userId: z.string().optional(),
  })
  .strict();

/**
 * `ReusePlanBody` —— 复用最近一个 build（指定时按 buildId 找）的 plan 文档
 * 起新 build。同 ContinueBody 的严格 + 留 userId 说明。
 */
const ReusePlanBody = z
  .object({
    buildId: z.string().optional(),
    userId: z.string().optional(),
  })
  .strict();

/**
 * `RestoreBody` —— 写 `builds.pending_restore`（`{sessionLeafEntryId, commitSha, sessionId}`）。
 *
 * **形状决定依据（grep + 读 schema 实测）**：
 *   1. `packages/db/src/schema.ts` 的 `build_message` 字段集只有
 *      `id, buildId, role, phase, triggerBy, content, agent, isError, durationMs, seq, createdAt`。
 *      `GET /api/builds/:buildId/messages` 返回的 `BuildMessage[]`（见
 *      `routes/build-messages.ts` 的 shapeMessage）**没有**任何
 *      「checkpoint id」「session leaf entry id」「git sha」之类可定位回滚点的字段。
 *   2. `build_messages.seq` 只是 per-build 自增序号；`content` 装的也不是结构化的
 *      「commit 引用」，是 JSON 信封或纯文本，没法从客户端稳定推出 checkpoint。
 *   3. 客户端**无法**自动列出「可回滚的历史轮次」—— schema 没记录这个信息。
 *   → body **只接受 `{commitSha, sessionLeafEntryId}`**（必填），`sessionId`
 *     由服务端从 `builds.session.id` 自动取出（build 行已 not null 存着 JSONB）。
 *
 *   `buildId` 可选：缺省取 todo 最新一个 build；指定时必须属于该 todo。
 *   后续若 schema 加了 checkpoint 字段，body 可扩展为 `{messageSeq?, commitSha?, sessionLeafEntryId?}`
 *   —— 但本切片不动 schema。
 *
 * **与 ContinueBody 同款**：`strict()` + 留 `userId` 兜底 BFF proxyWrite 注入
 * （与 `routes/todos.ts:113-121` 同源注释）。
 */
const RestoreBody = z
  .object({
    commitSha: z.string().min(1).max(200),
    sessionLeafEntryId: z.string().min(1).max(200),
    buildId: z.string().optional(),
    userId: z.string().optional(),
  })
  .strict();

/**
 * `MentionsBody` —— 把一组 mentions 绑定到一条 `build_message` 上。
 *
 * 原站语义（`docs-conversation.md:34`）：`composer` 里 `Mention` 按钮 + prefix
 * (`@ agent or member, # todo, / skill, ~ project, & machine`) 写入的是
 * 「structured reference chip rather than plain text」——
 * 让 agent **resolves the exact ID instead of guessing**。
 *
 * **两步而非一步写入**：本端点不创建 message（不在 Target 里 —— 改动会冲击
 * 既有 911 个 server 测试的 fixture 写法），只把「引用关系」绑到调用方提供
 * 的 `messageId` 上。UI 侧先 POST 消息（已有 `POST /api/builds/:buildId/messages`）
 * 再 POST mentions，调用方按这个顺序串。
 *
 * **校验（路由层）**：
 *   - `messageId` 必须存在且属于调用方 todo 下的 build（否则 404）
 *   - `kind` 与 `prefix` 必须与原站表一致（路由层 `superRefine` 自检 + 数据库 CHECK 双兜底）
 *   - `'@'` 前缀可对应 `agent` 或 `member`（原站原文「`@ agent or member`」）；
 *     其它 prefix 与 kind 必须严格一一对应
 *   - 每条 `refId` 必须存在 + 调用者所属 team 可读（`agent` / `member` /
 *     `skill` / `project` / `machine` 按 teamId 收窄；`todo` 按
 *     `project.teamId` 收窄 —— 跨 project 但同 team 允许，与原站
 *     「can belong to another project on your team」一致）
 *   - 全部通过才写入；任一条失败 → 422/403/404，**零写入**（事务）
 *
 * **幂等**：同一 `messageId` 重复提交按 `(message_id, kind, ref_id)` 唯一约束
 * 收敛，重复行不产生。
 */
const MentionsBody = z
  .object({
    messageId: z.string().min(1).max(80),
    mentions: z
      .array(
        z.object({
          kind: z.enum(['agent', 'member', 'todo', 'skill', 'project', 'machine']),
          prefix: z.enum(['@', '#', '/', '~', '&']),
          refId: z.string().min(1).max(80),
          label: z.string().min(1).max(200),
        }),
      )
      .min(1)
      .max(50),
    // 留 `userId` 兜底未来切到 `proxyWrite`（BFF 会注入它），与 RestoreBody 同款。
    userId: z.string().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    // 路由层 `prefix ↔ kind` 自检。数据库 CHECK 也兜底一次（见 0003_mentions.sql）。
    // `'@'` 对应 agent 或 member（歧义），其它 prefix 严格 1:1。
    for (let i = 0; i < v.mentions.length; i += 1) {
      const m = v.mentions[i]!;
      const ok =
        (m.prefix === '@' && (m.kind === 'agent' || m.kind === 'member')) ||
        (m.prefix === '#' && m.kind === 'todo') ||
        (m.prefix === '/' && m.kind === 'skill') ||
        (m.prefix === '~' && m.kind === 'project') ||
        (m.prefix === '&' && m.kind === 'machine');
      if (!ok) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['mentions', i, 'kind'],
          message: `prefix "${m.prefix}" does not match kind "${m.kind}"`,
        });
      }
    }
  });
type MentionsBodyT = z.infer<typeof MentionsBody>;

/**
 * 把「看板拖拽到的目标相位」翻译成对应 trigger。
 *
 * **铁律**：本函数**不**承诺「这个 trigger 一定能落点 toPhase」——
 *   - `complete` 在 review 上：merge=false → done，merge=true → implement
 *     两条互斥，看板拖拽要看用户想落到哪一列才能定 merge。
 *   - `plan_ready` 在 planning 上：planFirst=true → confirm，planFirst=false → implement
 *     取决于 todo 的 planFirst 字段；本函数返回的 trigger 不带条件，
 *     transition() 会按 ctx.planFirst 自动选落点。
 *
 * 不存在的 (from→to) 组合返回 null —— 调用方（POST /move）一律 409，
 * 文案说清「这一跳转不在已有 trigger 集合里，不是简单拖拽能完成的」。
 */
function triggerForMove(fromPhase: TodoPhase, toPhase: TodoPhase): Trigger | null {
  if (fromPhase === toPhase) return null;
  // 任何非闸门相位都可以被 `fail` 或 `cancel` 推到 `failed` / `closed`。
  // 闸门 (`confirm` / `review`) 也接 `fail` / `cancel`（state-machine.ts 中
  // `gate ${current} rejects ${t}` 之前已 `if (t === 'fail') ... if (t === 'cancel') ...`）。
  if (toPhase === 'failed') return { kind: 'fail' };
  if (toPhase === 'closed') return { kind: 'cancel' };

  // 终态 (done/failed/closed) 也能被 `fail`/`cancel` 重写 —— 但 todo 已经在
  // 终态，再写一个 fail/cancel 是 no-op。让 triggerForMove 返回 null，由调用方
  // 走 reopen/rerun 端点更明确。
  if (isSettled(fromPhase)) return null;

  switch (`${fromPhase}->${toPhase}` as const) {
    case 'todo->planning':
    case 'queued->planning':
      // `claim` 需要 machineId 字段；看板拖拽不挑机器，传空串即可。
      // transition() 不读 machineId 的语义，只看 trigger.kind。
      return { kind: 'claim', machineId: '' };
    case 'planning->confirm':
    case 'planning->implement':
      // 落点取决于 ctx.planFirst；move 调用方在拿到 transition 结果后判
      // `next !== toPhase` → 409，语义由 transition 锁定。
      return { kind: 'plan_ready' };
    case 'confirm->implement':
      return { kind: 'approve', by: 'user' };
    case 'confirm->reviewing':
      return { kind: 'review_start' };
    case 'implement->review':
      return { kind: 'changes_ready' };
    case 'reviewing->confirm':
      return { kind: 'review_end' };
    case 'review->done':
      return { kind: 'complete', merge: false };
    case 'review->implement':
      return { kind: 'complete', merge: true };
    default:
      return null;
  }
}

/**
 * 把 zod 校验错误转成 422。这条比直接 safeParse 一遍再分支干净：
 * 调用方仅一行 `parseBody(Schema, req.body)`，语义保持 .parse 风格。
 */
function parseBody<T extends z.ZodTypeAny>(
  schema: T,
  payload: unknown,
): z.infer<T> {
  const r = schema.safeParse(payload);
  if (!r.success) {
    throw new HttpError(422, r.error.issues.map((i) => i.message).join('; '));
  }
  return r.data;
}

/**
 * 拼「那台机器上的一个子目录」。
 *
 * **为什么不用 Node 的 `path.join`**：服务端与目标机器可能不是同一个 OS
 * （服务端 Linux、机器 Windows 是常态），`path.join` 会用**本机**的分隔符，
 * 给 Windows 机器拼出 `/ws/sub` 这种它认不了的路径。`workspacesDir` 是机器
 * 自己上报的字符串，分隔符必然与它自己的 OS 一致 —— 所以按它已用的分隔符拼。
 * 只有「含 `\` 且不含 `/`」才当 Windows；混用（UNC 路径、Windows 上手写的
 * 正斜杠）一律走 `/`，那是 Windows 也接受的写法。
 */
function joinOnMachine(dir: string, segment: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  const trimmed = dir.endsWith(sep) ? dir.slice(0, -1) : dir;
  return `${trimmed}${sep}${segment}`;
}

/**
 * 在一个 todo 的 build 列表里找「Continue 真正想用的那条」：
 *   - 有 spec.buildId → 必须是该 todo 下、errorMessage 已设置的 build
 *   - 没传 → 取 todo 最新一条 build，且同样必须满足 errorMessage 已设置
 *
 * 「failed build」判定**只用** `build.errorMessage IS NOT NULL`：在
 *   `routes/machine.ts:528-534` 的 done 路径里，failed / cancelled 时
 *   `finishedAt` 留 null（只有 succeeded 才写 ts），所以「finishedAt = null」
 *   区分不了「失败」与「还在跑」；同时 phase 已经收成 failed 才会触发本端点。
 *   `errorMessage` 由 daemon 上报时落入（`routes/machine.ts:529`），是
 *   「该 build 真的失败过」的真源信号。`settlementCode` 是另一条枚举，不参与
 *   本判定 —— 因为 settlementCode=null 的 build 不一定没失败（也可能字段
 *   当时未填），用 errorMessage 更收敛。
 *
 * 返回 null 表示「没有失败 build 可 continue」—— 调用方用 409 报告。
 */
async function findContinueTarget(
  db: Db,
  todoId: string,
  requestedBuildId: string | undefined,
): Promise<{ id: string; n: number; errorMessage: string | null } | null> {
  // drizzle 的 select.from().where() 是单一查询构造点 —— 不能在结果上再次
  // .where() 链式相加（TS 也会报错的「'where' does not exist on type ...」）。
  // requestedBuildId 那边直接构造一个完整条件链，更直观。
  const errorNotNull = sql`${builds.errorMessage} is not null`;
  if (requestedBuildId) {
    const row = (await db
      .select({ id: builds.id, n: builds.n, errorMessage: builds.errorMessage })
      .from(builds)
      .where(
        and(
          eq(builds.todoId, todoId),
          eq(builds.id, requestedBuildId),
          errorNotNull,
        ),
      )
      .limit(1))[0];
    if (!row || !row.errorMessage) return null;
    return row;
  }
  const rows = await db
    .select({ id: builds.id, n: builds.n, errorMessage: builds.errorMessage })
    .from(builds)
    .where(and(eq(builds.todoId, todoId), errorNotNull))
    .orderBy(sql`${builds.n} desc`)
    .limit(1);
  return rows[0] ?? null;
}

export function registerTodoRoutes(app: FastifyInstance, db: Db): void {
  // ── 看板 ────────────────────────────────────────────────────────────

  app.get('/api/todos', async (req) => {
    const ctx = await resolveContext(db, req);
    // teamId 缺省时按「当前用户所属 team」收窄（不能跨租户）。
    // 给 teamId 时先 requireTeamMembership 校验 → 403（非 401：身份对，但没权）。
    const parsed = z
      .object({
        teamId: z.string().optional(),
        projectId: z.string().optional(),
      })
      .safeParse(req.query);

    if (!parsed.success) {
      return { todos: [] };
    }
    const q = parsed.data;

    const whereProject = q.projectId
      ? eq(todos.projectId, q.projectId)
      : sql`true`;
    let whereTeam;
    if (q.teamId) {
      await requireTeamMembership(db, ctx.userId, q.teamId);
      whereTeam = eq(projects.teamId, q.teamId);
    } else {
      const ids = await teamIdsForUser(db, ctx.userId);
      if (ids.length === 0) {
        return { todos: [] };
      }
      whereTeam = inArray(projects.teamId, ids);
    }

    const rows = await db
      .select({
        id: todos.id,
        phase: todos.phase,
        seqNum: todos.seqNum,
        title: todos.title,
        projectId: todos.projectId,
        projectName: projects.name,
        teamId: projects.teamId,
        // 看板筛选需要的两个字段（2026-10-18）：
        //   * ownerMemberId：用于「我创建的」/「其他成员创建的」过滤
        //   * createdByType：用于「总管或 Agent 创建的」过滤
        // 缺一个就筛不全 —— 契约 §3.2 列表项字段是冻结签名。
        ownerMemberId: todos.ownerMemberId,
        createdByType: todos.createdByType,
        createdAt: todos.createdAt,
        updatedAt: todos.updatedAt,
      })
      .from(todos)
      .innerJoin(projects, eq(projects.id, todos.projectId))
      .where(and(whereTeam, whereProject))
      .orderBy(sql`${todos.projectId} asc, ${todos.seqNum} asc`);

    return { todos: rows };
  });

  app.get('/api/todos/:todoId', async (req) => {
    const { todoId } = req.params as { todoId: string };
    const ctx = await resolveContext(db, req);

    const { todo: row, builds: buildRows, documents: allDocuments } = await loadTodoContext(
      db,
      todoId,
    );
    const teamId = await loadTodoTeamId(db, todoId);
    if (!teamId) throw new HttpError(404, 'team not found');
    await requireTeamMembership(db, ctx.userId, teamId);

    const currentPhase = row.phase;
    // 与「当前 phase」相关的文档用一个静态可枚举表决定；
    // input 不一定属于当前 phase，按 createdAt desc 永远取最新一条（后续 filter）。
    const desiredByPhase: Record<TodoPhase, readonly string[]> = {
      todo: [currentPhase, 'plan'],
      queued: [currentPhase, 'plan'],
      planning: [currentPhase, 'plan'],
      confirm: [currentPhase, 'plan'],
      implement: [currentPhase],
      reviewing: [currentPhase],
      review: [currentPhase, 'changes'],
      done: [currentPhase, 'changes'],
      failed: [currentPhase, 'changes'],
      closed: [currentPhase, 'changes'],
    };
    const desired = desiredByPhase[currentPhase];
    const currentPhaseDocuments = allDocuments.filter((d) => desired.includes(d.kind));

    return { todo: row, builds: buildRows, currentPhaseDocuments };
  });

  // ── Run history（文档：旧 build 只读保留）───────────────────────────

  app.get('/api/todos/:todoId/builds', async (req) => {
    const { todoId } = req.params as { todoId: string };
    const ctx = await resolveContext(db, req);
    // 以前 todo 不存在时这里回空列表，客户端分不清「没有 build」和「todo 不存在」；
    // 加了归属判定之后必须先解析出 team（解析不到 = todo 不存在）→ 404，与
    // documents 路由（~207-212）的语义对齐。
    const teamId = await loadTodoTeamId(db, todoId);
    if (!teamId) throw new HttpError(404, 'todo not found');
    await requireTeamMembership(db, ctx.userId, teamId);
    const buildRows = await db
      .select()
      .from(builds)
      .where(eq(builds.todoId, todoId))
      .orderBy(sql`${builds.n} desc`);
    return { builds: buildRows };
  });

  // ── 文档列表 ────────────────────────────────────────────────────────

  app.get('/api/todos/:todoId/documents', async (req) => {
    const { todoId } = req.params as { todoId: string };
    const ctx = await resolveContext(db, req);
    // 先确认 todo 存在 —— 否则「todo 不存在」与「todo 还没有 build」
    // 都会返回空列表，客户端无法分辨。
    const exists = (await db
      .select({ id: todos.id })
      .from(todos)
      .where(eq(todos.id, todoId))
      .limit(1))[0];
    if (!exists) throw new HttpError(404, 'todo not found');
    const teamId = await loadTodoTeamId(db, todoId);
    if (!teamId) throw new HttpError(404, 'team not found');
    await requireTeamMembership(db, ctx.userId, teamId);

    const buildIds = (await db
      .select({ id: builds.id })
      .from(builds)
      .where(eq(builds.todoId, todoId))).map((b) => b.id);
    if (buildIds.length === 0) return { documents: [] };
    const rows = await db
      .select()
      .from(documents)
      .where(inArray(documents.buildId, buildIds))
      .orderBy(sql`${documents.createdAt} desc`);
    return { documents: rows };
  });

  // ── 单文档 ──────────────────────────────────────────────────────────
  /**
   * `GET /api/documents/:docId` —— 拉单个文档（Changes / Plan 正文）。
   *
   * 为什么必须有：UI 两处直拉这条（`apps/web/src/app/todo/[id]/page.tsx:294`
   * 的 Composer 用 `latest.changesDocId`，`ConfirmPreview` 用
   * `latest.planDocId`），BFF `apps/web/src/app/api/documents/[docId]/route.ts`
   * 也已经写好了转发 —— 但服务端从来没有这条路由。实测：对一条**已落库**的
   * changes 文档 `GET /api/documents/pndhvDUm-0rJtpGRFZfPkOPh` 回
   * `404 {"error":"not found"}`，BFF 把它归一成 `ready:false`
   * `endpoint-not-implemented`，于是页面上永远显示「Changes 文档不可用」，
   * 哪怕 `build.changes_doc_id` 已经写了值。闸门上看不见 diff，等于这一轮
   * 白跑。
   *
   * 归属判定与列表路由同一套：文档 → build → todo → team。按主键查**不能**
   * 省掉团队校验，否则别的团队的 key 能凭 id 读到别人的 diff 正文。
   */
  app.get('/api/documents/:docId', async (req) => {
    const { docId } = req.params as { docId: string };
    const ctx = await resolveContext(db, req);
    const doc = (await db
      .select()
      .from(documents)
      .where(eq(documents.id, docId))
      .limit(1))[0];
    if (!doc) throw new HttpError(404, 'document not found');
    // `documents.build_id` 是 notNull + cascade（`packages/db/src/schema.ts:451`），
    // 所以这一跳必然存在；build 被删过（cascade 会连文档一起删）时兜底 404。
    const build = (await db
      .select({ todoId: builds.todoId })
      .from(builds)
      .where(eq(builds.id, doc.buildId))
      .limit(1))[0];
    if (!build) throw new HttpError(404, 'build not found');
    const teamId = await loadTodoTeamId(db, build.todoId);
    if (!teamId) throw new HttpError(404, 'team not found');
    await requireTeamMembership(db, ctx.userId, teamId);
    // **扁平返回**：BFF 把上游 JSON 原样塞进 `{ready:true,data}`，前端
    // `apps/web/src/lib/api.ts:96` 的 `Document` 就是这一行的形状
    // （`id/buildId/kind/version/payload/...`），`setChangesDoc(docBody.data)`
    // 直接当文档用。这里再包一层 `{document}` 会让前端拿到
    // `{document:{...}}`，`changesDoc.kind` 变 undefined，闸门照样空白。
    return doc;
  });

  // ── 创建 ────────────────────────────────────────────────────────────

  app.post('/api/todos', async (req) => {
    const body = parseBody(CreateTodoBody, req.body);
    const ctx = await resolveContext(db, req);
    await requireTeamMembership(db, ctx.userId, body.teamId);
    // `ownerMemberId` 是 `member.id`（不是 user id），且 `todo.owner_member_id` 没有 FK
    // （`schema.ts:244`）—— 不校验就会把 todo 挂到不存在或别团队的 member 上，库里
    // 看不出异常。谓词与 `routes/mcp.ts:531-541` 的 `create_todo` 完全一致（同一条
    // 403 措辞），两条写路径不能各判各的。
    const ownerIsMember = (await db
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.id, body.ownerMemberId), eq(members.teamId, body.teamId)))
      .limit(1))[0];
    if (!ownerIsMember) {
      throw new HttpError(
        403,
        `ownerMemberId "${body.ownerMemberId}" is not a member of team "${body.teamId}"`,
      );
    }

    // 容量校验 1：每 project ≤ FREE_LIMITS.openTodosPerProject —— 走 quota.openTodos()
    const openCount = await countOpenTodos(db, body.projectId);
    enforceQuota(quota.openTodos(openCount));

    // 容量校验 2：description(spec) ≤ 800 字符 —— 复用 quota.roleDescription()，
    //   它的 800 字符上限与本产品 spec 字段硬上限一致，并且消息风格统一。
    if (body.spec !== null) enforceQuota(quota.roleDescription(body.spec));

    // T6 收敛：REST 创建路径走服务层 `createTodo`，与 MCP / Chief 共用同一份
    // seq 分配 + 审计 + SSE 实现。spec 长度由 zod 的 SPEC_MAX_CHARS 兜底。
    // `createdByType: 'user'` —— 这是用户在 dashboard / 看板主按钮 / New
    // Todo 页主动创建的写路径。Chief / Agent 路径在各自 routes 文件里显式
    // 标 'chief' / 'agent'（service 层没有默认值，漏传编译失败）。
    return await createTodo(db, {
      teamId: body.teamId,
      projectId: body.projectId,
      ownerMemberId: body.ownerMemberId,
      agentId: body.agentId,
      title: body.title,
      spec: body.spec,
      tagIds: body.tagIds,
      planFirst: body.planFirst,
      separatePlanBuild: body.separatePlanBuild,
      withChecklist: body.withChecklist,
      createdByType: 'user',
    });
  });

  // ── Confirm 闸门主按钮 ───────────────────────────────────────────────

  app.post('/api/todos/:todoId/approve', async (req) => {
    const { todoId } = req.params as { todoId: string };
    const ctx = await resolveContext(db, req);
    const body = parseBody(ApproveBody, req.body ?? {});

    const todoRow = (await db
      .select({
        phase: todos.phase,
        planFirst: todos.planFirst,
      })
      .from(todos)
      .where(eq(todos.id, todoId))
      .limit(1))[0];
    if (!todoRow) throw new HttpError(404, 'todo not found');

    if (todoRow.phase !== 'confirm') {
      throw new HttpError(
        409,
        `approve is only valid at confirm gate; current phase is ${todoRow.phase}`,
      );
    }

    const teamId = await loadTodoTeamId(db, todoId);
    if (!teamId) throw new HttpError(404, 'team not found');
    await requireTeamMembership(db, ctx.userId, teamId);

    const trigger: Trigger = { kind: 'approve', by: body.by };
    assertGateTrigger(trigger);

    const r = await commitPhaseTransition(db, {
      todoId,
      teamId,
      trigger,
      planFirst: todoRow.planFirst,
    });

    if (!r.dispatch) {
      throw new HttpError(409, `transition refused: ${r.reason ?? 'unknown'}`);
    }
    return { ok: true, phase: r.next };
  });

  // ── Review 闸门主按钮 ────────────────────────────────────────────────

  app.post('/api/todos/:todoId/complete', async (req) => {
    const { todoId } = req.params as { todoId: string };
    const ctx = await resolveContext(db, req);
    const body = parseBody(CompleteBody, req.body ?? {});

    const todoRow = (await db
      .select({
        phase: todos.phase,
        planFirst: todos.planFirst,
      })
      .from(todos)
      .where(eq(todos.id, todoId))
      .limit(1))[0];
    if (!todoRow) throw new HttpError(404, 'todo not found');

    if (todoRow.phase !== 'review') {
      throw new HttpError(
        409,
        `complete is only valid at review gate; current phase is ${todoRow.phase}`,
      );
    }

    const teamId = await loadTodoTeamId(db, todoId);
    if (!teamId) throw new HttpError(404, 'team not found');
    await requireTeamMembership(db, ctx.userId, teamId);

    const trigger: Trigger = { kind: 'complete', merge: body.merge };
    assertGateTrigger(trigger);

    const r = await commitPhaseTransition(db, {
      todoId,
      teamId,
      trigger,
      planFirst: todoRow.planFirst,
    });

    // transition('review','complete', merge=false) → next='done'
    // transition('review','complete', merge=true)  → next='implement'
    // 任何 r.next='review' 表示被 transition 拒绝
    if (r.next === 'review' && !r.dispatch) {
      throw new HttpError(409, `transition refused: ${r.reason ?? 'unknown'}`);
    }
    return {
      ok: true,
      phase: r.next,
      mergeDispatch: body.merge && r.next === 'implement',
    };
  });

  // ── 闸门内的文字输入 —— 永远停在同一闸门 ────────────────────────────

  app.post('/api/todos/:todoId/feedback', async (req) => {
    const { todoId } = req.params as { todoId: string };
    const ctx = await resolveContext(db, req);
    const body = parseBody(FeedbackBody, req.body);

    const todoRow = (await db
      .select({ phase: todos.phase })
      .from(todos)
      .where(eq(todos.id, todoId))
      .limit(1))[0];
    if (!todoRow) throw new HttpError(404, 'todo not found');

    if (!isGate(todoRow.phase)) {
      throw new HttpError(
        409,
        `feedback only valid inside a gate (confirm / review); current phase is ${todoRow.phase}`,
      );
    }

    const teamId = await loadTodoTeamId(db, todoId);
    if (!teamId) throw new HttpError(404, 'team not found');
    await requireTeamMembership(db, ctx.userId, teamId);

    // 业务规则全在 `services/builds.ts` 的 `messageTodo` —— MCP 的 `message_todo`
    // 调的是同一个函数。REST 自己再实现一遍的话，两条写路径迟早漂移，而这里
    // 漂移的后果是「AI 能绕过闸门」。相位不变的铁律兜底也在服务层里。
    const r = await messageTodo(db, todoId, body.message);

    return {
      ok: true,
      phase: r.phase,
      advanced: false,
      revisionDispatched: r.revisionDispatched,
    };
  });

  // ── 看板拖拽改相位 ────────────────────────────────────────────────
  // 把「拖到 X 列」翻译成一个 trigger，再走 transition() 判定。
  // 铁律（与文件里其它 handler 一致）：**绝不**手写 phase if/else。
  // triggerForMove 只承诺「这个 trigger 在状态机里有定义」——
  // 真正的合法性（落点是否等于 toPhase）由 transition() 判定。

  app.post('/api/todos/:todoId/move', async (req) => {
    const { todoId } = req.params as { todoId: string };
    const ctx = await resolveContext(db, req);
    const body = parseBody(MoveBody, req.body);

    const todoRow = (await db
      .select({ phase: todos.phase, planFirst: todos.planFirst })
      .from(todos)
      .where(eq(todos.id, todoId))
      .limit(1))[0];
    if (!todoRow) throw new HttpError(404, 'todo not found');

    const teamId = await loadTodoTeamId(db, todoId);
    if (!teamId) throw new HttpError(404, 'team not found');
    await requireTeamMembership(db, ctx.userId, teamId);

    // 终态 → reopen / rerun 走独立端点；这里只能 fail / cancel。
    if (isSettled(todoRow.phase) && body.phase !== 'failed' && body.phase !== 'closed') {
      throw new HttpError(
        409,
        `todo is settled (phase=${todoRow.phase}); use /reopen or /rerun instead of /move to "${body.phase}"`,
      );
    }

    const trigger = triggerForMove(todoRow.phase, body.phase);
    if (trigger === null) {
      throw new HttpError(
        409,
        `move ${todoRow.phase} -> ${body.phase} is not expressible as a known trigger; ` +
          `it would require a new state-machine trigger, which /move cannot invent`,
      );
    }

    // 闸门内的 trigger（approve / complete / revision_feedback / cancel / reopen）
    // 走 assertGateTrigger 防御 —— 但 /move 也接受 cross-phase trigger（claim /
    // plan_ready / changes_ready / review_start / review_end / fail），不在
    // assertGateTrigger 白名单里。这里**不**调它：白名单只给「路由层只暴露给用户
    // 的闸门 trigger」，/move 是批量改相位，理论上要 emit 的 trigger 集合是
    // 白名单的超集（且路由层 + 状态机 + 服务层 commitPhaseTransition 三层校验
    // 仍是真源）。
    const r = await commitPhaseTransition(db, {
      todoId,
      teamId,
      trigger,
      planFirst: todoRow.planFirst,
    });

    // 闸门拒绝 / 落点错位 两种情形都在 ok:false 上汇聚 —— 路由层都 409。
    if (!r.ok) {
      throw new HttpError(
        409,
        `transition refused: move ${todoRow.phase} -> ${body.phase} via ${trigger.kind} ` +
          `rejected (${r.reason ?? 'no reason'}); transition would land on ${r.next}`,
      );
    }
    if (r.next !== body.phase) {
      // 状态机接受了 trigger，但落点与用户意图不一致 —— 例如 review → done 拖
      // 拽在 merge=true 时实际落 implement。这种「合法 trigger 但落点错位」
      // 必须告诉前端，不能把 todo 静默挪到别处让看板显示错位。
      throw new HttpError(
        409,
        `move ${todoRow.phase} -> ${body.phase} would actually land on ${r.next} ` +
          `(trigger=${trigger.kind}); the trigger is valid but the target phase does ` +
          `not match. Pick the correct board column or use a different endpoint`,
      );
    }

    // dispatch 已经在 commitPhaseTransition 里 publish 到 team + todo scope，
    // 看板订阅者会自动同步。这里不再额外 publish。
    return { ok: true, phase: r.next, dispatch: r.dispatch };
  });

  // ── 终态 → review（reopen） ────────────────────────────────────────
  // `reopen` 走 commitPhaseTransition 拿真值；终态 + reopen 必回 review（状态机
  // 既有语义，不改）。同样不允许手写 phase 判断。

  app.post('/api/todos/:todoId/reopen', async (req) => {
    const { todoId } = req.params as { todoId: string };
    const ctx = await resolveContext(db, req);
    // body 是空对象；保留 ReopenBody 让以后加字段不用改路由签名。
    parseBody(ReopenBody, req.body ?? {});

    const todoRow = (await db
      .select({ phase: todos.phase, planFirst: todos.planFirst })
      .from(todos)
      .where(eq(todos.id, todoId))
      .limit(1))[0];
    if (!todoRow) throw new HttpError(404, 'todo not found');

    const teamId = await loadTodoTeamId(db, todoId);
    if (!teamId) throw new HttpError(404, 'team not found');
    await requireTeamMembership(db, ctx.userId, teamId);

    if (!isSettled(todoRow.phase)) {
      throw new HttpError(
        409,
        `reopen is only valid on a settled todo (done/failed/closed); current phase is ${todoRow.phase}`,
      );
    }

    const trigger: Trigger = { kind: 'reopen' };
    assertGateTrigger(trigger);

    const r = await commitPhaseTransition(db, {
      todoId,
      teamId,
      trigger,
      planFirst: todoRow.planFirst,
    });

    if (!r.ok || r.next !== 'review') {
      throw new HttpError(
        409,
        `transition refused: reopen on ${todoRow.phase} would land on ${r.next} ` +
          `(${r.reason ?? 'unknown'})`,
      );
    }

    return { ok: true, phase: r.next, dispatch: r.dispatch };
  });

  // ── 终态 → todo（rerun） ────────────────────────────────────────────
  // `transition(终态, submit)` → {ok:true, next:'todo', dispatch: undefined}，
  // dispatch 缺席语义由 commitPhaseTransition 转成 false；不再额外派 build，
  // 真正的 build 由后续 claim 触发（与 chief.ts 的 createTodo → claim 流程同源）。

  app.post('/api/todos/:todoId/rerun', async (req) => {
    const { todoId } = req.params as { todoId: string };
    const ctx = await resolveContext(db, req);
    parseBody(RerunBody, req.body ?? {});

    const todoRow = (await db
      .select({ phase: todos.phase, planFirst: todos.planFirst })
      .from(todos)
      .where(eq(todos.id, todoId))
      .limit(1))[0];
    if (!todoRow) throw new HttpError(404, 'todo not found');

    const teamId = await loadTodoTeamId(db, todoId);
    if (!teamId) throw new HttpError(404, 'team not found');
    await requireTeamMembership(db, ctx.userId, teamId);

    if (!isSettled(todoRow.phase)) {
      throw new HttpError(
        409,
        `rerun is only valid on settled todos; current phase is ${todoRow.phase}`,
      );
    }

    const trigger: Trigger = { kind: 'submit' };
    const r = await commitPhaseTransition(db, {
      todoId,
      teamId,
      trigger,
      planFirst: todoRow.planFirst,
    });

    if (!r.ok || r.next !== 'todo') {
      throw new HttpError(
        409,
        `transition refused: rerun on ${todoRow.phase} would land on ${r.next} ` +
          `(${r.reason ?? 'unknown'})`,
      );
    }

    // submit 在终态上的 dispatch 缺席 —— 不另外创建 build。状态机已经决定
    // 「submit 仅重置 phase」，新 build 由后续 claim 流程触发。
    return { ok: true, phase: r.next };
  });

  // ── 终态 failed → 在原 build 上重试那一轮（Continue） ────────────
  // 原站 `docs-todos.md` 原文：「Continue — retrying the failed turn **in place
  // on the existing build**, keeping its conversation and code changes — which is
  // also Chief's default when rerunning a failed todo」。
  //
  // **为什么不用 `transition()` 把 phase 推走**：状态机里 `failed` 只能走
  // `reopen`（→ review）或 `submit`（→ todo = Start over）两个 trigger，**没有**
  // `failed → planning/implement/queued` 的路径。继续语义是「retry in place」——
  // 真正让 todo 重新跑起来的是那台 daemon 看到新 step 并 `claim`。所以这条端点
  // 在状态机层**不动 phase**：
  //   1. 校验 phase === 'failed'
  //   2. 找目标 build（spec.buildId 优先，否则 todo 最新的 build）
  //   3. 校验「这个 build 确实失败过」（`build.errorMessage IS NOT NULL`）
  //   4. 同一事务：清掉 build 行上的失败标记 + 新写一条 `queued` step + 写审计
  //   5. publish 一个 SSE `continue_queued` 让前端看板自动刷新
  //
  // ⚠️ **daemon 限制披露**：本切片只能写到「库里已重置 + 新 step 入队」。Daemon
  // 那边若是「只接 `pendingRestore` 非空的 build」，则该 step 不会被拾起，但
  // 这一行失败模式需要 daemon / Restore 切片去补 `pendingRestore` —— 不在本切
  // 片的 scope 里伪造接口。注释与 UI 文案**必须**如实告诉用户。
  //
  // 状态机里没有从 `failed` 到非终态的 trigger，所以端点不调 transition()，
  // 用 422-like 409 报告「phase 不允许」即可（与原站一致：only failed 有 Continue）。
  app.post('/api/todos/:todoId/continue', async (req) => {
    const { todoId } = req.params as { todoId: string };
    const ctx = await resolveContext(db, req);
    const body = parseBody(ContinueBody, req.body ?? {});

    const todoRow = (await db
      .select({ phase: todos.phase, planFirst: todos.planFirst })
      .from(todos)
      .where(eq(todos.id, todoId))
      .limit(1))[0];
    if (!todoRow) throw new HttpError(404, 'todo not found');

    const teamId = await loadTodoTeamId(db, todoId);
    if (!teamId) throw new HttpError(404, 'team not found');
    await requireTeamMembership(db, ctx.userId, teamId);

    if (todoRow.phase !== 'failed') {
      throw new HttpError(
        409,
        `continue is only valid on a failed todo; current phase is ${todoRow.phase} ` +
          `(use /reopen or /rerun for non-failed end states)`,
      );
    }

    // 找目标 build：spec 优先；否则取最新一个。两条路径都必须落到真正
    // 失败过的 build（`errorMessage IS NOT NULL`），否则 409。
    const targetBuild = await findContinueTarget(db, todoId, body.buildId);
    if (!targetBuild) {
      throw new HttpError(
        409,
        body.buildId
          ? `build "${body.buildId}" is not a failed build of this todo; ` +
            `continue requires a build with errorMessage set`
          : `todo has no failed build to continue; ` +
            `use /rerun to start a fresh build instead`,
      );
    }

    // 同一事务：清失败标记 + 写新 step（无机器也可以先入 step，等机器 claim）
    // + audit。step 复用 `step_status` enum 的 'queued'。build.finishedAt 本来
    // failed 时就是 null，不需要清。
    const ts = now();
    const result = await db.transaction(async (tx) => {
      await tx
        .update(builds)
        .set({
          settlementCode: null,
          errorMessage: null,
          // v 自增 —— SSE / 客户端按 v 识别「这一行被改过」
          v: sql`${builds.v} + 1`,
        })
        .where(eq(builds.id, targetBuild.id));

      const stepId = newId();
      await tx.insert(steps).values({
        id: stepId,
        buildId: targetBuild.id,
        // machineId 为 null：等 daemon claim（同 startBuild 的 same 路径）
        machineId: null,
        status: 'queued',
      });

      await tx.insert(auditEvents).values({
        teamId,
        actorType: 'user',
        todoId,
        buildId: targetBuild.id,
        type: 'continue_queued',
        payload: {
          stepId,
          buildN: targetBuild.n,
          fromErrorMessage: targetBuild.errorMessage,
        },
        createdAt: ts,
      });

      return { stepId };
    });

    // SSE：让看板与详情页自动看到 build 行 / 新 step。
    // 用 `step_update` 而不是新发明的 type —— 客户端已订阅该 type 并刷新。
    await publish(db, targetBuild.id, 'step_update',
      { status: 'queued', todoId, buildId: targetBuild.id },
      teamId);
    await publish(db, `todo:${todoId}`, 'phase_changed',
      { todoId, phase: 'failed', continued: true },
      teamId);

    // ⚠️ phase 这里**显式返回当前值**（不变），前端用此判断刷新完后状态。
    return {
      ok: true,
      phase: 'failed' as const,
      buildId: targetBuild.id,
      stepId: result.stepId,
      continued: true,
    };
  });

  // ── 终态 → 复用上一个 build 的 plan 文档起新 build ─────────────
  // 原站 `docs-todos.md` 原文：「if the previous build produced a plan, rerunning
  // also offers Reuse plan」。复用 = 新 build + 该 build 把它上一次那版 plan
  // 文档内容当作「起手输入」。
  //
  // **不调 `runBuilds()`**：MCP 的 `run_builds` 在 `services/builds.ts:240` 有
  // 完整的「选机器 + 写 build + 写 step + 推进 phase + audit + SSE」事务。
  // 复用 plan 要做的是：在它写完 build 之后，**额外写一条 plan 文档（指向新
  // build）并把它的 id 回填到新 build 的 `planDocId`**。但 `runBuilds` 不
  // 暴露这一步钩子。两种修法：
  //   (a) 抽一个 `startNewBuildAndAttachPlan(db, todoId, sourcePlan)` 进
  //       services。这条路侵入面大，且与 MCP `run_builds` 还需要共用 step
  //       事务；本期范围不扩。
  //   (b) **同一事务里手写 build + step + phase + plan 文档**，事务外 publish。
  //       选这条 —— 字段集合与 `startBuild()` 同形、与 `services/builds.ts:130-260`
  //       那份 insert 等价；不共用的代价是「如果以后 services 改 build 行
  //       字段漏改本路由」，但改一处时同时被 reviewer 看到，trade-off 可接受。
  //
  // 状态机：终态 `submit` → `todo`（与 `/rerun` 走完全一样的 transition 校验），
  // 故本端点**先调 `commitPhaseTransition({kind:'submit'})`**（dispatch 缺席
  // —— 与 `/rerun` 完全同源）；然后在同一 try 之后起新 build + 复制 plan。
  app.post('/api/todos/:todoId/reuse-plan', async (req) => {
    const { todoId } = req.params as { todoId: string };
    const ctx = await resolveContext(db, req);
    const body = parseBody(ReusePlanBody, req.body ?? {});

    const todoRow = (await db
      .select({ phase: todos.phase, planFirst: todos.planFirst, agentId: todos.agentId })
      .from(todos)
      .where(eq(todos.id, todoId))
      .limit(1))[0];
    if (!todoRow) throw new HttpError(404, 'todo not found');

    const teamId = await loadTodoTeamId(db, todoId);
    if (!teamId) throw new HttpError(404, 'team not found');
    await requireTeamMembership(db, ctx.userId, teamId);

    if (!isSettled(todoRow.phase)) {
      throw new HttpError(
        409,
        `reuse-plan is only valid on a settled todo (done/failed/closed); ` +
          `current phase is ${todoRow.phase}`,
      );
    }

    // 找「最近一个写过 plan 的 build」：用 planDocId 是因为
    //   - builds.withPlan = planFirst 的透传（`services/builds.ts:148`），**不是**
    //     「该 build 实际产出过 plan」的信号
    //   - planDocId 不为 null 就说明 documents 表里有一条 kind='plan' 的文档
    //     属于该 build —— 即「真产出过 plan」
    const sourceBuild = body.buildId
      ? (await db
          .select({
            id: builds.id,
            n: builds.n,
            todoId: builds.todoId,
            planDocId: builds.planDocId,
          })
          .from(builds)
          .where(and(eq(builds.id, body.buildId), eq(builds.todoId, todoId)))
          .limit(1))[0]
      : (await db
          .select({
            id: builds.id,
            n: builds.n,
            todoId: builds.todoId,
            planDocId: builds.planDocId,
          })
          .from(builds)
          .where(and(eq(builds.todoId, todoId), sql`${builds.planDocId} is not null`))
          .orderBy(sql`${builds.n} desc`)
          .limit(1))[0];

    if (!sourceBuild || !sourceBuild.planDocId) {
      throw new HttpError(
        409,
        body.buildId
          ? `build "${body.buildId}" has no plan document (planDocId is null); ` +
            `reuse-plan requires a build that actually produced a plan`
          : `latest build of this todo has no plan document; ` +
            `cannot reuse plan — use /rerun to start a fresh build instead`,
      );
    }

    // take the source plan doc content（不允许 plan_doc 不在 documents 里）
    const sourceDoc = (await db
      .select({ payload: documents.payload })
      .from(documents)
      .where(and(eq(documents.id, sourceBuild.planDocId), eq(documents.kind, 'plan')))
      .limit(1))[0];
    if (!sourceDoc) {
      throw new HttpError(
        409,
        `source build's planDocId "${sourceBuild.planDocId}" does not correspond ` +
          `to a plan document; cannot reuse plan`,
      );
    }

    // ── 推进阶段：终态 → todo ────────────────────────────────────
    // 与 `/rerun` 同源的`submit` trigger，状态机保证终态上 ok → next:'todo'。
    const trigger: Trigger = { kind: 'submit' };
    const r = await commitPhaseTransition(db, {
      todoId,
      teamId,
      trigger,
      planFirst: todoRow.planFirst,
    });
    if (!r.ok || r.next !== 'todo') {
      throw new HttpError(
        409,
        `transition refused: reuse-plan on ${todoRow.phase} would land on ${r.next} ` +
          `(${r.reason ?? 'unknown'})`,
      );
    }

    // ── 起新 build（手动，与 startBuild() 等价） ─────────────────
    // 按 services/builds.ts:130-260 的形状做最小实现：n+1、分支名
    // `tds/conv-<buildId>`、session 初值、v=0。无 step 等 daemon claim：
    // `pickAvailableMachine` 可能为 null，与 Chief 分支同样处理（不写 step）。
    // **不**复用 startBuild() —— 因为它走 transition 我们已经跑过了。
    const ts = now();
    const newBuildId = newId();
    const buildAndDoc = await db.transaction(async (tx) => {
      const prior = (await tx
        .select({ maxN: sql<number>`coalesce(max(${builds.n}), 0)::int` })
        .from(builds)
        .where(eq(builds.todoId, todoId)))[0];
      const newN = Number(prior?.maxN ?? 0) + 1;

      await tx.insert(builds).values({
        id: newBuildId,
        todoId,
        n: newN,
        branch: `tds/conv-${newBuildId}`,
        // reuse-plan 总是从「用户主动挑这个 build」起步，下一阶段是 todo
        prevPhase: todoRow.phase,
        triggerSource: 'user',
        withPlan: true,                 // 一上来就承诺要 plan；旧 plan 文档已复制
        withChecklist: false,
        agentId: todoRow.agentId ?? '',
        pinnedMachineId: null,
        session: { runtime: 'unknown', id: newId(), openedAt: ts },
        usageByModel: [],
        createdAt: ts,
        v: 0,
      });

      const newPlanDocId = newId();
      await tx.insert(documents).values({
        id: newPlanDocId,
        buildId: newBuildId,
        kind: 'plan',
        version: 1,
        payload: sourceDoc.payload,
        createdAt: ts,
        updatedAt: ts,
      });

      await tx
        .update(builds)
        .set({ planDocId: newPlanDocId, v: sql`${builds.v} + 1` })
        .where(eq(builds.id, newBuildId));

      await tx.insert(auditEvents).values({
        teamId,
        actorType: 'user',
        todoId,
        buildId: newBuildId,
        type: 'plan_reused',
        payload: {
          sourceBuildId: sourceBuild.id,
          sourcePlanDocId: sourceBuild.planDocId,
          reusedPlanDocId: newPlanDocId,
        },
        createdAt: ts,
      });

      return { n: newN, newPlanDocId };
    });

    await publish(db, newBuildId, 'plan_reused',
      { todoId, buildId: newBuildId, reusedFrom: sourceBuild.id },
      teamId);
    await publish(db, `todo:${todoId}`, 'build_created',
      { todoId, buildId: newBuildId, n: buildAndDoc.n },
      teamId);
    await publish(db, `team:${teamId}`, 'build_created',
      { todoId, buildId: newBuildId, n: buildAndDoc.n },
      teamId);

    return {
      ok: true,
      phase: 'todo' as const,
      buildId: newBuildId,
      reusedPlanFrom: sourceBuild.id,
    };
  });

  // ── Rewind / Restore ─────────────────────────────────────────────
  // 原站 `docs-conversation.md`（Rewinding 段）：
  //   "Any earlier round can be restored ... The conversation and code return
  //    to that checkpoint, the message you sent there goes back into the
  //    composer for you to edit and resend, and the agent continues from
  //    there — much faster than arguing a run back on track when it drifted
  //    several turns ago."
  //   "Restoring is available while the todo rests at Confirm, Review, or
  //    Failed (not while a turn is running or after the todo is marked Done),
  //    and only for the todo's owner ... rolling the worktree and session
  //    back is deferred to the start of the next turn on whichever machine
  //    runs it."
  //   "Agent memory survives a rewind; lessons the agent saved stay saved."
  //
  // 切片范围（**只写 pendingRestore + 校验**，不接通 daemon 真实回滚）：
  //   1. 时机校验：phase ∈ {confirm, review, failed}，且 build 不在跑
  //      （`steps.status` 仍有 queued/pending/running ⇒ 拒绝，理由同上）
  //   2. owner 校验：复用 `routes/needs-you.ts` 的 INNER JOIN 谓词
  //      （member.id=todos.owner_member_id AND member.member_type='user'
  //       AND member.actor_id=ctx.userId AND team 一致）
  //   3. 写库：`builds.pending_restore = {sessionLeafEntryId, commitSha, sessionId}`
  //      其中 `sessionId` 服务端从 `builds.session.id` 取
  //      （build 行 not null 存着 JSONB）。
  //      **绝不**改 `todo.phase` —— 状态机没有 rewind/restore trigger，
  //      改相位就破坏「状态机是唯一事实源」铁律。
  //   4. 重复 restore 拒绝（409）—— 覆盖会丢用户上次的选择；想取消
  //      pendingRestore 应另开 DELETE 端点，本切片不做。
  //   5. 不在跑判定用 **`steps` 表**：
  //      `builds.finishedAt` 在 failed/cancelled 时也是 null
  //      （`routes/machine.ts:528-534` done 路径里只在 succeeded 写 ts），
  //      所以「finishedAt IS NULL」同时覆盖「正在跑」「失败」「取消」三种状态，
  //      **不能用**。`steps` 才是真源信号 —— `services/builds.ts:288` 的
  //      `cancelBuilds` 用 `status IN (queued,pending,running)` 判 open，
  //      与本端点判定同源。
  //   6. 落 audit + publish SSE，让前端 todo 详情页 + 看板自动同步。
  app.post('/api/todos/:todoId/restore', async (req) => {
    const { todoId } = req.params as { todoId: string };
    const ctx = await resolveContext(db, req);
    const body = parseBody(RestoreBody, req.body ?? {});

    const todoRow = (await db
      .select({
        phase: todos.phase,
        ownerMemberId: todos.ownerMemberId,
        projectId: todos.projectId,
      })
      .from(todos)
      .where(eq(todos.id, todoId))
      .limit(1))[0];
    if (!todoRow) throw new HttpError(404, 'todo not found');

    // ── 1) 时机校验 ──
    // 原站：available while the todo rests at Confirm, Review, or Failed.
    // 不在跑判定走 steps 表（见上方注释）。
    const ALLOWED: readonly TodoPhase[] = ['confirm', 'review', 'failed'];
    if (!(ALLOWED as readonly string[]).includes(todoRow.phase)) {
      throw new HttpError(
        409,
        `restore is only valid at confirm / review / failed; current phase is ${todoRow.phase}`,
      );
    }

    const teamId = await loadTodoTeamId(db, todoId);
    if (!teamId) throw new HttpError(404, 'team not found');

    // 真正的 team membership 校验 —— 即便 owner 通过，同团队校验仍要走。
    // owner 谓词只验证「owner_member_id 属于当前 user」，不替代 membership。
    await requireTeamMembership(db, ctx.userId, teamId);

    // ── 2) owner 校验（复用 needs-you.ts 的谓词） ──
    // 用 INNER JOIN 一次查完 —— 跨团队 / 同团队非 owner / owner 是 agent 这三种
    // 情况都把行剔掉，剩余 0 行 ⇒ 403。
    // 与 `routes/needs-you.ts:107-112`（gateRows 谓词）字面同源。
    const ownerRow = (await db
      .select({ id: members.id })
      .from(members)
      .innerJoin(projects, eq(projects.id, todoRow.projectId))
      .where(
        and(
          eq(members.id, todoRow.ownerMemberId),
          eq(members.teamId, projects.teamId),
          eq(members.memberType, 'user'),
          eq(members.actorId, ctx.userId),
        ),
      )
      .limit(1))[0];
    if (!ownerRow) {
      throw new HttpError(
        403,
        `restore is only allowed for the todo's owner; user "${ctx.userId}" ` +
          `is not the owner of todo "${todoId}"`,
      );
    }

    // ── 3) 找目标 build ──
    // body 不带 buildId → 默认取 todo 最新一个 build；带 buildId 则必须
    // 属于该 todo 且不是别的 todo 的 build。Restore 是「最近一轮出问题」
    // 的语义，默认最新一条是正解。
    const targetBuildRow = body.buildId
      ? (await db
          .select({
            id: builds.id,
            todoId: builds.todoId,
            n: builds.n,
            session: builds.session,
            pendingRestore: builds.pendingRestore,
          })
          .from(builds)
          .where(and(eq(builds.id, body.buildId), eq(builds.todoId, todoId)))
          .limit(1))[0]
      : (await db
          .select({
            id: builds.id,
            todoId: builds.todoId,
            n: builds.n,
            session: builds.session,
            pendingRestore: builds.pendingRestore,
          })
          .from(builds)
          .where(eq(builds.todoId, todoId))
          .orderBy(sql`${builds.n} desc`)
          .limit(1))[0];

    if (!targetBuildRow) {
      throw new HttpError(
        404,
        body.buildId
          ? `build "${body.buildId}" not found for this todo`
          : `todo has no build to restore`,
      );
    }

    // ── 4) 不在跑校验 —— steps 表为准 ──
    const openStep = (await db
      .select({ id: steps.id })
      .from(steps)
      .where(
        and(
          eq(steps.buildId, targetBuildRow.id),
          inArray(steps.status, ['queued', 'pending', 'running']),
        ),
      )
      .limit(1))[0];
    if (openStep) {
      throw new HttpError(
        409,
        `restore is not allowed while the build is running (an open step ` +
          `with status queued|pending|running exists); wait for the build to settle`,
      );
    }

    // ── 5) 重复 restore 拒绝 ──
    if (targetBuildRow.pendingRestore) {
      throw new HttpError(
        409,
        `a restore is already pending for this build (pendingRestore is set); ` +
          `cancel it first or wait for it to settle`,
      );
    }

    // ── 6) 写库：pending_restore + audit + v 自增 ──
    // sessionId 从 build.session JSONB 取（`packages/db/src/schema.ts:336` 声明
    // session.notNull() —— 一定存在）；其它两个字段由调用方提供。
    const sessionId = targetBuildRow.session.id;
    const ts = now();

    await db.transaction(async (tx) => {
      await tx
        .update(builds)
        .set({
          pendingRestore: {
            sessionLeafEntryId: body.sessionLeafEntryId,
            commitSha: body.commitSha,
            sessionId,
          },
          v: sql`${builds.v} + 1`,
        })
        .where(eq(builds.id, targetBuildRow.id));

      await tx.insert(auditEvents).values({
        teamId,
        actorType: 'user',
        actorId: ctx.userId,
        todoId,
        buildId: targetBuildRow.id,
        type: 'restore_requested',
        payload: {
          commitSha: body.commitSha,
          sessionLeafEntryId: body.sessionLeafEntryId,
          sessionId,
          buildN: targetBuildRow.n,
        },
        createdAt: ts,
      });
    });

    // ── 7) publish SSE ──
    // 用 `step_update` 同款 type，前端已经在订阅，build 行 v+1 后会自动刷新。
    await publish(db, targetBuildRow.id, 'step_update',
      { status: 'queued', todoId, buildId: targetBuildRow.id, restoreQueued: true },
      teamId);
    await publish(db, `todo:${todoId}`, 'phase_changed',
      { todoId, phase: todoRow.phase, restoreQueued: true },
      teamId);

    return {
      ok: true as const,
      todoId,
      buildId: targetBuildRow.id,
      phase: todoRow.phase,
      pendingRestore: {
        sessionLeafEntryId: body.sessionLeafEntryId,
        commitSha: body.commitSha,
        sessionId,
      },
      // ⚠️ daemon 限制披露：原站原文「rolling the worktree and session back
      // is deferred to the start of the next turn on whichever machine runs it」。
      // 我们这里只把 pendingRestore 写入 DB，daemon 端在 next turn 看到非空
      // pendingRestore 时是否真的回滚 worktree + 续 session 是另一个切片。
      // UI 文案**必须**如实告诉用户这一点 —— 不承诺自动回滚。
      daemonPending: true as const,
    };
  });

  // ── Reset ─────────────────────────────────────────────────────
  // 契约 §3.3（2026-10-18 看板新增）。
  //
  // 原站语义（5 步引导第 2 步 · 拖拽移动）：
  //   "已开始的卡片拖回「待开始」会重置任务：中断构建并清空对话、方案和改动记录。"
  //
  // 本切片**仅数据库层 + 状态机语义**：phase=todo、清掉该 todo 名下所有 document、
  // build 置终态、updated_at = now、写 audit、发 SSE。清「对话 = build_message」
  // 留作后续 —— 它对状态恢复没那么核心，且面太大（build_message 是机器侧上下文。
  // 是否要清，得先和 daemon 确认「同一个 buildId 重起时它是该读旧消息还是新消息」
  // —— 这是另一片）。本切片明示 UI 给出「重置后该 todo 的对话已清空（方案 / 改动 /
  // 输入 / 校验清单）」，并把「以后这条 build 的对话还会被读」写进限制披露。
  //
  // 删除顺序（**为什么不能靠 cascade**）：
  //   `documents` 表的 FK 是 `build_id → build(id) ON DELETE CASCADE`，**不**
  //   `todo_id`。所以删 `todo` 行不会带走 `documents`，得手动按 buildIds 删。
  //   build 不能直接删（删了 todo 也走 cascade 一起没了 —— reset 只重置不删
  //   todo），所以只能按 buildIds 显式 `DELETE FROM document WHERE build_id IN(...)`。
  //   这条不显式做的话，用户重置完 todo 还能在「Old Plans / Changes」栏看到
  //   上一次的方案，违反原站「清空对话、方案和改动记录」语义。
  app.post('/api/todos/:todoId/reset', async (req) => {
    const { todoId } = req.params as { todoId: string };
    const ctx = await resolveContext(db, req);
    parseBody(ResetBody, req.body ?? {});

    // 1) 解析 teamId + 归属校验 → 403
    const teamId = await loadTodoTeamId(db, todoId);
    if (!teamId) throw new HttpError(404, 'todo not found');
    await requireTeamMembership(db, ctx.userId, teamId);

    // 2) 读 todo 行（要 phase + 当前 updatedAt + owner 字段）
    const todoRow = (await db
      .select({
        phase: todos.phase,
      })
      .from(todos)
      .where(eq(todos.id, todoId))
      .limit(1))[0];
    if (!todoRow) throw new HttpError(404, 'todo not found');

    // 3) 终态 todo 不允许 reset
    if (isSettled(todoRow.phase)) {
      throw new HttpError(
        409,
        `reset is not valid on a settled todo (phase=${todoRow.phase}); ` +
          `use /reopen or /rerun instead`,
      );
    }

    // 4) 同事务：建 buildIds、documents 全删、把未结束 build 写 finishedAt、
    //    todo.phase='todo'、updatedAt=now、写 audit。事务原子性靠 db.transaction。
    //
    //    **为什么不调 `commitPhaseTransition`**：commitPhaseTransition 的设计是
    //    「接受 trigger 的闸门推进」，但 `reset` 不是状态机里的合法 trigger
    //    （不属于 `Trigger.kind` 的联合类型：approve/complete/revision_feedback/
    //    cancel/reopen/submit/claim/plan_ready/changes_ready/review_start/
    //    review_end/fail/restore —— reset 不在）。自己写 `update todos set phase`
    //    + 同款 audit + SSE 形状（与 commitPhaseTransition 对齐，不发明新 type）。

    const ts = now();
    const buildIds = (
      await db
        .select({ id: builds.id })
        .from(builds)
        .where(eq(builds.todoId, todoId))
    ).map((b) => b.id);

    // 若有 build，先清 documents（FK 指向 build 不指向 todo）
    // + 把没 finishedAt 的 build 标 settled。两条都在前面算 buildIds。
    const txResult = await db.transaction(async (tx) => {
      if (buildIds.length > 0) {
        // document FK 是 build_id → build(id) CASCADE，不指向 todo —— 必须显式删。
        // 不显式 → cascade 不会触发，因为 build 还在（我们只标 finishedAt，不删）。
        await tx
          .delete(documents)
          .where(inArray(documents.buildId, buildIds));

        // 把「还没收尾」的 build 写 finishedAt —— 让 daemon 端的「该 build
        // 还在跑」的查询（`builds.finished_at IS NULL`）立刻收敛。
        // 注意：**不**改 `build.errorMessage` / `settlementCode`，因为「重置」
        // 不是失败也不是成功 —— 是「主动放弃这一轮」。把 errorMessage 留 null
        // 会让产品侧误判成「build 正常结束但 commit 没写」。
        await tx
          .update(builds)
          .set({
            finishedAt: ts,
            // v 自增让任何订阅 build 行的客户端收到一行变化
            v: sql`${builds.v} + 1`,
          })
          .where(
            and(
              inArray(builds.id, buildIds),
              sql`${builds.finishedAt} is null`,
            ),
          );
      }

      // todo 本身回到 'todo'。updatedAt 必更新：DONE 列 7 天窗口靠
      // updatedAt desc 排序；reset 后这条 todo 若曾经 done 也已不再 done
      // （前置 isSettled 把终态挡了），但保持 updatedAt 刷新让 SSE 端知道
      // 这一行变了。
      await tx
        .update(todos)
        .set({ phase: 'todo', updatedAt: ts })
        .where(eq(todos.id, todoId));

      // 双轨审计 —— reset 是人类主动行为，actorType = 'user'。
      await tx.insert(auditEvents).values({
        teamId,
        actorType: 'user',
        actorId: ctx.userId,
        todoId,
        buildId: null,
        type: 'todo_reset',
        payload: {
          from: todoRow.phase,
          buildIds,
          documentCount: buildIds.length, // 不精确（删行数），但便于审计回放
        },
        createdAt: ts,
      });

      // SSE 行 —— 与 commitPhaseTransition 同款（scope team + scope todo,
      // type 'phase_changed'）。客户端订阅 phase_changed type 即可拿到。
      // seq 由事务返回给外层；外层在事务提交后再 deliverEvent，推送顺序与
      // commitPhaseTransition 同源。
      const changePayload = { todoId, from: todoRow.phase, to: 'todo' as const, trigger: 'reset' };
      const insertedTodo = await tx
        .insert(sseEvents)
        .values({
          teamId,
          scope: `todo:${todoId}`,
          type: 'phase_changed',
          payload: changePayload,
          createdAt: ts,
        })
        .returning({ seq: sseEvents.seq });
      await tx.insert(sseEvents).values({
        teamId,
        scope: `team:${teamId}`,
        type: 'phase_changed',
        payload: changePayload,
        createdAt: ts,
      });
      return { todoSseSeq: insertedTodo[0]?.seq ?? 0, changePayload };
    });

    // 事务已提交 —— 现在推送给本进程订阅者。commitPhaseTransition 也是
    // 同样的「先 recordEvent 拿到 seq，再 commit 后 deliverEvent」。
    if (txResult.todoSseSeq > 0) {
      deliverEvent(
        `todo:${todoId}`,
        'phase_changed',
        txResult.todoSseSeq,
        txResult.changePayload,
      );
    }

    return { ok: true as const, phase: 'todo' as const };
  });

  // ── Cancel ───────────────────────────────────────────────────
  // 契约 §3.3（2026-10-18 看板新增）—— 关闭 todo，对应 `Trigger.kind = 'cancel'`。
  //
  // 状态机里 `cancel` 把任何非终态推到 `closed`（与 `close` 不同：`close` 是死字段，
  // 见 services/todos.ts:42-46）。
  //
  // 契约要求「无 build 409」：此 todo 还没起过 build 时没有「运行中流程」要中断，
  // 「关闭」没业务意义 —— 这种 todo 应该走 `delete` 而不是 `cancel`。所以
  // 端点校验「至少一个 build 行存在」，否则 409。
  app.post('/api/todos/:todoId/cancel', async (req) => {
    const { todoId } = req.params as { todoId: string };
    const ctx = await resolveContext(db, req);
    parseBody(CancelBody, req.body ?? {});

    const teamId = await loadTodoTeamId(db, todoId);
    if (!teamId) throw new HttpError(404, 'todo not found');
    await requireTeamMembership(db, ctx.userId, teamId);

    const todoRow = (await db
      .select({
        phase: todos.phase,
        planFirst: todos.planFirst,
      })
      .from(todos)
      .where(eq(todos.id, todoId))
      .limit(1))[0];
    if (!todoRow) throw new HttpError(404, 'todo not found');

    // 终态不能 cancel（语义重叠：终态上 cancel 是 reopen = 起新一轮）
    if (isSettled(todoRow.phase)) {
      throw new HttpError(
        409,
        `cancel is not valid on a settled todo (phase=${todoRow.phase}); ` +
          `use /reopen instead`,
      );
    }

    // 契约 §3.3：无 build 409 —— 还没起过运行的 todo 「关闭」没意义。
    const hasBuild = (await db
      .select({ id: builds.id })
      .from(builds)
      .where(eq(builds.todoId, todoId))
      .limit(1))[0];
    if (!hasBuild) {
      throw new HttpError(
        409,
        `cancel requires at least one build; this todo has never started a run; ` +
          `use /delete instead`,
      );
    }

    const trigger: Trigger = { kind: 'cancel' };
    assertGateTrigger(trigger);

    const r = await commitPhaseTransition(db, {
      todoId,
      teamId,
      trigger,
      planFirst: todoRow.planFirst,
    });

    if (!r.ok || r.next !== 'closed') {
      throw new HttpError(
        409,
        `transition refused: cancel on ${todoRow.phase} would land on ${r.next} ` +
          `(${r.reason ?? 'unknown'})`,
      );
    }

    return { ok: true as const, phase: r.next };
  });

  // ── Patch（更新 title / spec） ───────────────────────────────
  // 契约 §3.3（2026-10-18 看板新增）—— PATCH /api/todos/:todoId。
  //
  // **不复用 services/todos.ts 的 updateTodo**：
  //   - updateTodo 接受 `title / spec / agentId / tagIds`，但契约只让前端改
  //     这俩字段（看板右键菜单「编辑」只动 title + spec）。
  //   - updateTodo 也不校验 `requireTeamMembership`：路由层必须再校验一次。
  //   - updateTodo 是 open-codeset patch（任意 subset），前端契约只暴露
  //     title/spec，超出会被 zod 挡掉。
  // 这里**只做路由层校验 → service.updateTodo（限定白名单）**：
  app.patch('/api/todos/:todoId', async (req) => {
    const { todoId } = req.params as { todoId: string };
    const ctx = await resolveContext(db, req);
    const body = parseBody(PatchTodoBody, req.body ?? {});

    const teamId = await loadTodoTeamId(db, todoId);
    if (!teamId) throw new HttpError(404, 'todo not found');
    await requireTeamMembership(db, ctx.userId, teamId);

    // 不接受 phase：superRefine 已经把 `phase` 当成 zod 未知字段拒掉
    // （strict()）。这里再 explicit 检查一次作为防御。
    const patch: { title?: string; spec?: string | null } = {};
    if (body.title !== undefined) patch.title = body.title;
    if (body.spec !== undefined) patch.spec = body.spec;

    if (Object.keys(patch).length === 0) {
      throw new HttpError(
        422,
        'patch todo requires at least one of title / spec',
      );
    }

    await updateTodo(db, todoId, teamId, patch);

    // 返回最新 todo —— 复用 service.loadTodoContext，与 GET handler 同源。
    const row = await loadTodoContext(db, todoId);
    return { todo: row.todo };
  });

  // ── Delete（前端不发 content-type，Fastify 对空 body+JSON 直接 400） ─
  // 契约 §3.3（2026-10-18 看板新增）。
  //
  // 复用 service.deleteTodo —— 它已经处理了 FK cascade（todo → build →
  // document / build_message / checklist_item）、audit_event 孤儿清理与
  // team-scope SSE。所以路由层只要鉴权 + 调它。
  app.delete('/api/todos/:todoId', async (req) => {
    const { todoId } = req.params as { todoId: string };
    const ctx = await resolveContext(db, req);

    const teamId = await loadTodoTeamId(db, todoId);
    if (!teamId) throw new HttpError(404, 'todo not found');
    await requireTeamMembership(db, ctx.userId, teamId);

    await deleteTodo(db, todoId, teamId);
    return { ok: true as const };
  });

  // ── Sync-to-machine ─────────────────────────────────────────
  // 契约 §3.8（2026-10-18 接通）—— POST /api/todos/:todoId/sync-to-machine。
  //
  // **这个端点只做一件事：往 `machine_pending_action` 写一行指令。**
  // server 端不执行 git —— git 只能在装了 repo 的那台机器上跑。指令由 daemon
  // 在 `POST /api/machine/recover` 里领走执行，执行完
  // `POST /api/machine/action-result` 回执 → 服务端写审计 + 发 SSE
  // `action_completed` → 浏览器才显示真实结果。
  //
  // 六条分支：
  //   (a) todo 没 build（还没跑过 / 被删完了）   → 409
  //   (b) machineId 不存在                       → 404
  //   (c) 机器属于别的 team                      → 403
  //   (d) 机器离线 (isOnline=false)              → {ok:false, reason:'机器当前离线，无法同步'}
  //   (e) 机器在线但 workspacesDir 为空          → {ok:false, reason:'该机器没有配置工作目录'}
  //   (f) 在线 + 有工作目录                      → 写指令行，返回
  //       {ok:true, actionId, machineId, branch, dir, todoId, buildId, baseBranch}
  //
  // **诚实要求（最容易假绿的地方）**：(f) 的 `ok:true` 只代表**指令已下发**，
  // 不代表文件已经拉到那台机器上，响应里绝不出现「已同步」字样。前端
  // `BranchMenu` 会把响应原样显示在回执框里（已实测它显示 reason），写
  // 「已同步」就是骗用户。ok:false 分支照旧返回 reason 字符串。
  //
  // **dir 的语义（daemon 侧要照着这个实现）**：`machines.workspacesDir` 就是
  // daemon 自己上报的 `PATHS.workspaces`（`apps/daemon/src/cli.ts` enroll 时
  // 传的是它），而 daemon 给某个 build 建的隔离工作区是
  // `path.join(PATHS.workspaces, buildId)`（`paths.ts` 的 `worktreeFor`、
  // `git.ts` 的 `prepareWorkspace` 都是这个路径）。所以这里给的是**具体目录**
  // `<workspacesDir>/<buildId>`、不是工作根：契约 §3.6 要求 daemon「必须直接
  // 用 dir，不要拼自己的 home」，而 `MachineAction` 里没有 baseBranch 字段，
  // daemon 拿到工作根也拼不出该进哪个子目录。给具体目录之后，这台机器要是
  // 跑过这个 build，目录已存在且是 git 仓库，`fetch/checkout/reset` 直接能
  // 跑；没跑过就按契约 §3.7 的边界老实报「目录还不存在，先 clone」。
  //
  // `baseBranch` 只给前端看（这条分支从哪个基线切出），daemon 不需要它。
  //
  // **幂等（契约 §3.8）**：同一 (machineId, todoId) 上已有 pending/running 行
  // 时复用那一行、返回同一个 actionId —— 用户连点两次不该产生两条 git 指令。
  app.post('/api/todos/:todoId/sync-to-machine', async (req) => {
    const { todoId } = req.params as { todoId: string };
    const ctx = await resolveContext(db, req);
    const body = parseBody(SyncToMachineBody, req.body);

    const teamId = await loadTodoTeamId(db, todoId);
    if (!teamId) throw new HttpError(404, 'todo not found');
    await requireTeamMembership(db, ctx.userId, teamId);

    // 1) 拿 todo 的最新 build —— 必须有一个 build 才能「同步分支」。
    //    「无 build」状态通常是用户刚创建 todo 还没 claim 机器，跟契约 §3.3
    //    「无 build 409」一致。
    const buildRow = (await db
      .select({
        id: builds.id,
        branch: builds.branch,
        todoId: builds.todoId,
      })
      .from(builds)
      .where(eq(builds.todoId, todoId))
      .orderBy(sql`${builds.n} desc`)
      .limit(1))[0];
    if (!buildRow) {
      throw new HttpError(
        409,
        `todo has no build to sync; start one (claim a machine) before ` +
          `syncing the branch to a machine`,
      );
    }

    // 2) 拿机器 —— 必须同 team，不存在 → 404。
    const machineRow = (await db
      .select({
        id: machines.id,
        teamId: machines.teamId,
        isOnline: machines.isOnline,
        workspacesDir: machines.workspacesDir,
      })
      .from(machines)
      .where(eq(machines.id, body.machineId))
      .limit(1))[0];
    if (!machineRow) {
      throw new HttpError(404, `machine "${body.machineId}" not found`);
    }
    if (machineRow.teamId !== teamId) {
      throw new HttpError(
        403,
        `machine "${machineRow.id}" belongs to a different team`,
      );
    }

    // 3) 六条返回分支 —— 见函数头注释。**所有「ok:false」分支都返回 reason
    //    字符串**，前端会原样显示在 BranchMenu 的「同步到机器」回执框里。
    //    ok:true 路径（下面的 (f)）只代表指令已下发，绝不写「已同步」。
    if (!machineRow.isOnline) {
      return {
        ok: false as const,
        reason: '机器当前离线，无法同步',
      };
    }
    if (machineRow.workspacesDir === null || machineRow.workspacesDir === '') {
      return {
        ok: false as const,
        reason: '该机器没有配置工作目录',
      };
    }

    // (f) —— 在线 + 有工作目录：**下发指令**（本切片接通的就是这条）。
    //
    // dir = `<workspacesDir>/<buildId>`，也就是 daemon 自己给这个 build 建的
    // 隔离工作区（「dir 的语义」见函数头注释）。用 `joinOnMachine` 而不是
    // `path.join`：分隔符必须跟**目标机器**的 OS 一致，不是本服务端的。
    const dir = joinOnMachine(machineRow.workspacesDir, buildRow.id);
    const ts = now();

    // baseBranch —— 这条 build 分支从哪个基线切出。`builds` 表**没有**存
    // base（只有 `branch`），所以走 todo → project → default_branch，与
    // `routes/machine.ts` 的 claim 响应同源（那边也是
    // `project?.defaultBranch ?? 'main'`）。查不到 project 行时给 null。
    const projectRow = (await db
      .select({ defaultBranch: projects.defaultBranch })
      .from(todos)
      .innerJoin(projects, eq(projects.id, todos.projectId))
      .where(eq(todos.id, todoId))
      .limit(1))[0];
    const baseBranch = projectRow?.defaultBranch ?? null;

    // ── 幂等（契约 §3.8）─────────────────────────────────────
    // 同一 (machineId, todoId) 上已有未完成的指令时**复用那一行**：用户连点
    // 两次不该产生两条要 git 拉取的指令。
    const pendingWhere = and(
      eq(machinePendingActions.machineId, machineRow.id),
      eq(machinePendingActions.todoId, todoId),
      inArray(machinePendingActions.status, ['pending', 'running']),
    );

    const reuse = (await db
      .select({ id: machinePendingActions.id })
      .from(machinePendingActions)
      .where(pendingWhere)
      .orderBy(machinePendingActions.requestedAt)
      .limit(1))[0];

    let actionId: string;
    if (reuse) {
      actionId = reuse.id;
      // 刷新而不是直接返回旧值：branch 可能已经换了（同一 todo 的 n+1 build），
      // requestedAt 刷新让「刚点的那次优先」在 recover 的 ORDER BY 里成立。
      await db
        .update(machinePendingActions)
        .set({ requestedAt: ts, branch: buildRow.branch, dir })
        .where(eq(machinePendingActions.id, actionId));
    } else {
      actionId = newId();
      await db.insert(machinePendingActions).values({
        id: actionId,
        machineId: machineRow.id,
        teamId,
        kind: 'sync_branch',
        branch: buildRow.branch,
        dir,
        buildId: buildRow.id,
        todoId,
        status: 'pending',
        requestedBy: ctx.userId,
        requestedAt: ts,
        attempts: 0,
      });
    }

    // 并发竞态兜底 —— **这里没有更强的保证，说清楚为什么**。
    // 两个请求同时到达时都能查到「无 pending/running」，于是各插一行。
    // `on conflict do nothing` 在这里用不了：表上唯一的约束是主键 `id`
    // （随机 newId 永不冲突），而契约 §3.3 的 DDL 只有普通索引
    // `machine_action_pending_idx`，没有 (machine_id, todo_id) where
    // status in ('pending','running') 的**部分唯一索引** —— 本切片不许改那份
    // DDL，所以竞态在 SQL 层关不掉。
    // 退化成「再查一次拿真实 actionId」：两边都返回同一条（最老的）指令，前端
    // 看到的是同一个 actionId；多插出来的那行也会被 daemon 的 recover 领走
    // 执行，但 git 侧幂等（同一条分支 fetch + reset 两遍没有副作用），所以
    // 竞态的代价是「多跑一次 git」，不是「两个请求拿到不同的 actionId」。
    const authoritative = (await db
      .select({ id: machinePendingActions.id })
      .from(machinePendingActions)
      .where(pendingWhere)
      .orderBy(machinePendingActions.requestedAt, machinePendingActions.id)
      .limit(1))[0];
    if (authoritative) actionId = authoritative.id;

    // **`ok:true` 只代表「指令已下发」**，不代表文件已经拉到那台机器上。
    // 真实完成状态要等 daemon 回执（`POST /api/machine/action-result` →
    // SSE `action_completed`）。响应里没有任何「已同步」字样。
    return {
      ok: true as const,
      actionId,
      machineId: machineRow.id,
      branch: buildRow.branch,
      dir,
      todoId,
      buildId: buildRow.id,
      baseBranch,
    };
  });

  // ── Mentions 结构化引用（2026-10-18 新增） ─────────────────────────
  //
  // 原站语义：composer 里 `Mention` 按钮 + prefix (`@ agent or member, # todo,
  // / skill, ~ project, & machine`) 写入的是「structured reference chip rather
  // than plain text」，让 agent **resolves the exact ID instead of guessing**。
  // 见 `D:/AI/todos/recon-live/docs-conversation.md:34`。
  //
  // **两步而非一步**：本端点**只绑定**「哪些 mentions 属于这条 message」，
  // 不创建 message 行 —— 创建消息走既有 `POST /api/builds/:buildId/messages`
  // （不在本切片 Target）。UI 侧先 POST 消息拿到 `messageId` 再 POST 到本端点。
  // 这样既不破坏既有 911 个 server 测试的 fixture 写法，也不要求
  // `build-messages.ts` 那边支持 mentions 入参。

  /**
   * 把一条 mention 翻译成「这个 ref_id 在哪张表 + 该 ref 所属 teamId」——
   * 调用方拿到 teamId 后再与调用者所属 team 比对，跨团队 → 403。
   * 返回 null 表示 ref_id 在对应表里根本不存在 → 422。
   *
   *   - `agent` / `member` → 按主键查，校验 team 归属
   *   - `todo`            → 走 `todos.project.teamId`，允许跨 project 同 team
   *   - `skill` / `project` / `machine` → 直接按 teamId
   *
   * 抛 422 / 403 / 404 由调用方决定；本函数只负责 SELECT 与解析。
   */
  async function resolveMentionRef(
    teamId: string,
    m: { kind: MentionsBodyT['mentions'][number]['kind']; refId: string },
  ): Promise<{ ok: true; ownerTeamId: string } | { ok: false; status: 422 | 403 | 404; reason: string }> {
    const ownerTeam = async (
      k: 'agent' | 'member' | 'skill' | 'project' | 'machine' | 'todo',
    ): Promise<string | null> => {
      if (k === 'agent') {
        const row = (await db
          .select({ teamId: agents.teamId })
          .from(agents)
          .where(eq(agents.id, m.refId))
          .limit(1))[0];
        return row?.teamId ?? null;
      }
      if (k === 'member') {
        const row = (await db
          .select({ teamId: members.teamId })
          .from(members)
          .where(eq(members.id, m.refId))
          .limit(1))[0];
        return row?.teamId ?? null;
      }
      if (k === 'skill') {
        const row = (await db
          .select({ teamId: skills.teamId })
          .from(skills)
          .where(eq(skills.id, m.refId))
          .limit(1))[0];
        return row?.teamId ?? null;
      }
      if (k === 'project') {
        const row = (await db
          .select({ teamId: projects.teamId })
          .from(projects)
          .where(eq(projects.id, m.refId))
          .limit(1))[0];
        return row?.teamId ?? null;
      }
      if (k === 'machine') {
        const row = (await db
          .select({ teamId: machines.teamId })
          .from(machines)
          .where(eq(machines.id, m.refId))
          .limit(1))[0];
        return row?.teamId ?? null;
      }
      // todo：通过 project → team
      const row = (await db
        .select({ teamId: projects.teamId })
        .from(todos)
        .innerJoin(projects, eq(projects.id, todos.projectId))
        .where(eq(todos.id, m.refId))
        .limit(1))[0];
      return row?.teamId ?? null;
    };

    const owner = await ownerTeam(m.kind);
    if (owner === null) {
      return {
        ok: false,
        status: 422,
        reason: `referenced ${m.kind} "${m.refId}" does not exist`,
      };
    }
    if (owner !== teamId) {
      // 与原站对齐：todo / agent / member / skill / project / machine 都要同 team。
      // 原站明确说 todo 可跨 project（同 team），但跨 team 一律不行 —— 这条
      // 把「跨 team 的任何引用」按 403 拒掉，与 `requireTeamMembership` 措辞同源。
      return {
        ok: false,
        status: 403,
        reason: `referenced ${m.kind} "${m.refId}" belongs to a different team`,
      };
    }
    return { ok: true, ownerTeamId: owner };
  }

  app.post('/api/todos/:todoId/mentions', async (req) => {
    const { todoId } = req.params as { todoId: string };
    const ctx = await resolveContext(db, req);
    const body = parseBody(MentionsBody, req.body);

    // 1. todo 存在 + 调用者所属 team
    const todoRow = (await db
      .select({ id: todos.id })
      .from(todos)
      .where(eq(todos.id, todoId))
      .limit(1))[0];
    if (!todoRow) throw new HttpError(404, 'todo not found');
    const teamId = await loadTodoTeamId(db, todoId);
    if (!teamId) throw new HttpError(404, 'todo not found');
    await requireTeamMembership(db, ctx.userId, teamId);

    // 2. message 存在且属于该 todo 的某个 build
    const messageRow = (await db
      .select({ id: buildMessages.id, buildId: buildMessages.buildId })
      .from(buildMessages)
      .innerJoin(builds, eq(builds.id, buildMessages.buildId))
      .where(and(eq(buildMessages.id, body.messageId), eq(builds.todoId, todoId)))
      .limit(1))[0];
    if (!messageRow) {
      throw new HttpError(
        404,
        `message "${body.messageId}" does not belong to any build of todo "${todoId}"`,
      );
    }

    // 3. 全部 mentions 通过校验才写入 —— 任一失败 422/403/404，零写入
    const ts = now();
    const validated: Array<MentionsBodyT['mentions'][number] & { id: string }> = [];
    for (const m of body.mentions) {
      const r = await resolveMentionRef(teamId, m);
      if (!r.ok) {
        // 用 throw 让 Fastify 的 installErrorHandlers 直接按 statusCode 出响应体；
        // 不写半库：validated 还没写。
        throw new HttpError(r.status, r.reason);
      }
      validated.push({ ...m, id: newId() });
    }

    // 4. 一次事务写入（幂等：重复 (message_id, kind, ref_id) 走 ON CONFLICT DO NOTHING）
    const inserted = await db.transaction(async (tx) => {
      const rows: Array<{
        id: string;
        messageId: string;
        buildId: string;
        kind: string;
        prefix: string;
        refId: string;
        label: string;
        createdAt: number;
      }> = [];
      for (const m of validated) {
        const row = (await tx
          .insert(buildMessageMentions)
          .values({
            id: m.id,
            messageId: messageRow.id,
            buildId: messageRow.buildId,
            kind: m.kind,
            prefix: m.prefix,
            refId: m.refId,
            label: m.label,
            createdAt: ts,
          })
          .onConflictDoNothing({ target: [buildMessageMentions.messageId, buildMessageMentions.kind, buildMessageMentions.refId] })
          .returning())[0];
        // onConflictDoNothing 时 row 为 undefined —— 此时按 (messageId, kind, ref_id) 重新读回
        if (row) {
          rows.push(row);
        } else {
          const existing = (await tx
            .select({
              id: buildMessageMentions.id,
              messageId: buildMessageMentions.messageId,
              buildId: buildMessageMentions.buildId,
              kind: buildMessageMentions.kind,
              prefix: buildMessageMentions.prefix,
              refId: buildMessageMentions.refId,
              label: buildMessageMentions.label,
              createdAt: buildMessageMentions.createdAt,
            })
            .from(buildMessageMentions)
            .where(
              and(
                eq(buildMessageMentions.messageId, messageRow.id),
                eq(buildMessageMentions.kind, m.kind),
                eq(buildMessageMentions.refId, m.refId),
              ),
            )
            .limit(1))[0];
          if (existing) rows.push(existing);
        }
      }
      return rows;
    });

    return { ok: true as const, mentions: inserted };
  });

  // 读：按 todoId + messageId 拿一条消息的 mentions。
  // 不另开 `/api/builds/:buildId/mentions` —— 与 todo 鉴权链路复用一处即可。
  app.get('/api/todos/:todoId/mentions', async (req) => {
    const { todoId } = req.params as { todoId: string };
    const ctx = await resolveContext(db, req);
    const parsed = z
      .object({ messageId: z.string().min(1).max(80) })
      .safeParse(req.query);
    if (!parsed.success) {
      throw new HttpError(422, 'messageId is required');
    }
    const { messageId } = parsed.data;

    const teamId = await loadTodoTeamId(db, todoId);
    if (!teamId) throw new HttpError(404, 'todo not found');
    await requireTeamMembership(db, ctx.userId, teamId);

    // 防御：message 不属于该 todo 的 build → 404（与 POST 同款语义）
    const msgOk = (await db
      .select({ id: buildMessages.id })
      .from(buildMessages)
      .innerJoin(builds, eq(builds.id, buildMessages.buildId))
      .where(and(eq(buildMessages.id, messageId), eq(builds.todoId, todoId)))
      .limit(1))[0];
    if (!msgOk) {
      throw new HttpError(
        404,
        `message "${messageId}" does not belong to any build of todo "${todoId}"`,
      );
    }

    const rows = await db
      .select({
        id: buildMessageMentions.id,
        messageId: buildMessageMentions.messageId,
        buildId: buildMessageMentions.buildId,
        kind: buildMessageMentions.kind,
        prefix: buildMessageMentions.prefix,
        refId: buildMessageMentions.refId,
        label: buildMessageMentions.label,
        createdAt: buildMessageMentions.createdAt,
      })
      .from(buildMessageMentions)
      .where(eq(buildMessageMentions.messageId, messageId))
      .orderBy(buildMessageMentions.createdAt, buildMessageMentions.id);
    return { mentions: rows };
  });
}
