import { NextResponse } from 'next/server';
import { API_BASE } from '@/lib/api';
import { isAuthed, unauthorized } from '@/lib/auth';

/**
 * BFF：todo 关联的所有文档列表（plan / changes / question / ...）。
 *
 * 端点上游：`GET /api/todos/:todoId/documents`（在 apps/server/src/routes/todos.ts:278
 * 之后）。返回 `{ documents: [...] }`，按 createdAt desc，所以每个 build 都有一份
 * 独立文档 → 多次 rerun 后会出现 N 份 plan + N 份 changes → 可做版本对比。
 *
 * 上游把 envelope 拆给前端，前端 `fetchJson<Document[]>` 期望 data 直接就是数组。
 * 同 `builds` 这条 BFF 的解构约定（route.ts 同目录下那份有同样的陷阱注释）。
 */

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!isAuthed(req)) return unauthorized();

  const { id } = await ctx.params;
  try {
    const res = await fetch(`${API_BASE}/api/todos/${encodeURIComponent(id)}/documents`, {
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
    const body = (await res.json()) as { documents?: unknown };
    if (!('documents' in body)) {
      return NextResponse.json({ ready: false, reason: 'malformed-payload' }, { status: 200 });
    }
    return NextResponse.json({ ready: true, data: body.documents });
  } catch (err) {
    return NextResponse.json({ ready: false, reason: err instanceof Error ? err.name : 'unknown' }, { status: 200 });
  }
}
