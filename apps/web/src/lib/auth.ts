import { NextResponse } from 'next/server';

/**
 * 简单 token 认证 —— 单人使用场景的刻意简化。
 *
 * 目标（用户明确要求）：**够用就好**，不引入 session / OAuth / 用户体系。
 * 原站用 NextAuth + Google/GitHub OAuth 三选一 —— 那是为了多用户 SaaS，
 * 我们单人本地用，引入它只会增加复杂度而不带来任何好处。
 *
 * 机制：
 *   - 服务端用 `TDS_WEB_TOKEN` 环境变量持有 token
 *   - 浏览器侧存 cookie `tds_token`（httpOnly，由 /api/auth 端点下发）
 *   - BFF 路由在转发前校验 cookie；不匹配返回 401
 *
 * 为什么存 cookie 而不是 localStorage：
 *   - httpOnly cookie 不能被 XSS 读到，而 localStorage 可以
 *   - PWA 独立窗口启动时也能带上（localStorage 依赖同源，但 cookie 更标准）
 *
 * 未配置 `TDS_WEB_TOKEN` 时**放行全部请求**：
 * 本地开发不想被 token 卡住。这是刻意的开发态行为，不是漏洞 ——
 * 生产部署必须设置该变量，且 `.env.example` 里已写明。
 *
 * 后端（`apps/server`）现在**自己也鉴权**（`src/main.ts` 的全局 preHandler +
 * `src/auth.ts`）：这一层 `isAuthed` 只是给未登录的浏览器一个早退的 401，
 * 真正的边界在后端。绕过 BFF 直连后端、或 BFF 因未配 token 而放行，后端照样
 * 401。前提是两边读同一个 `TDS_WEB_TOKEN`（同机部署就是同一个环境变量）。
 */

const COOKIE_NAME = 'tds_token';
/** cookie 有效期 30 天，够单人日常使用，不用频繁重登。 */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function expectedToken(): string | null {
  return process.env.TDS_WEB_TOKEN?.trim() || null;
}

export function readTokenCookie(req: Request): string | null {
  const raw = req.headers.get('cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE_NAME) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/**
 * 校验请求是否已认证。
 * 未配置 token → 返回 true（开发态放行）。
 */
export function isAuthed(req: Request): boolean {
  const expected = expectedToken();
  if (!expected) return true;
  return readTokenCookie(req) === expected;
}

/** 401 响应 —— BFF 统一用它，客户端据此跳转登录。 */
export function unauthorized(): NextResponse {
  return NextResponse.json(
    { ready: false, reason: 'unauthorized' },
    { status: 401 },
  );
}

/**
 * 给 BFF 路由用的守卫包装。
 * 未认证直接返回 401，否则放行到实际 handler。
 */
export async function withAuth(
  req: Request,
  handler: () => Promise<NextResponse>,
): Promise<NextResponse> {
  if (!isAuthed(req)) return unauthorized();
  return handler();
}

interface LoginBody {
  token: string;
}

/**
 * cookie 的 `Secure` 标记判定 —— 为什么不能用 `NODE_ENV === 'production'`：
 *
 * 局域网部署是「生产模式 + 纯 HTTP」的组合（`next start` 时 NODE_ENV 就是
 * production，但没人给你配 HTTPS 证书）。`Secure` cookie 在 `http://` 下会被
 * 浏览器**直接丢弃**：登录 POST 返回 200、`{ok:true}`，但 cookie 存不下来，
 * 页面永远停在登录页。实测踩过（树莓派 10.0.0.191:3100）。
 *
 * 之所以在 Windows 上没暴露：Chrome 把 `http://127.0.0.1` 当安全上下文，
 * Secure cookie 照样存。换成局域网 IP 就露馅了。
 *
 * 判定顺序：反向代理的 `x-forwarded-proto`（有代理时它才是真相）→ 请求 URL
 * 自己的 scheme（直连时即真相）。
 */
function requestIsSecure(req: Request): boolean {
  const forwarded = req.headers.get('x-forwarded-proto');
  if (forwarded) return forwarded.split(',')[0]?.trim() === 'https';
  try {
    return new URL(req.url).protocol === 'https:';
  } catch {
    // req.url 不是绝对 URL（少见形态）：宁可不加 Secure，也不要登录失效。
    return false;
  }
}

/**
 * `POST /api/auth/login` —— 校验并下发 cookie。
 * 值错误的请求一律 401，不区分「token 不存在」与「token 不匹配」
 * （避免变成 token 探测接口）。
 */
export async function handleLogin(req: Request): Promise<NextResponse> {
  const expected = expectedToken();
  let provided = '';
  try {
    const body = (await req.json()) as LoginBody;
    provided = typeof body?.token === 'string' ? body.token.trim() : '';
  } catch {
    return unauthorized();
  }

  // 未配置 token：登录页直接通过（开发态）
  if (!expected) return NextResponse.json({ ok: true, required: false });

  if (!provided || provided !== expected) return unauthorized();

  const res = NextResponse.json({ ok: true, required: true });
  res.cookies.set(COOKIE_NAME, provided, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
    // Secure 必须跟**实际协议**走，不能跟 NODE_ENV 走 —— 见 requestIsSecure。
    secure: requestIsSecure(req),
  });
  return res;
}

/** `POST /api/auth/logout` —— 清 cookie。 */
export async function handleLogout(): Promise<NextResponse> {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, '', { httpOnly: true, path: '/', maxAge: 0 });
  return res;
}

/** `GET /api/auth/session` —— 前端用它决定显示登录页还是主界面。 */
export async function handleSession(req: Request): Promise<NextResponse> {
  const expected = expectedToken();
  if (!expected) return NextResponse.json({ required: false, authed: true });
  return NextResponse.json({
    required: true,
    authed: readTokenCookie(req) === expected,
  });
}
