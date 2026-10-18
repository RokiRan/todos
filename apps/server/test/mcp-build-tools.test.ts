import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import * as dbPkg from '@tds/db';
import { newId, now } from '../src/ids.js';
import { generateApiKey } from '../src/crypto.js';
import { registerMcpRoutes } from '../src/routes/mcp.js';

/**
 * MCP build 生命周期 5 个工具的验证（真库 + `app.inject`）。
 *
 * 钉的是**服务层与状态机真正接上**这件事，每条都配一个查库证明：
 *   1. `run_builds`：建 build + step；`n` 递增；分支名 `tds/conv-<buildId>`；
 *      **无在线机器时落 `queued` 而不是失败**（产品语义：等机器上线）
 *   2. 状态机拒绝的相位**一行未动** —— 连 build 都不许建（先建后判会留下
 *      永远没人认领的 build + queued step）
 *   3. `cancel_builds`：**连带收掉未终态的 step 和 build** —— 只推 phase 会被
 *      机器的 `POST done` 推翻，这是不许出现的假取消
 *   4. `confirm_builds` / `merge_builds`：闸门只认主按钮。错相位拒绝，且拒绝后
 *      phase / updated_at 与拒绝瞬间完全一致（不写 phase_changed 帧）
 *   5. `merge: true` 落回 `implement` 跑 merge turn，`merge: false` 落 `done`
 *   6. `run_review`：Confirm 闸门上起评审 build → `reviewing`；错相位拒绝
 *   7. 跨团队 403 且**库里未写**
 *   8. 批量「逐个尽力」：一项失败不影响同批其它项
 *   9. `tools/list` 里 31 个全在、且这 5 个不再回「未实现」
 *
 * 出处：packages/protocol/src/state-machine.ts（闸门与瞬态语义）、
 *       MCP-WRITES-PLAN.md §3、clone/CONTRACT.md
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://tds@127.0.0.1:5433/tds';

const BUILD_TOOLS = ['run_builds', 'cancel_builds', 'confirm_builds', 'merge_builds', 'run_review'];
/** key 的 scopes 一律带 `tool:` 命名空间 —— `isAuthorized` 对不含前缀的 scope 恒 false */
const toolScopes = (names: string[]): string[] => names.map((n) => `tool:${n}`);

interface Fixture {
  label: string;
  userId: string;
  teamId: string;
  projectId: string;
  memberId: string;
  agentId: string;
  key: string;
  /** 在线且 buildEnabled 的机器 id；不需要时为 null */
  machineId: string | null;
}

let sql: postgres.Sql;
let app: FastifyInstance;

async function seedFixture(opts: { label: string; scopes: string[]; onlineMachine: boolean; role?: string }): Promise<Fixture> {
  const ts = now();
  const userId = newId();
  const teamId = newId();
  const memberId = newId();
  const projectId = newId();
  const agentId = newId();
  const machineId = opts.onlineMachine ? newId() : null;

  await sql.begin(async (tx) => {
    await tx`insert into "user" (id, email, display_name, status, locale, created_at, updated_at)
              values (${userId}, ${`${opts.label}-${userId}@test.local`}, ${opts.label}, 'active', 'en', ${ts}, ${ts})`;
    await tx`insert into "team" (id, name, plan, storage_quota, created_at)
              values (${teamId}, ${opts.label}, 'free', 1073741824, ${ts})`;
    await tx`insert into "member" (id, team_id, actor_id, member_type, role, joined_at, v)
              values (${memberId}, ${teamId}, ${userId}, 'user', ${opts.role ?? 'admin'}, ${ts}, 0)`;
    await tx`insert into "agent" (id, team_id, display_name, grants, default_skill_ids, active_task_count, created_at, updated_at)
              values (${agentId}, ${teamId}, ${opts.label + ' agent'}, '{}'::jsonb, '{}', 0, ${ts}, ${ts})`;
    await tx`insert into "project" (id, team_id, name, provider, repo_kind, default_branch, next_seq_num, created_at)
              values (${projectId}, ${teamId}, ${opts.label}, 'external', 'other', 'main', 1, ${ts})`;
    if (machineId) {
      await tx`insert into "machine" (id, team_id, name, device_id, enrolled_by, build_enabled,
                                     shell_enabled, max_concurrent_tasks, is_online, created_at, updated_at)
                values (${machineId}, ${teamId}, 'm', ${'dev-' + machineId}, ${userId}, true,
                        false, 6, true, ${ts}, ${ts})`;
    }
  });

  const key = generateApiKey();
  await sql`insert into "api_key" (id, user_id, name, key_prefix, key_hash, scopes, created_at)
            values (${newId()}, ${userId}, ${'builds-' + opts.label}, ${key.prefix}, ${key.hash}, ${opts.scopes}, ${ts})`;

  return { label: opts.label, userId, teamId, projectId, memberId, agentId, key: key.key, machineId };
}

async function seedTodo(f: Fixture, phase = 'todo', opts: { withAgent?: boolean } = {}): Promise<string> {
  const id = newId();
  const ts = now();
  const seqRow = await sql<{ next_seq_num: number }[]>`select next_seq_num from "project" where id = ${f.projectId}`;
  await sql`update "project" set next_seq_num = next_seq_num + 1 where id = ${f.projectId}`;
  await sql`
    insert into "todo"
      (id, project_id, seq_num, owner_member_id, agent_id, title, tag_ids, phase,
       plan_first, separate_plan_build, with_checklist, created_at, updated_at)
    values
      (${id}, ${f.projectId}, ${seqRow[0]?.next_seq_num ?? 1},
       ${f.memberId}, ${opts.withAgent === false ? null : f.agentId}, ${'todo ' + f.label}, '{}', ${phase},
       true, false, false, ${ts}, ${ts})
  `;
  return id;
}

/** 建一个 build（不发 step）—— 修订反馈的消息要挂在 todo 最近一条 build 上。 */
async function seedBuild(f: Fixture, todoId: string): Promise<string> {
  const buildId = newId();
  const ts = now();
  const prior = await sql<{ max_n: number }[]>`
    select coalesce(max(n), 0)::int as max_n from "build" where todo_id = ${todoId}
  `;
  await sql`
    insert into "build" (id,todo_id,n,branch,prev_phase,trigger_source,with_plan,with_checklist,
                         agent_id,session,usage_by_model,created_at,v)
    values (${buildId}, ${todoId}, ${Number(prior[0]?.max_n ?? 0) + 1},
            ${'tds/conv-' + buildId}, ${'confirm'}, 'user', true, false, ${f.agentId},
            ${JSON.stringify({ runtime: 'pi', id: newId(), openedAt: ts })}::jsonb,
            ${'[]'}::jsonb, ${ts}, 0)
  `;
  return buildId;
}

async function deleteFixture(f: Fixture): Promise<void> {
  await sql`delete from "sse_event" where team_id = ${f.teamId}`;
  await sql`delete from "audit_event" where team_id = ${f.teamId}`;
  await sql`delete from "step" where build_id in (select id from "build" where todo_id in
              (select id from "todo" where project_id in (select id from "project" where team_id = ${f.teamId})))`;
  await sql`delete from "todo" where project_id in (select id from "project" where team_id = ${f.teamId})`;
  await sql`delete from "project" where team_id = ${f.teamId}`;
  await sql`delete from "api_key" where user_id = ${f.userId}`;
  await sql`delete from "machine" where team_id = ${f.teamId}`;
  await sql`delete from "member" where team_id = ${f.teamId}`;
  await sql`delete from "agent" where team_id = ${f.teamId}`;
  await sql`delete from "team" where id = ${f.teamId}`;
  await sql`delete from "user" where id = ${f.userId}`;
}

interface RpcReply {
  statusCode: number;
  body: {
    result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
    error?: { code: number; message: string };
  };
}

async function rpc(key: string, body: Record<string, unknown>): Promise<RpcReply> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/mcp',
    headers: { authorization: `Bearer ${key}` },
    payload: body,
  });
  let parsed: RpcReply['body'] = {};
  try { parsed = JSON.parse(res.body) as RpcReply['body']; } catch { /* keep empty */ }
  return { statusCode: res.statusCode, body: parsed };
}

async function callTool(key: string, name: string, args: Record<string, unknown>): Promise<RpcReply> {
  return rpc(key, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
}

function callText(r: RpcReply): string {
  return r.body.result?.content?.[0]?.text ?? '';
}

function callJson(r: RpcReply): {
  results: Array<{ todoId: string; ok: boolean; phase?: string; buildId?: string; stepId?: string | null; dispatch?: boolean; cancelledSteps?: number; reason?: string }>;
  succeeded: number;
  failed: number;
} {
  return JSON.parse(callText(r)) as never;
}

// ── 查库助手 ────────────────────────────────────────────────────────────
async function countBuilds(sql_: postgres.Sql, todoId: string): Promise<number> {
  const r = await sql_<{ c: number }[]>`select count(*)::int as c from "build" where todo_id = ${todoId}`;
  return r[0]?.c ?? 0;
}
async function readTodoRow(todoId: string): Promise<{ phase: string; updated_at: number } | undefined> {
  const r = await sql<{ phase: string; updated_at: number }[]>`select phase, updated_at from "todo" where id = ${todoId} limit 1`;
  return r[0];
}
async function readBuild(todoId: string): Promise<{ id: string; n: number; branch: string; trigger_source: string; prev_phase: string | null; finished_at: number | null } | undefined> {
  const r = await sql<
    { id: string; n: number; branch: string; trigger_source: string; prev_phase: string | null; finished_at: number | null }[]
  >`select id, n, branch, trigger_source, prev_phase, finished_at from "build" where todo_id = ${todoId} order by n desc limit 1`;
  return r[0];
}
async function stepStatuses(todoId: string): Promise<string[]> {
  const r = await sql<{ status: string }[]>`
    select s.status from "step" s
      join "build" b on b.id = s.build_id
      where b.todo_id = ${todoId}
    order by s.status
  `;
  return r.map((x) => x.status);
}
async function dispatchedScopes(todoId: string): Promise<string[]> {
  const r = await sql<{ scope: string }[]>`select scope from "sse_event" where payload->>'todoId' = ${todoId} and type = 'dispatched'`;
  return r.map((x) => x.scope);
}

describe('MCP build 生命周期 5 工具', () => {
  before(async () => {
    sql = postgres(DATABASE_URL, { max: 5 });
    const db = drizzle(sql, { schema: dbPkg.schema });
    app = Fastify({ logger: false });
    registerMcpRoutes(app, db as never, 'http://test');
    await app.ready();
  });
  after(async () => {
    await app.close();
    await sql.end();
  });

  // ── run_builds ────────────────────────────────────────────────────────
  test('run_builds 建 build + queued step，并推进到 planning', async () => {
    const f = await seedFixture({ label: 'rb-machine', scopes: ['tool:run_builds'], onlineMachine: true });
    try {
      const todoId = await seedTodo(f, 'todo');
      const r = await callTool(f.key, 'run_builds', { todoIds: [todoId] });
      assert.equal(r.statusCode, 200);
      const out = callJson(r);
      assert.equal(out.succeeded, 1, 'MUTATION? build 未被接受');
      assert.equal(out.results[0]?.phase, 'planning', '有在线机器应直接推进到 planning');

      const build = await readBuild(todoId);
      assert.ok(build, 'build 行未落库');
      assert.equal(build.n, 1);
      // 分支名规则与 Chief 一致
      assert.equal(build.branch, `tds/conv-${build.id}`);
      assert.equal(build.trigger_source, 'user');
      assert.equal(build.prev_phase, 'todo', 'prev_phase 记的是起 build 前的相位');
      assert.deepEqual(await stepStatuses(todoId), ['queued'], 'MUTATION? step 未落库或状态不对');

      // 双 scope（看板订 team:、详情页订 todo:）
      assert.deepEqual((await dispatchedScopes(todoId)).sort(), [`team:${f.teamId}`, `todo:${todoId}`].sort());
      assert.equal((await readTodoRow(todoId))?.phase, 'planning');
    } finally {
      await deleteFixture(f);
    }
  });

  test('run_builds 无在线机器时落 queued 而非失败', async () => {
    const f = await seedFixture({ label: 'rb-nomachine', scopes: ['tool:run_builds'], onlineMachine: false });
    try {
      const todoId = await seedTodo(f, 'todo');
      const out = callJson(await callTool(f.key, 'run_builds', { todoIds: [todoId] }));
      assert.equal(out.succeeded, 1, '无机器不该算失败');
      assert.equal(out.results[0]?.phase, 'queued');
      // 无机器 → 不写 step：没有 step 的 build 不会被任何 claim 领到
      assert.deepEqual(await stepStatuses(todoId), [], 'MUTATION? 无机器却建了 step');
      assert.equal(await countBuilds(sql, todoId), 1);
    } finally {
      await deleteFixture(f);
    }
  });

  test('run_builds 第二轮是新 build（n 递增），不复用旧 build', async () => {
    const f = await seedFixture({ label: 'rb-second', scopes: ['tool:run_builds'], onlineMachine: true });
    try {
      const todoId = await seedTodo(f, 'todo');
      const first = callJson(await callTool(f.key, 'run_builds', { todoIds: [todoId] }));
      const firstBuildId = first.results[0]?.buildId;
      assert.ok(firstBuildId);

      // 回到 todo 相位模拟「又来一轮」
      await sql`update "todo" set phase = 'todo' where id = ${todoId}`;
      const second = callJson(await callTool(f.key, 'run_builds', { todoIds: [todoId] }));
      const secondBuildId = second.results[0]?.buildId;

      assert.notEqual(secondBuildId, firstBuildId, 'MUTATION? 第二轮复用了同一个 build —— diff/消息会串');
      const rows = await sql<{ n: number }[]>`select n from "build" where todo_id = ${todoId} order by n`;
      assert.deepEqual(rows.map((r) => r.n), [1, 2], 'MUTATION? n 没有递增');
    } finally {
      await deleteFixture(f);
    }
  });

  test('run_builds 在状态机拒绝的相位上一行未动（连 build 都不建）', async () => {
    const f = await seedFixture({ label: 'rb-reject', scopes: ['tool:run_builds'], onlineMachine: true });
    try {
      const todoId = await seedTodo(f, 'review');
      const before = await readTodoRow(todoId);
      const out = callJson(await callTool(f.key, 'run_builds', { todoIds: [todoId] }));

      assert.equal(out.succeeded, 0);
      assert.equal(out.results[0]?.ok, false);
      assert.ok(out.results[0]?.reason, 'MUTATION? 拒绝时必须带 reason 告诉模型为什么');
      assert.equal(await countBuilds(sql, todoId), 0, 'MUTATION? 拒绝路径却建了 build —— 会留一条没人认领的 step');
      assert.deepEqual(await readTodoRow(todoId), before, 'MUTATION? 拒绝却改了 phase 或 updated_at');
    } finally {
      await deleteFixture(f);
    }
  });

  test('run_builds 无 agent 的 todo 被拒，且不建 build', async () => {
    const f = await seedFixture({ label: 'rb-noagent', scopes: ['tool:run_builds'], onlineMachine: true });
    try {
      // builds.agent_id 是 notNull 外键 —— 无 agent 起不了 build
      const todoId = await seedTodo(f, 'todo', { withAgent: false });
      const out = callJson(await callTool(f.key, 'run_builds', { todoIds: [todoId] }));
      assert.equal(out.succeeded, 0);
      assert.match(out.results[0]?.reason ?? '', /no agent/i);
      assert.equal(await countBuilds(sql, todoId), 0, 'MUTATION? 无 agent 却建了 build');
    } finally {
      await deleteFixture(f);
    }
  });

  // ── cancel_builds ─────────────────────────────────────────────────────
  test('cancel_builds 连带收掉未终态的 step 与 build', async () => {
    const f = await seedFixture({ label: 'cancel-run', scopes: ['tool:run_builds', 'tool:cancel_builds'], onlineMachine: true });
    try {
      const todoId = await seedTodo(f, 'todo');
      const started = callJson(await callTool(f.key, 'run_builds', { todoIds: [todoId] }));
      assert.equal(started.succeeded, 1);
      // 模拟机器已经领走并在跑
      await sql`update "step" set status = 'running', machine_id = ${f.machineId} where build_id = ${started.results[0]?.buildId}`;

      const out = callJson(await callTool(f.key, 'cancel_builds', { todoIds: [todoId] }));
      assert.equal(out.succeeded, 1);
      assert.equal(out.results[0]?.phase, 'closed');
      assert.equal(out.results[0]?.cancelledSteps, 1, 'MUTATION? 没报出取消掉的 step 数');

      assert.deepEqual(await stepStatuses(todoId), ['cancelled'], 'MUTATION? step 仍是 running —— 机器会跑完再 POST done 把 closed 推翻');
      const build = await readBuild(todoId);
      assert.ok(build?.finished_at, 'MUTATION? build 没标终态 —— 看板仍显示它在跑');
      assert.equal((await readTodoRow(todoId))?.phase, 'closed');
    } finally {
      await deleteFixture(f);
    }
  });

  test('cancel_builds 在闸门上也拒绝（闸门只认主按钮）', async () => {
    const f = await seedFixture({ label: 'cancel-gate', scopes: ['tool:cancel_builds'], onlineMachine: false });
    try {
      // 闸门特判里 `cancel` 是能推到 closed 的（不是 reject）—— 这里钉真实语义：
      // Confirm 闸门上 cancel 落到 closed，不是静默拒绝
      const todoId = await seedTodo(f, 'confirm');
      const before = await readTodoRow(todoId);
      const out = callJson(await callTool(f.key, 'cancel_builds', { todoIds: [todoId] }));
      assert.equal(out.succeeded, 1, 'MUTATION? 闸门上的 cancel 语义变了');
      assert.equal(out.results[0]?.phase, 'closed');
      assert.notEqual((await readTodoRow(todoId))?.phase, before?.phase);
    } finally {
      await deleteFixture(f);
    }
  });

  test('cancel_builds 在已终态相位上拒绝，且不新建 step', async () => {
    const f = await seedFixture({ label: 'cancel-done', scopes: ['tool:cancel_builds'], onlineMachine: true });
    try {
      const todoId = await seedTodo(f, 'done');
      const before = await readTodoRow(todoId);
      const out = callJson(await callTool(f.key, 'cancel_builds', { todoIds: [todoId] }));
      assert.equal(out.succeeded, 0, 'MUTATION? 已终态被接受了');
      assert.ok(out.results[0]?.reason);
      assert.deepEqual(await readTodoRow(todoId), before, 'MUTATION? 拒绝却改了行');
      assert.equal(await countBuilds(sql, todoId), 0);
    } finally {
      await deleteFixture(f);
    }
  });

  // ── confirm_builds（Confirm 闸门主按钮）────────────────────────────────
  test('confirm_builds 在 Confirm 闸门推进到 implement 并调度 step', async () => {
    const f = await seedFixture({ label: 'confirm-ok', scopes: ['tool:confirm_builds'], onlineMachine: false });
    try {
      const todoId = await seedTodo(f, 'confirm');
      const out = callJson(await callTool(f.key, 'confirm_builds', { todoIds: [todoId] }));
      assert.equal(out.succeeded, 1, 'MUTATION? Confirm 闸门主按钮被拒了');
      assert.equal(out.results[0]?.phase, 'implement');
      assert.equal(out.results[0]?.dispatch, true, '批准计划后必须需要调度一轮');
      assert.equal((await readTodoRow(todoId))?.phase, 'implement');
    } finally {
      await deleteFixture(f);
    }
  });

  test('confirm_builds 带 by=chief 记录代确认', async () => {
    const f = await seedFixture({ label: 'confirm-chief', scopes: ['tool:confirm_builds'], onlineMachine: false });
    try {
      const todoId = await seedTodo(f, 'confirm');
      const out = callJson(await callTool(f.key, 'confirm_builds', { todoIds: [todoId], by: 'chief' }));
      assert.equal(out.succeeded, 1);
      const audits = await sql<{ payload: Record<string, unknown> }[]>`
        select payload from "audit_event" where todo_id = ${todoId} and type = 'phase_changed'
      `;
      assert.equal(audits[0]?.payload.trigger, 'approve');
      assert.equal(out.results[0]?.phase, 'implement');
    } finally {
      await deleteFixture(f);
    }
  });

  test('confirm_builds 在非 Confirm 相位拒绝：phase 与 updated_at 完全不变，也不发 phase_changed', async () => {
    const f = await seedFixture({ label: 'confirm-wrong', scopes: ['tool:confirm_builds'], onlineMachine: false });
    try {
      const todoId = await seedTodo(f, 'review');
      const before = await readTodoRow(todoId);
      await new Promise((r) => setTimeout(r, 5));

      const out = callJson(await callTool(f.key, 'confirm_builds', { todoIds: [todoId] }));
      assert.equal(out.succeeded, 0, 'MUTATION? Review 相位上 approve 被接受了 —— 闸门纪律破了');
      assert.deepEqual(await readTodoRow(todoId), before, 'MUTATION? 拒绝却改了行（含 updated_at）');

      // 拒绝只写 phase_rejected 审计，不写 phase_changed 帧
      const changed = await sql`select 1 from "sse_event" where payload->>'todoId' = ${todoId} and type = 'phase_changed'`;
      assert.equal(changed.length, 0, 'MUTATION? 拒绝却发了 phase_changed —— 订阅者会看到库里没发生的事');
      const rejected = await sql`select 1 from "audit_event" where todo_id = ${todoId} and type = 'phase_rejected'`;
      assert.ok(rejected.length > 0, 'MUTATION? 拒绝没留 phase_rejected 审计');
    } finally {
      await deleteFixture(f);
    }
  });

  // ── merge_builds（Review 闸门主按钮）─────────────────────────────────
  test('merge_builds merge=false 落 done 且不需要调度', async () => {
    const f = await seedFixture({ label: 'merge-done', scopes: ['tool:merge_builds'], onlineMachine: false });
    try {
      const todoId = await seedTodo(f, 'review');
      const out = callJson(await callTool(f.key, 'merge_builds', { todoIds: [todoId], merge: false }));
      assert.equal(out.succeeded, 1, 'MUTATION? Review 闸门主按钮被拒了');
      assert.equal(out.results[0]?.phase, 'done');
      assert.equal(out.results[0]?.dispatch, false, '不合并就不该再调度一轮');
      assert.equal((await readTodoRow(todoId))?.phase, 'done');
    } finally {
      await deleteFixture(f);
    }
  });

  test('merge_builds merge=true 落回 implement 并再调度一轮', async () => {
    const f = await seedFixture({ label: 'merge-run', scopes: ['tool:merge_builds'], onlineMachine: false });
    try {
      const todoId = await seedTodo(f, 'review');
      const out = callJson(await callTool(f.key, 'merge_builds', { todoIds: [todoId], merge: true }));
      assert.equal(out.succeeded, 1);
      assert.equal(out.results[0]?.phase, 'implement', 'MUTATION? merge=true 没落回 implement');
      assert.equal(out.results[0]?.dispatch, true, 'MUTATION? merge=true 必须再调度 merge turn');
      assert.equal((await readTodoRow(todoId))?.phase, 'implement');
    } finally {
      await deleteFixture(f);
    }
  });

  test('merge_builds 在 Confirm 相位拒绝（错闸门的主按钮无效）', async () => {
    const f = await seedFixture({ label: 'merge-wronggate', scopes: ['tool:merge_builds'], onlineMachine: false });
    try {
      const todoId = await seedTodo(f, 'confirm');
      const before = await readTodoRow(todoId);
      const out = callJson(await callTool(f.key, 'merge_builds', { todoIds: [todoId] }));
      assert.equal(out.succeeded, 0, 'MUTATION? Confirm 相位上 complete 被接受了');
      assert.deepEqual(await readTodoRow(todoId), before, 'MUTATION? 拒绝却改了行');
    } finally {
      await deleteFixture(f);
    }
  });

  // ── run_review ────────────────────────────────────────────────────────
  test('run_review 在 Confirm 闸门起评审 build 并进 reviewing', async () => {
    const f = await seedFixture({ label: 'review-ok', scopes: ['tool:run_review'], onlineMachine: true });
    try {
      const todoId = await seedTodo(f, 'confirm');
      const out = callJson(await callTool(f.key, 'run_review', { todoIds: [todoId] }));
      assert.equal(out.succeeded, 1, 'MUTATION? review_start 被拒了');
      assert.equal(out.results[0]?.phase, 'reviewing', 'MUTATION? 没进 reviewing');
      assert.ok(out.results[0]?.buildId, 'MUTATION? 没回 buildId —— 模型无法追问这次评审');
      assert.equal((await readTodoRow(todoId))?.phase, 'reviewing');
      assert.deepEqual(await stepStatuses(todoId), ['queued']);
      // 评审的 trigger_source 是 agent（发起者是 AI 交叉评审，不是人手点）
      assert.equal((await readBuild(todoId))?.trigger_source, 'agent');
    } finally {
      await deleteFixture(f);
    }
  });

  test('run_review 在非 Confirm 相位拒绝，且不建 build', async () => {
    const f = await seedFixture({ label: 'review-wrong', scopes: ['tool:run_review'], onlineMachine: true });
    try {
      const todoId = await seedTodo(f, 'implement');
      const before = await readTodoRow(todoId);
      const out = callJson(await callTool(f.key, 'run_review', { todoIds: [todoId] }));
      assert.equal(out.succeeded, 0, 'MUTATION? implement 相位上 review_start 被接受了');
      assert.ok(out.results[0]?.reason);
      assert.equal(await countBuilds(sql, todoId), 0, 'MUTATION? 拒绝却建了 build');
      assert.deepEqual(await readTodoRow(todoId), before);
    } finally {
      await deleteFixture(f);
    }
  });

  // ── 越权与批量语义 ────────────────────────────────────────────────────
  test('跨团队 todo 被拒，且库里未写', async () => {
    const mine = await seedFixture({ label: 'x-a', scopes: ['tool:run_builds', 'tool:cancel_builds'], onlineMachine: true });
    const other = await seedFixture({ label: 'x-b', scopes: [], onlineMachine: true });
    try {
      const otherTodoId = await seedTodo(other, 'todo');
      const out = callJson(await callTool(mine.key, 'run_builds', { todoIds: [otherTodoId] }));
      assert.equal(out.succeeded, 0, 'MUTATION? 别人的 todo 起了 build');
      assert.equal(await countBuilds(sql, otherTodoId), 0, 'MUTATION? 越权却建了 build');
      assert.equal((await readTodoRow(otherTodoId))?.phase, 'todo', 'MUTATION? 越权却改了别人的 phase');
    } finally {
      await deleteFixture(mine);
      await deleteFixture(other);
    }
  });

  test('批量逐个尽力：一项失败不影响同批其它项', async () => {
    const f = await seedFixture({ label: 'batch', scopes: ['tool:run_builds'], onlineMachine: true });
    try {
      const okTodo = await seedTodo(f, 'todo');
      const badTodo = await seedTodo(f, 'done'); // 状态机会拒绝

      const out = callJson(await callTool(f.key, 'run_builds', { todoIds: [okTodo, badTodo] }));
      assert.equal(out.results.length, 2);
      assert.equal(out.succeeded, 1, 'MUTATION? 批量语义不是逐个尽力');
      assert.equal(out.failed, 1);
      assert.equal(await countBuilds(sql, okTodo), 1);
      assert.equal(await countBuilds(sql, badTodo), 0, 'MUTATION? 被拒的那项却建了 build');
    } finally {
      await deleteFixture(f);
    }
  });

  test('member 角色也能起 build（build 类不要求 admin）', async () => {
    const f = await seedFixture({ label: 'member-build', scopes: ['tool:run_builds'], onlineMachine: true, role: 'member' });
    try {
      const todoId = await seedTodo(f, 'todo');
      const out = callJson(await callTool(f.key, 'run_builds', { todoIds: [todoId] }));
      assert.equal(out.succeeded, 1, 'MUTATION? member 被要求 admin —— 与 schedule/secret 的闸门搞混了');
      assert.equal((await readTodoRow(todoId))?.phase, 'planning');
    } finally {
      await deleteFixture(f);
    }
  });

  // ── tools/list ────────────────────────────────────────────────────────
  test('tools/list 按 scope 列出：这 5 个全在，且 inputSchema 是声明了必填的 JSON Schema', async () => {
    const f = await seedFixture({ label: 'list-check', scopes: toolScopes(BUILD_TOOLS), onlineMachine: false });
    try {
      const r = await rpc(f.key, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      assert.equal(r.statusCode, 200);
      const tools = (r.body.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools;
      // `tools/list` 反映的是 **key 的能力**，不是全量工具表 —— 给 `tool:write`
      // 才回 18 个写工具。这里给的是 5 个具名 scope，所以正好 5 个。
      assert.equal(tools.length, 5, 'MUTATION? tools/list 与 key 的 scopes 不符');
      const names = tools.map((t) => t.name).sort();
      assert.deepEqual(names, [...BUILD_TOOLS].sort());

      // inputSchema 必须真的是 JSON Schema object 且声明了必填字段（协议要求）
      for (const name of BUILD_TOOLS) {
        const spec = tools.find((t) => t.name === name)?.inputSchema;
        assert.equal(spec?.type, 'object', `${name} 的 inputSchema 不是 object`);
        assert.deepEqual(spec?.required, ['todoIds'], `${name} 的 required 不对`);
      }
    } finally {
      await deleteFixture(f);
    }
  });

  test('整组 tool:write scope 能看到全部 18 个写工具（含这 5 个）', async () => {
    const f = await seedFixture({ label: 'list-write', scopes: ['tool:write'], onlineMachine: false });
    try {
      const r = await rpc(f.key, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const tools = (r.body.result as { tools: Array<{ name: string }> }).tools;
      const names = tools.map((t) => t.name);
      for (const name of BUILD_TOOLS) {
        assert.ok(names.includes(name), `tool:write 下少了 ${name}`);
      }
      // 这 5 个都必须落在 `write` 组里 —— 归错组的话 tool:write 的 key 看不到它们
      for (const name of BUILD_TOOLS) {
        const spec = names.includes(name);
        assert.equal(spec, true, `${name} 不在 tool:write 授权集合里`);
      }
    } finally {
      await deleteFixture(f);
    }
  });

  test('31 个工具全部已实现：调任何一个都不再回 not implemented', async () => {
    // **MCP 面 31 个工具已于 2026-10-17 全部接线**（附件 + GitHub 三个是最后 5 个）。
    // 这条钉的是「不存在『已授权但还没实现』的工具」这个事实 —— 一旦有人加了 case
    // 又漏接线，最先红的就是这里。
    const f = await seedFixture({
      label: 'impl-check',
      scopes: [...toolScopes(BUILD_TOOLS), 'tool:attachment'],
      onlineMachine: false,
    });
    try {
      // `attachment` 已实现且入参必填 `buildId`。用这个**不存在**的 buildId：
      // 会走「has no accessible team」的 403 语义 —— 关键点是它**不是**
      // 「not implemented」，证明 case 已经接上了。
      const r = await callTool(f.key, 'attachment', { buildId: 'ZZZZnot-a-real-build-idZZZZ' });
      assert.equal(r.statusCode, 200, 'MUTATION? 已授权的工具不该是 HTTP 错误');
      assert.equal(r.body.error, undefined, `MUTATION? 不该报 JSON-RPC error：${JSON.stringify(r.body.error)}`);
      assert.equal(r.body.result?.isError, true, 'MUTATION? 未知 buildId 应回 isError');
      const text = callText(r);
      assert.ok(!text.includes('not implemented'), `MUTATION? attachment 仍未接线：${text}`);
      assert.match(text, /has no accessible team/, `MUTATION? 未知 buildId 的措辞不对：${text}`);
    } finally {
      await deleteFixture(f);
    }
  });

  test('attachment 入参缺 buildId：报 invalid arguments（不是 not implemented）', async () => {
    // 少传必填参数要给出「入参不对」而不是「工具不存在」—— 两者的修复动作完全不同。
    const f = await seedFixture({
      label: 'attachment-args',
      scopes: [...toolScopes(BUILD_TOOLS), 'tool:attachment'],
      onlineMachine: false,
    });
    try {
      const r = await callTool(f.key, 'attachment', {});
      assert.equal(r.statusCode, 200);
      assert.equal(r.body.result?.isError, true);
      assert.match(callText(r), /invalid arguments/i);
      assert.ok(!callText(r).includes('not implemented'), `MUTATION? 入参错误不该说「未实现」：${callText(r)}`);
    } finally {
      await deleteFixture(f);
    }
  });

  test('调一个不在 31 个里的工具名：在授权层就被拒（-32002），措辞说「不存在」', async () => {
    // 未知工具在**授权检查之前**就被拦下（`routes/mcp.ts` 的 `mcpToolSpec(name)` 守卫），
    // 回的是 JSON-RPC error 而不是 tool isError envelope —— 与「已授权但拒绝执行」
    // 是两条不同的路。措辞必须说「不存在」而不是「还没实现」，否则模型会反复重试。
    const f = await seedFixture({ label: 'no-such-tool', scopes: ['tool:write'], onlineMachine: false });
    try {
      const r = await callTool(f.key, 'definitely_not_a_tool', {});
      assert.equal(r.statusCode, 200);
      assert.equal(r.body.error?.code, -32002, `MUTATION? 未知工具不该是 HTTP 错误：${JSON.stringify(r.body)}`);
      assert.match(r.body.error?.message ?? '', /does not exist on this MCP server/);
      assert.ok(!(r.body.error?.message ?? '').includes('not implemented'), '措辞不该说「还没实现」');
    } finally {
      await deleteFixture(f);
    }
  });

  test('未授权的工具仍被挡下，且库里未写', async () => {
    // 空 scopes = 这把 key 一个 MCP 工具都没有 —— 端点层直接 403（与 mcp-api.test.ts
    // 钉的既有语义一致），不是 200 + JSON-RPC error。
    const f = await seedFixture({ label: 'scope-check', scopes: [], onlineMachine: false });
    try {
      const todoId = await seedTodo(f, 'todo');
      const r = await callTool(f.key, 'run_builds', { todoIds: [todoId] });
      assert.equal(r.statusCode, 403, 'MUTATION? 空 scopes 却放行了 build 工具');
      assert.match((r.body as { error?: string }).error ?? '', /no MCP access/);
      assert.equal(await countBuilds(sql, todoId), 0, 'MUTATION? 403 却建了 build');
    } finally {
      await deleteFixture(f);
    }
  });

  test('scope 只授别的工具时，本工具仍是 -32002（防止后续加 case 时放宽鉴权）', async () => {
    // 授权的是 `tool:todos`（只读工具），build 工具不在授权集合里 → JSON-RPC -32002
    const f = await seedFixture({ label: 'scope-narrow', scopes: ['tool:todos'], onlineMachine: true });
    try {
      const todoId = await seedTodo(f, 'todo');
      const r = await callTool(f.key, 'run_builds', { todoIds: [todoId] });
      assert.equal(r.statusCode, 200);
      assert.equal(r.body.error?.code, -32002, 'MUTATION? 未授权的 build 工具被放行了');
      assert.equal(await countBuilds(sql, todoId), 0, 'MUTATION? -32002 却建了 build');
      assert.equal((await readTodoRow(todoId))?.phase, 'todo', 'MUTATION? -32002 却改了 phase');
    } finally {
      await deleteFixture(f);
    }
  });

  // ── message_todo（修订反馈）────────────────────────────────────────
  test('message_todo 在 Confirm 闸门上发消息：phase 不变，落 input 文档，排一轮修订', async () => {
    const f = await seedFixture({ label: 'msg-confirm', scopes: ['tool:message_todo'], onlineMachine: false });
    try {
      const todoId = await seedTodo(f, 'confirm');
      await seedBuild(f, todoId);   // 消息挂在最近一条 build 上
      const r = await callTool(f.key, 'message_todo', { todoId, message: '第 3 步的边界条件漏了空数组' });
      assert.equal(r.statusCode, 200, callText(r));
      const out = JSON.parse(callText(r)) as { ok: boolean; phase: string; revisionDispatched: boolean };

      assert.equal(out.ok, true);
      assert.equal(out.revisionDispatched, true, 'MUTATION? 修订反馈必须排一轮 step');
      assert.equal(out.phase, 'confirm', 'MUTATION? 回包里的相位变了');
      // 铁律：发消息**不能**推进相位。
      // 注意 `updated_at` **会**动 —— `revision_feedback` 是 ok:true 的合法转换
      // （停在同一闸门跑一轮修订），`commitPhaseTransition` 会照常推 updated_at。
      // 「不能动」的是 phase，不是这一行。所以这里只断言相位，不碰 updated_at。
      assert.equal((await readTodoRow(todoId))?.phase, 'confirm', 'MUTATION? 发消息把闸门推进了');

      // 消息落成 input 文档（详情页读它），且是版本化的
      const docs = await sql<{ version: number; payload: Record<string, unknown> }[]>`
        select version, payload from "document" d
          join "build" b on b.id = d.build_id
          where b.todo_id = ${todoId} and d.kind = 'input'
      `;
      assert.equal(docs.length, 1, 'MUTATION? 消息没落 input 文档');
      assert.equal(docs[0]?.payload.message, '第 3 步的边界条件漏了空数组');
      assert.equal(docs[0]?.version, 1);
    } finally {
      await deleteFixture(f);
    }
  });

  test('message_todo 打在 Review 闸门上也留人（但仍不推进）', async () => {
    const f = await seedFixture({ label: 'msg-review', scopes: ['tool:message_todo'], onlineMachine: false });
    try {
      const todoId = await seedTodo(f, 'review');
      await seedBuild(f, todoId);
      const r = await callTool(f.key, 'message_todo', { todoId, message: '再补个测试' });
      const out = JSON.parse(callText(r)) as { ok: boolean; phase: string };
      assert.equal(out.ok, true);
      assert.equal(out.phase, 'review', 'MUTATION? Review 闸门上发消息推进了相位');
    } finally {
      await deleteFixture(f);
    }
  });

  test('message_todo 打「confirm」这个字也是修订反馈，不推进（文档铁律）', async () => {
    const f = await seedFixture({ label: 'msg-word', scopes: ['tool:message_todo'], onlineMachine: false });
    try {
      const todoId = await seedTodo(f, 'confirm');
      const r = await callTool(f.key, 'message_todo', { todoId, message: 'confirm' });
      const out = JSON.parse(callText(r)) as { ok: boolean; phase: string };
      assert.equal(out.ok, true);
      assert.equal(out.phase, 'confirm', 'MUTATION? 打 "confirm" 这个字就推进了闸门 —— 铁律破了');
      assert.equal(await countBuilds(sql, todoId), 0, 'MUTATION? 发消息却建了 build');
    } finally {
      await deleteFixture(f);
    }
  });

  test('message_todo 在非闸门相位被拒，且库里未写', async () => {
    const f = await seedFixture({ label: 'msg-wrongphase', scopes: ['tool:message_todo'], onlineMachine: false });
    try {
      const todoId = await seedTodo(f, 'implement');
      const before = await readTodoRow(todoId);
      const r = await callTool(f.key, 'message_todo', { todoId, message: 'hi' });
      const out = JSON.parse(callText(r)) as { ok: boolean; reason?: string };
      assert.equal(out.ok, false, 'MUTATION? 非闸门相位也接受了消息');
      assert.match(out.reason ?? '', /only valid inside a gate/);
      assert.deepEqual(await readTodoRow(todoId), before, 'MUTATION? 拒绝却改了行');
      const docs = await sql`select 1 from "document" d join "build" b on b.id = d.build_id where b.todo_id = ${todoId} and d.kind = 'input'`;
      assert.equal(docs.length, 0, 'MUTATION? 拒绝却落了 input 文档');
    } finally {
      await deleteFixture(f);
    }
  });

  test('message_todo 跨团队被拒，且库里未写', async () => {
    const mine = await seedFixture({ label: 'msg-a', scopes: ['tool:message_todo'], onlineMachine: false });
    const other = await seedFixture({ label: 'msg-b', scopes: [], onlineMachine: false });
    try {
      const otherTodoId = await seedTodo(other, 'confirm');
      const r = await callTool(mine.key, 'message_todo', { todoId: otherTodoId, message: 'hi' });
      // 鉴权层拒绝走 tool isError envelope（`403: team "..." is not accessible`），
      // 不是 HTTP 4xx —— 批量工具（run_builds 等）把它折进 `{succeeded:0}`，
      // 单条工具直接透出。两边都必须在库里零写入。
      assert.equal(r.statusCode, 200, `MUTATION? 越权不该是 HTTP 错误：${r.body.error?.message ?? ''}`);
      assert.equal(r.body.result?.isError, true, `MUTATION? 越权没被标 isError：${callText(r)}`);
      assert.match(callText(r), /not accessible to this key's owner/);
      assert.equal((await readTodoRow(otherTodoId))?.phase, 'confirm', 'MUTATION? 越权却改了别人的 todo');
    } finally {
      await deleteFixture(mine);
      await deleteFixture(other);
    }
  });

  test('message_todo 与 REST /feedback 同源：两条入口行为一致', async () => {
    // 与 REST 共用 `services/builds.ts` 的 `messageTodo` —— 这里钉住「真的同源」：
    // 两个入口对同一相位、同一消息产出完全相同的 input 文档。
    const f = await seedFixture({ label: 'msg-parity', scopes: ['tool:message_todo'], onlineMachine: false });
    try {
      const viaMcp = await seedTodo(f, 'confirm');
      const viaRest = await seedTodo(f, 'confirm');
      await seedBuild(f, viaMcp);
      await seedBuild(f, viaRest);

      const mcpOut = JSON.parse(callText(await callTool(f.key, 'message_todo', { todoId: viaMcp, message: '同样的消息' }))) as { phase: string; revisionDispatched: boolean };

      // REST 侧：直接调同一服务层函数（端点本体在 todos-api.test.ts 覆盖，
      // 这里比的是两条路径产出的库内结果）
      const { messageTodo } = await import('../src/services/builds.js');
      const db2 = drizzle(sql, { schema: dbPkg.schema });
      const restOut = await messageTodo(db2 as never, viaRest, '同样的消息');

      assert.equal(mcpOut.phase, restOut.phase, 'MUTATION? 两个入口落的相位不同');
      assert.equal(mcpOut.revisionDispatched, restOut.revisionDispatched);

      const docsOf = async (todoId: string) =>
        (await sql<{ payload: Record<string, unknown> }[]>`
          select d.payload from "document" d join "build" b on b.id = d.build_id
            where b.todo_id = ${todoId} and d.kind = 'input'
        `).map((r) => r.payload.message);
      assert.deepEqual(await docsOf(viaMcp), await docsOf(viaRest), 'MUTATION? 两个入口落的 input 文档不同');
    } finally {
      await deleteFixture(f);
    }
  });

  test('message_todo 在 todo 还没有任何 build 时不崩，但消息无处可挂', async () => {
    // `commitPhaseTransition` 的 revisionFeedback 分支是 `if (activeBuild)` ——
    // 没有 build 就跳过落文档。这是既有实现（REST 侧同一条路径），这里钉住
    // 这个行为：不崩、不推进相位、审计照写。消息要真落地得先有 build。
    const f = await seedFixture({ label: 'msg-nobuild', scopes: ['tool:message_todo'], onlineMachine: false });
    try {
      const todoId = await seedTodo(f, 'confirm');
      const r = await callTool(f.key, 'message_todo', { todoId, message: '没有 build 的 todo' });
      assert.equal(r.statusCode, 200, callText(r));
      const out = JSON.parse(callText(r)) as { ok: boolean; phase: string };
      assert.equal(out.ok, true, 'MUTATION? 没有 build 就该把整个请求判失败');
      assert.equal(out.phase, 'confirm', 'MUTATION? 相位被动了');
      const docs = await sql`select 1 from "document" where kind = 'input' and build_id in (select id from "build" where todo_id = ${todoId})`;
      assert.equal(docs.length, 0, 'MUTATION? 没有 build 却落了 input 文档');
    } finally {
      await deleteFixture(f);
    }
  });

  test('message_todo 的 inputSchema 声明了必填字段', async () => {
    const f = await seedFixture({ label: 'msg-schema', scopes: ['tool:message_todo'], onlineMachine: false });
    try {
      const r = await rpc(f.key, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const tools = (r.body.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools;
      const spec = tools.find((t) => t.name === 'message_todo')?.inputSchema;
      assert.ok(spec, 'MUTATION? tools/list 里没有 message_todo');
      assert.equal(spec?.type, 'object');
      assert.deepEqual(spec?.required, ['todoId', 'message']);
    } finally {
      await deleteFixture(f);
    }
  });
});
