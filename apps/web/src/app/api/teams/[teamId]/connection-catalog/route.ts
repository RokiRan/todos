import { NextResponse } from 'next/server';
import { proxyRead } from '@/lib/bff-proxy';

/**
 * BFF：`/api/teams/:teamId/connection-catalog`
 *
 * 只读代理到 `apps/server/src/routes/connection-catalog.ts`。
 *
 * 形态与 `app/api/teams/[teamId]/projects/route.ts` 一致：`pick` 把上游
 * `{ catalog, categories, teamConnectionCount, limit }` 整包当作 `data`
 * 转发，**不挑字段** —— `catalog` 数组 + `categories` 顺序必须**逐字段**
 * 与上游一致，前端要用 `catalog.length` / `categories` 渲染筛选。
 *
 * 与 `[teamId]/projects/route.ts` 不同的是：本端点没有写路径 —— 用户在
 * Connection 目录页点的「连接」按钮**不会**真正发起 OAuth，那条流程是另一
 * 个数量级的工程，本切片按 assignment 只把目录数据送过去 + UI 上诚实说明
 * 一键登录尚未接通。
 */

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ teamId: string }> },
): Promise<NextResponse> {
  const { teamId } = await ctx.params;
  return proxyRead(req, teamId, {
    path: (t) => `/api/teams/${encodeURIComponent(t)}/connection-catalog`,
    // 整包透传 —— 上游形状固定，缺失任一字段视为「malformed-payload」。
    pick: (b) => {
      if (b === null || typeof b !== 'object') return undefined;
      const o = b as Record<string, unknown>;
      if (!Array.isArray(o['catalog'])) return undefined;
      if (!Array.isArray(o['categories'])) return undefined;
      if (typeof o['teamConnectionCount'] !== 'number') return undefined;
      if (typeof o['limit'] !== 'number') return undefined;
      return o;
    },
  });
}
