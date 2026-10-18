import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import * as dbPkg from '@tds/db';
import { newId, now } from '../src/ids.js';
import { registerChiefRoutes } from '../src/routes/chief.js';
import { generateApiKey } from '../src/crypto.js';

type TestDb = PostgresJsDatabase<typeof dbPkg.schema>;
type TestApp = FastifyInstance;

/**
 * Chief REST 路由端到端验证。
 *
 * 关键契约 —— 任何回归都必须有锁死单测：
 *   - GET /api/teams/:teamId/chief：按 `chief-<userId>-<teamId>` 规则找；
 *     不存在返回 {chief: null}
 *   - PUT charter：写库 + 审计；charter 字段对 Chief 只读、用户可写
 *   - POST threads：≤50 上限，超了 422
 *   - POST dispatch：todo + build + step 全部建出来；
 *     branch === `tds/conv-<buildId>`；build.triggerSource === 'chief'
 *   - 没在线机器时，todo.phase 落 'queued'，不建 step
 *   - 推进走 transition()（todo → planning）而非手写 update
 *
 * DB 是开发机 127.0.0.1:5433 上的 tds 真库；每个 test 用独立 fixture，
 * after 兜底清理。
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://tds:tds_local_dev@127.0.0.1:5433/tds';
const dbSchema = dbPkg.schema;

function buildTestApp(db: TestDb): TestApp {
  const app = Fastify({ logger: false });
  app.decorate('machineUrl', 'http://test');
  registerChiefRoutes(app, db as never);
  return app;
}

interface Fixture {
  label: string;
  userId: string;
  teamId: string;
  projectId: string;
  memberId: string;
  agentId: string;
  chiefId: string;
  key: string;
}

async function seedFixture(sql: postgres.Sql, label: string): Promise<Fixture> {
  const ts = now();
  const userId = newId();
  const teamId = newId();
  const memberId = newId();
  const agentId = newId();
  const projectId = newId();
  const chiefId = `chief-${userId}-${teamId}`;

  await sql`
    insert into "user"
      (id, email, display_name, status, locale, created_at, updated_at)
    values
      (${userId}, ${`${label}-${userId}@test.local`}, ${label}, 'active', 'en', ${ts}, ${ts})
  `;
  await sql`
    insert into "team"
      (id, name, plan, storage_quota, created_at)
    values
      (${teamId}, ${label}, 'free', 1073741824, ${ts})
  `;
  await sql`
    insert into "member"
      (id, team_id, actor_id, member_type, role, joined_at, v)
    values
      (${memberId}, ${teamId}, ${userId}, 'user', 'admin', ${ts}, 0)
  `;
  await sql`
    insert into "agent"
      (id, team_id, display_name, default_skill_ids, grants, active_task_count, created_at, updated_at)
    values
      (${agentId}, ${teamId}, ${label}, '{}', '{}'::jsonb, 0, ${ts}, ${ts})
  `;
  await sql`
    insert into "project"
      (id, team_id, name, provider, repo_kind, default_branch, next_seq_num, created_at)
    values
      (${projectId}, ${teamId}, ${label}, 'external', 'other', 'main', 1, ${ts})
  `;
  await sql`
    insert into "chief"
      (id, user_id, team_id, agent_id, charter, created_at, updated_at)
    values
      (${chiefId}, ${userId}, ${teamId}, ${agentId}, '初始 charter', ${ts}, ${ts})
  `;

  const k = generateApiKey();
  await sql`
    insert into "api_key"
      (id, user_id, name, key_prefix, key_hash, scopes, created_at)
    values
      (${newId()}, ${userId}, ${'rest-' + label}, ${k.prefix}, ${k.hash}, ${['*']}, ${ts})
  `;
  return { label, userId, teamId, projectId, memberId, agentId, chiefId, key: k.key };
}

async function seedChiefOnly(sql: postgres.Sql, label: string): Promise<Fixture> {
  // 给「没有 chief 行」的 negative 测试用
  const ts = now();
  const userId = newId();
  const teamId = newId();
  const memberId = newId();
  const agentId = newId();
  const projectId = newId();
  const chiefId = `chief-${userId}-${teamId}`;

  await sql`
    insert into "user"
      (id, email, display_name, status, locale, created_at, updated_at)
    values
      (${userId}, ${`${label}-${userId}@test.local`}, ${label}, 'active', 'en', ${ts}, ${ts})
  `;
  await sql`
    insert into "team"
      (id, name, plan, storage_quota, created_at)
    values
      (${teamId}, ${label}, 'free', 1073741824, ${ts})
  `;
  await sql`
    insert into "member"
      (id, team_id, actor_id, member_type, role, joined_at, v)
    values
      (${memberId}, ${teamId}, ${userId}, 'user', 'admin', ${ts}, 0)
  `;
  await sql`
    insert into "agent"
      (id, team_id, display_name, default_skill_ids, grants, active_task_count, created_at, updated_at)
    values
      (${agentId}, ${teamId}, ${label}, '{}', '{}'::jsonb, 0, ${ts}, ${ts})
  `;
  await sql`
    insert into "project"
      (id, team_id, name, provider, repo_kind, default_branch, next_seq_num, created_at)
    values
      (${projectId}, ${teamId}, ${label}, 'external', 'other', 'main', 1, ${ts})
  `;

  const k = generateApiKey();
  await sql`
    insert into "api_key"
      (id, user_id, name, key_prefix, key_hash, scopes, created_at)
    values
      (${newId()}, ${userId}, ${'rest-' + label}, ${k.prefix}, ${k.hash}, ${['*']}, ${ts})
  `;
  return { label, userId, teamId, projectId, memberId, agentId, chiefId, key: k.key };
}

async function deleteFixture(sql: postgres.Sql, f: Fixture): Promise<void> {
  await sql`delete from "team" where id = ${f.teamId}`;
  await sql`delete from "user" where id = ${f.userId}`;
}

describe('Chief REST 路由', () => {
  let sql: postgres.Sql;
  let db: TestDb;
  let app: TestApp;
  const fixtures: Fixture[] = [];

  before(async () => {
    sql = postgres(DATABASE_URL, { max: 5, idle_timeout: 20 });
    db = drizzle(sql, { schema: dbSchema as never });
    app = buildTestApp(db);
    await app.ready();
  });

  after(async () => {
    for (const f of fixtures) {
      try { await deleteFixture(sql, f); } catch { /* ignore */ }
    }
    await app.close();
    await sql.end();
  });

  test('GET /api/teams/:teamId/chief —— 命中规则 chief-<userId>-<teamId>', async () => {
    const f = await seedFixture(sql, 'chief-get');
    fixtures.push(f);
    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'GET',
      url: `/api/teams/${f.teamId}/chief?userId=${f.userId}`,
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as { chief: { id: string; charter: string | null; agentName: string | null } | null };
    assert.ok(body.chief, 'chief 必须存在');
    assert.equal(body.chief?.id, f.chiefId);
    assert.equal(body.chief?.charter, '初始 charter');
    assert.equal(body.chief?.agentName, f.label);
  });

  test('GET /api/teams/:teamId/chief —— 没有 chief 时返回 {chief: null}', async () => {
    const f = await seedChiefOnly(sql, 'chief-null');
    fixtures.push(f);
    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'GET',
      url: `/api/teams/${f.teamId}/chief?userId=${f.userId}`,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { chief: unknown };
    assert.equal(body.chief, null);
  });

  test('GET /api/teams/:teamId/chief —— 无凭据 → 401，且不会惰性建 chief', async () => {
    const f = await seedChiefOnly(sql, 'chief-noauth');
    fixtures.push(f);
    const res = await app.inject({ method: 'GET', url: `/api/teams/${f.teamId}/chief` });
    assert.equal(res.statusCode, 401, `body=${res.body}`);
    const rows = await sql<{ n: number }[]>`select count(*)::int as n from "chief" where team_id = ${f.teamId}`;
    assert.equal(Number(rows[0]?.n), 0, '无凭据的请求不该在库里留下 chief 行');
  });

  test('GET 不创建 chief —— 只读端点不得留下副作用', async () => {
    const f = await seedChiefOnly(sql, 'chief-no-write');
    fixtures.push(f);
    await app.inject({ method: 'GET', url: `/api/teams/${f.teamId}/chief?userId=${f.userId}` , headers: { authorization: `Bearer ${f.key}` } });
    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from "chief" where id = ${f.chiefId}
    `;
    assert.equal(rows[0]?.n, 0, 'GET 之后 chief 仍应不存在');
  });

  test('PUT charter 会惰性创建 chief（原站：首次用 Chief 才建）', async () => {
    const f = await seedChiefOnly(sql, 'chief-lazy');
    fixtures.push(f);

    const before = await sql<{ n: number }[]>`
      select count(*)::int as n from "chief" where id = ${f.chiefId}
    `;
    assert.equal(before[0]?.n, 0, '前置：chief 不存在');

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'PUT',
      url: `/api/teams/${f.teamId}/chief/charter`,
      payload: { userId: f.userId, charter: '首次使用就写 charter' },
    });
    assert.equal(res.statusCode, 200);

    const rows = await sql<{ charter: string }[]>`
      select charter from "chief" where id = ${f.chiefId}
    `;
    assert.equal(rows[0]?.charter, '首次使用就写 charter', 'chief 应被建出来并写入 charter');
  });

  test('建 topic 会惰性创建 chief', async () => {
    const f = await seedChiefOnly(sql, 'chief-lazy-thread');
    fixtures.push(f);

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/chief/threads`,
      payload: { userId: f.userId, title: '帮我组建团队' },
    });
    assert.equal(res.statusCode, 200);

    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from "chief" where id = ${f.chiefId}
    `;
    assert.equal(rows[0]?.n, 1, '建 topic 之后 chief 应存在');
  });

  test('团队没有任何 agent 时建 Chief 报 409（Chief 需要运行时载体）', async () => {
    const f = await seedChiefOnly(sql, 'chief-no-agent');
    fixtures.push(f);
    await sql`delete from "agent" where team_id = ${f.teamId}`;

    // 前置：chief 行不存在（seedChiefOnly 不插 chief）—— 409 拒绝后必须仍然不存在。
    const before = await sql<{ n: number }[]>`
      select count(*)::int as n from "chief" where id = ${f.chiefId}
    `;
    assert.equal(before[0]?.n, 0, '前置：chief 行不存在');

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'PUT',
      url: `/api/teams/${f.teamId}/chief/charter`,
      payload: { userId: f.userId, charter: 'x' },
    });
    assert.equal(res.statusCode, 409);

    // 拒绝后查库：chief 仍不应被惰性创建（否则 ensureChief 在 agent 缺失分支提早建了行）。
    const after = await sql<{ n: number }[]>`
      select count(*)::int as n from "chief" where id = ${f.chiefId}
    `;
    assert.equal(after[0]?.n, 0, '409 拒绝后 chief 行仍应不存在（不能留下半截副作用）');
  });

  test('PUT /api/teams/:teamId/chief/charter —— 写库 + 审计', async () => {
    const f = await seedFixture(sql, 'chief-charter');
    fixtures.push(f);

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'PUT',
      url: `/api/teams/${f.teamId}/chief/charter`,
      payload: { userId: f.userId, charter: '新的 charter 内容 —— 长一点' },
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as { ok: boolean; id: string };
    assert.equal(body.ok, true);
    assert.equal(body.id, f.chiefId);

    const rows = await sql<{ charter: string }[]>`
      select charter from "chief" where id = ${f.chiefId}
    `;
    assert.equal(rows[0]?.charter, '新的 charter 内容 —— 长一点');

    const audits = await sql<{ type: string }[]>`
      select type from "audit_event" where team_id = ${f.teamId} and type = 'chief_charter_updated'
    `;
    assert.equal(audits.length, 1);
  });

  test('PUT /api/teams/:teamId/chief/charter —— 非 team 成员 403', async () => {
    const f = await seedFixture(sql, 'chief-charter-403');
    fixtures.push(f);

    // 前置：seedFixture 把 chief.charter 写为 '初始 charter'，403 拒绝后必须仍等于这个值。
    const before = await sql<{ charter: string | null }[]>`
      select charter from "chief" where id = ${f.chiefId}
    `;
    assert.equal(before[0]?.charter, '初始 charter', '前置：charter 必须是 seed 的初值');

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'PUT',
      url: `/api/teams/${f.teamId}/chief/charter`,
      payload: { userId: 'stranger-id', charter: 'bad' },
    });
    assert.equal(res.statusCode, 403);

    // 拒绝后查库：charter 字面值与 before 完全一致。
    const after = await sql<{ charter: string | null }[]>`
      select charter from "chief" where id = ${f.chiefId}
    `;
    assert.equal(after[0]?.charter, '初始 charter', '403 拒绝后 charter 必须未被改写');
  });

  test('POST /api/teams/:teamId/chief/threads —— 正常建 topic', async () => {
    const f = await seedFixture(sql, 'thread-create');
    fixtures.push(f);
    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/chief/threads`,
      payload: { userId: f.userId, title: '主题：项目 A 的设计', initialMessage: null },
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as { id: string; title: string; totalTopics: number };
    assert.ok(body.id.length > 0);
    assert.equal(body.title, '主题：项目 A 的设计');
    assert.equal(body.totalTopics, 1);

    const rows = await sql<{ title: string; chief_id: string }[]>`
      select title, chief_id from "chief_thread" where id = ${body.id}
    `;
    assert.equal(rows[0]?.title, '主题：项目 A 的设计');
    assert.equal(rows[0]?.chief_id, f.chiefId);
  });

  test('POST threads —— 50 上限：超了 422', async () => {
    const f = await seedFixture(sql, 'thread-cap');
    fixtures.push(f);
    // 直接插 50 条 thread 把它打到上限
    const ts = now();
    const session = JSON.stringify({ runtime: 'claude-code', id: 's', openedAt: ts });
    for (let i = 0; i < 50; i++) {
      await sql`
        insert into "chief_thread"
          (id, chief_id, title, session, tool_def_hashes, watched_todos, created_at, updated_at)
        values
          (${newId()}, ${f.chiefId}, ${'主题 ' + i}, ${session}::jsonb, '{}'::jsonb, '{}', ${ts}, ${ts})
      `;
    }

    // 前置：刚好 50 条 —— 422 拒绝后必须仍是 50（第 51 条没进来）。
    const before = await sql<{ n: number }[]>`
      select count(*)::int as n from "chief_thread" where chief_id = ${f.chiefId}
    `;
    assert.equal(before[0]?.n, 50, '前置：50 条 thread 刚好打到上限');

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/chief/threads`,
      payload: { userId: f.userId, title: '第 51 个', initialMessage: null },
    });
    assert.equal(res.statusCode, 422, `body=${res.body}`);
    assert.match(res.body, /topic limit reached/);

    // 拒绝后查库：行数仍为 50，第 51 条必须没落库。
    const after = await sql<{ n: number }[]>`
      select count(*)::int as n from "chief_thread" where chief_id = ${f.chiefId}
    `;
    assert.equal(after[0]?.n, 50, '422 拒绝后 chief_thread 行数必须仍为 50（第 51 条没落库）');
  });

  test('GET /api/teams/:teamId/chief/threads —— 列出 topic（实测字段）', async () => {
    const f = await seedFixture(sql, 'thread-list');
    fixtures.push(f);

    // 建 2 个 topic
    for (const title of ['t1', 't2']) {
      await app.inject({
              headers: { authorization: `Bearer ${f.key}` },
        method: 'POST',
        url: `/api/teams/${f.teamId}/chief/threads`,
        payload: { userId: f.userId, title, initialMessage: null },
      });
    }

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'GET',
      url: `/api/teams/${f.teamId}/chief/threads?userId=${f.userId}`,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as {
      threads: Array<{
        id: string;
        chiefId: string;
        title: string;
        session: { runtime: string; id: string; openedAt: number };
        watchedTodos: string[];
        toolDefHashes: Record<string, string>;
        pendingSessionResumeAt: number | null;
        lastTurnAt: number | null;
      }>;
    };
    assert.equal(body.threads.length, 2);

    const first = body.threads[0];
    assert.ok(first);
    assert.equal(first.chiefId, f.chiefId);
    assert.equal(typeof first.id, 'string');
    assert.equal(typeof first.session.runtime, 'string');
    assert.equal(typeof first.session.openedAt, 'number');
    assert.deepEqual(first.watchedTodos, []);
    assert.deepEqual(first.toolDefHashes, {});
  });

  test('GET /api/chief/threads/:threadId —— 单 topic 详情', async () => {
    const f = await seedFixture(sql, 'thread-one');
    fixtures.push(f);
    const create = await app.inject({
                           headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/chief/threads`,
      payload: { userId: f.userId, title: '单条', initialMessage: null },
    });
    const { id } = JSON.parse(create.body) as { id: string };

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'GET',
      url: `/api/chief/threads/${id}`,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { thread: { id: string; title: string } };
    assert.equal(body.thread.id, id);
    assert.equal(body.thread.title, '单条');
  });

  test('GET /api/chief/threads/:threadId —— 不存在 404', async () => {
    const f = await seedChiefOnly(sql, 'thread-404');
    fixtures.push(f);
    const res = await app.inject({
      method: 'GET',
      url: '/api/chief/threads/nope-not-exist',
      headers: { authorization: `Bearer ${f.key}` },
    });
    assert.equal(res.statusCode, 404, `body=${res.body}`);
  });

  // 2026-10-18 修正契约。
  //
  // 此前这里断言「未知 conv → 403」，理由是「不泄露存在性」。但这个判断对
  // **Chief topic** 是错的：topic 的 `session.id` 是 thread 的会话 id，不是
  // build id —— 还没派工的 topic 查 `builds.id = <session.id>` 必然查不到。
  // 于是用户打开 Workspace 左侧对话面板看到的是「数据未就绪：http-403」，
  // 而实际只是「这个 topic 还没有对话记录」。
  //
  // 既有文档 `chief-routes.md:18` 写的就是「topic 没绑 build 时返空 messages
  // 不 500」，**实现与文档相反**。现在改成与文档一致。
  //
  // ⚠️ 安全边界没有放宽：查到 build 行时仍然 `requireTeamMembership`，
  // 跨团队仍是 403。「查不到」返回空列表、「查到但无权限」返回 403 ——
  // 两者对非成员都不可区分，不泄露存在性。下一条测试专门锁这一点。
  test('GET /api/conversations/:convId/messages —— 查不到 build 行返回空列表（Chief topic 未派工的正常状态）', async () => {
    const f = await seedChiefOnly(sql, 'conv-unknown');
    fixtures.push(f);
    const res = await app.inject({
      method: 'GET',
      url: '/api/conversations/conv-nonexistent/messages',
      headers: { authorization: `Bearer ${f.key}` },
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as { messages: unknown[] };
    assert.deepEqual(body.messages, [], '未绑 build 的 topic 应是空对话，不是 403');
  });

  // 上一条放宽的是「查不到」，这条锁住「查到但无权限仍然是 403」——
  // 少了它，放宽就变成了跨团队可读。
  test('GET /api/conversations/:convId/messages —— build 存在但跨团队仍 403（放宽只针对查不到）', async () => {
    const home = await seedChiefOnly(sql, 'conv-home');
    const other = await seedChiefOnly(sql, 'conv-other');
    fixtures.push(home, other);

    const ts = now();
    const todoId = newId();
    const convId = newId();
    await sql`
      insert into "todo"
        (id, project_id, seq_num, owner_member_id, agent_id, title, tag_ids, phase,
         plan_first, separate_plan_build, with_checklist, created_at, updated_at)
      values
        (${todoId}, ${home.projectId}, 1, ${home.memberId}, ${home.agentId}, 'cross conv', '{}', 'todo',
         true, false, false, ${ts}, ${ts})
    `;
    await sql`
      insert into "build"
        (id, todo_id, n, branch, prev_phase, trigger_source, with_plan, with_checklist,
         agent_id, session, usage_by_model, created_at, v)
      values
        (${convId}, ${todoId}, 1, ${'tds/conv-' + convId}, null, 'chief', true, false,
         ${home.agentId}, ${JSON.stringify({ runtime: 'claude-code', id: 's', openedAt: ts })}::jsonb,
         '[]'::jsonb, ${ts}, 0)
    `;

    // 用 other 团队的 key 去读 home 团队的 conversation
    const res = await app.inject({
      method: 'GET',
      url: `/api/conversations/${convId}/messages`,
      headers: { authorization: `Bearer ${other.key}` },
    });
    assert.equal(res.statusCode, 403, `跨团队必须是 403，body=${res.body}`);
    assert.match(res.body, /not accessible|403/);
  });

  test('GET /api/conversations/:convId/messages —— 自己团队的空 conv 返回空数组', async () => {
    const f = await seedChiefOnly(sql, 'conv-empty');
    fixtures.push(f);
    const ts = now();
    const todoId = newId();
    const convId = newId();
    await sql`
      insert into "todo"
        (id, project_id, seq_num, owner_member_id, agent_id, title, tag_ids, phase,
         plan_first, separate_plan_build, with_checklist, created_at, updated_at)
      values
        (${todoId}, ${f.projectId}, 1, ${f.memberId}, ${f.agentId}, 'conv todo', '{}', 'todo',
         true, false, false, ${ts}, ${ts})
    `;
    await sql`
      insert into "build"
        (id, todo_id, n, branch, prev_phase, trigger_source, with_plan, with_checklist,
         agent_id, session, usage_by_model, created_at, v)
      values
        (${convId}, ${todoId}, 1, ${'tds/conv-' + convId}, null, 'chief', true, false,
         ${f.agentId}, ${JSON.stringify({ runtime: 'claude-code', id: 's', openedAt: ts })}::jsonb,
         '[]'::jsonb, ${ts}, 0)
    `;
    const res = await app.inject({
      method: 'GET',
      url: `/api/conversations/${convId}/messages`,
      headers: { authorization: `Bearer ${f.key}` },
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as { messages: unknown[] };
    assert.deepEqual(body.messages, []);
  });

  test('POST /api/chief/threads/:threadId/dispatch —— 无机器时 phase=queued', async () => {
    const f = await seedFixture(sql, 'dispatch-no-machine');
    fixtures.push(f);

    // 建 topic
    const create = await app.inject({
                           headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/chief/threads`,
      payload: { userId: f.userId, title: 'no-machine', initialMessage: null },
    });
    const { id: threadId } = JSON.parse(create.body) as { id: string };

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/chief/threads/${threadId}/dispatch`,
      payload: {
        teamId: f.teamId,
        projectId: f.projectId,
        ownerMemberId: f.memberId,
        agentId: f.agentId,
        title: '离线派的活',
        spec: '复刻 todo',
      },
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as {
      todoId: string;
      buildId: string;
      stepId: string | null;
      phase: string;
    };
    assert.equal(body.phase, 'queued', '无机器时必须停在 queued');
    assert.equal(body.stepId, null, '无机器时不建 step');

    // todo 落 queued
    const todoRows = await sql<{ phase: string }[]>`
      select phase from "todo" where id = ${body.todoId}
    `;
    assert.equal(todoRows[0]?.phase, 'queued');

    // build 落库，branch 与 triggerSource 校验
    const buildRows = await sql<{ branch: string; trigger_source: string; n: number }[]>`
      select branch, trigger_source, n from "build" where id = ${body.buildId}
    `;
    assert.equal(buildRows[0]?.branch, `tds/conv-${body.buildId}`);
    assert.equal(buildRows[0]?.trigger_source, 'chief');

    // thread.watchedTodos 自动加入该 todoId
    const threadRows = await sql<{ watched_todos: string[] }[]>`
      select watched_todos from "chief_thread" where id = ${threadId}
    `;
    assert.deepEqual(threadRows[0]?.watched_todos, [body.todoId]);
  });

  test('POST dispatch —— 有在线机器时 phase=planning，build 与 step 齐活', async () => {
    const f = await seedFixture(sql, 'dispatch-with-machine');
    fixtures.push(f);

    // 加一台在线机器
    const machineId = newId();
    const ts = now();
    await sql`
      insert into "machine"
        (id, team_id, name, device_id, enrolled_by, max_concurrent_tasks, runtimes, disabled_runtimes, hardware, is_online, created_at, updated_at)
      values
        (${machineId}, ${f.teamId}, 'test-mc', 'dev-1', ${f.userId}, 6, ARRAY['claude-code']::text[], ARRAY[]::text[], '{}'::jsonb, true, ${ts}, ${ts})
    `;

    const create = await app.inject({
                           headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/chief/threads`,
      payload: { userId: f.userId, title: 'with-machine', initialMessage: null },
    });
    const { id: threadId } = JSON.parse(create.body) as { id: string };

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/chief/threads/${threadId}/dispatch`,
      payload: {
        teamId: f.teamId,
        projectId: f.projectId,
        ownerMemberId: f.memberId,
        agentId: f.agentId,
        title: '派给机器',
        spec: '要做的活',
      },
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as {
      todoId: string;
      buildId: string;
      stepId: string | null;
      phase: string;
    };
    assert.equal(body.phase, 'planning', '有机器：claim 后进 planning（transition 产物）');
    assert.ok(body.stepId, '有机器时必须建 step');

    const todoRows = await sql<{ phase: string }[]>`
      select phase from "todo" where id = ${body.todoId}
    `;
    assert.equal(todoRows[0]?.phase, 'planning');

    const stepRows = await sql<{ status: string; machine_id: string | null }[]>`
      select status, machine_id from "step" where id = ${body.stepId}
    `;
    assert.equal(stepRows[0]?.status, 'queued');
    assert.equal(stepRows[0]?.machine_id, null, 'claim 还没执行前 machine_id 必为空');

    const auditRows = await sql<{ type: string; payload: Record<string, unknown> }[]>`
      select type, payload from "audit_event"
      where todo_id = ${body.todoId} and type = 'dispatched'
    `;
    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0]?.payload['hasMachine'], true);
    assert.equal(auditRows[0]?.payload['threadId'], threadId);
  });

  test('POST dispatch —— 同一 todo 不重复 watch', async () => {
    const f = await seedFixture(sql, 'dispatch-dedup');
    fixtures.push(f);

    const create = await app.inject({
                           headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/chief/threads`,
      payload: { userId: f.userId, title: 'dedup', initialMessage: null },
    });
    const { id: threadId } = JSON.parse(create.body) as { id: string };

    // 第一次派：watchedTodos 加入 first.todoId
    const res1 = await app.inject({
                         headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/chief/threads/${threadId}/dispatch`,
      payload: {
        teamId: f.teamId,
        projectId: f.projectId,
        ownerMemberId: f.memberId,
        agentId: f.agentId,
        title: '首次派',
        spec: null,
      },
    });
    assert.equal(res1.statusCode, 200, `body=${res1.body}`);
    const first = JSON.parse(res1.body) as { todoId: string };

    // 第二次派一个完全不同的 todo —— watchedTodos 增加 second.todoId，不影响 first
    const res2 = await app.inject({
                         headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/chief/threads/${threadId}/dispatch`,
      payload: {
        teamId: f.teamId,
        projectId: f.projectId,
        ownerMemberId: f.memberId,
        agentId: f.agentId,
        title: '再派',
        spec: null,
      },
    });
    assert.equal(res2.statusCode, 200, `body=${res2.body}`);
    const second = JSON.parse(res2.body) as { todoId: string };
    assert.notEqual(first.todoId, second.todoId);

    // 校验 watchedTodos：包含 first + second，且 first 只出现一次
    const rows = await sql<{ watched_todos: string[] }[]>`
      select watched_todos from "chief_thread" where id = ${threadId}
    `;
    const watched = rows[0]?.watched_todos ?? [];
    assert.equal(watched.length, 2, 'watchedTodos 仅有两个 todo');
    assert.equal(watched.filter((t) => t === first.todoId).length, 1, 'first todoId 只入 1 次');
    assert.ok(watched.includes(second.todoId));
  });

  test('POST dispatch —— 缺失 threadId 返回 404', async () => {
    const f = await seedChiefOnly(sql, 'dispatch-404');
    fixtures.push(f);
    const res = await app.inject({
      method: 'POST',
      url: '/api/chief/threads/no-such-thread/dispatch',
      headers: { authorization: `Bearer ${f.key}` },
      payload: {
        teamId: f.teamId, projectId: f.projectId, ownerMemberId: f.memberId,
        agentId: f.agentId, title: 'x', spec: null,
      },
    });
    assert.equal(res.statusCode, 404, `body=${res.body}`);
    const rows = await sql<{ n: number }[]>`select count(*)::int as n from "todo" where project_id = ${f.projectId}`;
    assert.equal(Number(rows[0]?.n), 0, 'thread 不存在时不该建 todo');
  });

  test('POST dispatch —— body 缺字段返回 422', async () => {
    const f = await seedFixture(sql, 'dispatch-bad-body');
    fixtures.push(f);
    const create = await app.inject({
                           headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/chief/threads`,
      payload: { userId: f.userId, title: 'bad', initialMessage: null },
    });
    const { id: threadId } = JSON.parse(create.body) as { id: string };

    // 前置：本项目下 0 条 todo / 0 条 build / 0 条 step（其它测试的 fixture 也都带独立 projectId，不会串）。
    const beforeTodo = await sql<{ n: number }[]>`
      select count(*)::int as n from "todo" where project_id = ${f.projectId}
    `;
    const beforeBuild = await sql<{ n: number }[]>`
      select count(*)::int as n from "build" where todo_id in (select id from "todo" where project_id = ${f.projectId})
    `;
    const beforeStep = await sql<{ n: number }[]>`
      select count(*)::int as n from "step" where build_id in (select b.id from "build" b join "todo" t on b.todo_id = t.id where t.project_id = ${f.projectId})
    `;
    assert.equal(beforeTodo[0]?.n, 0, '前置：本项目下 todo=0');
    assert.equal(beforeBuild[0]?.n, 0, '前置：本项目下 build=0');
    assert.equal(beforeStep[0]?.n, 0, '前置：本项目下 step=0');

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/chief/threads/${threadId}/dispatch`,
      payload: { title: 'x' },
    });
    assert.equal(res.statusCode, 422);

    // 拒绝后查库：3 张表都不能多 —— zod 失败必须早于 dispatchTodo，不应留半截。
    const afterTodo = await sql<{ n: number }[]>`
      select count(*)::int as n from "todo" where project_id = ${f.projectId}
    `;
    const afterBuild = await sql<{ n: number }[]>`
      select count(*)::int as n from "build" where todo_id in (select id from "todo" where project_id = ${f.projectId})
    `;
    const afterStep = await sql<{ n: number }[]>`
      select count(*)::int as n from "step" where build_id in (select b.id from "build" b join "todo" t on b.todo_id = t.id where t.project_id = ${f.projectId})
    `;
    assert.equal(afterTodo[0]?.n, 0, '422 拒绝后 todo 仍应=0（不能留半截 todo）');
    assert.equal(afterBuild[0]?.n, 0, '422 拒绝后 build 仍应=0（不能留半截 build）');
    assert.equal(afterStep[0]?.n, 0, '422 拒绝后 step 仍应=0（不能留半截 step）');
  });

  test('GET /api/chief/threads/:threadId/watches —— 列出 watched todos', async () => {
    const f = await seedFixture(sql, 'watches-list');
    fixtures.push(f);

    const create = await app.inject({
                           headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/chief/threads`,
      payload: { userId: f.userId, title: 'watch', initialMessage: null },
    });
    const { id: threadId } = JSON.parse(create.body) as { id: string };

    // 无机器直接派
    const dis = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/chief/threads/${threadId}/dispatch`,
      payload: {
        teamId: f.teamId,
        projectId: f.projectId,
        ownerMemberId: f.memberId,
        agentId: f.agentId,
        title: '被 watch 的活',
        spec: null,
      },
    });
    const { todoId } = JSON.parse(dis.body) as { todoId: string };

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'GET',
      url: `/api/chief/threads/${threadId}/watches`,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { watches: Array<{ id: string; phase: string }> };
    assert.equal(body.watches.length, 1);
    assert.equal(body.watches[0]?.id, todoId);
    assert.equal(body.watches[0]?.phase, 'queued');
  });

  test('GET watches —— thread 不存在 404', async () => {
    const f = await seedChiefOnly(sql, 'watches-404');
    fixtures.push(f);
    const res = await app.inject({
      method: 'GET',
      url: '/api/chief/threads/none/watches',
      headers: { authorization: `Bearer ${f.key}` },
    });
    assert.equal(res.statusCode, 404, `body=${res.body}`);
  });

  test('A 团队的 key 打 B 团队的 chief → 403，且库里没写', async () => {
    const a = await seedChiefOnly(sql, 'chief-A');
    const b = await seedChiefOnly(sql, 'chief-B');
    const before = await sql<{ n: number }[]>`select count(*)::int as n from "chief" where team_id = ${b.teamId}`;
    const res = await app.inject({
      method: 'GET',
      url: `/api/teams/${b.teamId}/chief`,
      headers: { authorization: `Bearer ${a.key}` },
    });
    assert.equal(res.statusCode, 403, res.body);
    assert.match(res.body, /is not accessible to this key's owner/);
    const after = await sql<{ n: number }[]>`select count(*)::int as n from "chief" where team_id = ${b.teamId}`;
    assert.equal(Number(after[0]?.n), Number(before[0]?.n), '403 不该写库');
  });
});
