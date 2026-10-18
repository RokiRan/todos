import { NextResponse } from 'next/server';
import { proxyRead, proxyWrite } from '@/lib/bff-proxy';

/**
 * BFF：团队 connection（MCP server）列表 + 新增。
 *
 * - GET：透出上游 `GET /api/teams/:teamId/mcp-servers` 的 `{mcpServers}` 字段。
 *   4xx → `{ready:false}`（与其它只读 BFF 一致），让设置页能渲染「数据未就绪」
 *   占位而不是白屏。
 * - POST：透出上游 `POST /api/teams/:teamId/mcp-servers`，4xx 原样回给客户端。
 *   422（identifier 不合规 / transport 不合规 / 缺 endpoint）/ 409（identifier 重复）/
 *   403（非 admin）必须能分开 —— 文案由上游给。
 *
 * **identifier / transport / endpoint 一旦建好就不可改**（写阅契约）：
 * 见 `services/connections.ts:215-225` —— 它们是工具名与连法的一部分，要改就
 * 删了重建。
 */

export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ teamId: string }> }): Promise<NextResponse> {
  const { teamId } = await ctx.params;
  return proxyRead(req, teamId, {
    path: (t) => `/api/teams/${t}/mcp-servers`,
    pick: (b) => (b as { mcpServers?: unknown }).mcpServers,
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ teamId: string }> }): Promise<NextResponse> {
  const { teamId } = await ctx.params;
  return proxyWrite(req, teamId, { path: (t) => `/api/teams/${t}/mcp-servers` }, 'POST');
}