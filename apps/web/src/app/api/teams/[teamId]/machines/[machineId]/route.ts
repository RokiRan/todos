import { NextResponse } from 'next/server';
import { proxyWrite } from '@/lib/bff-proxy';

/**
 * BFF：`/api/teams/:teamId/machines/:machineId`
 *
 * 对标 `apps/server/src/routes/machines.ts`：
 *   - `PATCH` 改 `name / buildEnabled / shellEnabled / maxConcurrentTasks`。
 *   - `DELETE` 真删机器（cascade 也清 `machine_runtime_usage`，响应 `note` 字段
 *     透出来给 UI 显示）。
 *
 * 全部走 `proxyWrite` —— 写路径必须原样透出 4xx 状态码：
 *   - 422（参数错 / 闸门值越界）
 *   - 403（跨团队）
 *   - 404（机器不存在）
 *
 * `proxyWrite` 对 DELETE 不带 `content-type` 也不注入 userId（与 projects
 * 删除的写法对齐）。
 */

export const dynamic = 'force-dynamic';

export async function PATCH(req: Request, ctx: { params: Promise<{ teamId: string; machineId: string }> }): Promise<NextResponse> {
  const { teamId, machineId } = await ctx.params;
  return proxyWrite(
    req,
    teamId,
    {
      path: () => `/api/machines/${encodeURIComponent(machineId)}`,
    },
    'PATCH',
  );
}

export async function DELETE(req: Request, ctx: { params: Promise<{ teamId: string; machineId: string }> }): Promise<NextResponse> {
  const { teamId, machineId } = await ctx.params;
  return proxyWrite(
    req,
    teamId,
    {
      path: () => `/api/machines/${encodeURIComponent(machineId)}`,
    },
    'DELETE',
  );
}
