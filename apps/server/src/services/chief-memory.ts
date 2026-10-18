/**
 * Chief 工具面：memory 组（8 个 MCP 面外工具）的服务层。
 *
 * 覆盖：memories / save_memory / delete_memory / watch_todos /
 *       unwatch_todos / set_wake / clear_wake / wakes
 *
 * 与 MCP mcp-tools.ts 的写路径严格隔离 —— Chief 端不通过 MCP 走。
 * 这份是真源（routes 与 MCP 都从这里调，不许第二份）；
 * 具体执行在 chief/executor.ts 之前，由本模块提供所有数据访问。
 *
 * 数据真相（packages/db/src/schema.ts 已确认 —— 本文件不重定义表）：
 *   - 记忆：    agent_memory（按 agent_id 私有；记 content/title/scope/project_id）
 *   - 关注：    chief_thread.watchedTodos（text[]；payload 所有权在 chief_thread）
 *   - 定时唤醒：本服务自管的 `chief_wake` 表（schema 暂未提供，本模块 idempotent 建表）
 *               —— 单条 (threadId, todoId, fireAt, createdAt) 一次性；过期/被清即移除。
 *
 * 语义来源（重新声明本批的判断依据）：
 *   - memories / save_memory / delete_memory
 *       → recon/docs/memory.md：title ≤ 80、content ≤ 1200、agent 私有、
 *         凭据形态禁止、scope ∈ {team, project}、expiresAt 可选。
 *         schema.ts:132 agentMemory 列与之一致；service 复用 src/memory.ts
 *         的 validateMemory 校验，DB 层独立做 access 校验。
 *   - watch_todos / unwatch_todos
 *       → routes/chief.ts:560 (派工后写入 watchedTodos)；
 *         chief/dispatch.ts:280 (Chief 自己 watch)；本批负责手工 add/remove。
 *   - set_wake / clear_wake / wakes
 *       → recon/docs/chief.md「Timed check-ins for off-platform work. … one-shot
 *         timed check-in (up to 7 days out)」 → MAX_CHECKIN_DAYS=7（chief/prompt.ts:265）。
 *         同时被同一 topic 的多次 wake 合并（chief/watch.ts:31 dedup by topicId）；
 *         set_wake 落在未触发前可被 clear_wake 显式清除；fireAt 已过的视同已触发。
 *
 * 鉴权铁律（与既有 services 一致）：
 *   - 写路径要校验 target 资源属于传入的 teamId（build → todo → project → team /
 *     agent → team / chief_thread → chief → team）。
 *   - 不属于或 teamId 不存在 → 抛 HttpError(403)（**不**用 404，避免泄露）。
 *   - 写路径必须落 audit_event，actorType='chief' / actorId=chief 标识。
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '@tds/db';
import {
  agentMemories,
  auditEvents,
  chiefThreads,
  chiefs,
  projects,
  todos,
} from '@tds/db';
import { HttpError } from '../http.js';
import { newId, now } from '../ids.js';
import { validateMemory, type MemoryRecord } from '../memory.js';
import { CHIEF_LIMITS } from '../chief/prompt.js';

/** 7 天毫秒数 —— 与 chief/prompt.ts:CHIEF_LIMITS.MAX_CHECKIN_DAYS 锁步 */
const MAX_CHECKIN_MS = CHIEF_LIMITS.MAX_CHECKIN_DAYS * 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────
// 表自管：chief_wake 在 schema.ts 暂未提供；服务首调 ensureWakeTable() 后即可。
// CREATE TABLE IF NOT EXISTS → 多次调用安全；只有本批的写/读能写它。

let wakeTableEnsured = false;

/**
 * 幂等建表。并发首调会被 PG 自身 serialize —— 后续 NOOP。
 *
 * 必须存到 `audit_event.team_id` 同源的 `team`（text FK）—— 不存 `chief_thread`
 * 列等已有字段，是因为 wake 是「独立调度事件」不是「topic 元数据」。
 */
async function ensureWakeTable(db: Db): Promise<void> {
  if (wakeTableEnsured) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS chief_wake (
      id text PRIMARY KEY,
      team_id text NOT NULL REFERENCES "team"(id) ON DELETE CASCADE,
      chief_id text NOT NULL REFERENCES chief(id) ON DELETE CASCADE,
      thread_id text NOT NULL REFERENCES chief_thread(id) ON DELETE CASCADE,
      todo_id text REFERENCES todo(id) ON DELETE SET NULL,
      fire_at bigint NOT NULL,
      source text NOT NULL DEFAULT 'chief_set',
      created_at bigint NOT NULL,
      cleared_at bigint
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS chief_wake_team_thread_idx
    ON chief_wake(team_id, thread_id)
  `);
  wakeTableEnsured = true;
}

// ─────────────────────────────────────────────────────────────────────
// 公共返回形状

export interface MemoryEntry {
  id: string;
  agentId: string;
  scope: string;
  projectId: string | null;
  title: string;
  content: string;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface WatchEntry {
  threadId: string;
  teamId: string;
  todoId: string;
  watchedAt: number;
}

export interface WakeEntry {
  id: string;
  teamId: string;
  chiefId: string;
  threadId: string;
  todoId: string | null;
  fireAt: number;
  source: string;
  createdAt: number;
  clearedAt: number | null;
}

// ─────────────────────────────────────────────────────────────────────
// 内部：归属与权限辅助

/**
 * 取 thread 所属 teamId（thread → chief → team）。不存在 → 403（同既有
 * `routes/chief.ts:464` 措辞，**不**用 404 避免泄露存在性）。
 */
async function loadThreadTeamId(db: Db, threadId: string): Promise<string> {
  const row = (await db
    .select({ teamId: chiefs.teamId })
    .from(chiefThreads)
    .innerJoin(chiefs, eq(chiefs.id, chiefThreads.chiefId))
    .where(eq(chiefThreads.id, threadId))
    .limit(1))[0];
  if (!row) throw new HttpError(403, `thread "${threadId}" has no accessible team`);
  return row.teamId;
}

/**
 * 取 todo 所属 teamId（todo → project → team）。同上：null 时走 403。
 */
async function loadTodoTeamId(db: Db, todoId: string): Promise<string> {
  const row = (await db
    .select({ teamId: projects.teamId })
    .from(todos)
    .innerJoin(projects, eq(projects.id, todos.projectId))
    .where(eq(todos.id, todoId))
    .limit(1))[0];
  if (!row) throw new HttpError(403, `todo "${todoId}" has no accessible team`);
  return row.teamId;
}

/**
 * 取 agent 所属 teamId。schema 上 agent.team_id 直接 FK 到 teams（schema.ts）。
 */
async function loadAgentTeamId(db: Db, agentId: string): Promise<string> {
  // `db.execute` 的行类型是 `unknown`（drizzle 不从 `sql<>` 泛型推），
  // 所以这里显式收窄一次 —— 之前靠泛型断言，strict 下直接报 TS2322。
  const rows = (await db.execute(
    sql`SELECT team_id FROM agent WHERE id = ${agentId} LIMIT 1`,
  )) as unknown as Array<{ team_id: string }>;
  const row = rows[0];
  if (!row) throw new HttpError(403, `agent "${agentId}" has no accessible team`);
  return row.team_id;
}

/**
 * 校验传入的 teamId 与实际资源 teamId 一致（防止跨团队越权写）。不一致 → 403。
 */
function assertSameTeam(expected: string, actual: string, kind: string, id: string): void {
  if (expected !== actual) {
    throw new HttpError(
      403,
      `${kind} "${id}" team "${actual}" does not match this key's owner team "${expected}"`,
    );
  }
}

/**
 * 在 write path 写一条审计。type 是 snake_case 大集合名。
 *
 * `chiefId` 可为 `null`（2026-10-17）：Web UI 建的 agent 不带 chief 行
 * （`agents-admin` 不建 chief，chief 是 Chief 对话流才产生的），而记忆是
 * 按 `agent_id` 存的，chiefId 只用于审计归属。此时落 `actorType='user'` /
 * `actorId=<触发者 userId>` —— 而不是伪造一个 chief id 或让整个写路径 404。
 * 传 chiefId 时保持原约定 `'chief'` / chiefId（mcp-tools 写路径一致）。
 */
async function audit(
  db: Db,
  teamId: string,
  chiefId: string | null,
  type: string,
  payload: Record<string, unknown>,
  opts: { actingUserId?: string | null } = {},
): Promise<void> {
  await db.insert(auditEvents).values({
    teamId,
    actorType: chiefId ? 'chief' : 'user',
    actorId: chiefId ?? opts.actingUserId ?? null,
    todoId: null,
    buildId: null,
    type,
    payload,
    createdAt: now(),
  });
}

// ─────────────────────────────────────────────────────────────────────
// memories / save_memory / delete_memory
//
// 数据来源：agent_memory 表（schema.ts:132）；service 层与 src/memory.ts
// 的注入编排**严格隔离** —— 那份只做「选 + 裁 + 渲」纯函数，没有任何 DB。
// 写入前的凭据/长度/数量校验 → 复用 validateMemory；DB 访问只在这里。
//
// 鉴权：team 拥有 agent 才能对它写记忆；同 agent 的记忆按 agent 自己 key
// （upsert by title）覆盖式更新，不报错。

/** 校验 teamId 真存在；不存在/无访问 → 404（顶层 team 校验，参考 schedules.ts:225） */
async function assertTeamExists(db: Db, teamId: string): Promise<void> {
  const row = (await db.execute(sql<
    { id: string }[]
  >`SELECT id FROM team WHERE id = ${teamId} LIMIT 1`))[0];
  if (!row) throw new HttpError(404, `team "${teamId}" not found`);
}

export interface ListMemoriesInput {
  teamId: string;
  /** 限定到某个 agent —— Chief 自己给自己读写时是这个；跨 agent 调用必传 */
  agentId: string;
}

/** 读一个 agent 的全部记忆（按时间倒序）。team 校验 → 403。 */
export async function listMemories(
  db: Db,
  input: ListMemoriesInput,
): Promise<MemoryEntry[]> {
  await assertTeamExists(db, input.teamId);
  const agentTeamId = await loadAgentTeamId(db, input.agentId);
  assertSameTeam(input.teamId, agentTeamId, 'agent', input.agentId);

  const rows = await db
    .select()
    .from(agentMemories)
    .where(eq(agentMemories.agentId, input.agentId))
    .orderBy(asc(agentMemories.createdAt));
  return rows.map(toMemoryEntry);
}

export interface SaveMemoryInput {
  teamId: string;
  /**
   * 仅用于审计 actorId。Web UI 建的 agent 不带 chief 行，这里允许 null；
   * 归属判定完全不靠它（记忆按 `agent_id` 存，见 `assertSameTeam`）。
   */
  chiefId: string | null;
  /** chiefId 为 null 时审计的 actorId 用它（Web UI 写入路径由路由填真实 userId）。 */
  actingUserId?: string | null;
  agentId: string;
  title: string;
  content: string;
  scope: 'team' | 'project';
  projectId?: string | null;
  /** 改写既有条目时由 caller 提供，单纯 update；不传 = 新建或 upsert */
  memoryId?: string;
  expiresAt?: number | null;
}

/**
 * 同 key（agent_id + title）upsert。schema 上没有 UNIQUE 约束，靠
 * 这里的「先查再决定 update/insert」逻辑保证幂等 —— 并发首双写无法避免
 * 双插，但 caller 是单 Chief agent 串行调用，不是热路径，够用。
 *
 * 写入前跑 validateMemory：title ≤80 / content ≤1200 / 凭据拦截 / 条数上限
 */
export async function saveMemory(
  db: Db,
  input: SaveMemoryInput,
): Promise<MemoryEntry> {
  await assertTeamExists(db, input.teamId);
  const agentTeamId = await loadAgentTeamId(db, input.agentId);
  assertSameTeam(input.teamId, agentTeamId, 'agent', input.agentId);

  const existingCount = await countAgentMemories(db, input.agentId);
  const validation = validateMemory({
    title: input.title,
    content: input.content,
    existingCount,
  });
  if (!validation.ok) {
    throw new HttpError(422, validation.reason ?? 'memory validation failed');
  }

  const ts = now();
  const explicitMemory = input.memoryId
    ? (await db
        .select()
        .from(agentMemories)
        .where(eq(agentMemories.id, input.memoryId))
        .limit(1))[0]
    : null;
  if (input.memoryId && !explicitMemory) {
    throw new HttpError(404, `memory "${input.memoryId}" not found`);
  }
  if (explicitMemory && explicitMemory.agentId !== input.agentId) {
    throw new HttpError(
      403,
      `memory "${input.memoryId}" does not belong to agent "${input.agentId}"`,
    );
  }

  if (explicitMemory) {
    await db
      .update(agentMemories)
      .set({
        title: input.title,
        content: input.content,
        scope: input.scope,
        projectId: input.projectId ?? null,
        expiresAt: input.expiresAt ?? null,
        updatedAt: ts,
      })
      .where(eq(agentMemories.id, explicitMemory.id));
    await audit(db, input.teamId, input.chiefId, 'memory_updated', {
      memoryId: explicitMemory.id,
      agentId: input.agentId,
      title: input.title,
    }, { actingUserId: input.actingUserId });
    const fresh = (await db
      .select()
      .from(agentMemories)
      .where(eq(agentMemories.id, explicitMemory.id))
      .limit(1))[0]!;
    return toMemoryEntry(fresh);
  }

  // upsert by (agentId, title)：同 key 已存在 → 改写而不是插入
  const byKey = (await db
    .select()
    .from(agentMemories)
    .where(
      and(eq(agentMemories.agentId, input.agentId), eq(agentMemories.title, input.title)),
    )
    .limit(1))[0];
  if (byKey) {
    await db
      .update(agentMemories)
      .set({
        content: input.content,
        scope: input.scope,
        projectId: input.projectId ?? null,
        expiresAt: input.expiresAt ?? null,
        updatedAt: ts,
      })
      .where(eq(agentMemories.id, byKey.id));
    await audit(db, input.teamId, input.chiefId, 'memory_updated', {
      memoryId: byKey.id,
      agentId: input.agentId,
      title: input.title,
      reason: 'upsert_by_title',
    }, { actingUserId: input.actingUserId });
    const fresh = (await db
      .select()
      .from(agentMemories)
      .where(eq(agentMemories.id, byKey.id))
      .limit(1))[0]!;
    return toMemoryEntry(fresh);
  }

  const id = newId();
  await db.insert(agentMemories).values({
    id,
    agentId: input.agentId,
    scope: input.scope,
    projectId: input.projectId ?? null,
    title: input.title,
    content: input.content,
    expiresAt: input.expiresAt ?? null,
    createdAt: ts,
    updatedAt: ts,
  });
  await audit(db, input.teamId, input.chiefId, 'memory_created', {
    memoryId: id,
    agentId: input.agentId,
    title: input.title,
  }, { actingUserId: input.actingUserId });
  const fresh = (await db
    .select()
    .from(agentMemories)
    .where(eq(agentMemories.id, id))
    .limit(1))[0]!;
  return toMemoryEntry(fresh);
}

export interface DeleteMemoryInput {
  teamId: string;
  /** 同 SaveMemoryInput.chiefId：仅审计用，可为 null。 */
  chiefId: string | null;
  /** 同 SaveMemoryInput.actingUserId。 */
  actingUserId?: string | null;
  agentId: string;
  memoryId: string;
}

/**
 * 删一条记忆。memory 不存在 / 不在 team 内都走 403（不暴露存在性）。
 * 删完落 `memory_deleted` 审计。
 */
export async function deleteMemory(
  db: Db,
  input: DeleteMemoryInput,
): Promise<void> {
  await assertTeamExists(db, input.teamId);
  const agentTeamId = await loadAgentTeamId(db, input.agentId);
  assertSameTeam(input.teamId, agentTeamId, 'agent', input.agentId);

  const row = (await db
    .select({ id: agentMemories.id, agentId: agentMemories.agentId })
    .from(agentMemories)
    .where(eq(agentMemories.id, input.memoryId))
    .limit(1))[0];
  if (!row) {
    throw new HttpError(403, `memory "${input.memoryId}" has no accessible team`);
  }
  if (row.agentId !== input.agentId) {
    throw new HttpError(
      403,
      `memory "${input.memoryId}" does not belong to agent "${input.agentId}"`,
    );
  }
  await db.delete(agentMemories).where(eq(agentMemories.id, input.memoryId));
  await audit(db, input.teamId, input.chiefId, 'memory_deleted', {
    memoryId: input.memoryId,
    agentId: input.agentId,
  }, { actingUserId: input.actingUserId });
}

function toMemoryEntry(row: {
  id: string;
  agentId: string;
  scope: string;
  projectId: string | null;
  title: string;
  content: string;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}): MemoryEntry {
  return {
    id: row.id,
    agentId: row.agentId,
    scope: row.scope,
    projectId: row.projectId,
    title: row.title,
    content: row.content,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function countAgentMemories(db: Db, agentId: string): Promise<number> {
  const rows = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(agentMemories)
    .where(eq(agentMemories.agentId, agentId));
  return rows[0]?.c ?? 0;
}

// ─────────────────────────────────────────────────────────────────────
// watch_todos / unwatch_todos
//
// 数据来源：chief_thread.watchedTodos（text[]）。service 读加、移除、读列表。
//
// 鉴权：传入的 teamId 必须 == thread 实际所属 team；不一致 → 403。
//
// 设计说明：watchedTodos 的 server-side write path 由 routes/chief.ts:560 在派工
// 完成后自动加入；本 service 提供手工 add/remove（Chief 主动 watch 别人派的 todo）。

export interface WatchTodoInput {
  teamId: string;
  chiefId: string;
  threadId: string;
  todoId: string;
}

/** 加一个 todo 到 topic 的 watch 列表。已存在 → no-op（idempotent）。 */
export async function watchTodo(
  db: Db,
  input: WatchTodoInput,
): Promise<WatchEntry> {
  await ensureWakeTable(db); // 让首调同时建表，避免读到一半建表
  const threadTeam = await loadThreadTeamId(db, input.threadId);
  assertSameTeam(input.teamId, threadTeam, 'thread', input.threadId);
  const todoTeam = await loadTodoTeamId(db, input.todoId);
  assertSameTeam(input.teamId, todoTeam, 'todo', input.todoId);

  const row = (await db
    .select({ watchedTodos: chiefThreads.watchedTodos })
    .from(chiefThreads)
    .where(eq(chiefThreads.id, input.threadId))
    .limit(1))[0];
  if (!row) throw new HttpError(403, `thread "${input.threadId}" has no accessible team`);
  const current = row.watchedTodos;
  if (!current.includes(input.todoId)) {
    const ts = now();
    await db
      .update(chiefThreads)
      .set({ watchedTodos: [...current, input.todoId], updatedAt: ts })
      .where(eq(chiefThreads.id, input.threadId));
    await audit(db, input.teamId, input.chiefId, 'watch_added', {
      threadId: input.threadId,
      todoId: input.todoId,
    });
    return { threadId: input.threadId, teamId: input.teamId, todoId: input.todoId, watchedAt: ts };
  }
  // 已存在 → 不重复落审计；watchedAt 取 thread 的 updatedAt 当 best effort
  const fresh = (await db
    .select({ updatedAt: chiefThreads.updatedAt })
    .from(chiefThreads)
    .where(eq(chiefThreads.id, input.threadId))
    .limit(1))[0]!;
  return {
    threadId: input.threadId,
    teamId: input.teamId,
    todoId: input.todoId,
    watchedAt: fresh.updatedAt,
  };
}

export interface UnwatchTodoInput {
  teamId: string;
  chiefId: string;
  threadId: string;
  todoId: string;
}

/** 移除一个 todo 的 watch；不存在 → no-op 同样算成功，幂等。 */
export async function unwatchTodo(
  db: Db,
  input: UnwatchTodoInput,
): Promise<void> {
  await ensureWakeTable(db);
  const threadTeam = await loadThreadTeamId(db, input.threadId);
  assertSameTeam(input.teamId, threadTeam, 'thread', input.threadId);

  const row = (await db
    .select({ watchedTodos: chiefThreads.watchedTodos })
    .from(chiefThreads)
    .where(eq(chiefThreads.id, input.threadId))
    .limit(1))[0];
  if (!row) throw new HttpError(403, `thread "${input.threadId}" has no accessible team`);
  const current = row.watchedTodos;
  if (!current.includes(input.todoId)) return;
  const ts = now();
  await db
    .update(chiefThreads)
    .set({ watchedTodos: current.filter((t) => t !== input.todoId), updatedAt: ts })
    .where(eq(chiefThreads.id, input.threadId));
  await audit(db, input.teamId, input.chiefId, 'watch_removed', {
    threadId: input.threadId,
    todoId: input.todoId,
  });
}

/** 读某个 topic 的完整 watch 列表（按入列顺序）。 */
export async function listWatchedTodos(
  db: Db,
  input: { teamId: string; threadId: string },
): Promise<WatchEntry[]> {
  await ensureWakeTable(db);
  const threadTeam = await loadThreadTeamId(db, input.threadId);
  assertSameTeam(input.teamId, threadTeam, 'thread', input.threadId);
  const row = (await db
    .select({ watchedTodos: chiefThreads.watchedTodos, updatedAt: chiefThreads.updatedAt })
    .from(chiefThreads)
    .where(eq(chiefThreads.id, input.threadId))
    .limit(1))[0];
  if (!row) throw new HttpError(403, `thread "${input.threadId}" has no accessible team`);
  const ts = row.updatedAt;
  return row.watchedTodos.map((todoId) => ({
    threadId: input.threadId,
    teamId: threadTeam,
    todoId,
    watchedAt: ts,
  }));
}

// ─────────────────────────────────────────────────────────────────────
// set_wake / clear_wake / wakes
//
// 数据来源：本服务自管的 chief_wake 表。语义来自 recon/docs/chief.md
// 「Timed check-ins for off-platform work. … one-shot timed check-in
// (up to 7 days out) at the expected completion time」 +
// chief/prompt.ts:CHIEF_LIMITS.MAX_CHECKIN_DAYS=7。
//
// 「同 topic 多次合并 → 一条」(chief/watch.ts:31)：本 service 的 listWakes
// 把同一 threadId 的全部 wake 都返回；fireAt 已过 + clearedAt is null 视为仍 active。
// future fire_at 即真未来；past fire_at 也仍是「未 clear」状态 → 不在这里自动归档。

export interface SetWakeInput {
  teamId: string;
  chiefId: string;
  threadId: string;
  /** 必传——check-in 跟 todo 进度挂钩（chief/types.ts:48 CheckIn） */
  todoId: string;
  /** 目标 fire 时间（毫秒）。早于 now → 钳到 now；超过 now+7 天 → 钳到 now+7 天。 */
  fireAt: number;
  source?: string;
}

export async function setWake(db: Db, input: SetWakeInput): Promise<WakeEntry> {
  await ensureWakeTable(db);
  const threadTeam = await loadThreadTeamId(db, input.threadId);
  assertSameTeam(input.teamId, threadTeam, 'thread', input.threadId);
  const todoTeam = await loadTodoTeamId(db, input.todoId);
  assertSameTeam(input.teamId, todoTeam, 'todo', input.todoId);

  // 7 天上限钳位（chief/prompt.ts:CHIEF_LIMITS.MAX_CHECKIN_DAYS=7）
  const nowMs = now();
  const clamped = Math.min(Math.max(input.fireAt, nowMs), nowMs + MAX_CHECKIN_MS);

  // 同 threadId + todoId 同条目替换（dedup 语义，对应 chief/watch.ts:31
  // 同 topic 并发 wake 合并）。
  const existing = ((await db.execute(sql`
    SELECT id, cleared_at FROM chief_wake
    WHERE thread_id = ${input.threadId}
      AND todo_id = ${input.todoId}
    LIMIT 1
  `)) as unknown as Array<{ id: string; cleared_at: number | null }>)[0];

  if (existing) {
    await db.execute(sql`
      UPDATE chief_wake
      SET fire_at = ${clamped},
          source = ${input.source ?? 'chief_set'},
          cleared_at = NULL,
          created_at = ${nowMs}
      WHERE id = ${existing.id}
    `);
    await audit(db, input.teamId, input.chiefId, 'wake_rescheduled', {
      wakeId: existing.id,
      threadId: input.threadId,
      todoId: input.todoId,
      fireAt: clamped,
      priorClearedAt: existing.cleared_at,
    });
    return wakeEntryFromRow({
      id: existing.id,
      team_id: input.teamId,
      chief_id: input.chiefId,
      thread_id: input.threadId,
      todo_id: input.todoId,
      fire_at: clamped,
      source: input.source ?? 'chief_set',
      created_at: nowMs,
      cleared_at: null,
    });
  }

  const id = newId();
  await db.execute(sql`
    INSERT INTO chief_wake (id, team_id, chief_id, thread_id, todo_id, fire_at, source, created_at, cleared_at)
    VALUES (${id}, ${input.teamId}, ${input.chiefId}, ${input.threadId},
            ${input.todoId}, ${clamped}, ${input.source ?? 'chief_set'}, ${nowMs}, NULL)
  `);
  await audit(db, input.teamId, input.chiefId, 'wake_set', {
    wakeId: id,
    threadId: input.threadId,
    todoId: input.todoId,
    fireAt: clamped,
  });
  return wakeEntryFromRow({
    id,
    team_id: input.teamId,
    chief_id: input.chiefId,
    thread_id: input.threadId,
    todo_id: input.todoId,
    fire_at: clamped,
    source: input.source ?? 'chief_set',
    created_at: nowMs,
    cleared_at: null,
  });
}

export interface ClearWakeInput {
  teamId: string;
  chiefId: string;
  /** threadId + todoId 共同定位一条 wake。 */
  threadId: string;
  todoId: string;
}

/**
 * 显式清除。fireAt 还没到的就显式取消；已经 fire 的（理论上不该 leftover
 * 在表里，但兜底）也仍然标 cleared_at，作为审计证据。
 */
export async function clearWake(db: Db, input: ClearWakeInput): Promise<void> {
  await ensureWakeTable(db);
  const threadTeam = await loadThreadTeamId(db, input.threadId);
  assertSameTeam(input.teamId, threadTeam, 'thread', input.threadId);

  const ts = now();
  // db.execute() 直接返回行数组；UPDATE...RETURNING 在 1 行匹配时是 [{...}]，
  // 未匹配时是 []。不要 `[0]` 再 [0] —— 直接取出首行即可。
  const result = await db.execute(sql<{ id: string }>`
    UPDATE chief_wake
    SET cleared_at = ${ts}
    WHERE thread_id = ${input.threadId}
      AND todo_id = ${input.todoId}
      AND cleared_at IS NULL
    RETURNING id
  `);
  if (!result[0]) {
    throw new HttpError(404, `no active wake for thread "${input.threadId}" todo "${input.todoId}"`);
  }
  await audit(db, input.teamId, input.chiefId, 'wake_cleared', {
    wakeId: result[0].id,
    threadId: input.threadId,
    todoId: input.todoId,
  });
}

/** 列出某 team 下**尚未清除**的 wake。已 fire 的仍显示（listWakes 不过滤 past）。 */
export async function listWakes(
  db: Db,
  input: { teamId: string; threadId?: string },
): Promise<WakeEntry[]> {
  await ensureWakeTable(db);
  await assertTeamExists(db, input.teamId);
  const where = input.threadId
    ? sql`team_id = ${input.teamId} AND thread_id = ${input.threadId} AND cleared_at IS NULL`
    : sql`team_id = ${input.teamId} AND cleared_at IS NULL`;
  const rows = (await db.execute(sql`
    SELECT id, team_id, chief_id, thread_id, todo_id, fire_at, source, created_at, cleared_at
    FROM chief_wake WHERE ${where} ORDER BY fire_at ASC
  `)) as unknown as ChiefWakeRow[];
  return rows.map(wakeEntryFromRow);
}

// ─────────────────────────────────────────────────────────────────────
// row → interface 收口

interface ChiefWakeRow {
  id: string;
  team_id: string;
  chief_id: string;
  thread_id: string;
  todo_id: string | null;
  fire_at: number;
  source: string;
  created_at: number;
  cleared_at: number | null;
}

function wakeEntryFromRow(row: ChiefWakeRow): WakeEntry {
  return {
    id: row.id,
    teamId: row.team_id,
    chiefId: row.chief_id,
    threadId: row.thread_id,
    todoId: row.todo_id,
    fireAt: row.fire_at,
    source: row.source,
    createdAt: row.created_at,
    clearedAt: row.cleared_at,
  };
}

/** 给 tests/只读路径使用 —— 不被 business logic 调；保留供外部 schema 探查 */
export const __CHIEF_MEMORY_DIAGNOSTICS__ = {
  tableEnsured: () => wakeTableEnsured,
};
