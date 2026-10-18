import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import * as dbPkg from '@tds/db';
import { newId, now } from '../src/ids.js';
import { generateApiKey } from '../src/crypto.js';
import { SPEC_MAX_CHARS } from '../src/services/todos.js';
import { registerTodoRoutes } from '../src/routes/todos.js';

/**
 * 5 个 todo 端点 + 1 个 GET 列表字段 + 1 个新 DB 列的端到端契约测试。
 *
 * 目标切片（DataLayer 2026-10-18）：
 *   - POST /api/todos/:todoId/reset
 *   - POST /api/todos/:todoId/cancel
 *   - PATCH /api/todos/:todoId        （title / spec）
 *   - DELETE /api/todos/:todoId
 *   - POST /api/todos/:todoId/sync-to-machine
 *   - GET /api/todos 列表新增 ownerMemberId + createdByType 字段
 *   - 新 DB 列 todo.created_by_type （CHECK: user|chief|agent）+ REST 写路径
 *     必写 'user'
 *
 * 防假绿核心：`sync-to-machine` 在 daemon 拉取协议未实现的情况下**永远**
 * 返回 ok:false；测试断言用 `notStrictEqual(body.ok, true)` 而不是
 * `strictEqual(body.ok, false)`，将来真接通时这条会红，提醒人来更新。
 *
 * 用 Fastify app.inject + 真实本地 Postgres（127.0.0.1:5433 上的 tds 库）。
 * 复用 `todos-api.test.ts` 的 fixture 风格：每条 test 独立 fixture，
 * after 兜底清理。**不**复用该文件的 fixture 函数本身 —— 切片的 fixtures
 * 必须独立：seedFixture 写文件是侵入式，遵循「既有文件零改动」约束。
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://tds:tds_local_dev@127.0.0.1:5433/tds';
type TestDb = PostgresJsDatabase<typeof dbPkg.schema>;
const dbSchema = dbPkg.schema;

// ─── 与 todos-api.test.ts 同套的 app 构建方式 ─────────────────────

function buildTestApp(
  db: TestDb,
): FastifyInstance {
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
  phase: 'todo' | 'confirm' | 'review' | 'implement' | 'done' | 'failed' | 'closed',
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

/** 插一条 document（plan / changes / input 任意 kind）。build 删不带走。 */
async function createDocumentRow(
  sql: postgres.Sql,
  buildId: string,
  kind: 'plan' | 'changes' | 'input' = 'plan',
): Promise<string> {
  const id = newId();
  const ts = now();
  await sql`
    insert into "document" (id, build_id, kind, version, payload, created_at, updated_at)
    values (${id}, ${buildId}, ${kind}, 1, ${'{"text":"seed"}'}::jsonb, ${ts}, ${ts})
  `;
  return id;
}

/** 插一台机器。状态字段（isOnline / workspacesDir）由调用方控制。 */
async function createMachineRow(
  sql: postgres.Sql,
  teamId: string,
  enrolledBy: string,
  opts: { isOnline: boolean; workspacesDir: string | null },
): Promise<string> {
  const id = newId();
  const ts = now();
  await sql`
    insert into "machine"
      (id, team_id, name, device_id, enrolled_by, build_enabled, shell_enabled,
       max_concurrent_tasks, runtimes, disabled_runtimes, workspaces_dir,
       is_online, last_heartbeat_at, created_at, updated_at)
    values
      (${id}, ${teamId}, ${'m-' + id}, ${'dev-' + id}, ${enrolledBy}, true, false, 6,
       ${['claude-code']}, ${[]}, ${opts.workspacesDir},
       ${opts.isOnline}, ${ts}, ${ts}, ${ts})
  `;
  return id;
}

async function deleteFixture(sql: postgres.Sql, f: Fixture): Promise<void> {
  // 反 FK 顺序：sse_event / audit_event 没强 FK（仅 team_id 强 FK），先清。
  // document / build / todo / project / member / agent / team / user。
  //
  // `machine_pending_action` 对 build/todo/machine 都是 ON DELETE CASCADE，
  // 理论上会跟着删；这里仍然显式清一次 —— 它的 `team_id` 只是一个**没有 FK
  // 的冗余列**（回执端点写 audit_event.team_id 用的），不能指望级联。
  await sql`delete from "machine_pending_action" where team_id = ${f.teamId}`;
  await sql`delete from "sse_event" where team_id = ${f.teamId}`;
  await sql`delete from "audit_event" where team_id = ${f.teamId}`;
  await sql`delete from "document" where build_id in (select id from "build" where todo_id in (select id from "todo" where project_id in (select id from "project" where team_id = ${f.teamId})))`;
  await sql`delete from "build" where todo_id in (select id from "todo" where project_id in (select id from "project" where team_id = ${f.teamId}))`;
  await sql`delete from "todo" where project_id in (select id from "project" where team_id = ${f.teamId})`;
  await sql`delete from "project" where team_id = ${f.teamId}`;
  await sql`delete from "member" where team_id = ${f.teamId}`;
  await sql`delete from "agent" where team_id = ${f.teamId}`;
  await sql`delete from "machine" where team_id = ${f.teamId}`;
  await sql`delete from "team" where id = ${f.teamId}`;
  await sql`delete from "user" where id = ${f.userId}`;
}

// ── 单测 ─────────────────────────────────────────────────────────────

describe('todo 端点切片 —— reset / cancel / patch / delete / sync-to-machine', () => {
  let sql: postgres.Sql;
  let db: TestDb;
  let app: FastifyInstance;
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

  // ─────────────────────────── POST /api/todos/:todoId/reset ────

  test('reset：todo 相位 → 200，phase=todo', async () => {
    const f = await seedFixture(sql, 'reset-ok');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'todo');
    await createBuildRow(sql, f, todoId);

    const res = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/todos/${todoId}/reset`,
      payload: {},
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as { ok: boolean; phase: string };
    assert.equal(body.ok, true);
    assert.equal(body.phase, 'todo');
  });

  test('reset：清空 document —— 计划/改动文档必须归零（不靠 build FK cascade）', async () => {
    // 关键：document FK 是 build_id → build.id CASCADE，不指向 todo。
    // 即使将来 todo 走 cascade 删 build，document 跟 build 是 1:N 而 build
    // 没真删（reset 只标 finishedAt），document 必须在路由层显式删。
    // 不显式做 → 用户重置完还能在「Old Plans / Changes」看到上一轮的方案，
    // 违反原站「清空对话、方案和改动记录」语义。
    const f = await seedFixture(sql, 'reset-docs');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'confirm');
    const { id: buildId } = await createBuildRow(sql, f, todoId);
    await createDocumentRow(sql, buildId, 'plan');
    await createDocumentRow(sql, buildId, 'changes');
    await createDocumentRow(sql, buildId, 'input');

    // sanity：先确认 document 真有 3 行
    const before = await sql<{ c: number }[]>`
      select count(*)::int as c from "document" where build_id = ${buildId}
    `;
    assert.equal(before[0]?.c, 3, '前置：3 行 document');

    const res = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/todos/${todoId}/reset`,
      payload: {},
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);

    // 关键断言：document 数为 0
    const after = await sql<{ c: number }[]>`
      select count(*)::int as c from "document" where build_id = ${buildId}
    `;
    assert.equal(after[0]?.c, 0, 'reset 后 document 必须为 0 行（CASCADE 不会带它走）');
  });

  test('reset：把没 finishedAt 的 build 置终态', async () => {
    // 实现里：build 行不会被真删（reset 是重置不是删除），但所有
    // `finished_at IS NULL` 的 build 会被写上 finishedAt —— 让
    // daemon 端「该 build 还在跑」的查询（finishedAt IS NULL）立刻收敛。
    const f = await seedFixture(sql, 'reset-finished');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'implement');
    const { id: buildId } = await createBuildRow(sql, f, todoId);

    // sanity：刚建的 build 是 unfinished
    const before = await sql<{ finished_at: number | null }[]>`
      select finished_at from "build" where id = ${buildId}
    `;
    assert.equal(before[0]?.finished_at, null, '前置：build 未终态');

    const res = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/todos/${todoId}/reset`,
      payload: {},
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);

    const after = await sql<{ finished_at: number | null }[]>`
      select finished_at from "build" where id = ${buildId}
    `;
    assert.notEqual(after[0]?.finished_at, null, 'reset 后 build.finishedAt 必须非 null');
  });

  test('reset：终态（done）拒绝 → 409', async () => {
    const f = await seedFixture(sql, 'reset-settled-done');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'done');

    const res = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/todos/${todoId}/reset`,
      payload: {},
    });
    assert.equal(res.statusCode, 409, `body=${res.body}`);
    assert.match(res.body, /reset is not valid on a settled todo.*done/);
  });

  test('reset：终态（failed）拒绝 → 409', async () => {
    const f = await seedFixture(sql, 'reset-settled-failed');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'failed');

    const res = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/todos/${todoId}/reset`,
      payload: {},
    });
    assert.equal(res.statusCode, 409, `body=${res.body}`);
    assert.match(res.body, /reset is not valid on a settled todo.*failed/);
  });

  test('reset：终态（closed）拒绝 → 409', async () => {
    const f = await seedFixture(sql, 'reset-settled-closed');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'closed');

    const res = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/todos/${todoId}/reset`,
      payload: {},
    });
    assert.equal(res.statusCode, 409, `body=${res.body}`);
    assert.match(res.body, /reset is not valid on a settled todo.*closed/);
  });

  test('reset：跨团队 → 403，且 document / build / todo 都没被改', async () => {
    // 最容易被忽略的越权写：路由层先做 loadTodoTeamId + requireTeamMembership，
    // 拒绝路径**不**进事务。document / build / todo 都必须保持原状。
    const a = await seedFixture(sql, 'reset-cross-A');
    const b = await seedFixture(sql, 'reset-cross-B');
    fixtures.push(a, b);
    const { id: todoId } = await createTodoRow(sql, b, 'confirm');
    const { id: buildId } = await createBuildRow(sql, b, todoId);
    await createDocumentRow(sql, buildId, 'plan');
    await createDocumentRow(sql, buildId, 'changes');

    const beforeDoc = await sql<{ c: number }[]>`
      select count(*)::int as c from "document" where build_id = ${buildId}
    `;
    const beforeBuild = await sql<{ finished_at: number | null }[]>`
      select finished_at from "build" where id = ${buildId}
    `;
    const beforeTodo = await sql<{ phase: string }[]>`
      select phase from "todo" where id = ${todoId}
    `;
    const beforeAudit = await sql<{ c: number }[]>`
      select count(*)::int as c from "audit_event" where team_id = ${b.teamId}
    `;
    const beforeSse = await sql<{ c: number }[]>`
      select count(*)::int as c from "sse_event" where team_id = ${b.teamId}
    `;

    const res = await app.inject({
      headers: { authorization: `Bearer ${a.key}` },
      method: 'POST',
      url: `/api/todos/${todoId}/reset`,
      payload: {},
    });
    assert.equal(res.statusCode, 403, `body=${res.body}`);

    // 403 路径**不**进事务：document 行数、build 终态、todo phase、audit、sse
    // 全部保持原状。
    const afterDoc = await sql<{ c: number }[]>`
      select count(*)::int as c from "document" where build_id = ${buildId}
    `;
    const afterBuild = await sql<{ finished_at: number | null }[]>`
      select finished_at from "build" where id = ${buildId}
    `;
    const afterTodo = await sql<{ phase: string }[]>`
      select phase from "todo" where id = ${todoId}
    `;
    const afterAudit = await sql<{ c: number }[]>`
      select count(*)::int as c from "audit_event" where team_id = ${b.teamId}
    `;
    const afterSse = await sql<{ c: number }[]>`
      select count(*)::int as c from "sse_event" where team_id = ${b.teamId}
    `;
    assert.equal(afterDoc[0]?.c, beforeDoc[0]?.c, '403：document 行数不变');
    assert.equal(afterBuild[0]?.finished_at, beforeBuild[0]?.finished_at, '403：build 终态不变');
    assert.equal(afterTodo[0]?.phase, beforeTodo[0]?.phase, '403：todo phase 不变');
    assert.equal(afterAudit[0]?.c, beforeAudit[0]?.c, '403：audit_event 零写入');
    assert.equal(afterSse[0]?.c, beforeSse[0]?.c, '403：sse_event 零写入');
  });

  test('reset：phase 变更后 audit_event 有 todo_reset 一行', async () => {
    const f = await seedFixture(sql, 'reset-audit');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'confirm');
    await createBuildRow(sql, f, todoId);

    const res = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/todos/${todoId}/reset`,
      payload: {},
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);

    // 双轨审计 —— reset 是人类主动行为，actorType = 'user'，type = 'todo_reset'
    const auditRows = await sql<{ actor_type: string; actor_id: string; type: string }[]>`
      select actor_type, actor_id, type from "audit_event"
       where team_id = ${f.teamId} and todo_id = ${todoId} and type = 'todo_reset'
    `;
    assert.equal(auditRows.length, 1, 'audit_event 应恰有一条 todo_reset');
    assert.equal(auditRows[0]?.actor_type, 'user');
    assert.equal(auditRows[0]?.actor_id, f.userId);
  });

  test('reset：sse_event 有 phase_changed 帧（todo 作用域 + team 作用域）', async () => {
    const f = await seedFixture(sql, 'reset-sse');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'confirm');
    await createBuildRow(sql, f, todoId);

    const res = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/todos/${todoId}/reset`,
      payload: {},
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);

    // 与 commitPhaseTransition 同款：todo 作用域 + team 作用域两条 phase_changed
    const sseScopes = (
      await sql<{ scope: string }[]>`
        select scope from "sse_event"
         where team_id = ${f.teamId}
           and type = 'phase_changed'
           and payload->>'todoId' = ${todoId}
      `
    ).map((r) => r.scope);
    assert.ok(sseScopes.includes(`todo:${todoId}`), 'todo 作用域 SSE 必须存在');
    assert.ok(sseScopes.includes(`team:${f.teamId}`), 'team 作用域 SSE 必须存在');
  });

  // ─────────────────────────── POST /api/todos/:todoId/cancel ────

  test('cancel：运行中相位（planning）→ 200，phase=closed', async () => {
    // 相位选 `planning` 而不是 `todo`：`state-machine.ts` 的 `case 'todo'`
    // 分支**没有** `if (t === 'cancel')` 一行，所以 `todo` 相位调 cancel 会拿到
    // 409（`todo rejects cancel`）。状态机接受 cancel 的是 queued / planning /
    // implement / reviewing 四个运行中相位，加上 gate 分支统一放行的
    // confirm / review。用 `todo` 会把「端点坏了」误判成「测试写错了」。
    const f = await seedFixture(sql, 'cancel-ok');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'planning');
    await createBuildRow(sql, f, todoId); // 必须有 build

    const res = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/todos/${todoId}/cancel`,
      payload: {},
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as { ok: boolean; phase: string };
    assert.equal(body.ok, true);
    assert.equal(body.phase, 'closed');

    const rows = await sql<{ phase: string }[]>`select phase from "todo" where id = ${todoId}`;
    assert.equal(rows[0]?.phase, 'closed');
  });

  test('cancel：todo 相位 → 409（状态机不接受；那条路是 /reset）', async () => {
    // 锁住「todo 相位拒绝 cancel」这条契约。UI 侧（CardMenu 的 showClose）
    // 依赖同一个事实来决定要不要显示「关闭」菜单项 —— 两边必须一致，
    // 否则用户点了就是注定 409 的死按钮。
    const f = await seedFixture(sql, 'cancel-todo-phase');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'todo');
    await createBuildRow(sql, f, todoId);

    const res = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/todos/${todoId}/cancel`,
      payload: {},
    });
    assert.equal(res.statusCode, 409, `body=${res.body}`);
    assert.match(res.body, /todo rejects cancel/);

    // 相位不变 —— 被拒绝的请求不许留下任何写入。
    const rows = await sql<{ phase: string }[]>`select phase from "todo" where id = ${todoId}`;
    assert.equal(rows[0]?.phase, 'todo', '被拒绝的 cancel 不得改动 phase');
  });

  test('cancel：无 build → 409', async () => {
    // 契约 §3.3：此 todo 还没起过 build 时没有「运行中流程」要中断，「关闭」
    // 没业务意义 —— 应走 delete 而不是 cancel。
    const f = await seedFixture(sql, 'cancel-no-build');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'todo'); // 没 createBuildRow

    const res = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/todos/${todoId}/cancel`,
      payload: {},
    });
    assert.equal(res.statusCode, 409, `body=${res.body}`);
    assert.match(res.body, /cancel requires at least one build.*use \/delete instead/);
  });

  test('cancel：终态（done） → 409', async () => {
    const f = await seedFixture(sql, 'cancel-settled');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'done');
    await createBuildRow(sql, f, todoId);

    const res = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/todos/${todoId}/cancel`,
      payload: {},
    });
    assert.equal(res.statusCode, 409, `body=${res.body}`);
    assert.match(res.body, /cancel is not valid on a settled todo.*done/);
  });

  test('cancel：跨团队 → 403', async () => {
    const a = await seedFixture(sql, 'cancel-cross-A');
    const b = await seedFixture(sql, 'cancel-cross-B');
    fixtures.push(a, b);
    const { id: todoId } = await createTodoRow(sql, b, 'todo');
    await createBuildRow(sql, b, todoId);

    const beforePhase = await sql<{ phase: string }[]>`
      select phase from "todo" where id = ${todoId}
    `;

    const res = await app.inject({
      headers: { authorization: `Bearer ${a.key}` },
      method: 'POST',
      url: `/api/todos/${todoId}/cancel`,
      payload: {},
    });
    assert.equal(res.statusCode, 403, `body=${res.body}`);

    const afterPhase = await sql<{ phase: string }[]>`
      select phase from "todo" where id = ${todoId}
    `;
    assert.equal(afterPhase[0]?.phase, beforePhase[0]?.phase, '403：todo phase 不变');
  });

  // ─────────────────────────── PATCH /api/todos/:todoId ────

  test('patch：title 单独 → 200，返回 todo.title 是新值，DB 也新', async () => {
    const f = await seedFixture(sql, 'patch-title');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'todo');

    const res = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'PATCH',
      url: `/api/todos/${todoId}`,
      payload: { title: '新标题' },
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as { todo: { title: string; id: string } };
    assert.equal(body.todo.title, '新标题');

    const rows = await sql<{ title: string }[]>`select title from "todo" where id = ${todoId}`;
    assert.equal(rows[0]?.title, '新标题', 'DB title 也被改');
  });

  test('patch：spec 单独 → 200，DB spec 也新', async () => {
    const f = await seedFixture(sql, 'patch-spec');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'todo');

    const res = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'PATCH',
      url: `/api/todos/${todoId}`,
      payload: { spec: '新 spec' },
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as { todo: { spec: string | null } };
    assert.equal(body.todo.spec, '新 spec');

    const rows = await sql<{ spec: string | null }[]>`select spec from "todo" where id = ${todoId}`;
    assert.equal(rows[0]?.spec, '新 spec');
  });

  test('patch：title + spec 同时 → 都改', async () => {
    const f = await seedFixture(sql, 'patch-both');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'todo');

    const res = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'PATCH',
      url: `/api/todos/${todoId}`,
      payload: { title: '双改标题', spec: '双改 spec' },
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as { todo: { title: string; spec: string | null } };
    assert.equal(body.todo.title, '双改标题');
    assert.equal(body.todo.spec, '双改 spec');

    const rows = await sql<{ title: string; spec: string | null }[]>`
      select title, spec from "todo" where id = ${todoId}
    `;
    assert.equal(rows[0]?.title, '双改标题');
    assert.equal(rows[0]?.spec, '双改 spec');
  });

  test('patch：空 body `{}` → 422（端点要求至少一个字段）', async () => {
    // 服务层 updateTodo 不接受空 patch —— 静默放过会让客户端以为「什么都没改
    // 也成功」。superRefine 在 schema 层就拒掉，路由层把 zod 错转成 422。
    const f = await seedFixture(sql, 'patch-empty');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'todo');

    const res = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'PATCH',
      url: `/api/todos/${todoId}`,
      payload: {},
    });
    assert.equal(res.statusCode, 422, `body=${res.body}`);
    assert.match(res.body, /patch todo requires at least one of title \/ spec/);
  });

  test('patch：未知字段 → 422（zod strict）', async () => {
    // phase 不是用户可改字段（状态机唯一决定）。superRefine + strict() 双重
    // 防御 —— 但其实 strict() 就够，phase 当成未知字段直接拒。
    const f = await seedFixture(sql, 'patch-unknown');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'todo');

    const res = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'PATCH',
      url: `/api/todos/${todoId}`,
      payload: { title: '新的', phase: 'implement' },
    });
    assert.equal(res.statusCode, 422, `body=${res.body}`);

    // 同时确认 phase 没被偷偷改
    const rows = await sql<{ phase: string }[]>`select phase from "todo" where id = ${todoId}`;
    assert.equal(rows[0]?.phase, 'todo', '未知字段拒绝时 phase 不变');
  });

  test('patch：跨团队 → 403，且 DB 里 title 原值不变（最易忽略的越权写）', async () => {
    // 关键：路由层 requireTeamMembership 必须在 service.updateTodo 之前。
    // 一旦顺序反了，攻击者可以借别人的 api_key 改别人 todo 的 title。
    const a = await seedFixture(sql, 'patch-cross-A');
    const b = await seedFixture(sql, 'patch-cross-B');
    fixtures.push(a, b);
    const { id: todoId } = await createTodoRow(sql, b, 'todo');

    const beforeTitle = await sql<{ title: string }[]>`
      select title from "todo" where id = ${todoId}
    `;
    assert.equal(beforeTitle[0]?.title, 'test');

    const res = await app.inject({
      headers: { authorization: `Bearer ${a.key}` },
      method: 'PATCH',
      url: `/api/todos/${todoId}`,
      payload: { title: '被越权改写' },
    });
    assert.equal(res.statusCode, 403, `body=${res.body}`);

    const afterTitle = await sql<{ title: string }[]>`
      select title from "todo" where id = ${todoId}
    `;
    assert.equal(afterTitle[0]?.title, 'test', '403：title 必须保持原值');
  });

  test('patch：超长 title（281 字符，超过 zod .max(280)） → 422', async () => {
    const f = await seedFixture(sql, 'patch-long-title');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'todo');

    const res = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'PATCH',
      url: `/api/todos/${todoId}`,
      payload: { title: 'x'.repeat(281) },
    });
    assert.equal(res.statusCode, 422, `body=${res.body}`);
  });

  test('patch：超长 spec（> SPEC_MAX_CHARS） → 422', async () => {
    // SPEC_MAX_CHARS = 800 与 spec 创建路径同源 —— 不能 REST 创建路径拒掉
    // 但 PATCH 路径放过，PATCH 就成了一条「任意长度 spec」的旁路。
    const f = await seedFixture(sql, 'patch-long-spec');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'todo');

    const res = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'PATCH',
      url: `/api/todos/${todoId}`,
      payload: { spec: 'x'.repeat(SPEC_MAX_CHARS + 1) },
    });
    assert.equal(res.statusCode, 422, `body=${res.body}`);
  });

  // ─────────────────────────── DELETE /api/todos/:todoId ────

  test('delete：200 {ok:true}，DB 里 todo 行消失', async () => {
    const f = await seedFixture(sql, 'delete-ok');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'todo');
    await createBuildRow(sql, f, todoId);

    // sanity
    const before = await sql<{ c: number }[]>`
      select count(*)::int as c from "todo" where id = ${todoId}
    `;
    assert.equal(before[0]?.c, 1);

    const res = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'DELETE',
      url: `/api/todos/${todoId}`,
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as { ok: boolean };
    assert.equal(body.ok, true);

    const after = await sql<{ c: number }[]>`
      select count(*)::int as c from "todo" where id = ${todoId}
    `;
    assert.equal(after[0]?.c, 0, 'todo 行必须消失（service.deleteTodo 已删）');
  });

  test('delete：跨团队 → 403，且 DB 里 todo 仍在', async () => {
    const a = await seedFixture(sql, 'delete-cross-A');
    const b = await seedFixture(sql, 'delete-cross-B');
    fixtures.push(a, b);
    const { id: todoId } = await createTodoRow(sql, b, 'todo');

    const res = await app.inject({
      headers: { authorization: `Bearer ${a.key}` },
      method: 'DELETE',
      url: `/api/todos/${todoId}`,
    });
    assert.equal(res.statusCode, 403, `body=${res.body}`);

    const rows = await sql<{ c: number }[]>`
      select count(*)::int as c from "todo" where id = ${todoId}
    `;
    assert.equal(rows[0]?.c, 1, '403：todo 必须仍在');
  });

  test('delete：重复删除第二次 → 404（幂等语义明确）', async () => {
    // 实现：service.deleteTodo 在 returning 为空时抛 404「todo not found」。
    // 路由层捕获后变成 404 —— 与「GET 不存在的 todo」一致。
    // 不能是 200（假装成功了）或 403（不是权限问题）。
    const f = await seedFixture(sql, 'delete-twice');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'todo');

    const r1 = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'DELETE',
      url: `/api/todos/${todoId}`,
    });
    assert.equal(r1.statusCode, 200, `body=${r1.body}`);

    const r2 = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'DELETE',
      url: `/api/todos/${todoId}`,
    });
    assert.equal(r2.statusCode, 404, `body=${r2.body}`);
  });

  // ─────────────────────────── POST /api/todos/:todoId/sync-to-machine ────

  test('sync-to-machine：无 build → 409', async () => {
    const f = await seedFixture(sql, 'sync-no-build');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'todo'); // 没 build
    const machineId = await createMachineRow(sql, f.teamId, f.userId, {
      isOnline: true,
      workspacesDir: '/ws',
    });

    const res = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/todos/${todoId}/sync-to-machine`,
      payload: { machineId },
    });
    assert.equal(res.statusCode, 409, `body=${res.body}`);
    assert.match(res.body, /no build to sync/);
  });

  test('sync-to-machine：machineId 不存在 → 404', async () => {
    const f = await seedFixture(sql, 'sync-no-machine');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'todo');
    await createBuildRow(sql, f, todoId);

    const res = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/todos/${todoId}/sync-to-machine`,
      payload: { machineId: newId() },
    });
    assert.equal(res.statusCode, 404, `body=${res.body}`);
    assert.match(res.body, /machine.*not found/);
  });

  test('sync-to-machine：机器属于别的 team → 403', async () => {
    const a = await seedFixture(sql, 'sync-cross-machine-A');
    const b = await seedFixture(sql, 'sync-cross-machine-B');
    fixtures.push(a, b);
    const { id: todoId } = await createTodoRow(sql, a, 'todo');
    await createBuildRow(sql, a, todoId);
    // 机器挂在 b 团队下 —— 不该被 a 团队的 todo 同步
    const bMachineId = await createMachineRow(sql, b.teamId, b.userId, {
      isOnline: true,
      workspacesDir: '/ws',
    });

    const res = await app.inject({
      headers: { authorization: `Bearer ${a.key}` },
      method: 'POST',
      url: `/api/todos/${todoId}/sync-to-machine`,
      payload: { machineId: bMachineId },
    });
    assert.equal(res.statusCode, 403, `body=${res.body}`);
    assert.match(res.body, /belongs to a different team/);
  });

  test('sync-to-machine：机器离线 → ok:false + reason 含「离线」', async () => {
    const f = await seedFixture(sql, 'sync-offline');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'todo');
    await createBuildRow(sql, f, todoId);
    const machineId = await createMachineRow(sql, f.teamId, f.userId, {
      isOnline: false,
      workspacesDir: '/ws',
    });

    const res = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/todos/${todoId}/sync-to-machine`,
      payload: { machineId },
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as { ok: boolean; reason: string };
    assert.notStrictEqual(body.ok, true, '分支 (b)：离线机器必须 ok:false');
    assert.match(body.reason, /离线/);
  });

  test('sync-to-machine：机器在线但 workspacesDir=null → ok:false + reason 含「工作目录」', async () => {
    const f = await seedFixture(sql, 'sync-no-ws');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'todo');
    await createBuildRow(sql, f, todoId);
    const machineId = await createMachineRow(sql, f.teamId, f.userId, {
      isOnline: true,
      workspacesDir: null,
    });

    const res = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/todos/${todoId}/sync-to-machine`,
      payload: { machineId },
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as { ok: boolean; reason: string };
    assert.notStrictEqual(body.ok, true, '分支 (c)：null workspacesDir 必须 ok:false');
    assert.match(body.reason, /工作目录/);
  });

  test('sync-to-machine：机器在线 + 有工作目录 → ok:true + 写 pending action（指令已下发，非已同步）', async () => {
    // ⚠️ 2026-10-18 起这条断言翻转了。此前 daemon 侧没有拉取协议，本分支
    // 恒返回 `ok:false` + 「daemon 尚未实现」；协议接通后改成**下发一条
    // pending action 并返回 ok:true**。
    //
    // **为什么 `ok:true` 仍然是诚实的**：`ok` 指的是「指令已成功下发给这台
    // 机器」，不是「文件已经拉到本地」。真正的执行结果由 daemon 执行完
    // 后回执（`POST /api/machine/action-result`）确定。所以这条测试除了
    // 断言 ok:true 之外，还要断言「action 行确实是 pending」——
    // 这是「下发」与「完成」两者的分界线。
    const f = await seedFixture(sql, 'sync-online-with-ws');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'todo');
    const { id: buildId, n: _buildN } = await createBuildRow(sql, f, todoId);
    const machineId = await createMachineRow(sql, f.teamId, f.userId, {
      isOnline: true,
      workspacesDir: '/ws',
    });

    const res = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/todos/${todoId}/sync-to-machine`,
      payload: { machineId },
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as {
      ok: boolean;
      actionId?: string;
      machineId?: string;
      branch?: string;
      dir?: string;
      todoId?: string;
      buildId?: string | null;
    };
    assert.equal(body.ok, true, `在线 + 有工作目录应当下发指令：${res.body}`);
    assert.ok(body.actionId, '必须返回 actionId —— 前端要靠它知道「去等回执」');
    assert.equal(body.machineId, machineId, 'machineId 必须返回');
    assert.equal(body.todoId, todoId, 'todoId 必须返回（回执要靠它溯源）');

    // **dir 是 `<workspacesDir>/<buildId>`，不是工作根。**
    //
    // 契约 §3.6 要求 daemon「必须直接用 dir，不要拼自己的 home」，而
    // `MachineAction` 里没有 baseBranch 字段 —— 给了工作根 daemon 也拼不出
    // 该进哪个子目录。更重要的是这个目录**就是 daemon 自己给这个 build 建的
    // 隔离工作区**（`PATHS.workspaces/<buildId>`，见 paths.ts / git.ts），
    // 所以它大概率已经存在且是 git 仓库，fetch/checkout/reset 直接能用。
    assert.equal(
      body.dir,
      `/ws/${buildId}`,
      `dir 必须 = <workspacesDir>/<buildId>，实际 ${body.dir}`,
    );

    // 关键：DB 里确实落了一条 **pending** 行，且它就是刚返回的 actionId。
    // 这一行 pending 就是「已下发但未完成」的事实凭据 —— 端到端测试里
    // 前端据此区分「指令已下发」与「同步完成」。
    const rows = await sql<
      { id: string; status: string; branch: string; dir: string; kind: string }[]
    >`
      select id, status, branch, dir, kind
        from machine_pending_action
       where id = ${body.actionId}
    `;
    assert.equal(rows.length, 1, 'pending action 行必须存在');
    assert.equal(rows[0]!.status, 'pending', '刚下发必须是 pending —— 不许直接标 done');
    assert.equal(rows[0]!.kind, 'sync_branch', 'kind 必须是 sync_branch');
    assert.equal(
      rows[0]!.dir,
      `/ws/${buildId}`,
      'pending action 行的 dir 必须与响应一致（daemon 拿的是这一行的值）',
    );

    // branch 必须取「最新 build 的分支」而不是 todo 级的东西
    const buildRow = await sql<{ branch: string }[]>`select branch from "build" where id = ${buildId}`;
    assert.equal(buildRow[0]?.branch, body.branch, '返回的 branch 必须 = 最新 build.branch');
    assert.equal(rows[0]!.branch, body.branch, 'pending action 行的 branch 必须一致');
  });

  test('sync-to-machine：同机器同 todo 连点两次 → 复用同一个 actionId（幂等）', async () => {
    // 用户连点两下不该产生两条要 git 拉取的指令。第二次请求必须复用第一条
    // pending 行并返回**同一个** actionId —— 前端拿到同一个 id 就知道是
    // 「同一次同步」，而不是两次独立任务。
    const f = await seedFixture(sql, 'sync-idempotent');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'todo');
    await createBuildRow(sql, f, todoId);
    const machineId = await createMachineRow(sql, f.teamId, f.userId, {
      isOnline: true,
      workspacesDir: '/ws',
    });

    const call = async (): Promise<{ ok: boolean; actionId?: string }> => {
      const res = await app.inject({
        headers: { authorization: `Bearer ${f.key}` },
        method: 'POST',
        url: `/api/todos/${todoId}/sync-to-machine`,
        payload: { machineId },
      });
      assert.equal(res.statusCode, 200, `body=${res.body}`);
      return JSON.parse(res.body) as { ok: boolean; actionId?: string };
    };

    const first = await call();
    const second = await call();
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.ok(first.actionId, '第一次必须有 actionId');
    assert.strictEqual(
      second.actionId,
      first.actionId,
      '连点两次必须返回同一个 actionId —— 否则会下发两条重复的 git 拉取指令',
    );

// 只数 pending/running：终态行留着是历史，不该参与「有没有待办」的判定
    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from machine_pending_action
       where machine_id = ${machineId} and todo_id = ${todoId}
         and status in ('pending','running')`;
    assert.equal(rows[0]?.n, 1, '待办指令必须只有一行');
  });

  test('sync-to-machine：机器离线/无工作目录 → ok:false 且不写 pending action（防假绿）', async () => {
    // **本条的意图**：不可用的机器上点「同步到机器」不许产生一条永远不会被
    // daemon 执行的 pending 指令。`ok:false` 时 DB 必须零写入 ——
    // 否则 pending 队列会堆垃圾行，等机器上线时一次拉取几十条历史指令。
    const f = await seedFixture(sql, 'sync-lockdown');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'todo');
    await createBuildRow(sql, f, todoId);
    const offlineMachineId = await createMachineRow(sql, f.teamId, f.userId, {
      isOnline: false,
      workspacesDir: '/ws',
    });
    const noWsMachineId = await createMachineRow(sql, f.teamId, f.userId, {
      isOnline: true,
      workspacesDir: null,
    });

    const scenarios: Array<{ label: string; machineId: string; expect: RegExp }> = [
      { label: 'offline', machineId: offlineMachineId, expect: /离线/ },
      { label: 'no-ws', machineId: noWsMachineId, expect: /工作目录/ },
    ];
    for (const sc of scenarios) {
      const res = await app.inject({
        headers: { authorization: `Bearer ${f.key}` },
        method: 'POST',
        url: `/api/todos/${todoId}/sync-to-machine`,
        payload: { machineId: sc.machineId },
      });
      assert.equal(res.statusCode, 200, `[${sc.label}] body=${res.body}`);
      const body = JSON.parse(res.body) as { ok: boolean; reason: string; actionId?: string };
      assert.strictEqual(body.ok, false, `[${sc.label}] 不可用的机器必须 ok:false`);
      assert.match(body.reason, sc.expect, `[${sc.label}] reason 必须说明原因`);
      assert.strictEqual(
        body.actionId,
        undefined,
        `[${sc.label}] ok:false 时不许返回 actionId —— 那会让前端以为有指令在跑`,
      );

      // DB 零写入
      const rows = await sql<{ n: number }[]>`
        select count(*)::int as n from machine_pending_action where machine_id = ${sc.machineId}`;
      assert.equal(rows[0]?.n, 0, `[${sc.label}] ok:false 必须 DB 零写入`);
    }
  });

  // ─────────────────────────── GET /api/todos 列表字段 ────

  test('GET /api/todos：列表项必有 ownerMemberId + createdByType', async () => {
    const f = await seedFixture(sql, 'list-shape');
    fixtures.push(f);
    // 造一条 todo 让列表非空
    const created = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: '/api/todos',
      payload: {
        teamId: f.teamId,
        projectId: f.projectId,
        ownerMemberId: f.memberId,
        agentId: f.agentId,
        title: '列表 shape',
        spec: null,
        tagIds: [],
        planFirst: true,
      },
    });
    assert.equal(created.statusCode, 200, `body=${created.body}`);
    const todoId = (JSON.parse(created.body) as { id: string }).id;

    const res = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'GET',
      url: `/api/todos?teamId=${f.teamId}`,
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as {
      todos: Array<{ id: string; ownerMemberId: string; createdByType: string }>;
    };
    const item = body.todos.find((t) => t.id === todoId);
    assert.ok(item, '新建的 todo 必须在列表里');
    assert.equal(item!.ownerMemberId, f.memberId, 'ownerMemberId 必有且匹配');
    assert.equal(typeof item!.createdByType, 'string', 'createdByType 必有');
    assert.ok(
      (['user', 'chief', 'agent'] as const).includes(item!.createdByType as 'user' | 'chief' | 'agent'),
      `createdByType 必须在 user|chief|agent 集合内，实际=${item!.createdByType}`,
    );
  });

  test('POST /api/todos：REST 写路径必填 createdByType=user（不靠默认值蒙对）', async () => {
    // 路由层显式标 'user'（不传则漏 service 层编译错误）。**显式断言值**，
    // 不靠 column DEFAULT —— 万一默认值改成 'agent' 了，这条会立刻红。
    const f = await seedFixture(sql, 'rest-createdByType');
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
        title: 'REST 显式 user',
        spec: null,
        tagIds: [],
        planFirst: true,
      },
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const todoId = (JSON.parse(res.body) as { id: string }).id;

    const rows = await sql<{ created_by_type: string }[]>`
      select created_by_type from "todo" where id = ${todoId}
    `;
    assert.equal(rows[0]?.created_by_type, 'user', 'REST 路径必为 user（CHECK 约束对齐）');
  });

  // ───────────────── GET /api/documents/:docId ────────────────────────
  // 这条路由此前**不存在**（实测 `GET /api/documents/<已落库的 changes 文档>`
  // 回 404），于是 BFF 归一成 `ready:false`，UI 上永远是「Changes 文档不可用」，
  // 哪怕 `build.changes_doc_id` 已写值 —— 闸门看不见 diff。断言的是消费者
  // 真正拿到的东西：扁平 Document、404、以及跨团队读不到正文。

  test('单文档：200 且是扁平 Document（前端 `lib/api.ts:96` 的形状）', async () => {
    const f = await seedFixture(sql, 'doc-single');
    fixtures.push(f);
    const { id: todoId } = await createTodoRow(sql, f, 'confirm');
    const { id: buildId } = await createBuildRow(sql, f, todoId);
    const docId = await createDocumentRow(sql, buildId, 'changes');

    const res = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'GET',
      url: `/api/documents/${docId}`,
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const doc = JSON.parse(res.body) as {
      id: string;
      buildId: string;
      kind: string;
      version: number;
      payload: Record<string, unknown>;
    };
    assert.equal(doc.id, docId);
    assert.equal(doc.buildId, buildId);
    assert.equal(doc.kind, 'changes');
    assert.equal(doc.version, 1);
    assert.deepEqual(doc.payload, { text: 'seed' });
    // BFF 把上游 JSON 原样塞进 `{ready:true,data}`，前端
    // `setChangesDoc(docBody.data)` 直接当 Document 用 —— 这里再包一层
    // `{document}` 就会让 `changesDoc.kind` 变 undefined，闸门照样空白。
    assert.equal('document' in doc, false, '必须扁平返回，不能包一层');
  });

  test('单文档：不存在的 id → 404（不是空 200）', async () => {
    const f = await seedFixture(sql, 'doc-404');
    fixtures.push(f);
    const res = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'GET',
      url: `/api/documents/${newId()}`,
    });
    assert.equal(res.statusCode, 404, `body=${res.body}`);
  });

  test('单文档：跨团队 key 读不到别人的 diff（403 且不带正文）', async () => {
    const owner = await seedFixture(sql, 'doc-owner');
    const other = await seedFixture(sql, 'doc-other');
    fixtures.push(owner, other);
    const { id: todoId } = await createTodoRow(sql, owner, 'confirm');
    const { id: buildId } = await createBuildRow(sql, owner, todoId);
    const docId = await createDocumentRow(sql, buildId, 'changes');

    const res = await app.inject({
      headers: { authorization: `Bearer ${other.key}` },
      method: 'GET',
      url: `/api/documents/${docId}`,
    });
    assert.equal(res.statusCode, 403, `body=${res.body}`);
    assert.ok(!res.body.includes('seed'), '越权时不能把 payload 正文带出去');
  });
});
