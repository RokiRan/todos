import { NextResponse } from 'next/server';
import { proxyWrite } from '@/lib/bff-proxy';

/**
 * BFF：`/api/teams/:teamId/projects/:projectId`
 *
 * 单条项目的 PATCH / DELETE（对标 `apps/server/src/routes/projects.ts`）。
 *
 * 全部走 `proxyWrite`：
 *   - PATCH 写失败（403 非 admin / 422 字段错）必须能看到后端原文，
 *     proxyRead 的 `ready:false` 折法会把 error 吃掉。
 *   - DELETE 成功 `{ok:true, deleted, deletedTodos}` —— 把删除量级透回前端，
 *     UI 二次确认对话框的措辞靠这字段。不带 body，proxyWrite 已处理
 *     `content-type` 的有无问题（Fastify 在无 body DELETE 上一律不带
 *     `content-type`，硬塞会 400）。
 *
 * 注意：路径段是 `[projectId]`（与后端 `:projectId` 对齐），
 * **不是** `[id]` —— 上游路由用 projectId 而非内部 id 拼路径。
 */

export const dynamic = 'force-dynamic';

export async function PATCH(req: Request, ctx: { params: Promise<{ teamId: string; projectId: string }> }): Promise<NextResponse> {
  const { teamId, projectId } = await ctx.params;
  return proxyWrite(
    req,
    teamId,
    {
      path: (t) =>
        `/api/teams/${encodeURIComponent(t)}/projects/${encodeURIComponent(projectId)}`,
    },
    'PATCH',
  );
}

export async function DELETE(req: Request, ctx: { params: Promise<{ teamId: string; projectId: string }> }): Promise<NextResponse> {
  const { teamId, projectId } = await ctx.params;
  return proxyWrite(
    req,
    teamId,
    {
      path: (t) =>
        `/api/teams/${encodeURIComponent(t)}/projects/${encodeURIComponent(projectId)}`,
    },
    'DELETE',
  );
}
