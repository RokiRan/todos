import { NextResponse } from 'next/server';
import { API_BASE } from '@/lib/api';
import { isAuthed, unauthorized } from '@/lib/auth';
import { forwardAuthHeaders } from '@/lib/bff-auth';

/**
 * BFF：API keys 的增删改查。
 *
 * 这是**写路径**，与其它只读 BFF 有两点不同：
 *   1. **不回传明文以外的任何字段**，且透传 `cache-control: no-store` ——
 *      `POST` 的响应里带一次性的 `tds_…` 明文，任何中间缓存都不该留存。
 *   2. **上游的 4xx 原样透出**（不像只读路由那样折成 `{ready:false}`）。
 *      Settings 页面需要区分「409 同名」与「404 不是你的 key」，折成
 *      `ready:false` 就把错误原因吃掉了。
 *
 * 凭据转发：cookie 原样带给上游（`tds_token`），后端据此识别「这是哪个用户」。
 * 后端按 **user_id** 判归属，不按 team —— key 属于人。
 */

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<NextResponse> {
  if (!isAuthed(req)) return unauthorized();
  try {
    const res = await fetch(`${API_BASE}/api/user/api-keys`, {
      headers: { Accept: 'application/json', ...forwardAuthHeaders(req) },
      cache: 'no-store',
    });
    if (!res.ok) {
      return NextResponse.json({ error: `http-${res.status}` }, { status: res.status });
    }
    const data = (await res.json()) as { apiKeys?: unknown[] };
    return NextResponse.json({ ready: true, data: data.apiKeys ?? [] });
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
    const body = await req.json();
    const res = await fetch(`${API_BASE}/api/user/api-keys`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'content-type': 'application/json',
        ...forwardAuthHeaders(req),
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    // 明文只在这一次响应里出现：必须禁缓存
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

export async function PATCH(): Promise<NextResponse> {
  // 刻意不支持：Next App Router 按「文件 = 路径段」匹配，带 `:keyId` 的
  // PATCH 属于 `[keyId]/route.ts`。挂在这里的话 Next 会把
  // `/api/user/api-keys/{keyId}` 判成 404 —— 症状看起来像「后端没这个端点」，
  // 实际是路由没落对位置。
  return NextResponse.json(
    { error: 'use /api/user/api-keys/{keyId}' },
    { status: 405 },
  );
}
