/**
 * `GET /api/teams/:teamId/projects` —— 列某团队的项目。
 *
 * **为什么需要这个端点**：前端新建 todo 表单要让用户从下拉框选 `projectId`，
 * 但 todo 看板只返回 todo 自带的 `projectId` / `projectName`，新建表单没有 todo
 * 可参考。已有 MCP 工具的 `case 'projects'`（`routes/mcp.ts:660`）列出过同
 * 一个集合，但 MCP 走 Bearer API key，不能被 BFF cookie 复用。所以这里再开一条
 * REST 路径，**字段集合逐字照抄 MCP 投影**（`id / teamId / name / provider /
 * repoFullName / defaultBranch / createdAt`）—— 两处漂移会让 UI 在切换数据源
 * 时静默丢字段。
 *
 * 鉴权：`actorForTeam(db, req, teamId)` 不传 `opts.action`，走「成员即可读」
 * 分支（写项目元数据是 admin，但读列表仅需成员；与 `GET /api/todos` 一致）。
 */
import type { FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@tds/db';
import { projects } from '@tds/db';
import { actorForTeam } from '../auth.js';
import { HttpError } from '../http.js';
import { createProject, updateProject } from '../services/projects-admin.js';

/** 与 `services/projects-admin.ts` 的 `CreateProjectInput` 对齐。 */
const CreateProjectBody = z.object({
  name: z.string().min(1).max(200),
  provider: z.enum(['external', 'platform']).optional(),
  repoKind: z
    .enum(['github', 'gitlab', 'gitea', 'forgejo', 'bitbucket', 'other'])
    .optional(),
  repoUrl: z.string().max(2000).nullable().optional(),
  repoFullName: z.string().max(400).nullable().optional(),
  defaultBranch: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
});

/** 仓库三件套（kind/url/fullName）不可改 —— 改了等于换仓库。 */
const UpdateProjectBody = z.object({
  name: z.string().min(1).max(200).optional(),
  defaultBranch: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
});

export function registerProjectRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/teams/:teamId/projects', async (req) => {
    const { teamId } = req.params as { teamId: string };
    // 不传 action → 仅校验「用户属于这个 team」，不做 admin 闸门。
    await actorForTeam(db, req, teamId);
    const rows = await db
      .select({
        id: projects.id,
        teamId: projects.teamId,
        name: projects.name,
        provider: projects.provider,
        repoKind: projects.repoKind,
        repoFullName: projects.repoFullName,
        repoUrl: projects.repoUrl,
        defaultBranch: projects.defaultBranch,
        description: projects.description,
        createdAt: projects.createdAt,
      })
      .from(projects)
      .where(eq(projects.teamId, teamId))
      .orderBy(projects.createdAt);
    return { projects: rows };
  });

  // ── 项目 CRUD（2026-10-17 补）────────────────────────────────────────
  //
  // 此前只有 GET 列表，于是「新建 todo」表单只能从列表里选项目，用户**无法新建项目** ——
  // 空团队第一次使用时，除了写 SQL 没有任何办法拿到一个项目，todo 都建不了。
  // `services/projects-admin.ts` 的 create/update 早就在（MCP 与 Chief 在用），这里接上 REST。
  //
  // 删除是**危险操作**（级联删掉该项目下所有 todo，见 schema 的 onDelete:cascade），
  // 所以用 HTTP DELETE 且要求 admin —— 前端必须二次确认并提示会连带删除多少 todo。

  app.get('/api/teams/:teamId/projects/:projectId', async (req) => {
    const { teamId, projectId } = req.params as { teamId: string; projectId: string };
    await actorForTeam(db, req, teamId);
    const row = (
      await db.select().from(projects)
        .where(and(eq(projects.teamId, teamId), eq(projects.id, projectId)))
        .limit(1)
    )[0];
    if (!row) throw new HttpError(404, 'project not found');
    return { project: row };
  });

  app.post('/api/teams/:teamId/projects', async (req) => {
    const { teamId } = req.params as { teamId: string };
    const parsed = CreateProjectBody.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(422, parsed.error.issues.map((i) => i.message).join('; '));
    }
    const actorId = await actorForTeam(db, req, teamId, { action: 'changing projects' });
    const project = await createProject(db, { teamId, actorId, ...parsed.data });
    return { project };
  });

  app.patch('/api/teams/:teamId/projects/:projectId', async (req) => {
    const { teamId, projectId } = req.params as { teamId: string; projectId: string };
    const parsed = UpdateProjectBody.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(422, parsed.error.issues.map((i) => i.message).join('; '));
    }
    const actorId = await actorForTeam(db, req, teamId, { action: 'changing projects' });
    const project = await updateProject(db, { teamId, projectId, actorId, patch: parsed.data });
    return { project };
  });

  app.delete('/api/teams/:teamId/projects/:projectId', async (req) => {
    const { teamId, projectId } = req.params as { teamId: string; projectId: string };
    await actorForTeam(db, req, teamId, { action: 'changing projects' });
    const row = (
      await db.select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.teamId, teamId), eq(projects.id, projectId)))
        .limit(1)
    )[0];
    if (!row) throw new HttpError(404, 'project not found');

    // 先数清楚会连带删掉多少 todo，回包给前端做确认文案（级联删不可逆）
    const doomed = await db.execute(sql`
      select count(*)::int as c from todo where project_id = ${projectId}
    `);
    const todoCount = Number(
      (doomed as unknown as Array<Record<string, unknown>>)[0]?.['c'] ?? 0,
    );

    await db.delete(projects).where(eq(projects.id, projectId));
    return { ok: true, deleted: projectId, deletedTodos: todoCount };
  });
}