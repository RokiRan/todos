import { NextResponse } from 'next/server';
import { API_BASE } from '@/lib/api';
import { isAuthed, unauthorized } from '@/lib/auth';
import { forwardAuthHeaders } from '@/lib/bff-auth';

/**
 * BFF：`POST /api/todos/:id/rerun`
 *
 * 单 todo 终态重跑 —— 对标后端 `apps/server/src/routes/todos.ts` 的
 * `POST /api/todos/:todoId/rerun`。
 *
 * URL 不带 `:teamId`，与 `/api/todos/:id/checklist` 同形：后端按 todoId 解析
 * 出 teamId，再走归属校验。所以这里**不调** `proxyWrite`（那个会注入 userId
 * 字段，rerun 不需要），改用手写转发 —— 抄 checklist POST 的形态：
 *
 *   - 4xx 原样透出：
 *     · 409：当前 phase 不是终态（`done | failed | closed`），状态机拒绝 rerun
 *     · 422：zod body 校验失败
 *     · 403：actor 不在所属团队
 *     · 404：todo 不存在
 *   - 成功：上游 `{ok: true, phase: TodoPhase}` —— 客户端用 `phase` 立刻刷新详情页。
 *   - 上游异常 / 网络错误：catch 折成 `{ready:false, reason}` + HTTP 200，
 *     让前端用与其它只读端点统一的占位文案呈现（不要在这里抛 500）。
 *
 * 客户端约定 body：`{}` 或 `undefined`（不传）。body 字段由后端按 trigger 推导，
 * 前端不强行构造。
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
      `${API_BASE}/api/todos/${encodeURIComponent(todoId)}/rerun`,
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
    // 网络层异常 —— 后端 reachable 性都不明确；按 checklist POST 同样的兜底。
    return NextResponse.json(
      { ready: false, reason: err instanceof Error ? err.name : 'unknown' },
      { status: 200 },
    );
  }
}
