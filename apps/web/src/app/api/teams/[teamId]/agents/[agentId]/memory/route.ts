import { NextResponse } from 'next/server';
import { proxyRead, proxyWrite } from '@/lib/bff-proxy';

/**
 * BFF：agent memory 列表（GET）+ 创建/改写（POST）。
 *
 * 两条挨在一起是因为：同路径下 method 不同即可，浏览器永远只调一个，避免
 * 在 `/memory` 下再拆两个目录。路由命名是按**资源**走（memory），不是按
 * 方法拆。这里跟既有的 `/skills` BFF 一样是资源级路由，路径语义清楚。
 *
 * 上游：`GET /api/teams/:teamId/agents/:agentId/memories` → `{memories:[...]}`
 * 上游：`POST /api/teams/:teamId/agents/:agentId/memories` → `{memory:{...}}`
 *
 * 失败语义按模式分流：
 *   - GET（read）：上游 404/异常 → `{ready:false,reason}` + 200，前端降级渲染
 *     「数据未就绪」而不是白屏。
 *   - POST（write）：上游状态码**原样透出**，让前端能区分 422（参数错）/ 409 /
 *     403（无权）。`proxyWrite` 自动注入 userId（cookie → userId）；后端的
 *     `chiefId` **不靠 userId 推**，是路由反查 `chief` 行得到的 —— 与 mcp-tools
 *     这套已经固化的「actorType='chief' / actorId=chiefId」审计约定保持一致。
 */

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ teamId: string; agentId: string }> },
): Promise<NextResponse> {
  const { teamId, agentId } = await ctx.params;
  return proxyRead(req, teamId, {
    path: (t) =>
      `/api/teams/${encodeURIComponent(t)}/agents/${encodeURIComponent(agentId)}/memories`,
    pick: (b) =>
      b !== null && typeof b === 'object' && 'memories' in b ? b['memories'] : undefined,
  });
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ teamId: string; agentId: string }> },
): Promise<NextResponse> {
  const { teamId, agentId } = await ctx.params;
  return proxyWrite(
    req,
    teamId,
    {
      path: (t) =>
        `/api/teams/${encodeURIComponent(t)}/agents/${encodeURIComponent(agentId)}/memories`,
    },
    'POST',
  );
}
