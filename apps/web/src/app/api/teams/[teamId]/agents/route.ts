import type { NextResponse } from 'next/server';
import { proxyRead, proxyWrite } from '@/lib/bff-proxy';

/**
 * BFF：`GET/POST /api/teams/:teamId/agents`。
 *
 * 列表走 `proxyRead`（404/非 2xx 一律折成 `{ready:false}`），新建走 `proxyWrite`
 * （上游 4xx 原样透出：403 = 非 admin、422 = 校验失败）。写路径**绝对不要用
 * `proxyRead`** —— 那种折法会把 403 吞成「数据未就绪」占位，让用户分辨不出
 * 「没权限」与「后端挂了」。
 *
 * `pick` 只挑 `agents` 字段：上游包了 `{agents: [...]}`，但调用方只关心数组，
 * 包一层对象没意义 —— 与 providers 列表的写法同源。
 *
 * POST 注入 userId 由 `proxyWrite` 完成，浏览器**绝不**发 userId。
 */

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ teamId: string }> },
): Promise<NextResponse> {
  const { teamId } = await ctx.params;
  return proxyRead(req, teamId, {
    path: (t) => `/api/teams/${encodeURIComponent(t)}/agents`,
    pick: (b) =>
      b !== null && typeof b === 'object' && 'agents' in b ? b['agents'] : undefined,
  });
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ teamId: string }> },
): Promise<NextResponse> {
  const { teamId } = await ctx.params;
  return proxyWrite(
    req,
    teamId,
    { path: (t) => `/api/teams/${encodeURIComponent(t)}/agents` },
    'POST',
  );
}