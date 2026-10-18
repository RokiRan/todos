import { NextResponse } from 'next/server';
import { proxyWrite } from '@/lib/bff-proxy';

/**
 * BFF：`PUT /api/teams/:teamId/chief/charter` —— 编辑 Chief charter。
 *
 * 上游（`apps/server/src/routes/chief.ts` 的 PUT charter）走
 * `parseBody(CharterBody)`：要求 `userId` 必须等于凭据解析出的 userId，
 * `charter` ≤ 8000 字符。`proxyWrite` 把上游 422（参数错）/ 403（userId
 * 不一致）原样透出 —— UI 用这一点区分「字超了」与「不是本人」。
 */

export const dynamic = 'force-dynamic';

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ teamId: string }> },
): Promise<NextResponse> {
  const { teamId } = await ctx.params;
  return proxyWrite(
    req,
    teamId,
    {
      path: (t) => `/api/teams/${encodeURIComponent(t)}/chief/charter`,
    },
    'PUT',
  );
}