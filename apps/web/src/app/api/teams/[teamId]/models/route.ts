import type { NextResponse } from 'next/server';
import { proxyRead } from '@/lib/bff-proxy';

/**
 * BFF：`GET /api/teams/:teamId/models?runtime=pi` —— 模型目录。
 *
 * Providers 设置页的「模型目录」区块读它。上游是
 * `apps/server/src/routes/providers.ts` 的 `GET /api/teams/:teamId/models`：
 * `runtime=pi`（默认）时把 provider 的模型并集铺平，`usable` 标记该 provider
 * 是否配了 key；`runtime≠pi` 时返回 `{ models: [], source: 'machine-reported' }`
 * （外部 runtime 的模型由机器上报，不能拿 provider 的冒充）。
 *
 * 这一条此前**漏建了**：页面照契约去 fetch，Next 返回 404，
 * 于是「模型目录」区块恒显示未就绪。症状看着像后端没实现，实际是 BFF 少一条路由
 * —— 与当初 `mcp-tools` 同一个坑，所以每个新页面都要把「页面 fetch 的每个 URL」
 * 与「BFF 已注册的路由」逐条对齐，不能只对齐写路径。
 *
 * 只读 → `proxyRead`：404/非 2xx 一律折成 HTTP 200 + `ready:false`，
 * 页面渲染「未就绪」而不是白屏。
 */

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ teamId: string }> },
): Promise<NextResponse> {
  const { teamId } = await ctx.params;
  // runtime 由调用方给（默认 pi）。只接受字面量 pi 与外部 runtime 名 ——
  // 上游对未知 runtime 返回空列表而不是报错，这里保持透传，不猜。
  const runtime = new URL(req.url).searchParams.get('runtime') ?? 'pi';
  return proxyRead(req, teamId, {
    path: (t) => `/api/teams/${encodeURIComponent(t)}/models`,
    query: `runtime=${encodeURIComponent(runtime)}`,
    pick: (b) => (b !== null && typeof b === 'object' && 'models' in b ? b.models : undefined),
  });
}
