import type { NextResponse } from 'next/server';
import { proxyRead, proxyWrite } from '@/lib/bff-proxy';

/**
 * BFF：`GET/POST /api/teams/:teamId/providers`。
 *
 * 只读代理走 `proxyRead`（标准守卫 / 404→ready:false / 信封归一化），创建走
 * `proxyWrite`（上游 4xx 原样透出）。分开的原因见 `apps/web/src/lib/bff-proxy.ts`
 * 顶部：分散实现会让「4xx 是折 ready:false 还是原样透出」两套规则漂移，写路径
 * 需要的是后者 —— 调用方要能分辨 403 / 409 / 422。
 *
 * `pick` 只挑 `providers` 字段：上游响应是 `{ providers: [...] }`，但前端页面只
 * 关心数组本身，包装对象本身没意义。用 `in` 守卫做窄化，让 TS 在 `pick` 边界推
 * `unknown` 而不是凭空声明形状 —— 上游真返回 `{providers:[...]}` 还是
 * `{items:[...]}` 在这里就有机会被发现，不会被内联断言吞掉。
 *
 * POST 与 GET 同文件而不是拆开：Next App Router 的路由段就是文件，
 * `[providerId]/route.ts` 只负责单条操作，集合级的新增必须落在这里 ——
 * 漏掉它的话页面的「新增 provider」会拿到 405，症状看着像「后端不支持创建」。
 */

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ teamId: string }> },
): Promise<NextResponse> {
  const { teamId } = await ctx.params;
  return proxyRead(req, teamId, {
    path: (t) => `/api/teams/${encodeURIComponent(t)}/providers`,
    pick: (b) =>
      b !== null && typeof b === 'object' && 'providers' in b ? b.providers : undefined,
  });
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ teamId: string }> },
): Promise<NextResponse> {
  const { teamId } = await ctx.params;
  // 浏览器**不**发 userId：由 proxyWrite 从 cookie 解析出的身份注入
  // （上游 CreateProviderBody 把它声明成必填，但它又是不可信输入）。
  return proxyWrite(
    req,
    teamId,
    { path: (t) => `/api/teams/${encodeURIComponent(t)}/providers` },
    'POST',
  );
}