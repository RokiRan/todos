import { NextResponse } from 'next/server';
import { API_BASE } from '@/lib/api';
import { isAuthed, unauthorized } from '@/lib/auth';

/**
 * BFF：单个 todo 详情。
 *
 * 凭据转发：把浏览器带来的 cookie（含 `tds_token`）原样转给 upstream。
 * 后端 `auth.ts` 的 `readWebToken` 与浏览器 cookie 名一致，直接比对即可。
 */

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!isAuthed(req)) return unauthorized();

  const { id } = await ctx.params;
  try {
    const res = await fetch(`${API_BASE}/api/todos/${encodeURIComponent(id)}`, {
      headers: {
        Accept: 'application/json',
        ...(req.headers.get('cookie') ? { cookie: req.headers.get('cookie') as string } : {}),
      },
      cache: 'no-store',
    });
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
    const data = (await res.json()) as { todo?: unknown };
    // 上游 `routes/todos.ts` 的 `GET /api/todos/:todoId` 回的是 `{ todo: {...} }`
    // （与 `GET /api/todos` 的 `{ todos: [...] }` 同一形状约定）。
    // 这里**剥掉外层**再包 `data` —— 客户端 `fetchJson<Todo>(...)` 期望 `data` 就是
    // Todo 本身。之前直接透传，于是 data 变成 `{todo:{...}}`，页面读 `todo.title`
    // 拿到 undefined：症状是详情页只剩一个「#」而没有标题、闸门区整块不渲染
    // （渲染条件是 `todo.phase`，phase 是 undefined）。字段少一层比 404 更难查。
    if (!('todo' in data)) {
      return NextResponse.json({ ready: false, reason: 'malformed-payload' }, { status: 200 });
    }
    return NextResponse.json({ ready: true, data: data.todo });
  } catch (err) {
    return NextResponse.json(
      { ready: false, reason: err instanceof Error ? err.name : 'unknown' },
      { status: 200 },
    );
  }
}
