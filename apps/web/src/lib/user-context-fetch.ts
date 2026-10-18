import { API_BASE } from '@/lib/api';
import { forwardAuthHeaders } from '@/lib/bff-auth';

/**
 * BFF 侧的凭据身份解析（**只在服务端跑**，绝不进浏览器包）。
 *
 * 存在的理由：写路径的上游 schema 把 `userId` 声明成必填（`z.string().min(1)`），
 * 但 `userId` 本身是**不可信输入** —— 后端 `actorForTeam` 会拿它与凭据所有者比对，
 * 不等就 403。所以正确的形状是「浏览器不发 userId，BFF 从 cookie 推导后填进去」。
 * 这个模块就是那个推导，唯一实现在 `lib/bff-proxy.ts` 的 `proxyWrite` 里调用。
 *
 * 为什么单独一个模块而不内联：`app/api/user/context/route.ts` 是给浏览器用的 HTTP 端点，
 * 它自己也要调后端的同一个端点。若把 fetch 写在 `bff-proxy.ts` 里，
 * 「BFF → BFF」会形成一条容易误读的调用链；单独立文件把「服务端如何取身份」这件事
 * 收敛到一处，注释也集中。
 *
 * 失败即 null：调用方据此回 401 —— 身份取不到就不该继续写，静默用空串会让上游
 * 报一个含义错误的 422（`String must contain at least 1 character(s)`），
 * 排查方向会跑偏。
 */
export interface ServerIdentity {
  userId: string;
  email: string;
}

export async function fetchUserContext(req: Request): Promise<ServerIdentity | null> {
  try {
    const res = await fetch(`${API_BASE}/api/user/context`, {
      headers: { Accept: 'application/json', ...forwardAuthHeaders(req) },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { userId?: unknown; email?: unknown };
    if (typeof body.userId !== 'string' || body.userId.length === 0) return null;
    return {
      userId: body.userId,
      email: typeof body.email === 'string' ? body.email : '',
    };
  } catch {
    // 后端不可达 —— 与「拿不到身份」同等处理：不能在无法确认身份时写库
    return null;
  }
}
