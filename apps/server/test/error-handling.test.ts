import assert from 'node:assert/strict';
import { test, describe, type TestContext } from 'node:test';
import Fastify from 'fastify';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as dbPkg from '@tds/db';
import { buildServer } from '../src/main.js';
import { installErrorHandlers } from '../src/http.js';
import { newId, now } from '../src/ids.js';
import { generateApiKey } from '../src/crypto.js';

/**
 * 错误处理回归。
 *
 * 曾经有一个极隐蔽的 bug：setErrorHandler 写在 registerXxxRoutes **之前**，
 * Fastify 只把它作用于「调用时刻已存在」的路由，于是所有业务错误
 * （404/409/422）都走了默认 500，客户端完全无法区分错误类型。
 *
 * 这些测试锁死两件事：
 *   1. 带 statusCode 的错误按其状态码返回
 *   2. installErrorHandlers 必须在路由注册之后调用（顺序本身是契约）
 *   3. 鉴权 hook 的 skip-list：`/api/health` 与 `/api/mcp` 不被 hook 拦，
 *      业务端点无凭据一律 401 且不写库
 */

describe('错误处理', () => {
  test('带 statusCode 的错误按其状态码返回', async () => {
    const app = Fastify({ logger: false });
    app.get('/boom', async () => {
      const err = new Error('自定义原因') as Error & { statusCode: number };
      err.statusCode = 409;
      throw err;
    });
    installErrorHandlers(app as never);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/boom' });
    assert.equal(res.statusCode, 409);
    assert.deepEqual(JSON.parse(res.body), { error: '自定义原因' });
    await app.close();
  });

  test('无 statusCode 的错误才是 500', async () => {
    const app = Fastify({ logger: false });
    app.get('/boom', async () => {
      throw new Error('真·内部错误');
    });
    installErrorHandlers(app as never);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/boom' });
    assert.equal(res.statusCode, 500);
    // 不泄漏内部细节
    assert.deepEqual(JSON.parse(res.body), { error: 'internal error' });
    await app.close();
  });

  test('未匹配路由返回 404 JSON', async () => {
    const app = Fastify({ logger: false });
    installErrorHandlers(app as never);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/nope' });
    assert.equal(res.statusCode, 404);
    await app.close();
  });

  test('先注册路由再装 handler —— 顺序颠倒会让 handler 静默失效', async () => {
    const app = Fastify({ logger: false });
    // 路由先注册
    app.get('/boom', async () => {
      const err = new Error('x') as Error & { statusCode: number };
      err.statusCode = 409;
      throw err;
    });
    // handler 后装 → 必须生效
    installErrorHandlers(app as never);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/boom' });
    assert.equal(res.statusCode, 409, 'handler 必须作用于已注册的路由');
    await app.close();
  });

  /**
   * 真 server + 真凭据。
   *
   * buildServer() 装的是全局鉴权 hook，所以「真实 server」的用例必须带
   * Bearer key 才能打到业务路由；库里 seed 一个 admin 用户 + 它的 key。
   * 数据库不可达时返回 null（调用方直接 return，测试记为 skip）。
   */
  async function realServer(t: TestContext): Promise<{
    app: ReturnType<typeof buildServer>['app'];
    key: string;
    teamId: string;
    projectId: string;
    cleanup: () => Promise<void>;
  } | null> {
    const url = process.env.DATABASE_URL ?? 'postgres://tds@127.0.0.1:5433/tds';
    let probe: postgres.Sql | null = null;
    try {
      probe = postgres(url, { max: 1, connect_timeout: 3 });
      await probe`select 1`;
    } catch {
      if (probe) await probe.end().catch(() => undefined);
      t.skip('数据库不可达');
      return null;
    }
    await probe.end();

    const ts = now();
    const userId = newId();
    const teamId = newId();
    const memberId = newId();
    const projectId = newId();
    const k = generateApiKey();
    const seedSql = postgres(url, { max: 1 });
    await seedSql`insert into "user" (id,email,display_name,status,locale,created_at,updated_at)
                   values (${userId}, ${`eh-${userId}@test.local`}, 'eh', 'active', 'en', ${ts}, ${ts})`;
    await seedSql`insert into "team" (id,name,plan,storage_quota,created_at)
                   values (${teamId}, 'eh-team', 'free', 1073741824, ${ts})`;
    await seedSql`insert into "member" (id,team_id,actor_id,member_type,role,joined_at,v)
                   values (${memberId}, ${teamId}, ${userId}, 'user', 'admin', ${ts}, 0)`;
    // 建一个空项目：「401 不该写库」只能数**自己名下**的 todo。全表计数会被
    // 并行跑的其它测试文件的写入污染 —— 那时红的是别人的写入，不是本请求写的。
    await seedSql`insert into "project" (id,team_id,name,provider,repo_kind,default_branch,next_seq_num,created_at)
                   values (${projectId}, ${teamId}, 'eh-p', 'external', 'other', 'main', 1, ${ts})`;
    await seedSql`insert into "api_key" (id,user_id,name,key_prefix,key_hash,scopes,created_at)
                   values (${newId()}, ${userId}, 'eh', ${k.prefix}, ${k.hash}, ${['*']}, ${ts})`;
    await seedSql.end();

    process.env.DATABASE_URL = url;
    const { app } = buildServer();
    await app.ready();
    return {
      app,
      key: k.key,
      teamId,
      projectId,
      cleanup: async () => {
        await app.close();
        const s = postgres(url, { max: 1 });
        await s`delete from "team" where id = ${teamId}`;
        await s`delete from "user" where id = ${userId}`;
        await s.end();
      },
    };
  }

  test('真实 server：todo 不存在返回 404 而非 500', async (t) => {
    const rs = await realServer(t);
    if (!rs) return;
    const res = await rs.app.inject({
      method: 'POST',
      url: '/api/todos/definitely-not-a-real-todo/complete',
      headers: { authorization: `Bearer ${rs.key}` },
      payload: {},
    });
    assert.equal(res.statusCode, 404, res.body);
    assert.match(res.body, /todo not found/);
    await rs.cleanup();
  });

  test('真实 server：校验失败返回 422 而非 500', async (t) => {
    const rs = await realServer(t);
    if (!rs) return;
    const res = await rs.app.inject({
      method: 'POST',
      url: '/api/todos/whatever/feedback',
      headers: { authorization: `Bearer ${rs.key}` },
      payload: { message: '' },
    });
    assert.equal(res.statusCode, 422, res.body);
    await rs.cleanup();
  });

  test('/api/health 无凭据 → 200（鉴权 hook 的 skip-list 契约）', async (t) => {
    const rs = await realServer(t);
    if (!rs) return;
    const res = await rs.app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(res.statusCode, 200, res.body);
    await rs.cleanup();
  });

  test('POST /api/mcp 无凭据 → 401（MCP 自己鉴权，不过 hook）', async (t) => {
    const rs = await realServer(t);
    if (!rs) return;
    const res = await rs.app.inject({
      method: 'POST',
      url: '/api/mcp',
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    assert.equal(res.statusCode, 401, res.body);
    assert.match(res.body, /missing or malformed Authorization header/);
    await rs.cleanup();
  });

  test('业务端点无凭据 → 401，且该团队名下没有 todo 行被写入', async (t) => {
    const rs = await realServer(t);
    if (!rs) return;
    const url = process.env.DATABASE_URL ?? 'postgres://tds@127.0.0.1:5433/tds';
    const s = postgres(url, { max: 1 });
    const before = await s<{ n: number }[]>`
      select count(*)::int as n from "todo" where project_id = ${rs.projectId}
    `;
    const res = await rs.app.inject({ method: 'GET', url: `/api/todos?teamId=${rs.teamId}` });
    assert.equal(res.statusCode, 401, res.body);
    const after = await s<{ n: number }[]>`
      select count(*)::int as n from "todo" where project_id = ${rs.projectId}
    `;
    assert.equal(Number(after[0]?.n), Number(before[0]?.n), '401 不该写库');
    await s.end();
    await rs.cleanup();
  });
});
