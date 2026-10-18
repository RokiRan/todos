import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as dbPkg from '@tds/db';
import { transition, isGate } from '@tds/protocol';
import Fastify from 'fastify';
import { newId, now } from '../src/ids.js';
import { generateApiKey } from '../src/crypto.js';
import { registerTodoRoutes } from '../src/routes/todos.js';

/**
 * todos REST 路由层验证。
 *
 * 关键闸门铁律必须在 **路由层** 重新验证一次（不只 protocol 层）：
 *   - 路由层的 approve / complete / feedback 必须真的走 transition()，
 *     不许手写 phase 判断后直接 update
 *   - feedback 永远不能推进 phase，哪怕 transition() 返回了 ok=true，
 *     路由层的二次断言也必须挡掉「意外的 phase 变更」
 *
 * 用 Fastify app.inject 跑端到端；DB 是开发机 127.0.0.1:5433 上的 tds 真库。
 * 每条 test 用独立的 fixture，并在 after 兜底清理。
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://tds:tds_local_dev@127.0.0.1:5433/tds';
const dbSchema = dbPkg.schema;

function buildTestApp(
  db: ReturnType<typeof drizzle<typeof dbPkg.schema>>,
): ReturnType<typeof Fastify> {
  const app = Fastify({ logger: false });
  app.decorate('machineUrl', 'http://test');
  registerTodoRoutes(app, db as never);
  return app;
}

interface Fixture {
  label: string;
  userId: string;
  teamId: string;
  projectId: string;
  memberId: string;
  agentId: string;
  key: string;
}

async function seedFixture(sql: postgres.Sql, label: string): Promise<Fixture> {
  const ts = now();
  const userId = newId();
  const teamId = newId();
  const memberId = newId();
  const agentId = newId();
  const projectId = newId();

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
  // member 行：actor_id 指向 user 行；actor 不需要全局唯一，仅 (team, actor, type) 联合唯一
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
  return { label, userId, teamId, projectId, memberId, agentId, key: k.key };
}

async function createTodoRow(
  sql: postgres.Sql,
  f: Fixture,
  phase: 'todo' | 'confirm' | 'review',
): Promise<{ id: string; seq: number }> {
  const id = newId();
  const ts = now();
  const seqRow = await sql<{ next_seq_num: number }[]>`
    select next_seq_num from "project" where id = ${f.projectId}
  `;
  const seq = seqRow[0]?.next_seq_num ?? 1;
  await sql`update "project" set next_seq_num = next_seq_num + 1 where id = ${f.projectId}`;
  await sql`
    insert into "todo"
      (id, project_id, seq_num, owner_member_id, agent_id, title, tag_ids, phase, plan_first, separate_plan_build, with_checklist, created_at, updated_at)
    values
      (${id}, ${f.projectId}, ${seq}, ${f.memberId}, ${f.agentId}, 'test', '{}', ${phase}, true, false, false, ${ts}, ${ts})
  `;
  return { id, seq };
}

async function createBuildRow(
  sql: postgres.Sql,
  f: Fixture,
  todoId: string,
): Promise<{ id: string; n: number }> {
  const id = newId();
  const ts = now();
  const session = JSON.stringify({ runtime: 'claude-code', id: 's', openedAt: ts });
  await sql`
    insert into "build"
      (id, todo_id, n, branch, prev_phase, trigger_source, with_plan, with_checklist, agent_id, session, usage_by_model, created_at, v)
    values
      (${id}, ${todoId}, 1, ${'tds/conv-' + id}, 'planning', 'user', false, false, ${f.agentId}, ${session}::jsonb, '[]'::jsonb, ${ts}, 0)
  `;
  return { id, n: 1 };
}

async function deleteFixture(sql: postgres.Sql, f: Fixture): Promise<void> {
  // project / member / agent / team / user —— 用反序删除避开 FK 报错
  // project 没 users，cascade 走 team 端
  await sql`delete from "team" where id = ${f.teamId}`;
  await sql`delete from "user" where id = ${f.userId}`;
}

// ── 单测 ─────────────────────────────────────────────────────────────

describe('todos 路由 —— 闸门铁律在路由层也成立', () => {
  let sql: postgres.Sql;
  let db: ReturnType<typeof drizzle<typeof dbPkg.schema>>;
  let app: ReturnType<typeof Fastify>;
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

  test('transition 包自己保证的三条铁律 —— 路由层不重复声明，作为 import 探针', () => {
    assert.equal(
      transition('confirm', { kind: 'approve', by: 'user' }).next,
      'implement',
    );
    assert.equal(
      transition('review', { kind: 'complete', merge: false }).next,
      'done',
    );
    assert.equal(
      transition('confirm', { kind: 'revision_feedback' }).next,
      'confirm',
      '产品铁律：feedback 不能推进闸门',
    );
    assert.equal(isGate('review'), true);
  });

  test('approve 在 confirm 闸门上：phase → implement，且 DB 真落 implement', async () => {
    const f = await seedFixture(sql, 'approve-ok');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'confirm');
    await createBuildRow(sql, f, todoId);

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/todos/${todoId}/approve`,
      payload: { by: 'user' },
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as { ok: boolean; phase: string };
    assert.equal(body.ok, true);
    assert.equal(body.phase, 'implement');

    const rows = await sql<{ phase: string }[]>`select phase from "todo" where id = ${todoId}`;
    assert.equal(rows[0]?.phase, 'implement');
  });

  test('approve 在非 confirm phase 上：返回 409，不进 transition', async () => {
    const f = await seedFixture(sql, 'approve-wrong');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'todo');

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/todos/${todoId}/approve`,
      payload: { by: 'user' },
    });
    assert.equal(res.statusCode, 409, `body=${res.body}`);
    assert.match(res.body, /approve is only valid at confirm/);

    const rows = await sql<{ phase: string }[]>`select phase from "todo" where id = ${todoId}`;
    assert.equal(rows[0]?.phase, 'todo');
  });

  test('complete 在 review 闸门上：未勾合并时 phase → done', async () => {
    const f = await seedFixture(sql, 'complete-no-merge');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'review');
    await createBuildRow(sql, f, todoId);

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/todos/${todoId}/complete`,
      payload: { merge: false },
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as { ok: boolean; phase: string; mergeDispatch: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.phase, 'done');
    assert.equal(body.mergeDispatch, false);
  });

  test('complete 在 review 闸门上：勾合并时 phase → implement', async () => {
    const f = await seedFixture(sql, 'complete-merge');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'review');
    await createBuildRow(sql, f, todoId);

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/todos/${todoId}/complete`,
      payload: { merge: true },
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as { ok: boolean; phase: string; mergeDispatch: boolean };
    assert.equal(body.phase, 'implement');
    assert.equal(body.mergeDispatch, true);
  });

  test('complete 在非 review 上：返回 409', async () => {
    const f = await seedFixture(sql, 'complete-wrong');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'confirm');

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/todos/${todoId}/complete`,
      payload: { merge: false },
    });
    assert.equal(res.statusCode, 409);
  });

  test('feedback 在 confirm 闸门上：phase 不变（产品铁律）', async () => {
    const f = await seedFixture(sql, 'feedback-confirm');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'confirm');
    const { id: buildId } = await createBuildRow(sql, f, todoId);

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/todos/${todoId}/feedback`,
      payload: { message: '请更详细一些' },
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as {
      ok: boolean; phase: string; advanced: boolean; revisionDispatched: boolean;
    };
    assert.equal(body.ok, true);
    assert.equal(body.phase, 'confirm', 'feedback 永远停在原闸门');
    assert.equal(body.advanced, false);
    assert.equal(body.revisionDispatched, true);

    const rows = await sql<{ phase: string }[]>`select phase from "todo" where id = ${todoId}`;
    assert.equal(rows[0]?.phase, 'confirm');

    const docs = await sql<{ kind: string; payload: Record<string, unknown> }[]>`
      select kind, payload from "document" where build_id = ${buildId}
    `;
    const inputDocs = docs.filter((d) => d.kind === 'input');
    assert.ok(inputDocs.length >= 1, 'input 文档必须落库');
    assert.equal(inputDocs[0]?.payload['message'], '请更详细一些');
  });

  test('feedback 在 review 闸门上：同样 phase 不变', async () => {
    const f = await seedFixture(sql, 'feedback-review');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'review');
    await createBuildRow(sql, f, todoId);

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/todos/${todoId}/feedback`,
      payload: { message: 'diff OK 但还要 X' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { phase: string; advanced: boolean };
    assert.equal(body.phase, 'review');
    assert.equal(body.advanced, false);
  });

  test('feedback 在闸门外的 phase 上：返回 409，不进 transition', async () => {
    const f = await seedFixture(sql, 'feedback-out-of-gate');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'todo');

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/todos/${todoId}/feedback`,
      payload: { message: 'hi' },
    });
    assert.equal(res.statusCode, 409, `body=${res.body}`);
  });

  test('POST /api/todos —— 创建成功，phase=todo', async () => {
    const f = await seedFixture(sql, 'create-ok');
    fixtures.push(f);

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: '/api/todos',
      payload: {
        teamId: f.teamId,
        projectId: f.projectId,
        ownerMemberId: f.memberId,
        agentId: f.agentId,
        title: '做点啥',
        spec: '需求描述',
        tagIds: [],
        planFirst: true,
      },
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as { id: string; seqNum: number };
    assert.ok(body.id.length > 0);
    assert.ok(body.seqNum >= 1);

    const rows = await sql<{ phase: string; title: string; spec: string | null }[]>`
      select phase, title, spec from "todo" where id = ${body.id}
    `;
    assert.equal(rows[0]?.phase, 'todo');
    assert.equal(rows[0]?.title, '做点啥');
    assert.equal(rows[0]?.spec, '需求描述');
  });

  test('POST /api/todos —— 超长 spec（801 字符）触发 422', async () => {
    const f = await seedFixture(sql, 'create-long-spec');
    fixtures.push(f);

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: '/api/todos',
      payload: {
        teamId: f.teamId,
        projectId: f.projectId,
        ownerMemberId: f.memberId,
        title: 'long spec',
        spec: 'x'.repeat(801),
        tagIds: [],
        planFirst: true,
      },
    });
    assert.equal(res.statusCode, 422, `body=${res.body}`);
  });

  test('GET /api/todos/:id/documents —— todo 不存在返回 404 而非空列表', async () => {
    // 回归：曾经对不存在的 todo 也返回 {documents: []}，
    // 客户端无法区分「todo 不存在」与「todo 还没有 build」。
    const f = await seedFixture(sql, 'docs-404');
    fixtures.push(f);
    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'GET',
      url: '/api/todos/definitely-not-a-real-todo/documents',
    });
    assert.equal(res.statusCode, 404, `body=${res.body}`);
  });

  test('GET /api/todos/:id/documents —— todo 存在但无 build 时返回空列表', async () => {
    const f = await seedFixture(sql, 'docs-empty');
    fixtures.push(f);

    const created = await app.inject({
                            headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: '/api/todos',
      payload: {
        teamId: f.teamId,
        projectId: f.projectId,
        ownerMemberId: f.memberId,
        agentId: f.agentId,
        title: '还没有 build 的 todo',
        spec: null,
        tagIds: [],
        planFirst: true,
      },
    });
    assert.equal(created.statusCode, 200, `body=${created.body}`);
    const todoId = (JSON.parse(created.body) as { id: string }).id;

    const res = await app.inject({ method: 'GET', url: `/api/todos/${todoId}/documents` , headers: { authorization: `Bearer ${f.key}` } });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as { documents: unknown[] };
    assert.deepEqual(body.documents, [], '存在但无 build 的 todo 应返回空列表');
  });

  test('无凭据打 todo 列表 → 401，且这个项目下没有 todo 被写入', async () => {
    const f = await seedFixture(sql, 'todos-noauth');
    fixtures.push(f);
    // 只数本 fixture 自己项目下的 todo：全表计数会被并行跑的其它测试文件的
    // 写入污染，那时红的是别人的写入，不是这个 401 写的。
    const count = () => sql<{ n: number }[]>`
      select count(*)::int as n from "todo" where project_id = ${f.projectId}
    `;
    const before = await count();
    const res = await app.inject({ method: 'GET', url: `/api/todos?teamId=${f.teamId}` });
    assert.equal(res.statusCode, 401, `body=${res.body}`);
    const after = await count();
    assert.equal(Number(after[0]?.n), Number(before[0]?.n), '401 不该写库');
  });

  test('A 团队的 key 打 B 团队的 todo 列表 → 403，且库里没写', async () => {
    const a = await seedFixture(sql, 'todo-A');
    const b = await seedFixture(sql, 'todo-B');
    fixtures.push(a, b);
    const created = await app.inject({
      method: 'POST',
      url: '/api/todos',
      headers: { authorization: `Bearer ${b.key}` },
      payload: {
        teamId: b.teamId, projectId: b.projectId, ownerMemberId: b.memberId,
        title: 'in B', spec: null, tagIds: [], planFirst: true,
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    const before = await sql<{ n: number }[]>`select count(*)::int as n from "todo" where project_id = ${b.projectId}`;
    const res = await app.inject({
      method: 'GET',
      url: `/api/todos?teamId=${b.teamId}`,
      headers: { authorization: `Bearer ${a.key}` },
    });
    assert.equal(res.statusCode, 403, res.body);
    assert.match(res.body, /is not accessible to this key's owner/);
    const after = await sql<{ n: number }[]>`select count(*)::int as n from "todo" where project_id = ${b.projectId}`;
    assert.equal(Number(after[0]?.n), Number(before[0]?.n), '403 不该写库');
  });

  test('key 是 A、ownerMemberId 传别人团队的成员 → 403，且库里没写', async () => {
    const a = await seedFixture(sql, 'todo-imp');
    const b = await seedFixture(sql, 'todo-victim');
    fixtures.push(a, b);
    const res = await app.inject({
      method: 'POST',
      url: '/api/todos',
      headers: { authorization: `Bearer ${a.key}` },
      payload: {
        teamId: a.teamId, projectId: a.projectId, ownerMemberId: b.memberId,
        title: 'fake owner', spec: null, tagIds: [], planFirst: true,
      },
    });
    assert.equal(res.statusCode, 403, res.body);
    assert.match(res.body, /is not a member of team/);
    const rows = await sql<{ n: number }[]>`select count(*)::int as n from "todo" where project_id = ${a.projectId}`;
    assert.equal(Number(rows[0]?.n), 0, '冒充失败时一行都不该写');
  });
});
