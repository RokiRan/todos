import { NextResponse } from 'next/server';
import { proxyWrite } from '@/lib/bff-proxy';

/**
 * BFF：单个 skill 的改名 / 覆盖 SKILL.md + 删除。
 *
 * 上游 `PATCH /api/teams/:teamId/skills/:skillId` 仅接受 `{userId, name?, skillMd?}`
 * （两个都不传会被后端判 422 `no-op update`），所以前端把两个字段都留空时这里
 * 也是空 body，服务端会原样拒绝 —— 错误由 422 原样回到页面，符合写路径契约。
 *
 * 删除走 `DELETE`，无 body。两侧都不带 `content-type` 避免 Fastify 在无 body
 * DELETE 上误判 400。
 */

export const dynamic = 'force-dynamic';

export async function PATCH(req: Request, ctx: { params: Promise<{ teamId: string; skillId: string }> }): Promise<NextResponse> {
  const { teamId, skillId } = await ctx.params;
  return proxyWrite(req, teamId, { path: (t) => `/api/teams/${t}/skills/${skillId}` }, 'PATCH');
}

export async function DELETE(req: Request, ctx: { params: Promise<{ teamId: string; skillId: string }> }): Promise<NextResponse> {
  const { teamId, skillId } = await ctx.params;
  return proxyWrite(req, teamId, { path: (t) => `/api/teams/${t}/skills/${skillId}` }, 'DELETE');
}
