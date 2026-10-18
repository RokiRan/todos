import { NextResponse } from 'next/server';
import { API_BASE } from '@/lib/api';
import { isAuthed, unauthorized } from '@/lib/auth';
import { forwardAuthHeaders } from '@/lib/bff-auth';

/**
 * BFF：撤销一把 API key。
 *
 * 用 POST /revoke 而不是 DELETE —— 上游的语义是「软撤销，行还在库里，
 * 时间戳打上」，不可逆；要恢复只能新建一把。DELETE 在 REST 惯例里会被读成
 * 「资源已移除」，与实际不符。
 *
 * 4xx 原样透出：404 = 不是你的 key（或者已被撤销）。
 */

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ keyId: string }> }): Promise<NextResponse> {
  if (!isAuthed(req)) return unauthorized();
  try {
    const { keyId } = await ctx.params;
    const res = await fetch(`${API_BASE}/api/user/api-keys/${encodeURIComponent(keyId)}/revoke`, {
      method: 'POST',
      headers: { Accept: 'application/json', ...forwardAuthHeaders(req) },
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
