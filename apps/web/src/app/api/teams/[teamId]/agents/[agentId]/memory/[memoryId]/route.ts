import { NextResponse } from 'next/server';
import { proxyWrite } from '@/lib/bff-proxy';

/**
 * BFF：删一条 agent memory。
 *
 * 上游：`DELETE /api/teams/:teamId/agents/:agentId/memories/:memoryId`
 *        → `{ok:true, deleted: memoryId}`
 *
 * 写路径：原样透出状态码（404 memory 不存在 → 404；403 跨 team → 403；422 zod → 422）。
 * DELETE 不注入 userId —— 后端的 DELETE 全靠 cookie / Bearer 身份校验，
 * 业务 userId 也不在路径上。proxyWrite 已按 mode='DELETE' 自动省 body / content-type。
 */

export const dynamic = 'force-dynamic';

export async function DELETE(
  req: Request,
  ctx: {
    params: Promise<{ teamId: string; agentId: string; memoryId: string }>;
  },
): Promise<NextResponse> {
  const { teamId, agentId, memoryId } = await ctx.params;
  return proxyWrite(
    req,
    teamId,
    {
      path: (t) =>
        `/api/teams/${encodeURIComponent(t)}/agents/${encodeURIComponent(agentId)}/memories/${encodeURIComponent(memoryId)}`,
    },
    'DELETE',
  );
}
