import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify from 'fastify';
import * as dbPkg from '@tds/db';
import { newId, now } from '../src/ids.js';
import { registerSseRoutes, publish } from '../src/sse.js';
import { registerTodoRoutes } from '../src/routes/todos.js';
import { generateApiKey, open } from '../src/crypto.js';

/**
 * SSE 事件层验证。
 *
 * 覆盖两个实测踩过的坑：
 *   1. **断线续传** —— seq 是持久游标，带 Last-Event-ID / ?since= 重连时补发遗漏事件
 *   2. **scope 双发** —— 看板订阅 `team:<teamId>`，详情页订阅 `todo:<id>`。
 *      只发 todo scope 的话看板永远不更新（这正是之前的 bug）。
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://tds@127.0.0.1:5433/tds';

let sql: postgres.Sql;
let app: ReturnType<typeof Fastify>;
let db: ReturnType<typeof drizzle<typeof dbPkg.schema>>;
let teamId: string;
let userId: string;
let memberId: string;
let projectId: string;
let todoId: string;
let agentId: string;
let convId: string;

const SCOPE = (): string => `team:${teamId}`;

let port = 0;
let apiKey = '';

/**
 * 所有还没 cancel 的流 reader —— after 里统一掐断。
 *
 * 不这么做的话 node:test 进程不会退出：SSE 响应体是长连接，
 * 每次 readFrames 的 catch 分支虽然 abort 了 controller，但底层 socket
 * 仍可能挂在服务端，导致 Fastify.close() 等到超时。
 */
const openReaders = new Set<{ cancel: () => Promise<void> }>();

async function readFrames(
  url: string,
  opts: { count?: number; ms?: number; headers?: Record<string, string> } = {},
): Promise<Array<{ type: string; seq: number; payload?: unknown }>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.ms ?? 4000);
  const frames: Array<{ type: string; seq: number; payload?: unknown }> = [];
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      signal: ctrl.signal,
      headers: opts.headers,
    });
    if (!res.body) return frames;
    reader = res.body.getReader();
    openReaders.add(reader);
    const dec = new TextDecoder();
    let buf = '';
    while (frames.length < (opts.count ?? 99)) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';
      for (const part of parts) {
        for (const line of part.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try {
            frames.push(JSON.parse(line.slice(5).trim()));
          } catch {
            /* 忽略非 JSON 行 */
          }
        }
      }
    }
  } catch {
    // 超时/取消：返回已收到的帧（这正是本函数存在的意义）
  } finally {
    clearTimeout(timer);
    if (reader) {
      openReaders.delete(reader);
      await reader.cancel().catch(() => undefined);
    }
  }
  return frames;
}


describe('SSE 事件层', () => {
  before(async () => {
    // 注意：必须给连接池留余量（max: 1 会死锁）。
    // SSE 连接的 handler 里要跑 replaySince 查询，若它占着唯一那条连接，
    // 同一时刻 publish 的 insert 就永远拿不到连接 —— 测试会挂在第一个 SSE 用例上。
    sql = postgres(DATABASE_URL, { max: 5 });
    db = drizzle(sql, { schema: dbPkg.schema });

    app = Fastify({ logger: false });
    app.decorate('machineUrl', 'http://test');
    registerTodoRoutes(app, db as never);
    registerSseRoutes(app, db as never);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;

    const ts = now();
    userId = newId();
    teamId = newId();
    memberId = newId();
    projectId = newId();
    agentId = newId();
    convId = newId();
    todoId = newId();

    await sql.begin(async (tx) => {
      await tx`insert into "user" (id,email,display_name,created_at,updated_at)
                values (${userId}, ${`sse-${userId}@test.local`}, 'sse', ${ts}, ${ts})`;
      await tx`insert into team (id,name,plan,storage_quota,created_at)
                values (${teamId}, 'sse-team', 'free', 1073741824, ${ts})`;
      await tx`insert into member (id,team_id,actor_id,member_type,role,joined_at,v)
                values (${memberId}, ${teamId}, ${userId}, 'user', 'admin', ${ts}, 0)`;
      await tx`insert into project (id,team_id,name,provider,repo_kind,default_branch,next_seq_num,created_at)
                values (${projectId}, ${teamId}, 'sse-p', 'external', 'other', 'main', 1, ${ts})`;
      await tx`insert into todo (id,project_id,seq_num,owner_member_id,title,phase,plan_first,created_at,updated_at)
                values (${todoId}, ${projectId}, 1, ${memberId}, 'sse todo', 'review', ${false}, ${ts}, ${ts})`;
      await tx`insert into agent (id,team_id,display_name,default_skill_ids,grants,active_task_count,created_at,updated_at)
                values (${agentId}, ${teamId}, 'sse-agent', '{}', '{}'::jsonb, 0, ${ts}, ${ts})`;
      await tx`insert into build (id,todo_id,n,branch,prev_phase,trigger_source,with_plan,with_checklist,agent_id,session,usage_by_model,created_at,v)
                values (${convId}, ${todoId}, 1, ${'tds/conv-' + convId}, null, 'user', false, false, ${agentId}, ${JSON.stringify({ runtime: 'claude-code', id: 's', openedAt: ts })}::jsonb, '[]'::jsonb, ${ts}, 0)`;
    });

    const k = generateApiKey();
    apiKey = k.key;
    await sql`
      insert into "api_key" (id, user_id, name, key_prefix, key_hash, scopes, created_at)
      values (${newId()}, ${userId}, ${'sse-' + userId}, ${k.prefix}, ${k.hash}, ${['*']}, ${ts})
    `;
    // EventSource 发不了 header，所以 SSE 这条链路必须支持 ?token= / cookie：
    // TDS_WEB_TOKEN 是共享 secret，TDS_WEB_USER 把它映射到本文件自己的用户。
    process.env.TDS_WEB_TOKEN = 'sse-secret';
    process.env.TDS_WEB_USER = `sse-${userId}@test.local`;
  });

  after(async () => {
    await cleanupScope();
    await sql`delete from build where todo_id = ${todoId}`;
    await sql`delete from agent where id = ${agentId}`;
    await sql`delete from audit_event where team_id = ${teamId}`;
    await sql`delete from todo where project_id = ${projectId}`;
    await sql`delete from project where team_id = ${teamId}`;
    await sql`delete from member where team_id = ${teamId}`;
    await sql`delete from team where id = ${teamId}`;
    await sql`delete from "user" where id = ${userId}`;
    // 先掐断所有还挂着的 SSE 连接，否则 Fastify.close() 会等到超时
    for (const r of openReaders) await r.cancel().catch(() => undefined);
    openReaders.clear();
    await app.close();
    await sql.end();
  });

  async function cleanupScope(): Promise<void> {
    await sql`delete from sse_event where scope = ${SCOPE()} or scope = ${`todo:${todoId}`}`;
  }

  test('首帧是 ping，且 content-type 是 text/event-stream', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stream?scope=${encodeURIComponent(SCOPE())}&token=sse-secret`);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.equal(res.headers.get('x-accel-buffering'), 'no', '必须关掉代理缓冲');
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const { value } = await reader.read();
    const first = JSON.parse(dec.decode(value).split('\n')[0]!.slice(5).trim());
    assert.equal(first.type, 'ping');
    assert.equal(first.seq, 0, 'ping 帧 seq 恒为 0');
    await reader.cancel().catch(() => undefined);
  });

  test('publish 后订阅者立刻收到事件', async () => {
    const seq = await publish(db as never, SCOPE(), 'custom_event', { hello: 'world' }, teamId);
    assert.ok(seq > 0, 'publish 应返回 seq');

    const frames = await readFrames(
      `/api/stream?scope=${encodeURIComponent(SCOPE())}&since=${seq - 1}&token=sse-secret`,
      { ms: 3000 },
    );
    // ping + 补发的那一条（续传会把它重放）
    const hit = frames.find((f) => f.type === 'custom_event');
    assert.ok(hit, `应收到 custom_event，实际收到 ${frames.map((f) => f.type).join(',')}`);
    assert.deepEqual(hit!.payload, { hello: 'world' });
  });

  test('断线续传：since 之后的事件全部补发', async () => {
    await cleanupScope();
    const s1 = await publish(db as never, SCOPE(), 'e1', { i: 1 }, teamId);
    const s2 = await publish(db as never, SCOPE(), 'e2', { i: 2 }, teamId);
    const s3 = await publish(db as never, SCOPE(), 'e3', { i: 3 }, teamId);

    // 模拟"断线前只见过 s1"
    const frames = await readFrames(
      `/api/stream?scope=${encodeURIComponent(SCOPE())}&since=${s1}&token=sse-secret`,
      { ms: 3000 },
    );
    const replayed = frames.filter((f) => f.type.startsWith('e')).map((f) => f.type);
    assert.deepEqual(replayed, ['e2', 'e3'], `只该补发 s2/s3，实际 ${replayed.join(',')}`);
    assert.ok(s2 < s3, 'seq 必须单调递增');
  });

  test('Last-Event-ID 头与 ?since= 等效', async () => {
    await cleanupScope();
    const s1 = await publish(db as never, SCOPE(), 'h1', {}, teamId);
    await publish(db as never, SCOPE(), 'h2', {}, teamId);

    const frames = await readFrames(
      `/api/stream?scope=${encodeURIComponent(SCOPE())}&token=sse-secret`,
      { ms: 3000, headers: { 'last-event-id': String(s1) } },
    );
    assert.ok(frames.some((f) => f.type === 'h2'), 'Last-Event-ID 应触发补发');
    assert.ok(!frames.some((f) => f.type === 'h1'), '不该重发已见过的事件');
  });

  test('scope 隔离：不同 scope 互不串台（mine 收到、foreign 不收到）', async () => {
    await cleanupScope();

    // 必须先建订阅、再发事件 —— deliverEvent 只推当前进程内的活动订阅者，
    // 先发后订会让 `mine` 也丢失（不是隔离 bug，但会让「mine 收到」断章）。
    const res = await fetch(`http://127.0.0.1:${port}/api/stream?scope=${encodeURIComponent(SCOPE())}&token=sse-secret`);
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    openReaders.add(reader);
    // 读掉 ping 帧 = 订阅者已注册进 subscribers
    await reader.read();

    // 在订阅者已建立的前提下，两个 scope 各发一条
    await publish(db as never, 'team:other-scope', 'foreign', { src: 'other' }, teamId);
    const mineSeq = await publish(db as never, SCOPE(), 'mine', { src: 'mine' }, teamId);

    const frames: Array<{ type: string; seq: number; payload?: unknown }> = [];
    const timer = setTimeout(() => reader.cancel().catch(() => undefined), 2500);
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of dec.decode(value).split('\n')) {
          if (!line.startsWith('data:')) continue;
          frames.push(JSON.parse(line.slice(5).trim()));
        }
      }
    } catch {
      /* 超时取消 */
    } finally {
      clearTimeout(timer);
      openReaders.delete(reader);
      await reader.cancel().catch(() => undefined);
    }

    // 阳性对照：mine 一定要到 —— 否则 0 帧也算「不串台」，绿得没意义。
    const mine = frames.find((f) => f.type === 'mine');
    assert.ok(mine, `订阅者必须收到 mine（来自 ${SCOPE()}），实际: ${frames.map((f) => f.type).join(',')}`);
    assert.equal(mine!.seq, mineSeq, 'mine 的 seq 必须等于 publish 的返回值');
    assert.deepEqual(mine!.payload, { src: 'mine' }, 'mine 的 payload 必须原样送达');

    // 阴性对照：别的 scope 的事件不该出现 —— 这是原测试的契约。
    assert.ok(!frames.some((f) => f.type === 'foreign'), '别的 scope 的事件不该出现');
  });

  test('闸门变更同时发到 team 与 todo 两个 scope（看板/详情页都要更新）', async () => {
    await cleanupScope();
    // 先记录当前 seq 游标，触发后再从游标处续传 ——
    // 比 since=0 更贴近真实重连场景，也不受历史事件量影响。
    const head = await sql`select coalesce(max(seq), 0) as m from sse_event`;
    const before = Number(head[0]?.m ?? 0);

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/feedback`,
      payload: { message: '触发闸门事件' },
      headers: { authorization: `Bearer ${apiKey}` },
    });
    assert.equal(res.statusCode, 200, res.body);

    const teamFrames = await readFrames(
      `/api/stream?scope=${encodeURIComponent(SCOPE())}&since=${before}&token=sse-secret`,
      { ms: 2500 },
    );
    const todoFrames = await readFrames(
      `/api/stream?scope=${encodeURIComponent(`todo:${todoId}`)}&since=${before}&token=sse-secret`,
      { ms: 2500 },
    );

    const teamHit = teamFrames.find((f) => f.type === 'phase_changed');
    const todoHit = todoFrames.find((f) => f.type === 'phase_changed');
    assert.ok(teamHit, `team scope 必须收到 phase_changed，实际: ${teamFrames.map((f) => f.type).join(',')}`);
    assert.ok(todoHit, `todo scope 必须收到 phase_changed，实际: ${todoFrames.map((f) => f.type).join(',')}`);
    // 两边 payload 一致：看板与详情页看到的是同一个事实
    assert.deepEqual(teamHit!.payload, todoHit!.payload);
  });

  test('事件落在 sse_event 表里（持久游标，重启不丢）', async () => {
    await cleanupScope();
    await publish(db as never, SCOPE(), 'persisted', { x: 1 }, teamId);
    const rows = await sql`select seq, type from sse_event where scope = ${SCOPE()} order by seq desc limit 1`;
    assert.equal(rows[0]?.type, 'persisted');
  });

  test('Cookie: tds_token 与 ?token= 等效（浏览器两种走法都能鉴权）', async () => {
    const viaCookie = await fetch(
      `http://127.0.0.1:${port}/api/stream?scope=${encodeURIComponent(SCOPE())}`,
      { headers: { cookie: 'tds_token=sse-secret' } },
    );
    assert.equal(viaCookie.status, 200, 'cookie 携带 web token 应放行');
    await viaCookie.body?.cancel();

    const wrong = await fetch(
      `http://127.0.0.1:${port}/api/stream?scope=${encodeURIComponent(SCOPE())}&token=wrong-token`,
    );
    assert.equal(wrong.status, 401, '错 token 应 401');
    await wrong.body?.cancel();
  });

  test('原站路径存在：/api/teams/:teamId/stream 与 /api/conversations/:id/stream', async () => {
    const t = await fetch(`http://127.0.0.1:${port}/api/teams/${teamId}/stream?token=sse-secret`);
    assert.equal(t.status, 200, 'team 级 stream 端点应对标原站');
    await t.body?.cancel();

    // conversation 级：本团队真实 build 的 conv 必须放行
    const own = await fetch(`http://127.0.0.1:${port}/api/conversations/${convId}/stream?token=sse-secret`);
    assert.equal(own.status, 200, '自己团队的 conv stream 应放行');
    await own.body?.cancel();

    // 未知 conv：403 —— 不向非成员泄露它是否存在
    const c = await fetch(`http://127.0.0.1:${port}/api/conversations/${newId()}/stream?token=sse-secret`);
    const cBody = await c.text();
    assert.equal(c.status, 403, `未知 conv 不该放行，body=${cBody}`);
  });

  test('原站路径的 scope 由路径推导，不是 query', async () => {
    await cleanupScope();
    // /api/teams/X/stream 的 scope 必须是 team:X —— 否则 publish 到 team:X 的事件收不到。
    // 不靠固定 sleep 等订阅建立：先发 ping 帧当作"已就绪"的信号。
    const res = await fetch(`http://127.0.0.1:${port}/api/teams/${teamId}/stream?token=sse-secret`);
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    // 读掉 ping 帧 = 订阅者已注册进 subscribers
    await reader.read();

    const seq = await publish(db as never, `team:${teamId}`, 'viapath', {}, teamId);

    const frames: Array<{ type: string }> = [];
    const timer = setTimeout(() => reader.cancel().catch(() => undefined), 3000);
    openReaders.add(reader);
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of dec.decode(value).split('\n')) {
          if (!line.startsWith('data:')) continue;
          frames.push(JSON.parse(line.slice(5).trim()));
          if (frames.some((f) => f.type === 'viapath')) break;
        }
        if (frames.some((f) => f.type === 'viapath')) break;
      }
    } catch {
      /* 超时取消 */
    } finally {
      clearTimeout(timer);
      openReaders.delete(reader);
      await reader.cancel().catch(() => undefined);
    }

    assert.ok(frames.some((f) => f.type === 'viapath'),
      `/api/teams/${teamId}/stream 应订阅到 team:${teamId}（发布 seq=${seq}）`);
  });

  test('无凭据打 /api/stream → 401，且 sse_event 行数没变', async () => {
    const before = await sql<{ n: number }[]>`select count(*)::int as n from sse_event`;
    const res = await fetch(`http://127.0.0.1:${port}/api/stream?scope=${encodeURIComponent(SCOPE())}`);
    assert.equal(res.status, 401, `body=${await res.text()}`);
    const after = await sql<{ n: number }[]>`select count(*)::int as n from sse_event`;
    assert.equal(Number(after[0]?.n), Number(before[0]?.n), '401 不该写库');
  });

  test('别人的 key 订阅 team:<foreign> → 403，且 sse_event 行数没变', async () => {
    const before = await sql<{ n: number }[]>`select count(*)::int as n from sse_event`;
    const res = await fetch(
      `http://127.0.0.1:${port}/api/stream?scope=${encodeURIComponent('team:not-my-team')}`,
      { headers: { authorization: `Bearer ${apiKey}` } },
    );
    assert.equal(res.status, 403, '别人的 key 订阅别人的团队应 403');
    assert.match(await res.text(), /forbidden/, 'SSE 的 4xx 走 raw 响应：EventSource 读不到 JSON body');
    const after = await sql<{ n: number }[]>`select count(*)::int as n from sse_event`;
    assert.equal(Number(after[0]?.n), Number(before[0]?.n), '403 不该写库');
  });

  test('缺 ?scope= → 400（不再有默认 scope）', async () => {
    const before = await sql<{ n: number }[]>`select count(*)::int as n from sse_event`;
    const res = await fetch(`http://127.0.0.1:${port}/api/stream?token=sse-secret`);
    assert.equal(res.status, 400, `body=${await res.text()}`);
    const after = await sql<{ n: number }[]>`select count(*)::int as n from sse_event`;
    assert.equal(Number(after[0]?.n), Number(before[0]?.n), '400 不该写库');
  });
});

// open 只是为了确认 crypto 模块在测试环境可加载（凭据加密与 SSE 同进程）
void open;
