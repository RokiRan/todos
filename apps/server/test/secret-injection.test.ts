import assert from 'node:assert/strict';
import { test, describe, before, after, beforeEach } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify from 'fastify';
import * as dbPkg from '@tds/db';
import { newId, now } from '../src/ids.js';
import { registerMachineRoutes } from '../src/routes/machine.js';
import { hashApiKey, seal } from '../src/crypto.js';

/**
 * team secrets → claim 打通验证。
 *
 * 文档（recon/docs/secrets.md）钉的三条，这里逐条验证：
 *   1. **不自动流向每个 agent** —— 要在 agent 的 Access 页打开 `Team secrets`
 *      开关（`agents.grants.team_secrets`），默认关闭
 *   2. **值只进子进程 env** —— 只在 claim 响应里出现一次，不进 prompt / transcript
 *   3. **scope 规则** —— team 级对该团队每个项目可见；project 级只在该项目内；
 *      **同名时 project 级覆盖 team 级**
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://tds@127.0.0.1:5433/tds';

let sql: postgres.Sql;
let app: ReturnType<typeof Fastify>;
interface Fixture {
  userId: string; teamId: string; memberId: string; agentId: string;
  machineKey: string; machineId: string; projectId: string;
}
let fx: Fixture;

describe('team secrets → claim 打通', () => {
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
      await tx`insert into "user" (id,email,display_name,created_at,updated_at)
                values (${userId}, ${`secrets-${teamId}@test.local`}, 'secrets', ${ts}, ${ts})`;
      await tx`insert into team (id,name,plan,storage_quota,created_at)
                values (${teamId}, 'secrets-team', 'free', 1073741824, ${ts})`;
      await tx`insert into member (id,team_id,actor_id,member_type,role,joined_at,v)
                values (${memberId}, ${teamId}, ${userId}, 'user', 'admin', ${ts}, 0)`;
      // 默认 grants 为空 —— 「secret 不会自动流向每个 agent」
      await tx`insert into agent (id,team_id,display_name,default_skill_ids,grants,active_task_count,created_at,updated_at)
                values (${agentId}, ${teamId}, 'secrets agent', '{}', '{}'::jsonb, 0, ${ts}, ${ts})`;
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

  /** 建一条 team 级 secret（值走真 seal，验证解封链路）。 */
  async function seedTeamSecret(name: string, value: string): Promise<void> {
    const s = seal(value);
    await sql`
      insert into "secret" (id,team_id,project_id,scope,name,enc_value,enc_nonce,created_by,created_at)
      values (${newId()}, ${fx.teamId}, null, 'team', ${name},
              ${`${s.cipher}.${s.tag}`}, ${s.nonce}, ${fx.userId}, ${now()})
    `;
  }

  /** 建一条 project 级 secret。 */
  async function seedProjectSecret(name: string, value: string): Promise<void> {
    const s = seal(value);
    await sql`
      insert into "secret" (id,team_id,project_id,scope,name,enc_value,enc_nonce,created_by,created_at)
      values (${newId()}, ${fx.teamId}, ${fx.projectId}, 'project', ${name},
              ${`${s.cipher}.${s.tag}`}, ${s.nonce}, ${fx.userId}, ${now()})
    `;
  }

  async function setGrants(teamSecretsOn: boolean): Promise<void> {
    await sql`
      update agent set grants = ${JSON.stringify({ team_secrets: teamSecretsOn })}::jsonb
      where id = ${fx.agentId}
    `;
  }

  async function clearSecrets(): Promise<void> {
    await sql`delete from "secret" where team_id = ${fx.teamId}`;
  }

  async function seedStep(): Promise<string> {
    const ts = now();
    const todoId = newId();
    const buildId = newId();
    const stepId = newId();
    await sql`insert into todo (id,project_id,seq_num,owner_member_id,title,phase,plan_first,created_at,updated_at)
              values (${todoId}, ${fx.projectId},
                      (select next_seq_num from project where id = ${fx.projectId}), ${fx.memberId},
                      't', 'implement', false, ${ts}, ${ts})`;
    await sql`update project set next_seq_num = next_seq_num + 1 where id = ${fx.projectId}`;
    await sql`insert into build (id,todo_id,n,branch,trigger_source,with_plan,with_checklist,agent_id,session,usage_by_model,created_at,v)
              values (${buildId}, ${todoId}, 1, ${'tds/conv-' + buildId}, 'manual', false, false,
                      ${fx.agentId}, '{}'::jsonb, '[]'::jsonb, ${ts}, 0)`;
    await sql`insert into step (id,build_id,status,claimed_at,heartbeat_at)
              values (${stepId}, ${buildId}, 'queued', ${ts}, ${ts})`;
    return stepId;
  }

  async function claim(): Promise<{ secretEnv: Record<string, string>; prompt: string | null; raw: string }> {
    await seedStep();
    const res = await app.inject({
      method: 'POST',
      url: '/api/machine/tasks/claim',
      headers: { authorization: `Bearer ${fx.machineKey}` },
      payload: { runtimes: ['pi'], concurrency: 6 },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as { secretEnv?: Record<string, string>; prompt: string | null };
    return { secretEnv: body.secretEnv ?? {}, prompt: body.prompt, raw: res.body };
  }

  beforeEach(async () => {
    await clearSecrets();
    await setGrants(false);
  });

  after(async () => {
    if (fx) {
      const todos = (await sql`select id from todo where project_id = ${fx.projectId}`).map((r) => r.id);
      const builds = todos.length
        ? (await sql`select id from build where todo_id = any(${todos})`).map((r) => r.id)
        : [];
      if (builds.length > 0) {
        await sql`delete from step where build_id = any(${builds})`;
        await sql`delete from build where id = any(${builds})`;
      }
      if (todos.length > 0) await sql`delete from todo where id = any(${todos})`;
      await sql`delete from "secret" where team_id = ${fx.teamId}`;
      await sql`delete from project where team_id = ${fx.teamId}`;
      await sql`delete from api_key where user_id = ${fx.userId}`;
      await sql`delete from agent where team_id = ${fx.teamId}`;
      await sql`delete from machine where team_id = ${fx.teamId}`;
      await sql`delete from member where team_id = ${fx.teamId}`;
      await sql`delete from team where id = ${fx.teamId}`;
      await sql`delete from "user" where id = ${fx.userId}`;
    }
    await app.close();
    await sql.end();
  });

  test('开关关闭时不下发任何 secret（默认关闭）', async () => {
    await seedTeamSecret('API_KEY', 'super-secret-value');
    await setGrants(false);

    const got = await claim();
    assert.deepEqual(got.secretEnv, {}, 'team_secrets 关闭时 secretEnv 必须为空');
    assert.ok(!got.raw.includes('super-secret-value'), '明文绝不能出现在 claim 响应里');
  });

  test('开关打开后下发 team 级 secret 的明文值', async () => {
    await seedTeamSecret('API_KEY', 'super-secret-value');
    await seedTeamSecret('DB_URL', 'postgres://db');
    await setGrants(true);

    const got = await claim();
    assert.equal(got.secretEnv.API_KEY, 'super-secret-value', '值应解封后下发');
    assert.equal(got.secretEnv.DB_URL, 'postgres://db');
  });

  test('同名时 project 级覆盖 team 级', async () => {
    await seedTeamSecret('DATABASE_URL', 'postgres://team-default');
    await seedProjectSecret('DATABASE_URL', 'postgres://project-own');
    await setGrants(true);

    const got = await claim();
    assert.equal(
      got.secretEnv.DATABASE_URL,
      'postgres://project-own',
      '项目内的 task 必须拿到该项目的值，而不是团队的默认值',
    );
  });

  test('project 级 secret 不串到别的项目', async () => {
    const ts = now();
    const otherProject = newId();
    await sql`insert into project (id,team_id,name,provider,repo_kind,default_branch,next_seq_num,created_at)
              values (${otherProject}, ${fx.teamId}, 'other', 'external', 'other', 'main', 1, ${ts})`;
    await seedProjectSecret('ONLY_HERE', 'project-only-value');
    await setGrants(true);

    // task 落在 fx.projectId 上
    const got = await claim();
    assert.equal(got.secretEnv.ONLY_HERE, 'project-only-value');

    // task 改落到另一个项目 —— 该 project 级 secret 必须消失
    const todoId = newId();
    const buildId = newId();
    const stepId = newId();
    await sql`insert into todo (id,project_id,seq_num,owner_member_id,title,phase,plan_first,created_at,updated_at)
              values (${todoId}, ${otherProject}, 1, ${fx.memberId}, 't2', 'implement', false, ${ts}, ${ts})`;
    await sql`update project set next_seq_num = next_seq_num + 1 where id = ${otherProject}`;
    await sql`insert into build (id,todo_id,n,branch,trigger_source,with_plan,with_checklist,agent_id,session,usage_by_model,created_at,v)
              values (${buildId}, ${todoId}, 1, ${'tds/conv-' + buildId}, 'manual', false, false,
                      ${fx.agentId}, '{}'::jsonb, '[]'::jsonb, ${ts}, 0)`;
    await sql`insert into step (id,build_id,status,claimed_at,heartbeat_at)
              values (${stepId}, ${buildId}, 'queued', ${ts}, ${ts})`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/machine/tasks/claim',
      headers: { authorization: `Bearer ${fx.machineKey}` },
      payload: { runtimes: ['pi'], concurrency: 6 },
    });
    const body = JSON.parse(res.body) as { secretEnv?: Record<string, string> };
    assert.deepEqual(body.secretEnv ?? {}, {}, '别的项目的 secret 不该被下发');

    await sql`delete from step where id = ${stepId}`;
    await sql`delete from build where id = ${buildId}`;
    await sql`delete from todo where id = ${todoId}`;
    await sql`delete from project where id = ${otherProject}`;
  });

  test('别队的 queued step 不被领走（跨租户凭据泄露防线）', async () => {
    // 回归：claim 曾经只按 `status='queued'` 全局取最老的一条，于是 A 团队的机器
    // 能领到 B 团队的 step。接上 team secrets 之后那不只是「跑错活」——
    // 它会连带把 B 的 secret 明文下发给 A 的机器。
    const ts = now();
    const otherTeamId = newId();
    const otherProjectId = newId();
    const otherTodoId = newId();
    const otherBuildId = newId();
    const otherStepId = newId();

    await sql`insert into team (id,name,plan,storage_quota,created_at)
              values (${otherTeamId}, 'other-team', 'free', 1073741824, ${ts})`;
    await sql`insert into project (id,team_id,name,provider,repo_kind,default_branch,next_seq_num,created_at)
              values (${otherProjectId}, ${otherTeamId}, 'op', 'external', 'other', 'main', 1, ${ts})`;
    await sql`insert into todo (id,project_id,seq_num,owner_member_id,title,phase,plan_first,created_at,updated_at)
              values (${otherTodoId}, ${otherProjectId}, 1, ${fx.memberId}, 'other', 'implement', false, ${ts}, ${ts})`;
    await sql`insert into build (id,todo_id,n,branch,trigger_source,with_plan,with_checklist,agent_id,session,usage_by_model,created_at,v)
              values (${otherBuildId}, ${otherTodoId}, 1, ${'tds/conv-' + otherBuildId}, 'manual', false, false,
                      ${fx.agentId}, '{}'::jsonb, '[]'::jsonb, ${ts}, 0)`;
    await sql`insert into step (id,build_id,status,claimed_at,heartbeat_at)
              values (${otherStepId}, ${otherBuildId}, 'queued', ${ts}, ${ts})`;

    // 别的队的 step 存在、且它更「老」—— 本队没有任何 queued step 可领
    const res = await app.inject({
      method: 'POST',
      url: '/api/machine/tasks/claim',
      headers: { authorization: `Bearer ${fx.machineKey}` },
      payload: { runtimes: ['pi'], concurrency: 6 },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as { stepId: string | null; secretEnv?: Record<string, string> };
    assert.equal(body.stepId, null, '本队没有 queued step 时不该领走别队的 step');
    assert.deepEqual(body.secretEnv ?? {}, {}, '没领到活就不该下发任何 secret');

    // 那个 step 必须还在 queued（没被 A 团队的机器占用）
    const rows = await sql<{ status: string; machine_id: string | null }[]>`
      select status, machine_id from step where id = ${otherStepId}
    `;
    assert.equal(rows[0]?.status, 'queued', '别队的 step 不该被标记成已领取');
    assert.equal(rows[0]?.machine_id, null);

    await sql`delete from step where id = ${otherStepId}`;
    await sql`delete from build where id = ${otherBuildId}`;
    await sql`delete from todo where id = ${otherTodoId}`;
    await sql`delete from project where id = ${otherProjectId}`;
    await sql`delete from team where id = ${otherTeamId}`;
  });

  test('值不进 prompt / 不进 audit（只走 secretEnv 字段）', async () => {
    await seedTeamSecret('API_KEY', 'never-in-prompt');
    await setGrants(true);

    const got = await claim();
    assert.ok(got.prompt !== null);
    assert.ok(!got.prompt.includes('never-in-prompt'), 'secret 值绝不能出现在 prompt 里');
    const audits = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from audit_event where build_id in (select build_id from step)
    `;
    for (const row of audits) {
      assert.ok(
        !JSON.stringify(row.payload).includes('never-in-prompt'),
        'secret 值绝不能写进 audit',
      );
    }
  });
});
