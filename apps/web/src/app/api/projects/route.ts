import { NextResponse } from 'next/server';
import { API_BASE } from '@/lib/api';
import { isAuthed, unauthorized } from '@/lib/auth';
import { forwardAuthHeaders } from '@/lib/bff-auth';

/**
 * BFF：`GET /api/projects?teamId=...` —— 列出某团队下的项目，供新建 todo 表单的下拉框用。
 *
 * **为什么不用 `proxyRead`**：`proxyRead` 是按「路径里就有 teamId」的团队级资源
 * 模板（`/api/teams/:teamId/...`）。本端点是查询参数带 teamId —— 新建 todo 表单在
 * settings layout 之外（`app/new-todo/page.tsx`），不能用 `useTeamContext`，只能自己
 * fetch `/api/user/context` 拿 teamId 后再调这条 BFF。所以这里手写一个轻量 GET：
 *   1. 取 `?teamId=` 并校验非空
 *   2. 转发到上游 `/api/teams/:teamId/projects`
 *   3. 归一化 `{projects: [...]}` → 裸数组，与前端 list 习惯一致
 *   4. 上游 404/5xx → `{ready:false}` + HTTP 200（与其它只读 BFF 一致，让页面能
 *      显示「数据未就绪」占位而不是白屏）
 *
 * 信任边界：teamId 在 URL 上看起来可被客户端篡改，但后端 `actorForTeam` 会做
 * 「凭据 → 用户 → 是该 team 成员」的判定；这里转给上游就够了，不要在 BFF 里再判
 * 一次（否则两边漂移）。
 *
 * `pick` 不抽 `bi`：`projects` 字段名与 MCP 投影同字面量，是契约的一部分。
 */

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<NextResponse> {
  if (!isAuthed(req)) return unauthorized();
  const url = new URL(req.url);
  const teamId = url.searchParams.get('teamId');
  if (!teamId) {
    return NextResponse.json(
      { ready: false, reason: 'missing-teamId' },
      { status: 200 },
    );
  }
  try {
    const res = await fetch(
      `${API_BASE}/api/teams/${encodeURIComponent(teamId)}/projects`,
      {
        headers: { Accept: 'application/json', ...forwardAuthHeaders(req) },
        cache: 'no-store',
      },
    );
    if (res.status === 404) {
      return NextResponse.json(
        { ready: false, reason: 'endpoint-not-implemented' },
        { status: 200 },
      );
    }
    if (!res.ok) {
      return NextResponse.json(
        { ready: false, reason: `http-${res.status}` },
        { status: 200 },
      );
    }
    const body = (await res.json()) as { projects?: unknown[] };
    const list = Array.isArray(body.projects) ? body.projects : [];
    return NextResponse.json({ ready: true, data: list });
  } catch (err) {
    return NextResponse.json(
      { ready: false, reason: err instanceof Error ? err.name : 'unknown' },
      { status: 200 },
    );
  }
}