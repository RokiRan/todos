import { NextResponse } from 'next/server';
import { API_BASE } from '@/lib/api';
import { isAuthed, unauthorized } from '@/lib/auth';

/**
 * BFF：todo 关联的 build 列表。
 *
 * 凭据转发：cookie header 原样给 upstream。
 */

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!isAuthed(req)) return unauthorized();

  const { id } = await ctx.params;
  try {
    const res = await fetch(`${API_BASE}/api/todos/${encodeURIComponent(id)}/builds`, {
      headers: {
        Accept: 'application/json',
        ...(req.headers.get('cookie') ? { cookie: req.headers.get('cookie') as string } : {}),
      },
      cache: 'no-store',
    });
    if (res.status === 404) {
      return NextResponse.json({ ready: false, reason: 'endpoint-not-implemented' }, { status: 200 });
    }
    if (!res.ok) {
      return NextResponse.json({ ready: false, reason: `http-${res.status}` }, { status: 200 });
    }
    const body = (await res.json()) as { builds?: unknown };
    // 上游回 `{ builds: [...] }`；客户端 `fetchJson<Build[]>` 期望 data 就是数组。
    // 直接透传会让页面拿到 `data.builds`（undefined）→ 判成「无 build」，
    // 症状是消息流与 Changes 文档两块永远空白，且没有任何报错。
    if (!('builds' in body)) {
      return NextResponse.json({ ready: false, reason: 'malformed-payload' }, { status: 200 });
    }
    return NextResponse.json({ ready: true, data: body.builds });
  } catch (err) {
    return NextResponse.json({ ready: false, reason: err instanceof Error ? err.name : 'unknown' }, { status: 200 });
  }
}
