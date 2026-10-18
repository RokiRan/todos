import { NextResponse } from 'next/server';
import { API_BASE } from '@/lib/api';
import { isAuthed, unauthorized } from '@/lib/auth';
import { forwardAuthHeaders } from '@/lib/bff-auth';

/**
 * BFF：`/api/todos/:id/mentions`
 *
 * 对标 `apps/server/src/routes/todos.ts` 的 `POST /api/todos/:todoId/mentions`
 * 与 `GET /api/todos/:todoId/mentions?messageId=...`（2026-10-18 新增）。
 *
 * 与 `move` / `checklist` 同源：URL 不带 teamId，按 todoId 鉴权，
 * 不能走 `proxyRead/proxyWrite`，**手写转发**：
 *   - 取 cookie → 拼上游 URL → 把 status code 与响应体原样透回
 *   - 401 / 403 / 404 / 409 / 422 全部原样回 —— 折成 ready:false 会把
 *     「跨团队 → 403」「引用不存在 → 422」「message 不属于该 todo → 404」
 *     三类关键诊断吃掉，前端无法分辨
 *   - 上游连接失败 / 5xx 才落到 `{ready:false, reason}` + HTTP 200 兜底
 *
 * `[id]` 段是 Next App Router 的文件名约束（动态段必须叫 `[id]`），函数形参
 * 用 `todoId` 表达语义。
 */

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!isAuthed(req)) return unauthorized();
  const { id: todoId } = await ctx.params;
  try {
    const url = new URL(req.url);
    const messageId = url.searchParams.get('messageId') ?? '';
    const upstream = `${API_BASE}/api/todos/${encodeURIComponent(todoId)}/mentions?messageId=${encodeURIComponent(messageId)}`;
    const res = await fetch(upstream, {
      headers: {
        Accept: 'application/json',
        ...forwardAuthHeaders(req),
      },
      cache: 'no-store',
    });
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

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!isAuthed(req)) return unauthorized();
  const { id: todoId } = await ctx.params;
  try {
    const raw = await req.text();
    const res = await fetch(
      `${API_BASE}/api/todos/${encodeURIComponent(todoId)}/mentions`,
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
