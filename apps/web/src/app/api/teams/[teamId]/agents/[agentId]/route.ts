import type { NextResponse } from 'next/server';
import { proxyRead, proxyWrite } from '@/lib/bff-proxy';

/**
 * BFF：`GET/PATCH/DELETE /api/teams/:teamId/agents/:agentId`。
 *
 * - GET：详情页（profile / grants / default skills / 正在处理的 todo 等）的核心数据源。
 *   只读 → `proxyRead`：上游 404 折成 `{ready:false}`，让页面区分「端点缺失」与「真出错」。
 * - PATCH：编辑 agent。**写路径** → 上游 4xx 原样透出（403 = 非 admin、422 = 校验失败、
 *   409 = 删除冲突）。`defaultSkillIds` / `grants` 是整体替换语义 —— 调用方构造完整数组。
 * - DELETE：删除 agent。`proxyWrite` 已经处理好「无 body 不塞 content-type」的细节，
 *   DELETE **不带** userId（上游不读 query userId，靠 actorForTeam 判身份）。
 *
 * `pick('agent')` 把包对象剥掉一层；上游总是 `{agent: ...}`，前端不必再拆。
 *
 * 浏览器**绝不**发 userId —— POST/PATCH 走 `proxyWrite` 由 cookie 推导后注入。
 */

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ teamId: string; agentId: string }> },
): Promise<NextResponse> {
  const { teamId, agentId } = await ctx.params;
  return proxyRead(req, teamId, {
    path: (t) => `/api/teams/${encodeURIComponent(t)}/agents/${encodeURIComponent(agentId)}`,
    pick: (b) =>
      b !== null && typeof b === 'object' && 'agent' in b ? b['agent'] : undefined,
  });
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ teamId: string; agentId: string }> },
): Promise<NextResponse> {
  const { teamId, agentId } = await ctx.params;
  return proxyWrite(
    req,
    teamId,
    {
      path: (t) => `/api/teams/${encodeURIComponent(t)}/agents/${encodeURIComponent(agentId)}`,
    },
    'PATCH',
  );
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ teamId: string; agentId: string }> },
): Promise<NextResponse> {
  const { teamId, agentId } = await ctx.params;
  return proxyWrite(
    req,
    teamId,
    {
      path: (t) => `/api/teams/${encodeURIComponent(t)}/agents/${encodeURIComponent(agentId)}`,
    },
    'DELETE',
  );
}