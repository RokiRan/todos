import { NextResponse } from 'next/server';
import { API_BASE } from '@/lib/api';
import { isAuthed, unauthorized } from '@/lib/auth';
import { forwardAuthHeaders } from '@/lib/bff-auth';

/**
 * BFF：就地改一把 key 的 scopes。
 *
 * 对应上游 `PATCH /api/user/api-keys/:keyId` —— key 属于人，后端按 `user_id`
 * 判归属：不是你的 key 回 404（不泄露它是否存在）。
 *
 * 4xx 原样透出：409（已撤销不可改）与 404（不是你的）语义完全不同，UI 要能分开显示。
 *
 * 为什么是独立文件：Next App Router 按「一个文件 = 一个路径段」匹配。
 * 把 PATCH 写在父级 `api-keys/route.ts` 里，`/api/user/api-keys/{keyId}`
 * 会直接 404 —— 症状看着像后端缺端点，实际是路由没落对位置。
 */

export const dynamic = 'force-dynamic';

export async function PATCH(req: Request, ctx: { params: Promise<{ keyId: string }> }): Promise<NextResponse> {
  if (!isAuthed(req)) return unauthorized();
  try {
    const { keyId } = await ctx.params;
    const body = await req.json();
    const res = await fetch(`${API_BASE}/api/user/api-keys/${encodeURIComponent(keyId)}`, {
      method: 'PATCH',
      headers: {
        Accept: 'application/json',
        'content-type': 'application/json',
        ...forwardAuthHeaders(req),
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json(
      { ready: false, reason: err instanceof Error ? err.name : 'unknown' },
      { status: 200 },
    );
  }
}
