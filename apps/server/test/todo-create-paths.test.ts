import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import * as dbPkg from '@tds/db';
import { newId, now } from '../src/ids.js';
import { generateApiKey } from '../src/crypto.js';
import { createTodo, countOpenTodos, SPEC_MAX_CHARS } from '../src/services/todos.js';
import { registerTodoRoutes } from '../src/routes/todos.js';
import { registerChiefRoutes } from '../src/routes/chief.js';
import { registerMcpRoutes } from '../src/routes/mcp.js';

/**
 * T6 收敛到服务层的端到端测试 —— 真 HTTP + 真数据库（`app.inject` + postgres-js）。
 *
 * 关键契约：
 *   - REST (POST /api/todos) / Chief (POST /api/chief/threads/.../dispatch)
 *     / MCP (tools/call create_todo) 三条创建路径**全部**走 `services/todos.ts`
 *     的 `createTodo` 函数，因此 seq 分配原子（`UPDATE … RETURNING`），
 *     可观察副作用（todo_created 审计 + team-scope SSE）对三条路径**全部**存在。
 *   - 第一条 todo 在新项目里 seq_num = 1；多条并发 `createTodo` 调用不会撞
 *     `(project_id, seq_num)` 唯一约束。
 *   - 拒绝路径（Free 档 openTodos / spec 超 800）必须查库确认**没有半截**
 *     todo / build / step 落库。
 *
 * 拒绝硬规则（项目铁律）：每一处创建失败 / 配额超限 / spec 超长的测试都必须
 * 用 SQL 显式查一次 `todo` (与 `audit_event`) 行数；只断言 HTTP 返回值不算
 * 证明（bug 曾经在返回值正确但半截入库的形态上漂过来）。
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
  opts: { scopes?: string[] } = {},
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
    insert into "api_key"
      (id, user_id, name, key_prefix, key_hash, scopes, created_at)
    values (${newId()}, ${userId}, ${'t6-' + label}, ${k.prefix}, ${k.hash},
            ${opts.scopes ?? ['tool:create_todo']}, ${ts})
  `;
  return { label, userId, teamId, projectId, memberId, agentId, key: k.key };
}

async function seedThreadForChief(
  sql: postgres.Sql,
  f: Fixture,
): Promise<string> {
  const ts = now();
  const chiefId = `chief-${f.userId}-${f.teamId}`;
  await sql`
    insert into "chief" (id, user_id, team_id, agent_id, charter, created_at, updated_at)
    values (${chiefId}, ${f.userId}, ${f.teamId}, ${f.agentId}, 't6 chief', ${ts}, ${ts})
    on conflict (id) do nothing
  `;
  const threadId = newId();
  const sessionJson = JSON.stringify({ runtime: 'claude-code', id: 's', openedAt: ts });
  await sql`
    insert into "chief_thread"
      (id, chief_id, title, session, tool_def_hashes, watched_todos, created_at, updated_at)
    values (${threadId}, ${chiefId}, 't6 topic', ${sessionJson}::jsonb, '{}'::jsonb, '{}', ${ts}, ${ts})
  `;
  return threadId;
}

async function deleteFixture(sql: postgres.Sql, f: Fixture): Promise<void> {
  // 注意：sse_event 没有 FK，必须显式种；audit_event.todo_id 也是裸 text。
  await sql`delete from "sse_event" where team_id = ${f.teamId}`;
  await sql`delete from "audit_event" where team_id = ${f.teamId}`;
  await sql`delete from "team" where id = ${f.teamId}`;
  await sql`delete from "user" where id = ${f.userId}`;
}

/** 该项目的 todo + audit + sse_event 行数。拒绝路径必须保持 0。 */
async function projectFootprint(
  sql: postgres.Sql,
  projectId: string,
  teamId: string,
): Promise<{ todos: number; audits: number; sse: number }> {
  const todos = (await sql<{ c: number }[]>`
    select count(*)::int as c from "todo" where project_id = ${projectId}
  `)[0]?.c ?? 0;
  const audits = (await sql<{ c: number }[]>`
    select count(*)::int as c from "audit_event"
    where team_id = ${teamId} and type = 'todo_created'
  `)[0]?.c ?? 0;
  const sse = (await sql<{ c: number }[]>`
    select count(*)::int as c from "sse_event"
    where team_id = ${teamId} and type = 'todo_created'
  `)[0]?.c ?? 0;
  return { todos, audits, sse };
}

/** 项目中所有 todo 的 seq_num 数组，用来验证原子 + 唯一。 */
async function projectSeqNums(
  sql: postgres.Sql,
  projectId: string,
): Promise<number[]> {
  const rows = await sql<{ seq_num: number }[]>`
    select seq_num from "todo" where project_id = ${projectId} order by seq_num asc
  `;
  return rows.map((r) => r.seq_num);
}

// ─────────────────────────────────────────────────────────────────────

describe('T6 · 三条 todo 创建路径收敛到 services/todos.ts createTodo', () => {
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
    registerChiefRoutes(app, db as never);
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

  test('REST POST /api/todos：第一条 todo 的 seq_num = 1', async () => {
    const f = await seedFixture(sql, 't6-first-rest');
    fixtures.push(f);
    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: '/api/todos',
      payload: {
        teamId: f.teamId, projectId: f.projectId, ownerMemberId: f.memberId,
        agentId: f.agentId, title: '首条', spec: null, tagIds: [],
        planFirst: true,
      },
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as { id: string; seqNum: number };
    assert.equal(body.seqNum, 1, '新项目第一条 todo 必须 seq_num = 1');

    const seqs = await projectSeqNums(sql, f.projectId);
    assert.deepEqual(seqs, [1]);
    const footprint = await projectFootprint(sql, f.projectId, f.teamId);
    assert.equal(footprint.todos, 1);
    assert.equal(footprint.audits, 1, 'todo_created 审计已落库');
    assert.equal(footprint.sse, 1, 'team scope 的 todo_created SSE 已落库');
  });

  test('服务层 createTodo：第一条 todo 的 seq_num = 1（与 REST 一致）', async () => {
    const f = await seedFixture(sql, 't6-first-service');
    fixtures.push(f);
    const created = await createTodo(db, {
      teamId: f.teamId,
      projectId: f.projectId,
      ownerMemberId: f.memberId,
      agentId: f.agentId,
      title: '服务层首条',
      spec: null,
      tagIds: [],
      planFirst: true,
      separatePlanBuild: false,
      withChecklist: false,
    });
    assert.equal(created.seqNum, 1);
    const seqs = await projectSeqNums(sql, f.projectId);
    assert.deepEqual(seqs, [1]);
    const footprint = await projectFootprint(sql, f.projectId, f.teamId);
    assert.equal(footprint.todos, 1);
    assert.equal(footprint.audits, 1);
    assert.equal(footprint.sse, 1);
  });

  test('MCP 后 REST：两条不同路径的 seq 互不撞唯一约束（顺序）', async () => {
    const f = await seedFixture(sql, 't6-mcp-then-rest', {
      scopes: ['tool:create_todo'],
    });
    fixtures.push(f);

    // 1. MCP create_todo
    const mcpRes = await app.inject({
      method: 'POST',
      url: '/api/mcp',
      headers: { authorization: `Bearer ${f.key}` },
      payload: {
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: {
          name: 'create_todo',
          arguments: {
            teamId: f.teamId, projectId: f.projectId, title: 'MCP 第一条',
          },
        },
      },
    });
    const mcpBody = JSON.parse(mcpRes.body) as {
      result?: { isError?: boolean; content?: Array<{ type: string; text: string }> };
    };
    assert.equal(mcpBody.result?.isError, undefined, 'MCP create_todo 必须成功');
    const mcpJson = JSON.parse(mcpBody.result?.content?.[0]?.text ?? '{}') as {
      todoId: string; seqNum: number;
    };
    assert.equal(mcpJson.seqNum, 1);

    // 2. REST POST /api/todos
    const restRes = await app.inject({
                            headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: '/api/todos',
      payload: {
        teamId: f.teamId, projectId: f.projectId, ownerMemberId: f.memberId,
        agentId: f.agentId, title: 'REST 第二条', spec: null, tagIds: [],
        planFirst: true,
      },
    });
    assert.equal(restRes.statusCode, 200);
    const restBody = JSON.parse(restRes.body) as { id: string; seqNum: number };
    assert.equal(restBody.seqNum, 2, 'MCP 用 1 号后 REST 必须拿 2 号');

    const seqs = await projectSeqNums(sql, f.projectId);
    assert.deepEqual(seqs, [1, 2]);
    const footprint = await projectFootprint(sql, f.projectId, f.teamId);
    assert.equal(footprint.todos, 2);
    assert.equal(footprint.audits, 2, '每条 todo 都有 todo_created 审计');
    assert.equal(footprint.sse, 2, '每条 todo 都有 team-scope todo_created SSE');
  });

  test('REST + REST 真并发：两条同时段 createTodo 不撞 seq 唯一约束', async () => {
    const f = await seedFixture(sql, 't6-concurrent-rest');
    fixtures.push(f);

    // 两个 app.inject 同时发出。两条都成功时 seq 必须唯一。
    const r1 = app.inject({
                 headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: '/api/todos',
      payload: {
        teamId: f.teamId, projectId: f.projectId, ownerMemberId: f.memberId,
        agentId: f.agentId, title: '并发 A', spec: null, tagIds: [],
        planFirst: true,
      },
    });
    const r2 = app.inject({
                 headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: '/api/todos',
      payload: {
        teamId: f.teamId, projectId: f.projectId, ownerMemberId: f.memberId,
        agentId: f.agentId, title: '并发 B', spec: 'desc', tagIds: [],
        planFirst: true,
      },
    });
    const [a, b] = await Promise.all([r1, r2]);
    const aBody = JSON.parse(a.body) as { id: string; seqNum: number };
    const bBody = JSON.parse(b.body) as { id: string; seqNum: number };
    if (a.statusCode === 200 && b.statusCode === 200) {
      assert.notEqual(aBody.seqNum, bBody.seqNum, '成功的两条 seq 必须不同');
      const seqs = (await projectSeqNums(sql, f.projectId)).sort((x, y) => x - y);
      assert.deepEqual(seqs, [1, 2], '原子分配 → 两条连号');
    } else {
      // 即便其中一条最终失败，也不能撞 `(project_id, seq_num)` 唯一约束
      // （即不能 500）。允许 422 但禁止 500。
      const bad = [a, b].filter((r) => r.statusCode === 500);
      assert.equal(bad.length, 0, '并发时不能撞 unique 约束变 500');
    }
  });

  test('服务层 createTodo 真并发：两条平行的 Promise.all 不撞唯一约束', async () => {
    const f = await seedFixture(sql, 't6-concurrent-service');
    fixtures.push(f);

    // 用同一个 db 句柄并行两条 createTodo —— 测的是「seq 原子性」本身，
    // 不绑定到任何特定 HTTP 路径。
    const results = await Promise.allSettled([
      createTodo(db, {
        teamId: f.teamId, projectId: f.projectId, ownerMemberId: f.memberId,
        agentId: f.agentId, title: '并发 S-A', spec: null, tagIds: [],
        planFirst: true, separatePlanBuild: false, withChecklist: false,
      }),
      createTodo(db, {
        teamId: f.teamId, projectId: f.projectId, ownerMemberId: f.memberId,
        agentId: f.agentId, title: '并发 S-B', spec: null, tagIds: [],
        planFirst: true, separatePlanBuild: false, withChecklist: false,
      }),
    ]);
    const oks = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r) => r.status === 'rejected');
    assert.equal(bad.length, 0, '两条 createTodo 都应该成功 —— 不得因 seq 撞唯一而抛错');
    assert.equal(oks.length, 2);
    const seqs = (await projectSeqNums(sql, f.projectId)).sort((x, y) => x - y);
    assert.deepEqual(seqs, [1, 2], '原子分配 → 两条连号 1/2');
  });

  test('REST + 服务层 createTodo：两条混路径同样分配 1/2', async () => {
    const f = await seedFixture(sql, 't6-rest-service-mix');
    fixtures.push(f);

    const httpPromise = app.inject({
                          headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: '/api/todos',
      payload: {
        teamId: f.teamId, projectId: f.projectId, ownerMemberId: f.memberId,
        agentId: f.agentId, title: 'HTTP 一条', spec: null, tagIds: [],
        planFirst: true,
      },
    });
    const dbPromise = createTodo(db, {
      teamId: f.teamId, projectId: f.projectId, ownerMemberId: f.memberId,
      agentId: f.agentId, title: 'service 一条', spec: null, tagIds: [],
      planFirst: true, separatePlanBuild: false, withChecklist: false,
    });
    const [httpRes, dbRes] = await Promise.all([httpPromise, dbPromise]);
    assert.equal(httpRes.statusCode, 200, `body=${httpRes.body}`);
    const seqs = (await projectSeqNums(sql, f.projectId)).sort((x, y) => x - y);
    assert.deepEqual(seqs, [1, 2], 'HTTP + service 两条也得原子分配 1/2');
    assert.equal(dbRes.seqNum >= 1, true);
  });

  test('MCP + 服务层 createTodo：MCP 用 1 号后 service 拿 2 号（验证 createTodo 可独立再走）', async () => {
    const f = await seedFixture(sql, 't6-mcp-service', { scopes: ['tool:create_todo'] });
    fixtures.push(f);

    const mcpRes = await app.inject({
      method: 'POST',
      url: '/api/mcp',
      headers: { authorization: `Bearer ${f.key}` },
      payload: {
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: {
          name: 'create_todo',
          arguments: { teamId: f.teamId, projectId: f.projectId, title: 'mcp' },
        },
      },
    });
    assert.equal(mcpRes.statusCode, 200);
    const mcpJson = JSON.parse(
      (JSON.parse(mcpRes.body) as { result: { content: Array<{ text: string }> } })
        .result.content[0]?.text ?? '{}',
    ) as { seqNum: number };
    assert.equal(mcpJson.seqNum, 1);

    const dbRes = await createTodo(db, {
      teamId: f.teamId, projectId: f.projectId, ownerMemberId: f.memberId,
      agentId: f.agentId, title: 'svc-2', spec: null, tagIds: [],
      planFirst: true, separatePlanBuild: false, withChecklist: false,
    });
    assert.equal(dbRes.seqNum, 2);
    const seqs = await projectSeqNums(sql, f.projectId);
    assert.deepEqual(seqs, [1, 2]);
  });

  test('REST POST 配 SPEC_MAX_CHARS = 800：801 字符拒绝时无 todo / 审计 / SSE 落库', async () => {
    const f = await seedFixture(sql, 't6-rest-spec-cap');
    fixtures.push(f);

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: '/api/todos',
      payload: {
        teamId: f.teamId, projectId: f.projectId, ownerMemberId: f.memberId,
        agentId: f.agentId, title: 'spec 太长', spec: 'x'.repeat(SPEC_MAX_CHARS + 1),
        tagIds: [], planFirst: true,
      },
    });
    assert.equal(res.statusCode, 422, `body=${res.body}`);
    const footprint = await projectFootprint(sql, f.projectId, f.teamId);
    assert.equal(footprint.todos, 0, '拒绝时严禁留 todo');
    assert.equal(footprint.audits, 0, '拒绝时严禁 todo_created 审计');
    assert.equal(footprint.sse, 0, '拒绝时严禁 todo_created SSE');
  });

  test('服务层 createTodo：跨团队写入抛 403，无任何半截落库', async () => {
    // 两个 team：让 project 在 teamA，但传入 teamB 的 teamId。
    const a = await seedFixture(sql, 't6-cross-team-a');
    const b = await seedFixture(sql, 't6-cross-team-b');
    fixtures.push(a, b);

    let threw = false;
    try {
      await createTodo(db, {
        teamId: b.teamId,
        projectId: a.projectId,
        ownerMemberId: a.memberId,
        agentId: a.agentId,
        title: '越权',
        spec: null,
        tagIds: [],
        planFirst: true, separatePlanBuild: false, withChecklist: false,
      });
    } catch (err) {
      threw = true;
      assert.ok(err instanceof Error);
      assert.match(err.message, /different team/i);
    }
    assert.ok(threw, '跨团队必须抛错（403 / HttpError）');

    // a 与 b 都不能有 todo_created 审计或 todo 行
    for (const proj of [{ pid: a.projectId, tid: a.teamId }, { pid: b.projectId, tid: b.teamId }]) {
      const fp = await projectFootprint(sql, proj.pid, proj.tid);
      assert.equal(fp.todos, 0, `团队 ${proj.tid} 项目 ${proj.pid} 无 todo`);
      assert.equal(fp.audits, 0, `团队 ${proj.tid} 项目 ${proj.pid} 无 todo_created 审计`);
      assert.equal(fp.sse, 0, `团队 ${proj.tid} 项目 ${proj.pid} 无 todo_created SSE`);
    }
  });

  test('Chief POST /api/chief/threads/:threadId/dispatch：派工也走 service createTodo（无机器场景下的 queued）', async () => {
    const f = await seedFixture(sql, 't6-chief-dispatch');
    fixtures.push(f);
    const threadId = await seedThreadForChief(sql, f);

    const dis = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/chief/threads/${threadId}/dispatch`,
      payload: {
        teamId: f.teamId, projectId: f.projectId, ownerMemberId: f.memberId,
        agentId: f.agentId, title: 'chief 派的第一条', spec: null,
      },
    });
    assert.equal(dis.statusCode, 200, `body=${dis.body}`);
    const d = JSON.parse(dis.body) as { todoId: string; buildId: string; phase: string };
    assert.equal(d.phase, 'queued', '无机器时落地 queued');

    // 服务层副作用 + Chief 的额外审计 / SSE 全部到位
    const todoRows = await sql<{ seq_num: number }[]>`
      select seq_num from "todo" where project_id = ${f.projectId}
    `;
    assert.equal(todoRows.length, 1, 'Chief 派工也必须建出 1 条 todo');
    assert.equal(todoRows[0]?.seq_num, 1, '走 service createTodo 后第一条 seq_num = 1');

    const serviceAudits = await sql<{ c: number }[]>`
      select count(*)::int as c from "audit_event"
      where team_id = ${f.teamId} and type = 'todo_created'
    `;
    assert.equal(serviceAudits[0]?.c, 1, 'createTodo 的 todo_created 审计在场');

    const dispatchedAudits = await sql<{ c: number }[]>`
      select count(*)::int as c from "audit_event"
      where team_id = ${f.teamId} and type = 'dispatched'
    `;
    assert.equal(dispatchedAudits[0]?.c, 1, 'Chief 额外的 dispatched 审计在场');

    const sseScopes = await sql<{ scope: string; type: string }[]>`
      select scope, type from "sse_event"
      where team_id = ${f.teamId} order by seq asc
    `;
    const teamScopeCreated = sseScopes.some((s) => s.type === 'todo_created' && s.scope === `team:${f.teamId}`);
    const teamDispatched = sseScopes.some((s) => s.type === 'dispatched' && s.scope === `team:${f.teamId}`);
    const todoDispatched = sseScopes.some((s) => s.type === 'dispatched' && s.scope === `todo:${d.todoId}`);
    assert.ok(teamScopeCreated, 'team scope 必有一条 todo_created（SSE）');
    assert.ok(teamDispatched, 'T5.a：team scope 必有一条 dispatched');
    assert.ok(todoDispatched, 'T5.a：todo scope 必有一条 dispatched');
    // team_id 不再是空字符串
    const sseTeamIds = await sql<{ team_id: string }[]>`
      select distinct team_id from "sse_event" where team_id = ${f.teamId}
    `;
    assert.equal(sseTeamIds.length, 1, 'sse_event 的 team_id 必须真等于 teamId，绝不为空字符串');
  });

  test('Chief POST dispatch：spec 801 字符拒绝（zod SPEC_MAX_CHARS 兜底）', async () => {
    const f = await seedFixture(sql, 't6-chief-spec-cap');
    fixtures.push(f);
    const threadId = await seedThreadForChief(sql, f);

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/chief/threads/${threadId}/dispatch`,
      payload: {
        teamId: f.teamId, projectId: f.projectId, ownerMemberId: f.memberId,
        agentId: f.agentId, title: 'chief 派的长 spec', spec: 'y'.repeat(SPEC_MAX_CHARS + 1),
      },
    });
    assert.equal(res.statusCode, 422, `body=${res.body}`);
    const footprint = await projectFootprint(sql, f.projectId, f.teamId);
    assert.equal(footprint.todos, 0);
    assert.equal(footprint.audits, 0);
    assert.equal(footprint.sse, 0);

    const builds = await sql<{ c: number }[]>`
      select count(*)::int as c from "build"
        inner join "todo" on build.todo_id = todo.id
        where todo.project_id = ${f.projectId}
    `;
    assert.equal(builds[0]?.c, 0, 'spec 拒了之后 build 也不能落库');
  });

  test('Chief POST dispatch：spec 刚好 800 通过（与 REST / MCP 同一上限）', async () => {
    const f = await seedFixture(sql, 't6-chief-spec-edge');
    fixtures.push(f);
    const threadId = await seedThreadForChief(sql, f);
    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/chief/threads/${threadId}/dispatch`,
      payload: {
        teamId: f.teamId, projectId: f.projectId, ownerMemberId: f.memberId,
        agentId: f.agentId, title: 'chief 派的刚好 800', spec: 'a'.repeat(SPEC_MAX_CHARS),
      },
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const d = JSON.parse(res.body) as { todoId: string };
    const stored = await sql<{ spec_len: number }[]>`
      select length(spec)::int as spec_len from "todo" where id = ${d.todoId}
    `;
    assert.equal(stored[0]?.spec_len, SPEC_MAX_CHARS, '800 字符必须原样落库，不许被截断');
  });

  test('Chief POST dispatch：超 400 open todo 时被配额拒，且库内无半截', async () => {
    const f = await seedFixture(sql, 't6-chief-quota');
    fixtures.push(f);
    const threadId = await seedThreadForChief(sql, f);

    // 灌满 400 条 open todo（计数：services/todos.ts 的 countOpenTodos
    // 只排除 done / failed / closed，故新建的 'todo' 仍算 open）
    const ts = now();
    await sql`
      insert into "todo"
        (id, project_id, seq_num, owner_member_id, title, tag_ids, phase,
         plan_first, separate_plan_build, with_checklist, created_at, updated_at)
      select md5(${f.projectId} || gs::text), ${f.projectId}, gs, ${f.memberId},
        'bulk open todo', '{}', 'todo', true, false, false, ${ts}, ${ts}
      from generate_series(1, 400) gs
    `;
    // 推计数器
    await sql`update "project" set next_seq_num = greatest(next_seq_num, 401)
              where id = ${f.projectId}`;

    const openCount = await countOpenTodos(db, f.projectId);
    assert.equal(openCount, 400);

    // 派工 = 第 401 条，命中 openTodosPerProject 上限
    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/chief/threads/${threadId}/dispatch`,
      payload: {
        teamId: f.teamId, projectId: f.projectId, ownerMemberId: f.memberId,
        agentId: f.agentId, title: '溢出的第 401 条', spec: null,
      },
    });
    assert.equal(res.statusCode, 422, `body=${res.body}`);
    assert.match(res.body, /Free 上限|openTodos|quota/i);

    // 库内仍是 400 条（被拒的那一条没落库）
    const todos = await sql<{ c: number }[]>`
      select count(*)::int as c from "todo" where project_id = ${f.projectId}
    `;
    assert.equal(todos[0]?.c, 400, '配额拒绝时 401 条严禁入库');
  });

  test('REST 配 SPEC_MAX_CHARS = 800：800 字符刚好通过', async () => {
    const f = await seedFixture(sql, 't6-rest-spec-edge');
    fixtures.push(f);
    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: '/api/todos',
      payload: {
        teamId: f.teamId, projectId: f.projectId, ownerMemberId: f.memberId,
        agentId: f.agentId, title: '刚好 800', spec: 'a'.repeat(SPEC_MAX_CHARS),
        tagIds: [], planFirst: true,
      },
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as { seqNum: number };
    assert.equal(body.seqNum, 1);
  });
});
