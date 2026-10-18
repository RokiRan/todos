import type { NextResponse } from 'next/server';
import { proxyWrite } from '@/lib/bff-proxy';

/**
 * BFF：`POST /api/todos/:id/feedback`。
 *
 * 闸门内「文字反馈」专用 —— 写路径必须走 `proxyWrite` 让 4xx 原样透出：
 *   - 409：当前 phase 不是 confirm / review（`feedback only valid inside a gate`）
 *   - 422：message 长度越界（上游 `FeedbackBody.message.max(8000)`）
 *   - 403 / 404：归属 / 不存在
 *
 * **铁律语义**（业务层兜底在 `services/builds.ts` 的 `messageTodo`，前端必须配合）：
 *   - 上游收到 `message` 之后**永远停在同一闸门**，phase 不推进
 *   - 仅落一条 `kind='input'` 文档、派一个修订 build，AI 据此重新规划
 *   - 所以前端文案必须告诉用户：「在这里输入文字（包括写"确认"）**只是修订反馈**，
 *     不会放行当前计划；要放行请点上面的按钮」。
 *
 * 上游：`apps/server/src/routes/todos.ts:387` `POST /api/todos/:todoId/feedback`。
 */

export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  return proxyWrite(
    req,
    '',
    {
      path: () => `/api/todos/${encodeURIComponent(id)}/feedback`,
    },
    'POST',
  );
}