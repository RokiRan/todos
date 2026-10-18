import { NextResponse } from 'next/server';
import { API_BASE } from '@/lib/api';
import { isAuthed, unauthorized } from '@/lib/auth';
import { forwardAuthHeaders } from '@/lib/bff-auth';

/**
 * BFF：`GET /api/user/context` —— 身份 + 团队 + 本人 memberId + agent 名册。
 *
 * **唯一用途**：给设置页提供 URL 里的 `:teamId` 和写路径要的 `ownerMemberId`。
 * 在此之前前端只能从 `GET /api/todos` 的返回里顺带读到 teamId，于是空看板时
 * 所有设置页都进不去（后端功能在、UI 接不上）。这条路由就是那个缺口。
 *
 * 用 `proxyRead` 而非手写：只读端点，404/非 2xx 一律折成 HTTP 200 + `ready:false`，
 * 与其它只读 BFF 一致 —— 前端只需判 `ready`，不必关心状态码。
 */

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<NextResponse> {
  if (!isAuthed(req)) return unauthorized();
  try {
    const res = await fetch(`${API_BASE}/api/user/context`, {
      headers: { Accept: 'application/json', ...forwardAuthHeaders(req) },
      cache: 'no-store',
    });
    if (!res.ok) {
      return NextResponse.json({ ready: false, reason: `http-${res.status}` }, { status: 200 });
    }
    const data = (await res.json()) as unknown;
    // 形状不对（不是对象、没有 teams 数组）时按「未就绪」处理，而不是把
    // 半个对象交给页面 —— 页面会在 teams.map 上炸成白屏。
    if (
      typeof data !== 'object' ||
      data === null ||
      !Array.isArray((data as { teams?: unknown }).teams)
    ) {
      return NextResponse.json({ ready: false, reason: 'malformed-payload' }, { status: 200 });
    }
    return NextResponse.json({ ready: true, data });
  } catch (err) {
    return NextResponse.json(
      { ready: false, reason: err instanceof Error ? err.name : 'unknown' },
      { status: 200 },
    );
  }
}
