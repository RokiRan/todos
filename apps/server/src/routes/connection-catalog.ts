/**
 * `GET /api/teams/:teamId/connection-catalog` —— 原站 todos.dev `/docs/mcp-servers`
 * 目录数据的 REST 投影。
 *
 * **为什么独立于 `routes/mcp.ts`**：mcp.ts 是 MCP 协议侧（Bearer API key），
 * 而本端点是 BFF 转发用（cookie + 团队归属），两者写鉴权的方式不同，强行合并
 * 只会让两边都得互相迁就。**字段集合与 `services/connections.ts` 的 `listConnections`
 * 不同**：那里是用户已添加的连接；这里是平台提供的官方目录。
 *
 * **数据来源**：直接 `import` `@tds/protocol` 的 `MCP_CATALOG` —— 服务端**不复制**
 * 一份常量，否则两边漂移会让前端拿到「不一致的两份目录」。`teamConnectionCount`
 * 才是这次查询唯一会去查库的地方。
 *
 * 鉴权：`actorForTeam(db, req, teamId)` 不传 `opts.action`，走「成员即可读」分支
 * （与 `GET /api/todos` / `GET /api/teams/:id/projects` 一致）。
 */

import type { FastifyInstance } from 'fastify';
import { and, count, eq, isNull } from 'drizzle-orm';
import type { Db } from '@tds/db';
import { connections } from '@tds/db';
import { MCP_CATALOG, MCP_CATALOG_CATEGORIES, TEAM_CONNECTION_LIMIT } from '@tds/protocol';
import { actorForTeam } from '../auth.js';

export function registerConnectionCatalogRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/teams/:teamId/connection-catalog', async (req) => {
    const { teamId } = req.params as { teamId: string };
    await actorForTeam(db, req, teamId);

    // 团队当前活跃连接数（soft-delete 不计）。这是这次端点唯一要查库的地方 —
    // — 目录数据本身是 `MCP_CATALOG` 常量，不带请求参数随机化（这一点也在测试
    // 里钉死）。
    const row = (
      await db
        .select({ c: count() })
        .from(connections)
        .where(and(eq(connections.teamId, teamId), isNull(connections.deletedAt)))
    )[0];

    return {
      catalog: MCP_CATALOG,
      categories: MCP_CATALOG_CATEGORIES,
      teamConnectionCount: row?.c ?? 0,
      limit: TEAM_CONNECTION_LIMIT,
    };
  });
}
