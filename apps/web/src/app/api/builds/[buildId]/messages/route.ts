import { NextResponse } from 'next/server';
import { API_BASE } from '@/lib/api';
import { isAuthed, unauthorized } from '@/lib/auth';
import { forwardAuthHeaders } from '@/lib/bff-auth';

/**
 * BFF：`/api/builds/:buildId/messages`
 *
 * GET / POST / PATCH / DELETE 一体的转发。GET 走 `proxyRead` 风格的「恒 200 +
 * {ready:false,reason}」兜底（与第一批 Messages BFF 同源），POST/PATCH/DELETE
 * 走**手写转发**（与 `apps/web/src/app/api/todos/[id]/move/route.ts` 同源）：
 * URL 不带 teamId —— 上游按 buildId 自己推 team 然后判 403，**不能**走
 * `proxyWrite`：后者会注入 `userId`，而本端点的鉴权不消费 body.userId，会
 * 被 zod `.strict()` 拒成 422。前端 fetchJson 的契约（`{ready:false}` /
 * `{ready:true, data}`）只对 GET 用 —— 写路径**原样透出上游状态码与响应体**，
 * 让前端能区分 401/403/404/409/422。
 */

export const dynamic = 'force-dynamic';

// ── GET ─────────────────────────────────────────────────────────
export async function GET(
  req: Request,
  ctx: { params: Promise<{ buildId: string }> },
): Promise<NextResponse> {
  if (!isAuthed(req)) return unauthorized();
  const { buildId } = await ctx.params;
  const url = new URL(req.url);
  const since = url.searchParams.get('since');
  const qs = since !== null ? `?since=${encodeURIComponent(since)}` : '';
  try {
    const res = await fetch(
      `${API_BASE}/api/builds/${encodeURIComponent(buildId)}/messages${qs}`,
      {
        headers: {
          Accept: 'application/json',
          ...(req.headers.get('cookie') ? { cookie: req.headers.get('cookie') as string } : {}),
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
    const data = await res.json();
    return NextResponse.json({ ready: true, data });
  } catch (err) {
    return NextResponse.json(
      { ready: false, reason: err instanceof Error ? err.name : 'unknown' },
      { status: 200 },
    );
  }
}

// ── POST ────────────────────────────────────────────────────────
// 手写转发（详见文件头注释）。
export async function POST(
  req: Request,
  ctx: { params: Promise<{ buildId: string }> },
): Promise<NextResponse> {
  return forwardWrite(req, ctx, 'POST');
}

// ── PATCH ──────────────────────────────────────────────────────
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ buildId: string }> },
): Promise<NextResponse> {
  return forwardWrite(req, ctx, 'PATCH');
}

// ── DELETE ─────────────────────────────────────────────────────
export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ buildId: string }> },
): Promise<NextResponse> {
  return forwardWrite(req, ctx, 'DELETE');
}

async function forwardWrite(
  req: Request,
  ctx: { params: Promise<{ buildId: string }> },
  method: 'POST' | 'PATCH' | 'DELETE',
): Promise<NextResponse> {
  if (!isAuthed(req)) return unauthorized();
  const { buildId } = await ctx.params;
  // messageId 在 PATCH/DELETE 的 path 段里 —— GET params 没它，所以从 ?messageId= 取。
  const url = new URL(req.url);
  const messageId = url.searchParams.get('messageId');
  const tail = messageId !== null ? `/${encodeURIComponent(messageId)}` : '';
  try {
    const raw = method === 'DELETE' ? '' : await req.text();
    const upstream = await fetch(
      `${API_BASE}/api/builds/${encodeURIComponent(buildId)}/messages${tail}`,
      {
        method,
        headers: {
          Accept: 'application/json',
          'content-type': 'application/json',
          ...forwardAuthHeaders(req),
        },
        body: raw.length > 0 ? raw : method === 'DELETE' ? undefined : '{}',
        cache: 'no-store',
      },
    );
    const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
    return NextResponse.json(data, {
      status: upstream.status,
      headers: { 'cache-control': 'no-store' },
    });
  } catch (err) {
    return NextResponse.json(
      { ready: false, reason: err instanceof Error ? err.name : 'unknown' },
      { status: 200 },
    );
  }
}
