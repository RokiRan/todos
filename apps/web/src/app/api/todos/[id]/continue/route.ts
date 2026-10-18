import { NextResponse } from 'next/server';
import { API_BASE } from '@/lib/api';
import { isAuthed, unauthorized } from '@/lib/auth';
import { forwardAuthHeaders } from '@/lib/bff-auth';

/**
 * BFF：`POST /api/todos/:id/continue`
 *
 * 单 todo `failed` 相位上的「在原 build 上重试失败的那一轮」—— 对标后端
 * `apps/server/src/routes/todos.ts` 的 `POST /api/todos/:todoId/continue`。
 *
 * 与 `reopen` / `rerun` BFF 同形（URL 不带 `:teamId`，不经过 `proxyWrite`）：
 *   - 守卫 → 取 cookie → 转发到上游 `POST /api/todos/:todoId/continue`
 *   - 状态码与响应体原样透出（4xx 与成功 200 都不改写），让前端按
 *     `friendlyTerminalError` 同样的 4xx 表区分「重试无意义」与「参数错」
 *   - 上游连接失败 / 5xx 才折成 `{ready:false, reason}` + HTTP 200 兜底
 *
 * body 由前端直接序列化为 JSON 字符串转发：服务端 `ContinueBody` 接受
 * `{ buildId?: string }`，不传就取最近一个 build。
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
      `${API_BASE}/api/todos/${encodeURIComponent(todoId)}/continue`,
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
    // 网络层异常 —— 后端 reachable 性都不明确；按 rerun POST 同源兜底。
    return NextResponse.json(
      { ready: false, reason: err instanceof Error ? err.name : 'unknown' },
      { status: 200 },
    );
  }
}
