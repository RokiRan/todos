import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import * as dbPkg from '@tds/db';
import { newId, now } from '../src/ids.js';
import { generateApiKey } from '../src/crypto.js';
import { registerNeedsYouRoutes } from '../src/routes/needs-you.js';

/**
 * 「Needs you」路由层验证（真库 + `app.inject`）。
 *
 * 权威定义（`recon-live/docs-chief.md:16`）：
 * > "Needs you gathers everything waiting on your decision: plans to confirm,
 * >  changes to accept, failed runs, and research or question tasks that have
 * >  replied or asked a question."
 *
 * 五类来源，按本端点的实现拆：
 *   1. confirm 闸门     ── 计划待批准（schema: `todo.phase='confirm'`）
 *   2. review 闸门      ── 改动待接受（schema: `todo.phase='review'`）
 *   3. failed run       ── 失败任务（schema: `todo.phase='failed'`）
 *   4. agent 提问       ── 任一运行中 phase + `documents.kind='question'`
 *   5. agent 回复       ── **schema 不支持**，本端点不实现
 *
 * 这里钉住 1/2/3/4 + 跨团队隔离 + 鉴权 + 与写路径的关系（**不**写 phase）。
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://tds:tds_local_dev@127.0.0.1:5433/tds';

let sql: postgres.Sql;
let app: FastifyInstance;

interface Fixture {
  label: string;
  userId: string;
  teamId: string;
  projectId: string;
  memberId: string;
  agentId: string;
  key: string;
}

const fixtures: Fixture[] = [];

async function seedFixture(label: string): Promise<Fixture> {
  const ts = now();
  const userId = newId();
  const teamId = newId();
  const memberId = newId();
  const agentId = newId();
  const projectId = newId();

  await sql`
    insert into "user" (id, email, display_name, status, locale, created_at, updated_at)
    values (${userId}, ${`ny-${label}-${userId}@test.local`}, ${label}, 'active', 'en', ${ts}, ${ts})
  `;
  await sql`
    insert into "team" (id, name, plan, storage_quota, created_at)
    values (${teamId}, ${label}, 'free', 1073741824, ${ts})
  `;
  await sql`
    insert into "member" (id, team_id, actor_id, member_type, role, joined_at, v)
    values (${memberId}, ${teamId}, ${userId}, 'user', 'admin', ${ts}, 0)
  `;
  await sql`
    insert into "agent" (id, team_id, display_name, default_skill_ids, grants, active_task_count, created_at, updated_at)
    values (${agentId}, ${teamId}, ${label}, '{}', '{}'::jsonb, 0, ${ts}, ${ts})
  `;
  await sql`
    insert into "project" (id, team_id, name, provider, repo_kind, default_branch, next_seq_num, created_at)
    values (${projectId}, ${teamId}, ${label}, 'external', 'other', 'main', 1, ${ts})
  `;

  const k = generateApiKey();
  await sql`
    insert into "api_key" (id, user_id, name, key_prefix, key_hash, scopes, created_at)
    values (${newId()}, ${userId}, ${'rest-' + label}, ${k.prefix}, ${k.hash}, ${['*']}, ${ts})
  `;
  const f: Fixture = { label, userId, teamId, projectId, memberId, agentId, key: k.key };
  fixtures.push(f);
  return f;
}

/** 在指定 fixture 的 project 下插入一条 todo，返回 todoId。 */
async function createTodoRow(
  f: Fixture,
  phase:
    | 'todo'
    | 'queued'
    | 'planning'
    | 'confirm'
    | 'implement'
    | 'review'
    | 'reviewing'
    | 'done'
    | 'failed'
    | 'closed',
  opts?: { title?: string },
): Promise<string> {
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
      (${id}, ${f.projectId}, ${seq}, ${f.memberId}, ${f.agentId},
       ${opts?.title ?? 'ny-test'}, '{}', ${phase}, true, false, false, ${ts}, ${ts})
  `;
  return id;
}

/** 插入一条 build 行（question 文档必须挂在 build 下）。 */
async function createBuildRow(f: Fixture, todoId: string): Promise<string> {
  const id = newId();
  const ts = now();
  const session = JSON.stringify({ runtime: 'claude-code', id: 's', openedAt: ts });
  await sql`
    insert into "build"
      (id, todo_id, n, branch, prev_phase, trigger_source, with_plan, with_checklist, agent_id, session, usage_by_model, created_at, v)
    values
      (${id}, ${todoId}, 1, ${'tds/conv-' + id}, 'planning', 'user', false, false, ${f.agentId}, ${session}::jsonb, '[]'::jsonb, ${ts}, 0)
  `;
  return id;
}

/** 给定 build 下插一份 question 文档。 */
async function createQuestionDoc(buildId: string): Promise<string> {
  const id = newId();
  const ts = now();
  await sql`
    insert into "document"
      (id, build_id, kind, version, payload, created_at, updated_at)
    values
      (${id}, ${buildId}, 'question', 1, '{}'::jsonb, ${ts}, ${ts})
  `;
  return id;
}

async function deleteFixture(f: Fixture): Promise<void> {
  // 反序避开 FK 报错：cascade 在 team 端会带走 member/project/agent；
  // todo/build/document 在 project/team cascade 范围内。
  // api_key → user 是双向 FK（apikey 引用 user、user 行被 api_key 引用时
  // 不能直接 delete user）—— 先删 api_key，再删 user，最后删 team 让 cascade
  // 带走 member/project/agent/todo/build/document。
  await sql`delete from "api_key" where user_id = ${f.userId}`;
  await sql`delete from "user" where id = ${f.userId}`;
  await sql`delete from "team" where id = ${f.teamId}`;
}

function auth(key: string): { authorization: string } {
  return { authorization: `Bearer ${key}` };
}

// ── 单测 ────────────────────────────────────────────────────────────

describe('Needs you 路由（recon-live/docs-chief.md:16）', () => {
  before(async () => {
    sql = postgres(DATABASE_URL, { max: 5, idle_timeout: 20 });
    const db = drizzle(sql, { schema: dbPkg.schema });
    app = Fastify({ logger: false });
    app.decorate('machineUrl', 'http://test');
    registerNeedsYouRoutes(app, db as never);
    await app.ready();
  });

  after(async () => {
    while (fixtures.length > 0) {
      const f = fixtures.pop();
      if (!f) break;
      try { await deleteFixture(f); } catch { /* ignore */ }
    }
    await app.close();
    await sql.end();
  });

  test('无凭据 → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/needs-you' });
    assert.equal(res.statusCode, 401, res.body);
  });

  test('跨团队用户 → 看不到别人的 todo，且 DB 没被改', async () => {
    const a = await seedFixture('cross-a');
    const b = await seedFixture('cross-b');

    // b 团队里有一条 confirm todo，owner 是 b 自己
    const confirmInB = await createTodoRow(b, 'confirm', { title: 'b-confirm' });

    // a 询问（不带 teamId → 收窄为 a 的团队；带 teamId=b → 403）
    const resNoTeam = await app.inject({
      method: 'GET', url: '/api/needs-you',
      headers: auth(a.key),
    });
    assert.equal(resNoTeam.statusCode, 200, resNoTeam.body);
    const noTeamBody = JSON.parse(resNoTeam.body) as { items: Array<{ todoId: string }>; count: number };
    const ids = noTeamBody.items.map((i) => i.todoId);
    assert.ok(!ids.includes(confirmInB), '不带 teamId 时不应看到 b 的 todo');

    const resOther = await app.inject({
      method: 'GET',
      url: `/api/needs-you?teamId=${encodeURIComponent(b.teamId)}`,
      headers: auth(a.key),
    });
    assert.equal(resOther.statusCode, 403, `跨团队必须 403；body=${resOther.body}`);

    // DB 校验：b 的 confirm todo 仍在 confirm
    const rows = await sql<{ phase: string }[]>`
      select phase from "todo" where id = ${confirmInB}
    `;
    assert.equal(rows[0]?.phase, 'confirm', '被拒时 todo.phase 必须仍是 confirm');
  });

  test('闸门内的 todo 出现在 items 里，gate 字段正确', async () => {
    const f = await seedFixture('gate-shape');
    const tConfirm = await createTodoRow(f, 'confirm', { title: 'a-confirm' });
    const tReview = await createTodoRow(f, 'review', { title: 'b-review' });

    const res = await app.inject({
      method: 'GET', url: `/api/needs-you?teamId=${encodeURIComponent(f.teamId)}`,
      headers: auth(f.key),
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as {
      items: Array<{ todoId: string; gate: string; kind: string; phase: string; reason: string }>;
      count: number;
    };
    const confirm = body.items.find((i) => i.todoId === tConfirm);
    const review = body.items.find((i) => i.todoId === tReview);
    assert.ok(confirm, 'confirm todo 应出现');
    assert.equal(confirm!.gate, 'confirm');
    assert.equal(confirm!.kind, 'confirm');
    assert.equal(confirm!.phase, 'confirm');
    assert.match(confirm!.reason, /计划确认/);

    assert.ok(review, 'review todo 应出现');
    assert.equal(review!.gate, 'review');
    assert.equal(review!.kind, 'review');
    assert.equal(review!.phase, 'review');
    assert.match(review!.reason, /变更确认/);
  });

  test('failed run 出现在 items 里，kind=failed, gate=null', async () => {
    const f = await seedFixture('failed-shape');
    const tFailed = await createTodoRow(f, 'failed', { title: 'c-failed' });

    const res = await app.inject({
      method: 'GET', url: `/api/needs-you?teamId=${encodeURIComponent(f.teamId)}`,
      headers: auth(f.key),
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as {
      items: Array<{ todoId: string; gate: string | null; kind: string; reason: string }>;
      count: number;
    };
    const failed = body.items.find((i) => i.todoId === tFailed);
    assert.ok(failed, 'failed todo 应出现');
    assert.equal(failed!.gate, null);
    assert.equal(failed!.kind, 'failed');
    assert.match(failed!.reason, /失败/);
  });

  test('非闸门、非 failed、非 awaiting-reply 的 todo 不出现', async () => {
    const f = await seedFixture('running');
    const tTodo = await createTodoRow(f, 'todo', { title: 'd-todo' });
    const tImpl = await createTodoRow(f, 'implement', { title: 'e-impl' });
    const tDone = await createTodoRow(f, 'done', { title: 'f-done' });
    const tClosed = await createTodoRow(f, 'closed', { title: 'g-closed' });

    const res = await app.inject({
      method: 'GET', url: `/api/needs-you?teamId=${encodeURIComponent(f.teamId)}`,
      headers: auth(f.key),
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as { items: Array<{ todoId: string }>; count: number };
    const ids = body.items.map((i) => i.todoId);
    for (const id of [tTodo, tImpl, tDone, tClosed]) {
      assert.ok(!ids.includes(id), `phase 不在 Needs you 集合里的 todo(${id}) 不应出现`);
    }
  });

  test('count 与 items 长度一致（侧栏角标与列表不能错位）', async () => {
    const f = await seedFixture('count-parity');
    await createTodoRow(f, 'confirm', { title: 'p1' });
    await createTodoRow(f, 'review', { title: 'p2' });
    await createTodoRow(f, 'failed', { title: 'p3' });

    const res = await app.inject({
      method: 'GET', url: `/api/needs-you?teamId=${encodeURIComponent(f.teamId)}`,
      headers: auth(f.key),
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as { items: unknown[]; count: number };
    assert.equal(body.count, body.items.length, 'count 必须 === items.length');
    assert.ok(body.count >= 3, '至少包含上面三条');
  });

  test('不写 phase —— 调 GET 不改 todo.phase', async () => {
    const f = await seedFixture('readonly');
    const t = await createTodoRow(f, 'confirm', { title: 'read-only-check' });

    const before = await sql<{ phase: string; updated_at: number }[]>`
      select phase, updated_at from "todo" where id = ${t}
    `;

    const res = await app.inject({
      method: 'GET', url: `/api/needs-you?teamId=${encodeURIComponent(f.teamId)}`,
      headers: auth(f.key),
    });
    assert.equal(res.statusCode, 200, res.body);

    const after = await sql<{ phase: string; updated_at: number }[]>`
      select phase, updated_at from "todo" where id = ${t}
    `;
    assert.equal(after[0]?.phase, before[0]?.phase, 'GET 后 phase 不能变');
    assert.equal(after[0]?.updated_at, before[0]?.updated_at, 'GET 后 updated_at 不能变');
  });

  test('question 文档路径：当前 schema 支持枚举（kind=question），但服务层不写——结果集为空', async () => {
    // 这一条是**故意**为「第 4 类 awaiting-reply」钉形状：
    //   - SQL 应当不会因为 schema 缺失而炸
    //   - 结果集为空（因为服务层不生成 question 文档）
    //   - 不为这条造一份假 question 文档来让列表不空
    const f = await seedFixture('q-empty');
    // 放一个 implement 中的 todo，没有 question 文档 → 不进 awaiting-reply
    await createTodoRow(f, 'implement', { title: 'h-impl-no-q' });

    const res = await app.inject({
      method: 'GET', url: `/api/needs-you?teamId=${encodeURIComponent(f.teamId)}`,
      headers: auth(f.key),
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as {
      items: Array<{ kind: string }>;
      count: number;
    };
    // 应当 0 条 awaiting-reply（这次跑没有 question 文档）
    const awaiting = body.items.filter((i) => i.kind === 'awaiting-reply');
    assert.equal(awaiting.length, 0, '当前数据下不应有 awaiting-reply 项');
  });

  test('question 文档路径：手动种一份 question 文档后，那条 implement todo 进 awaiting-reply', async () => {
    const f = await seedFixture('q-seeded');
    const tImpl = await createTodoRow(f, 'implement', { title: 'i-impl-with-q' });
    const buildId = await createBuildRow(f, tImpl);
    await createQuestionDoc(buildId);

    const res = await app.inject({
      method: 'GET', url: `/api/needs-you?teamId=${encodeURIComponent(f.teamId)}`,
      headers: auth(f.key),
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as {
      items: Array<{ todoId: string; kind: string; gate: string | null; reason: string }>;
      count: number;
    };
    const awaiting = body.items.find((i) => i.todoId === tImpl);
    assert.ok(awaiting, 'implement + question 文档的 todo 应出现在 awaiting-reply 组');
    assert.equal(awaiting!.kind, 'awaiting-reply');
    assert.equal(awaiting!.gate, null);
    assert.match(awaiting!.reason, /等待回复/);
  });
});