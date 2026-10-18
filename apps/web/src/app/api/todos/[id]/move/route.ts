import { NextResponse } from 'next/server';
import { API_BASE } from '@/lib/api';
import { isAuthed, unauthorized } from '@/lib/auth';
import { forwardAuthHeaders } from '@/lib/bff-auth';

/**
 * BFF：`/api/todos/:id/move`
 *
 * 看板拖拽改相位的 BFF —— 与 `apps/web/src/app/api/todos/[id]/checklist/route.ts`
 * 同源（按 todoId 鉴权，URL 不带 teamId，不能走 `proxyWrite`）：守卫 → 取 cookie →
 * 转发到上游 `POST /api/todos/:todoId/move` → **状态码与响应体原样透出**。
 *
 * 写路径失败语义（与 checklist POST 同源）：
 *   - 401 / 403 / 404 / 409 / 422 全部原样透给前端 —— 前端要能分辨「重试无意义」
 *     与「参数错」，折成 ready:false 会把原因吃掉。
 *   - 上游连接失败 / 5xx 才落到 `{ready:false, reason}` + HTTP 200 的兜底。
 *
 * `[id]` 段是 Next App Router 的文件名约束（动态段必须叫 `[id]`），函数形参
 * 用 `todoId` 表达语义 —— 写代码的人看到 `todoId` 而不是 `id` 就知道这是 todo。
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
      `${API_BASE}/api/todos/${encodeURIComponent(todoId)}/move`,
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