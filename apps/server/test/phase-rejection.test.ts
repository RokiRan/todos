import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import * as dbPkg from '@tds/db';
import { newId, now } from '../src/ids.js';
import { generateApiKey } from '../src/crypto.js';
import { commitPhaseTransition } from '../src/services/todos.js';
import { registerTodoRoutes } from '../src/routes/todos.js';
import { registerMcpRoutes } from '../src/routes/mcp.js';

/**
 * T7 · 被拒绝的 phase 转换：定下契约并写测试（真库 + app.inject）。
 *
 * 钉死以下契约：
 *   - result.ok === false 时：
 *       - `todos.phase` 不变
 *       - `todos.updated_at` 不变（这是与「拒绝后什么都没发生」等价的数值断言）
 *       - 不发 `phase_changed`（sse_event 表里 0 条 type='phase_changed' for that todo）
 *       - 仍写一条 `phase_rejected` 审计（双轨审计不能丢）
 *   - result.ok === true 时：
 *       - 双 scope（team + todo）各有 `phase_changed` 一行
 *   - `revision_feedback`（ok:true 且 next === current）特殊路径：
 *       - 这不是「被拒」，行为不能误改 —— phase 不变，但 sse_event 仍发 phase_changed；
 *         audit 仍是 phase_changed 不是 phase_rejected
 *
 * REST 的 409 路径（`/api/todos/:todoId/complete` 在非 review 阶段）会被包到
 * `commitPhaseTransition` 之外的 409 校验挡掉；当绕过这层校验直接调
 * 服务层（用 `commitPhaseTransition`）就能直击 T7 拒收契约本身。
 *
 * MCP 路径（`complete_todos` on non-review todo）走同一服务层，行为同步覆盖。
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
    values (${newId()}, ${userId}, ${'t7-' + label}, ${k.prefix}, ${k.hash}, ${scopes}, ${ts})
  `;
  return { label, userId, teamId, projectId, memberId, agentId, key: k.key };
}

/**
 * 给定 phase 测点种一条 todo，返回 id 与**拒绝前的 updated_at** 数值。
 * 后面的契约断言就是「拒绝之后 updated_at 仍是这个值」。
 */
async function seedTodoAt(
  sql: postgres.Sql,
  f: Fixture,
  phase: 'todo' | 'confirm' | 'review' | 'implement' | 'queued',
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
      (${id}, ${f.projectId}, ${seq}, ${f.memberId}, ${f.agentId}, 'T7 todo',
       '{}', ${phase}, true, false, false, ${tsStr}, ${tsStr})
  `;
  return { todoId: id, updatedAtBefore: tsStr };
}

/** 给定 todo 的全文状态：phase / updated_at
 *  注意：postgres-js 把 bigint 默认映射成字符串 —— 这里用字符串存，避免与
 *  fixture 里的 number 比较时类型不一致。语义上二者相等即可。
 */
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
  // audit_event.todo_id 是裸 text，没有 FK。sse_event 完全没 FK。两张表都
  // 必须显式清掉，否则 deleteFixture 之后还在库里留垃圾，会污染下一次测试。
  await sql`delete from "audit_event" where team_id = ${f.teamId}`;
  await sql`delete from "sse_event" where team_id = ${f.teamId}`;
  await sql`delete from "team" where id = ${f.teamId}`;
  await sql`delete from "user" where id = ${f.userId}`;
}

async function phaseChangedCount(sql: postgres.Sql, todoId: string): Promise<number> {
  const r = await sql<{ c: number }[]>`
    select count(*)::int as c from "sse_event"
    where type = 'phase_changed' and payload->>'todoId' = ${todoId}
  `;
  return r[0]?.c ?? 0;
}

async function phaseChangedScopes(
  sql: postgres.Sql,
  todoId: string,
): Promise<string[]> {
  const r = await sql<{ scope: string }[]>`
    select distinct scope from "sse_event"
    where type = 'phase_changed' and payload->>'todoId' = ${todoId}
  `;
  return r.map((x) => x.scope).sort();
}

async function auditsForTodo(sql: postgres.Sql, todoId: string): Promise<string[]> {
  const r = await sql<{ type: string }[]>`
    select type from "audit_event"
    where todo_id = ${todoId} order by id asc
  `;
  return r.map((x) => x.type);
}

// ─────────────────────────────────────────────────────────────

describe('T7 · commitPhaseTransition 的拒绝契约', () => {
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

  test('服务层 commitPhaseTransition：reject 时 phase 与 updated_at 不动，且 audit 是 phase_rejected', async () => {
    // 用 'complete' trigger 打 'confirm' phase —— 这是状态机里
    // `gate confirm rejects complete` 的最短路径，必然 result.ok=false。
    const f = await seedFixture(sql, 't7-reject-svc', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId, updatedAtBefore } = await seedTodoAt(sql, f, 'confirm');

    const result = await commitPhaseTransition(db, {
      todoId,
      teamId: f.teamId,
      trigger: { kind: 'complete', merge: false },
      planFirst: true,
    });
    assert.equal(result.ok, false, '状态机在 confirm 拒绝 complete，必须 ok=false');
    assert.equal(result.next, 'confirm');

    // ① phase 不变
    const after = await readTodo(sql, todoId);
    assert.ok(after, 'todo 应当仍在库里（拒绝不能删 todo）');
    assert.equal(after.phase, 'confirm', 'phase 必须保持 confirm');
    assert.equal(
      after.updated_at, updatedAtBefore,
      `updated_at 必须保持拒绝前的值 (${updatedAtBefore})；拒绝是「什么都没发生」`,
    );

    // ② phase_changed SSE 一行都不能有
    const sseCount = await phaseChangedCount(sql, todoId);
    assert.equal(sseCount, 0, '拒绝时严禁发 phase_changed SSE（库里 + 推送 + 详情页都得静默）');

    // ③ phase_rejected 审计必须存在
    const audits = await auditsForTodo(sql, todoId);
    assert.deepEqual(
      audits.filter((t) => t.startsWith('phase_')),
      ['phase_rejected'],
      `phase_* 类审计必须只剩 phase_rejected；实际：${audits.join(',')}`,
    );
  });

  test('服务层 commitPhaseTransition：accept 时 phase 真推进，双 scope phase_changed + audit phase_changed', async () => {
    const f = await seedFixture(sql, 't7-accept-svc', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId } = await seedTodoAt(sql, f, 'review');

    const result = await commitPhaseTransition(db, {
      todoId,
      teamId: f.teamId,
      trigger: { kind: 'complete', merge: false },
      planFirst: true,
    });
    assert.equal(result.ok, true, 'complete(review) 必须被接');
    assert.equal(result.next, 'done');

    // ① phase 推进
    const after = await readTodo(sql, todoId);
    assert.ok(after);
    assert.equal(after.phase, 'done');

    // ② 双 scope 都必须 phase_changed
    const scopes = await phaseChangedScopes(sql, todoId);
    assert.deepEqual(scopes, [`team:${f.teamId}`, `todo:${todoId}`].sort());

    // ③ audit 是 phase_changed 不是 phase_rejected
    const audits = await auditsForTodo(sql, todoId);
    assert.deepEqual(audits.filter((t) => t.startsWith('phase_')), ['phase_changed']);
  });

  test('服务层 commitPhaseTransition：revision_feedback (ok:true, next===current) 不是拒绝，不被新分支误改', async () => {
    const f = await seedFixture(sql, 't7-revision-svc', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId, updatedAtBefore } = await seedTodoAt(sql, f, 'confirm');

    // 给该 todo 种一条 build —— revision_feedback 在 services/todos.ts 里只在有
    // active build 时写 input document。直接调 commitPhaseTransition 不带 build
    // 会让文档分支被跳过，但审计 / phase_changed 仍按 ok:true 走。新事务的覆盖
    // 测试只保证「不被误改」，因此这里也给一个 build 把文档路径也覆盖到。
    const buildId = newId();
    const sessionJson = JSON.stringify({ runtime: 'claude-code', id: 's', openedAt: Number(updatedAtBefore) });
    await sql`
      insert into "build"
        (id, todo_id, n, branch, trigger_source, with_plan, with_checklist, agent_id,
         session, usage_by_model, created_at, v)
      values
        (${buildId}, ${todoId}, 1, ${'tds/conv-' + buildId}, 'manual', false, false, ${f.agentId},
         ${sessionJson}::jsonb, '[]'::jsonb, ${updatedAtBefore}, 0)
    `;

    const result = await commitPhaseTransition(db, {
      todoId,
      teamId: f.teamId,
      trigger: { kind: 'revision_feedback' },
      planFirst: true,
      revisionFeedback: { message: '请在第 3 段加风险说明' },
    });
    // 关键：revision_feedback on gate 是 { ok:true, next: current, dispatch: true }
    assert.equal(result.ok, true, 'revision_feedback 必须被闸门接受（ok:true）');
    assert.equal(result.next, 'confirm', 'feedback 永远停在同闸门');
    assert.equal(result.dispatch, true, 'revision 必须 dispatch 一轮');

    // 接受路径：phase 不变（产品铁律）但 update_at 必须变（一次成功调用）
    const after = await readTodo(sql, todoId);
    assert.ok(after);
    assert.equal(after.phase, 'confirm', 'feedback 不动 phase');
    assert.notEqual(
      after.updated_at, updatedAtBefore,
      `acceptance 也必须刷 updated_at；当前 after.updated_at=${after.updated_at} before=${updatedAtBefore}`,
    );

    // 双 scope phase_changed
    const scopes = await phaseChangedScopes(sql, todoId);
    assert.deepEqual(scopes, [`team:${f.teamId}`, `todo:${todoId}`].sort());
    // audit 是 phase_changed（不是 phase_rejected）
    const audits = await auditsForTodo(sql, todoId);
    assert.deepEqual(audits.filter((t) => t.startsWith('phase_')), ['phase_changed']);

    // 额外：input document 必须落库（确保 revision_feedback 路径仍能写文档）
    const docs = await sql<{ c: number }[]>`
      select count(*)::int as c from "document"
      inner join "build" on document.build_id = build.id
      where build.todo_id = ${todoId} and document.kind = 'input'
    `;
    assert.ok((docs[0]?.c ?? 0) >= 1, 'revision_feedback 必须留 input 文档（不能被事务吞）');
  });

  test('服务层 commitPhaseTransition：todo 不存在时抛 404，与 ok:false 完全无关（不与被拒分支混淆）', async () => {
    const f = await seedFixture(sql, 't7-missing-svc', ['tool:complete_todos']);
    fixtures.push(f);

    let threw = false;
    try {
      await commitPhaseTransition(db, {
        todoId: 'definitely-not-a-real-todo',
        teamId: f.teamId,
        trigger: { kind: 'complete', merge: false },
        planFirst: true,
      });
    } catch (err) {
      threw = true;
      assert.ok(err instanceof Error);
      assert.match(err.message, /disappeared before transition|not found/);
    }
    assert.ok(threw, 'todo 不存在必须抛 HttpError（404）');
  });

  test('REST 409 路径：POST /api/todos/:id/complete 在非 review 上拒（不进 transition）', async () => {
    // 该路径在路由层就有 phase === 'review' 的 409 前置挡掉；这条测锁「拒绝
    // 不进 transition」这个**路由层**的语义（与 T7 服务层契约并行存在）。
    const f = await seedFixture(sql, 't7-rest-pre-409', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId, updatedAtBefore } = await seedTodoAt(sql, f, 'confirm');

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/todos/${todoId}/complete`,
      payload: { merge: false },
    });
    assert.equal(res.statusCode, 409, `body=${res.body}`);
    assert.match(res.body, /complete is only valid at review/);

    const after = await readTodo(sql, todoId);
    assert.ok(after);
    assert.equal(after.phase, 'confirm');
    assert.equal(after.updated_at, updatedAtBefore, '路由层 409 也不允许刷 updated_at');
  });

  test('REST 通过闸门但被 transition 拒绝：complete 在 review 但 merge=false 时走 ok:true（证明非误改）', async () => {
    // 与上一条对应；这里锁定 review+complete 走 ok:true 后：
    //  - phase 推进（done）
    //  - 双 scope phase_changed
    //  - audit phase_changed
    const f = await seedFixture(sql, 't7-rest-accept', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId } = await seedTodoAt(sql, f, 'review');

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/todos/${todoId}/complete`,
      payload: { merge: false },
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as { ok: boolean; phase: string };
    assert.equal(body.ok, true);
    assert.equal(body.phase, 'done');

    const scopes = await phaseChangedScopes(sql, todoId);
    assert.deepEqual(scopes, [`team:${f.teamId}`, `todo:${todoId}`].sort());
  });

  test('REST approve 在 confirm 上：ok=true 时双 scope phase_changed', async () => {
    const f = await seedFixture(sql, 't7-rest-approve', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId } = await seedTodoAt(sql, f, 'confirm');

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/todos/${todoId}/approve`,
      payload: { by: 'user' },
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);

    const after = await readTodo(sql, todoId);
    assert.equal(after?.phase, 'implement');
    const scopes = await phaseChangedScopes(sql, todoId);
    assert.deepEqual(scopes, [`team:${f.teamId}`, `todo:${todoId}`].sort());
    const audits = await auditsForTodo(sql, todoId);
    assert.deepEqual(audits.filter((t) => t.startsWith('phase_')), ['phase_changed']);
  });

  test('REST feedback 在 confirm：接受（revision_feedback）；phase 不动但双 scope phase_changed + audit phase_changed', async () => {
    const f = await seedFixture(sql, 't7-rest-feedback', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId, updatedAtBefore } = await seedTodoAt(sql, f, 'confirm');

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/todos/${todoId}/feedback`,
      payload: { message: '计划写得太简略' },
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as { ok: boolean; phase: string; advanced: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.phase, 'confirm', 'feedback 永远停在同闸门');
    assert.equal(body.advanced, false);

    const after = await readTodo(sql, todoId);
    assert.equal(after?.phase, 'confirm');
    assert.notEqual(after?.updated_at, updatedAtBefore, 'feedback 是接受路径 → 必须刷 updated_at');

    const scopes = await phaseChangedScopes(sql, todoId);
    assert.deepEqual(scopes, [`team:${f.teamId}`, `todo:${todoId}`].sort());
    const audits = await auditsForTodo(sql, todoId);
    assert.deepEqual(audits.filter((t) => t.startsWith('phase_')), ['phase_changed']);
  });

  test('MCP complete_todos 在非 review todo 上走服务层 ok:false：phase 不变、双 sse 都 0、audit phase_rejected', async () => {
    const f = await seedFixture(sql, 't7-mcp-reject', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId, updatedAtBefore } = await seedTodoAt(sql, f, 'confirm');

    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp',
      headers: { authorization: `Bearer ${f.key}` },
      payload: {
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'complete_todos', arguments: { todoIds: [todoId] } },
      },
    });
    assert.equal(res.statusCode, 200);
    const reply = JSON.parse(res.body) as {
      result?: { isError?: boolean; content?: Array<{ type: string; text: string }> };
    };
    assert.equal(reply.result?.isError, undefined, 'MCP 服务层拒绝不是 tool error');
    const parsed = JSON.parse(reply.result?.content?.[0]?.text ?? '{}') as {
      results: Array<{ todoId: string; ok: boolean; phase?: string; reason?: string }>;
      succeeded: number;
      failed: number;
    };
    const item = parsed.results.find((r) => r.todoId === todoId);
    assert.ok(item, '该 todoId 必须在结果数组中');
    assert.equal(item.ok, false, 'MCP 必须如实回 ok:false（不静默吞掉）');
    assert.equal(parsed.succeeded, 0);
    assert.equal(parsed.failed, 1);

    // T7 契约的 DB 验证
    const after = await readTodo(sql, todoId);
    assert.ok(after);
    assert.equal(after.phase, 'confirm');
    assert.equal(after.updated_at, updatedAtBefore, '拒绝必须 = 什么都没发生 → updated_at 静止');

    const sseCount = await phaseChangedCount(sql, todoId);
    assert.equal(sseCount, 0, '拒绝时 SSE 表里没有 phase_changed');

    const audits = await auditsForTodo(sql, todoId);
    assert.deepEqual(audits.filter((t) => t.startsWith('phase_')), ['phase_rejected']);
  });

  test('MCP complete_todos 在 review 上接受：phase → done，双 scope phase_changed，audit phase_changed', async () => {
    const f = await seedFixture(sql, 't7-mcp-accept', ['tool:complete_todos']);
    fixtures.push(f);
    const { todoId } = await seedTodoAt(sql, f, 'review');

    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp',
      headers: { authorization: `Bearer ${f.key}` },
      payload: {
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'complete_todos', arguments: { todoIds: [todoId] } },
      },
    });
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(
      (JSON.parse(res.body) as { result: { content: Array<{ text: string }> } })
        .result.content[0]?.text ?? '{}',
    ) as { succeeded: number; failed: number; results: Array<{ ok: boolean }> };
    assert.equal(parsed.succeeded, 1);
    assert.equal(parsed.results[0]?.ok, true);

    const after = await readTodo(sql, todoId);
    assert.equal(after?.phase, 'done');
    const scopes = await phaseChangedScopes(sql, todoId);
    assert.deepEqual(scopes, [`team:${f.teamId}`, `todo:${todoId}`].sort());
    const audits = await auditsForTodo(sql, todoId);
    assert.deepEqual(audits.filter((t) => t.startsWith('phase_')), ['phase_changed']);
  });
});
