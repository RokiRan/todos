import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify from 'fastify';
import * as dbPkg from '@tds/db';
import { newId, now } from '../src/ids.js';
import { hashApiKey } from '../src/crypto.js';
import { registerMachineRoutes } from '../src/routes/machine.js';
import { stepApi } from '@tds/protocol';

/**
 * `POST /api/machine/steps/:id/done` 的相位收敛（真库 + `app.inject`）。
 *
 * **背景（2026-10-17 挖出的真 bug）**：`routes/machine.ts` 的 done 路径原本按
 * `body.status` **硬编码**落相位：
 *
 *   succeeded → review   cancelled → closed   其余 → failed
 *
 * 完全不看 todo 当时的相位。于是 2026-10-17 接上 `run_review` 之后出了这条：
 *
 *   Confirm 闸门 → run_review → reviewing → 机器跑完 POST done(succeeded)
 *   → todo 被硬写成 `review`
 *
 * **直接跳过了 Confirm 闸门** —— 闸门铁律（文档最核心的一条）破了：一个还没被
 * 批准的计划，评审完自己变成了「待验收」。正确落点应走状态机：
 * `reviewing` + `review_end` → 回 `confirm`。
 *
 * 所以 done 路径必须**问状态机**，不能自己发明落点。这里逐个钉死五种起始相位。
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://tds@127.0.0.1:5433/tds';

let sql: postgres.Sql;
let app: ReturnType<typeof Fastify>;
let fx: {
  userId: string; teamId: string; memberId: string; agentId: string;
  machineKey: string; machineId: string; projectId: string;
};

describe('机器 done 的相位收敛走状态机', () => {
  before(async () => {
    sql = postgres(DATABASE_URL, { max: 5 });
    const db = drizzle(sql, { schema: dbPkg.schema });
    app = Fastify({ logger: false });
    app.decorate('machineUrl', 'http://test');
    registerMachineRoutes(app, db as never);
    await app.ready();

    const ts = now();
    const userId = newId();
    const teamId = newId();
    const memberId = newId();
    const agentId = newId();
    const machineId = newId();
    const projectId = newId();
    const machineKey = `tds_machine-${machineId}`;

    await sql.begin(async (tx) => {
      await tx`insert into "user" (id,email,display_name,status,locale,created_at,updated_at)
                values (${userId}, ${`done-${userId}@test.local`}, 'done', 'active', 'en', ${ts}, ${ts})`;
      await tx`insert into team (id,name,plan,storage_quota,created_at)
                values (${teamId}, 'done-team', 'free', 1073741824, ${ts})`;
      await tx`insert into member (id,team_id,actor_id,member_type,role,joined_at,v)
                values (${memberId}, ${teamId}, ${userId}, 'user', 'admin', ${ts}, 0)`;
      await tx`insert into agent (id,team_id,display_name,default_skill_ids,grants,active_task_count,created_at,updated_at)
                values (${agentId}, ${teamId}, 'done agent', '{}', '{}'::jsonb, 0, ${ts}, ${ts})`;
      await tx`insert into project (id,team_id,name,provider,repo_kind,default_branch,next_seq_num,created_at)
                values (${projectId}, ${teamId}, 'p', 'external', 'other', 'main', 1, ${ts})`;
      await tx`insert into machine (id,team_id,name,device_id,enrolled_by,build_enabled,shell_enabled,
                                     max_concurrent_tasks,runtimes,disabled_runtimes,workspaces_dir,
                                     is_online,last_heartbeat_at,created_at,updated_at)
                values (${machineId}, ${teamId}, 'm', ${'dev-' + machineId}, ${userId}, true, false, 6,
                        ${['pi']}, ${[]}, 'C:/ws', true, ${ts}, ${ts}, ${ts})`;
    });

    await sql`insert into api_key (id,user_id,name,key_prefix,key_hash,scopes,created_at)
              values (${newId()}, ${userId}, ${'machine:' + machineId}, ${'tds_'},
                      ${hashApiKey(machineKey)}, ${['machine:run']}, ${ts})`;

    fx = { userId, teamId, memberId, agentId, machineKey, machineId, projectId };
  });

  after(async () => {
    const todos = (await sql`select id from todo where project_id = ${fx.projectId}`).map((r) => r.id);
    if (todos.length > 0) {
      const buildIds = (await sql`select id from build where todo_id = any(${todos})`).map((r) => r.id);
      if (buildIds.length > 0) await sql`delete from step where build_id = any(${buildIds})`;
      await sql`delete from build where todo_id = any(${todos})`;
    }
    await sql`delete from todo where project_id = ${fx.projectId}`;
    await sql`delete from sse_event where team_id = ${fx.teamId}`;
    await sql`delete from audit_event where team_id = ${fx.teamId}`;
    await sql`delete from project where team_id = ${fx.teamId}`;
    await sql`delete from api_key where user_id = ${fx.userId}`;
    await sql`delete from machine where team_id = ${fx.teamId}`;
    await sql`delete from member where team_id = ${fx.teamId}`;
    await sql`delete from agent where team_id = ${fx.teamId}`;
    await sql`delete from team where id = ${fx.teamId}`;
    await sql`delete from "user" where id = ${fx.userId}`;
    await app.close();
    await sql.end();
  });

  /** 建一条 todo（给定相位）+ 一个 running step，返回 stepId。 */
  async function seedTodoWithStep(phase: string): Promise<{ todoId: string; stepId: string; buildId: string }> {
    const ts = now();
    const todoId = newId();
    const seqRow = await sql<{ next_seq_num: number }[]>`select next_seq_num from project where id = ${fx.projectId}`;
    await sql`update project set next_seq_num = next_seq_num + 1 where id = ${fx.projectId}`;
    await sql`
      insert into todo (id,project_id,seq_num,owner_member_id,agent_id,title,tag_ids,phase,
                        plan_first,separate_plan_build,with_checklist,created_at,updated_at)
      values (${todoId}, ${fx.projectId}, ${seqRow[0]?.next_seq_num ?? 1}, ${fx.memberId}, ${fx.agentId},
              'done todo', '{}', ${phase}, true, false, false, ${ts}, ${ts})
    `;
    const buildId = newId();
    await sql`
      insert into build (id,todo_id,n,branch,prev_phase,trigger_source,with_plan,with_checklist,
                         agent_id,session,usage_by_model,created_at,v)
      values (${buildId}, ${todoId}, 1, ${'tds/conv-' + buildId}, ${phase}, 'user', true, false,
              ${fx.agentId}, ${JSON.stringify({ runtime: 'pi', id: newId(), openedAt: ts })}::jsonb,
              ${'[]'}::jsonb, ${ts}, 0)
    `;
    const stepId = newId();
    await sql`insert into step (id,build_id,machine_id,status,claimed_at,heartbeat_at)
              values (${stepId}, ${buildId}, ${fx.machineId}, 'running', ${ts}, ${ts})`;
    return { todoId, stepId, buildId };
  }

  async function done(stepId: string, status: 'succeeded' | 'failed' | 'cancelled') {
    const res = await app.inject({
      method: 'POST',
      url: stepApi.done(stepId),
      headers: { authorization: `Bearer ${fx.machineKey}` },
      // stepId 要同时出现在 URL 与 body —— `DoneSchema` 里它是必填字段，
      // daemon 的 `server-client.done` 就是 `{stepId, ...payload}` 两处都带。
      payload: { stepId, status },
    });
    assert.equal(res.statusCode, 200, res.body);
    return JSON.parse(res.body) as { ok: boolean };
  }

  async function phaseOf(todoId: string): Promise<string> {
    const rows = await sql<{ phase: string }[]>`select phase from todo where id = ${todoId} limit 1`;
    return rows[0]?.phase ?? '';
  }

  // ── 核心回归：reviewing 不能再被硬写成 review ────────────────────────
  test('reviewing 相位 succeeded → 回 confirm，不进 review（闸门铁律）', async () => {
    const { todoId, stepId } = await seedTodoWithStep('reviewing');
    await done(stepId, 'succeeded');
    const p = await phaseOf(todoId);
    assert.equal(p, 'confirm',
      `MUTATION? reviewing 跑完落到了 ${p} —— 直接跳过了 Confirm 闸门，计划未经批准就成了待验收`);
  });

  test('reviewing 相位 cancelled → closed', async () => {
    const { todoId, stepId } = await seedTodoWithStep('reviewing');
    await done(stepId, 'cancelled');
    assert.equal(await phaseOf(todoId), 'closed');
  });

  test('reviewing 相位 failed → failed', async () => {
    const { todoId, stepId } = await seedTodoWithStep('reviewing');
    await done(stepId, 'failed');
    assert.equal(await phaseOf(todoId), 'failed');
  });

  // ── 其余起始相位：原有行为不许被这次改动破坏 ────────────────────────
  test('implement 相位 succeeded → review（常规路径不变）', async () => {
    const { todoId, stepId } = await seedTodoWithStep('implement');
    await done(stepId, 'succeeded');
    assert.equal(await phaseOf(todoId), 'review', 'MUTATION? 常规实施路径的落点被改了');
  });

  test('planning 相位 failed → failed（不能被改成 review）', async () => {
    const { todoId, stepId } = await seedTodoWithStep('planning');
    await done(stepId, 'failed');
    assert.equal(await phaseOf(todoId), 'failed');
  });

  test('confirm 相位 failed → failed（闸门上失败不回落）', async () => {
    const { todoId, stepId } = await seedTodoWithStep('confirm');
    await done(stepId, 'failed');
    assert.equal(await phaseOf(todoId), 'failed');
  });

  test('confirm 相位 cancelled → closed', async () => {
    const { todoId, stepId } = await seedTodoWithStep('confirm');
    await done(stepId, 'cancelled');
    assert.equal(await phaseOf(todoId), 'closed');
  });

  // ── 事件与审计不许因为改落点而丢失 ──────────────────────────────────
  test('落点变了但 phase_changed 仍然双发（team: 与 todo:）', async () => {
    const { todoId, stepId } = await seedTodoWithStep('reviewing');
    await done(stepId, 'succeeded');
    const scopes = (
      await sql<{ scope: string }[]>`
        select scope from sse_event where payload->>'todoId' = ${todoId} and type = 'phase_changed'
      `
    ).map((r) => r.scope);
    assert.ok(scopes.includes(`todo:${todoId}`), `MUTATION? 详情页没收到 phase_changed：${JSON.stringify(scopes)}`);
    assert.ok(scopes.includes(`team:${fx.teamId}`), `MUTATION? 看板没收到 phase_changed：${JSON.stringify(scopes)}`);
  });

  test('step 与 build 都落终态（看板不能一直显示在跑）', async () => {
    const { todoId, stepId, buildId } = await seedTodoWithStep('reviewing');
    await done(stepId, 'succeeded');
    const step = await sql<{ status: string; finished_at: number | null }[]>`
      select status, finished_at from step where id = ${stepId}
    `;
    assert.equal(step[0]?.status, 'succeeded');
    assert.ok(step[0]?.finished_at, 'MUTATION? step 没记 finished_at');
    const build = await sql<{ finished_at: number | null }[]>`
      select finished_at from build where id = ${buildId}
    `;
    assert.ok(build[0]?.finished_at, 'MUTATION? build 没标终态 —— 看板仍显示它在跑');
    assert.equal(await phaseOf(todoId), 'confirm');
  });

  test('审计记录的是真实落点（step_succeeded 的 phase 不能是 review）', async () => {
    const { todoId, stepId } = await seedTodoWithStep('reviewing');
    await done(stepId, 'succeeded');
    const rows = await sql<{ type: string }[]>`
      select type from audit_event where todo_id = ${todoId} and type like 'step_%'
    `;
    assert.equal(rows.length, 1, 'MUTATION? 没写 step 审计');
    assert.equal(rows[0]?.type, 'step_succeeded');
  });
});
