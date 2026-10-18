import { NextResponse } from 'next/server';
import { API_BASE } from '@/lib/api';
import { isAuthed, unauthorized } from '@/lib/auth';
import { forwardAuthHeaders } from '@/lib/bff-auth';

/**
 * BFF：`GET /api/needs-you` —— 当前用户「Needs you」待决集合。
 *
 * **不带 teamId 的路径**：团队从 cookie 身份推导（服务端 `teamIdsForUser`），
 * 不让客户端挑 team（挑错会让 N 个团队的结果混在一起，角标/列表全错）。
 *
 * **失败语义对齐 `user-context`**：只读 → 上游非 2xx 恒返回 HTTP 200 +
 * `{ready:false, reason}`。侧栏角标据此判断「数据未就绪」时**不显示**
 * 数字（不能因为接口失败就在侧栏画个错的 0 或上一个陈旧的数）。
 *
 * 浏览器侧：失败时页面应把数字位隐藏，绝不画假值。
 */

export const dynamic = 'force-dynamic';

interface NeedsYouItem {
  todoId: string;
  seqNum: number;
  title: string;
  phase: string;
  gate: 'confirm' | 'review' | null;
  kind: 'confirm' | 'review' | 'failed' | 'awaiting-reply';
  reason: string;
  updatedAt: number;
}

interface NeedsYouResponse {
  items: NeedsYouItem[];
  count: number;
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!isAuthed(req)) return unauthorized();
  try {
    const res = await fetch(`${API_BASE}/api/needs-you`, {
      headers: { Accept: 'application/json', ...forwardAuthHeaders(req) },
      cache: 'no-store',
    });
    if (!res.ok) {
      return NextResponse.json(
        { ready: false, reason: `http-${res.status}` },
        { status: 200 },
      );
    }
    const body = (await res.json()) as unknown;
    // 形状不对（不是对象、没有 items 数组、没有 count）时按「未就绪」处理，
    // 而不是把半个对象交给页面 —— 页面会在 items.map 上炸成白屏。
    if (
      typeof body !== 'object' ||
      body === null ||
      !Array.isArray((body as { items?: unknown }).items) ||
      typeof (body as { count?: unknown }).count !== 'number'
    ) {
      return NextResponse.json({ ready: false, reason: 'malformed-payload' }, { status: 200 });
    }
    return NextResponse.json({ ready: true, data: body as NeedsYouResponse });
  } catch (err) {
    return NextResponse.json(
      { ready: false, reason: err instanceof Error ? err.name : 'unknown' },
      { status: 200 },
    );
  }
}