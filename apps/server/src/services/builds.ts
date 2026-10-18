import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@tds/db';
import { auditEvents, builds, machines, sseEvents, steps, todos } from '@tds/db';
import { transition, type TodoPhase, type Trigger } from '@tds/protocol';
import { newId, now } from '../ids.js';
import { deliverEvent } from '../sse.js';
import { HttpError } from '../http.js';
import {
  assertGateTrigger,
  commitPhaseTransition,
  loadTodoTeamId,
  readTodoGateState,
} from './todos.js';

/**
 * build 生命周期服务层 —— MCP 的 build 类薄壳（`run_builds` / `cancel_builds` /
 * `confirm_builds` / `merge_builds` / `run_review`）与 REST / Chief 共用的业务规则。
 *
 * **为什么必须抽出来**：这五个工具里 `confirm_builds` / `merge_builds` 本质就是
 * 闸门主按钮，复用 `commitPhaseTransition` 就够；但 `run_builds` 要建 build +
 * step，而建 build 的规则（分支名 `tds/conv-<buildId>`、`n` 递增、`session`
 * 初值、机器槽探测）是 Chief `dispatchTodo` 里内联的 60 行 —— 复制第二份迟早漂移。
 *
 * **共享层不引入新相位**：五个工具全部落在 `packages/protocol/state-machine.ts`
 * 已有分支上，`run_review` 用的 `review_start` / `review_end` 也是既有 union
 * 成员 —— 此前**没有任何调用方**（全仓 grep 为空），即交叉评审这条路径整体没
 * 接线。这里是它的第一批调用方。
 */

/** 单个 todo 的 build 视图 —— 起 build / 取消都需要 todo 自身的状态。 */
interface TodoBuildState {
  phase: TodoPhase;
  planFirst: boolean;
  agentId: string | null;
}

async function loadTodoBuildState(db: Db, todoId: string): Promise<TodoBuildState> {
  const row = (await db
    .select({ phase: todos.phase, planFirst: todos.planFirst, agentId: todos.agentId })
    .from(todos)
    .where(eq(todos.id, todoId))
    .limit(1))[0];
  if (!row) throw new HttpError(404, `todo "${todoId}" not found`);
  return row;
}

/**
 * 找一台能接活的机器：online + buildEnabled + 同团队 + 还有空槽。
 *
 * 空槽判定 = `maxConcurrentTasks` 减去当前 running/pending 的 step 数，与
 * `routes/machine.ts` 的 claim 路径同一口径。**取不到机器不是错误** —— 产品
 * 语义是 todo 落 `queued` 等机器上线，Chief 的 `dispatchTodo` 也这么做。
 */
async function pickAvailableMachine(db: Db, teamId: string): Promise<string | null> {
  const machine = (await db
    .select({ id: machines.id, maxConcurrentTasks: machines.maxConcurrentTasks })
    .from(machines)
    .where(
      and(
        eq(machines.teamId, teamId),
        eq(machines.isOnline, true),
        eq(machines.buildEnabled, true),
      ),
    )
    .orderBy(asc(machines.createdAt))
    .limit(1))[0];
  if (!machine) return null;

  const busy = (await db
    .select({ n: sql<number>`count(*)::int` })
    .from(steps)
    .where(and(eq(steps.machineId, machine.id), inArray(steps.status, ['running', 'pending']))))[0];
  return Number(busy?.n ?? 0) < machine.maxConcurrentTasks ? machine.id : null;
}

/** 起 build 的结果。`ok:false` 时**库一行未动**（连 build 都不建）。 */
export interface StartBuildResult {
  ok: boolean;
  phase: TodoPhase;
  buildId?: string;
  stepId?: string | null;
  reason?: string;
}

/**
 * 起一个新 build：写 `build` 行 + 必要时写一条 `queued` step，并把 phase 推到
 * 状态机认可的位置。
 *
 * **为什么要新 build 而不是复用旧的**：同一个 todo 的每一轮都是独立 build
 * （`build.n` 递增、分支名含 buildId）。复用会把两轮的 diff / 消息 / 结算码混在
 * 一起 —— `build_message.seq` 是 per-build 的，混了就串了。
 *
 * **先问状态机再写库**：状态机拒绝就立刻返回，不建 build。顺序不能反 ——
 * 先建后判会在拒绝路径上留下一条永远没人认领的 build + queued step。
 */
async function startBuild(
  db: Db,
  params: {
    todoId: string;
    teamId: string;
    agentId: string;
    trigger: Trigger;
    triggerSource: 'user' | 'agent';
    phase: TodoPhase;
    planFirst: boolean;
  },
): Promise<StartBuildResult> {
  const ts = now();
  const machineId = await pickAvailableMachine(db, params.teamId);

  // ── 相位落点 ────────────────────────────────────────────────────────
  // 有机器：交给状态机（`claim` 从 todo/queued 落到 planning）。
  //
  // 无机器：**不能**让状态机决定 —— `transition(todo, claim)` 恒回 `planning`，
  // 状态机里没有「没机器」这个概念（它根本不知道机器存在与否）。产品语义是落
  // `queued` 等机器上线；Chief 的 `dispatchTodo` 同样是无机器时直接写 `queued`
  // （那里也绕过了 transition，见 chief.ts 的注释）。这里与它同源。
  let verdict: { ok: boolean; next: TodoPhase; reason?: string };
  if (machineId) {
    const r = transition(params.phase, params.trigger, { planFirst: params.planFirst });
    verdict = { ok: r.ok, next: r.next, ...(r.reason !== undefined ? { reason: r.reason } : {}) };
  } else if (params.phase === 'todo' || params.phase === 'queued') {
    verdict = { ok: true, next: 'queued', reason: 'no machine online; queued' };
  } else {
    verdict = { ok: false, next: params.phase, reason: `no machine online; ${params.phase} needs one` };
  }
  if (!verdict.ok) {
    return { ok: false, phase: params.phase, reason: verdict.reason ?? 'rejected by state machine' };
  }
  const buildId = newId();
  let stepId: string | null = null;

  // ── build + step + phase + 审计 + SSE 行：同一事务 ────────────────────
  const seqs = await db.transaction(async (tx) => {
    const prior = (await tx
      .select({ maxN: sql<number>`coalesce(max(${builds.n}), 0)::int` })
      .from(builds)
      .where(eq(builds.todoId, params.todoId)))[0];

    await tx.insert(builds).values({
      id: buildId,
      todoId: params.todoId,
      n: Number(prior?.maxN ?? 0) + 1,
      // 分支名规则与 Chief 一致：buildId 同时就是分支名的一部分
      branch: `tds/conv-${buildId}`,
      prevPhase: params.phase,
      triggerSource: params.triggerSource,
      withPlan: params.planFirst,
      withChecklist: false,
      agentId: params.agentId,
      pinnedMachineId: machineId,
      session: { runtime: 'unknown', id: newId(), openedAt: ts },
      usageByModel: [],
      createdAt: ts,
      v: 0,
    });

    // 有机器才写 step —— 无 step 的 build 不会被任何 claim 领到，
    // 与 Chief 保持同一取舍（Chief 那里写了同样语义的注释）。
    if (machineId) {
      stepId = newId();
      await tx.insert(steps).values({ id: stepId, buildId, machineId: null, status: 'queued' });
    }

    await tx.update(todos).set({ phase: verdict.next, updatedAt: ts }).where(eq(todos.id, params.todoId));

    await tx.insert(auditEvents).values({
      teamId: params.teamId,
      actorType: params.triggerSource === 'agent' ? 'agent' : 'user',
      todoId: params.todoId,
      buildId,
      type: 'dispatched',
      payload: {
        trigger: params.trigger.kind,
        from: params.phase,
        to: verdict.next,
        hasMachine: machineId !== null,
      },
      createdAt: ts,
    });

    const frame = {
      todoId: params.todoId,
      buildId,
      phase: verdict.next,
      triggeredBy: params.triggerSource,
    };
    const inserted = await tx
      .insert(sseEvents)
      .values([
        {
          teamId: params.teamId,
          scope: `todo:${params.todoId}`,
          type: 'dispatched',
          payload: frame,
          createdAt: ts,
        },
        {
          teamId: params.teamId,
          scope: `team:${params.teamId}`,
          type: 'dispatched',
          payload: frame,
          createdAt: ts,
        },
      ])
      .returning({ seq: sseEvents.seq });
    return inserted.map((r) => r.seq);
  });

  // 事务提交后再推 —— 回滚时订阅者不会看到库里没发生的事件
  const frame = {
    todoId: params.todoId,
    buildId,
    phase: verdict.next,
    triggeredBy: params.triggerSource,
  };
  [`todo:${params.todoId}`, `team:${params.teamId}`].forEach((scope, i) => {
    const seq = seqs[i];
    if (seq !== undefined && seq > 0) deliverEvent(scope, 'dispatched', seq, frame);
  });

  return { ok: true, buildId, stepId, phase: verdict.next };
}

/** 闸门类工具的共同回包。 */
export interface GateResult {
  ok: boolean;
  phase: TodoPhase;
  dispatch: boolean;
  reason?: string;
}

/**
 * `run_builds` —— 启动 build（对已存在但没在跑的 todo）。
 *
 * 已终态（done/failed/closed）不接受 —— 那是 `reopen` 或「新建 todo」的事，
 * 状态机会拒绝，本函数把 reason 原样回报。
 */
export async function runBuilds(db: Db, todoId: string): Promise<StartBuildResult> {
  const state = await loadTodoBuildState(db, todoId);
  const teamId = await loadTodoTeamId(db, todoId);

  // builds.agent_id 是 notNull 外键 —— 无 agent 的 todo 起不了 build
  if (!state.agentId) {
    return { ok: false, phase: state.phase, reason: 'todo has no agent assigned' };
  }

  return startBuild(db, {
    todoId,
    teamId,
    agentId: state.agentId,
    // claim 是「机器接手」语义；相位落点由状态机自己判断
    trigger: { kind: 'claim', machineId: 'pending' },
    triggerSource: 'user',
    phase: state.phase,
    planFirst: state.planFirst,
  });
}

/**
 * `cancel_builds` —— 取消 build。
 *
 * **必须同时动 step 和 build**：只把 todo 推到 `closed` 而留着 `running` 的
 * step，机器那边会继续跑完再 `POST done`，`routes/machine.ts` 的 done 路径会
 * 把这个 build 的 todo 又写回 `closed`/`failed` —— 撤销立刻被推翻。
 */
export async function cancelBuilds(
  db: Db,
  todoId: string,
): Promise<{ ok: boolean; phase: TodoPhase; cancelledSteps: number; reason?: string }> {
  const state = await loadTodoBuildState(db, todoId);
  const teamId = await loadTodoTeamId(db, todoId);

  const trigger: Trigger = { kind: 'cancel' };
  // 白名单防御：cancel 在名单内，但以后换 trigger 时这行会挡住
  assertGateTrigger(trigger);

  const cancelledSteps = await db.transaction(async (tx) => {
    // 该 todo 全部 build 下未终态的 step
    const openSteps = (
      await tx
        .select({ id: steps.id })
        .from(steps)
        .innerJoin(builds, eq(builds.id, steps.buildId))
        .where(
          and(
            eq(builds.todoId, todoId),
            inArray(steps.status, ['queued', 'pending', 'running']),
          ),
        )
    ).map((r) => r.id);

    if (openSteps.length > 0) {
      await tx
        .update(steps)
        .set({ status: 'cancelled', finishedAt: now(), error: 'cancelled by user' })
        .where(inArray(steps.id, openSteps));
    }

    // build 自身标终态，否则看板仍显示它在跑
    const openBuilds = (
      await tx.select({ id: builds.id }).from(builds).where(and(eq(builds.todoId, todoId), sql`${builds.finishedAt} is null`))
    ).map((r) => r.id);
    if (openBuilds.length > 0) {
      await tx
        .update(builds)
        .set({ finishedAt: now(), v: sql`${builds.v} + 1` })
        .where(inArray(builds.id, openBuilds));
    }

    return openSteps.length;
  });

  // 相位推进仍走共享层 —— 审计 / SSE / 闸门拒绝语义一次拿全
  const r = await commitPhaseTransition(db, { todoId, teamId, trigger, planFirst: state.planFirst });

  return { ok: r.ok, phase: r.next, cancelledSteps, ...(r.reason !== undefined ? { reason: r.reason } : {}) };
}

/**
 * `confirm_builds` —— Confirm 闸门主按钮（批准计划，开始改代码）。
 *
 * 闸门纪律：闸门只认各自主按钮（`gateDecision`），任何其它 trigger 都推不动。
 * 这里用 `{kind:'approve', by}`，与 REST `/approve` 完全同一个 trigger。
 */
export async function confirmBuilds(
  db: Db,
  todoId: string,
  by: 'user' | 'chief',
): Promise<GateResult> {
  const teamId = await loadTodoTeamId(db, todoId);
  const gate = await readTodoGateState(db, todoId);
  const trigger: Trigger = { kind: 'approve', by };
  assertGateTrigger(trigger);
  const r = await commitPhaseTransition(db, { todoId, teamId, trigger, planFirst: gate.planFirst });
  return { ok: r.ok, phase: r.next, dispatch: r.dispatch, ...(r.reason !== undefined ? { reason: r.reason } : {}) };
}

/**
 * `merge_builds` —— Review 闸门主按钮（验收并完成）。
 *
 * `merge: false` → 落 `done`；`merge: true` → 落回 `implement` 跑 merge turn
 * （状态机 `advance` 分支里此时 dispatch 为 true）。
 */
export async function mergeBuilds(db: Db, todoId: string, merge: boolean): Promise<GateResult> {
  const teamId = await loadTodoTeamId(db, todoId);
  const gate = await readTodoGateState(db, todoId);
  const trigger: Trigger = { kind: 'complete', merge };
  assertGateTrigger(trigger);
  const r = await commitPhaseTransition(db, { todoId, teamId, trigger, planFirst: gate.planFirst });
  return { ok: r.ok, phase: r.next, dispatch: r.dispatch, ...(r.reason !== undefined ? { reason: r.reason } : {}) };
}

/**
 * `message_todo` —— 给 todo 发一条消息，触发一轮修订。
 *
 * 语义**就是**闸门上的 `revision_feedback`：文档铁律「输入框里打任何文字，包括
 * `confirm` 这个词，都只是修订反馈 —— agent 跑一轮修订后又停在同一个闸门，
 * 它既不会开始改代码，也不会合并」。所以：
 *
 *   - 只在**闸门**上有效（confirm / review），其它相位拒绝
 *   - phase **必须不变** —— 这是铁律，`gateDecision` 恒回 `revise`，落点就是当前闸门
 *   - 消息落成 `input` 文档（按 version 递增），详情页读的就是它
 *   - `dispatch=true` 表示要跑一轮修订 step
 *
 * 与 REST `/api/todos/:id/feedback` **同一个服务函数** —— 两条写路径各写一份
 * 就会漂移，而这里漂移的后果是「AI 能绕过闸门」。
 */
export async function messageTodo(
  db: Db,
  todoId: string,
  message: string,
): Promise<{ ok: boolean; phase: TodoPhase; revisionDispatched: boolean; reason?: string }> {
  const state = await loadTodoBuildState(db, todoId);
  const teamId = await loadTodoTeamId(db, todoId);

  if (state.phase !== 'confirm' && state.phase !== 'review') {
    // 与 REST 的措辞对齐（同一段语义，两条入口必须说同一句话）
    return {
      ok: false,
      phase: state.phase,
      revisionDispatched: false,
      reason: `message only valid inside a gate (confirm / review); current phase is ${state.phase}`,
    };
  }

  const trigger: Trigger = { kind: 'revision_feedback' };
  assertGateTrigger(trigger);

  const r = await commitPhaseTransition(db, {
    todoId,
    teamId,
    trigger,
    planFirst: state.planFirst,
    revisionFeedback: { message },
  });

  // 闸门铁律兜底：打文字绝不能推进 phase。`gateDecision` 恒回 revise 保证它不变，
  // 这里再断言一次 —— 万一 protocol 包未来漂移，我们宁可报错也不让闸门被悄悄推进。
  if (r.next !== state.phase) {
    throw new HttpError(
      409,
      `message unexpectedly changed phase (${state.phase} -> ${r.next}); refusing to advance`,
    );
  }

  return { ok: r.ok, phase: r.next, revisionDispatched: r.dispatch };
}

/**
 * 收敛一个 build 的相位 —— 机器 `POST done` 的相位落点真源。
 *
 * **2026-10-17**：这段逻辑原本内联在 `routes/machine.ts` 的 done 路径里，按
 * `body.status` **硬编码**：
 *
 *   succeeded → review   cancelled → closed   其余 → failed
 *
 * 完全不看 todo 当时的相位。接上 `run_review`（Confirm 闸门 → `reviewing`）
 * 之后这就成了真 bug：todo 在 `reviewing` 跑完一轮，被硬写成 `review` ——
 * **直接跳过了 Confirm 闸门**，一个未经批准的计划自己变成了「待验收」。
 * 文档最核心的那条铁律（闸门只认主按钮）被机器协议从后门绕过了。
 *
 * 现在落点一律问状态机：`reviewing` 收成功 → `review_end` → 回 `confirm`。
 * 起始相位由 `triggerSource` 决定用什么 trigger：
 *   成功 → `plan_ready`（planning/queued/todo）或 `changes_ready`（implement）
 *         或 `review_end`（reviewing）
 *   取消 → `cancel`    失败 → `fail`
 *
 * 状态机拒绝了怎么办：**不写相位**（保持原相位）并把 reason 透出去。step 与
 * build 的终态照记 —— 机器确实跑完了，只是这个相位不认这次收敛。
 */
export async function settleBuildPhase(
  db: Db,
  params: { buildId: string; todoId: string; status: 'succeeded' | 'failed' | 'cancelled' },
): Promise<{ phase: TodoPhase; ok: boolean; reason?: string }> {
  const row = (await db
    .select({ phase: todos.phase, planFirst: todos.planFirst })
    .from(todos)
    .where(eq(todos.id, params.todoId))
    .limit(1))[0];
  if (!row) return { phase: 'failed', ok: false, reason: 'todo not found' };

  const trigger: Trigger =
    params.status === 'cancelled'
      ? { kind: 'cancel' }
      : params.status === 'failed'
        ? { kind: 'fail' }
        : // 成功：按**当前相位**选 trigger —— 评审的收敛与实施的收敛不是一回事
          row.phase === 'reviewing'
          ? { kind: 'review_end' }
          : row.phase === 'implement'
            ? { kind: 'changes_ready' }
            : { kind: 'plan_ready' };

  const verdict = transition(row.phase, trigger, { planFirst: row.planFirst });
  if (!verdict.ok) {
    // 不推进 —— 保持原相位。返回 reason 让机器侧日志能看出「跑完了但没推进」。
    return { phase: row.phase, ok: false, reason: verdict.reason ?? 'rejected by state machine' };
  }
  return { phase: verdict.next, ok: true };
}

/**
 * `run_review` —— 在 Confirm 闸门上发起 AI 交叉评审。
 *
 * 状态机 `reviewing` 相位：`review_end` 恒回 `confirm`。**这不是「回到触发它的
 * 那个闸门」** —— 协议里没有记住来源闸门的字段。落到别的相位上时状态机会拒绝，
 * 本函数把 reason 原样回报，不自己发明落点。
 *
 * `review_start` 在本文件之前**零调用方**（全仓 grep 为空），状态机注释里也写明
 * 这条路径整体未实现 —— 这里给它第一批真实调用方。
 */
export async function runReview(db: Db, todoId: string): Promise<StartBuildResult> {
  const state = await loadTodoBuildState(db, todoId);
  const teamId = await loadTodoTeamId(db, todoId);

  if (!state.agentId) {
    return { ok: false, phase: state.phase, reason: 'todo has no agent assigned' };
  }

  return startBuild(db, {
    todoId,
    teamId,
    agentId: state.agentId,
    trigger: { kind: 'review_start' },
    triggerSource: 'agent',
    phase: state.phase,
    planFirst: state.planFirst,
  });
}
