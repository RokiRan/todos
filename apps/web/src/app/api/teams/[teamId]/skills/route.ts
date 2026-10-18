import { NextResponse } from 'next/server';
import { proxyRead, proxyWrite } from '@/lib/bff-proxy';

/**
 * BFF：团队 skill 列表 + 新增。
 *
 * - GET：透出上游 `GET /api/teams/:teamId/skills` 的 `{skills}` 字段。
 *   4xx → `{ready:false}`（与其它只读 BFF 一致），让设置页能渲染「数据未就绪」
 *   占位而不是白屏。
 * - POST：透出上游 `POST /api/teams/:teamId/skills`，4xx 原样回给客户端。
 *   422（参数错 / 上限超）和 403（非 admin）必须能分开，文案由上游给。
 */

export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ teamId: string }> }): Promise<NextResponse> {
  const { teamId } = await ctx.params;
  return proxyRead(req, teamId, {
    path: (t) => `/api/teams/${t}/skills`,
    pick: (b) => (b as { skills?: unknown }).skills,
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ teamId: string }> }): Promise<NextResponse> {
  const { teamId } = await ctx.params;
  return proxyWrite(req, teamId, { path: (t) => `/api/teams/${t}/skills` }, 'POST');
}
