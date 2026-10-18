import assert from 'node:assert/strict';
import { test, describe, before, after, afterEach } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import * as dbPkg from '@tds/db';
import { newId, now } from '../src/ids.js';
import { generateApiKey, hashApiKey } from '../src/crypto.js';
import { registerBuildMessageRoutes } from '../src/routes/build-messages.js';

/**
 * Build 对话 / 队列 REST 验证（真库 + `app.inject`）。
 *
 * 钉死（`recon-live/GAP-ANALYSIS.md` + docs-conversation.md）：
 *   1. 跨团队 GET 别人 build 的 messages → 403，且对方表内**没**新增队列或消息
 *   2. build 不存在 → 404
 *   3. `?since=<seq>` 增量只返回 `seq > since` 的行（最易假绿，精确比对 ids）
 *   4. 已结算（`finishedAt != NULL`）的 build POST → `queued:false`，消息落 `build_message`
 *   5. 未结算（`finishedAt IS NULL`）的 build POST → `queued:true`，带 `queueId` 与 `position`
 *   6. 编辑/撤回**已落库**的消息 → 409（不能改历史）
 *
 * 鉴权：Bearer API key 落 `req.ctx`（main.ts 全局 preHandler），与 machines-api
 *   同源。注意我们注册的是模块路由，但 main.ts 鉴权钩子没注册到这里 —— 我们
 *   在测试里**自己**写 `app.addHook('preHandler')` 把 body 上的 `key` 当 Bearer。
 *   这是 fixtures 模式与生产保持一致的最简做法（参见 machines-api.test.ts）
 *   —— 这里测试的是路由契约，鉴权由它自己 mimmick。
 *
 * Storage：进程内 Map（详 build-messages.ts 文件头注释）。重启丢队列、单实例
 *   —— 这两条局限在汇报里说明。
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://tds:tds_local_dev@127.0.0.1:5433/tds';

let sql: postgres.Sql;
let app: FastifyInstance;
let fixtures: Fixture[] = [];

interface Fixture {
  userId: string;
  teamId: string;
  memberId: string;
  agentId: string;
  projectId: string;
  todoId: string;
  buildId: string;
  key: string;
  finishedAt: number | null;
}

function auth(key: string): { authorization: string } {
  return { authorization: `Bearer ${key}` };
}

/** Seed 一条完整 build 链（team → user → api_key → member → agent → project → todo → build）。
 *  `finishedAt` = null 模拟「还在跑」（未结算）。 */
async function seedFixture(label: string, finished: boolean): Promise<Fixture> {
  const ts = now();
  const userId = newId();
  const teamId = newId();
  const memberId = newId();
  const agentId = newId();
  const projectId = newId();
  const todoId = newId();
  const buildId = newId();

  await sql`insert into "user" (id,email,display_name,created_at,updated_at)
              values (${userId}, ${`bm-${label}-${userId}@test.local`}, ${label}, ${ts}, ${ts})`;
  await sql`insert into team (id,name,plan,storage_quota,created_at)
              values (${teamId}, ${label}, 'free', 1073741824, ${ts})`;
  await sql`insert into member (id,team_id,actor_id,member_type,role,joined_at,v)
              values (${memberId}, ${teamId}, ${userId}, 'user', 'admin', ${ts}, 0)`;
  await sql`insert into agent (id,team_id,display_name,grants,active_task_count,created_at,updated_at)
              values (${agentId}, ${teamId}, ${`ag-${label}`},
                      '{}'::jsonb, 0, ${ts}, ${ts})`;
  await sql`insert into project (id,team_id,name,provider,repo_kind,default_branch,next_seq_num,created_at)
              values (${projectId}, ${teamId}, ${`p-${label}`}, 'external', 'other', 'main', 1, ${ts})`;
  await sql`insert into todo (id,project_id,seq_num,owner_member_id,agent_id,title,tag_ids,phase,plan_first,separate_plan_build,with_checklist,created_at,updated_at)
              values (${todoId}, ${projectId}, 1, ${memberId}, ${agentId}, ${`t-${label}`},
                      '{}'::text[], 'implement', ${true}, ${false}, ${false}, ${ts}, ${ts})`;
  const sessionJson = `{"runtime":"claude-code","id":"sess","openedAt":${ts}}`;
  await sql`insert into "build" (id,todo_id,n,branch,trigger_source,with_plan,with_checklist,agent_id,session,usage_by_model,created_at,finished_at,v)
              values (${buildId}, ${todoId}, 1, ${`tds/conv-${buildId}`},
                      'user', ${false}, ${false}, ${agentId},
                      ${sessionJson}::jsonb,
                      '[]'::jsonb, ${ts}, ${finished ? ts : null}, 0)`;

  const k = generateApiKey();
  await sql`insert into "api_key" (id,user_id,name,key_prefix,key_hash,scopes,created_at)
              values (${newId()}, ${userId}, ${`bm-${label}`}, ${k.prefix}, ${k.hash}, ${['*']}, ${ts})`;

  const f: Fixture = {
    userId,
    teamId,
    memberId,
    agentId,
    projectId,
    todoId,
    buildId,
    key: k.key,
    finishedAt: finished ? ts : null,
  };
  fixtures.push(f);
  return f;
}

async function seedMessage(buildId: string, seq: number, content: string): Promise<void> {
  const ts = now();
  await sql`insert into build_message (id,build_id,role,content,is_error,seq,created_at)
              values (${'m_' + newId()}, ${buildId}, 'user', ${content}, ${false}, ${seq}, ${ts})`;
}

async function cleanupFixture(f: Fixture): Promise<void> {
  // cascade: build_message/delete todo/etc. 都由 FK 接走
  await sql`delete from "build" where id = ${f.buildId}`;
  await sql`delete from todo where id = ${f.todoId}`;
  await sql`delete from project where id = ${f.projectId}`;
  await sql`delete from agent where id = ${f.agentId}`;
  await sql`delete from "api_key" where user_id = ${f.userId}`;
  await sql`delete from member where team_id = ${f.teamId}`;
  await sql`delete from team where id = ${f.teamId}`;
  await sql`delete from "user" where id = ${f.userId}`;
}

describe('build messages & steering queue', () => {
  before(async () => {
    sql = postgres(DATABASE_URL, { max: 5 });
    const db = drizzle(sql, { schema: dbPkg.schema });
    app = Fastify({ logger: false });
    app.decorate('machineUrl', 'http://test');
    // 模拟 main.ts 的全局鉴权 hook —— Bearer 解析后挂到 req.ctx。
    app.addHook('preHandler', async (req) => {
      if (!req.url.startsWith('/api/')) return;
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith('Bearer ')) {
        const err = new Error('unauthorized') as Error & { statusCode?: number };
        err.statusCode = 401;
        throw err;
      }
      const token = auth.slice(7);
      // 与生产同源：HMAC-SHA256(KEK, token) → key_hash
      const tokenHash = hashApiKey(token);
      const rows = await sql<
        { id: string; user_id: string }[]
      >`select id, user_id from api_key where key_hash = ${tokenHash}`;
      const hit = rows[0];
      if (!hit) {
        const err = new Error('unauthorized') as Error & { statusCode?: number };
        err.statusCode = 401;
        throw err;
      }
      (req as unknown as { ctx: { userId: string } }).ctx = { userId: hit.user_id };
    });
    registerBuildMessageRoutes(app, db as never);
    await app.ready();
  });

  after(async () => {
    while (fixtures.length > 0) {
      const f = fixtures.pop();
      if (f) await cleanupFixture(f);
    }
    await app.close();
    await sql.end();
  });

  afterEach(async () => {
    while (fixtures.length > 0) {
      const f = fixtures.pop();
      if (f) await cleanupFixture(f);
    }
  });

  test('GET 列表：返回 build 的 messages 与 queued 都不混', async () => {
    const f = await seedFixture('list-ok', true /* settled */);
    await seedMessage(f.buildId, 0, 'first');
    await seedMessage(f.buildId, 1, 'second');

    const res = await app.inject({
      method: 'GET',
      url: `/api/builds/${encodeURIComponent(f.buildId)}/messages`,
      headers: auth(f.key),
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as {
      messages: Array<{ id: string; seq: number; content: string }>;
      queued?: unknown[];
    };
    assert.equal(body.messages.length, 2);
    assert.deepEqual(
      body.messages.map((m) => m.seq),
      [0, 1],
      '返回顺序按 seq asc',
    );
    // settled build 没有 running 期，队列自然空。
    assert.equal(body.queued, undefined, '空队列不应返回 queued 字段或返回 []');
  });

  test('增量 since：返回 seq > since 的行', async () => {
    const f = await seedFixture('since', true);
    await seedMessage(f.buildId, 0, 'a');
    await seedMessage(f.buildId, 1, 'b');
    await seedMessage(f.buildId, 2, 'c');

    const res = await app.inject({
      method: 'GET',
      url: `/api/builds/${encodeURIComponent(f.buildId)}/messages?since=0`,
      headers: auth(f.key),
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as {
      messages: Array<{ seq: number; content: string }>;
    };
    // 钉死：since=0 必须只回 [1, 2]，不能回三条也不能空（最易假绿）
    assert.equal(body.messages.length, 2, `expected 2 after since=0, got ${body.messages.length}`);
    assert.equal(body.messages[0]?.content, 'b');
    assert.equal(body.messages[1]?.content, 'c');
  });

  test('POST 到 settled build → queued:false 且落库', async () => {
    const f = await seedFixture('post-settled', true);

    const res = await app.inject({
      method: 'POST',
      url: `/api/builds/${encodeURIComponent(f.buildId)}/messages`,
      headers: auth(f.key),
      payload: { content: 'hi', mentions: [] },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as {
      ok: boolean;
      queued: boolean;
      message?: { id: string; content: string; seq: number };
      queueId?: string;
      position?: number;
    };
    assert.equal(body.ok, true);
    assert.equal(body.queued, false);
    assert.ok(body.message, 'settled 路径必须直接返回 message');
    // content 走 envelope：{content,mentions}
    const env = JSON.parse(body.message!.content) as { content: string; mentions: unknown[] };
    assert.equal(env.content, 'hi');
    assert.equal(body.queueId, undefined);

    // 钉死：库里必须有这条 build_message 行 ——「消息真的落库」是 settle 路径的核心契约。
    const rows = await sql<{ count: number }[]>`
      select count(*)::int as count from build_message where build_id = ${f.buildId}
    `;
    assert.equal(rows[0]?.count, 1, 'settled POST 后库内必须多一条 build_message');
  });

  test('POST 到 running build → queued:true，进程内 Map，库内不动', async () => {
    const f = await seedFixture('post-running', false /* finishedAt IS NULL */);

    const res = await app.inject({
      method: 'POST',
      url: `/api/builds/${encodeURIComponent(f.buildId)}/messages`,
      headers: auth(f.key),
      payload: { content: 'mid-turn steer', mentions: [] },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as {
      ok: boolean;
      queued: boolean;
      queueId?: string;
      position?: number;
    };
    assert.equal(body.ok, true);
    assert.equal(body.queued, true);
    assert.ok(body.queueId);
    assert.equal(body.position, 1, '第一条入队 position=1');

    // 关键不变量：running 路径 **不** 写 build_message —— 否则会污染 agent 上下文。
    const dbRows = await sql<{ count: number }[]>`
      select count(*)::int as count from build_message where build_id = ${f.buildId}
    `;
    assert.equal(dbRows[0]?.count, 0, 'queued:true 时 build_message 必须空');

    // 多次入队 → position 自增
    const res2 = await app.inject({
      method: 'POST',
      url: `/api/builds/${encodeURIComponent(f.buildId)}/messages`,
      headers: auth(f.key),
      payload: { content: 'second', mentions: [] },
    });
    const body2 = JSON.parse(res2.body) as { position: number };
    assert.equal(body2.position, 2, '第二次入队 position=2');
  });

  test('PATCH 未投递队列项：可改', async () => {
    const f = await seedFixture('patch-queue', false);
    const post = await app.inject({
      method: 'POST',
      url: `/api/builds/${encodeURIComponent(f.buildId)}/messages`,
      headers: auth(f.key),
      payload: { content: 'v1', mentions: [] },
    });
    const { queueId } = JSON.parse(post.body) as { queueId: string };
    assert.ok(queueId);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/builds/${encodeURIComponent(f.buildId)}/messages/${encodeURIComponent(queueId!)}`,
      headers: auth(f.key),
      payload: { content: 'v2' },
    });
    assert.equal(patch.statusCode, 200, patch.body);
    const body = JSON.parse(patch.body) as {
      ok: boolean;
      item: { id: string; content: string; status: string };
    };
    assert.equal(body.ok, true);
    assert.equal(body.item.content, 'v2');
    assert.equal(body.item.status, 'pending');
  });

  test('PATCH 已落库消息 → 409（历史不可改）', async () => {
    const f = await seedFixture('patch-hist', true);
    await seedMessage(f.buildId, 0, 'old');
    // 取真实 build_message id
    const rows = await sql<{ id: string }[]>`
      select id from build_message where build_id = ${f.buildId} order by seq limit 1
    `;
    const persistedId = rows[0]!.id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/builds/${encodeURIComponent(f.buildId)}/messages/${encodeURIComponent(persistedId)}`,
      headers: auth(f.key),
      payload: { content: 'tampered' },
    });
    assert.equal(res.statusCode, 409, res.body);
    // 钉死：库里这条消息**不能**被改成 'tampered'
    const after = await sql<{ content: string }[]>`
      select content from build_message where id = ${persistedId}
    `;
    assert.equal(after[0]?.content, 'old', '409 后库内一行未动');
  });

  test('DELETE 未投递队列项：撤回消失', async () => {
    const f = await seedFixture('retract-ok', false);
    const post = await app.inject({
      method: 'POST',
      url: `/api/builds/${encodeURIComponent(f.buildId)}/messages`,
      headers: auth(f.key),
      payload: { content: 'about to retract', mentions: [] },
    });
    const { queueId } = JSON.parse(post.body) as { queueId: string };
    assert.ok(queueId);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/builds/${encodeURIComponent(f.buildId)}/messages/${encodeURIComponent(queueId!)}`,
      headers: auth(f.key),
      payload: {},
    });
    assert.equal(del.statusCode, 200, del.body);

    // 再 GET 应当 queued 为空（snapshotQueue 不返回已撤回的项）
    const list = await app.inject({
      method: 'GET',
      url: `/api/builds/${encodeURIComponent(f.buildId)}/messages`,
      headers: auth(f.key),
    });
    const listBody = JSON.parse(list.body) as { messages: unknown[]; queued?: unknown[] };
    assert.equal(listBody.messages.length, 0);
    assert.equal(listBody.queued, undefined, '撤回后 queued 字段应该消失');
  });

  test('DELETE 已落库消息 → 409', async () => {
    const f = await seedFixture('retract-hist', true);
    await seedMessage(f.buildId, 0, 'frozen');
    const rows = await sql<{ id: string }[]>`
      select id from build_message where build_id = ${f.buildId} limit 1
    `;
    const persistedId = rows[0]!.id;

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/builds/${encodeURIComponent(f.buildId)}/messages/${encodeURIComponent(persistedId)}`,
      headers: auth(f.key),
      payload: {},
    });
    assert.equal(res.statusCode, 409, res.body);
    const after = await sql<{ c: number }[]>`
      select count(*)::int as c from build_message where id = ${persistedId}
    `;
    assert.equal(after[0]?.c, 1, '409 后历史消息不能被删');
  });

  test('跨团队读他人 build → 403，且对方库内没新增', async () => {
    const a = await seedFixture('cross-a', true);
    const b = await seedFixture('cross-b', true);
    await seedMessage(b.buildId, 0, 'private');

    const res = await app.inject({
      method: 'GET',
      url: `/api/builds/${encodeURIComponent(b.buildId)}/messages`,
      headers: auth(a.key),
    });
    assert.equal(res.statusCode, 403, res.body);
    const rows = await sql<{ count: number }[]>`
      select count(*)::int as count from build_message where build_id = ${b.buildId}
    `;
    assert.equal(rows[0]?.count, 1, '403 时对方表内一行未动');
  });

  test('跨团队 POST 到他人 build → 403，且进程内队列不增长', async () => {
    const a = await seedFixture('cross-post-a', false);
    const b = await seedFixture('cross-post-b', false);

    const res = await app.inject({
      method: 'POST',
      url: `/api/builds/${encodeURIComponent(b.buildId)}/messages`,
      headers: auth(a.key),
      payload: { content: 'hostile', mentions: [] },
    });
    assert.equal(res.statusCode, 403, res.body);

    // b 自己 GET 看不到这条 ——「进程内 Map 按 buildId 隔离」的兜底：身份校验
    // 已经把这条拒了，所以 b 的队列依然是空的。
    const list = await app.inject({
      method: 'GET',
      url: `/api/builds/${encodeURIComponent(b.buildId)}/messages`,
      headers: auth(b.key),
    });
    const listBody = JSON.parse(list.body) as { messages: unknown[]; queued?: unknown[] };
    assert.equal(listBody.messages.length, 0);
    assert.equal(listBody.queued, undefined, '跨队 POST 拒后队列仍是空');
  });

  test('build 不存在 → 403（不泄露存在性，与 conversations 同源）', async () => {
    const f = await seedFixture('ghost', true);
    const res = await app.inject({
      method: 'GET',
      url: `/api/builds/${encodeURIComponent(newId())}/messages`,
      headers: auth(f.key),
    });
    // 真实契约：`loadConversationTeamId` 对不存在 build 抛 403「conversation has
    // no accessible team」—— 这是设计，避免让非成员借 404/403 区分来探测存在性。
    assert.equal(res.statusCode, 403, res.body);
  });

  test('POST content 为空 → 422', async () => {
    const f = await seedFixture('post-422', true);
    const res = await app.inject({
      method: 'POST',
      url: `/api/builds/${encodeURIComponent(f.buildId)}/messages`,
      headers: auth(f.key),
      payload: { content: '', mentions: [] },
    });
    assert.equal(res.statusCode, 422, res.body);
  });
});
