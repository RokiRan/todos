import { NextResponse } from 'next/server';
import { proxyRead, proxyWrite } from '@/lib/bff-proxy';

/**
 * BFF：`/api/teams/:teamId/chief/threads` —— topic 列表与创建。
 *
 * GET 走 `proxyRead`（只读，404 → ready:false）。POST 走 `proxyWrite`：
 * 上游在建 topic 超 50 时返回 `422 chief topic limit reached`，原样透出
 * 让 UI 直接展示后端原文。
 */

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ teamId: string }> },
): Promise<NextResponse> {
  const { teamId } = await ctx.params;
  return proxyRead(req, teamId, {
    path: (t) => `/api/teams/${encodeURIComponent(t)}/chief/threads`,
    pick: (body) => (body as { threads?: unknown[] }).threads ?? [],
  });
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ teamId: string }> },
): Promise<NextResponse> {
  const { teamId } = await ctx.params;
  return proxyWrite(
    req,
    teamId,
    {
      path: (t) => `/api/teams/${encodeURIComponent(t)}/chief/threads`,
    },
    'POST',
  );
}