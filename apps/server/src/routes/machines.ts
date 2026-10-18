/**
 * `GET /api/machines` · `PATCH /api/machines/:machineId` · `DELETE /api/machines/:machineId`
 *
 * **为什么和 `routes/machine.ts` 并存**：后者是机器**协议**端点（enroll /
 * claim / heartbeat / done / changes / tool），凭据体系完全独立
 * （API key name = `machine:<machineId>`，来自入队），不需要团队归属也不会走
 * 用户的 web 会话。这里要解决的是「人在浏览器里看不到自己有哪些机器」——
 * 必须按团队归属过滤，按 REST `resolveContext` 取身份。
 *
 * 实测：`machines` 表自身不含任何凭据列（`schema.ts:193-238`），凭据在
 * `machine_runtime_usage.account`（id/plan/email）和 `step_credential`。
 * 但为防有人往 `machines` 表加 `tunnel_secret` 之类的字段后忘了投影，
 * GET 走**显式白名单**列选择（`listColumns`），不 `select()` 全表。
 *
 * 同时把 schema 里读到但本端点**不需要**返回的字段（`hardware`、`perf`）也
 * 砍掉 —— 这两块是大体积 JSONB 字典，序列化 + JSON.parsed 跨进程划不来。
 *
 * `teamId` 缺省时按当前用户所属 team 收窄：照搬 `routes/todos.ts` 的
 * `GET /api/todos` 解析写法，不盲信 body。
 *
 * 删除是级联硬删（schema 的 `onDelete: 'cascade'` 会带走
 * `machine_runtime_usage`），响应里把这条事实写在 `note` 字段里 —— 不要做成
 * 假软删除。
 */
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@tds/db';
import { machines } from '@tds/db';
import { now } from '../ids.js';
import { publish } from '../sse.js';
import { HttpError } from '../http.js';
import {
  resolveContext,
  requireTeamMembership,
  teamIdsForUser,
} from '../auth.js';

/** GET 列表白名单字段 —— 不返回 `hardware`/`perf` 这类大体量 JSONB。 */
const LIST_COLUMNS = {
  id: machines.id,
  teamId: machines.teamId,
  name: machines.name,
  deviceId: machines.deviceId,
  enrolledBy: machines.enrolledBy,
  buildEnabled: machines.buildEnabled,
  shellEnabled: machines.shellEnabled,
  maxConcurrentTasks: machines.maxConcurrentTasks,
  cliVersion: machines.cliVersion,
  workspacesDir: machines.workspacesDir,
  runtimes: machines.runtimes,
  disabledRuntimes: machines.disabledRuntimes,
  arch: machines.arch,
  runner: machines.runner,
  platform: machines.platform,
  tailnetAddr: machines.tailnetAddr,
  tunnelError: machines.tunnelError,
  isOnline: machines.isOnline,
  lastHeartbeatAt: machines.lastHeartbeatAt,
  createdAt: machines.createdAt,
  updatedAt: machines.updatedAt,
} as const;

/** `maxConcurrentTasks` 上界原站说 1..10；我们放宽到 64 是给「多机并发测试」留余地，
 *  但仍要远小于 BIGINT 上限，避免有人写 999999999 时被悄悄截断到 0。 */
const MAX_CONCURRENT_TASKS_MAX = 64;
const MIN_CONCURRENT_TASKS = 1;

const MachineTeamIdQuery = z.object({
  teamId: z.string().optional(),
});

/**
 * PATCH body：全部 optional。`name` 是用户在 UI 看到的标签；
 * `buildEnabled` / `shellEnabled` 是配 build / shell 闸门；
 * `maxConcurrentTasks` 是并发闸门。
 *
 * `userId` 只声明、不使用：`proxyWrite` 会**无条件**往写路径 body 里注入
 * 凭据身份（apps/web/src/lib/bff-proxy.ts:143-152），而本 schema 是
 * `.strict()` —— 不声明它，浏览器每一次开关切换都会被 zod 拒成
 * `Unrecognized key(s) in object: 'userId'`。实测踩过：UI 点「接 Builds」
 * 直接报「写入被拒」。声明它只是让 strict 通过，真正判身份的是
 * `resolveContext` + `requireTeamMembership`，不读 body 里的这个值。
 */
const PatchMachineBody = z
  .object({
    userId: z.string().optional(),
    name: z.string().min(1).max(200).optional(),
    buildEnabled: z.boolean().optional(),
    shellEnabled: z.boolean().optional(),
    maxConcurrentTasks: z.number().int().min(MIN_CONCURRENT_TASKS).max(MAX_CONCURRENT_TASKS_MAX).optional(),
  })
  .strict();

/**
 * 解析 machine → teamId（schema 的 FK）。解析不到 = 机器不存在（不是 forbidden）：
 * 与 `routes/projects.ts:75-79` 的语义对齐。
 */
async function loadMachineTeamId(db: Db, machineId: string): Promise<string | null> {
  const rows = await db
    .select({ teamId: machines.teamId })
    .from(machines)
    .where(eq(machines.id, machineId))
    .limit(1);
  return rows[0]?.teamId ?? null;
}

export function registerMachineAdminRoutes(app: FastifyInstance, db: Db): void {
  // ── 列表 ────────────────────────────────────────────────────────
  app.get('/api/machines', async (req) => {
    const ctx = await resolveContext(db, req);
    const parsed = MachineTeamIdQuery.safeParse(req.query);
    if (!parsed.success) {
      return { machines: [] };
    }
    const { teamId } = parsed.data;

    let where;
    if (teamId) {
      await requireTeamMembership(db, ctx.userId, teamId);
      where = eq(machines.teamId, teamId);
    } else {
      // 不给 teamId 时按「当前用户所属 team」收窄：和 `GET /api/todos` 一致。
      const ids = await teamIdsForUser(db, ctx.userId);
      if (ids.length === 0) return { machines: [] };
      where = inArray(machines.teamId, ids);
    }

    const rows = await db
      .select(LIST_COLUMNS)
      .from(machines)
      .where(where)
      .orderBy(desc(machines.updatedAt));

    return { machines: rows };
  });

  // ── PATCH ──────────────────────────────────────────────────────
  app.patch('/api/machines/:machineId', async (req) => {
    const { machineId } = req.params as { machineId: string };
    const ctx = await resolveContext(db, req);

    const bodyParse = PatchMachineBody.safeParse(req.body);
    if (!bodyParse.success) {
      throw new HttpError(
        422,
        bodyParse.error.issues.map((i) => i.message).join('; '),
      );
    }
    if (Object.keys(bodyParse.data).length === 0) {
      throw new HttpError(422, 'no fields to update');
    }

    const teamId = await loadMachineTeamId(db, machineId);
    if (!teamId) {
      throw new HttpError(404, 'machine not found');
    }
    await requireTeamMembership(db, ctx.userId, teamId);

    const updated = await db
      .update(machines)
      .set({ ...bodyParse.data, updatedAt: now() })
      .where(eq(machines.id, machineId))
      .returning(LIST_COLUMNS);
    const row = updated[0];
    if (!row) {
      // 竞态：load 时还在，update 时没了。
      throw new HttpError(404, 'machine not found');
    }

    await publish(
      db,
      `team:${teamId}`,
      'machine_updated',
      { machineId, fields: Object.keys(bodyParse.data) },
      teamId,
    );

    return { machine: row };
  });

  // ── DELETE ────────────────────────────────────────────────────
  app.delete('/api/machines/:machineId', async (req) => {
    const { machineId } = req.params as { machineId: string };
    const ctx = await resolveContext(db, req);

    const teamId = await loadMachineTeamId(db, machineId);
    if (!teamId) {
      throw new HttpError(404, 'machine not found');
    }
    await requireTeamMembership(db, ctx.userId, teamId);

    // 直接 `where(eq(machines.id, machineId))` 已经把跨团队的访问挡在前面了
    // （requireTeamMembership 已经拒绝非本团队成员）。
    const deleted = await db
      .delete(machines)
      .where(and(eq(machines.id, machineId), eq(machines.teamId, teamId)))
      .returning({ id: machines.id });
    const row = deleted[0];
    if (!row) {
      // 已被别的请求删除 —— 不暴露任何额外信息。
      throw new HttpError(404, 'machine not found');
    }

    await publish(
      db,
      `team:${teamId}`,
      'machine_deleted',
      { machineId },
      teamId,
    );

    // **级联硬删** —— schema `machines` 的 PK 同时是 `machine_runtime_usage` 的 FK
    // 引用，关系上的 `onDelete: 'cascade'` 已自动清掉运行时刻度表。这里**不要**
    // 假装是软删除或「保留 audit」。返回 success 的同时带一个 note 说明
    // 真实发生了什么，让 BFF/UI 自己渲染给用户看。
    return {
      ok: true,
      deleted: machineId,
      note: 'machine hard-deleted; cascade removed machine_runtime_usage rows for this machine (machine_runtime_usage has no independent audit).',
    };
  });
}
