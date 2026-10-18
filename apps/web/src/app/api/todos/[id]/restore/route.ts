import { NextResponse } from 'next/server';
import { API_BASE } from '@/lib/api';
import { isAuthed, unauthorized } from '@/lib/auth';
import { forwardAuthHeaders } from '@/lib/bff-auth';

/**
 * BFF：`/api/todos/:id/restore`
 *
 * 与 `apps/web/src/app/api/todos/[id]/move/route.ts` 同源：URL 不带 teamId，
 * 按 todoId 鉴权（路由层走 requireTeamMembership），**手写转发**而非
 * `proxyWrite`（后者要 teamId，不适用）。状态码与响应体原样透出，4xx 不折
 * 成 ready:false —— 前端要能分辨 409「phase 不允许 / build 在跑 / 已有 pending」
 * 与 422「参数错」。
 */

export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!isAuthed(req)) return unauthorized();
  const { id: todoId } = await ctx.params;
  try {
    const raw = await req.text();
    const res = await fetch(
      `${API_BASE}/api/todos/${encodeURIComponent(todoId)}/restore`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'content-type': 'application/json',
          ...forwardAuthHeaders(req),
        },
        body: raw.length > 0 ? raw : '{}',
        cache: 'no-store',
      },
    );
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return NextResponse.json(data, {
      status: res.status,
      headers: { 'cache-control': 'no-store' },
    });
  } catch (err) {
    return NextResponse.json(
      { ready: false, reason: err instanceof Error ? err.name : 'unknown' },
      { status: 200 },
    );
  }
}