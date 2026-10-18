import { NextResponse } from 'next/server';
import { API_BASE } from '@/lib/api';
import { isAuthed, unauthorized } from '@/lib/auth';
import { forwardAuthHeaders } from '@/lib/bff-auth';

/**
 * BFF：todos 列表 + 创建。
 *
 * - GET：透传后端 `/api/todos`。Fastify 当前未实现该端点 —— 这条路由会原样收到 404，
 *   BFF 把它翻译成结构化的 `{ready:false}`，让客户端能展示「数据未就绪」占位
 *   而不是裸 404。
 * - POST：透传后端 `POST /api/todos`。**4xx 原样透出**（不像 GET 那样折成
 *   `{ready:false}`）—— 创建失败时 UI 要能分辨 422（参数错，例如 spec 超长 /
 *   ownerMemberId 不是本团队成员）与 403（无团队归属），把状态码吃掉会让用户
 *   看到的是「白屏/未知失败」。
 *
 * 为什么不直接让客户端 fetch 后端：
 *   1) 避免浏览器 CORS 预检（虽然 server 已开 cors，但 SSR 走内部 fetch 更稳）
 *   2) 集中降级策略 —— 客户端只关心 ready 字段
 *
 * 凭据转发：浏览器同源 fetch 自带 httpOnly cookie，BFF 取出后原样转给
 * 上游 —— cookie 名（`tds_token`）与后端读取的一致，token 不进 URL 日志。
 * POST 走 `forwardAuthHeaders`（统一入口），GET 的内联实现是历史遗留 —— 行为等价，
 * 这里不动它以免顺带改 GET。
 */

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<NextResponse> {
  if (!isAuthed(req)) return unauthorized();
  try {
    const res = await fetch(`${API_BASE}/api/todos`, {
      headers: {
        Accept: 'application/json',
        // BFF 把浏览器带来的 cookie 透给 upstream；空时不带，避免后端把它当作「无凭据」
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
    const data = (await res.json()) as { todos?: unknown[] } | unknown[];
    // 后端返回 { todos: [...] }；客户端 fetchJson<Todo[]> 期望裸数组，
    // 这里归一化，避免 UI 拿到对象后 map 崩溃。
    if (Array.isArray(data)) {
      return NextResponse.json({ ready: true, data });
    }
    const list = (data as { todos?: unknown[] }).todos;
    if (!Array.isArray(list)) {
      return NextResponse.json({ ready: false, reason: 'malformed-payload' }, { status: 200 });
    }
    return NextResponse.json({ ready: true, data: list });
  } catch (err) {
    return NextResponse.json(
      { ready: false, reason: err instanceof Error ? err.name : 'unknown' },
      { status: 200 },
    );
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!isAuthed(req)) return unauthorized();
  try {
    const body = await req.text();
    const res = await fetch(`${API_BASE}/api/todos`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'content-type': 'application/json',
        ...forwardAuthHeaders(req),
      },
      body: body.length > 0 ? body : '{}',
      cache: 'no-store',
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    // 上游 `routes/todos.ts:267` 的 `createTodo` 服务层返回 `{ id, seqNum }`，
    // route 直接 spread 返回 —— 客户端拿到的是 `{id, seqNum}` 形状，必须原样透出。
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
