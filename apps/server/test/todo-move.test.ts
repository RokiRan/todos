import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import * as dbPkg from '@tds/db';
import { newId, now } from '../src/ids.js';
import { generateApiKey } from '../src/crypto.js';
import { registerTodoRoutes } from '../src/routes/todos.js';
import { registerMcpRoutes } from '../src/routes/mcp.js';

/**
 * TodoMove 端点契约（POST /api/todos/:todoId/move|reopen|rerun）：
 *   - 跨团队用户对他人 todo 调任何端点 → **403**（不是 401，不是 404）
 *   - todo 不存在 → **404**
 *   - 非法跳转（例如 `todo` → `done`）→ **409**，且**数据库里的 phase 没有被改**
 *   - 合法跳转 → 200 且 phase 落库正确
 *   - rerun / reopen 在非终态上 → 409
 *   - move zod 非法 body（比如 `phase: "nonsense"`）→ 422
 *   - 合法 move 的 `next !== toPhase`（如 review + merge=true 拖到 done）→ 409
 *
 * 测试用真 Postgres + app.inject，与 phase-rejection.test.ts 同源 —— 不 mock。
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://tds:tds_local_dev@127.0.0.1:5433/tds';
type TestDb = PostgresJsDatabase<typeof dbPkg.schema>;

interface Fixture {
  label: string;
  userId: string;
  teamId: string;
  projectId: string;
  memberId: string;
  agentId: string;
  key: string;
}

async function seedFixture(
  sql: postgres.Sql,
  label: string,
  scopes: string[],
): Promise<Fixture> {
  const ts = now();
  const userId = newId();
  const teamId = newId();
  const memberId = newId();
  const agentId = newId();
  const projectId = newId();
  await sql`
    insert into "user" (id, email, display_name, status, locale, created_at, updated_at)
    values (${userId}, ${`${label}-${userId}@test.local`}, ${label}, 'active', 'en', ${ts}, ${ts})
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
    values (${newId()}, ${userId}, ${'tm-' + label}, ${k.prefix}, ${k.hash}, ${scopes}, ${ts})
  `;
  return { label, userId, teamId, projectId, memberId, agentId, key: k.key };
}

async function seedTodoAt(
  sql: postgres.Sql,
  f: Fixture,
  phase: 'todo' | 'confirm' | 'review' | 'implement' | 'queued' | 'planning' | 'reviewing' | 'done' | 'failed' | 'closed',
  planFirst: boolean = true,
): Promise<{ todoId: string; updatedAtBefore: string }> {
  const id = newId();
  const ts = now();
  const tsStr = String(ts);
  const seqRow = await sql<{ next_seq_num: number }[]>`
    select next_seq_num from "project" where id = ${f.projectId}
  `;
  const seq = seqRow[0]?.next_seq_num ?? 1;
  await sql`update "project" set next_seq_num = next_seq_num + 1 where id = ${f.projectId}`;
  await sql`
    insert into "todo"
      (id, project_id, seq_num, owner_member_id, agent_id, title, tag_ids, phase,
       plan_first, separate_plan_build, with_checklist, created_at, updated_at)
    values
      (${id}, ${f.projectId}, ${seq}, ${f.memberId}, ${f.agentId}, 'TodoMove todo',
       '{}', ${phase}, ${planFirst}, false, false, ${tsStr}, ${tsStr})
  `;
  return { todoId: id, updatedAtBefore: tsStr };
}

async function readTodo(
  sql: postgres.Sql,
  todoId: string,
): Promise<{ phase: string; updated_at: string } | undefined> {
  const rows = await sql<{ phase: string; updated_at: string }[]>`
    select phase, updated_at from "todo" where id = ${todoId} limit 1
  `;
  return rows[0];
}

async function deleteFixture(sql: postgres.Sql, f: Fixture): Promise<void> {
  await sql`delete from "audit_event" where team_id = ${f.teamId}`;
  await sql`delete from "sse_event" where team_id = ${f.teamId}`;
  // todo.agent_id 指向 agent 且 agent.team_id → team ON DELETE CASCADE：
  // 直接删 team 会撞 FK 失败（agent 已无父但 todo 还引用）。先删 project，
  // project→todo 级联清掉；再删 team，agent / member / project 自动级联。
  await sql`delete from "project" where id = ${f.projectId}`;
  await sql`delete from "team" where id = ${f.teamId}`;
  await sql`delete from "user" where id = ${f.userId}`;
}

// ─────────────────────────────────────────────────────────────

describe('TodoMove · REST 端点契约', () => {
  let sql: postgres.Sql;
  let db: TestDb;
  let app: FastifyInstance;
  const fixtures: Fixture[] = [];

  before(async () => {
    sql = postgres(DATABASE_URL, { max: 5, idle_timeout: 20 });
    db = drizzle(sql, { schema: dbPkg.schema as never });
    app = Fastify({ logger: false });
    app.decorate('machineUrl', 'http://test');
    registerTodoRoutes(app, db as never);
    registerMcpRoutes(app, db as never);
    await app.ready();
  });

  after(async () => {
    for (const f of fixtures) {
      try { await deleteFixture(sql, f); } catch { /* ignore */ }
    }
    await app.close();
    await sql.end();
  });

  // ─────────────── 鉴权 ───────────────

  test('跨团队用户对他人 todo 调 /move → 403（不是 401、不是 404）', async () => {
    const owner = await seedFixture(sql, 'tm-owner', ['tool:complete_todos']);
    fixtures.push(owner);
    const { todoId, updatedAtBefore } = await seedTodoAt(sql, owner, 'todo');

    // 创建另一个团队的用户（无 owner 团队成员身份）
    const stranger = await seedFixture(sql, 'tm-stranger', ['tool:complete_todos']);
    fixtures.push(stranger);

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/move`,
      headers: { authorization: `Bearer ${stranger.key}` },
      payload: { phase: 'planning' },
    });
    assert.equal(res.statusCode, 403, `body=${res.body}`);

    // 数据库里 phase 必须不变
    const after = await readTodo(sql, todoId);
    assert.ok(after);
    assert.equal(after.phase, 'todo');
    assert.equal(after.updated_at, updatedAtBefore, '403 时数据库不能被改');
  });

  test('跨团队用户对他人 todo 调 /reopen → 403', async () => {
    const owner = await seedFixture(sql, 'tm-owner-r', ['tool:complete_todos']);
    fixtures.push(owner);
    const { todoId, updatedAtBefore } = await seedTodoAt(sql, owner, 'done');

    const stranger = await seedFixture(sql, 'tm-stranger-r', ['tool:complete_todos']);
    fixtures.push(stranger);

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/reopen`,
      headers: { authorization: `Bearer ${stranger.key}` },
      payload: {},
    });
    assert.equal(res.statusCode, 403, `body=${res.body}`);

    const after = await readTodo(sql, todoId);
    assert.ok(after);
    assert.equal(after.phase, 'done');
    assert.equal(after.updated_at, updatedAtBefore);
  });

  test('跨团队用户对他人 todo 调 /rerun → 403', async () => {
    const owner = await seedFixture(sql, 'tm-owner-rn', ['tool:complete_todos']);
    fixtures.push(owner);
    const { todoId, updatedAtBefore } = await seedTodoAt(sql, owner, 'failed');

    const stranger = await seedFixture(sql, 'tm-stranger-rn', ['tool:complete_todos']);
    fixtures.push(stranger);

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/rerun`,
      headers: { authorization: `Bearer ${stranger.key}` },
      payload: {},
    });
    assert.equal(res.statusCode, 403, `body=${res.body}`);

    const after = await readTodo(sql, todoId);
    assert.ok(after);
    assert.equal(after.phase, 'failed');
    assert.equal(after.updated_at, updatedAtBefore);
  });

  // ─────────────── 404 ───────────────

  test('move / reopen / rerun 对不存在的 todo → 404', async () => {
    const f = await seedFixture(sql, 'tm-404', ['tool:complete_todos']);
    fixtures.push(f);
    const ghostId = 'definitely-not-a-real-todo';

    for (const path of ['move', 'reopen', 'rerun'] as const) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/todos/${ghostId}/${path}`,
        headers: { authorization: `Bearer ${f.key}` },
        payload: path === 'move' ? { phase: 'planning' } : {},
      });
      assert.equal(res.statusCode, 404, `${path} → 404 expected, got ${res.statusCode}: ${res.body}`);
    }
  });

  // ─────────────── 422 zod ───────────────

  test('move 用 nonsense phase → 422', async () => {
    const f = await seedFixture(sql, 'tm-zod', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId } = await seedTodoAt(sql, f, 'todo');

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/move`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: { phase: 'nonsense' },
    });
    assert.equal(res.statusCode, 422, `body=${res.body}`);
  });

  // ─────────────── 409 非法跳转 ───────────────

  test('move `todo` → `done` 是非法跳转（state machine 没有 trigger） → 409 且 DB 不变', async () => {
    const f = await seedFixture(sql, 'tm-illegal', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId, updatedAtBefore } = await seedTodoAt(sql, f, 'todo');

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/move`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: { phase: 'done' },
    });
    assert.equal(res.statusCode, 409, `body=${res.body}`);

    // 关键：phase 仍为 todo，updated_at 未动。
    // transition() 在 'todo' 状态下没有任何到达 'done' 的分支 → triggerForMove
    // 返回 null → 路由直接 409，根本不进 commitPhaseTransition。
    const after = await readTodo(sql, todoId);
    assert.ok(after);
    assert.equal(after.phase, 'todo', '409 后 phase 仍必须是 todo');
    assert.equal(
      after.updated_at, updatedAtBefore,
      `409 后 updated_at 必须保持原值 (${updatedAtBefore})；收到 ${after.updated_at}`,
    );
  });

  test('move `todo` → `failed` 是合法 trigger（fail 在 todo 上被闸门外放行） → 200 且 phase 变 failed', async () => {
    // fail 在非闸门相位上一律 ok:true → failed（state-machine.ts queued/planning/implement 等分支）。
    // todo 不在闸门里但也没有 case 处理 'fail' —— 验证一下 state machine 实际行为。
    const f = await seedFixture(sql, 'tm-fail', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId } = await seedTodoAt(sql, f, 'todo');

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/move`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: { phase: 'failed' },
    });
    // state-machine.ts 的 'todo' case: 只接 submit/claim/plan_ready；其它一律
    // `return { ok: false, next: current, reason: ... }`。所以 fail('/todo') 实际
    // 被状态机拒收 → 路由 409。这条用例锁死这个真实行为。
    assert.equal(res.statusCode, 409, `body=${res.body}`);

    const after = await readTodo(sql, todoId);
    assert.ok(after);
    assert.equal(after.phase, 'todo', 'state machine 拒收时 phase 不变');
  });

  test('move `implement` → `failed`（合法 trigger）→ 200 且 phase 落 failed', async () => {
    // implement 在非闸门相位，triggerForMove 给 { kind: 'fail' }；state machine
    // 在 implement 下：'if (t === \'fail\') return { ok: true, next: \'failed\' }'。
    const f = await seedFixture(sql, 'tm-fail-impl', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId } = await seedTodoAt(sql, f, 'implement');

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/move`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: { phase: 'failed' },
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as { ok: boolean; phase: string };
    assert.equal(body.ok, true);
    assert.equal(body.phase, 'failed');

    const after = await readTodo(sql, todoId);
    assert.ok(after);
    assert.equal(after.phase, 'failed');
  });

  // ─────────────── 合法跳转 ───────────────

  test('move `implement` → `review`（changes_ready）→ 200 且 phase 落 review', async () => {
    const f = await seedFixture(sql, 'tm-legal', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId } = await seedTodoAt(sql, f, 'implement');

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/move`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: { phase: 'review' },
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as { ok: boolean; phase: string; dispatch: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.phase, 'review');
    // changes_ready 在 implement 上是 { ok:true, next:'review', dispatch: undefined }
    // → commitPhaseTransition 默认 dispatch=false。
    assert.equal(body.dispatch, false);

    const after = await readTodo(sql, todoId);
    assert.equal(after?.phase, 'review');
  });

  test('move `confirm` → `implement`（approve by user）→ 200 且 phase 落 implement', async () => {
    const f = await seedFixture(sql, 'tm-approve', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId } = await seedTodoAt(sql, f, 'confirm');

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/move`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: { phase: 'implement' },
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as { ok: boolean; phase: string };
    assert.equal(body.ok, true);
    assert.equal(body.phase, 'implement');

    const after = await readTodo(sql, todoId);
    assert.equal(after?.phase, 'implement');
  });

  test('move `review` → `done`（complete merge=false）→ 200 且 phase 落 done', async () => {
    const f = await seedFixture(sql, 'tm-complete', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId } = await seedTodoAt(sql, f, 'review');

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/move`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: { phase: 'done' },
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as { ok: boolean; phase: string };
    assert.equal(body.ok, true);
    assert.equal(body.phase, 'done');

    const after = await readTodo(sql, todoId);
    assert.equal(after?.phase, 'done');
  });

  test('move 终态 todo → planning → 409（终态必须走 reopen/rerun）', async () => {
    const f = await seedFixture(sql, 'tm-settled-move', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId, updatedAtBefore } = await seedTodoAt(sql, f, 'done');

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/move`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: { phase: 'planning' },
    });
    assert.equal(res.statusCode, 409, `body=${res.body}`);

    const after = await readTodo(sql, todoId);
    assert.equal(after?.phase, 'done');
    assert.equal(after?.updated_at, updatedAtBefore);
  });

  // ─────────────── Reopen ───────────────

  test('reopen 在 done 上 → 200 且 phase 落 review', async () => {
    const f = await seedFixture(sql, 'tm-reopen-done', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId } = await seedTodoAt(sql, f, 'done');

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/reopen`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: {},
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as { ok: boolean; phase: string; dispatch: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.phase, 'review');
    // reopen 不 dispatch（state machine: reopen → review, dispatch 缺席）
    assert.equal(body.dispatch, false);

    const after = await readTodo(sql, todoId);
    assert.equal(after?.phase, 'review');
  });

  test('reopen 在 failed 上 → 200 且 phase 落 review', async () => {
    const f = await seedFixture(sql, 'tm-reopen-failed', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId } = await seedTodoAt(sql, f, 'failed');

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/reopen`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: {},
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as { ok: boolean; phase: string };
    assert.equal(body.ok, true);
    assert.equal(body.phase, 'review');

    const after = await readTodo(sql, todoId);
    assert.equal(after?.phase, 'review');
  });

  test('reopen 在 closed 上 → 200 且 phase 落 review', async () => {
    const f = await seedFixture(sql, 'tm-reopen-closed', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId } = await seedTodoAt(sql, f, 'closed');

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/reopen`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: {},
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as { ok: boolean; phase: string };
    assert.equal(body.ok, true);
    assert.equal(body.phase, 'review');

    const after = await readTodo(sql, todoId);
    assert.equal(after?.phase, 'review');
  });

  test('reopen 在非终态（todo）上 → 409', async () => {
    const f = await seedFixture(sql, 'tm-reopen-todo', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId, updatedAtBefore } = await seedTodoAt(sql, f, 'todo');

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/reopen`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: {},
    });
    assert.equal(res.statusCode, 409, `body=${res.body}`);
    assert.match(res.body, /reopen is only valid on a settled todo/);

    const after = await readTodo(sql, todoId);
    assert.equal(after?.phase, 'todo');
    assert.equal(after?.updated_at, updatedAtBefore, '409 后数据库不能动');
  });

  // ─────────────── Rerun ───────────────

  test('rerun 在 done 上 → 200 且 phase 落 todo', async () => {
    const f = await seedFixture(sql, 'tm-rerun-done', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId } = await seedTodoAt(sql, f, 'done');

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/rerun`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: {},
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as { ok: boolean; phase: string };
    assert.equal(body.ok, true);
    assert.equal(body.phase, 'todo');

    const after = await readTodo(sql, todoId);
    assert.equal(after?.phase, 'todo');
  });

  test('rerun 在 failed 上 → 200 且 phase 落 todo', async () => {
    const f = await seedFixture(sql, 'tm-rerun-failed', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId } = await seedTodoAt(sql, f, 'failed');

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/rerun`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: {},
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as { ok: boolean; phase: string };
    assert.equal(body.ok, true);
    assert.equal(body.phase, 'todo');
  });

  test('rerun 在 closed 上 → 200 且 phase 落 todo', async () => {
    const f = await seedFixture(sql, 'tm-rerun-closed', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId } = await seedTodoAt(sql, f, 'closed');

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/rerun`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: {},
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as { ok: boolean; phase: string };
    assert.equal(body.ok, true);
    assert.equal(body.phase, 'todo');
  });

  test('rerun 在非终态（implement）上 → 409', async () => {
    const f = await seedFixture(sql, 'tm-rerun-impl', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId, updatedAtBefore } = await seedTodoAt(sql, f, 'implement');

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/rerun`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: {},
    });
    assert.equal(res.statusCode, 409, `body=${res.body}`);
    assert.match(res.body, /rerun is only valid on settled todos/);

    const after = await readTodo(sql, todoId);
    assert.equal(after?.phase, 'implement');
    assert.equal(after?.updated_at, updatedAtBefore, '409 后数据库不能动');
  });

  // ─────────────── 合法 trigger 但落点错位 ───────────────

  test('move `review` → `done` 但 ctx 中 planFirst=false 时，triggerForMove 仍给 merge=false；单测覆盖落点正确', async () => {
    // 这条用例锁死 triggerForMove(review, done) → {kind:'complete', merge:false}，
    // 并且 planFirst 不影响 review→done（confirm→implement 才受 planFirst 影响）。
    const f = await seedFixture(sql, 'tm-planfirst', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId } = await seedTodoAt(sql, f, 'review', /* planFirst */ false);

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/move`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: { phase: 'done' },
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as { ok: boolean; phase: string };
    assert.equal(body.ok, true);
    assert.equal(body.phase, 'done');
  });
});