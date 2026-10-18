import { API_BASE } from '@/lib/api';
import { isAuthed, unauthorized } from '@/lib/auth';

/**
 * BFF：SSE 透传代理 —— `GET /api/stream?scope=<scope>`
 *
 * 为什么不直接让浏览器连后端 4000：
 *   1) **认证**。EventSource 不能自定义 header，只能靠 cookie。
 *      直连后端意味着把 token 放进 URL（会在日志/历史里留下）。
 *      走 BFF 后由服务端带上 httpOnly cookie，token 不暴露给前端代码。
 *   2) **CORS 与同源**。浏览器 EventSource 对跨域更挑剔。
 *
 * 关键点：**必须原样流式转发，不能先缓冲**。
 * 若用 `await res.json()` 或 `await res.text()`，SSE 的实时性就没了 ——
 * 事件要攒到连接关闭才一次性吐出，等于退化成轮询。
 * 所以这里直接 `body.pipeTo(writable)`。
 */

export const dynamic = 'force-dynamic';
// SSE 长连接不能被平台的默认超时掐断
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  if (!isAuthed(req)) return unauthorized();

  const url = new URL(req.url);
  const scope = url.searchParams.get('scope');
  if (!scope) {
    return new Response(JSON.stringify({ error: 'scope is required' }), {
      status: 422,
      headers: { 'content-type': 'application/json' },
    });
  }

  const upstream = new URL(`${API_BASE}/api/stream`);
  upstream.searchParams.set('scope', scope);
  // 断线续传：把浏览器带来的 Last-Event-ID 透给后端，
  // 由后端补发错过的事件（seq 是持久游标）。
  const lastEventId = req.headers.get('last-event-id');
  if (lastEventId) upstream.searchParams.set('since', lastEventId);

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstream, {
      headers: {
        Accept: 'text/event-stream',
        // 后端也要能收到 cookie（BFF 与后端同机，header 直接带过去）
        ...(req.headers.get('cookie') ? { cookie: req.headers.get('cookie') as string } : {}),
      },
      cache: 'no-store',
    });
  } catch {
    return new Response(JSON.stringify({ error: 'upstream unreachable' }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (!upstreamRes.ok || !upstreamRes.body) {
    return new Response(JSON.stringify({ error: `upstream-${upstreamRes.status}` }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }

  return new Response(upstreamRes.body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // 关键：让 nginx/代理别缓冲
      'x-accel-buffering': 'no',
    },
  });
}
