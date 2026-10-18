/**
 * 团队级「资源」REST 路由：secrets 与 mcp-servers（connections）。
 *
 * **为什么这两个端点现在才补**：`services/secrets.ts` 与 `services/connections.ts`
 * 的 CRUD 早就写好了（为 MCP 工具面服务），但**只被 `routes/mcp.ts` 调用**，
 * 没有任何 REST 入口 —— 于是 Web 端无法配置凭据与连接，功能在服务层存在、
 * 用户却碰不到。本文件把同一份服务层接到 REST 上，与 Chief 的
 * `POST /api/chief/tools/:toolName` 共用实现，写阅契约与幂等语义必然一致。
 *
 * **写阅契约（两个模块都适用）**：
 *   - secret 的**值永不回传**：读接口只有 `SecretSummary`（无 `encValue`/`encNonce`）
 *   - connection 的 **config 只回键名**（`configKeys`），值永不回传
 *   这不是疏忽，是 `services/*.ts` 在类型层面就只导出 Summary 类型来保证的。
 *
 * 鉴权：读=成员，写=admin（沿用 `actorForTeam(db, req, teamId, {action})`）。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '@tds/db';
import { connections } from '@tds/db';
import { actorForTeam } from '../auth.js';
import { HttpError } from '../http.js';
import {
  deleteSecrets,
  listSecrets,
  setSecret,
} from '../services/secrets.js';
import {
  addConnection,
  deleteConnections,
  listConnections,
  updateConnection,
} from '../services/connections.js';

const SetSecretBody = z.object({
  scope: z.enum(['team', 'project']).default('team'),
  projectId: z.string().nullable().optional(),
  name: z.string().min(1),
  description: z.string().max(500).nullable().optional(),
  value: z.string(),
  /** 同名已存在时是否覆盖；不传 = 409（服务层自己判） */
  overwrite: z.boolean().optional(),
});

const DeleteSecretsBody = z.object({
  scope: z.enum(['team', 'project']).default('team'),
  projectId: z.string().nullable().optional(),
  /** 一次可删多个（文档：「at once, with no confirmation step」） */
  names: z.array(z.string().min(1)).min(1),
});

const AddConnectionBody = z.object({
  kind: z.string().optional(),
  /** 小写 slug，团队内唯一；MCP 工具名前缀就是它 */
  identifier: z.string().min(1),
  transport: z.string().min(1),
  label: z.string().min(1),
  endpoint: z.string().max(2000).nullable().optional(),
  /** 凭据（headers/env）。值只进密文，永不回显 */
  config: z.record(z.string(), z.string()).nullable().optional(),
  expiresAt: z.number().int().nullable().optional(),
});

const UpdateConnectionBody = z.object({
  label: z.string().min(1).optional(),
  /** 只覆盖出现的键；没出现的保持原值（文档：「Untouched keys survive a save」） */
  config: z.record(z.string(), z.string()).nullable().optional(),
  expiresAt: z.number().int().nullable().optional(),
});

export function registerResourceRoutes(app: FastifyInstance, db: Db): void {
  // ── secrets ────────────────────────────────────────────────────────

  // 读：成员即可。`?projectId=` 三态必须区分（服务层约定）：
  //   不传 = 全部；`projectId=`（空串→null）= 只要 team 级；给 id = 只要那个 project。
  app.get('/api/teams/:teamId/secrets', async (req) => {
    const { teamId } = req.params as { teamId: string };
    await actorForTeam(db, req, teamId);
    const q = req.query as { projectId?: string } | undefined;
    // 空串表示显式要 team 级（`?projectId=`）
    const projectId = q?.projectId === undefined ? undefined : (q.projectId || null);
    return { secrets: await listSecrets(db, teamId, projectId) };
  });

  // 写：admin（team secrets 是高影响能力，默认关闭、按需授权）
  app.post('/api/teams/:teamId/secrets', async (req) => {
    const { teamId } = req.params as { teamId: string };
    const parsed = SetSecretBody.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(422, parsed.error.issues.map((i) => i.message).join('; '));
    }
    const userId = await actorForTeam(db, req, teamId, { action: 'managing secrets' });
    const body = parsed.data;
    const secret = await setSecret(db, {
      teamId,
      scope: body.scope,
      projectId: body.projectId ?? null,
      name: body.name,
      description: body.description ?? null,
      value: body.value,
      overwrite: body.overwrite,
      createdBy: userId,
    });
    // 明文只在这一次请求里出现过（seal 之后），回包里只有 Summary
    return { secret };
  });

  app.delete('/api/teams/:teamId/secrets', async (req) => {
    const { teamId } = req.params as { teamId: string };
    const parsed = DeleteSecretsBody.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(422, parsed.error.issues.map((i) => i.message).join('; '));
    }
    const userId = await actorForTeam(db, req, teamId, { action: 'managing secrets' });
    const body = parsed.data;
    const deleted = await deleteSecrets(
      db,
      teamId,
      body.scope,
      body.projectId ?? null,
      body.names,
    );
    void userId; // 归属已判，删除本身按 team+scope+names 定位
    return { ok: true, deleted };
  });

  // ── mcp-servers / connections ──────────────────────────────────────

  app.get('/api/teams/:teamId/mcp-servers', async (req) => {
    const { teamId } = req.params as { teamId: string };
    await actorForTeam(db, req, teamId);
    return { mcpServers: await listConnections(db, teamId) };
  });

  app.post('/api/teams/:teamId/mcp-servers', async (req) => {
    const { teamId } = req.params as { teamId: string };
    const parsed = AddConnectionBody.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(422, parsed.error.issues.map((i) => i.message).join('; '));
    }
    const userId = await actorForTeam(db, req, teamId, { action: 'managing connections' });
    const body = parsed.data;
    const connection = await addConnection(db, {
      teamId,
      kind: body.kind,
      identifier: body.identifier,
      transport: body.transport,
      label: body.label,
      endpoint: body.endpoint ?? null,
      config: body.config ?? null,
      expiresAt: body.expiresAt ?? null,
      createdBy: userId,
    });
    return { mcpServer: connection };
  });

  // 路径用 identifier（与 MCP 工具 `delete_mcp_servers` 的入参一致，也是团队内唯一键），
  // 但 `updateConnection` 的 `connectionId` 实际匹配的是 **`connections.id`**
  // （services/connections.ts:218 的 where 是 `eq(connections.id, input.connectionId)`）。
  // 直接把 identifier 塞进去会 404「not found」—— 两个字段长得像但不通用，
  // 所以这里先查一次 id 再交给服务层。
  app.patch('/api/teams/:teamId/mcp-servers/:identifier', async (req) => {
    const { teamId, identifier } = req.params as { teamId: string; identifier: string };
    const parsed = UpdateConnectionBody.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(422, parsed.error.issues.map((i) => i.message).join('; '));
    }
    await actorForTeam(db, req, teamId, { action: 'managing connections' });

    const current = (
      await db
        .select({ id: connections.id })
        .from(connections)
        .where(
          and(
            eq(connections.teamId, teamId),
            eq(connections.identifier, identifier),
            isNull(connections.deletedAt),
          ),
        )
        .limit(1)
    )[0];
    // 404 = 这个团队下没有这个 identifier；与 deleteConnections 的措辞对齐
    if (!current) throw new HttpError(404, `mcp server "${identifier}" not found`);

    const body = parsed.data;
    const mcpServer = await updateConnection(db, {
      teamId,
      connectionId: current.id,
      label: body.label,
      config: body.config,
      expiresAt: body.expiresAt,
    });
    return { mcpServer };
  });

  app.delete('/api/teams/:teamId/mcp-servers/:identifier', async (req) => {
    const { teamId, identifier } = req.params as { teamId: string; identifier: string };
    await actorForTeam(db, req, teamId, { action: 'managing connections' });
    const deleted = await deleteConnections(db, teamId, [identifier]);
    return { ok: true, deleted };
  });
}
