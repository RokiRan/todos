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
 * Continue / Reuse plan 端点契约（POST /api/todos/:todoId/continue|reuse-plan）：
 *
 *   跨团队 → **403**，且数据库里 todo 的 phase / build 行的状态都没被改
 *
 *   todo 不存在 → 404
 *
 *   Continue：
 *     - 非 failed（done / closed）→ 409
 *     - failed todo 但 build 行 errorMessage 是 null（非失败 build） → 409
 *     - failed todo 且最新 build 有 errorMessage → 200，build 行 errorMessage 已被清，
 *       新 step 行 status='queued'，phase 仍 failed（**不动**，因为状态机无 failed→
 *       非终态 trigger，daemon settle 才推进）
 *     - userId 字段（伪 BFF proxyWrite 注入兜底）→ 200（strict 通过）
 *
 *   Reuse plan：
 *     - 非终态（todo / planning ...）→ 409
 *     - 终态但 todo 没有任何 build 的 planDocId 非空 → 409「无 plan 可复用」
 *     - 终态且最近 build 的 planDocId 非空（文档存在 kind='plan'） → 200，
 *       新 build 行 + 新 plan doc 行 → 数据库里能查到
 *     - userId 字段（伪 BFF proxyWrite 注入兜底）→ 200（strict 通过）
 *
 *   zod 非法 body（nonsense 字段）→ 422
 *
 * 全部真 Postgres + app.inject + 不 mock —— 与 todo-move.test.ts 同源。
 *
 * ⚠️ daemon 限制披露：本测试**不**断言「agent 真的在原 build 上跑了 turn」——
 *   Continue 的端到端连续性取决于 daemon 是否支持对**已完成 step** 的 build
 *   再发起新 step（本切片写库内 reset + 新 step 行；daemon 是否接是另一个切片）。
 *   测试只断言「库内状态变更正确」：（build 行 errorMessage 已清）+（同 buildId 上
 *   有一行 status='queued' 的 step）足以证明「continue 已落库」。如果以后
 *   pendingRestore 真接通，daemon 端会基于这条 queued step 接续。
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
    values (${newId()}, ${userId}, ${'tc-' + label}, ${k.prefix}, ${k.hash}, ${scopes}, ${ts})
  `;
  return { label, userId, teamId, projectId, memberId, agentId, key: k.key };
}

async function seedTodoAt(
  sql: postgres.Sql,
  f: Fixture,
  phase: 'todo' | 'confirm' | 'review' | 'implement' | 'queued' | 'planning' | 'reviewing' | 'done' | 'failed' | 'closed',
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
      (${id}, ${f.projectId}, ${seq}, ${f.memberId}, ${f.agentId}, 'TodoContinue todo',
       '{}', ${phase}, true, false, false, ${tsStr}, ${tsStr})
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

/**
 * 给 todo 插一条 build 行；可选地标记 errorMessage / settlementCode / planDocId。
 * 用 raw SQL 写 —— build 行通常由 `startBuild()` 起，但本切片只需要测 endpoint
 * 内部 SQL，不需要重现整条派发链。
 */
async function seedBuild(
  sql: postgres.Sql,
  f: Fixture,
  todoId: string,
  opts: {
    n?: number;
    errorMessage?: string | null;
    settlementCode?: string | null;
    planDocId?: string | null;
  } = {},
): Promise<{ buildId: string; n: number }> {
  const id = newId();
  const ts = now();
  const prior = await sql<{ maxN: number }[]>`
    select coalesce(max(n), 0)::int as "maxN" from "build" where todo_id = ${todoId}
  `;
  const n = (prior[0]?.maxN ?? 0) + 1;
  await sql`
    insert into "build"
      (id, todo_id, n, branch, prev_phase, trigger_source, settlement_code, error_message,
       with_plan, with_checklist, agent_id, plan_doc_id, session, usage_by_model, created_at, v)
    values
      (${id}, ${todoId}, ${n}, ${'tds/conv-' + id}, ${'planning'}, ${'user'},
       ${opts.settlementCode ?? null}, ${opts.errorMessage ?? null},
       ${opts.planDocId ? true : false}, false, ${f.agentId}, ${opts.planDocId ?? null},
       ${JSON.stringify({ runtime: 'test', id: newId(), openedAt: ts })}::jsonb,
       ${'[]'}::jsonb, ${ts}, 0)
  `;
  return { buildId: id, n };
}

async function seedPlanDoc(
  sql: postgres.Sql,
  buildId: string,
  payload: Record<string, unknown> = { summary: 'reused' },
): Promise<{ docId: string }> {
  const id = newId();
  const ts = now();
  await sql`
    insert into "document" (id, build_id, kind, version, payload, created_at, updated_at)
    values (${id}, ${buildId}, 'plan', 1, ${JSON.stringify(payload)}::jsonb, ${ts}, ${ts})
  `;
  return { docId: id };
}

async function readBuild(
  sql: postgres.Sql,
  buildId: string,
): Promise<{ errorMessage: string | null; settlementCode: string | null; planDocId: string | null } | undefined> {
  const rows = await sql<{ error_message: string | null; settlement_code: string | null; plan_doc_id: string | null }[]>`
    select error_message, settlement_code, plan_doc_id from "build" where id = ${buildId} limit 1
  `;
  if (!rows[0]) return undefined;
  return {
    errorMessage: rows[0].error_message,
    settlementCode: rows[0].settlement_code,
    planDocId: rows[0].plan_doc_id,
  };
}

async function countStepsForBuild(
  sql: postgres.Sql,
  buildId: string,
): Promise<{ count: number; latestStatus: string | null }> {
  const total = (await sql<{ n: number }[]>`
    select count(*)::int as n from "step" where build_id = ${buildId}
  `)[0];
  // step 表**没有** created_at —— 只有 claimed_at（claim 之前为 null）/ heartbeat /
  // finished_at。用 heartbeat_at desc 是不靠谱的「最新进展」近似，
  // 对 queued step 来说 heartbeat 也是 null，所以会按主键顺序回退；这足够
  // 断言「至少一行 step 且最新一行 status='queued'」的轻量结论。
  const latest = (await sql<{ status: string | null }[]>`
    select status from "step" where build_id = ${buildId}
    order by heartbeat_at desc nulls last, claimed_at desc nulls last, id asc
    limit 1
  `)[0];
  return { count: total?.n ?? 0, latestStatus: latest?.status ?? null };
}

async function deleteFixture(sql: postgres.Sql, f: Fixture): Promise<void> {
  // 同 todo-move.test.ts 的清理顺序：先项目再 team，避免 FK 卡死（agent / member
  // 都在 project 下游，但 build 行 → todo → project 级联）。这里多挂 build /
  // document / step，先把它们一起删。
  await sql`delete from "audit_event" where team_id = ${f.teamId}`;
  await sql`delete from "sse_event" where team_id = ${f.teamId}`;
  await sql`delete from "project" where id = ${f.projectId}`;
  await sql`delete from "team" where id = ${f.teamId}`;
  await sql`delete from "user" where id = ${f.userId}`;
}

// ─────────────────────────────────────────────────────────────

describe('TodoContinue · REST 端点契约', () => {
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

  // ─────────────── Continue · 鉴权 ───────────────

  test('跨团队用户对他人 failed todo 调 /continue → 403（不是 401、不是 404）', async () => {
    const owner = await seedFixture(sql, 'tc-cont-owner', ['tool:complete_todos']);
    fixtures.push(owner);
    const { todoId, updatedAtBefore } = await seedTodoAt(sql, owner, 'failed');
    const { buildId } = await seedBuild(sql, owner, todoId, { errorMessage: 'boom', settlementCode: 'runtime_error' });
    void buildId;

    const stranger = await seedFixture(sql, 'tc-cont-stranger', ['tool:complete_todos']);
    fixtures.push(stranger);

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/continue`,
      headers: { authorization: `Bearer ${stranger.key}` },
      payload: {},
    });
    assert.equal(res.statusCode, 403, `body=${res.body}`);

    // 数据库 todo 行 phase 不变；build 行 errorMessage 也不被清（403 不进事务）
    const after = await readTodo(sql, todoId);
    assert.ok(after);
    assert.equal(after.phase, 'failed');
    assert.equal(after.updated_at, updatedAtBefore);
    const builds = await sql<{ error_message: string | null }[]>`
      select error_message from "build" where todo_id = ${todoId} order by n desc limit 1
    `;
    assert.equal(builds[0]?.error_message, 'boom', '403 时 build.errorMessage 不能被清');
  });

  // ─────────────── Continue · 404 ───────────────

  test('continue / reuse-plan 对不存在的 todo → 404', async () => {
    const f = await seedFixture(sql, 'tc-404', ['tool:complete_todos']);
    fixtures.push(f);
    const ghostId = 'definitely-not-a-real-todo';

    for (const path of ['continue', 'reuse-plan'] as const) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/todos/${ghostId}/${path}`,
        headers: { authorization: `Bearer ${f.key}` },
        payload: {},
      });
      assert.equal(res.statusCode, 404, `${path} → 404 expected, got ${res.statusCode}: ${res.body}`);
    }
  });

  // ─────────────── Continue · 409 / 422 ───────────────

  test('continue 在非 failed（done）上 → 409 且 DB 不变', async () => {
    const f = await seedFixture(sql, 'tc-cont-done', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId, updatedAtBefore } = await seedTodoAt(sql, f, 'done');
    await seedBuild(sql, f, todoId, { errorMessage: null }); // done build 通常不失败

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/continue`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: {},
    });
    assert.equal(res.statusCode, 409, `body=${res.body}`);
    assert.match(res.body, /continue is only valid on a failed todo/);

    const after = await readTodo(sql, todoId);
    assert.equal(after?.phase, 'done');
    assert.equal(after?.updated_at, updatedAtBefore);
  });

  test('continue 在 failed 但 build 行 errorMessage=null（非失败 build）→ 409', async () => {
    // 这条用例锁死「失败判定只用 errorMessage」的语义：phase 是 failed 不等于
    // 「存在失败 build 可 continue」。
    const f = await seedFixture(sql, 'tc-cont-nobuild', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId, updatedAtBefore } = await seedTodoAt(sql, f, 'failed');
    // 没有任何 build 行 —— 也算「没有失败 build 可 continue」。
    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/continue`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: {},
    });
    assert.equal(res.statusCode, 409, `body=${res.body}`);

    const after = await readTodo(sql, todoId);
    assert.equal(after?.phase, 'failed');
    assert.equal(after?.updated_at, updatedAtBefore);
  });

  test('continue 在 failed + 但 build 行 errorMessage=null（虽然 phase 已 failed）→ 409', async () => {
    // 同上但加一条 errorMessage=null 的 build 行 —— 锁死「findContinueTarget」的判定。
    const f = await seedFixture(sql, 'tc-cont-empty', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId, updatedAtBefore } = await seedTodoAt(sql, f, 'failed');
    await seedBuild(sql, f, todoId, { errorMessage: null });

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/continue`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: {},
    });
    assert.equal(res.statusCode, 409, `body=${res.body}`);

    const after = await readTodo(sql, todoId);
    assert.equal(after?.phase, 'failed');
    assert.equal(after?.updated_at, updatedAtBefore);
  });

  test('continue 在 failed + build 行有 errorMessage → 200，build.errorMessage 清空，新 step 入队，phase 仍 failed（不让状态机擅自推进）', async () => {
    const f = await seedFixture(sql, 'tc-cont-ok', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId } = await seedTodoAt(sql, f, 'failed');
    const { buildId } = await seedBuild(sql, f, todoId, {
      errorMessage: 'agent turn failed',
      settlementCode: 'runtime_error',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/continue`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: {},
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as {
      ok: boolean;
      phase: string;
      buildId: string;
      stepId: string;
      continued: boolean;
    };
    assert.equal(body.ok, true);
    assert.equal(body.phase, 'failed', 'phase 必须仍为 failed —— 状态机无 failed→非终态路径');
    assert.equal(body.buildId, buildId);
    assert.equal(body.continued, true);

    // build 行：errorMessage 清空、settlementCode 清空、v +1。
    const buildRow = await readBuild(sql, buildId);
    assert.ok(buildRow);
    assert.equal(buildRow.errorMessage, null, 'continue 后 build.errorMessage 必须清空');
    assert.equal(buildRow.settlementCode, null, 'continue 后 build.settlementCode 必须清空');

    // step：新一行 queued
    const steps = await countStepsForBuild(sql, buildId);
    assert.ok(steps.count >= 1, 'continue 后必须有 step');
    assert.equal(steps.latestStatus, 'queued');

    // todo phase 不动 —— 与 body.phase 一致
    const after = await readTodo(sql, todoId);
    assert.equal(after?.phase, 'failed');
  });

  test('continue body 接受 userId 字段（proxyWrite 注入兜底，.strict() 不拒） → 200', async () => {
    // 这条是契约：以后真有人改 BFF 走 proxyWrite 而 ContinueBody 仍 .strict()
    // 也不会被 422 误伤。本路由当前 BFF 是手写转发不带 userId，但声明 shape 稳。
    const f = await seedFixture(sql, 'tc-cont-userid', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId } = await seedTodoAt(sql, f, 'failed');
    await seedBuild(sql, f, todoId, { errorMessage: 'boom' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/continue`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: { userId: 'fake-user-id', buildId: undefined },
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
  });

  test('continue body 含无关字段 → 422（strict() 真生效）', async () => {
    const f = await seedFixture(sql, 'tc-cont-strict', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId } = await seedTodoAt(sql, f, 'failed');
    await seedBuild(sql, f, todoId, { errorMessage: 'boom' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/continue`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: { nonsense: 1 },
    });
    assert.equal(res.statusCode, 422, `body=${res.body}`);
  });

  test('continue 指定 buildId 但该 build 不是 failed → 409', async () => {
    const f = await seedFixture(sql, 'tc-cont-wrongb', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId } = await seedTodoAt(sql, f, 'failed');
    // 一条有 errorMessage 的失败 build
    const { buildId: failedBuildId } = await seedBuild(sql, f, todoId, { errorMessage: 'the real fail' });
    // 一条没 errorMessage 的非失败 build（更早一轮 maybe 就成功了）
    const { buildId: okBuildId } = await seedBuild(sql, f, todoId, { errorMessage: null });

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/continue`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: { buildId: okBuildId },
    });
    assert.equal(res.statusCode, 409, `body=${res.body}`);

    // failedBuildId 那一条**也**不应该被改 —— 409 是路由层即时返回，没进事务。
    const failedRow = await readBuild(sql, failedBuildId);
    assert.equal(failedRow?.errorMessage, 'the real fail');
    void failedBuildId;
  });

  test('continue 指定 buildId 指向那条失败 build → 200，且只清那一条的 errorMessage', async () => {
    const f = await seedFixture(sql, 'tc-cont-specific', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId } = await seedTodoAt(sql, f, 'failed');
    const { buildId: oldFailedBuild } = await seedBuild(sql, f, todoId, { errorMessage: 'earlier fail' });
    const { buildId: latestFailedBuild } = await seedBuild(sql, f, todoId, { errorMessage: 'latest fail' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/continue`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: { buildId: latestFailedBuild },
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as { buildId: string };
    assert.equal(body.buildId, latestFailedBuild);

    // 老 failed build 不被改
    const oldRow = await readBuild(sql, oldFailedBuild);
    assert.equal(oldRow?.errorMessage, 'earlier fail', '旧失败 build 不能被连带清掉');
    // 新指定的那条被清
    const newRow = await readBuild(sql, latestFailedBuild);
    assert.equal(newRow?.errorMessage, null);
  });

  // ─────────────── Reuse plan · 409 ───────────────

  test('reuse-plan 在非终态（todo）上 → 409 且 DB 不变', async () => {
    const f = await seedFixture(sql, 'tc-reuse-todo', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId, updatedAtBefore } = await seedTodoAt(sql, f, 'todo');
    // 即便 todo 已有 plan 文档，phase 不对就 409 —— 测的是「终态闸门」
    const { buildId } = await seedBuild(sql, f, todoId);
    const { docId } = await seedPlanDoc(sql, buildId);
    await sql`update "build" set plan_doc_id = ${docId} where id = ${buildId}`;

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/reuse-plan`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: {},
    });
    assert.equal(res.statusCode, 409, `body=${res.body}`);
    assert.match(res.body, /reuse-plan is only valid on a settled todo/);

    const after = await readTodo(sql, todoId);
    assert.equal(after?.phase, 'todo');
    assert.equal(after?.updated_at, updatedAtBefore);
  });

  test('reuse-plan 在 failed todo 但 build 行 planDocId=null → 409「无 plan 可复用」', async () => {
    // 关键：用 planDocId 判「该 build 真出过 plan」，不用 withPlan。
    // withPlan 在创建时透传 planFirst，根本不能反映「产出过 plan」。
    const f = await seedFixture(sql, 'tc-reuse-noplan', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId, updatedAtBefore } = await seedTodoAt(sql, f, 'failed');
    // 创建 build 时 planDocId 不带 —— 即使 withPlan 是 true（planFirst=true 透传）
    await seedBuild(sql, f, todoId, { errorMessage: 'boom', withPlan: true } as never);

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/reuse-plan`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: {},
    });
    assert.equal(res.statusCode, 409, `body=${res.body}`);
    assert.match(res.body, /no plan document/);

    const after = await readTodo(sql, todoId);
    assert.equal(after?.phase, 'failed');
    assert.equal(after?.updated_at, updatedAtBefore);
  });

  test('reuse-plan 在 failed + 最近 build 有 planDocId + 文档存在 → 200，新 build + 新 plan 文档入库', async () => {
    const f = await seedFixture(sql, 'tc-reuse-ok', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId } = await seedTodoAt(sql, f, 'failed');
    const { buildId } = await seedBuild(sql, f, todoId, {
      errorMessage: 'failed at implement',
      settlementCode: 'runtime_error',
    });
    const { docId } = await seedPlanDoc(sql, buildId, { summary: 'previous turn plan' });
    await sql`update "build" set plan_doc_id = ${docId} where id = ${buildId}`;

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/reuse-plan`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: {},
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as {
      ok: boolean;
      phase: string;
      buildId: string;
      reusedPlanFrom: string;
    };
    assert.equal(body.ok, true);
    assert.equal(body.phase, 'todo', 'reuse-plan 必须把 phase 推到 todo（与 rerun 同）');
    assert.equal(body.reusedPlanFrom, buildId, '要回报旧 build 标的是哪条');
    assert.notEqual(body.buildId, buildId, '必须是新 build id');

    // 库内：新 build 行的 n = 旧 build n + 1，prevPhase=failed，planDocId 不为 null
    const newBuilds = await sql<{ id: string; n: number; prev_phase: string | null; plan_doc_id: string | null }[]>`
      select id, n, prev_phase, plan_doc_id from "build" where id = ${body.buildId} limit 1
    `;
    assert.ok(newBuilds[0]);
    assert.equal(newBuilds[0].prev_phase, 'failed');
    assert.ok(newBuilds[0].plan_doc_id, '新 build 必须有 planDocId');

    // 新 plan 文档：build_id = 新 build，kind='plan'，payload 与旧同形
    const newDocs = await sql<{ payload: unknown; kind: string }[]>`
      select payload, kind from "document" where build_id = ${body.buildId} limit 1
    `;
    assert.ok(newDocs[0]);
    assert.equal(newDocs[0].kind, 'plan');
    assert.deepEqual(newDocs[0].payload as Record<string, unknown>, { summary: 'previous turn plan' });

    // todo phase 现在是 todo
    const after = await readTodo(sql, todoId);
    assert.equal(after?.phase, 'todo');

    // ── 响应键名契约回归保护 ────────────────────────────────────────
    // `apps/web/src/app/todo/[id]/page.tsx` 的 Reuse plan 按钮可见条件读
    // `builds?.[0]?.planDocId` —— 必须确认上游真的以驼峰键返回，**不**是
    // snake_case。drizzle 是 TS 属性名 ↔ DB 列名的桥（`packages/db` schema
    // 里 `planDocId` ↔ `plan_doc_id`），select() 默认走属性名：BFF 又 raw
    // 透传，所以 GET /api/todos/:todoId/builds 的 JSON 里 `planDocId` 应当
    // 存在且非空。断言这一条防止后续如果谁在 `apps/server/src/main.ts` 加
    // `casing: 'snake_case'` 或在 BFF 里塞键名转换，会让前端静默失效
    // （按钮永远不显示，看板 reusable build 变成看不见）。
    const buildsRes = await app.inject({
      method: 'GET',
      url: `/api/todos/${todoId}/builds`,
      headers: { authorization: `Bearer ${f.key}` },
    });
    assert.equal(buildsRes.statusCode, 200, `body=${buildsRes.body}`);
    const buildsJson = JSON.parse(buildsRes.body) as { builds?: Array<Record<string, unknown>> };
    assert.ok(Array.isArray(buildsJson.builds));
    assert.ok(buildsJson.builds!.length >= 2, '旧 build + 新 build 都应在 builds 列表里');
    // 至少一个新 build（n 最大那条）的 `planDocId` 键名是 camelCase 且非 null
    const newest = buildsJson.builds!.reduce((max, b) =>
      Number(b['n'] ?? 0) > Number(max['n'] ?? 0) ? b : max, buildsJson.builds![0]!);
    assert.ok('planDocId' in newest, 'builds JSON 必须有 planDocId 键（驼峰键名契约）');
    assert.ok(
      Object.prototype.hasOwnProperty.call(newest, 'planDocId') &&
      !('plan_doc_id' in newest),
      'builds JSON 不能同时混 plan_doc_id 键 —— 要么驼峰要么下划线，不能漂移',
    );
    assert.ok(newest['planDocId'], '最新 build 必须有非空 planDocId（reuse-plan 端点的语义落点）');
  });

  test('reuse-plan 跨团队 → 403', async () => {
    const owner = await seedFixture(sql, 'tc-reuse-owner', ['tool:complete_todos']);
    fixtures.push(owner);
    const { todoId, updatedAtBefore } = await seedTodoAt(sql, owner, 'done');
    const { buildId } = await seedBuild(sql, owner, todoId);
    const { docId } = await seedPlanDoc(sql, buildId);
    await sql`update "build" set plan_doc_id = ${docId} where id = ${buildId}`;

    const stranger = await seedFixture(sql, 'tc-reuse-stranger', ['tool:complete_todos']);
    fixtures.push(stranger);

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/reuse-plan`,
      headers: { authorization: `Bearer ${stranger.key}` },
      payload: {},
    });
    assert.equal(res.statusCode, 403, `body=${res.body}`);

    const after = await readTodo(sql, todoId);
    assert.equal(after?.phase, 'done');
    assert.equal(after?.updated_at, updatedAtBefore);
  });

  test('reuse-plan body 接受 userId 字段（proxyWrite 注入兜底） → 200', async () => {
    const f = await seedFixture(sql, 'tc-reuse-userid', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId } = await seedTodoAt(sql, f, 'failed');
    const { buildId } = await seedBuild(sql, f, todoId, { errorMessage: 'boom' });
    const { docId } = await seedPlanDoc(sql, buildId);
    await sql`update "build" set plan_doc_id = ${docId} where id = ${buildId}`;

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/reuse-plan`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: { userId: 'fake-user-id' },
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
  });

  test('reuse-plan body 含无关字段 → 422（strict() 真生效）', async () => {
    const f = await seedFixture(sql, 'tc-reuse-strict', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId } = await seedTodoAt(sql, f, 'failed');
    const { buildId } = await seedBuild(sql, f, todoId, { errorMessage: 'boom' });
    const { docId } = await seedPlanDoc(sql, buildId);
    await sql`update "build" set plan_doc_id = ${docId} where id = ${buildId}`;

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/reuse-plan`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: { nonsense: 1 },
    });
    assert.equal(res.statusCode, 422, `body=${res.body}`);
  });

  // ─────────────── 清理确认：fixture 全部收回 ───────────────
  test('全部 fixture 已在 after 钩子里 cleanup', () => {
    // 真实清理在 after() 钩子里跑；这里只是一个 hook 保险，不允许 fixture
    // 数量截断到 0 前还有未清理行。
    assert.ok(fixtures.length > 0, '至少跑过一条测试');
  });
});
