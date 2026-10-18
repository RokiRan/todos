import { NextResponse } from 'next/server';
import { proxyRead } from '@/lib/bff-proxy';

/**
 * BFF：`GET /api/chief/threads/:threadId/watches` —— 当前 topic 在 watch 的 todos。
 *
 * 上游（`apps/server/src/routes/chief.ts:665` GET watches）返回
 * `{ watches: [{ id, phase, title, seqNum, projectId, updatedAt }] }`，
 * 字段与 `Todo` 近似（没有 spec/owner 等）。`phase` 字段是 `TodoPhase`
 * 字符串，UI 用 `lib/api.ts` 的 `PHASE_COLUMNS` 转中文标签。
 *
 * 同单条 thread：不带 `:teamId`，归属由服务端走 `thread → chief → team`。
 */

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ threadId: string }> },
): Promise<NextResponse> {
  const { threadId } = await ctx.params;
  return proxyRead(req, '', {
    path: () => `/api/chief/threads/${encodeURIComponent(threadId)}/watches`,
    pick: (body) => (body as { watches?: unknown[] }).watches ?? [],
  });
}