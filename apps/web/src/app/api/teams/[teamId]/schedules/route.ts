import { NextResponse } from 'next/server';
import { proxyRead, proxyWrite } from '@/lib/bff-proxy';

/**
 * BFF：`/api/teams/:teamId/schedules`
 *
 * 列表 + 创建定时规则（对标 `apps/server/src/routes/schedules.ts`）。
 *
 * 用 `proxyRead` / `proxyWrite` 而非手写 fetch：
 *   - 读端点：上游 404/非 2xx 一律折成 HTTP 200 + `{ready:false}`，前端据此
 *     渲染「数据未就绪」占位而不是白屏；与其它只读 BFF 语义一致。
 *   - 写端点：上游状态码与响应体**原样透出**。Schedule 写失败的语义需要
 *     分辨：403（不是 admin）/ 409（todoId 不属于这个 team）/ 422（cron
 *     格式错、时区非法、todoId 不存在、已达 10 条上限）。折成 `ready:false`
 *     会把 `error` 原文吃掉。
 *
 * `proxyRead` 的 `pick` 取 `schedules` 字段 —— 上游 `registerScheduleRoutes`
 * 返回 `{ schedules: SchedulePublic[] }`；POST 端点返回 `{ schedule: ... }`
 * 但这里走的是 `proxyWrite` 直接透传响应体，没有 `pick`。
 */

export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ teamId: string }> }): Promise<NextResponse> {
  const { teamId } = await ctx.params;
  return proxyRead(req, teamId, {
    path: (tid) => `/api/teams/${encodeURIComponent(tid)}/schedules`,
    pick: (b) => {
      // 形状归一化：上游 `{ schedules: ... }`；缺这个字段就当未就绪（proxyRead
      // 对 `pick` 返回 `undefined` 会自动折成 `ready:false`）。
      if (b && typeof b === 'object' && 'schedules' in b) return b.schedules;
      return undefined;
    },
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ teamId: string }> }): Promise<NextResponse> {
  const { teamId } = await ctx.params;
  return proxyWrite(
    req,
    teamId,
    {
      path: (tid) => `/api/teams/${encodeURIComponent(tid)}/schedules`,
    },
    'POST',
  );
}
