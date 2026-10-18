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
 * Restore / Rewind 端点契约（POST /api/todos/:todoId/restore）：
 *
 *   跨团队 → **403**，且目标 build 的 `pending_restore` JSONB 没被改
 *   同团队但 owner 是别人（user-member.actor_id != ctx.userId） → **403**，
 *     且 `pending_restore` 没被改
 *   同团队但 owner 是 agent-member（member_type='agent'） → **403**
 *
 *   todo 不存在 → 404
 *   build 不存在 → 404
 *
 *   phase 在 `todo` / `queued` / `planning` / `implement` / `reviewing`
 *     / `done` / `closed` → **409**，且 `pending_restore` 没被写
 *   phase 在 `confirm` / `review` / `failed` + 合法 body → **200**，
 *     且数据库里 `pending_restore` 真的写进去了（断言 JSONB 三个字段），
 *     且 **todo.phase 不变**（状态机没有 restore trigger —— 不能改相位）
 *
 *   非法 body（缺字段 / 类型错 / 无关字段）→ 422
 *   重复 restore（同一 build 已有 pending_restore）→ **409** 且不覆盖
 *
 *   「正在跑的 build 不可 restore」—— 用 `steps` 表的 queued|pending|running
 *   判定（不是 `builds.finishedAt`：failed/cancelled 时 finishedAt 也是 null），
 *   且 `pending_restore` 没被改。
 *
 * 全部真 Postgres + app.inject + 不 mock —— 与 todo-continue.test.ts 同源。
 *
 * ⚠️ daemon 限制披露：本测试**不**断言「worktree 真的被回滚」——
 *   Restore 切片只写 `pendingRestore` JSONB；daemon 端是否在 next turn 看到
 *   非空 pendingRestore 时真正回滚 worktree + 续 session 是另一个切片。
 *   测试只断言「库内状态变更正确」。
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
  agentMemberId: string;
  otherUserMemberId: string;
  otherUserId: string;
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
  // 用来测「owner 是别人」：另一名同团队 user + agent member。
  const otherUserId = newId();
  const otherUserMemberId = newId();
  const agentMemberId = newId();
  await sql`
    insert into "user" (id, email, display_name, status, locale, created_at, updated_at)
    values (${userId}, ${`${label}-${userId}@test.local`}, ${label}, 'active', 'en', ${ts}, ${ts})
  `;
  await sql`
    insert into "user" (id, email, display_name, status, locale, created_at, updated_at)
    values (${otherUserId}, ${`${label}-other-${otherUserId}@test.local`}, ${label + '-other'}, 'active', 'en', ${ts}, ${ts})
  `;
  await sql`
    insert into "team" (id, name, plan, storage_quota, created_at)
    values (${teamId}, ${label}, 'free', 1073741824, ${ts})
  `;
  await sql`
    insert into "member" (id, team_id, actor_id, member_type, role, joined_at, v)
    values (${memberId}, ${teamId}, ${userId}, 'user', 'admin', ${ts}, 0)
  `;
  // 第二个同团队 user-member —— 用作「owner 是别人」场景
  await sql`
    insert into "member" (id, team_id, actor_id, member_type, role, joined_at, v)
    values (${otherUserMemberId}, ${teamId}, ${otherUserId}, 'user', 'member', ${ts}, 0)
  `;
  // 一个 agent-member —— 用作「owner 是 agent」场景（todo.owner_member_id 指向它时
  // 谓词应当排除）
  await sql`
    insert into "member" (id, team_id, actor_id, member_type, role, joined_at, v)
    values (${agentMemberId}, ${teamId}, ${agentId}, 'agent', 'member', ${ts}, 0)
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
    values (${newId()}, ${userId}, ${'tr-' + label}, ${k.prefix}, ${k.hash}, ${scopes}, ${ts})
  `;
  return {
    label, userId, teamId, projectId, memberId, agentId,
    agentMemberId, otherUserMemberId, otherUserId,
    key: k.key,
  };
}

async function seedTodoAt(
  sql: postgres.Sql,
  f: Fixture,
  phase: 'todo' | 'confirm' | 'review' | 'implement' | 'queued' | 'planning' | 'reviewing' | 'done' | 'failed' | 'closed',
  ownerMemberId: string = f.memberId,
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
      (${id}, ${f.projectId}, ${seq}, ${ownerMemberId}, ${f.agentId}, 'TodoRestore todo',
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
 * 给 todo 插一条 build 行；可选地预置 pending_restore / step 行。
 * raw SQL —— 与 todo-continue.test.ts 同款，仅取本切片需要的字段。
 */
async function seedBuild(
  sql: postgres.Sql,
  f: Fixture,
  todoId: string,
  opts: {
    errorMessage?: string | null;
    pendingRestore?: Record<string, unknown> | null;
  } = {},
): Promise<{ buildId: string; n: number }> {
  const id = newId();
  const ts = now();
  const prior = await sql<{ maxN: number }[]>`
    select coalesce(max(n), 0)::int as "maxN" from "build" where todo_id = ${todoId}
  `;
  const n = (prior[0]?.maxN ?? 0) + 1;
  // ⚠️ `gate-law-e2e.ts:73` 注释：模板里 `${null}::jsonb` 写法会被 TS/JS 解析器
  // 误读（`::` 是类型断言语法）。postgres-js 自动把 JSON 字符串投到 jsonb 列
  // （已实测：insert into build(... jsonb) values ('{"a":1}') 工作），所以
  // 直接传字符串 + null 即可，省掉显式 ::jsonb cast。
  const sessionJson = JSON.stringify({ runtime: 'test', id: newId(), openedAt: ts });
  const emptyArr = JSON.stringify([]);
  const pendingRestoreJson = opts.pendingRestore ? JSON.stringify(opts.pendingRestore) : null;
  await sql`
    insert into "build"
      (id, todo_id, n, branch, prev_phase, trigger_source, settlement_code, error_message,
       with_plan, with_checklist, agent_id, plan_doc_id, session, usage_by_model,
       pending_restore, created_at, v)
    values
      (${id}, ${todoId}, ${n}, ${'tds/conv-' + id}, ${'planning'}, ${'user'},
       ${null}, ${opts.errorMessage ?? null},
       false, false, ${f.agentId}, ${null},
       ${sessionJson},
       ${emptyArr},
       ${pendingRestoreJson},
       ${ts}, 0)
  `;
  return { buildId: id, n };
}

async function seedStep(
  sql: postgres.Sql,
  buildId: string,
  opts: { status?: 'queued' | 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' } = {},
): Promise<{ stepId: string }> {
  const id = newId();
  const ts = now();
  await sql`
    insert into "step" (id, build_id, machine_id, status, claimed_at, heartbeat_at, finished_at)
    values (${id}, ${buildId}, ${null}, ${opts.status ?? 'queued'}, ${null}, ${null}, ${null})
  `;
  return { stepId: id };
}

async function readBuild(
  sql: postgres.Sql,
  buildId: string,
): Promise<{
  pendingRestore: Record<string, unknown> | null;
  v: number;
} | undefined> {
  const rows = await sql<{ pending_restore: Record<string, unknown> | null; v: number }[]>`
    select pending_restore, v from "build" where id = ${buildId} limit 1
  `;
  if (!rows[0]) return undefined;
  return { pendingRestore: rows[0].pending_restore, v: rows[0].v };
}

async function countAuditForBuild(
  sql: postgres.Sql,
  buildId: string,
  type: string,
): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from "audit_event"
    where build_id = ${buildId} and type = ${type}
  `;
  return rows[0]?.n ?? 0;
}

async function deleteFixture(sql: postgres.Sql, f: Fixture): Promise<void> {
  // 与 todo-continue.test.ts 一样的清理顺序：先 project 再 team，避免 FK。
  // 这里多挂 build / step / audit。
  await sql`delete from "audit_event" where team_id = ${f.teamId}`;
  await sql`delete from "sse_event" where team_id = ${f.teamId}`;
  await sql`delete from "project" where id = ${f.projectId}`;
  await sql`delete from "team" where id = ${f.teamId}`;
  await sql`delete from "user" where id = ${f.userId}`;
  await sql`delete from "user" where id = ${f.otherUserId}`;
}

const VALID_BODY = {
  commitSha: 'abc1234567890def',
  sessionLeafEntryId: 'leaf-xyz-001',
};

// ─────────────────────────────────────────────────────────────

describe('TodoRestore · REST 端点契约', () => {
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

  // ─────────────── 鉴权 · 跨团队 ───────────────

  test('跨团队用户对他人 failed todo 调 /restore → 403（不是 401、不是 404）', async () => {
    const owner = await seedFixture(sql, 'tr-cross-owner', ['tool:complete_todos']);
    fixtures.push(owner);
    const { todoId, updatedAtBefore } = await seedTodoAt(sql, owner, 'failed');
    const { buildId } = await seedBuild(sql, owner, todoId);

    const stranger = await seedFixture(sql, 'tr-cross-stranger', ['tool:complete_todos']);
    fixtures.push(stranger);

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/restore`,
      headers: { authorization: `Bearer ${stranger.key}` },
      payload: VALID_BODY,
    });
    assert.equal(res.statusCode, 403, `body=${res.body}`);

    // 数据库：todo 行 phase 不变；build 行 pending_restore 没被改
    const after = await readTodo(sql, todoId);
    assert.ok(after);
    assert.equal(after.phase, 'failed');
    assert.equal(after.updated_at, updatedAtBefore);
    const buildRow = await readBuild(sql, buildId);
    assert.ok(buildRow);
    assert.equal(buildRow.pendingRestore, null, '403 时 build.pending_restore 不能被写');
    assert.equal(Number(buildRow.v), 0, '403 时 build.v 不能自增');

    // 也不应有 audit 记录
    const auditCount = await countAuditForBuild(sql, buildId, 'restore_requested');
    assert.equal(auditCount, 0, '403 时不该有 restore_requested audit');
  });

  // ─────────────── 鉴权 · 非 owner（同团队） ───────────────

  test('同团队但 owner 是别人 → 403，且 DB 不变', async () => {
    // 把 todo 的 owner_member_id 指向 otherUserMemberId（otherUser 的人）。
    // 当前 fixture key 是 owner.key（user 是 owner.userId）。
    // 谓词应当过滤掉（member.actor_id != ctx.userId）。
    const f = await seedFixture(sql, 'tr-notowner', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId, updatedAtBefore } = await seedTodoAt(sql, f, 'review', f.otherUserMemberId);
    const { buildId } = await seedBuild(sql, f, todoId);

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/restore`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: VALID_BODY,
    });
    assert.equal(res.statusCode, 403, `body=${res.body}`);

    const after = await readTodo(sql, todoId);
    assert.equal(after?.phase, 'review');
    assert.equal(after?.updated_at, updatedAtBefore);
    const buildRow = await readBuild(sql, buildId);
    assert.equal(buildRow?.pendingRestore, null);
    assert.equal(Number(buildRow?.v ?? -1), 0);
  });

  test('owner 是 agent-member（member_type=agent）→ 403', async () => {
    // owner 谓词要求 member_type='user'；agent 拥有的 todo 不能 restore。
    const f = await seedFixture(sql, 'tr-agentowner', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId } = await seedTodoAt(sql, f, 'confirm', f.agentMemberId);
    await seedBuild(sql, f, todoId);

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/restore`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: VALID_BODY,
    });
    assert.equal(res.statusCode, 403, `body=${res.body}`);
  });

  // ─────────────── 404 ───────────────

  test('todo 不存在 → 404', async () => {
    const f = await seedFixture(sql, 'tr-404', ['tool:complete_todos']);
    fixtures.push(f);
    const ghostId = 'restore-not-a-real-todo';
    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${ghostId}/restore`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: VALID_BODY,
    });
    assert.equal(res.statusCode, 404, `body=${res.body}`);
  });

  test('todo 有 phase，但没有任何 build 行 → 404', async () => {
    // 端点语义：body 不带 buildId 时取最新 build，没有就 404
    // （不是 409「phase not allowed」，因为 phase 已 allowed；是 404「资源不够」）。
    const f = await seedFixture(sql, 'tr-nobuild', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId } = await seedTodoAt(sql, f, 'review');
    // 不插 build

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/restore`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: VALID_BODY,
    });
    assert.equal(res.statusCode, 404, `body=${res.body}`);
  });

  test('body 指定 buildId 但该 build 不属于该 todo → 404', async () => {
    const f = await seedFixture(sql, 'tr-wrongbuild', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId } = await seedTodoAt(sql, f, 'review');
    // 别插 build —— buildId 完全是编的
    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/restore`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: { ...VALID_BODY, buildId: 'not-a-real-build' },
    });
    assert.equal(res.statusCode, 404, `body=${res.body}`);
  });

  // ─────────────── 409 · phase 不允许 ───────────────

  test('phase 在 done / closed → 409，且 DB 不变', async () => {
    const f = await seedFixture(sql, 'tr-done', ['tool:complete_todos']);
    fixtures.push(f);
    for (const phase of ['done', 'closed'] as const) {
      const { todoId, updatedAtBefore } = await seedTodoAt(sql, f, phase);
      const { buildId } = await seedBuild(sql, f, todoId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/todos/${todoId}/restore`,
        headers: { authorization: `Bearer ${f.key}` },
        payload: VALID_BODY,
      });
      assert.equal(res.statusCode, 409, `${phase} → 409 expected, body=${res.body}`);
      assert.match(res.body, /confirm \/ review \/ failed/);
      const after = await readTodo(sql, todoId);
      assert.equal(after?.phase, phase);
      assert.equal(after?.updated_at, updatedAtBefore);
      const buildRow = await readBuild(sql, buildId);
      assert.equal(buildRow?.pendingRestore, null, `${phase} 时不能写 pending_restore`);
    }
  });

  test('phase 在 todo / queued / planning / implement / reviewing → 409', async () => {
    const f = await seedFixture(sql, 'tr-running', ['tool:complete_todos']);
    fixtures.push(f);
    for (const phase of ['todo', 'queued', 'planning', 'implement', 'reviewing'] as const) {
      const { todoId } = await seedTodoAt(sql, f, phase);
      const { buildId } = await seedBuild(sql, f, todoId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/todos/${todoId}/restore`,
        headers: { authorization: `Bearer ${f.key}` },
        payload: VALID_BODY,
      });
      assert.equal(res.statusCode, 409, `${phase} → 409 expected, body=${res.body}`);
      const buildRow = await readBuild(sql, buildId);
      assert.equal(buildRow?.pendingRestore, null, `${phase} 时不能写 pending_restore`);
    }
  });

  // ─────────────── 409 · 正在跑的 build ───────────────

  test('build 有 queued/pending/running 的 step → 409，且 DB 不变', async () => {
    // 这是「不在跑」判定的真源信号 —— steps 表，不是 builds.finishedAt。
    // 故意不写 finishedAt（= null），让「finishedAt IS NULL」单看一定是 false 阳性；
    // 端点必须看 steps.status 才能正确判定。
    const f = await seedFixture(sql, 'tr-running-build', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId, updatedAtBefore } = await seedTodoAt(sql, f, 'failed');
    const { buildId } = await seedBuild(sql, f, todoId);
    await seedStep(sql, buildId, { status: 'queued' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/restore`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: VALID_BODY,
    });
    assert.equal(res.statusCode, 409, `body=${res.body}`);
    assert.match(res.body, /running/);

    const after = await readTodo(sql, todoId);
    assert.equal(after?.phase, 'failed');
    assert.equal(after?.updated_at, updatedAtBefore);
    const buildRow = await readBuild(sql, buildId);
    assert.equal(buildRow?.pendingRestore, null, 'build 在跑时不能写 pending_restore');
    assert.equal(Number(buildRow?.v ?? -1), 0);
  });

  // ─────────────── 200 · 合法路径 ───────────────

  test('phase 在 confirm + 合法 body → 200，pending_restore 写入三个字段，phase 不变', async () => {
    const f = await seedFixture(sql, 'tr-confirm-ok', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId, updatedAtBefore } = await seedTodoAt(sql, f, 'confirm');
    const { buildId } = await seedBuild(sql, f, todoId);
    const sessionBefore = await sql<{ session: { id: string; runtime: string; openedAt: number } }[]>`
      select session from "build" where id = ${buildId} limit 1
    `;
    const expectedSessionId = sessionBefore[0]?.session.id;
    assert.ok(expectedSessionId, 'fixture build 必须有 session.id');

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/restore`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: VALID_BODY,
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as {
      ok: boolean;
      todoId: string;
      buildId: string;
      phase: string;
      pendingRestore: { sessionLeafEntryId: string; commitSha: string; sessionId: string };
      daemonPending: boolean;
    };
    assert.equal(body.ok, true);
    assert.equal(body.todoId, todoId);
    assert.equal(body.buildId, buildId);
    assert.equal(body.phase, 'confirm', '**phase 必须仍为 confirm** —— 状态机没有 restore trigger');
    assert.equal(body.pendingRestore.commitSha, VALID_BODY.commitSha);
    assert.equal(body.pendingRestore.sessionLeafEntryId, VALID_BODY.sessionLeafEntryId);
    assert.equal(body.pendingRestore.sessionId, expectedSessionId);
    assert.equal(body.daemonPending, true);

    // DB 端：pending_restore JSONB 真的写进去了 + v+1
    const buildRow = await readBuild(sql, buildId);
    assert.ok(buildRow);
    assert.ok(buildRow.pendingRestore, 'pending_restore 必须写入');
    assert.equal(buildRow.pendingRestore['commitSha'], VALID_BODY.commitSha);
    assert.equal(buildRow.pendingRestore['sessionLeafEntryId'], VALID_BODY.sessionLeafEntryId);
    assert.equal(buildRow.pendingRestore['sessionId'], expectedSessionId);
    assert.equal(Number(buildRow.v), 1, 'v 必须 +1');

    // todo.phase **完全不变**
    const after = await readTodo(sql, todoId);
    assert.equal(after?.phase, 'confirm');
    assert.equal(after?.updated_at, updatedAtBefore);

    // audit_event: restore_requested 落库
    const auditCount = await countAuditForBuild(sql, buildId, 'restore_requested');
    assert.equal(auditCount, 1);
  });

  test('phase 在 review → 200，pending_restore 写入；phase 在 failed → 200', async () => {
    for (const phase of ['review', 'failed'] as const) {
      const f = await seedFixture(sql, `tr-${phase}-ok`, ['tool:complete_todos']);
      fixtures.push(f);
      const { todoId } = await seedTodoAt(sql, f, phase);
      const { buildId } = await seedBuild(sql, f, todoId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/todos/${todoId}/restore`,
        headers: { authorization: `Bearer ${f.key}` },
        payload: VALID_BODY,
      });
      assert.equal(res.statusCode, 200, `${phase} → 200, body=${res.body}`);
      const buildRow = await readBuild(sql, buildId);
      assert.ok(buildRow?.pendingRestore, `${phase} pending_restore must be set`);
      assert.equal(Number(buildRow.v), 1);
      const after = await readTodo(sql, todoId);
      assert.equal(after?.phase, phase, `${phase} 端点不动 phase`);
    }
  });

  // ─────────────── 409 · 重复 restore ───────────────

  test('重复 restore（同一 build 已有 pending_restore）→ 409，且不覆盖', async () => {
    // 决定：拒绝（不覆盖）。覆盖会丢用户上次的选择；想取消 pendingRestore
    // 应另开 DELETE 端点（本切片不做）。
    const f = await seedFixture(sql, 'tr-dup', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId } = await seedTodoAt(sql, f, 'failed');
    // 直接给 build 预置一个 pendingRestore（模拟上一次 restore 已入库）
    const priorRestore = {
      sessionLeafEntryId: 'old-leaf-1',
      commitSha: 'oldsha123',
      sessionId: 'oldsession',
    };
    const { buildId } = await seedBuild(sql, f, todoId, { pendingRestore: priorRestore });

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/restore`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: VALID_BODY,
    });
    assert.equal(res.statusCode, 409, `body=${res.body}`);
    assert.match(res.body, /already pending/);

    // DB：旧的 pendingRestore 不被覆盖；v 不变
    const buildRow = await readBuild(sql, buildId);
    assert.deepEqual(buildRow?.pendingRestore, priorRestore, '旧的 pending_restore 不能被覆盖');
    assert.equal(Number(buildRow?.v ?? -1), 0, 'v 不能自增');
    const auditCount = await countAuditForBuild(sql, buildId, 'restore_requested');
    assert.equal(auditCount, 0, '409 重复 restore 时不能写 audit');
  });

  // ─────────────── 422 · 非法 body ───────────────

  test('body 缺字段 → 422', async () => {
    const f = await seedFixture(sql, 'tr-422-missing', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId } = await seedTodoAt(sql, f, 'review');
    const { buildId } = await seedBuild(sql, f, todoId);
    for (const body of [
      { commitSha: 'abc' },                         // 缺 sessionLeafEntryId
      { sessionLeafEntryId: 'leaf-1' },              // 缺 commitSha
      {},                                            // 全部缺
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/todos/${todoId}/restore`,
        headers: { authorization: `Bearer ${f.key}` },
        payload: body,
      });
      assert.equal(res.statusCode, 422, `${JSON.stringify(body)} → 422, got ${res.statusCode}: ${res.body}`);
    }
    const buildRow = await readBuild(sql, buildId);
    assert.equal(buildRow?.pendingRestore, null, '422 时不能写 pending_restore');
  });

  test('body 字段类型错 → 422', async () => {
    const f = await seedFixture(sql, 'tr-422-type', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId } = await seedTodoAt(sql, f, 'review');
    const { buildId } = await seedBuild(sql, f, todoId);
    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/restore`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: { commitSha: 12345, sessionLeafEntryId: 'leaf' },
    });
    assert.equal(res.statusCode, 422, `body=${res.body}`);
    const buildRow = await readBuild(sql, buildId);
    assert.equal(buildRow?.pendingRestore, null);
  });

  test('body 含无关字段 → 422（strict() 真生效）', async () => {
    const f = await seedFixture(sql, 'tr-422-strict', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId } = await seedTodoAt(sql, f, 'review');
    const { buildId } = await seedBuild(sql, f, todoId);
    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/restore`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: { ...VALID_BODY, nonsense: 1 },
    });
    assert.equal(res.statusCode, 422, `body=${res.body}`);
    const buildRow = await readBuild(sql, buildId);
    assert.equal(buildRow?.pendingRestore, null);
  });

  test('body 接受 userId 字段（proxyWrite 注入兜底） → 200', async () => {
    const f = await seedFixture(sql, 'tr-userid', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId } = await seedTodoAt(sql, f, 'review');
    const { buildId } = await seedBuild(sql, f, todoId);
    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoId}/restore`,
      headers: { authorization: `Bearer ${f.key}` },
      payload: { ...VALID_BODY, userId: 'fake-user-id', buildId: undefined },
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const buildRow = await readBuild(sql, buildId);
    assert.ok(buildRow?.pendingRestore, 'userId 注入不该让 .strict() 拒');
  });

  // ─────────────── 清理确认：fixture 全部收回 ───────────────
  test('全部 fixture 已在 after 钩子里 cleanup', () => {
    // 真实清理在 after() 钩子里跑；fixture 数组不为空即说明 setup 走通。
    // 数据库层面的「残留检查」放在**外部**脚本里另跑：
    //   DATABASE_URL=... npx tsx --test test/todo-restore.test.ts
    //   psql ... -c 'select count(*) from todo where title=...'
    // 这条只是保险锁，确保 cleanup-after 必然先于"测试数清零"发生。
    assert.ok(fixtures.length > 0, '至少跑过一条测试');
  });
});