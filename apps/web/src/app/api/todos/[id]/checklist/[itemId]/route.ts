import { NextResponse } from 'next/server';
import { API_BASE } from '@/lib/api';
import { isAuthed, unauthorized } from '@/lib/auth';
import { forwardAuthHeaders } from '@/lib/bff-auth';

/**
 * BFF：`/api/todos/:id/checklist/:itemId`
 *
 * 单条验收清单项的 PATCH / DELETE（对标 `apps/server/src/routes/checklist.ts`）。
 *
 * 与 `route.ts` 同理：URL 不带 teamId，按 todoId 鉴权。proxyWrite 那套依赖
 * `proxyRead(req, teamId, ...)` 的形状不适用（[bff-proxy] 的 ProxyOptions 把
 * teamId 当成必填），所以这里直接 fetch + 原样透出：
 *   - PATCH 失败（403 不在 todo 团队 / 422 done 字段错）必须能看到后端原文。
 *   - DELETE 无 body，Fastify 上游不能带 `content-type` —— 这里手写也保证
 *     POST/PATCH 带 `content-type`、DELETE 不带，行为与 proxyWrite 一致。
 *
 * 路径段是 `[id]` / `[itemId]`（Next 文件名约束），函数形参 `todoId` / `itemId`
 * 表达语义。
 */

export const dynamic = 'force-dynamic';

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string; itemId: string }> }): Promise<NextResponse> {
  if (!isAuthed(req)) return unauthorized();
  const { id: todoId, itemId } = await ctx.params;
  try {
    const raw = await req.text();
    const res = await fetch(
      `${API_BASE}/api/todos/${encodeURIComponent(todoId)}/checklist/${encodeURIComponent(itemId)}`,
      {
        method: 'PATCH',
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

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string; itemId: string }> }): Promise<NextResponse> {
  if (!isAuthed(req)) return unauthorized();
  const { id: todoId, itemId } = await ctx.params;
  try {
    const res = await fetch(
      `${API_BASE}/api/todos/${encodeURIComponent(todoId)}/checklist/${encodeURIComponent(itemId)}`,
      {
        method: 'DELETE',
        headers: {
          Accept: 'application/json',
          ...forwardAuthHeaders(req),
        },
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
