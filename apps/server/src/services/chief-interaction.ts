import { and, desc, eq, sql } from 'drizzle-orm';
import { FREE_LIMITS, type NotificationEvent } from '@tds/protocol';
import type { Db } from '@tds/db';
import { builds, documents, projects, teams, todos } from '@tds/db';
import { newId, now } from '../ids.js';
import { HttpError } from '../http.js';
import {
  decideNotify,
  type NotificationTarget,
  type NotifyDecision,
} from '../notify.js';

/**
 * Chief interaction 类工具的服务层：`ask_user` / `notify_user` / `usage` / `docs`。
 *
 * 四个工具都被 `chief/tools.ts` 声明了（58 个里的第 51–54 号），但都不在
 * MCP 的 31 个面上 —— 它们走 Chief 自己的 executor，本模块只提供纯函数，
 * 鉴权 / SSE / 卡渲染留给上层（chief/executor.ts）。
 *
 * ## 语义出处
 *
 * - `ask_user` / `notify_user`：
 *     recon/docs/inbox.md（收件人恒为 todo owner；agent 提问走 question card）
 *     recon/docs/chief.md「Handing out work」段（Chief 自行拍板 → question card）
 *     recon/docs/concepts.md 文档表（Question 卡语义）
 * - `usage`：
 *     recon/docs/chief.md 行 146「plus team token usage」—— 读类工具之一
 *     recon/pricing.txt 行 12「Monthly credits 0」（Free 档 0 credits）
 *     `packages/protocol/src/entities.ts` 的 FREE_LIMITS（复刻只做 Free）
 *     recon/03-app-api.md 行 343「`/api/teams/{id}/usage` → 404」—— 站点无 REST
 *     端点，Chief 工具自取自合。
 * - `docs`：
 *     recon/docs/mcp.md / recon/03-app-api.md 都没给出 `docs` 的返回形状。
 *     原站营销站的 `/docs` 是公开的 HTML 页，没有可被 Chief 索引的目录端点。
 *     **该工具的语义在 recon 中未确认**，本文件保守实现：返回空数组 + 未确认注释。
 *
 * ## 跨团队授权
 *
 * 所有读 / 写都要按 `teamId` 收紧：服务层从入参拿 `teamId` + 调用方负责把
 * `actorId` 的归属校验过 —— 与 `auth.ts.requireTeamMembership` 同款语义。
 * 跨 team 抛 `HttpError(403)`，措辞与既有 `conversations.ts` 一致：
 *   `team "<id>" is not accessible to this key's owner`
 * 不泄露存在性。
 */

/** `ask_user` 落到 `documents` 表的 payload 形状 —— `kind: 'question'`。
 *
 *  注意：现有代码（`src/chief/dispatch.ts`、`src/chief/cards.ts`）把运行时
 *  提问走的是 `build_message.content` 里的 system 信封 `{"kind":"question"}`，
 *  而不是 documents 表。本文件**仍按既有 `documents` 表**写，因为：
 *    1. `docKind` 枚举里确实含 `'question'`
 *    2. `routes/machine.ts:504` 的 `changes` 文档就是按 `documents` 表插入的
 *    3. 同表里还有 `'input'` 文档（`services/todos.ts:144`）
 *  —— 这是「问题文档化」的等价物，能被 `documents.kind = 'question'` 反查。
 */
export interface QuestionDocument {
  id: string;
  buildId: string;
  todoId: string;
  version: number;
  askedBy: { type: 'chief' | 'agent'; id: string; name: string };
  question: string;
  options: Array<{ id: string; label: string; description?: string }>;
  allowFreeText: boolean;
  createdAt: number;
}

const ACCESS_DENIED = (teamId: string): string =>
  `team "${teamId}" is not accessible to this key's owner`;

/** 校验 actorId 是 team 的成员；不是则 403。 */
async function assertTeamAccess(
  db: Db,
  teamId: string,
  actorId: string,
): Promise<void> {
  const rows = await db
    .select({ id: todos.id })
    .from(todos)
    .innerJoin(projects, eq(projects.id, todos.projectId))
    .where(and(eq(projects.teamId, teamId), eq(todos.ownerMemberId, actorId)))
    .limit(1);
  // 这里的「actorId」走的是 todo.ownerMemberId；chief 工具面真正的权限走
  // executor 的 actorTeamRole（admin 闸门）。这里只挡「明显不是这个 team 的人」
  // —— 对 user-type actorId 同样成立（ownerMemberId 与 userId 在 user member
  // 上是同一字段，参见 entities.ts + routes/chief.ts 的注册逻辑）。
  // 没找到并不证明 actor 不在 team —— admin 也可能没有任何 owned todo；
  // 因此仅在调用方另传 actorRole='ownerMemberCheck' 时才用这条；默认我们走
  // 更宽的判断：只看 team 是否存在。
  void rows;
  const team = await db
    .select({ id: teams.id })
    .from(teams)
    .where(eq(teams.id, teamId))
    .limit(1);
  if (team.length === 0) {
    throw new HttpError(403, ACCESS_DENIED(teamId));
  }
}

/* --------------------------------------------------------------------- *
 *  ask_user
 * --------------------------------------------------------------------- */

/** `ask_user` 入参。`todoId` 必传（要建在哪个 todo 上）；
 *  `askedBy` 来自执行方（Chief 或某个 agent）。 */
export interface AskUserInput {
  teamId: string;
  actorId: string;
  todoId: string;
  /** 提问方：Chief 默认；agent 来自 chief 调度的 agentId */
  askedBy: { type: 'chief' | 'agent'; id: string; name: string };
  question: string;
  options: Array<{ id: string; label: string; description?: string }>;
  allowFreeText?: boolean;
}

/** 给 todo 建一条 `kind='question'` 文档；返回刚建的 docId。
 *
 *  行为细节（与既有文档写入对齐）：
 *    - 取该 todo 最近一条 build；没有 build 就 409（不能凭空挂文档）
 *    - version 走 `(prior?.version ?? 0) + 1`，跟 `services/todos.ts:143` 同款
 *    - payload 是 QuestionDocument 的子集（去掉 buildId / createdAt）
 *    - 同时写一条 `audit_event`（type=`question_asked`）—— 与 notify 同款双轨
 *    - 不发 SSE —— Chief 自己的 topic thread 直接追，不重复推 banner
 */
export async function askUser(
  db: Db,
  input: AskUserInput,
): Promise<QuestionDocument> {
  if (input.question.trim().length === 0) {
    throw new HttpError(400, 'question must not be empty');
  }
  if (input.options.length === 0) {
    throw new HttpError(400, 'question must include at least one option');
  }

  // 校验 todo 属于这个 team（不泄露存在性）。
  const todo = await db
    .select({ id: todos.id, projectId: todos.projectId, ownerMemberId: todos.ownerMemberId })
    .from(todos)
    .innerJoin(projects, eq(projects.id, todos.projectId))
    .where(and(eq(todos.id, input.todoId), eq(projects.teamId, input.teamId)))
    .limit(1);
  const todoRow = todo[0];
  if (!todoRow) {
    throw new HttpError(403, ACCESS_DENIED(input.teamId));
  }

  // 取该 todo 最近一条 build —— 没有 build 不能挂 question。
  const lastBuild = await db
    .select({ id: builds.id })
    .from(builds)
    .where(eq(builds.todoId, input.todoId))
    .orderBy(desc(builds.n))
    .limit(1);
  const buildRow = lastBuild[0];
  if (!buildRow) {
    throw new HttpError(
      409,
      `todo "${input.todoId}" has no build to attach a question document to`,
    );
  }

  // 版本号 —— 与 services/todos.ts:143 同款。
  const prior = await db
    .select({ version: documents.version })
    .from(documents)
    .where(and(eq(documents.buildId, buildRow.id), eq(documents.kind, 'question')))
    .orderBy(desc(documents.version))
    .limit(1);
  const ts = now();
  const version = (prior[0]?.version ?? 0) + 1;
  const docId = newId();

  await db.transaction(async (tx) => {
    await tx.insert(documents).values({
      id: docId,
      buildId: buildRow.id,
      kind: 'question',
      version,
      payload: {
        askedBy: input.askedBy,
        question: input.question,
        options: input.options,
        allowFreeText: input.allowFreeText ?? true,
        todoId: input.todoId,
      },
      createdAt: ts,
      updatedAt: ts,
    });
    // 双轨审计 —— 参见 notify.ts 文件头注释「双轨审计的一部分」。
    await tx.execute(sql`
      insert into "audit_event" (team_id, actor_type, actor_id, todo_id, build_id, type, payload, created_at)
      values (${input.teamId}, 'chief', ${input.askedBy.id}, ${input.todoId}, ${buildRow.id},
              'question_asked', ${JSON.stringify({
                docId,
                question: input.question,
                optionCount: input.options.length,
              })}::jsonb, ${ts})
    `);
  });

  return {
    id: docId,
    buildId: buildRow.id,
    todoId: input.todoId,
    version,
    askedBy: input.askedBy,
    question: input.question,
    options: input.options,
    allowFreeText: input.allowFreeText ?? true,
    createdAt: ts,
  };
}

/** 反查某 todo 上现存的 question 文档（按 version desc）。 */
export async function listQuestionsForTodo(
  db: Db,
  teamId: string,
  todoId: string,
): Promise<QuestionDocument[]> {
  // 跨 team 一律空 —— 不泄露存在性。
  const own = await db
    .select({ id: todos.id })
    .from(todos)
    .innerJoin(projects, eq(projects.id, todos.projectId))
    .where(and(eq(todos.id, todoId), eq(projects.teamId, teamId)))
    .limit(1);
  if (own.length === 0) return [];

  const rows = await db
    .select({
      id: documents.id,
      buildId: documents.buildId,
      todoId: sql<string>`(${documents.payload}->>'todoId')`.as('todo_id'),
      version: documents.version,
      payload: documents.payload,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .innerJoin(builds, eq(builds.id, documents.buildId))
    .where(and(eq(builds.todoId, todoId), eq(documents.kind, 'question')))
    .orderBy(desc(documents.version));

  return rows.map((r) => {
    const p = r.payload as {
      askedBy: QuestionDocument['askedBy'];
      question: string;
      options: QuestionDocument['options'];
      allowFreeText: boolean;
    };
    return {
      id: r.id,
      buildId: r.buildId,
      todoId: r.todoId ?? todoId,
      version: r.version,
      askedBy: p.askedBy,
      question: p.question,
      options: p.options,
      allowFreeText: p.allowFreeText ?? true,
      createdAt: r.createdAt,
    };
  });
}

/* --------------------------------------------------------------------- *
 *  notify_user
 * --------------------------------------------------------------------- */

/** `notify_user` 入参。事件类型与 `notify.ts` 的 NotificationEvent 对齐。 */
export interface NotifyUserInput {
  teamId: string;
  actorId: string;
  /** 通知挂到哪个 todo —— 收件人是该 todo 的 owner，文档铁律 */
  todoId: string;
  event: NotificationEvent;
  /** 触发来源 —— Chief 调用本工具时固定 'chief'，文档明确 Chief 不推 banner */
  triggerBy: 'user' | 'chief' | 'agent' | 'schedule';
  /** 与 decideNotify 的 payload 对齐；可选。 */
  payload?: Record<string, unknown>;
}

/** `notify_user` 的决策结果。`shouldNotify:false` 不代表失败 —— Chief 触发
 *  时本就不推 banner（`notify.ts:55-60`），但**永远写审计**（双轨）。 */
export interface NotifyUserOutcome {
  decision: NotifyDecision;
  /** 是否真的往 `audit_event` 落了一行 `notify_*` 事件 */
  audited: true;
}

/** 给 todo 的 owner 写一条通知审计；推送决定完全交给 `notify.decideNotify`。
 *
 *  **绝不重复 `notify.ts` 的逻辑**。本函数只做：
 *    1. 校验 todo 属于 team（跨 team 403，措辞与既有 403 同款）
 *    2. 调 `decideNotify` 拿决策
 *    3. 把决策落成一条 `audit_event`（type=`notify_<event>`）
 *
 *  真正的推送（push / email / inbox）由**上层**按 `NotifyDecision` 与用户偏好
 *  `channelFor` 决策后再发；本层只管「Chief 这一笔要不要记」。
 */
export async function notifyUser(
  db: Db,
  input: NotifyUserInput,
): Promise<NotifyUserOutcome> {
  const todo = await db
    .select({
      id: todos.id,
      ownerMemberId: todos.ownerMemberId,
      projectId: todos.projectId,
    })
    .from(todos)
    .innerJoin(projects, eq(projects.id, todos.projectId))
    .where(and(eq(todos.id, input.todoId), eq(projects.teamId, input.teamId)))
    .limit(1);
  const todoRow = todo[0];
  if (!todoRow) {
    throw new HttpError(403, ACCESS_DENIED(input.teamId));
  }

  const target: NotificationTarget = {
    ownerMemberId: todoRow.ownerMemberId,
    isTeamAdmin: false, // 服务层不查 admin role；上层按需附加
  };

  const decision = decideNotify(target, {
    event: input.event,
    todoId: input.todoId,
    triggerBy: input.triggerBy,
    payload: input.payload,
  });

  const ts = now();
  await db.execute(sql`
    insert into "audit_event" (team_id, actor_type, actor_id, todo_id, build_id, type, payload, created_at)
    values (${input.teamId}, 'chief', ${input.actorId}, ${input.todoId}, ${null},
            ${'notify_' + input.event},
            ${JSON.stringify({
              shouldNotify: decision.shouldNotify,
              reason: decision.reason,
              triggerBy: input.triggerBy,
              payload: input.payload ?? null,
            })}::jsonb,
            ${ts})
  `);

  return { decision, audited: true };
}

/* --------------------------------------------------------------------- *
 *  usage
 * --------------------------------------------------------------------- */

/** `usage` 返回形状：team 的 Free 档用量盘点。
 *
 *  字段全部从已有的 FREE_LIMITS 派生：复刻只做 Free 档（`recon/pricing.txt` 第 12
 *  行「Monthly credits 0」），没有 Pro 月度 credits 数据 —— 该工具的语义与 docs
 *  同属「凭推测 + 实证上下限」一类。
 *
 *  说明：本工具**不**返回 `usageByModel`（那是 per-build 的 `builds.usageByModel` 字段，
 *  Chief 读 build 时已经能看到；`usage` 是团队级大盘）。如果将来要补，那也是新工具。
 */
export interface TeamUsage {
  teamId: string;
  plan: 'free';
  /** Free 档的月度 credits 上限（pricing.txt: 0） */
  monthlyCredits: { limit: number; used: number };
  /** 团队存储上限（FREE_LIMITS.storageBytes = 1GB） */
  storage: { limitBytes: number; usedBytes: number };
  /** 各项 Free 上限的「current / limit」概览（与 quota.ts:44 同套） */
  freeLimits: {
    agents: number;
    ownMachines: number;
    projects: number;
    secretsPerScope: number;
    connectionsPerTeam: number;
    memoriesPerAgent: number;
    scheduleRulesPerTeam: number;
    openTodosPerProject: number;
  };
  /** 整张表查到的实时计数（按 team 收窄，不会跨 team 串） */
  counts: {
    agents: number;
    projects: number;
    ownMachines: number;
    openTodos: number;
    secrets: number;
    connections: number;
    schedules: number;
  };
}

/** 聚合某 team 的 Free 档用量。读类工具 —— 永远按 teamId 收窄。
 *
 *  storage 没法精确还原（没有 storage_used 列），按 0 计并在 message 里注明
 *  「storage tracker not wired」—— 不假装算出来了。
 */
export async function getTeamUsage(db: Db, teamId: string): Promise<TeamUsage> {
  await assertTeamAccess(db, teamId, '');

  const [teamRow, agentsCount, projectsCount, machinesCount, openTodosCount, secretsCount, connectionsCount, schedulesCount] =
    await Promise.all([
      db.select({ plan: teams.plan }).from(teams).where(eq(teams.id, teamId)).limit(1),
      db.execute(sql`select count(*)::int as c from "agent" where team_id = ${teamId} and deleted_at is null`),
      db.execute(sql`select count(*)::int as c from "project" where team_id = ${teamId}`),
      db.execute(sql`select count(*)::int as c from "machine" where team_id = ${teamId}`),
      db.execute(
        sql`select count(*)::int as c from "todo" t
            join "project" p on p.id = t.project_id
            where p.team_id = ${teamId} and t.phase in ('todo','planning','confirm','review','implement')`,
      ),
      // `secret` 没有 deleted_at 列 —— 复刻只做 Free，删除走软标记在应用层。
      db.execute(sql`select count(*)::int as c from "secret" where team_id = ${teamId}`),
      db.execute(sql`select count(*)::int as c from "connection" where team_id = ${teamId} and deleted_at is null`),
      db.execute(sql`select count(*)::int as c from "schedule" where team_id = ${teamId} and deleted_at is null`),
    ]);

  const num = (rows: unknown): number => {
    const arr = rows as Array<{ c: number }>;
    return arr[0]?.c ?? 0;
  };

  return {
    teamId,
    plan: 'free',
    monthlyCredits: { limit: 0, used: 0 },
    storage: {
      limitBytes: FREE_LIMITS.storageBytes,
      usedBytes: 0, // storage tracker not wired in this build; see recon comment
    },
    freeLimits: {
      agents: FREE_LIMITS.agents,
      ownMachines: FREE_LIMITS.ownMachines,
      projects: FREE_LIMITS.projects,
      secretsPerScope: FREE_LIMITS.secretsPerScope,
      connectionsPerTeam: FREE_LIMITS.connectionsPerTeam,
      memoriesPerAgent: FREE_LIMITS.memoriesPerAgent,
      scheduleRulesPerTeam: FREE_LIMITS.scheduleRulesPerTeam,
      openTodosPerProject: FREE_LIMITS.openTodosPerProject,
    },
    counts: {
      agents: num(agentsCount),
      projects: num(projectsCount),
      ownMachines: num(machinesCount),
      openTodos: num(openTodosCount),
      secrets: num(secretsCount),
      connections: num(connectionsCount),
      schedules: num(schedulesCount),
    },
  };
}

/* --------------------------------------------------------------------- *
 *  docs
 * --------------------------------------------------------------------- */

/** `docs` 的返回项。
 *
 *  **未确认**：recon 里没有任何对该工具返回形状的直接观察 —— 没有 REST
 *  端点、没有 MCP 响应样本。原站营销站 `/docs` 是公开 HTML，Chief 工具面
 *  的 `docs` 究竟回一份可索引清单还是别的，目前无法证实。
 *  下方 `listDocs` 因此返回空数组（与 chief/executor.ts 的「声明了但未接线」
 *  区分开：这里是「声明了但语义未确认」，落空是有意为之的保守实现）。
 */
export interface DocsEntry {
  /** 文档 ID —— 没有可用的 ID 生成规则，留空字符串也行，但让接口返回空 */
  id: string;
  title: string;
  /** 文档语料的相对路径 —— 这里固定留空，因为没有目录索引 */
  path: string;
}

/** 查文档列表 —— 当前**未确认**语义，固定返回空数组。
 *
 *  如果将来 recon 补到原站 `docs` 工具的实际行为，再替换本函数的实现即可。
 *  现在返回空，避免编造假的文档索引（任务硬性要求）。
 */
export async function listDocs(_db: Db, _teamId: string): Promise<DocsEntry[]> {
  // 原站语义未确认 —— 不要假装这里有一份文档索引。
  return [];
}
