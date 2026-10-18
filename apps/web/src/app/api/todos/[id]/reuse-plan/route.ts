import { NextResponse } from 'next/server';
import { API_BASE } from '@/lib/api';
import { isAuthed, unauthorized } from '@/lib/auth';
import { forwardAuthHeaders } from '@/lib/bff-auth';

/**
 * BFF：`POST /api/todos/:id/reuse-plan`
 *
 * 终态重跑 —— **复用上一次 build 的 plan 文档**起新 build（对标原站
 * `docs-todos.md` Reuse plan 语义）。对应后端
 * `apps/server/src/routes/todos.ts` 的 `POST /api/todos/:todoId/reuse-plan`。
 *
 * 与 `reopen` / `rerun` BFF 同形：URL 不带 `:teamId`，不经过 `proxyWrite`，
 * 直接手写转发。原站语义：「上一个 build 出过计划时，rerun 也提供 Reuse plan」，
 * 后端会判 `build.planDocId IS NOT NULL`，没有 plan 的 build 一律 409。
 *
 * 4xx 透出（同 rerun）；上游连接失败 / 5xx 才折成 `{ready:false, reason}` + 200。
 * body 由前端序列化为 JSON 转发：`{ buildId?: string }`（不传 → 取最近 build）。
 */

export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!isAuthed(req)) return unauthorized();
  const { id: todoId } = await ctx.params;
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    raw = '';
  }
  try {
    const res = await fetch(
      `${API_BASE}/api/todos/${encodeURIComponent(todoId)}/reuse-plan`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          ...(raw.length > 0 ? { 'content-type': 'application/json' } : {}),
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
