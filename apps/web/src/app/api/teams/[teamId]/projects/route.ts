import { NextResponse } from 'next/server';
import { proxyRead, proxyWrite } from '@/lib/bff-proxy';

/**
 * BFF：`/api/teams/:teamId/projects`
 *
 * 列表 + 创建（对标 `apps/server/src/routes/projects.ts`）。
 *
 * 与 `apps/web/src/app/api/projects/route.ts`（顶层 `?teamId=`）**共存**而非合并：
 *   - `app/api/projects/route.ts`：只读、`?teamId=` 形态，被 `app/new-todo/page.tsx`
 *     消费 —— 该页面在 settings layout 之外拿不到 `useTeamContext`，只能显式拿
 *     teamId 后查一次列表去填「项目下拉」。它是「只给新建 todo 表单用的一次性只读视图」，
 *     **不做写路径**。
 *   - 本文件（`app/api/teams/[teamId]/projects/route.ts`）：路径里带 teamId 的标准
 *     团队资源形态，被 settings/projects 页面消费 —— 该页面有 `useTeamContext`，
 *     写法与 skills / schedules 完全一致（`proxyRead` / `proxyWrite`），既能
 *     列表也能创建/编辑/删除。
 *
 * 强行合并会逼 new-todo 改用 `useTeamContext`（破坏「settings 之外不依赖 layout
 * 的 Provider」的现有约定 —— 见 `app/settings/layout.tsx` 顶部的注释），
 * 或者让 settings 改用 `?teamId=`（破坏它与 skills/schedules 的形态一致）。
 * 两套路由的差异只是「URL 形态不同」，语义都是「列某团队下的项目」。
 *
 * `proxyRead` 用 `pick` 取 `projects` 字段；`proxyWrite` 不做 `pick`，4xx 原样
 * 透出（创建失败的 422 参数错必须能看到后端原文）。
 */

export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ teamId: string }> }): Promise<NextResponse> {
  const { teamId } = await ctx.params;
  return proxyRead(req, teamId, {
    path: (t) => `/api/teams/${encodeURIComponent(t)}/projects`,
    pick: (b) => {
      // 上游形状：`{ projects: [...] }`。缺字段时 `pick` 返回 undefined 让
      // proxyRead 自动折成 `ready:false`，不要在这里猜。
      if (b !== null && typeof b === 'object' && 'projects' in b) {
        const projects = b['projects'];
        return Array.isArray(projects) ? projects : undefined;
      }
      return undefined;
    },
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ teamId: string }> }): Promise<NextResponse> {
  const { teamId } = await ctx.params;
  return proxyWrite(
    req,
    teamId,
    { path: (t) => `/api/teams/${encodeURIComponent(t)}/projects` },
    'POST',
  );
}
