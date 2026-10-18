/**
 * Conversation（build 对话）的**唯一真源**。
 *
 * 和 `services/todos.ts` / `services/schedules.ts` 同构：纯服务层，抛 `HttpError`。
 * REST（`routes/chief.ts` 的 `GET /api/conversations/:convId/messages`）与 MCP
 * （`conversation` 工具）读的是同一批 build_message 行，必须共用同一条查询 ——
 * 一旦 MCP 侧自己写一份，就会在「增量游标」和「字段取舍」上漂移，模型读到的
 * 上下文就会和页面看到的不一致。
 *
 * 归属链：build → todo → project → team。找不到就是「不属于任何团队」，
 * 抛 403（不是 404）：向非成员泄露「这个 conversation 存在」本身就是信息。
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '@tds/db';
import { buildMessages, builds, projects, todos } from '@tds/db';
import { HttpError } from '../http.js';

/** 返回给调用方的消息形状 —— REST 与 MCP 共用，避免两处各裁一次字段。 */
export interface ConversationMessage {
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
}

/**
 * 解析 build 所属团队。build 不存在、或它链上的 todo/project 缺失，
 * 一律当「没有可访问的团队」→ 403。
 */
export async function loadConversationTeamId(db: Db, buildId: string): Promise<string> {
  const teamId = await loadConversationTeamIdOrNull(db, buildId);
  if (teamId === null) throw new HttpError(403, 'conversation has no accessible team');
  return teamId;
}

/**
 * 同上，但查不到时返 `null` 而不是抛 403（2026-10-18）。
 *
 * 给「查不到是正常状态」的场景用：Chief topic 的 `session.id` 是 **thread 的
 * 会话 id**，不是 build id。还没派工的 topic 查不到 build 行是**正常**的，
 * 不该报 403 —— 那样用户打开对话面板只会看到「数据未就绪」而不是空对话。
 *
 * ⚠️ 调用方仍必须对 `null` 之外的 teamId 做 `requireTeamMembership`；
 * 这里只放宽了「查不到」，没放宽「查到但无权限」（那条仍然是 403）。
 */
export async function loadConversationTeamIdOrNull(
  db: Db,
  buildId: string,
): Promise<string | null> {
  const row = (await db
    .select({ teamId: projects.teamId })
    .from(builds)
    .innerJoin(todos, eq(todos.id, builds.todoId))
    .innerJoin(projects, eq(projects.id, todos.projectId))
    .where(eq(builds.id, buildId))
    .limit(1))[0];
  return row?.teamId ?? null;
}

/**
 * 读某个 build 的对话，按 `seq` 升序。
 *
 * `sinceSeq` 是增量游标：原站 Chief「重复读只回增量」就是这个语义
 * （recon/docs/chief.md「repeat reads return only incremental changes」）。
 * 传了就只回 `seq > sinceSeq` 的行。
 */
export async function listConversationMessages(
  db: Db,
  buildId: string,
  sinceSeq?: number,
): Promise<ConversationMessage[]> {
  const where = sinceSeq !== undefined
    ? and(eq(buildMessages.buildId, buildId), sql`${buildMessages.seq} > ${sinceSeq}`)
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
  return rows;
}
