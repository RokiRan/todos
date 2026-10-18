import type { NextResponse } from 'next/server';
import { proxyWrite } from '@/lib/bff-proxy';

/**
 * BFF：`POST /api/todos/:id/sync-to-machine`。
 *
 * 看板 BranchMenu（契约 §3.4）发起的「同步到机器」写路径。
 * 上游语义（契约 §3.3 + `apps/server/src/routes/todos.ts` 的 sync-to-machine
 * handler 注释）**永远**走 `ok:false` 路径（daemon 拉取协议尚未实现）——
 * 前端必须把 `reason` 原样显示，**不允许**改写成「已同步」。
 *
 * 走 `proxyWrite` 是为了：
 *   - userId 由 cookie 自动注入（契约 §5.1）；
 *   - 403 / 404 / 200 等状态码原样透出，前端才能正确显示 reason。
 *
 * 上游：`apps/server/src/routes/todos.ts:1754`
 *        `POST /api/todos/:todoId/sync-to-machine`。
 */

export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  // 上游按 todoId 解析 teamId，URL 模板里不出现 teamId。
  return proxyWrite(
    req,
    '',
    {
      path: () => `/api/todos/${encodeURIComponent(id)}/sync-to-machine`,
    },
    'POST',
  );
}