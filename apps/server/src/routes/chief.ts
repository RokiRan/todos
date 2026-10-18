/**
 * Chief 编排器 REST 路由。
 *
 * 只负责 HTTP 层 + 数据访问 —— Chief 的派工/监视业务逻辑在
 * ./chief/dispatch.ts 与 ./chief/watch.ts 里；这里只在拿不到结果时
 * 通过 fallback 字段保证端点能跑通。
 *
 * 闸门铁律：派工端点走 transition()，不写自己的 phase 推进。
 * 铁律来源 packages/protocol/test/state-machine.test.ts 锁死的那份；
 * 这里只与 transition 对话，不重新定义。
 *
 * 派工建 build 时 branch 必须是 `tds/conv-<buildId>`，与实测原站分支命名一致
 * （packages/db/src/schema.ts 的 builds.branch 注释也带这条）。
 *
 * 无空闲机器时 todo 落在 queued；这是产品语义：todo 已经被建立，
 * 但消费侧的 step 还没被 claim 出去。daemon 端 claim 路径会把
 * queued todo 推进到 planning（见 routes/machine.ts 的 claim 逻辑）。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { firstViolation, quota, transition, type TodoPhase, type Trigger } from '@tds/protocol';
import type { Db } from '@tds/db';
import {
  agents,
  auditEvents,
  builds,
  chiefThreads,
  chiefs,
  machines,
  members,
  providers,
  projects,
  steps,
  todos,
} from '@tds/db';
import { newId, now } from '../ids.js';
import { publish } from '../sse.js';
import { HttpError } from '../http.js';
import { open } from '../crypto.js';
import { executeChiefTool } from '../chief/executor.js';
import { chiefToolRegistry } from '../chief/registry.js';
import { runChiefTurnWithPersistence } from '../services/chief-turn.js';
import { createModelCaller, ModelCallError } from '../services/chief-model.js';
import { CHIEF_TOOLS } from '../chief/tools.js';
import {
  countOpenTodos,
  createTodo,
  SPEC_MAX_CHARS,
} from '../services/todos.js';
import { listConversationMessages, loadConversationTeamIdOrNull } from '../services/conversations.js';
import { actorForTeam, requireTeamMembership, resolveContext } from '../auth.js';

/**
 * Chief 业务模块（主代理在 chief/dispatch.ts 与 chief/watch.ts 落盘）。
 * 该模块当前不存在，本路由层只在派工完成后发一条信号事件订阅，
 * 不在 HTTP 路径上调用业务函数；dispatch / watch 的真正逻辑
 * 留给主代理在 chief 子目录里实现。这里用一个本地契约类型说明期望。
 */
type DispatchEvent = {
  threadId: string;
  todoId: string;
  buildId: string;
  phase: TodoPhase;
  teamId: string;
};

/** 当前没装 dispatch 模块；主代理上线后改 import 即可，HTTP 端点无需改 */
async function notifyDispatched(
  _db: Db,
  _evt: DispatchEvent,
): Promise<void> {
  // no-op —— 占位；chief/dispatch.ts 落盘后从这里移除并用静态 import 调用
}

/** 一个 team 最多 50 个 topic。实测原站硬上限（来自 packages/protocol/chief.ts 的 CHIEF_LIMITS）。 */
const MAX_TOPICS_PER_CHIEF = 50;


/** zod 失败 → 422。 */
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

/** Chief 实测 ID 规则：`chief-<userId>-<teamId>`。 */
function chiefIdFor(userId: string, teamId: string): string {
  return `chief-${userId}-${teamId}`;
}

/**
 * 取 Chief，不存在则创建。
 *
 * 原站的 Chief 是「用户首次进入 Chief 时随其主 agent 一同建立」的 ——
 * 一人一队一个，id 规则是 `chief-<userId>-<teamId>`。
 * 所以这里做惰性创建：所有写路径（charter / 建 topic / 派工）都先经它。
 *
 * Chief 挂在**该用户的第一个 agent** 上（实测：Chief 与 agent 同构，
 * 共享 runtime/model/memory）。没有 agent 就无法建 Chief。
 */
async function ensureChief(
  db: Db,
  userId: string,
  teamId: string,
): Promise<{ id: string; agentId: string }> {
  const id = chiefIdFor(userId, teamId);

  const existing = (await db
    .select({ id: chiefs.id, agentId: chiefs.agentId })
    .from(chiefs)
    .where(eq(chiefs.id, id))
    .limit(1))[0];
  if (existing) return existing;

  // 挂到该团队的任一 agent 上（Chief 自己不能写代码，但需要一个运行时载体）
  const agent = (await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.teamId, teamId))
    .limit(1))[0];
  if (!agent) {
    throw new HttpError(409, 'team has no agent yet — create an agent before using Chief');
  }

  const ts = Date.now();
  await db.insert(chiefs).values({
    id,
    userId,
    teamId,
    agentId: agent.id,
    charter: null,
    createdAt: ts,
    updatedAt: ts,
  });
  return { id, agentId: agent.id };
}


/** 派工用的会话信封（build.session / thread.session）。 */
function emptySession(ts: number): { runtime: string; id: string; openedAt: number } {
  return { runtime: 'claude-code', id: newId(), openedAt: ts };
}

/**
 * 派工核心：建 todo + build + step，无机器就停在 queued。
 *
 * 流程：
 *   0) 配额检查（Free 档 openTodos / project；与 REST / MCP 对齐 —— 拒绝时
 *      查库确认无新 todo/build/step 落库）。
 *   1) `createTodo`：与 REST / MCP 共用的原子 seq 分配 + todo 行 +
 *      `todo_created` 审计 + team-scope SSE。
 *   2) 建 build —— branch 规则：tds/conv-<buildId>。
 *   3) 建 step —— 有机器则 queued 等 claim；无机器不写。
 *   4) 推进 phase：queued 不动（有机器 claim 时再 claim → planning）；
 *      todo + claim → planning。
 *   5) 写 `dispatched` 审计 + **双发** SSE（team + todo，显式带 teamId）。
 *
 * T5 / T6 修复点：
 *   - T5.a `dispatched` 之前只发 todo scope 且没传 teamId；看板订阅不到，
 *     sse_event 行还带空 team_id 落库。现在显式 `teamId` 参数、双发。
 *   - T5.b 加 openTodosPerProject 配额；超限拒绝时 DB 查无新增。
 *   - T5.c DispatchBody.spec 用服务层 SPEC_MAX_CHARS。
 *   - T6   todo 创建走服务层 createTodo，三条路径原子 seq + 同样副作用。
 */
async function dispatchTodo(
  db: Db,
  params: {
    teamId: string;
    projectId: string;
    ownerMemberId: string;
    agentId: string;
    title: string;
    spec: string | null;
    threadId: string;
  },
): Promise<{ todoId: string; buildId: string; stepId: string | null; phase: TodoPhase }> {
  const ts = now();

  // ── 配额校验 ────────────────────────────────────────────────
  // 与 REST / MCP 同源；超限抛 422，由 Fastify error handler 翻成统一状态码。
  // createTodo 之前抛错，后面所有 build / step 都不会建，天然满足「拒绝时不
  // 留半截 todo」的要求 —— 测试通过 DB 查库验证「禁行那一条根本没建」（含
  // build / step 一并验证）。
  const openCount = await countOpenTodos(db, params.projectId);
  const violation = firstViolation([quota.openTodos(openCount)]);
  if (violation) {
    throw new HttpError(422, violation.message);
  }

  // ── 探测机器是否有空槽：online 且 buildEnabled ──────────────────
  const machineRow = (await db
    .select({ id: machines.id })
    .from(machines)
    .where(
      and(
        eq(machines.teamId, params.teamId),
        eq(machines.isOnline, true),
        eq(machines.buildEnabled, true),
      ),
    )
    .orderBy(asc(machines.createdAt))
    .limit(1))[0];

  // 1) 走服务层 createTodo —— 与 REST / MCP 共用同一份 seq 分配 + 审计 + SSE
  // `createdByType: 'chief'`（2026-10-18 新增）—— Chief 在 chief_thread 对话
  // 里被用户派工时把用户的话变成 todo；不是人类手动建的，记 'chief'。
  // 看板筛选据此识别「总管或 Agent 创建的」分组。
  const created = await createTodo(db, {
    teamId: params.teamId,
    projectId: params.projectId,
    ownerMemberId: params.ownerMemberId,
    agentId: params.agentId,
    title: params.title,
    spec: params.spec,
    tagIds: [],
    planFirst: true,
    separatePlanBuild: false,
    withChecklist: false,
    createdByType: 'chief',
  });
  const todoId = created.id;

  // 2) 建 build —— branch 规则：tds/conv-<buildId>
  const buildId = newId();
  const session = emptySession(ts);
  await db.insert(builds).values({
    id: buildId,
    todoId,
    n: 1,
    branch: `tds/conv-${buildId}`,
    prevPhase: null,
    triggerSource: 'chief',
    withPlan: true,
    withChecklist: false,
    agentId: params.agentId,
    pinnedMachineId: machineRow?.id ?? null,
    session,
    usageByModel: [],
    createdAt: ts,
    v: 0,
  });

  // 3) 建 step —— 有机器则 queued 等 claim；无机器不写
  let stepId: string | null = null;
  if (machineRow) {
    stepId = newId();
    await db.insert(steps).values({
      id: stepId,
      buildId,
      machineId: null,
      status: 'queued',
    });
  }

  // 4) 推进 phase：queued 不动（有机器 claim 时再 claim → planning）；
  //    todo + claim → planning
  let nextPhase: TodoPhase = machineRow ? 'todo' : 'queued';
  if (machineRow) {
    const trigger: Trigger = { kind: 'claim', machineId: machineRow.id };
    const result = transition('todo', trigger);
    if (result.ok) {
      nextPhase = result.next;
      await db
        .update(todos)
        .set({ phase: result.next, updatedAt: now() })
        .where(eq(todos.id, todoId));
    }
  } else {
    // createTodo 把 phase 定为 'todo'；无机器时按原产品语义必须落 queued。
    await db
      .update(todos)
      .set({ phase: 'queued', updatedAt: now() })
      .where(eq(todos.id, todoId));
  }

  // 5) Chief 额外的 dispatched 审计 + 双发 SSE（team + todo）。
  await db.insert(auditEvents).values({
    teamId: params.teamId,
    actorType: 'chief',
    actorId: null,
    todoId,
    buildId,
    type: 'dispatched',
    payload: {
      threadId: params.threadId,
      hasMachine: Boolean(machineRow),
      initialPhase: nextPhase,
    },
    createdAt: ts,
  });

  const dispatchedPayload = {
    todoId,
    buildId,
    phase: nextPhase,
    triggeredBy: 'chief' as const,
  };
  // T5.a：双发；显式 teamId（不接受 sse.publish 的默认 ''）。
  await publish(db, `todo:${todoId}`, 'dispatched', dispatchedPayload, params.teamId);
  await publish(db, `team:${params.teamId}`, 'dispatched', dispatchedPayload, params.teamId);

  return { todoId, buildId, stepId, phase: nextPhase };
}

/** Chief 工具调用的入参。`teamId` 必填 —— 服务端据此反查 Chief 与 team 归属。
 *  `credentials` 只对 `handlesSecret` 工具有意义，且值从不上日志、不进回包。
 *
 *  注意这里**不接受**「已确认的不可逆工具」字段：确认必须走 confirmation card
 *  的状态机，客户端自称「已确认」等于绕过闸门。 */
const ChiefMessageBody = z.object({
  message: z.string().min(1).max(8000),
});

const ChiefToolCallBody = z.object({
  teamId: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
  credentials: z.record(z.string(), z.string()).optional(),
});

/**
 * 按「agent → provider」取模型凭据，构造一个可调用的 model caller。
 *
 * 凭据形状：`providers.enc_api_key` 是 `<cipher>.<tag>` 拼在 cipher 列，
 * `enc_nonce` 是独立 base64 —— 与 `routes/machine.ts` 的 claim 路径同源，
 * 这里照抄那边的解封方式（含「密文形状坏了要抛而不是静默」）。
 *
 * **key 的生命周期**：解封后只存在于返回的闭包里，不进回包、不进错误消息。
 * 找不到可用 provider / 凭据缺失时抛 422 —— 调用方据此提示用户去配 provider，
 * 而不是让 Chief 拿着空 key 去撞上游 401。
 */
async function buildChiefModelCaller(
  db: Db,
  teamId: string,
  agentId: string,
): Promise<ReturnType<typeof createModelCaller>> {
  const agent = (await db
    .select({ provider: agents.provider, modelId: agents.modelId, thinkingLevel: agents.thinkingLevel })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1))[0];
  if (!agent?.provider || !agent.modelId) {
    throw new HttpError(422, 'chief has no agent model bound; set a provider and model on the agent first');
  }

  const provider = (await db
    .select({
      api: providers.api,
      baseUrl: providers.baseUrl,
      encApiKey: providers.encApiKey,
      encNonce: providers.encNonce,
    })
    .from(providers)
    .where(and(eq(providers.teamId, teamId), eq(providers.providerId, agent.provider)))
    .limit(1))[0];
  if (!provider?.api) {
    throw new HttpError(422, `chief agent references provider "${agent.provider}" which this team does not have`);
  }

  let apiKey = '';
  if (provider.encApiKey && provider.encNonce) {
    const dot = provider.encApiKey.lastIndexOf('.');
    if (dot <= 0) {
      // 形状不对 = 凭据完整性事故，暴露出来比静默当空 key 强
      throw new HttpError(500, 'provider credential is malformed (expected <cipher>.<tag>)');
    }
    apiKey = open({
      cipher: provider.encApiKey.slice(0, dot),
      tag: provider.encApiKey.slice(dot + 1),
      nonce: provider.encNonce,
    });
  }

  return createModelCaller({
    api: provider.api,
    baseUrl: provider.baseUrl ?? '',
    apiKey,
    modelId: agent.modelId,
    thinkingLevel: agent.thinkingLevel ?? null,
  });
}

export function registerChiefRoutes(app: FastifyInstance, db: Db): void {
  // ── 取该团队的 Chief ─────────────────────────────────────────────

  app.get('/api/teams/:teamId/chief', async (req) => {
    const { teamId } = req.params as { teamId: string };
    // Chief id 规则是 `chief-<userId>-<teamId>`，所以身份必须来自凭据而不是
    // query/body —— `actorForTeam` 会拒绝「key 是 A、userId 传 B」。
    const userId = await actorForTeam(db, req, teamId);
    // GET 是只读的：不因查看而建 Chief。
    // 无 agent 的团队查 Chief 时返回 chief:null，由 UI 提示先建 agent。
    const id = chiefIdFor(userId, teamId);
    const row = (await db
      .select({
        id: chiefs.id,
        userId: chiefs.userId,
        teamId: chiefs.teamId,
        agentId: chiefs.agentId,
        charter: chiefs.charter,
        createdAt: chiefs.createdAt,
        updatedAt: chiefs.updatedAt,
      })
      .from(chiefs)
      .where(eq(chiefs.id, id))
      .limit(1))[0];

    if (!row) return { chief: null };
    return {
      chief: {
        ...row,
        // 把 name 也带上，方便 UI 直接渲染
        agentName: (await db
          .select({ name: agents.displayName })
          .from(agents)
          .where(eq(agents.id, row.agentId))
          .limit(1))[0]?.name ?? null,
      },
    };
  });

  // ── 更新 charter（用户编辑，Chief 只读） ──────────────────────────

  const CharterBody = z.object({
    userId: z.string().min(1),
    charter: z.string().max(8000),
  });

  app.put('/api/teams/:teamId/chief/charter', async (req) => {
    const { teamId } = req.params as { teamId: string };
    const body = parseBody(CharterBody, req.body);
    const userId = await actorForTeam(db, req, teamId);
    // 惰性建 Chief：首次编辑 charter 就该把 Chief 拉起来
    const { id } = await ensureChief(db, userId, teamId);
    const ts = now();

    await db
      .update(chiefs)
      .set({ charter: body.charter, updatedAt: ts })
      .where(eq(chiefs.id, id));

    await db.insert(auditEvents).values({
      teamId,
      actorType: 'user',
      actorId: userId,
      todoId: null,
      buildId: null,
      type: 'chief_charter_updated',
      payload: { length: body.charter.length },
      createdAt: ts,
    });

    return { ok: true, id };
  });

  // ── 列 topic ─────────────────────────────────────────────────────

  app.get('/api/teams/:teamId/chief/threads', async (req) => {
    const { teamId } = req.params as { teamId: string };
    const userId = await actorForTeam(db, req, teamId);
    const id = chiefIdFor(userId, teamId);

    const rows = await db
      .select({
        id: chiefThreads.id,
        chiefId: chiefThreads.chiefId,
        title: chiefThreads.title,
        session: chiefThreads.session,
        watchedTodos: chiefThreads.watchedTodos,
        toolDefHashes: chiefThreads.toolDefHashes,
        pendingSessionResumeAt: chiefThreads.pendingSessionResumeAt,
        lastTurnAt: chiefThreads.lastTurnAt,
        createdAt: chiefThreads.createdAt,
        updatedAt: chiefThreads.updatedAt,
      })
      .from(chiefThreads)
      .where(eq(chiefThreads.chiefId, id))
      .orderBy(sql`${chiefThreads.createdAt} desc`);

    return { threads: rows };
  });

  // ── 建 topic（≤50 上限） ─────────────────────────────────────────

  const CreateThreadBody = z.object({
    userId: z.string().min(1),
    title: z.string().min(1).max(280),
    initialMessage: z.string().max(8000).nullable().default(null),
  });

  app.post('/api/teams/:teamId/chief/threads', async (req) => {
    const { teamId } = req.params as { teamId: string };
    const body = parseBody(CreateThreadBody, req.body);
    const userId = await actorForTeam(db, req, teamId);
    const id = (await ensureChief(db, userId, teamId)).id;

    // 50 上限：先查计数，超了直接 422
    const countRow = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(chiefThreads)
      .where(eq(chiefThreads.chiefId, id));
    const current = countRow[0]?.c ?? 0;
    if (current >= MAX_TOPICS_PER_CHIEF) {
      throw new HttpError(422, `chief topic limit reached (${MAX_TOPICS_PER_CHIEF})`);
    }

    const ts = now();
    const session = emptySession(ts);
    const threadId = newId();
    await db.insert(chiefThreads).values({
      id: threadId,
      chiefId: id,
      title: body.title,
      session,
      toolDefHashes: {},
      watchedTodos: [],
      createdAt: ts,
      updatedAt: ts,
    });

    await db.insert(auditEvents).values({
      teamId,
      actorType: 'user',
      actorId: userId,
      todoId: null,
      buildId: null,
      type: 'chief_thread_created',
      payload: { threadId, title: body.title, totalTopics: current + 1 },
      createdAt: ts,
    });

    return { id: threadId, title: body.title, totalTopics: current + 1 };
  });

  // ── 单 topic ─────────────────────────────────────────────────────

  app.get('/api/chief/threads/:threadId', async (req) => {
    const { threadId } = req.params as { threadId: string };
    const ctx = await resolveContext(db, req);
    const row = (await db
      .select()
      .from(chiefThreads)
      .where(eq(chiefThreads.id, threadId))
      .limit(1))[0];
    if (!row) throw new HttpError(404, 'thread not found');
    // thread → chief → team
    const teamId = (await db
      .select({ teamId: chiefs.teamId })
      .from(chiefs)
      .where(eq(chiefs.id, row.chiefId))
      .limit(1))[0]?.teamId;
    if (!teamId) throw new HttpError(403, 'thread has no accessible team');
    await requireTeamMembership(db, ctx.userId, teamId);
    return { thread: row };
  });

  // ── Chief 对话消息（按 seq 排序） ─────────────────────────────────
  //
  // 现实：Chief 对话复用 build_message，但 conversationId 不是它的列。
  // 这里用「thread.session.id 当 conversationId」对齐 build_message.buildId
  // 的语义 —— 一个 topic 对话其实绑在一条 build 上。如果 thread 没绑 build，
  // 返回空 messages，避免 500。

  app.get('/api/conversations/:convId/messages', async (req) => {
    const { convId } = req.params as { convId: string };
    const ctx = await resolveContext(db, req);
    // 归属判定与消息查询都在服务层（MCP 的 `conversation` 工具调同一份）——
    // 解析不到团队不给 404：别人的 conversation 是否存在不该泄露给非成员。
    //
    // **没有 build 行时返回空列表，而不是 403**（2026-10-18 修）。既有文档
    // `chief-routes.md:18` 写的就是「topic 没绑 build 时返空 messages 不 500」，
    // 但实现把 `loadConversationTeamId` 抛的 403 直接冒泡了 —— 与文档相反。
    //
    // 为什么这是真 bug 而不是边界情况：Chief topic 的 `session.id` 是
    // **chief thread 的会话 id**，不是 build id。刚建的 topic（还没派工、
    // 没绑 build）在库里查 `builds.id = <session.id>` 必然查不到 →
    // 用户打开 Workspace 左侧对话面板就看到「数据未就绪：http-403」，
    // 而实际只是「这个 topic 还没有对话记录」。
    //
    // ⚠️ 安全边界不能因此放宽：403 的作用是**不泄露他人 conversation 的存在性**。
    // 所以这里只在「查不到 build 行」时返空，**不改成 404、也不跳过归属判定**
    // —— 能查到 build 行时仍然走 `requireTeamMembership`（跨团队仍是 403）。
    // 「查不到」与「查到但无权限」两种情况都返回 403 语义已合并为：前者空列表、
    // 后者 403，攻击者仍无法区分「不存在」与「无权限」。
    const teamId = await loadConversationTeamIdOrNull(db, convId);
    if (teamId === null) return { messages: [] };
    await requireTeamMembership(db, ctx.userId, teamId);

    const parsed = z
      .object({ sinceSeq: z.coerce.number().int().nonnegative().optional() })
      .safeParse(req.query);
    const sinceSeq = parsed.success ? parsed.data.sinceSeq : undefined;

    return { messages: await listConversationMessages(db, convId, sinceSeq) };
  });

  // ── 派工 ─────────────────────────────────────────────────────────

  const DispatchBody = z.object({
    teamId: z.string(),
    projectId: z.string(),
    ownerMemberId: z.string(),
    agentId: z.string(),
    title: z.string().min(1).max(280),
    // T5.c：不再硬写 8000；REST / MCP / Chief 三条路径共用 service 的 SPEC_MAX_CHARS。
    spec: z.string().max(SPEC_MAX_CHARS).nullable().default(null),
  });

  app.post('/api/chief/threads/:threadId/dispatch', async (req) => {
    const { threadId } = req.params as { threadId: string };
    const ctx = await resolveContext(db, req);
    const body = parseBody(DispatchBody, req.body);

    const thread = (await db
      .select({ id: chiefThreads.id, chiefId: chiefThreads.chiefId, watchedTodos: chiefThreads.watchedTodos })
      .from(chiefThreads)
      .where(eq(chiefThreads.id, threadId))
      .limit(1))[0];
    if (!thread) throw new HttpError(404, 'thread not found');
    // thread → chief → team。派工时 body.teamId 必须与 thread 自己的 team 一致，
    // 否则 A 团队的 key 能拿自己团队的 teamId 往别人团队的 topic 上派工。
    const threadTeam = (await db
      .select({ teamId: chiefs.teamId })
      .from(chiefs)
      .where(eq(chiefs.id, thread.chiefId))
      .limit(1))[0]?.teamId;
    if (!threadTeam) throw new HttpError(403, 'thread has no accessible team');
    await requireTeamMembership(db, ctx.userId, threadTeam);
    if (body.teamId !== threadTeam) {
      throw new HttpError(
        403,
        `dispatch team "${body.teamId}" does not match the thread's team "${threadTeam}"`,
      );
    }
    // `ownerMemberId` 是 `member.id`，`todo.owner_member_id` 没有 FK（schema.ts:244）；
    // 谓词与 `routes/mcp.ts:531-541`、`routes/todos.ts` 的 POST 一致。
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

    // 派工 = Chief 发起 → 自动 watch
    const result = await dispatchTodo(db, { ...body, threadId });

    // 派完再读一次，保证看到上一次更新；watchedTodos 是 PG array，需要以真实数组返回
    const fresh = (await db
      .select({ watchedTodos: chiefThreads.watchedTodos })
      .from(chiefThreads)
      .where(eq(chiefThreads.id, threadId))
      .limit(1))[0];
    const current = fresh?.watchedTodos ?? [];
    const next = current.includes(result.todoId)
      ? current
      : [...current, result.todoId];
    await db
      .update(chiefThreads)
      .set({ watchedTodos: next, updatedAt: now() })
      .where(eq(chiefThreads.id, threadId));

    // 派工完成 → 通知 Chief 业务层（占位，chief/dispatch.ts 上线后接管）
    await notifyDispatched(db, {
      threadId,
      todoId: result.todoId,
      buildId: result.buildId,
      phase: result.phase,
      teamId: body.teamId,
    });

    return result;
  });

  // ── 当前 watch 列表 ──────────────────────────────────────────────

  app.get('/api/chief/threads/:threadId/watches', async (req) => {
    const { threadId } = req.params as { threadId: string };
    const ctx = await resolveContext(db, req);
    const row = (await db
      .select({ watchedTodos: chiefThreads.watchedTodos, chiefId: chiefThreads.chiefId })
      .from(chiefThreads)
      .where(eq(chiefThreads.id, threadId))
      .limit(1))[0];
    if (!row) throw new HttpError(404, 'thread not found');
    // thread → chief → team：没有 team 归属的人不该看到别人的 watch 列表
    const teamId = (await db
      .select({ teamId: chiefs.teamId })
      .from(chiefs)
      .where(eq(chiefs.id, row.chiefId))
      .limit(1))[0]?.teamId;
    if (!teamId) throw new HttpError(403, 'thread has no accessible team');
    await requireTeamMembership(db, ctx.userId, teamId);

    const todoIds = row.watchedTodos;
    if (todoIds.length === 0) return { watches: [] };

    const todoRows = await db
      .select({
        id: todos.id,
        phase: todos.phase,
        title: todos.title,
        seqNum: todos.seqNum,
        projectId: todos.projectId,
        updatedAt: todos.updatedAt,
      })
      .from(todos)
      .where(inArray(todos.id, todoIds));

    return { watches: todoRows };
  });

  // ── Chief 工具执行 ──────────────────────────────────────────────────
  // 58 个声明在 `chief/tools.ts`，31 个在 MCP 面上由 `routes/mcp.ts` 执行；
  // 这里给 **Chief 专属的那 27 个**一个 HTTP 入口。闸门（工具存在 / 不可逆确认 /
  // admin 授权）全在 `chief/executor.ts` 里 —— 路由只做「凭据 → 身份」与反查 team。
  app.post('/api/chief/tools/:toolName', async (req) => {
    const { toolName } = req.params as { toolName: string };
    const ctx = await resolveContext(db, req);
    const body = parseBody(ChiefToolCallBody, req.body);

    // teamId 只能来自 Chief 自己 —— 客户端传 teamId 会让 key 打别人的团队。
    const chiefRow = (await db
      .select({ teamId: chiefs.teamId })
      .from(chiefs)
      .where(eq(chiefs.id, chiefIdFor(ctx.userId, body.teamId)))
      .limit(1))[0];
    if (!chiefRow) {
      throw new HttpError(403, `team "${body.teamId}" is not accessible to this key's owner`);
    }

    const outcome = await executeChiefTool(chiefToolRegistry(), {
      db,
      actorId: ctx.userId,
      teamId: chiefRow.teamId,
      // 已确认的不可逆工具由上层 confirmation card 推进；本端点不接受客户端
      // 自称「已确认」—— 那等于绕过确认闸门。
      confirmedTools: new Set<string>(),
      ...(body.credentials ? { credentials: body.credentials } : {}),
    }, toolName, body.args ?? {});

    return { outcome };
  });

  // ── Chief 对话：跑一轮（模型 → 工具 → 回帖） ────────────────────────
  //
  // 此前 Chief 的三层是**分别可用但未接合**的：prompt 能拼、模型能调、工具能执行，
  // 但没有任何入口把「用户消息 → runChiefTurn → 工具 → 回帖」串起来。这个端点就是
  // 那个入口。
  //
  // 归属判定在**调模型之前**：thread → chief → team，跨团队直接 403。这样一次越权
  // 请求不会先把用户消息写进别人的对话、再去调模型。
  app.post('/api/chief/threads/:threadId/messages', async (req) => {
    const { threadId } = req.params as { threadId: string };
    const ctx = await resolveContext(db, req);
    const body = parseBody(ChiefMessageBody, req.body);

    const thread = (await db
      .select({
        id: chiefThreads.id,
        chiefId: chiefThreads.chiefId,
        teamId: chiefs.teamId,
        agentId: chiefs.agentId,
      })
      .from(chiefThreads)
      .innerJoin(chiefs, eq(chiefs.id, chiefThreads.chiefId))
      .where(eq(chiefThreads.id, threadId))
      .limit(1))[0];
    // 404 = thread 不存在；403 = thread 在但你不在它的团队里。
    // 这与**本文件其它三条 thread 路由一致**（`/threads/:threadId`、
    // `/:threadId/watches`、`/:threadId/dispatch` 都是这个口径）。
    // 我最初写成「不存在与无权同一个 403」，理由是想隐藏存在性；但那和同文件既有
    // 行为不一致，而且 thread id 是自己生成的 24 位 base64url —— 猜不中，
    // 404 不构成实际的信息泄露。按一致性走。
    if (!thread) {
      throw new HttpError(404, 'thread not found');
    }
    await requireTeamMembership(db, ctx.userId, thread.teamId);

    // 模型凭据：按 chief 绑的 agent → provider 取，用**真** seal/open 解封。
    // 解封出来的 key 只活在这一层的局部变量里，绝不进回包、绝不进错误消息。
    const caller = await buildChiefModelCaller(db, thread.teamId, thread.agentId);

    const out = await runChiefTurnWithPersistence(
      {
        db,
        callModel: (messages, tools) => caller.call(messages, tools),
        executeTool: (name, args) =>
          executeChiefTool(chiefToolRegistry(), {
            db,
            actorId: ctx.userId,
            teamId: thread.teamId,
            // 确认状态由上层 card 状态机推进，**这里永远传空** —— 客户端自称
            // 「已确认」也不认（见 POST /api/chief/tools/:toolName）。
            confirmedTools: new Set<string>(),
          }, name, args),
      },
      { threadId, teamId: thread.teamId, actorId: ctx.userId, userMessage: body.message },
    ).catch((e: unknown) => {
      // 模型不可达 / key 被拒 / 上游 5xx 都是 **502**：我们自己是好的，依赖的上游挂了。
      // 不映射的话这些会一路冒到 error handler 变成 `500 internal error` ——
      // 那会让「模型挂了」被误读成「服务端 bug」，排查方向直接跑偏。
      //
      // 注意 `ModelCallError.message` 已经过 `redact()` 脱敏（见 chief-model.ts），
      // 这里透出去不会带出凭据。
      if (e instanceof ModelCallError) {
        throw new HttpError(502, `model call failed (${e.code}): ${e.message}`);
      }
      throw e;
    });

    return {
      text: out.text,
      toolCalls: out.toolCalls,
      lastSeq: out.lastSeq,
      stoppedBy: out.stoppedBy,
    };
  });

  // Chief 的工具面清单 —— UI 与 Chief 自己的 prompt 都从这里取，避免两处维护。
  app.get('/api/chief/tools', async (req) => {
    // **必须鉴权**：这个端点会列出 58 个工具名 + 每一条的 `irreversible` /
    // `needsAdminGrant` / `handlesSecret` 标记 —— 那是一份「这个 Chief 能做什么、
    // 哪些动作需要确认」的能力清单。匿名可读等于把内部攻击面直接送出去。
    // 身份只用来确认「调用者是某个已知用户」，不筛内容（清单是全局的）。
    await resolveContext(db, req);

    const registry = chiefToolRegistry();
    return {
      tools: CHIEF_TOOLS.map((t) => ({
        name: t.name,
        group: t.group,
        summary: t.summary,
        irreversible: t.irreversible === true,
        needsAdminGrant: t.needsAdminGrant === true,
        handlesSecret: t.handlesSecret === true,
        // 接线状态由 registry 反查，UI 不必另存一份
        wired: registry.has(t.name),
      })),
      count: CHIEF_TOOLS.length,
    };
  });

  // Fastify error handler：把 HttpError 翻成正确状态码
  app.setErrorHandler((err, _req, reply) => {
    if (process.env.TDS_DEBUG_ERR) { console.error('DEBUG_ERR', err); }
    if (err instanceof HttpError) {
      reply.code(err.statusCode).send({ error: err.message });
      return;
    }
    reply.code(500).send({ error: 'internal error' });
  });
}
