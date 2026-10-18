import { NextResponse } from 'next/server';
import { proxyRead } from '@/lib/bff-proxy';

/**
 * BFF：`GET /api/teams/:teamId/chief` —— 读取当前团队的 Chief。
 *
 * 上游（`apps/server/src/routes/chief.ts` 的 GET）是无 agent 时返回
 * `{ chief: null }` 而不是 404 —— 区分「Chief 不存在」与「后端挂了」
 * 必须靠上游的 404 分支。`proxyRead` 已经把上游 404 折成 `ready:false`，
 * 所以这里**正常情况** chief 字段会是 `null`（已 ready），
 * 极端故障时才是 `ready:false`。页面要两种状态都正确处理。
 */

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ teamId: string }> },
): Promise<NextResponse> {
  const { teamId } = await ctx.params;
  return proxyRead(req, teamId, {
    path: (t) => `/api/teams/${encodeURIComponent(t)}/chief`,
    pick: (body) => (body as { chief?: unknown }).chief,
  });
}