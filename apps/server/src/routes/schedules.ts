import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '@tds/db';
import { HttpError } from '../http.js';
import { actorForTeam } from '../auth.js';
import {
  assertTeamExists,
  createSchedule,
  deleteSchedule,
  listSchedules,
  updateSchedule,
} from '../services/schedules.js';

/**
 * Schedule 业务 REST 路由。
 *
 * 对标 todos.dev /docs/schedules：
 *   - 4 种形态：hourly / daily / weekly / once
 *   - 所有成员可读；**写操作需 admin**（文档：reserved for owner/admin）
 *   - 每 team 规则 ≤ 10 条（FREE_LIMITS.scheduleRulesPerTeam）
 *   - 求值逻辑全部在 `schedule.ts` 里；**业务规则与持久化在 `services/schedules.ts`**，
 *     本文件只剩「参数解析 + 授权判定」（凭据在路由层才有）——MCP 侧调的是同一份服务层
 *   - automatic=false 时钉死机器，跳过条件不含 No machine online
 *     （文档钉机器 fire-and-fail 语义）
 *
 * 复用 schedule.ts：
 *   - `ScheduleKind` —— 复用，避免再硬编码 'hourly|daily|weekly|once'
 *   - `nextRunAt` —— 用它来确认 cron 表达式合法（非法就抛）
 *   - `SCHEDULE_CONSTANTS.MAX_RULES_PER_TEAM` —— 兜底硬上限（与 quota 软上限同源）
 *
 * 持久化策略：schedule 表只有 `cron` 列，没有 `weekday` 列。
 *   - hourly / daily / once：cron 直接存（与 schedule.ts expr 一致）
 *   - weekly：cron 存为 `"<dow> <HH:MM>"`（按 recon/05-schema.sql 注释：`dow HH:MM`），
 *     路由层在调用 nextRunAt 之前把它拆成 ScheduleRule.weekday + ScheduleRule.expr
 *
 * 没扩展 schedule.ts —— 求值层不变；本文件在边界做 weekly 拆分。
 */

const SCHEDULE_KIND_ZOD = z.enum(['hourly', 'daily', 'weekly', 'once']);

const CreateBody = z.object({
  todoId: z.string().min(1),
  kind: SCHEDULE_KIND_ZOD,
  /**
   * 按 kind 不同：
   *   hourly: 0-59 的整数（字符串形式）
   *   daily:  "HH:MM"
   *   weekly: "HH:MM"（weekday 字段单传）
   *   once:   ISO 时间戳
   */
  cron: z.string().min(1).max(120),
  timezone: z.string().min(1).max(80),
  /** 0=周日 … 6=周六；仅 weekly 时必填。 */
  weekday: z.number().int().min(0).max(6).optional(),
  agentId: z.string().nullable().default(null),
  /** machine 钉死后跳过 No machine online（automatic=false） */
  machineId: z.string().nullable().default(null),
  automatic: z.boolean().default(true),
  /** 调用者 userId —— 走 session 中介，MVP 阶段由调用方注入 */
  userId: z.string().min(1),
});

const UpdateBody = z.object({
  kind: SCHEDULE_KIND_ZOD.optional(),
  cron: z.string().min(1).max(120).optional(),
  timezone: z.string().min(1).max(80).optional(),
  weekday: z.number().int().min(0).max(6).optional(),
  agentId: z.string().nullable().optional(),
  machineId: z.string().nullable().optional(),
  automatic: z.boolean().optional(),
  userId: z.string().min(1),
});


export function registerScheduleRoutes(app: FastifyInstance, db: Db): void {
  // ── 列出（成员可读）───────────────────────────────────────────

  app.get('/api/teams/:teamId/schedules', async (req) => {
    const { teamId } = req.params as { teamId: string };
    await actorForTeam(db, req, teamId);

    return { schedules: await listSchedules(db, teamId) };
  });

  // ── 创建（需 admin）───────────────────────────────────────────

  app.post('/api/teams/:teamId/schedules', async (req) => {
    const { teamId } = req.params as { teamId: string };
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(422, parsed.error.issues.map((i) => i.message).join('; '));
    }
    const body = parsed.data;

    // team 是否存在**先判**，再判 admin —— 路径上的 team 不存在是 404 而不是
    // 403「你不是 admin」。这两个语义不能互换：后者会让人以为自己是 admin 但权限有问题。
    await assertTeamExists(db, teamId);
    // 归属与 admin 判定在路由层（凭据在这里）；业务规则在服务层。
    const actorId = await actorForTeam(db, req, teamId, { action: 'managing schedule rules' });
    const schedule = await createSchedule(db, {
      teamId,
      todoId: body.todoId,
      kind: body.kind,
      cron: body.cron,
      timezone: body.timezone,
      weekday: body.weekday,
      agentId: body.agentId,
      machineId: body.machineId,
      automatic: body.automatic,
      createdBy: actorId,
    });
    return { schedule };
  });

  // ── 更新（需 admin）───────────────────────────────────────────

  app.patch('/api/teams/:teamId/schedules/:scheduleId', async (req) => {
    const { teamId, scheduleId } = req.params as { teamId: string; scheduleId: string };
    const parsed = UpdateBody.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(422, parsed.error.issues.map((i) => i.message).join('; '));
    }
    const body = parsed.data;

    await actorForTeam(db, req, teamId, { action: 'managing schedule rules' });

    const schedule = await updateSchedule(db, {
      teamId,
      scheduleId,
      kind: body.kind,
      cron: body.cron,
      timezone: body.timezone,
      weekday: body.weekday,
      agentId: body.agentId,
      machineId: body.machineId,
      automatic: body.automatic,
    });
    return { schedule };
  });

  // ── 删除（需 admin，soft-delete via deleted_at）──────────────────────

  app.delete('/api/teams/:teamId/schedules/:scheduleId', async (req) => {
    const { teamId, scheduleId } = req.params as { teamId: string; scheduleId: string };
    // `?userId=` 以前是客户端随便填的；现在身份来自凭据（`actorForTeam` 内部
    // 校验显式传的 `userId` 必须等于 key 所有者）
    await actorForTeam(db, req, teamId, { action: 'managing schedule rules' });

    const deleted = await deleteSchedule(db, teamId, scheduleId);
    return { ok: true, deleted };
  });
}