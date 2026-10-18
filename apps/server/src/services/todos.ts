/**
 * Todo 写操作的**唯一真源**。
 *
 * 为什么要抽出来：REST 路由（`routes/todos.ts`）和 MCP 工具（`routes/mcp.ts`）
 * 都能改 todo —— 两者必须走同一套闸门、审计、SSE 双发。若各写一份，
 * 迟早出现「REST 推了 phase、MCP 没推」或「MCP 绕过了 revision_feedback
 * 的 document 落库」这类漂移，而且极难发现（只在跨接口组合时才显形）。
 *
 * 本模块是**纯服务层**：不认 HTTP、不认 JSON-RPC，抛 `HttpError`。
 * 两个调用方各自把它翻译成自己的错误形态（REST 直接 4xx，MCP 转 JSON-RPC
 * 或 toolCallEnvelope 的 isError）。
 *
 * 铁律（与 packages/protocol/test 的状态机测试锁死）：
 *   1. **绝不**手写 phase 判断 —— 一律走 `transition()`
 *   2. 闸门外的 trigger 在路由层就该被挡掉；`assertGateTrigger` 做防御
 *   3. 每次 phase 变化都写 audit + 双发 SSE（team + todo）
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { transition, type TodoPhase, type Trigger } from '@tds/protocol';
import type { Db } from '@tds/db';
import { auditEvents, builds, documents, projects, sseEvents, todos } from '@tds/db';
import { newId, now } from '../ids.js';
import { deliverEvent, publish, recordEvent } from '../sse.js';
import { HttpError } from '../http.js';

/** 单个 todo 的最小可视图 —— 闸门推进需要 phase 与 planFirst 两项。 */
interface TodoGateState {
  phase: TodoPhase;
  planFirst: boolean;
}

/** 调用方（人或 AI）允许对 todo 发出的 trigger 白名单。`merge_clean`/`merge_conflict`
 *  等属机器侧收敛，不该由用户或 AI 直接触发 —— 强行开放等于让调用方跳过闸门语义。
 *
 *  `cancel` 才是「关闭 todo」的 trigger：状态机里只有 `t === 'cancel'` 的分支（→ closed）。
 *  `Trigger` 联合类型里还挂着 `close`，但**没有任何分支处理它**，所以它永远返回
 *  ok:false。白名单不收它 —— 收了等于给调用方一个「看似合法、实则永远推不动」的 trigger。
 *  协议层这个死字段本身留给 TASK-7 处理。
 */
export function assertGateTrigger(trigger: Trigger): void {
  const ok =
    trigger.kind === 'approve' ||
    trigger.kind === 'complete' ||
    trigger.kind === 'revision_feedback' ||
    trigger.kind === 'cancel' ||
    trigger.kind === 'reopen';
  if (!ok) {
    throw new HttpError(409, `trigger "${trigger.kind}" cannot be issued against a todo`);
  }
}

/** 取 todo 的 teamId（经 project 关联）。不存在则 404 —— 不能让调用方
 *  猜 teamId，那样越权写入就无从校验了。 */
export async function loadTodoTeamId(db: Db, todoId: string): Promise<string> {
  const row = (await db
    .select({ teamId: projects.teamId, projectId: todos.projectId })
    .from(todos)
    .innerJoin(projects, eq(projects.id, todos.projectId))
    .where(eq(todos.id, todoId))
    .limit(1))[0];
  if (!row) throw new HttpError(404, `todo "${todoId}" not found`);
  return row.teamId;
}

/**
 * 推进 phase 并落审计 + SSE。
 *
 * 这是**唯一**允许写 `todos.phase` 的地方。
 *
 * **T7 契约**（被钉死的细节，T7 plan）：
 *   - `result.ok === false`：不改 `todos.phase` 与 `updated_at`（**与拒绝瞬间的
 *     行内容完全一致**）；不写 `phase_changed` SSE 行（详情页 / 看板都不应看到
 *     「假事件」）；仍写一条 `phase_rejected` 审计（双轨审计）。
 *   - `result.ok === true`：现有行为；尤其是 `revision_feedback`（`ok:true` 且
 *     `next === current`）是「闸门内打字修订」**不算拒绝**，行为不能被误改。
 *   - 多步写入（todo 行 + audit + sse_event 行）放进同一事务。
 *   - 实时推送（`sub.reply.raw.write`）在 commit **之后**才执行 —— 这样事务
 *     回滚时订阅者不会看到库里没发生的事件。
 */
export async function commitPhaseTransition(
  db: Db,
  params: {
    todoId: string;
    teamId: string;
    trigger: Trigger;
    planFirst: boolean;
    revisionFeedback?: { message: string };
  },
): Promise<{ ok: boolean; next: TodoPhase; dispatch: boolean; reason?: string }> {
  const before = (await db
    .select({ phase: todos.phase, planFirst: todos.planFirst })
    .from(todos)
    .where(eq(todos.id, params.todoId))
    .limit(1))[0];
  if (!before) {
    throw new HttpError(404, 'todo disappeared before transition');
  }

  const result = transition(before.phase, params.trigger, { planFirst: params.planFirst });
  const ts = now();

  // 准备「事务后推送」的帧。帧只在 ok:true 时构造 —— 拒绝时不发 phase_changed。
  const changePayload = {
    todoId: params.todoId,
    from: before.phase,
    to: result.next,
    trigger: params.trigger.kind,
  };
  type PendingSse = { scope: string; payload: Record<string, unknown> };
  const pendingSse: PendingSse[] =
    result.ok
      ? [
          { scope: `todo:${params.todoId}`, payload: changePayload },
          { scope: `team:${params.teamId}`, payload: changePayload },
        ]
      : [];

  // ── 事务：多步写要么全成功要么全回滚 ────────────────────────────
  const todoSeqs = await db.transaction(async (tx) => {
    if (result.ok) {
      // 接受：phase 与 updated_at 一起推。T7 契约要求「ok:false 时 phase 与
      // updated_at 都不动」—— 这一支只在 ok:true 时执行，自然满足。
      await tx
        .update(todos)
        .set({ phase: result.next, updatedAt: ts })
        .where(eq(todos.id, params.todoId));
    }

    if (params.revisionFeedback) {
      // 挂在该 todo 最近一条 build 上（无论是否 finished —— 历史亦保留）。
      const activeBuild = (await tx
        .select({ id: builds.id })
        .from(builds)
        .where(eq(builds.todoId, params.todoId))
        .orderBy(sql`${builds.n} desc`)
        .limit(1))[0];
      if (activeBuild) {
        const prior = (await tx
          .select({ version: documents.version })
          .from(documents)
          .where(and(eq(documents.buildId, activeBuild.id), eq(documents.kind, 'input')))
          .orderBy(sql`${documents.version} desc`)
          .limit(1))[0];
        await tx.insert(documents).values({
          id: newId(),
          buildId: activeBuild.id,
          kind: 'input',
          version: (prior?.version ?? 0) + 1,
          payload: { message: params.revisionFeedback.message, phase: before.phase },
          createdAt: ts,
          updatedAt: ts,
        });
      }
    }

    // 双轨审计：accepted（ok:true）→ phase_changed；rejected（ok:false）→ phase_rejected。
    // T7 明确要求「拒绝也必须留审计」，所以无条件写一行。
    await tx.insert(auditEvents).values({
      teamId: params.teamId,
      actorType: 'user',
      todoId: params.todoId,
      buildId: null,
      type: `phase_${result.ok ? 'changed' : 'rejected'}`,
      payload: {
        from: before.phase,
        to: result.next,
        trigger: params.trigger.kind,
        reason: result.reason ?? null,
      },
      createdAt: ts,
    });

    // SSE 行只在 ok:true 时写库 —— 拒绝不产生 phase_changed 帧。
    // recordEvent 不走订阅者推送（事务里不能写 raw socket）；commit 后再 deliver。
    const todoSeqsLocal: number[] = [];
    for (const p of pendingSse) {
      const inserted = await tx
        .insert(sseEvents)
        .values({
          teamId: params.teamId,
          scope: p.scope,
          type: 'phase_changed',
          payload: p.payload,
          createdAt: ts,
        })
        .returning({ seq: sseEvents.seq });
      todoSeqsLocal.push(inserted[0]?.seq ?? 0);
    }
    return todoSeqsLocal;
  });

  // ── 事务后推送：把刚拿到的 seq 用 deliverEvent 推给本进程订阅者 ───────
  pendingSse.forEach((p, i) => {
    const seq = todoSeqs[i] ?? 0;
    if (seq > 0) deliverEvent(p.scope, 'phase_changed', seq, p.payload);
  });

  // `ok` 与 `dispatch` 是两件事，必须分开回传：
  //   ok       = transition 是否被闸门接受
  //   dispatch = 是否需要调度一个 step
  // `close` / `reopen` 成功时 dispatch 缺席（不需要跑 step）。若调用方拿 dispatch
  // 当成功信号，就会把一次成功的关闭误报成「闸门拒绝」。
  const out: { ok: boolean; next: TodoPhase; dispatch: boolean; reason?: string } = {
    ok: result.ok,
    next: result.next,
    dispatch: result.dispatch ?? false,
  };
  if (result.reason !== undefined) out.reason = result.reason;
  return out;
}

/** 建 todo 时的入参（已由各调用方按自己的校验规则解析过）。 */
export interface CreateTodoInput {
  teamId: string;
  projectId: string;
  ownerMemberId: string;
  agentId: string | null;
  title: string;
  spec: string | null;
  tagIds: readonly string[];
  planFirst: boolean;
  separatePlanBuild: boolean;
  withChecklist: boolean;
  // 创建者身份（2026-10-18 新增，看板筛选依赖）。调用方必须显式传：
  //   REST 写路径（`routes/todos.ts` POST）→ 'user'
  //   Chief 派工（`routes/chief.ts` 的 dispatchTodo） → 'chief'
  //   MCP 工具面（`routes/mcp.ts` create_todo） → 'agent'
  // 不给默认值 —— 漏一个就被 TS 编译期挡住，绝不静默落到 'user'。
  createdByType: 'user' | 'chief' | 'agent';
}

/**
 * 建 todo —— 幂等性由调用方保证（REST 有唯一约束报错，MCP 侧靠调用方）。
 *
 * `seq_num` 按 `project.next_seq_num` 计数器分配，且 `(project_id, seq_num)` 唯一。
 * 这个计数器是 REST(`routes/todos.ts`) / Chief(`routes/chief.ts`) / MCP 三条写路径
 * **共用**的那一个 —— 两套算法并存时计数器会落后于 max，迟早撞唯一约束。
 *
 * **T6 契约**：REST / Chief / MCP 三条创建路径**必须**走本函数。返回 `{id, seqNum}`；
 * 不可观察副作用（事务内）：
 *   - `todo` 行（seq_num 原子分配）
 *   - `audit_event` 一行 `todo_created`
 *   - `sse_event` 一行 scope=`team:<teamId>` type=`todo_created`
 * 事务提交后再 `deliverEvent` 推送 team scope。如果事务回滚，三行同步消失，
 * 订阅者不会看到库里没发生的事件。
 */
export async function createTodo(db: Db, input: CreateTodoInput): Promise<{ id: string; seqNum: number }> {
  const project = (await db
    .select({ id: projects.id, teamId: projects.teamId })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .limit(1))[0];
  if (!project) throw new HttpError(404, `project "${input.projectId}" not found`);
  if (project.teamId !== input.teamId) {
    // 跨团队写入是越权：project 已把 todo 钉死在它的团队里。
    throw new HttpError(403, 'project belongs to a different team');
  }

  const ts = now();
  const id = newId();

  // ── 事务：project 号原子分配 + todo 行 + 审计 + sse_event 行 ──────────
  // 一条 `UPDATE ... RETURNING` 拿号：比「先读后写」更硬，并发下 Postgres 会给
  // 两个事务两个不同的号。RETURNING 给的是**递增后**的值，所以号 = 值 - 1。
  const txResult = await db.transaction(async (tx) => {
    const bumped = await tx
      .update(projects)
      .set({ nextSeqNum: sql`${projects.nextSeqNum} + 1` })
      .where(eq(projects.id, input.projectId))
      .returning({ nextSeqNum: projects.nextSeqNum });
    const bumpedRow = bumped[0];
    if (!bumpedRow) {
      throw new HttpError(404, `project "${input.projectId}" disappeared during create`);
    }
    const seq = bumpedRow.nextSeqNum - 1;

    await tx.insert(todos).values({
      id,
      projectId: input.projectId,
      seqNum: seq,
      ownerMemberId: input.ownerMemberId,
      agentId: input.agentId,
      title: input.title,
      spec: input.spec,
      tagIds: input.tagIds as string[],
      phase: 'todo',
      // 创建者身份：与 CreateTodoInput 同源 —— DB 列约束
      // 'user' | 'chief' | 'agent'（`db/drizzle/0004_todo_created_by_type.sql`）。
      // 三个调用方都是显式传，绝不静默默认。
      createdByType: input.createdByType,
      planFirst: input.planFirst,
      separatePlanBuild: input.separatePlanBuild,
      withChecklist: input.withChecklist,
      createdAt: ts,
      updatedAt: ts,
    });

    // 审计双轨：原站实测 `todo_created`。REST 与 MCP 的现行副作用都必须保
    // 留 —— Chief 的额外 `dispatched` 审计在路由层叠加，不要移动到这里。
    await tx.insert(auditEvents).values({
      teamId: input.teamId,
      actorType: 'user',
      todoId: id,
      buildId: null,
      type: 'todo_created',
      payload: {
        projectId: input.projectId,
        title: input.title,
        planFirst: input.planFirst,
        specLength: input.spec?.length ?? 0,
      },
      createdAt: ts,
    });

    // SSE 行（只落库，事务后由 deliverEvent 推送）。
    const inserted = await tx
      .insert(sseEvents)
      .values({
        teamId: input.teamId,
        scope: `team:${input.teamId}`,
        type: 'todo_created',
        payload: { todoId: id, projectId: input.projectId },
        createdAt: ts,
      })
      .returning({ seq: sseEvents.seq });
    return { seq, sseSeq: inserted[0]?.seq ?? 0 };
  });

  // ── 事务后推送：team scope 仅推送一次（详情页 / 看板订阅源） ──────
  if (txResult.sseSeq > 0) {
    deliverEvent(`team:${input.teamId}`, 'todo_created', txResult.sseSeq, {
      todoId: id,
      projectId: input.projectId,
    });
  }

  return { id, seqNum: txResult.seq };
}

/** 改 todo 的可变字段。白名单制：不给 phase（那只能走 commitPhaseTransition）。 */
export async function updateTodo(
  db: Db,
  todoId: string,
  teamId: string,
  patch: {
    title?: string;
    spec?: string | null;
    agentId?: string | null;
    tagIds?: readonly string[];
  },
): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: now() };
  if (patch.title !== undefined) set['title'] = patch.title;
  if (patch.spec !== undefined) set['spec'] = patch.spec;
  if (patch.agentId !== undefined) set['agentId'] = patch.agentId;
  if (patch.tagIds !== undefined) set['tagIds'] = patch.tagIds as string[];

  // 先确认存在再更新：drizzle 的 update 返回 RowList，没有 rowCount 可用。
  await readTodoGateState(db, todoId);
  await db.update(todos).set(set).where(eq(todos.id, todoId));
  await publish(db, `team:${teamId}`, 'todo_updated', { todoId }, teamId);
}

/**
 * 硬删除一个 todo。`todo` 表没有 `deleted_at`（`deletedAt` 只在 agents / connections /
 * skills / schedules），所以是硬删。
 *
 * **实测**（一次性 FK 探针，结论记在计划 §5.1 TASK-4）：所有指向 todo / build 的 FK 都是
 * `onDelete: cascade`，所以 `DELETE FROM todo` 会自动带走 build / document / build_message /
 * checklist —— 手写级联反而多余。`build.pinned_machine_id` 的 FK 只在**删机器**那个方向上会挡
 * （build 是引用方），删 build 不受它约束 —— 「有 build 的 todo 不能删」是错的。
 *
 * 唯一不会自动带走的是 `audit_event`：它的 FK 只有 `team_id → teams`，`todo_id` 是裸 text
 * 列。不显式删就留下孤儿行。所以**先删 todo**（失败就不动审计），**再删审计**。
 */
export async function deleteTodo(db: Db, todoId: string, teamId: string): Promise<void> {
  const deleted = await db.delete(todos).where(eq(todos.id, todoId)).returning({ id: todos.id });
  if (deleted[0] === undefined) throw new HttpError(404, `todo "${todoId}" not found`);
  await db.execute(sql`delete from "audit_event" where todo_id = ${todoId}`);
  await publish(db, `team:${teamId}`, 'todo_deleted', { todoId }, teamId);
}

/** 读 todo 的闸门状态 —— 给上层决定是否可推进。 */
export async function readTodoGateState(db: Db, todoId: string): Promise<TodoGateState> {
  const row = (await db.select({ phase: todos.phase, planFirst: todos.planFirst }).from(todos).where(eq(todos.id, todoId)).limit(1))[0];
  if (!row) throw new HttpError(404, `todo "${todoId}" not found`);
  return row;
}

/**
 * spec 字段硬上限。REST 与 MCP **共用同一个数** —— 两处入口各自写一份 800
 * 迟早漂移（一边放宽一边收紧，同一个 spec 一边能存一边不能存）。
 */
export const SPEC_MAX_CHARS = 800;

/**
 * 项目内未完成 todo 数 —— Free 档配额 `openTodosPerProject` 的输入。
 *
 * 「未完成」= 排除 done / failed / closed。定义只在这里，REST 与 MCP 同源。
 */
export async function countOpenTodos(db: Db, projectId: string): Promise<number> {
  const rows = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(todos)
    .where(
      and(
        eq(todos.projectId, projectId),
        ne(todos.phase, 'done'),
        ne(todos.phase, 'failed'),
        ne(todos.phase, 'closed'),
      ),
    );
  return rows[0]?.c ?? 0;
}

/** 单条 todo 的完整上下文（todo 行 + 全部 build + 全部文档）。 */
export interface TodoDetailRow {
  id: string;
  projectId: string;
  seqNum: number;
  ownerMemberId: string;
  agentId: string | null;
  title: string;
  spec: string | null;
  tagIds: string[];
  phase: TodoPhase;
  planFirst: boolean;
  separatePlanBuild: boolean;
  withChecklist: boolean;
  // 创建者身份（2026-10-18 新增）：详情页 Agent 创建徽章 / 筛选都用得到。
  createdByType: 'user' | 'chief' | 'agent';
  createdAt: number;
  updatedAt: number;
  projectName: string;
  repoUrl: string | null;
  repoFullName: string | null;
  defaultBranch: string;
}

export interface BuildDetailRow {
  id: string;
  n: number;
  branch: string;
  prevPhase: TodoPhase | null;
  triggerSource: string;
  withPlan: boolean;
  planDocId: string | null;
  changesDocId: string | null;
  prUrl: string | null;
  prNumber: number | null;
  errorMessage: string | null;
  settlementCode: string | null;
  createdAt: number;
  finishedAt: number | null;
}

export interface TodoDocumentRow {
  id: string;
  buildId: string;
  kind: string;
  version: number;
  payload: Record<string, unknown>;
  createdAt: number;
  /** 该文档属于第几轮 build；找不到对应 build 时为 null */
  buildN: number | null;
}

/**
 * 单条 todo 的完整上下文 —— REST 的 `GET /api/todos/:todoId` 与 MCP 读单条走**同一份**
 * 查询。两处各写一份 select 迟早漂移，这正是本模块存在的理由。
 *
 * `documents` 是**全部** build 的文档（按 `createdAt desc`，并附上所属 build 的轮次号），
 * 由调用方各自筛：REST 按 phase 筛出 `currentPhaseDocuments`，MCP 按 kind 分组给模型读完。
 * 这里不做 phase 过滤 —— 那是 UI 语义，不该渗进服务层。
 */
export async function loadTodoContext(db: Db, todoId: string): Promise<{
  todo: TodoDetailRow;
  builds: BuildDetailRow[];
  documents: TodoDocumentRow[];
}> {
  // drizzle 的 `text` 列返回 `string`，但 DB 层 CHECK 把 createdByType 收窄到
  // 'user' | 'chief' | 'agent' 三个值。select 阶段无法 cast（drizzle 不接受字面
  // 联合），所以在结果读出后 assert 一句。todo 行其它字段（id / projectId / 等）
  // 由 types 已保证非空，这里只补 createdByType 的字面化。
  const todoRaw = (await db
    .select({
      id: todos.id,
      projectId: todos.projectId,
      seqNum: todos.seqNum,
      ownerMemberId: todos.ownerMemberId,
      agentId: todos.agentId,
      title: todos.title,
      spec: todos.spec,
      tagIds: todos.tagIds,
      phase: todos.phase,
      planFirst: todos.planFirst,
      separatePlanBuild: todos.separatePlanBuild,
      withChecklist: todos.withChecklist,
      // 创建者身份（2026-10-18 新增）：GET /api/todos/:todoId 必须返回
      // 这俩字段，前端看板筛选 + 详情页 Agent 徽章都靠它们 —— 与
      // `GET /api/todos` 列表端点同时补齐（见 routes/todos.ts 看板 handler）。
      createdByType: todos.createdByType,
      createdAt: todos.createdAt,
      updatedAt: todos.updatedAt,
      projectName: projects.name,
      repoUrl: projects.repoUrl,
      repoFullName: projects.repoFullName,
      defaultBranch: projects.defaultBranch,
    })
    .from(todos)
    .innerJoin(projects, eq(projects.id, todos.projectId))
    .where(eq(todos.id, todoId))
    .limit(1))[0];
  if (!todoRaw) throw new HttpError(404, `todo "${todoId}" not found`);
  // drizzle text 列推断为 string，DB 层 CHECK 已把它收窄为三值字面联合；这里
  // 用 unknown 中转 cast 到字面，与 TodoDetailRow 对齐。CHECK 之外的脏数据
  // 在 DB 端就被拒掉，运行时等价 —— 不到这一步才到达 TS 层。
  const todo: TodoDetailRow = {
    ...todoRaw,
    createdByType: todoRaw.createdByType as 'user' | 'chief' | 'agent',
  };

  const buildRows = await db
    .select({
      id: builds.id,
      n: builds.n,
      branch: builds.branch,
      prevPhase: builds.prevPhase,
      triggerSource: builds.triggerSource,
      withPlan: builds.withPlan,
      planDocId: builds.planDocId,
      changesDocId: builds.changesDocId,
      prUrl: builds.prUrl,
      prNumber: builds.prNumber,
      errorMessage: builds.errorMessage,
      settlementCode: builds.settlementCode,
      createdAt: builds.createdAt,
      finishedAt: builds.finishedAt,
    })
    .from(builds)
    .where(eq(builds.todoId, todoId))
    .orderBy(sql`${builds.n} desc`);

  const buildNById = new Map<string, number>();
  for (const b of buildRows) buildNById.set(b.id, b.n);

  let docRows: TodoDocumentRow[] = [];
  if (buildNById.size > 0) {
    const all = await db
      .select({
        id: documents.id,
        buildId: documents.buildId,
        kind: documents.kind,
        version: documents.version,
        payload: documents.payload,
        createdAt: documents.createdAt,
      })
      .from(documents)
      .where(inArray(documents.buildId, [...buildNById.keys()]))
      .orderBy(sql`${documents.createdAt} desc`);
    docRows = all.map((d) => ({ ...d, buildN: buildNById.get(d.buildId) ?? null }));
  }
  return { todo, builds: buildRows, documents: docRows };
}
