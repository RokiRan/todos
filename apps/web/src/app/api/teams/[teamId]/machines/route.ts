import { NextResponse } from 'next/server';
import { proxyRead } from '@/lib/bff-proxy';

/**
 * BFF：`/api/teams/:teamId/machines`
 *
 * 对标 `apps/server/src/routes/machines.ts`：
 *   - `GET` 列出该团队的机器（**不含凭据字段**，由上游 listColumns 白名单保证）。
 *
 * **机器不是 Web 创建的**：`routes/machine.ts` 的 `POST /api/machine/enroll`
 * 才是真实入队路径 —— UI 只展示、不在这里新增。所以 GET 之外的方法显式
 * 405 防止和「真写」混淆：UI 的开关改 `.../[machineId]/route.ts`。
 *
 * 鉴权：BFF 入口已受 cookie 约束；上游再做一次 `requireTeamMembership`，
 * 跨团队访问会变 403 而不被本接口改写。
 */

export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ teamId: string }> }): Promise<NextResponse> {
  const { teamId } = await ctx.params;
  return proxyRead(req, teamId, {
    path: (t) => `/api/machines?teamId=${encodeURIComponent(t)}`,
    pick: (b) => {
      if (b !== null && typeof b === 'object' && 'machines' in b) {
        const list = b['machines'];
        return Array.isArray(list) ? list : undefined;
      }
      return undefined;
    },
  });
}

export async function POST(): Promise<NextResponse> {
  return NextResponse.json(
    { error: 'machines are enrolled, not created via web' },
    { status: 405, headers: { allow: 'GET' } },
  );
}

export async function PUT(): Promise<NextResponse> {
  return NextResponse.json(
    { error: 'PUT is not supported on this resource' },
    { status: 405, headers: { allow: 'GET' } },
  );
}
