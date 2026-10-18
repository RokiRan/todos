import type { NextResponse } from 'next/server';
import { proxyWrite } from '@/lib/bff-proxy';

/**
 * BFF：`PATCH/DELETE /api/teams/:teamId/providers/:providerId`。
 *
 * 写路径。**写路径必须用 `proxyWrite`** —— 它会把上游 4xx 原样透出，而不是像
 * 只读代理那样折成 `{ready:false}`。原因：写失败时调用方要能分辨 403（无权）/
 * 409（重试无意义）/ 422（参数错，例如 20 个上限 / key 非 ASCII / 校验失败），
 * 把状态码吃掉会让用户看不出到底改不了什么。
 *
 * DELETE 不带 body —— `proxyWrite` 已经处理好「无 body 不塞 content-type」的细节
 * （参见 `bff-proxy.ts` 里的注释），这里只需声明 path 与 method。
 */

export const dynamic = 'force-dynamic';

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ teamId: string; providerId: string }> },
): Promise<NextResponse> {
  const { teamId, providerId } = await ctx.params;
  return proxyWrite(
    req,
    teamId,
    {
      path: (t) => `/api/teams/${encodeURIComponent(t)}/providers/${encodeURIComponent(providerId)}`,
    },
    'PATCH',
  );
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ teamId: string; providerId: string }> },
): Promise<NextResponse> {
  const { teamId, providerId } = await ctx.params;
  return proxyWrite(
    req,
    teamId,
    {
      path: (t) => `/api/teams/${encodeURIComponent(t)}/providers/${encodeURIComponent(providerId)}`,
    },
    'DELETE',
  );
}