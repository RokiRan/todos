import { NextResponse } from 'next/server';
import { API_BASE } from '@/lib/api';
import { isAuthed, unauthorized } from '@/lib/auth';
import { forwardAuthHeaders } from '@/lib/bff-auth';
import { fetchUserContext } from '@/lib/user-context-fetch';

/**
 * 团队级资源 BFF 路由的**共享实现**。
 *
 * 为什么不逐条手写：本文件导出之前，`apps/web/src/app/api/` 下已有 12 条转发路由，
 * 每条都把「守卫 → 取 cookie → fetch → 判 404 → 归一化信封 → catch」抄了一遍。
 * 抄写本身不是问题，**漂移**才是 —— 已经出现过 `todos/route.ts` 用内联 cookie
 * 转发而 `mcp-tools/route.ts` 走 `forwardAuthHeaders`，两条规则并存；以及
 * `api-keys` 把 4xx 原样透出、其余折成 `ready:false`，调用方得逐条记住差异。
 * 抽到这里之后，新增路由只需声明「上游路径 + 怎么取数据字段」，两类失败语义
 * 由 `mode` 显式选定，不再靠记忆。
 *
 * 两种失败语义（**刻意分开，不要合并**）：
 *   - `read`（默认）：只读列表。上游 404/非 2xx → `{ready:false, reason}` + **HTTP 200**。
 *     客户端据此渲染「数据未就绪」占位而不是白屏。
 *   - `write`：写路径。上游状态码**原样透出**、响应体原样透出。写失败时调用方
 *     必须能区分 409（重试无意义）/ 403（无权）/ 422（参数错），折成
 *     `ready:false` 就把原因吃掉了 —— 这正是 api-keys 路由当年单独处理的理由。
 */

/** 上游响应体归一化：从 `{ key: value }` 里取 `value`，或直接把裸数组/对象当数据。 */
export type DataPicker = (body: unknown) => unknown;

export interface ProxyOptions {
  /**
   * 上游路径模板。`{teamId}` 会被替换成经 `encodeURIComponent` 的团队 id。
   * 不用 `:param` 风格是因为这是字符串模板而非路由匹配器。
   */
  path: (teamId: string) => string;
  /** 读响应体 → 取出要包进 `{ready,data}` 的那个字段。省略则原样透传。 */
  pick?: DataPicker;
  /**
   * 额外 query 参数（已编码的 `a=b&c=d`）。用于 `?runtime=pi` 之类。
   * 注意：**不要**把身份参数（userId/teamId）塞进这里 —— 身份必须来自 cookie。
   */
  query?: string;
}

function buildUpstreamUrl(path: string, query?: string): string {
  const url = new URL(`${API_BASE}${path}`);
  if (query) {
    for (const [k, v] of new URLSearchParams(query)) url.searchParams.set(k, v);
  }
  return url.toString();
}

/** GET：只读代理。恒返回 HTTP 200 + `{ready,data|reason}`。 */
export async function proxyRead(
  req: Request,
  teamId: string,
  opts: ProxyOptions,
): Promise<NextResponse> {
  if (!isAuthed(req)) return unauthorized();
  const upstreamPath = opts.path(teamId);
  try {
    const res = await fetch(buildUpstreamUrl(upstreamPath, opts.query), {
      headers: { Accept: 'application/json', ...forwardAuthHeaders(req) },
      cache: 'no-store',
    });
    if (res.status === 404) {
      return NextResponse.json(
        { ready: false, reason: 'endpoint-not-implemented' },
        { status: 200 },
      );
    }
    if (!res.ok) {
      return NextResponse.json({ ready: false, reason: `http-${res.status}` }, { status: 200 });
    }
    const body = (await res.json()) as unknown;
    const data = opts.pick ? opts.pick(body) : body;
    if (data === undefined) {
      return NextResponse.json({ ready: false, reason: 'malformed-payload' }, { status: 200 });
    }
    return NextResponse.json({ ready: true, data });
  } catch (err) {
    return NextResponse.json(
      { ready: false, reason: err instanceof Error ? err.name : 'unknown' },
      { status: 200 },
    );
  }
}

/**
 * 写代理：上游状态码与响应体原样透出。
 *
 * **`userId` 由 BFF 注入，不信任客户端**（关键）。
 * 后端的写路径 zod schema（`CreateProviderBody` 等）都把 `userId` 声明为
 * `z.string().min(1)`，所以**字段必须存在**，否则先在 zod 被 422 挡掉，根本走不到
 * `actorForTeam`。而 `actorForTeam` 又把客户端传的 userId 与凭据所有者比对 ——
 * 于是正确做法是：浏览器**完全不发** userId，BFF 从 cookie 解析出的身份里取出来填进去。
 * 让前端传 userId 有两个坏处：① 传空串 → 422（`min(1)`）；② 传别人的 → 403。
 * 前端手里本来就有 `ctx.userId`（`/api/user/context`），但把它当数据交给浏览器再传回来
 * 只是多一次可以出错的机会 —— 身份从凭据推导才是单一事实源。
 *
 * 请求体转发规则：客户端发了 JSON 就转发；没发 body（DELETE/无参 POST）就不带
 * `content-type`。给一个没有 body 的 DELETE 硬塞 `content-type: application/json`
 * 会让部分上游（含 Fastify）在无 body 时报 400 —— 症状是「删除报参数错」，
 * 实际是转发头的问题。
 *
 * DELETE **不注入** userId：后端的 DELETE 路由（providers / skills / schedules）
 * 都只靠 `actorForTeam(db, req, teamId)` 判身份，不读 query 里的 userId。
 * （`skills.ts` 里声明过 `DeleteQuerySchema`，但没有任何路由用它。）
 */
export async function proxyWrite(
  req: Request,
  teamId: string,
  opts: ProxyOptions,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
): Promise<NextResponse> {
  if (!isAuthed(req)) return unauthorized();
  const hasBody = method === 'POST' || method === 'PATCH' || method === 'PUT';
  try {
    const queryForUpstream =
      method === 'DELETE' ? new URL(req.url).search : opts.query;

    let outgoingBody: string | undefined;
    if (hasBody) {
      const raw = await req.text();
      let parsed: Record<string, unknown> = {};
      if (raw.length > 0) {
        try {
          const decoded: unknown = JSON.parse(raw);
          // 客户端若发了非对象（数组/字符串/数字），原样透传让上游拒，
          // 不在这里猜它想要什么 —— 改写请求体的职责只限于注入身份。
          if (typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded)) {
            parsed = decoded as Record<string, unknown>;
          }
        } catch {
          return NextResponse.json(
            { error: 'request body is not valid JSON' },
            { status: 400 },
          );
        }
      }
      // 身份字段：客户端没给或给了空串/非串时用凭据身份补上。
      // 非空的用户自填值原样保留 —— 后端会拿它与凭据所有者比对，不等就 403，
      // 这个校验留在服务端，BFF 不代替它做决定。
      const claimed = parsed['userId'];
      if (typeof claimed !== 'string' || claimed.length === 0) {
        const identity = await fetchUserContext(req);
        if (identity === null) {
          return NextResponse.json(
            { error: 'cannot resolve identity for the write path' },
            { status: 401 },
          );
        }
        parsed['userId'] = identity.userId;
      }
      outgoingBody = JSON.stringify(parsed);
    }

    const res = await fetch(buildUpstreamUrl(opts.path(teamId), queryForUpstream), {
      method,
      headers: {
        Accept: 'application/json',
        ...(hasBody
          ? { 'content-type': 'application/json', ...forwardAuthHeaders(req) }
          : forwardAuthHeaders(req)),
      },
      ...(hasBody ? { body: outgoingBody ?? '{}' } : {}),
      cache: 'no-store',
    });
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
