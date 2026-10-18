import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@tds/db';
import { builds, documents, members, projects, todos } from '@tds/db';
import { HttpError } from '../http.js';
import { requireTeamMembership, resolveContext, teamIdsForUser } from '../auth.js';

/**
 * 「Needs you」路由 —— 当前用户**待决**的全部 todo 一站式列表。
 *
 * 权威定义（`recon-live/docs-chief.md:16`，2026-10-18 实抓）：
 * > "The board's four columns. From left to right: **Backlog, In progress,
 * >  **Needs you, Done**. Needs you gathers **everything waiting on your
 * >  decision**: plans to confirm, changes to accept, failed runs, and
 * >  research or question tasks that have replied or asked a question."
 *
 * 五类来源（按 docs-chief.md 措辞拆）：
 *   1. **Plan ready**（`phase = 'confirm'`）—— 计划待批准
 *   2. **Changes ready**（`phase = 'review'`）—— 改动待接受
 *   3. **Failed runs**（`phase = 'failed'`）—— 失败任务需决定重跑/继续
 *   4. **Agent 提问**（任意 phase，且 build 下存在 `kind='question'` 文档）
 *   5. **Agent 回复**（research/question 任务的回复；**当前没实现**，理由见下）
 *
 * **schema 边界**：
 *   - `doc_kind` 枚举里有 `question`（`schema.ts:24-27`），所以**第 4 类**可实现。
 *   - **第 5 类**「research 任务有回复」在 schema 里没有对应标记 —— 没有
 *     `doc_kind = 'answer' / 'research' / 'reply'`，也没有 todo 表上的
 *     `is_research` 之类。**当前端点不会为第 5 类返回结果**；汇报里说明
 *     「schema 不支持，留作未来」。
 *   - 服务层目前也没有写入 `kind='question'` 文档的路径（plan / changes 由
 *     服务层写，question 是预留位）。所以第 4 类在复刻运行时同样为空；
 *     SQL 是为将来 question 写入留的，**不**为这条造一份假 question 文档。
 *
 * **owner 判定**（`recon-live/docs-inbox.md`）：
 * > "Task notifications go to the todo's owner, which is always a human team
 * >  member."
 * → `todos.owner_member_id` 必须能解析回当前 user。即仅当
 *   `member.member_type = 'user'` 且 `member.actor_id = userId` 时计入。
 *
 * **不写闸门铁律的代码**：这里只查「谁待决」，不写任何 phase 转移；闸门
 *   推进仍然走 `/api/todos/:id/approve` 与 `/api/todos/:id/complete`，
 *   failed 走 `/api/todos/:id/rerun` 或 `/api/todos/:id/reopen`。本文件存在
 *   的全部理由是「可查的当前待决集合」。
 */

export type NeedsYouGate = 'confirm' | 'review';

export interface NeedsYouItem {
  todoId: string;
  seqNum: number;
  title: string;
  phase: string;
  /** `confirm` / `review` / `null`（闸门外的待决项没有这个字段） */
  gate: NeedsYouGate | null;
  /**
   * 视觉分组键：'confirm' | 'review' | 'failed' | 'awaiting-reply'。
   * 闸门单独有自己的 key；闸门外的 `failed` 与 `awaiting-reply`（有
   * question 文档但不在闸门）也是「待你决」的来源，page.tsx 按此分组渲染。
   */
  kind: 'confirm' | 'review' | 'failed' | 'awaiting-reply';
  /** 一句话理由：闸门名 / 失败原因 / 文档提示 */
  reason: string;
  updatedAt: number;
}

export interface NeedsYouResponse {
  items: NeedsYouItem[];
  count: number;
}

export function registerNeedsYouRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/needs-you', async (req): Promise<NeedsYouResponse> => {
    const ctx = await resolveContext(db, req);

    const q = zParseQuery(req.query);
    let teamIds: string[];
    if (q.teamId !== undefined) {
      await requireTeamMembership(db, ctx.userId, q.teamId);
      teamIds = [q.teamId];
    } else {
      teamIds = await teamIdsForUser(db, ctx.userId);
      if (teamIds.length === 0) {
        return { items: [], count: 0 };
      }
    }

    // ── 1) 闸门内 todo（confirm / review） ──────────────────────────
    // 单条 INNER JOIN 把 owner 关联一并拉回：
    //   member.id = todo.owner_member_id
    //   member.team_id = project.team_id
    //   member.member_type = 'user'
    //   member.actor_id = 当前 user.id
    // 任一不等都把行剔掉 —— 与 `routes/mcp.ts:531-541` 同源（ownerMemberId
    // 合法性判定的另一份引用）。
    const gateRows = await db
      .select({
        todoId: todos.id,
        seqNum: todos.seqNum,
        title: todos.title,
        phase: todos.phase,
        updatedAt: todos.updatedAt,
      })
      .from(todos)
      .innerJoin(projects, eq(projects.id, todos.projectId))
      .innerJoin(
        members,
        and(
          eq(members.id, todos.ownerMemberId),
          eq(members.teamId, projects.teamId),
          eq(members.memberType, 'user'),
          eq(members.actorId, ctx.userId),
        ),
      )
      .where(
        and(
          inArray(projects.teamId, teamIds),
          inArray(todos.phase, ['confirm', 'review']),
        ),
      )
      .orderBy(desc(todos.updatedAt));

    const gateItems: NeedsYouItem[] = gateRows.map((r) => ({
      todoId: r.todoId,
      seqNum: r.seqNum,
      title: r.title,
      phase: r.phase,
      gate: r.phase === 'confirm' || r.phase === 'review' ? r.phase : null,
      kind: r.phase === 'confirm' ? 'confirm' : 'review',
      reason: r.phase === 'confirm' ? '闸门 · 计划确认' : '闸门 · 变更确认',
      updatedAt: r.updatedAt,
    }));

    // ── 2) failed 的 todo（闸门外的「待你决」） ─────────────────────
    // 闸门铁律：failed 不是闸门，不能用 approve / complete 推进。
    // 路径：`/api/todos/:id/rerun`（→ todo）或 `/api/todos/:id/reopen`（→ review）。
    // 这里只把它们列出来，不替用户选。
    const failedRows = await db
      .select({
        todoId: todos.id,
        seqNum: todos.seqNum,
        title: todos.title,
        phase: todos.phase,
        updatedAt: todos.updatedAt,
      })
      .from(todos)
      .innerJoin(projects, eq(projects.id, todos.projectId))
      .innerJoin(
        members,
        and(
          eq(members.id, todos.ownerMemberId),
          eq(members.teamId, projects.teamId),
          eq(members.memberType, 'user'),
          eq(members.actorId, ctx.userId),
        ),
      )
      .where(
        and(
          inArray(projects.teamId, teamIds),
          eq(todos.phase, 'failed'),
        ),
      )
      .orderBy(desc(todos.updatedAt));

    const failedItems: NeedsYouItem[] = failedRows.map((r) => ({
      todoId: r.todoId,
      seqNum: r.seqNum,
      title: r.title,
      phase: r.phase,
      gate: null,
      kind: 'failed',
      reason: '运行失败 · 待决定重跑',
      updatedAt: r.updatedAt,
    }));

    // ── 3) 等回复（agent 提问，phase ∈ {todo/queued/planning/implement/
    //     reviewing}，且 build 下存在 kind='question' 文档） ─────────
    // 三个 INNER JOIN：
    //   todos ─ projects (团队归属)
    //   todos ─ members (owner 是当前 user)
    //   todos ─ builds ─ documents(kind='question')
    // 用子查询 + EXISTS 风格避免一份 question 文档被算多次
    // （distinct 不必要 —— exists 子查询不会膨胀）。
    //
    // ⚠️ 文件头注释提过：服务层当前不写 question 文档，所以这条 SELECT
    // 现在永远空。本路由不为这条造假数据 —— schema 在那，问题在于谁写入。
    const questionTodoIds = db
      .select({ id: todos.id })
      .from(todos)
      .innerJoin(projects, eq(projects.id, todos.projectId))
      .innerJoin(
        members,
        and(
          eq(members.id, todos.ownerMemberId),
          eq(members.teamId, projects.teamId),
          eq(members.memberType, 'user'),
          eq(members.actorId, ctx.userId),
        ),
      )
      .innerJoin(builds, eq(builds.todoId, todos.id))
      .innerJoin(
        documents,
        and(eq(documents.buildId, builds.id), eq(documents.kind, 'question')),
      )
      .where(
        and(
          inArray(projects.teamId, teamIds),
          // 闸门/failed 已归到 gateItems / failedItems；这里只取
          // 仍然在跑的 phase（settled `done`/`closed` 也不在 Needs you）。
          sql`${todos.phase} not in ('confirm','review','failed','done','closed')`,
        ),
      )
      .as('qt');

    const questionRows = await db
      .select({
        todoId: todos.id,
        seqNum: todos.seqNum,
        title: todos.title,
        phase: todos.phase,
        updatedAt: todos.updatedAt,
      })
      .from(todos)
      .innerJoin(questionTodoIds, eq(questionTodoIds.id, todos.id))
      .orderBy(desc(todos.updatedAt));

    const questionItems: NeedsYouItem[] = questionRows.map((r) => ({
      todoId: r.todoId,
      seqNum: r.seqNum,
      title: r.title,
      phase: r.phase,
      gate: null,
      kind: 'awaiting-reply',
      reason: '等待回复',
      updatedAt: r.updatedAt,
    }));

    // 合并 + 排序：updatedAt desc（闸门、failed、question 三组各自已
    // 按这个顺序排过；混合后整体重排一次比依赖数据库顺序稳）。
    const items = [...gateItems, ...failedItems, ...questionItems];
    items.sort((a, b) => b.updatedAt - a.updatedAt);

    return { items, count: items.length };
  });
}

// ── 小工具：query 解析（不引 zod —— 单字段，没必要）───────────────

interface NeedsYouQuery {
  teamId?: string;
}

function zParseQuery(raw: unknown): NeedsYouQuery {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object') {
    throw new HttpError(422, 'query must be an object');
  }
  const obj = raw as Record<string, unknown>;
  if (obj['teamId'] === undefined) return {};
  if (typeof obj['teamId'] !== 'string' || obj['teamId'].length === 0) {
    throw new HttpError(422, 'teamId must be a non-empty string');
  }
  return { teamId: obj['teamId'] };
}