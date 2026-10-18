import { NextResponse } from 'next/server';
import { proxyRead } from '@/lib/bff-proxy';

/**
 * BFF：`GET /api/conversations/:convId/messages` —— 拉 Chief 对话历史。
 *
 * 字段以 `apps/server/src/services/conversations.ts` 的
 * `ConversationMessage` 为准（与 `BuildMessage` 同构）：
 *   id / buildId / role / phase / triggerBy / content / agent /
 *   isError / durationMs / seq / createdAt
 *
 * 序列化字段：`agent` 是 `unknown`（Drizzle jsonb），`createdAt` 是 unix ms。
 *
 * 支持 `?sinceSeq=N` 增量游标（见原 chief.md「repeat reads return only
 * incremental changes」）。`proxyRead` 已支持 `query` 透传 —— 上游的
 * `sinceSeq` 直接做 query 转发即可。
 *
 * 与 thread/watches 一样不带 `:teamId`：归属判定在服务端走
 * `build → todo → project → team`。
 */

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ convId: string }> },
): Promise<NextResponse> {
  const { convId } = await ctx.params;
  // 把原始 query（含 `sinceSeq`）原样转发给上游
  const url = new URL(req.url);
  const query = url.search.replace(/^\?/, '');
  return proxyRead(req, '', {
    path: () => `/api/conversations/${encodeURIComponent(convId)}/messages`,
    pick: (body) => (body as { messages?: unknown[] }).messages ?? [],
    ...(query ? { query } : {}),
  });
}