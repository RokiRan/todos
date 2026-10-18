import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '@tds/db';
import { buildMessages, builds } from '@tds/db';
import { HttpError } from '../http.js';
import { requireTeamMembership, resolveContext } from '../auth.js';
import {
  loadConversationTeamId,
  type ConversationMessage,
} from '../services/conversations.js';
import { now } from '../ids.js';

/**
 * Build 对话（messages）REST —— `/api/builds/:buildId/messages`。
 *
 * 范围：
 *   - GET    /api/builds/:buildId/messages?since=<seq>
 *   - POST   /api/builds/:buildId/messages             （steering 队列 / 直接落库）
 *   - PATCH  /api/builds/:buildId/messages/:messageId  （编辑未投递队列项）
 *   - DELETE /api/builds/:buildId/messages/:messageId  （撤回未投递队列项）
 *
 * 鉴权（按 buildId 推出 team，与 conversations 同源）：
 *   1. resolveContext(db, req)             —— 401/凭据错
 *   2. loadConversationTeamId(db, buildId) —— 找不到 / 不可达 都 403（不泄露存在性）
 *   3. requireTeamMembership               —— 403（非本团队）
 *
 * 真实 build 不存在 → 404；消息流空 vs build 不存在，客户端必须能分辨。
 *
 * 关键设计决定 —— steering 队列用**进程内 Map**：
 *   - `build_message` 表有强语义（`role='user'` 会被 Chief / MCP 等读出来
 *     当真实对话上下文喂给 agent），**未投递**的用户消息塞进去会污染 agent
 *     的上下文输入（recon-live/GAP-ANALYSIS.md 与 docs-conversation.md 都强调过）。
 *   - `step` 表是机器任务凭证，与「待投递的用户消息」语义不匹配。
 *   - 共享 schema（`packages/db/src/schema.ts`）由 Main 统一维护，本切片不
 *     改动；新建队列表相当于改 schema，与协作契约冲突。
 *   - 报告里会写清「进程内 Map 的局限」并给出建议表结构。
 *
 * 真实「正在跑」判定（per assignment）：
 *   用 `builds.finishedAt IS NULL`（schema.ts:342 `finishedAt bigint`）。
 *   query 走 `isNull(builds.finishedAt)`，**不**做 todo 侧相位推导 —— 服务的
 *   唯一真源是 build 行本身的结算状态。build 不存在直接 404。
 *
 * SSE 实证：
 *   publish 调用 type 字面量全集（grep 全仓）：
 *     'dispatched' / 'step_update' / 'phase_changed' / 'todo_updated'
 *     / 'todo_deleted'
 *   scope 字面量：
 *     'todo:<id>' / 'team:<id>' / '<buildId>'（machine 实时帧走 buildId）
 *   **没有消息级事件**。前端兜底：4s setInterval 轮询 `?since=<lastSeq>`，
 *   配合 banner 诚实说明「实时推送端到端事件尚未接通，当前用增量轮询」。
 */

const PostBody = z.object({
  content: z.string().min(1).max(8000),
  mentions: z
    .array(
      z.object({
        kind: z.enum(['agent', 'member', 'todo', 'skill', 'project', 'machine']),
        id: z.string(),
        label: z.string(),
      }),
    )
    .default([]),
});

const PatchBody = z.object({
  content: z.string().min(1).max(8000),
});

interface QueueItem {
  id: string;
  buildId: string;
  content: string;
  position: number;
  createdAt: number;
  status: 'pending' | 'delivered';
  mentions: Array<{ kind: string; id: string; label: string }>;
}

interface BuildQueueState {
  /** 自增位置号（per build，从 1 起）。重启清 0。 */
  nextPosition: number;
  /** 队列项 —— 投递前可在 /PATCH 改 /DELETE 撤回；投递后转交消息流后清。 */
  items: Map<string, QueueItem>;
}

const queueState = new Map<string, BuildQueueState>();

function getQueue(buildId: string): BuildQueueState {
  let s = queueState.get(buildId);
  if (!s) {
    s = { nextPosition: 1, items: new Map() };
    queueState.set(buildId, s);
  }
  return s;
}

/**
 * 取某个 build 的「可见队列」 —— 已投递的不再返回（已落进 `build_message`）。
 * 排序按 position 升序，与原站「按投递顺序编号」一致。
 *
 * 重要（per Main 约定 #2）：
 *   Map 的 key 只带 `buildId`。当 todo 被级联删除（FK ON DELETE CASCADE 把
 *   `build → build_message` 清掉）时，进程内 Map 里的项会残留。
 *   处理：对**当前路由调用** —— 先查库确认 build 还存在；不存在则**清空整
 *   个 build 的队列**（Map.delete）并返回 []，避免给客户端返回已死对象的
 *   队列状态。返回前再做一次过滤作为防御性 belt-and-suspenders。
 */
async function snapshotQueue(db: Db, buildId: string): Promise<QueueItem[]> {
  const exists = (
    await db
      .select({ id: builds.id })
      .from(builds)
      .where(eq(builds.id, buildId))
      .limit(1)
  )[0];
  if (!exists) {
    queueState.delete(buildId);
    return [];
  }
  const s = queueState.get(buildId);
  if (!s) return [];
  return [...s.items.values()]
    .filter((i) => i.buildId === buildId)
    .sort((a, b) => a.position - b.position);
}

function newQueueId(): string {
  // 24 字符 base64url —— 与 `apps/server/src/ids.ts` 的 `newId()` 同风格。
  return 'q_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** 把 build message 行压成 conversations 模块同形状 —— 真实字段集合对齐 schema。 */
function shapeMessage(row: {
  id: string;
  buildId: string;
  role: string;
  phase: string | null;
  triggerBy: string | null;
  content: string;
  agent: unknown;
  isError: boolean;
  durationMs: number | null;
  seq: number;
  createdAt: number;
}): ConversationMessage {
  return {
    id: row.id,
    buildId: row.buildId,
    role: row.role,
    phase: row.phase,
    triggerBy: row.triggerBy,
    content: row.content,
    agent: row.agent as Record<string, unknown> | null,
    isError: row.isError,
    durationMs: row.durationMs,
    seq: row.seq,
    createdAt: row.createdAt,
  };
}

/**
 * 取 build 的真实结算状态。
 * `finishedAt IS NULL` ⇒ 仍在跑（让 POST 进队列）。
 * `finishedAt != NULL` ⇒ 结算（POST 直接落 `build_message`，不进队列）。
 */
async function isBuildRunning(db: Db, buildId: string): Promise<boolean> {
  const row = (
    await db
      .select({ finishedAt: builds.finishedAt })
      .from(builds)
      .where(eq(builds.id, buildId))
      .limit(1)
  )[0];
  if (!row) throw new HttpError(404, 'build not found');
  return row.finishedAt === null;
}

/**
 * PATCH/DELETE 共用的查找语义（见两个 handler 内联）：先查 build_message 表
 * 确认不是已落库历史消息（→ 409），再查进程内 Map（→ 404）。这两个守门
 * 鉴权链在 caller 已经跑完：resolveContext + loadConversationTeamId +
 * requireTeamMembership —— Map 是唯一不经数据库的路径，但「能不能动它」
 * 的判权全程没有省。Per Main 约定 #1。
 */

export function registerBuildMessageRoutes(app: FastifyInstance, db: Db): void {
  // ── GET /api/builds/:buildId/messages ───────────────────────────
  app.get(
    '/api/builds/:buildId/messages',
    async (
      req,
      reply,
    ): Promise<{ messages: ConversationMessage[]; queued?: QueueItem[] }> => {
      const { buildId } = req.params as { buildId: string };
      const ctx = await resolveContext(db, req);
      const teamId = await loadConversationTeamId(db, buildId);
      await requireTeamMembership(db, ctx.userId, teamId);

      const rawSince = (req.query as { since?: string | string[] }).since;
      const sinceNum =
        typeof rawSince === 'string' && rawSince.length > 0 && !Number.isNaN(Number(rawSince))
          ? Number(rawSince)
          : undefined;

      const where =
        sinceNum !== undefined
          ? and(eq(buildMessages.buildId, buildId), sql`${buildMessages.seq} > ${sinceNum}`)
          : eq(buildMessages.buildId, buildId);

      const rows = await db
        .select({
          id: buildMessages.id,
          buildId: buildMessages.buildId,
          role: buildMessages.role,
          phase: buildMessages.phase,
          triggerBy: buildMessages.triggerBy,
          content: buildMessages.content,
          agent: buildMessages.agent,
          isError: buildMessages.isError,
          durationMs: buildMessages.durationMs,
          seq: buildMessages.seq,
          createdAt: buildMessages.createdAt,
        })
        .from(buildMessages)
        .where(where)
        .orderBy(asc(buildMessages.seq));

      // 关键约束（Main 强调，必须文件级注释）：
      //   `queued` 字段**不**进入 `messages` 数组，**不**进入 agent 上下文。
      //   进程内 Map 自成体系，services/conversations.ts 的 `listConversationMessages`
      //   只查 `build_message` 表，所以 list 给 MCP / Chief 的对话流里自然没有这
      //   些项。这是设计强制：未来加表/加 merge 逻辑的人必须知道——
      //   把它们丢进 build_message 会污染 agent 的输入（agent 会把未投递的
      //   用户消息当已交付上下文读），而把它们合成进 messages 数组会在 UI 上
      //   让用户看到「一份消息在 tray 里 + 又一份在消息流里」的双份显示。
      const queued = await snapshotQueue(db, buildId);
      // 必须在 headers 已发之前设置 status 与 headers。
      reply.header('cache-control', 'no-store');
      return {
        messages: rows.map(shapeMessage),
        ...(queued.length > 0 ? { queued } : {}),
      };
    },
  );

  // ── POST /api/builds/:buildId/messages ──────────────────────────
  app.post(
    '/api/builds/:buildId/messages',
    async (
      req,
      reply,
    ): Promise<{
      ok: true;
      queued: boolean;
      queueId?: string;
      position?: number;
      message?: ConversationMessage;
    }> => {
      const { buildId } = req.params as { buildId: string };
      const ctx = await resolveContext(db, req);

      // zod 校验失败 → 422（措辞对齐 `parseBody` 风格，与 `services/todos` 同源）。
      let body: z.infer<typeof PostBody>;
      try {
        body = PostBody.parse(req.body ?? {});
      } catch (err) {
        const msg = err instanceof z.ZodError ? err.issues.map((i) => i.message).join('; ') : 'invalid body';
        throw new HttpError(422, msg);
      }

      const teamId = await loadConversationTeamId(db, buildId);
      await requireTeamMembership(db, ctx.userId, teamId);

      const running = await isBuildRunning(db, buildId);

      if (running) {
        // steering 队列 —— 进程内 Map（见文件头设计决定）。
        const queue = getQueue(buildId);
        const item: QueueItem = {
          id: newQueueId(),
          buildId,
          content: body.content,
          position: queue.nextPosition++,
          createdAt: now(),
          status: 'pending',
          mentions: body.mentions,
        };
        queue.items.set(item.id, item);
        reply.header('cache-control', 'no-store');
        return {
          ok: true,
          queued: true,
          queueId: item.id,
          position: item.position,
        };
      }

      // build 已结算 —— 直接落 `build_message`（`role='user'`）。
      // seq 取当前 build 最大 seq + 1；与 `checklist.ts` 的同款并发容忍
      // （低并发 + id 兜底排序）。
      const maxRow = await db
        .select({ max: sql<number | null>`max(${buildMessages.seq})` })
        .from(buildMessages)
        .where(eq(buildMessages.buildId, buildId));
      const seq = (maxRow[0]?.max ?? -1) + 1;

      // mentions 也以 envelope 形式落到 content，避免污染 schema。
      // agent 看到这个 envelope 时就知道「这是一条带 mention 的用户消息」，
      // 不会当普通 plain text 处理。
      const envelope = { content: body.content, mentions: body.mentions };
      const row = {
        id: 'm_' + Math.random().toString(36).slice(2) + Date.now().toString(36),
        buildId,
        role: 'user',
        phase: null,
        triggerBy: ctx.userId,
        content: JSON.stringify(envelope),
        agent: null,
        isError: false,
        durationMs: null,
        seq,
        createdAt: now(),
      };
      await db.insert(buildMessages).values(row);
      reply.header('cache-control', 'no-store');
      return { ok: true, queued: false, message: shapeMessage(row) };
    },
  );

  // ── PATCH /api/builds/:buildId/messages/:queueId ────────────────
  // queueId 与已投递消息 id 不在同一命名空间（q_ 前缀 vs m_ 前缀）。
  app.patch(
    '/api/builds/:buildId/messages/:messageId',
    async (
      req,
      reply,
    ): Promise<{ ok: true; item: QueueItem }> => {
      const { buildId, messageId } = req.params as { buildId: string; messageId: string };
      const ctx = await resolveContext(db, req);
      const teamId = await loadConversationTeamId(db, buildId);
      await requireTeamMembership(db, ctx.userId, teamId);

      // 已落 `build_message` 的消息 id 不允许改（语义：历史消息不可改）。
      const persisted = (
        await db
          .select({ id: buildMessages.id })
          .from(buildMessages)
          .where(
            and(
              eq(buildMessages.id, messageId),
              eq(buildMessages.buildId, buildId),
            ),
          )
          .limit(1)
      )[0];
      if (persisted) {
        throw new HttpError(409, 'message already delivered; cannot edit history');
      }

      // 找 build 的队列 —— Map 按 buildId 隔离，若 build 已被 FK cascade 删
      // 除（同 per Main 约定 #2），`snapshotQueue` 会在读时清掉；这里若 Map
      // 里压根没有 build 的入口则说明队列本来就是空，「找不到这条」即 404。
      let queue = queueState.get(buildId);
      if (!queue) {
        queue = { nextPosition: 1, items: new Map() };
        queueState.set(buildId, queue);
      }
      const item = queue.items.get(messageId);
      if (!item || item.status !== 'pending') {
        throw new HttpError(
          item ? 409 : 404,
          item ? `queue item status is ${item.status}; cannot edit` : 'queue item not found',
        );
      }

      let body: z.infer<typeof PatchBody>;
      try {
        body = PatchBody.parse(req.body ?? {});
      } catch (err) {
        const msg = err instanceof z.ZodError ? err.issues.map((i) => i.message).join('; ') : 'invalid body';
        throw new HttpError(422, msg);
      }

      item.content = body.content;
      reply.header('cache-control', 'no-store');
      return { ok: true, item };
    },
  );

  // ── DELETE /api/builds/:buildId/messages/:messageId ──────────────
  app.delete(
    '/api/builds/:buildId/messages/:messageId',
    async (
      req,
      reply,
    ): Promise<{ ok: true; retracted: true; queueId: string }> => {
      const { buildId, messageId } = req.params as { buildId: string; messageId: string };
      const ctx = await resolveContext(db, req);
      const teamId = await loadConversationTeamId(db, buildId);
      await requireTeamMembership(db, ctx.userId, teamId);

      // 与 PATCH 同样的「历史不可变」守门。
      const persisted = (
        await db
          .select({ id: buildMessages.id })
          .from(buildMessages)
          .where(
            and(
              eq(buildMessages.id, messageId),
              eq(buildMessages.buildId, buildId),
            ),
          )
          .limit(1)
      )[0];
      if (persisted) {
        throw new HttpError(409, 'message already delivered; cannot retract history');
      }

      const queue = queueState.get(buildId);
      const item = queue?.items.get(messageId);
      if (!item) throw new HttpError(404, 'queue item not found');
      if (item.status !== 'pending') {
        throw new HttpError(409, `queue item status is ${item.status}; cannot retract`);
      }

      queue!.items.delete(messageId);
      reply.header('cache-control', 'no-store');
      return { ok: true, retracted: true, queueId: messageId };
    },
  );
}
