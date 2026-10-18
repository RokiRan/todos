import type { NextResponse } from 'next/server';
import { proxyWrite } from '@/lib/bff-proxy';

/**
 * BFF：`POST /api/todos/:id/approve`。
 *
 * 写路径 —— **必须**走 `proxyWrite` 让上游 4xx 原样透出：
 *   - 409：当前 phase 不是 confirm（`approve is only valid at confirm gate`）
 *   - 403：teamId 不属于 key 所有者
 *   - 404：todo 不存在
 * UI 必须能区分这三种失败，否则用户看到的是「按钮无效」而不知道是状态已变
 * 还是参数不对。
 *
 * `by` 字段默认 `'user'`（与上游 `ApproveBody` 一致）；前端不传时由上游补默认。
 *
 * 上游：`apps/server/src/routes/todos.ts:284` `POST /api/todos/:todoId/approve`。
 */

export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  // 上游路径是 `/api/todos/:todoId`，不是 `/api/teams/:teamId/...`，所以
  // proxyWrite 的 teamId 形参此处被忽略（上游按 todoId 解析 teamId 走归属校验）。
  // 这里传空串占位即可 —— 不会进入 URL。
  return proxyWrite(
    req,
    '',
    {
      path: () => `/api/todos/${encodeURIComponent(id)}/approve`,
    },
    'POST',
  );
}