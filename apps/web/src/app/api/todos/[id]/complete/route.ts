import type { NextResponse } from 'next/server';
import { proxyWrite } from '@/lib/bff-proxy';

/**
 * BFF：`POST /api/todos/:id/complete`。
 *
 * Review 闸门主按钮 —— 写路径必须走 `proxyWrite` 让 4xx 原样透出：
 *   - 409：当前 phase 不是 review（`complete is only valid at review gate`）
 *   - 403：teamId 不属于 key 所有者
 *   - 404：todo 不存在
 *
 * `merge` 字段（默认 false）由前端「完成并合并」按钮置 true、「完成（不合并）」
 * 置 false 决定；上游 `CompleteBody = { merge: boolean }` 的 default 已经兜底，
 * 这里只需把 body 原样转过去。
 *
 * 上游：`apps/server/src/routes/todos.ts:325` `POST /api/todos/:todoId/complete`。
 */

export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  // 上游按 todoId 解析 teamId 走归属校验，URL 模板里不需要 teamId。
  return proxyWrite(
    req,
    '',
    {
      path: () => `/api/todos/${encodeURIComponent(id)}/complete`,
    },
    'POST',
  );
}