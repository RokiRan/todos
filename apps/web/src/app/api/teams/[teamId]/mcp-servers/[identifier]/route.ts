import { NextResponse } from 'next/server';
import { proxyWrite } from '@/lib/bff-proxy';

/**
 * BFF：单个 MCP server 的编辑 + 删除（按 identifier）。
 *
 * 上游 `PATCH /api/teams/:teamId/mcp-servers/:identifier` 只接受
 * `{label?, config?, expiresAt?}` —— identifier / transport / endpoint 都不可改
 * （写阅契约）。**凭据 `config` 是按键合并**：
 *   - 不传（undefined / null / `{}`）→ 完全不动
 *   - 传 `{"Authorization": "Bearer xyz"}` → 只覆盖 Authorization，其他键保留
 *   - 传 `{"Authorization": ""}` → 用空串覆盖该键（**没有专用的删除 API**，要清掉
 *     一个键只能用空串盖写；本切片在 UI 上注明这一点）
 *
 * 删除走 `DELETE`，路径参数是 identifier；无 body。
 *   两侧都不带 `content-type` 避免 Fastify 在无 body DELETE 上误判 400。
 */

export const dynamic = 'force-dynamic';

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ teamId: string; identifier: string }> },
): Promise<NextResponse> {
  const { teamId, identifier } = await ctx.params;
  return proxyWrite(
    req,
    teamId,
    {
      path: (t) => `/api/teams/${encodeURIComponent(t)}/mcp-servers/${encodeURIComponent(identifier)}`,
    },
    'PATCH',
  );
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ teamId: string; identifier: string }> },
): Promise<NextResponse> {
  const { teamId, identifier } = await ctx.params;
  return proxyWrite(
    req,
    teamId,
    {
      path: (t) => `/api/teams/${encodeURIComponent(t)}/mcp-servers/${encodeURIComponent(identifier)}`,
    },
    'DELETE',
  );
}