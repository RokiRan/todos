import type { NextResponse } from 'next/server';
import { proxyRead } from '@/lib/bff-proxy';

/**
 * BFF：`GET /api/teams/:teamId/agents/:agentId/todos` —— agent 正在处理的 todo 列表。
 *
 * 详情页 Overview 段「the todos it is currently working on」的数据源（agents.md）。
 * 上游实现只返回 phase 不在 `done / closed / failed` 的 todo，且按 `seq_num` 升序。
 * 只读 → `proxyRead`：404 折成 `{ready:false}`，前端直接降级为空列表。
 *
 * 这条路由的 teamId 与 agentId 都在路径里，但**只是用于命中后端路由**——
 * 后端在 handler 里会再校验 agent 是否真属于该 team（不存在 → 404）。
 * 上游不存在跨 team 读别人 agent 的风险。
 */

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ teamId: string; agentId: string }> },
): Promise<NextResponse> {
  const { teamId, agentId } = await ctx.params;
  return proxyRead(req, teamId, {
    path: (t) => `/api/teams/${encodeURIComponent(t)}/agents/${encodeURIComponent(agentId)}/todos`,
    pick: (b) =>
      b !== null && typeof b === 'object' && 'todos' in b ? b['todos'] : undefined,
  });
}