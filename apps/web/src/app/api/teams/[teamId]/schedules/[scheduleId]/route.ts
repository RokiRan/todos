import { NextResponse } from 'next/server';
import { proxyWrite } from '@/lib/bff-proxy';

/**
 * BFF：`/api/teams/:teamId/schedules/:scheduleId`
 *
 * 单条定时规则的 PATCH / DELETE（对标 `apps/server/src/routes/schedules.ts`）。
 *
 * 全部走 `proxyWrite`：上游状态码与响应体原样透出 —— 与 `/schedules/route.ts`
 * 同理，写路径的 4xx 语义（403/404/422）必须能在前端分辨，不能折成
 * `{ready:false}`。
 *
 * 注意路由文件路径：Next App Router 按「文件 = 路径段」匹配，带 `:scheduleId`
 * 的 PATCH 必须落在 `[scheduleId]/route.ts`，否则 `PATCH /api/teams/{tid}/schedules/{sid}`
 * 会 404（症状像「后端没这个端点」，实际是路由没落对位置）。
 */

export const dynamic = 'force-dynamic';

export async function PATCH(req: Request, ctx: { params: Promise<{ teamId: string; scheduleId: string }> }): Promise<NextResponse> {
  const { teamId, scheduleId } = await ctx.params;
  return proxyWrite(
    req,
    teamId,
    {
      path: (tid) =>
        `/api/teams/${encodeURIComponent(tid)}/schedules/${encodeURIComponent(scheduleId)}`,
    },
    'PATCH',
  );
}

export async function DELETE(req: Request, ctx: { params: Promise<{ teamId: string; scheduleId: string }> }): Promise<NextResponse> {
  const { teamId, scheduleId } = await ctx.params;
  return proxyWrite(
    req,
    teamId,
    {
      path: (tid) =>
        `/api/teams/${encodeURIComponent(tid)}/schedules/${encodeURIComponent(scheduleId)}`,
    },
    'DELETE',
  );
}
