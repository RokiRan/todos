import { NextResponse } from 'next/server';
import { API_BASE } from '@/lib/api';
import { isAuthed, unauthorized } from '@/lib/auth';
import { forwardAuthHeaders } from '@/lib/bff-auth';

/**
 * BFF：`POST /api/todos/:id/reopen`
 *
 * 单 todo 终态重新打开 —— 对标后端 `apps/server/src/routes/todos.ts` 的
 * `POST /api/todos/:todoId/reopen`。
 *
 * 原站语义：reopen 把 todo 从终态（`done | failed | closed`）拉回 `review` 闸门，
 * 让用户重新决定「合并 / 反悔」之类的命运。成功后 phase 必回 `review`。
 *
 * URL 不带 `:teamId`，与 `/api/todos/:id/rerun` 同形 —— 后端按 todoId 解析
 * teamId、再走归属校验。所以**不调** `proxyWrite`（那个会注入 userId，
 * 而 reopen 不需要 client 身份字段），改用与 `rerun` route 一致的手写转发：
 *
 *   - 4xx 原样透出：
 *     · 409：当前 phase 不是终态（状态机拒绝 reopen）
 *     · 403：actor 不在所属团队
 *     · 404：todo 不存在
 *   - 成功：上游 `{ok: true, phase: TodoPhase}` —— phase 必是 `review`。
 *   - 异常：catch 折成 `{ready:false, reason}` + HTTP 200。
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
      `${API_BASE}/api/todos/${encodeURIComponent(todoId)}/reopen`,
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
