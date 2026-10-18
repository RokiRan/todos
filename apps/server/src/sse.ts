import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, gt, lte } from 'drizzle-orm';
import type { Db } from '@tds/db';
import { requireTeamMembership, resolveContext } from './auth.js';
import { HttpError } from './http.js';
import { builds, machines, projects, sseEvents, todos } from '@tds/db';
import { now } from './ids.js';

/**
 * SSE 事件层 —— 对标原站实测协议。
 *
 * 实测校正（recon/SPEC.md §10.2、recon/02-cli-protocol.md）：
 *   - Web 端也是 **SSE**，不是 WebSocket（选型稿里"Web UI 用 WebSocket"那条可砍）
 *   - 端点按资源分：`/api/teams/{teamId}/stream`、`/api/conversations/{convId}/stream`
 *   - 帧格式：`data: {"type":"...","seq":N}\n\n`，ping 帧是 `{"type":"ping","seq":0}`
 *   - 客户端重连退避 2s–30s（RECONNECT_MIN_MS / RECONNECT_MAX_MS）
 *
 * **seq 是单调递增的持久游标**，所以断线重连可以用 Last-Event-ID 续传：
 *   客户端带 `Last-Event-ID: <seq>` → 服务端把该 seq 之后的事件补发一遍。
 * 这样刷新页面/断网重连都不会丢中间状态。用 Postgres 存事件而非内存
 * EventEmitter 也是为此 —— 内存总线在多实例部署时会丢事件。
 */

interface Subscriber {
  id: string;
  scope: string;
  reply: FastifyReply;
}

const subscribers = new Map<string, Set<Subscriber>>();

/** 心跳间隔。原站 machine 侧是 3s（watchdog 15s），web 侧放宽到 20s。 */
const WEB_PING_MS = 20_000;

/** 续传时最多补发多少帧 —— 防止一个卡了很久的客户端把整张表拉走。 */
const REPLAY_LIMIT = 500;

/**
 * 仅落库，不推送给订阅者。
 *
 * 用于「事务内」写一行 sse_event —— 只有事务 commit 之后才允许直播推。
 * 回滚时这行自动消失，订阅者不会看到「库里没发生」的事件。
 *
 * 返回新行的 seq —— 调用方把它带出来，commit 之后用 deliverEvent 把 seq
 * 与原始 payload 一起推给订阅者，帧格式与 publish 一致。
 *
 * 「跑步」用途：把已落库的 seq 推给当前进程的所有订阅者（sub.reply.raw.write）。
 * 不会再次写库。多实例部署下另一进程的订阅者只能靠 sse_event 表在断线续传
 * 时补发（replaySince）—— 这是单进程 EventEmitter 模型的整体局限，不在这里解决。
 */
export async function recordEvent(
  db: Db,
  scope: string,
  type: string,
  payload: unknown,
  teamId = '',
): Promise<number> {
  const inserted = await db
    .insert(sseEvents)
    .values({ teamId, scope, type, payload, createdAt: now() })
    .returning({ seq: sseEvents.seq });
  return inserted[0]?.seq ?? 0;
}

/** 仅推送给订阅者，不写库。seq 来自 recordEvent 的返回值。 */
export function deliverEvent(
  scope: string,
  type: string,
  seq: number,
  payload: unknown,
): void {
  const frame = `data: ${JSON.stringify({ type, seq, payload })}\n\n`;
  const set = subscribers.get(scope);
  if (!set) return;
  for (const sub of [...set]) {
    try {
      sub.reply.raw.write(frame);
    } catch {
      // 写失败说明连接已死 —— 清掉，等 req.raw 的 close 事件做最终清理
      set.delete(sub);
    }
  }
}

/**
 * 发布一个事件：先落库拿到 seq，再推给所有订阅者。
 * 这是 recordEvent + deliverEvent 的组合，事务外/简单路径直接用。
 */
export async function publish(
  db: Db,
  scope: string,
  type: string,
  payload: unknown,
  teamId = '',
): Promise<number> {
  const seq = await recordEvent(db, scope, type, payload, teamId);
  deliverEvent(scope, type, seq, payload);
  return seq;
}

function pingFrame(): string {
  return `data: ${JSON.stringify({ type: 'ping', seq: 0 })}\n\n`;
}

/** 断线续传：把 since 之后的事件补发一遍。 */
async function replaySince(
  db: Db,
  scope: string,
  since: number,
  reply: FastifyReply,
): Promise<void> {
  // 补发区间上限 = 最早事件与目标 seq 之间的最近 REPLAY_LIMIT 条
  const head = await db
    .select({ seq: sseEvents.seq })
    .from(sseEvents)
    .where(eq(sseEvents.scope, scope))
    .orderBy(sseEvents.seq)
    .limit(1);
  const firstSeq = head[0]?.seq ?? 0;
  const floor = Math.max(since, firstSeq - 1);

  const missed = await db
    .select({ seq: sseEvents.seq, type: sseEvents.type, payload: sseEvents.payload })
    .from(sseEvents)
    .where(and(eq(sseEvents.scope, scope), gt(sseEvents.seq, floor)))
    .orderBy(sseEvents.seq)
    .limit(REPLAY_LIMIT);

  for (const ev of missed) {
    try {
      reply.raw.write(
        `data: ${JSON.stringify({ type: ev.type, seq: ev.seq, payload: ev.payload })}\n\n`,
      );
    } catch {
      return;
    }
  }
}

export function registerSseRoutes(app: FastifyInstance, db: Db): void {
  /**
   * 鉴权 —— SSE 与业务 REST 同一套（2026-10-17 落地）。
   *
   * 浏览器 EventSource 不能自定义 header，所以 token 走 query（`?token=`）；
   * httpOnly cookie `tds_token` 同样接受。以前这里是「只比字符串相等，而且
   * `TDS_WEB_TOKEN` 未配时直接放行」—— 那等于没有身份：网内任何人能订任何
   * scope，包括别人团队的 `team:<teamId>`。现在凭据必须解析成一个用户，并且
   * 他必须是那个 scope 所属 team 的成员。
   */
  async function authorizeScope(
    db: Db,
    req: FastifyRequest,
    scope: string,
  ): Promise<void> {
    const ctx = await resolveContext(db, req);
    const colon = scope.indexOf(':');
    const kind = colon < 0 ? '' : scope.slice(0, colon);
    const target = colon < 0 ? '' : scope.slice(colon + 1);
    switch (kind) {
      case 'team': {
        if (!target) throw new HttpError(400, 'scope "team" needs a team id');
        await requireTeamMembership(db, ctx.userId, target);
        return;
      }
      case 'todo': {
        if (!target) throw new HttpError(400, 'scope "todo" needs a todo id');
        const teamId = (await db
          .select({ teamId: projects.teamId })
          .from(todos)
          .innerJoin(projects, eq(projects.id, todos.projectId))
          .where(eq(todos.id, target))
          .limit(1))[0]?.teamId;
        if (!teamId) throw new HttpError(403, 'todo has no accessible team');
        await requireTeamMembership(db, ctx.userId, teamId);
        return;
      }
      case 'conv': {
        if (!target) throw new HttpError(400, 'scope "conv" needs a conversation id');
        // conversation 实际是 build id（`routes/chief.ts` 的
        // `/api/conversations/:convId/messages` 用 `build_message.build_id`），
        // 所以归属走 build → todo → project → team。
        const teamId = (await db
          .select({ teamId: projects.teamId })
          .from(builds)
          .innerJoin(todos, eq(todos.id, builds.todoId))
          .innerJoin(projects, eq(projects.id, todos.projectId))
          .where(eq(builds.id, target))
          .limit(1))[0]?.teamId;
        if (!teamId) throw new HttpError(403, 'conversation has no accessible team');
        await requireTeamMembership(db, ctx.userId, teamId);
        return;
      }
      case 'machine': {
        if (!target) throw new HttpError(400, 'scope "machine" needs a machine id');
        const teamId = (await db
          .select({ teamId: machines.teamId })
          .from(machines)
          .where(eq(machines.id, target))
          .limit(1))[0]?.teamId;
        if (!teamId) throw new HttpError(403, 'machine has no accessible team');
        await requireTeamMembership(db, ctx.userId, teamId);
        return;
      }
      default:
        throw new HttpError(400, `unknown scope "${scope}"`);
    }
  }

  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const rawScope = (req.query as { scope?: string }).scope;
    let scope: string;
    try {
      // 以前没有 `?scope=` 时默认订阅字面量 `'team'` —— 那是个没人 publish 的
      // scope（publish 一律发 `team:<teamId>`），连上去永远只能收到 ping。
      if (!rawScope) throw new HttpError(400, 'scope is required');
      await authorizeScope(db, req, rawScope);
      scope = rawScope;
    } catch (err) {
      // SSE 客户端读不到 body（EventSource 只看 status 然后触发 onerror），
      // 所以这里必须自己写 raw 响应 —— 不能交给 Fastify 的 setErrorHandler。
      const status = err instanceof HttpError ? err.statusCode : 500;
      const body =
        status === 401 ? 'unauthorized'
        : status === 403 ? 'forbidden'
        : err instanceof HttpError ? err.message
        : 'internal error';
      reply.raw.writeHead(status, { 'Content-Type': 'text/plain' });
      reply.raw.end(body);
      return;
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // 关掉 nginx 缓冲，否则事件会被攒着不发
      'X-Accel-Buffering': 'no',
    });
    // **帧里没有 `id:` 行**（只有 `data:`）—— 浏览器不会记 Last-Event-ID，原生
    // 断线续传用不上。游标由客户端自己维护：`apps/web/src/lib/api.ts` 记住每帧的
    // `seq`，重连时当 `?since=` 带上。这与原站的帧格式一致（recon 实测帧也是纯 data）。
    reply.raw.write(pingFrame());

    const sub: Subscriber = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      scope,
      reply,
    };
    let set = subscribers.get(scope);
    if (!set) {
      set = new Set();
      subscribers.set(scope, set);
    }
    set.add(sub);

    // 断线续传：EventSource 自动重连时会带上 Last-Event-ID；
    // 经 BFF 代理时改用 ?since= 传递（浏览器 fetch 不能设置 Last-Event-ID）。
    const headerId = req.headers['last-event-id'];
    const querySince = (req.query as { since?: string }).since;
    const raw = querySince ?? (Array.isArray(headerId) ? headerId[0] : headerId);
    const since = Number(raw);
    if (Number.isFinite(since) && since > 0) {
      await replaySince(db, scope, since, reply);
    }

    const hb = setInterval(() => {
      try {
        reply.raw.write(pingFrame());
      } catch {
        clearInterval(hb);
      }
    }, WEB_PING_MS);

    req.raw.on('close', () => {
      clearInterval(hb);
      const s = subscribers.get(scope);
      s?.delete(sub);
      if (s && s.size === 0) subscribers.delete(scope);
    });
  };

  /**
   * 原站实测的两个 Web 路径（SPEC §10.2）。scope 从路径推导，
   * 不用 query —— 这样一条连接只可能订阅一个资源，语义更严。
   */
  app.get('/api/teams/:teamId/stream', async (req, reply) => {
    (req.query as { scope?: string }).scope = `team:${(req.params as { teamId: string }).teamId}`;
    return handler(req, reply);
  });

  app.get('/api/conversations/:convId/stream', async (req, reply) => {
    (req.query as { scope?: string }).scope = `conv:${(req.params as { convId: string }).convId}`;
    return handler(req, reply);
  });

  // 通用入口：显式 scope（machine 侧与内部调用用）
  app.get('/api/machine/stream', handler);
  app.get('/api/stream', handler);
}

export type { Subscriber };
