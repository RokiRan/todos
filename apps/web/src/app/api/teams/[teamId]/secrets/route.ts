import { NextResponse } from 'next/server';
import { API_BASE } from '@/lib/api';
import { isAuthed, unauthorized } from '@/lib/auth';
import { forwardAuthHeaders } from '@/lib/bff-auth';
import { proxyRead, proxyWrite } from '@/lib/bff-proxy';

/**
 * BFF：`GET/POST /api/teams/:teamId/secrets`、`DELETE`（批量，按 `{scope,names}`）。
 *
 * GET / POST 走 `proxyRead` / `proxyWrite`（参见 `lib/bff-proxy.ts` 顶部的两种
 * 失败语义注解）。
 *
 * **DELETE 不能用 `proxyWrite`** —— `proxyWrite` 在 `method === 'DELETE'` 时
 * 把客户端请求体**转成 query string** 转发（避免给一个没有 body 的 DELETE 误塞
 * `content-type: application/json`，否则部分上游会在无 body 时返回 400）。
 * 但本端点的 `DELETE /api/teams/:teamId/secrets` 是**有 body 的**：
 * 服务端 `DeleteSecretsBody.safeParse(req.body)` 直接读 `req.body`，不读 query，
 * 所以把 body 折成 query 会让 422 变成「schema 不匹配」而不是有信息量的报错，
 * 且 `scope=team&names=A&names=B` 这种数组语义在 query 上也是脆的（后端不解析）。
 *
 * 因此 DELETE 这一支**自己手写转发**：
 *   - 显式 `isAuthed` + `forwardAuthHeaders` 守卫
 *   - 请求体原样转发（由浏览器 JSON.stringify，**不发 userId**，后端
 *     `actorForTeam` 会从 cookie 推出身份）
 *   - 上游状态码与响应体原样透出（写路径契约：必须能分辨 403/409/422）
 *
 * 「写路径原样透出失败码」的契约与 `proxyWrite` 一致 —— 浏览器据此渲染
 * 「403 需要管理员」/「409 同名冲突 → 是否覆盖？」/「422 name 不合法」等具体提示，
 * 不被折成 `ready:false` 那种抽象原因。
 */

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ teamId: string }> },
): Promise<NextResponse> {
  const { teamId } = await ctx.params;
  return proxyRead(req, teamId, {
    path: (t) => `/api/teams/${encodeURIComponent(t)}/secrets`,
    // `pick` 只挑 `secrets` 字段：上游响应是 `{secrets: [...]}`，前端页面
    // 只关心数组本身。窄化理由见 providers/route.ts。
    pick: (b) =>
      b !== null && typeof b === 'object' && 'secrets' in b ? b.secrets : undefined,
  });
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ teamId: string }> },
): Promise<NextResponse> {
  const { teamId } = await ctx.params;
  // 浏览器**不**发 userId：由 proxyWrite 从 cookie 注入身份。
  // 后端 `SetSecretBody` 把 userId 声明成必填，但 userId 是不可信输入
  // （`actorForTeam` 会与凭据所有者比对，不等就 403）。
  return proxyWrite(
    req,
    teamId,
    { path: (t) => `/api/teams/${encodeURIComponent(t)}/secrets` },
    'POST',
  );
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ teamId: string }> },
): Promise<NextResponse> {
  if (!isAuthed(req)) return unauthorized();
  const { teamId } = await ctx.params;
  try {
    const raw = await req.text();
    let outgoing: string;
    if (raw.length === 0) {
      // 没有 body：让上游自己出 422（缺 scope/names），不要在 BFF 里猜默认值。
      outgoing = '{}';
    } else {
      try {
        const decoded: unknown = JSON.parse(raw);
        // 与 proxyWrite 一致：必须是 JSON 对象；数组/字符串/数字原样透传
        // 让上游拒绝 —— BFF 不重写请求体（身份字段在 DELETE 上不注入）。
        if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
          return NextResponse.json(
            { error: 'request body must be a JSON object' },
            { status: 400 },
          );
        }
        outgoing = raw;
      } catch {
        return NextResponse.json(
          { error: 'request body is not valid JSON' },
          { status: 400 },
        );
      }
    }

    const res = await fetch(
      `${API_BASE}/api/teams/${encodeURIComponent(teamId)}/secrets`,
      {
        method: 'DELETE',
        headers: {
          Accept: 'application/json',
          'content-type': 'application/json',
          ...forwardAuthHeaders(req),
        },
        body: outgoing,
        cache: 'no-store',
      },
    );
    const data = (await res.json().catch(() => ({}))) as unknown;
    return NextResponse.json(data, {
      status: res.status,
      headers: { 'cache-control': 'no-store' },
    });
  } catch (err) {
    return NextResponse.json(
      { ready: false, reason: err instanceof Error ? err.name : 'unknown' },
      { status: 200 },
    );
  }
}