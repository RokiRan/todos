import { NextResponse } from 'next/server';
import { proxyWrite } from '@/lib/bff-proxy';

/**
 * BFF：`POST /api/chief/threads/:threadId/messages` —— 调模型跑一轮对话。
 *
 * 上游（`apps/server/src/routes/chief.ts:741` POST messages）会真调
 * `runChiefTurnWithPersistence`，**单次调用几十秒起**，且依赖上游模型可达：
 *   - `ModelCallError` → 上游 502 `model call failed (code): message`。
 *     UI 必须把这个当成「依赖挂了」而不是「服务端 bug」。
 *   - thread 不存在 → 上游 404，原样透出。
 *   - thread 在但不在你的团队 → 上游 403，原样透出。
 *
 * 注意此端点不带 `:teamId` —— 归属判定在服务端用 `thread → chief → team`
 * 内部反查。`proxyWrite` 第二参传空串，path 模板自己写全。
 */

export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ threadId: string }> },
): Promise<NextResponse> {
  const { threadId } = await ctx.params;
  return proxyWrite(
    req,
    '',
    {
      path: () => `/api/chief/threads/${encodeURIComponent(threadId)}/messages`,
    },
    'POST',
  );
}