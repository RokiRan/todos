/**
 * Todo 验收清单 REST 路由。
 *
 * **为什么现在补**：`todo.with_checklist` 字段与 `checklist_item` 表都早就有
 * （`packages/db/src/schema.ts:387`），但**没有任何端点读写它** —— 于是
 * `POST /api/todos` 的 `withChecklist` 参数设成 true 也只是一句空承诺：
 * agent 被告知「这个 todo 带验收清单」，用户却既看不到、也加不了。
 * 这是「字段存在但链路断开」的一类缺口，症状比缺端点更隐蔽。
 *
 * 契约：清单项按 `seq` 排序；勾选状态由 agent 与人共同维护（谁都能勾）。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '@tds/db';
import { checklistItems } from '@tds/db';
import { resolveContext } from '../auth.js';
import { HttpError } from '../http.js';
import { newId, now } from '../ids.js';
import { loadTodoTeamId } from '../services/todos.js';
import { requireTeamMembership } from '../auth.js';

const CreateItemBody = z.object({
  text: z.string().min(1).max(500),
  /** 追加到末尾；不给则按当前条数追加 */
  seq: z.number().int().min(0).optional(),
});

const ToggleBody = z.object({ done: z.boolean() });

export function registerChecklistRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/todos/:todoId/checklist', async (req) => {
    const { todoId } = req.params as { todoId: string };
    const ctx = await resolveContext(db, req);
    const teamId = await loadTodoTeamId(db, todoId);
    if (!teamId) throw new HttpError(404, 'todo not found');
    await requireTeamMembership(db, ctx.userId, teamId);

    const rows = await db
      .select()
      .from(checklistItems)
      .where(eq(checklistItems.todoId, todoId))
      // seq 后再按 id：并发追加可能撞同一个 seq（见 POST 里的说明）
      .orderBy(checklistItems.seq, checklistItems.id);
    return { checklist: rows };
  });

  app.post('/api/todos/:todoId/checklist', async (req) => {
    const { todoId } = req.params as { todoId: string };
    const ctx = await resolveContext(db, req);
    const parsed = CreateItemBody.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(422, parsed.error.issues.map((i) => i.message).join('; '));
    }
    const teamId = await loadTodoTeamId(db, todoId);
    if (!teamId) throw new HttpError(404, 'todo not found');
    await requireTeamMembership(db, ctx.userId, teamId);

    // 不给 seq 时追加到末尾：查当前最大 seq + 1。
    // 用 sql`max(...)` 而不是 orderBy(desc).limit(1) —— 后者在没有任何行时也拿不到
    // 「没有行」这个信息，只能靠 seq 是否为 null 判断，绕。
    // 并发下可能撞号（两个请求同时读到同一个 max）；checklist 是低并发场景，
    // 撞号只会让两条同序，显示顺序由 id 兜底（orderBy seq, id）。
    let seq = parsed.data.seq;
    if (seq === undefined) {
      const maxRow = await db
        .select({ max: sql<number | null>`max(${checklistItems.seq})` })
        .from(checklistItems)
        .where(eq(checklistItems.todoId, todoId));
      seq = (maxRow[0]?.max ?? -1) + 1;
    }

    const row = {
      id: newId(),
      todoId,
      text: parsed.data.text,
      done: false,
      seq,
      createdAt: now(),
    };
    await db.insert(checklistItems).values(row);
    return { item: row };
  });

  // 勾选/取消：人机共用，所以是 PATCH 而不是 POST（幂等：重复提交同一状态无副作用）
  app.patch('/api/todos/:todoId/checklist/:itemId', async (req) => {
    const { todoId, itemId } = req.params as { todoId: string; itemId: string };
    const ctx = await resolveContext(db, req);
    const parsed = ToggleBody.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(422, 'done must be a boolean');
    }
    const teamId = await loadTodoTeamId(db, todoId);
    if (!teamId) throw new HttpError(404, 'todo not found');
    await requireTeamMembership(db, ctx.userId, teamId);

    // item 必须属于这个 todo —— 否则能拿 A 的 todoId 去改 B 的清单项
    const current = (
      await db
        .select()
        .from(checklistItems)
        .where(
          and(eq(checklistItems.id, itemId), eq(checklistItems.todoId, todoId)),
        )
        .limit(1)
    )[0];
    if (!current) throw new HttpError(404, 'checklist item not found');

    await db
      .update(checklistItems)
      .set({ done: parsed.data.done })
      .where(eq(checklistItems.id, itemId));
    return { item: { ...current, done: parsed.data.done } };
  });

  app.delete('/api/todos/:todoId/checklist/:itemId', async (req) => {
    const { todoId, itemId } = req.params as { todoId: string; itemId: string };
    const ctx = await resolveContext(db, req);
    const teamId = await loadTodoTeamId(db, todoId);
    if (!teamId) throw new HttpError(404, 'todo not found');
    await requireTeamMembership(db, ctx.userId, teamId);

    const current = (
      await db
        .select({ id: checklistItems.id })
        .from(checklistItems)
        .where(
          and(eq(checklistItems.id, itemId), eq(checklistItems.todoId, todoId)),
        )
        .limit(1)
    )[0];
    if (!current) throw new HttpError(404, 'checklist item not found');

    await db.delete(checklistItems).where(eq(checklistItems.id, itemId));
    return { ok: true, deleted: itemId };
  });
}
