/**
 * Agent memory REST 路由。
 *
 * **为什么现在补**：服务层 `services/chief-memory.ts` 的完整 CRUD/watches/wakes
 * 早就有了（MCP 与 Chief 工具面在用），但 Web 端从来没有 REST 入口，导致
 * `/agents/[agentId]` 的 Memory tab 只能渲染「记忆功能尚未提供 UI」。
 *
 * 这份路由**不是**第二份业务实现 —— 写读都走服务层（mcp-tools 也是同一份），
 * 只负责：路径形状、鉴权、zod 校验、错误状态码。同服务层铁律：
 *   - 写路径要校验 target 资源属于传入的 teamId（service 会 assertSameTeam）。
 *   - 不属于 / teamId 不存在 → 403 / 404（service 自己处理）。
 *   - 写路径必须落 audit_event（service 自己落 —— actorType='chief'）。
 *
 * 鉴权落点（关键）：
 *   - 先 `resolveContext` 把凭据转成 userId；401 不在这里抛（preHandler 已抛）。
 *   - 再 `requireTeamMembership`：userId 不属于该 team → 403，且我们在这之前
 *     **不再调任何 DB** —— 防止 timing oracle 泄露资源是否存在。
 *   - 验证该 agent 真在团队内（按 agent.team_id = teamId 取） → 不是就 404。
 *   - 然后**查 chief 行**（agent 必有 chief —— schema 上 chief.agent_id 强 FK
 *     到 agent，agent 行在 evidence 范围内不会有 chief=null）→ 把 `chiefId` 透给
 *     服务层。服务层 audit_event 的 actorType='chief' / actorId=chiefId
 *     （mcp-tools 的审计约定）。
 *
 * 状态机/相位：本切片不接触 `state-machine.ts`，纯 CRUD。
 */
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '@tds/db';
import { agents, chiefs } from '@tds/db';
import { HttpError } from '../http.js';
import { requireTeamMembership, resolveContext } from '../auth.js';
import {
  deleteMemory,
  listMemories,
  saveMemory,
  type MemoryEntry,
} from '../services/chief-memory.js';

/**
 * 服务层 SaveMemoryInput 的 zod 形态 —— **不直接复用**：
 *   - chiefId 不收客户端（路由自己查）
 *   - expiresAt 用 bigint 毫秒；前端填 0 / null 即「不设」
 */
const SaveBody = z.object({
  title: z.string().min(1).max(80),
  content: z.string().min(1).max(1200),
  scope: z.enum(['team', 'project']),
  /** project scope 时必传；team scope 时忽略（服务层会落 null） */
  projectId: z.string().min(1).nullable().optional(),
  /** 编辑既有条目；不传 = upsert by (agentId, title) */
  memoryId: z.string().min(1).optional(),
  /** null/0 = 不设；正毫秒 = 到点停止注入 */
  expiresAt: z.number().int().positive().nullable().optional(),
});

function parseBody<T extends z.ZodTypeAny>(
  schema: T,
  payload: unknown,
): z.infer<T> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new HttpError(
      422,
      parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
    );
  }
  return parsed.data;
}

/**
 * 三件前置：(1) 验凭据 → userId；(2) 团队归属 → 403；(3) agent 属于该 team →
 * 查 chiefId。任何失败都用 4xx，但**先 team，后 agent**：teammembership 抛在前，
 * 既不让一个非成员凭 status code 区分「team 存在 / 不存在」也不让 timing 泄露。
 *
 * 返回 `{ chiefId }` 给 handler；找不到 chief 时按服务层惯例返 404 不暴露存在性
 * —— 一个刚建出来的 agent 还没触发任何 Chief 调用就不该有 chief，但**那条路径
 * 不在 Web UI 出现的范围里**（agent 名册由 user 创建、Chief 自动绑），所以现实
 * 跑不到。这里返回 404 给前端诚实提示「agent 尚未接入 Chief」。
 */
async function resolveAgentInTeam(
  db: Db,
  req: { ctx?: unknown; headers: { authorization?: string; cookie?: string }; query?: unknown },
  teamId: string,
  agentId: string,
): Promise<{ userId: string; chiefId: string | null }> {
  const ctx = await resolveContext(db, req as never);
  // 先团队归属：非成员直接 403，业务资源还没被摸到
  await requireTeamMembership(db, ctx.userId, teamId);

  // 再 agent 归属：team_id = teamId AND id = agentId AND not soft-deleted
  const agentRow = (
    await db
      .select({ id: agents.id, teamId: agents.teamId })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.teamId, teamId)))
      .limit(1)
  )[0];
  if (!agentRow) {
    // 不暴露存在性 —— 跨团队的 agent 与不存在的 agent 都走 404
    throw new HttpError(404, `agent "${agentId}" not found in team "${teamId}"`);
  }

  // agent 行在团队内 → 尝试反查它的 chief，拿来做审计的 actorId。
  //
  // **没有 chief 也必须放行**（2026-10-17 修）：原先这里 404，理由是
  // 「agent 必然带一条 chief」。实测证伪 —— 通过 Web UI 建的 agent
  // （`agents-admin` 服务层）**不建 chief 行**，而 chief 是 Chief 对话
  // 那条流上才产生的。后果是：用户在自己建的 agent 上打开 Memory tab，
  // GET 直接 404，UI 显示「记忆数据未就绪（endpoint-not-implemented）」，
  // 而端点其实完全正常。
  //
  // 放宽是安全的：记忆按 `agent_id` 存（`agent_memories.agent_id`），
  // chiefId 只进 audit 的 actorId（见 services/chief-memory.ts 的
  // `audit(...)` 调用），不参与任何归属判定。归属判定仍然只有上面两步
  // —— resolveContext + requireTeamMembership + agent.team_id。
  // 没有 chief 时传 null，审计落 actorType='user' / actorId=真实 userId。
  const chiefRow = (
    await db
      .select({ id: chiefs.id })
      .from(chiefs)
      .where(and(eq(chiefs.teamId, teamId), eq(chiefs.agentId, agentId)))
      .limit(1)
  )[0];
  return { userId: ctx.userId, chiefId: chiefRow?.id ?? null };
}

export function registerAgentMemoryRoutes(app: FastifyInstance, db: Db): void {
  /**
   * GET /api/teams/:teamId/agents/:agentId/memories
   * 读全部记忆（按 createdAt 升序，与服务层一致）。
   * 返回 `{memories: MemoryEntry[]}`；空时 `{memories:[]}` 而不是 404。
   */
  app.get(
    '/api/teams/:teamId/agents/:agentId/memories',
    async (req): Promise<{ memories: MemoryEntry[] }> => {
      const { teamId, agentId } = req.params as { teamId: string; agentId: string };
      await resolveAgentInTeam(db, req, teamId, agentId);
      const memories = await listMemories(db, { teamId, agentId });
      return { memories };
    },
  );

  /**
   * POST /api/teams/:teamId/agents/:agentId/memories
   * 创建 / 改写 / 按 title upsert。body 见 SaveBody；返回 `{memory: MemoryEntry}`。
   * 422 由 parseBody 抛；403 / 404 由 resolveAgentInTeam 或服务层抛。
   *
   * 不收 userId：BFF 没让浏览器传 userId（cookie 注入），但服务层要的是 chiefId——
   * 二者不同对象。**chiefId 从 agent 反查**，不是从客户端读，也**不**从 cookie 推
   * （cookie 里只有 userId，没有 chiefId）。后端写审计时落 actorType='chief' /
   * actorId=chiefId（与 mcp-tools 约定一致）。
   */
  app.post(
    '/api/teams/:teamId/agents/:agentId/memories',
    async (req): Promise<{ memory: MemoryEntry }> => {
      const { teamId, agentId } = req.params as { teamId: string; agentId: string };
      const { chiefId, userId } = await resolveAgentInTeam(db, req, teamId, agentId);
      const body = parseBody(SaveBody, req.body);
      const memory = await saveMemory(db, {
        teamId,
        chiefId,
        // 审计兜底：agent 没有 chief 行时，actorId 落真实操作者
        actingUserId: userId,
        agentId,
        title: body.title,
        content: body.content,
        scope: body.scope,
        projectId: body.projectId ?? null,
        memoryId: body.memoryId,
        expiresAt: body.expiresAt ?? null,
      });
      return { memory };
    },
  );

  /**
   * DELETE /api/teams/:teamId/agents/:agentId/memories/:memoryId
   * 删一条记忆；不存在或跨 agent → 403（service 内部判），不让前端感知存在性。
   * 返回 `{ok:true, deleted: memoryId}`。
   */
  app.delete(
    '/api/teams/:teamId/agents/:agentId/memories/:memoryId',
    async (req): Promise<{ ok: true; deleted: string }> => {
      const { teamId, agentId, memoryId } = req.params as {
        teamId: string;
        agentId: string;
        memoryId: string;
      };
      const { chiefId, userId } = await resolveAgentInTeam(db, req, teamId, agentId);
      await deleteMemory(db, { teamId, chiefId, actingUserId: userId, agentId, memoryId });
      return { ok: true, deleted: memoryId };
    },
  );
}
