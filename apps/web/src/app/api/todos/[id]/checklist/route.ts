import { NextResponse } from 'next/server';
import { API_BASE } from '@/lib/api';
import { isAuthed, unauthorized } from '@/lib/auth';
import { forwardAuthHeaders } from '@/lib/bff-auth';

/**
 * BFF：`/api/todos/:id/checklist`
 *
 * 单 todo 验收清单（对标 `apps/server/src/routes/checklist.ts`）。
 *
 * 与 projects/secrets/mcp-servers 不同：这条端点的 URL 不带 `:teamId`。
 * 后端 `routes/checklist.ts` 的 zod schema 是按 todoId 鉴权（`actorForTodo`），
 * 而不是按 teamId —— 一个 todo 的归属从它本身就能推出来，再让客户端挑 team
 * 反而是无意义的多传。所以这里**不调** `proxyRead(req, teamId, ...)`，而是手写：
 *
 *   - GET：透传上游 `/api/todos/:todoId/checklist` 的 `{checklist}` 字段；
 *     上游 404/非 2xx → `{ready:false}` + HTTP 200（与其它只读 BFF 一致）。
 *   - POST：透传上游 `POST /api/todos/:todoId/checklist`，4xx 原样回给客户端
 *     （422 文本为空 / 403 不在该 todo 团队里必须能分辨，不能折成 ready:false）。
 *
 * `[id]` 段是 Next App Router 的文件名约束（动态段必须叫 `[id]`），
 * 函数形参用 `todoId` 表达语义 —— 写代码的人看到 `todoId` 而不是 `id`
 * 就知道这是 todo，不是任意资源。
 */

export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  if (!isAuthed(req)) return unauthorized();
  const { id: todoId } = await ctx.params;
  try {
    const res = await fetch(
      `${API_BASE}/api/todos/${encodeURIComponent(todoId)}/checklist`,
      {
        headers: {
          Accept: 'application/json',
          ...forwardAuthHeaders(req),
        },
        cache: 'no-store',
      },
    );
    if (res.status === 404) {
      return NextResponse.json(
        { ready: false, reason: 'endpoint-not-implemented' },
        { status: 200 },
      );
    }
    if (!res.ok) {
      return NextResponse.json(
        { ready: false, reason: `http-${res.status}` },
        { status: 200 },
      );
    }
    const body = (await res.json().catch(() => ({}))) as unknown;
    if (body === null || typeof body !== 'object' || !('checklist' in body)) {
      return NextResponse.json(
        { ready: false, reason: 'malformed-payload' },
        { status: 200 },
      );
    }
    const list = body['checklist'];
    if (!Array.isArray(list)) {
      return NextResponse.json(
        { ready: false, reason: 'malformed-payload' },
        { status: 200 },
      );
    }
    return NextResponse.json({ ready: true, data: list });
  } catch (err) {
    return NextResponse.json(
      { ready: false, reason: err instanceof Error ? err.name : 'unknown' },
      { status: 200 },
    );
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  if (!isAuthed(req)) return unauthorized();
  const { id: todoId } = await ctx.params;
  try {
    const raw = await req.text();
    const res = await fetch(
      `${API_BASE}/api/todos/${encodeURIComponent(todoId)}/checklist`,
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
