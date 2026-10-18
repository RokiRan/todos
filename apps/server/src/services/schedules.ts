/**
 * Schedule 业务的**唯一真源**（读 + 写）。
 *
 * 为什么要抽出来：REST 路由（`routes/schedules.ts`）和 MCP 工具
 * （`routes/mcp.ts` 的 `schedules` / `schedule_todo` / `unschedule_todo`）
 * 都能读写 schedule —— 两者必须走同一套 cron 校验、容量上限与跨团队闸门。
 * 各写一份的后果很具体：MCP 侧忘了容量校验就能绕过 Free 档的 10 条上限；
 * 两侧的 weekly cron 拆法漂移会让同一个规则在两个入口表现不同。
 *
 * 与 `services/todos.ts` 同构：纯服务层，不认 HTTP、不认 JSON-RPC，
 * 抛 `HttpError`，由调用方翻译成 4xx 或 MCP 的 `isError`。
 *
 * 授权不在这里：调用方（REST 路由 / MCP）先各自判「这个 key 能不能碰这个团队」，
 * 再调本模块。这里只管业务规则 —— 与 `services/todos.ts` 同一分工。
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { quota } from '@tds/protocol';
import type { Db } from '@tds/db';
import { agents, machines, projects, schedules, todos } from '@tds/db';
import { HttpError } from '../http.js';
import { newId, now } from '../ids.js';
import { nextRunAt, SCHEDULE_CONSTANTS, type ScheduleKind } from '../schedule.js';

export type SchedulePublic = {
  id: string;
  teamId: string;
  todoId: string;
  kind: string;
  cron: string;
  weekday: number | null;
  timezone: string;
  agentId: string | null;
  machineId: string | null;
  automatic: boolean;
  lastFiredAt: number | null;
  lastOutcome: string | null;
  createdBy: string;
  createdAt: number;
};

/** 创建定时规则的入参（`kind` 保持字符串，由 `assertValidCron` 逐形态校验）。 */
export interface CreateScheduleInput {
  teamId: string;
  todoId: string;
  kind: string;
  cron: string;
  timezone: string;
  weekday?: number;
  agentId?: string | null;
  machineId?: string | null;
  automatic?: boolean;
  /** `created_by` 必须是真实 user id —— 调用方（REST / MCP）从凭据解析出它。 */
  createdBy: string;
}

/** 校验 timezone —— 真试构造 Intl.DateTimeFormat，最稳。 */
function assertValidTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new HttpError(422, `invalid timezone: ${tz}`);
  }
}

/** 把 weekly 的 cron (HH:MM) + weekday 拼成持久化形式 "<dow> <HH:MM>" */
function encodeWeeklyCron(weekday: number, hhmm: string): string {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `${names[weekday]} ${hhmm}`;
}

/** 反解持久化 cron：weekly 返回 { weekday, expr: HH:MM }；否则返回 null。 */
function decodeWeeklyCron(cron: string): { weekday: number; expr: string } | null {
  const names: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const m = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(\d{1,2}:\d{2})$/.exec(cron.trim());
  if (!m) return null;
  return { weekday: names[m[1]!]!, expr: m[2]! };
}

/**
 * 构造一个用于 nextRunAt 探测的 ScheduleRule。
 *
 * 用户视角的 cronField（按 kind）：
 *   hourly → "0-59"
 *   daily  → "HH:MM"
 *   weekly → "HH:MM" + 单独的 weekday 字段
 *   once   → ISO
 *
 * weekly 在这里把 weekday 还原为 ScheduleRule.weekday；持久化层会再加 dow 前缀。
 * 探测的 timezone 用用户的 timezone 而不是 UTC，因为 parseHHMM 跨时区偏移
 * 不影响解析结果，但 zonedParts 读「挂钟时间」时区可能影响 weekly 的 weekday 命中
 * —— 用用户时区更贴近真实行为。
 */
function buildRuleForEval(
  kind: ScheduleKind,
  cronField: string,
  timezone: string,
  weekdayHint: number | undefined,
): {
  kind: ScheduleKind;
  weekday: number;
  expr: string;
  timezone: string;
} {
  if (kind === 'weekly') {
    if (weekdayHint === undefined) {
      // 走到这里说明上游漏了 weekday 校验 —— 兜底取 0 让 nextRunAt 抛
      return { kind, weekday: 0, expr: cronField, timezone };
    }
    return { kind, weekday: weekdayHint, expr: cronField.trim(), timezone };
  }
  return { kind, weekday: 0, expr: cronField, timezone };
}

/**
 * 校验 cron / expr。
 *
 * 不重写 parseHHMM —— 直接复用 schedule.ts 的 nextRunAt 探针：
 *   - hourly: 内部 `Number(expr)`，但 schedule.ts 不卡 0-59，所以这里显式卡
 *   - daily/weekly: 内部 `parseHHMM`，格式错直接 throw
 *   - once: 内部 `Date.parse(expr)`，NaN throw
 */
export function assertValidCron(args: {
  kind: ScheduleKind;
  /** 用户视角的 cron 文本（weekly 下是 "HH:MM"，不是持久化的 "<dow> HH:MM"） */
  cronField: string;
  timezone: string;
  weekdayHint?: number;       // 仅 weekly 在创建/更新时提供
}): void {
  if (args.kind === 'hourly') {
    const n = Number(args.cronField.trim());
    if (!Number.isInteger(n) || n < 0 || n > 59) {
      throw new HttpError(422, 'hourly cron must be an integer 0-59');
    }
  }
  if (args.kind === 'once') {
    const ts = Date.parse(args.cronField);
    if (Number.isNaN(ts)) {
      throw new HttpError(422, 'once cron must be a valid ISO timestamp');
    }
    if (ts <= now()) {
      throw new HttpError(422, 'once cron must be in the future');
    }
  }
  if (args.kind === 'weekly') {
    // 用户入参：cronField 应是 "HH:MM" + weekday 字段；持久化时再 encodeWeeklyCron
    if (!/^(\d{1,2}):(\d{2})$/.test(args.cronField.trim())) {
      throw new HttpError(422, 'weekly cron must be HH:MM');
    }
    if (args.weekdayHint === undefined) {
      throw new HttpError(422, 'weekly requires weekday (0-6)');
    }
  }
  // 试着求下一次预定时间 —— 触发 parseHHMM/Date.parse 的内层 throw。
  // schedule.ts 通过 duck-typed `expr` 字段读 cron 文本（不在 ScheduleRule 接口里），
  // 所以这里也必须挂上，否则 `ruleTimeExpr(rule)` 会拿到 undefined → .trim() 崩。
  // 用用户的 timezone 探测，贴近真实行为。
  const probe = buildRuleForEval(args.kind, args.cronField, args.timezone, args.weekdayHint);
  try {
    nextRunAt(
      {
        id: 'probe',
        teamId: 'probe',
        todoId: 'probe',
        kind: probe.kind,
        weekday: probe.weekday,
        timezone: probe.timezone,
        automatic: true,
        lastFiredAt: null,
        expr: probe.expr,
      },
      Date.now() - 1,
    );
  } catch (err) {
    throw new HttpError(422, `invalid cron expression: ${(err as Error).message}`);
  }
}

/** 校验 agent / machine 属于该 team（若指定）。 */
async function assertAgentMachineBelong(
  db: Db,
  teamId: string,
  agentId: string | null,
  machineId: string | null,
): Promise<void> {
  if (agentId) {
    const row = (await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.teamId, teamId)))
      .limit(1))[0];
    if (!row) throw new HttpError(422, 'agent not in team');
  }
  if (machineId) {
    const row = (await db
      .select({ id: machines.id })
      .from(machines)
      .where(and(eq(machines.id, machineId), eq(machines.teamId, teamId)))
      .limit(1))[0];
    if (!row) throw new HttpError(422, 'machine not in team');
  }
}

/**
 * 校验 todo 存在并属于该 team —— todo 表只挂 project，team 通过 project 间接拿。
 * 不存在 → 422；跨 team → 409（与 todo/project 跨团队判定的拒绝一致）。
 */
export async function assertTodoInTeam(
  db: Db,
  teamId: string,
  todoId: string,
): Promise<void> {
  const row = (await db
    .select({ teamId: projects.teamId })
    .from(todos)
    .innerJoin(projects, eq(projects.id, todos.projectId))
    .where(eq(todos.id, todoId))
    .limit(1))[0];
  if (!row) throw new HttpError(422, 'todoId not found');
  if (row.teamId !== teamId) {
    throw new HttpError(409, 'todo does not belong to this team');
  }
}

/** 校验 team 存在 —— 不存在 → 404。 */
export async function assertTeamExists(db: Db, teamId: string): Promise<void> {
  const row = (await db
    .select({ id: sql<string>`team.id` })
    .from(sql`team`)
    .where(sql`team.id = ${teamId}`)
    .limit(1))[0];
  if (!row) throw new HttpError(404, 'team not found');
}

/**
 * 把 weekly 的 cron 拆出 weekday，附加到响应里。
 * 客户端可据此判断 UI 控件（其它形态 weekday 不展示）。
 */
export function publicSchedule(row: typeof schedules.$inferSelect): SchedulePublic {
  let weekday: number | null = null;
  if (row.kind === 'weekly') {
    weekday = decodeWeeklyCron(row.cron)?.weekday ?? null;
  }
  return {
    id: row.id,
    teamId: row.teamId,
    todoId: row.todoId,
    kind: row.kind,
    cron: row.kind === 'weekly' ? decodeWeeklyCron(row.cron)?.expr ?? row.cron : row.cron,
    weekday,
    timezone: row.timezone,
    agentId: row.agentId,
    machineId: row.machineId,
    automatic: row.automatic,
    lastFiredAt: row.lastFiredAt,
    lastOutcome: row.lastOutcome,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

/** 准备持久化 cron —— 把 weekly 的 weekday 前缀拼进去。 */
function persistCron(kind: ScheduleKind, cronExpr: string, weekday: number | undefined): string {
  if (kind === 'weekly') {
    if (weekday === undefined) {
      throw new HttpError(422, 'weekly requires weekday (0-6)');
    }
    return encodeWeeklyCron(weekday, cronExpr.trim());
  }
  return cronExpr;
}

/** 该团队当前的有效规则数（soft-delete 过的不算）。 */
async function countActive(db: Db, teamId: string): Promise<number> {
  const row = (await db
    .select({ c: sql<number>`count(*)::int` })
    .from(schedules)
    .where(and(eq(schedules.teamId, teamId), isNull(schedules.deletedAt))))[0];
  return row?.c ?? 0;
}

/** 列出该团队的全部有效规则。调用方先判过团队归属。 */
export async function listSchedules(db: Db, teamId: string): Promise<SchedulePublic[]> {
  const rows = await db
    .select()
    .from(schedules)
    .where(and(eq(schedules.teamId, teamId), isNull(schedules.deletedAt)))
    .orderBy(schedules.createdAt);
  return rows.map(publicSchedule);
}

/**
 * 建一条定时规则。
 *
 * 顺序是刻意的：先 `assertTeamExists`（404），再做业务校验（422/409）——
 * 调用方（REST / MCP）各自在调用**之前**判团队归属与 admin 角色，所以这里的
 * 422/409 都是「参数或引用不对」，不是「你没权限」。
 */
export async function createSchedule(
  db: Db,
  input: CreateScheduleInput,
): Promise<SchedulePublic> {
  await assertTeamExists(db, input.teamId);

  const kind = input.kind as ScheduleKind;
  assertValidTimezone(input.timezone);
  assertValidCron({
    kind,
    cronField: input.cron,
    timezone: input.timezone,
    weekdayHint: input.weekday,
  });
  await assertTodoInTeam(db, input.teamId, input.todoId);
  await assertAgentMachineBelong(db, input.teamId, input.agentId ?? null, input.machineId ?? null);

  // 容量校验：每 team ≤ 10 条
  const current = await countActive(db, input.teamId);
  const limitCheck = quota.schedules(current);
  if (!limitCheck.ok) {
    // 双保险：quota 与 SCHEDULE_CONSTANTS.MAX_RULES_PER_TEAM 数字一致，但
    // schedule.ts 已经把这个常量作为文档约定暴露，万一两边漂移时由这里兜底。
    if (current >= SCHEDULE_CONSTANTS.MAX_RULES_PER_TEAM) {
      throw new HttpError(422, `schedule limit reached (${SCHEDULE_CONSTANTS.MAX_RULES_PER_TEAM} per team)`);
    }
    throw new HttpError(422, limitCheck.message);
  }

  const ts = now();
  const id = newId();
  const storedCron = persistCron(kind, input.cron, input.weekday);
  await db.insert(schedules).values({
    id,
    teamId: input.teamId,
    todoId: input.todoId,
    kind: input.kind,
    cron: storedCron,
    timezone: input.timezone,
    agentId: input.agentId ?? null,
    machineId: input.machineId ?? null,
    automatic: input.automatic ?? true,
    lastFiredAt: null,
    lastOutcome: null,
    createdBy: input.createdBy,
    createdAt: ts,
    deletedAt: null,
  });

  const row = (await db
    .select()
    .from(schedules)
    .where(eq(schedules.id, id))
    .limit(1))[0];
  if (!row) throw new HttpError(500, 'schedule insert did not persist');
  return publicSchedule(row);
}

/** PATCH 的部分字段（全是可选；不传的字段保持原值）。 */
export interface UpdateScheduleInput {
  teamId: string;
  scheduleId: string;
  kind?: string;
  cron?: string;
  timezone?: string;
  weekday?: number;
  agentId?: string | null;
  machineId?: string | null;
  automatic?: boolean;
}

/**
 * 改一条规则。规则不存在或不属于该团队 → 404。
 *
 * weekly 的 cron 在库里存的是 `<dow> <HH:MM>`，而入参是 `HH:MM` + `weekday`
 * 两个字段 —— 拆合必须与创建路径同源，所以读旧值和拼新值都在这里做。
 */
export async function updateSchedule(
  db: Db,
  input: UpdateScheduleInput,
): Promise<SchedulePublic> {
  const current = (await db
    .select()
    .from(schedules)
    .where(and(eq(schedules.id, input.scheduleId), eq(schedules.teamId, input.teamId), isNull(schedules.deletedAt)))
    .limit(1))[0];
  if (!current) throw new HttpError(404, 'schedule not found');

  const nextKind = (input.kind ?? current.kind) as ScheduleKind;
  // 用户视角的 cron：weekly 时是 "HH:MM"，其它形态是 cronField 原文
  const userCron = input.cron ?? (
    current.kind === 'weekly' ? decodeWeeklyCron(current.cron)?.expr ?? current.cron : current.cron
  );
  const nextWeekday = input.weekday ?? (
    current.kind === 'weekly' ? decodeWeeklyCron(current.cron)?.weekday : undefined
  );

  if (input.timezone !== undefined) assertValidTimezone(input.timezone);
  if (input.cron !== undefined || input.kind !== undefined || input.weekday !== undefined) {
    assertValidCron({
      kind: nextKind,
      cronField: userCron,
      timezone: input.timezone ?? current.timezone,
      weekdayHint: nextKind === 'weekly' ? nextWeekday : undefined,
    });
  }

  if (input.agentId !== undefined || input.machineId !== undefined) {
    await assertAgentMachineBelong(
      db,
      input.teamId,
      input.agentId !== undefined ? input.agentId : current.agentId,
      input.machineId !== undefined ? input.machineId : current.machineId,
    );
  }

  const patch: Partial<typeof schedules.$inferInsert> = {};
  if (input.kind !== undefined) patch.kind = input.kind;
  if (input.timezone !== undefined) patch.timezone = input.timezone;
  if (input.agentId !== undefined) patch.agentId = input.agentId;
  if (input.machineId !== undefined) patch.machineId = input.machineId;
  if (input.automatic !== undefined) patch.automatic = input.automatic;
  // cron 总是按 kind + weekday + 用户 cron 重写 —— weekly 的 weekday 拼进前缀
  if (input.cron !== undefined || input.kind !== undefined || input.weekday !== undefined) {
    patch.cron = persistCron(nextKind, userCron, nextKind === 'weekly' ? nextWeekday : undefined);
  }

  await db.update(schedules).set(patch).where(eq(schedules.id, input.scheduleId));

  const row = (await db
    .select()
    .from(schedules)
    .where(eq(schedules.id, input.scheduleId))
    .limit(1))[0];
  if (!row) throw new HttpError(404, 'schedule not found');
  return publicSchedule(row);
}

/** 删一条规则（soft-delete）。不属于该团队或已删 → 404。 */
export async function deleteSchedule(
  db: Db,
  teamId: string,
  scheduleId: string,
): Promise<string> {
  const current = (await db
    .select({ id: schedules.id })
    .from(schedules)
    .where(and(eq(schedules.id, scheduleId), eq(schedules.teamId, teamId), isNull(schedules.deletedAt)))
    .limit(1))[0];
  if (!current) throw new HttpError(404, 'schedule not found');

  await db
    .update(schedules)
    .set({ deletedAt: now() })
    .where(eq(schedules.id, scheduleId));
  return scheduleId;
}
