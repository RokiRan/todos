import { NextResponse } from 'next/server';
import { API_BASE } from '@/lib/api';
import { isAuthed, unauthorized } from '@/lib/auth';

/**
 * BFF：拉单个 document（含 Changes 文档）。
 *
 * 凭据转发：cookie header 原样给 upstream。
 */

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ docId: string }> },
): Promise<NextResponse> {
  if (!isAuthed(req)) return unauthorized();

  const { docId } = await ctx.params;
  try {
    const res = await fetch(`${API_BASE}/api/documents/${encodeURIComponent(docId)}`, {
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
    const data = await res.json();
    return NextResponse.json({ ready: true, data });
  } catch (err) {
    return NextResponse.json({ ready: false, reason: err instanceof Error ? err.name : 'unknown' }, { status: 200 });
  }
}
