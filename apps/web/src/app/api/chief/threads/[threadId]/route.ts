import { NextResponse } from 'next/server';
import { proxyRead } from '@/lib/bff-proxy';

/**
 * BFF：`GET /api/chief/threads/:threadId` —— 读单条 topic。
 *
 * 注意：上游这个端点不带 `:teamId`，归属判定在服务端走
 * `thread → chief → team`（见 `apps/server/src/routes/chief.ts:538`）。
 *
 * 为什么传空 `teamId`：`proxyRead` 的第二参只在闭包里用，这里完全不需要
 * teamId（path 模板里没有占位符）。传空串让 type system 满意，path 自己
 * 写全，不依赖任何外部团队上下文。
 */

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ threadId: string }> },
): Promise<NextResponse> {
  const { threadId } = await ctx.params;
  return proxyRead(req, '', {
    path: () => `/api/chief/threads/${encodeURIComponent(threadId)}`,
    pick: (body) => (body as { thread?: unknown }).thread,
  });
}