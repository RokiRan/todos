/**
 * Agent 名册 REST 路由。
 *
 * **为什么现在补**：`services/agents-admin.ts` 的完整 CRUD 早就在（MCP 与 Chief
 * 工具面在用），但同样**只有 MCP 侧调用**，没有 REST 入口 —— 于是原站最核心的
 * 「agent 是团队成员、每支有名字/模型/职责/权限/记忆」在 Web 上完全无法配置。
 * 本文件把同一份服务层接到 REST，业务规则与写阅契约必然与 MCP 侧一致。
 *
 * 读=成员，写=admin（`agents.md`：「Changes require a team admin」）。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '@tds/db';
import { agents } from '@tds/db';
import { actorForTeam } from '../auth.js';
import { HttpError } from '../http.js';
import {
  createAgent,
  deleteAgents,
  updateAgent,
  type AgentSummary,
} from '../services/agents-admin.js';

function toSummary(row: typeof agents.$inferSelect): AgentSummary {
  return {
    id: row.id,
    teamId: row.teamId,
    displayName: row.displayName,
    description: row.description,
    provider: row.provider,
    modelId: row.modelId,
    thinkingLevel: row.thinkingLevel,
    defaultSkillIds: row.defaultSkillIds,
    grants: row.grants,
    activeTaskCount: row.activeTaskCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

const CreateBody = z.object({
  displayName: z.string().min(1).max(200),
  description: z.string().max(800).nullable().optional(),
  provider: z.string().nullable().optional(),
  modelId: z.string().nullable().optional(),
  thinkingLevel: z.string().nullable().optional(),
  defaultSkillIds: z.array(z.string()).max(10).optional(),
  grants: z.record(z.string(), z.boolean()).optional(),
});

/** 显式 `null` = 清空；不传 = 不动（与 `UpdateAgentPatch` 语义一致）。 */
const UpdateBody = z.object({
  displayName: z.string().min(1).max(200).optional(),
  description: z.string().max(800).nullable().optional(),
  provider: z.string().nullable().optional(),
  modelId: z.string().nullable().optional(),
  thinkingLevel: z.string().nullable().optional(),
  defaultSkillIds: z.array(z.string()).max(10).optional(),
  grants: z.record(z.string(), z.boolean()).optional(),
});

export function registerAgentAdminRoutes(app: FastifyInstance, db: Db): void {
  // 列表：成员可读。默认滤掉软删；`?includeDeleted=1` 才带上（agents.md 无此参数，
  // 但 Web 端需要「已删除」占位而不是列表突然少一项）
  app.get('/api/teams/:teamId/agents', async (req) => {
    const { teamId } = req.params as { teamId: string };
    await actorForTeam(db, req, teamId);
    const q = req.query as { includeDeleted?: string } | undefined;
    const rows = await db
      .select()
      .from(agents)
      .where(
        q?.includeDeleted === '1'
          ? eq(agents.teamId, teamId)
          : and(eq(agents.teamId, teamId), isNull(agents.deletedAt)),
      )
      .orderBy(agents.createdAt);
    return { agents: rows.map(toSummary) };
  });

  app.get('/api/teams/:teamId/agents/:agentId', async (req) => {
    const { teamId, agentId } = req.params as { teamId: string; agentId: string };
    await actorForTeam(db, req, teamId);
    const row = (
      await db
        .select()
        .from(agents)
        .where(and(eq(agents.teamId, teamId), eq(agents.id, agentId)))
        .limit(1)
    )[0];
    if (!row) throw new HttpError(404, 'agent not found');
    return { agent: toSummary(row) };
  });

  app.post('/api/teams/:teamId/agents', async (req) => {
    const { teamId } = req.params as { teamId: string };
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(422, parsed.error.issues.map((i) => i.message).join('; '));
    }
    const actorId = await actorForTeam(db, req, teamId, { action: 'changing agents' });
    const body = parsed.data;
    const agent = await createAgent(db, {
      teamId,
      actorId,
      displayName: body.displayName,
      description: body.description ?? null,
      provider: body.provider ?? null,
      modelId: body.modelId ?? null,
      thinkingLevel: body.thinkingLevel ?? null,
      defaultSkillIds: body.defaultSkillIds ?? [],
      grants: body.grants ?? {},
    });
    return { agent };
  });

  app.patch('/api/teams/:teamId/agents/:agentId', async (req) => {
    const { teamId, agentId } = req.params as { teamId: string; agentId: string };
    const parsed = UpdateBody.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(422, parsed.error.issues.map((i) => i.message).join('; '));
    }
    const actorId = await actorForTeam(db, req, teamId, { action: 'changing agents' });
    const agent = await updateAgent(db, {
      teamId,
      agentId,
      actorId,
      patch: parsed.data,
    });
    return { agent };
  });

  // 删除是不可逆的（agents.md）。服务层是**批量**语义（与 MCP 的 `delete_agents` 一致），
  // 这里单条删除也走它，拿到 results 数组而不是裸布尔 —— 前端能显示「哪支没删掉、为什么」。
  app.delete('/api/teams/:teamId/agents/:agentId', async (req) => {
    const { teamId, agentId } = req.params as { teamId: string; agentId: string };
    const actorId = await actorForTeam(db, req, teamId, { action: 'changing agents' });
    const out = await deleteAgents(db, { teamId, agentIds: [agentId], actorId });
    const first = out.results[0];
    if (first && !first.ok) {
      // 服务层用 200 + results 表达「部分失败」（MCP 语义）；REST 需要明确状态码
      throw new HttpError(409, first.reason ?? 'agent not deleted');
    }
    return { ok: true, deleted: agentId, results: out.results };
  });

  // agent 正在处理的 todo（agents.md：「the todos it is currently working on」）
  // agentId 存在 todo.agent_id 上，且只有非终态的才算「正在处理」。
  app.get('/api/teams/:teamId/agents/:agentId/todos', async (req) => {
    const { teamId, agentId } = req.params as { teamId: string; agentId: string };
    await actorForTeam(db, req, teamId);
    const agent = (
      await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.teamId, teamId), eq(agents.id, agentId)))
        .limit(1)
    )[0];
    if (!agent) throw new HttpError(404, 'agent not found');

    const rows = await db.execute(sql`
      select t.id, t.phase, t.title, t.seq_num, t.project_id
      from todo t
      join project p on p.id = t.project_id
      where p.team_id = ${teamId}
        and t.agent_id = ${agentId}
        and t.phase not in ('done', 'closed', 'failed')
      order by t.seq_num
    `);
    return { todos: (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
      id: r['id'],
      phase: r['phase'],
      title: r['title'],
      seqNum: r['seq_num'],
      projectId: r['project_id'],
    })) };
  });
}
