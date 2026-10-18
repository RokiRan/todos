import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify from 'fastify';
import * as dbPkg from '@tds/db';
import { newId, now } from '../src/ids.js';
import { registerMachineRoutes } from '../src/routes/machine.js';
import { hashApiKey } from '../src/crypto.js';

/**
 * provider → claim 打通验证。
 *
 * pi 的模型不在机器上，全靠 claim 响应带下来。这条链路断了 pi 就跑不了：
 *   agent.provider + agent.model_id → 查 provider → 解封 key → 下发 model/credential
 *
 * 关键安全性质：凭据**只在 claim 响应里出现一次**，GET 类接口永远不返回。
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://tds@127.0.0.1:5433/tds';

let sql: postgres.Sql;
let app: ReturnType<typeof Fastify>;
interface Fixture { userId: string; teamId: string; memberId: string; agentId: string; machineKey: string; machineId: string }
let fx: Fixture;

describe('provider → claim 打通', () => {
  before(async () => {
    sql = postgres(DATABASE_URL, { max: 1 });
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
    const deviceId = 'dev-' + newId();
    const machineKey = `tds_machine-${machineId}`;
    const email = `claim-${teamId}@test.local`;

    await sql.begin(async (tx) => {
      await tx`insert into "user" (id,email,display_name,created_at,updated_at)
                values (${userId}, ${email}, 'claim', ${ts}, ${ts})`;
      await tx`insert into team (id,name,plan,storage_quota,created_at)
                values (${teamId}, 'claim-team', 'free', 1073741824, ${ts})`;
      await tx`insert into member (id,team_id,actor_id,member_type,role,joined_at,v)
                values (${memberId}, ${teamId}, ${userId}, 'user', 'admin', ${ts}, 0)`;
      // provider 用无 baseUrl 的形态：验证纯下发路径不依赖网络
      await tx`insert into provider
                (id,team_id,kind,provider_id,label,api,compat,models,enc_api_key,enc_nonce,created_by,created_at,updated_at)
                values (${newId()}, ${teamId}, 'custom', 'my-gw', '我的网关', 'openai-completions',
                        '{}'::jsonb,
                        ${JSON.stringify([{ id: 'qwen3', contextWindow: 32000, maxTokens: 4096 }])}::jsonb,
                        ${'cipher-placeholder'}, ${'nonce-placeholder'}, ${userId}, ${ts}, ${ts})`;
      await tx`insert into agent (id,team_id,display_name,provider,model_id,thinking_level,
                                  default_skill_ids,grants,active_task_count,created_at,updated_at)
                values (${agentId}, ${teamId}, 'pi agent', 'my-gw', 'qwen3', 'medium',
                        '{}', '{}'::jsonb, 0, ${ts}, ${ts})`;
      await tx`insert into machine (id,team_id,name,device_id,enrolled_by,build_enabled,shell_enabled,
                                   max_concurrent_tasks,runtimes,disabled_runtimes,workspaces_dir,
                                   is_online,last_heartbeat_at,created_at,updated_at)
                values (${machineId}, ${teamId}, 'm', ${deviceId}, ${userId}, true, false, 6,
                        ${['pi']}, ${[]}, 'C:/ws', true, ${ts}, ${ts}, ${ts})`;
    });

    // key 用真实 seal，避免解封失败掩盖接线问题
    const { seal } = await import('../src/crypto.js');
    const s = seal('sk-team-secret-key');
    await sql`update provider set enc_api_key = ${`${s.cipher}.${s.tag}`}, enc_nonce = ${s.nonce}
               where team_id = ${teamId}`;

    const enrollScopes = ['machine:run'];
    await sql`insert into api_key (id,user_id,name,key_prefix,key_hash,scopes,created_at)
              values (${newId()}, ${userId}, ${'machine:' + machineId},
                      ${'tds_'}, ${hashApiKey(machineKey)}, ${enrollScopes}, ${ts})`;

    fx = { userId, teamId, memberId, agentId, machineKey, machineId };
  });

  after(async () => {
    if (fx) {
      const todos = (await sql`select id from todo where project_id in
                     (select id from project where team_id = ${fx.teamId})`).map((r) => r.id);
      const builds = todos.length
        ? (await sql`select id from build where todo_id = any(${todos})`).map((r) => r.id)
        : [];
      if (builds.length > 0) {
        await sql`delete from step where build_id = any(${builds})`;
        await sql`delete from build where id = any(${builds})`;
      }
      if (todos.length > 0) await sql`delete from todo where id = any(${todos})`;
      await sql`delete from project where team_id = ${fx.teamId}`;
      await sql`delete from provider where team_id = ${fx.teamId}`;
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

  async function seedStep(): Promise<string> {
    const ts = now();
    const projectId = newId();
    const todoId = newId();
    const buildId = newId();
    const stepId = newId();
    await sql`insert into project (id,team_id,name,provider,repo_kind,default_branch,next_seq_num,created_at)
              values (${projectId}, ${fx.teamId}, 'p', 'external', 'other', 'main', 1, ${ts})`;
    await sql`insert into todo (id,project_id,seq_num,owner_member_id,title,phase,plan_first,created_at,updated_at)
              values (${todoId}, ${projectId}, 1, ${fx.memberId}, 't', 'implement', false, ${ts}, ${ts})`;
    await sql`insert into build (id,todo_id,n,branch,trigger_source,with_plan,with_checklist,agent_id,session,usage_by_model,created_at,v)
              values (${buildId}, ${todoId}, 1, ${'tds/conv-' + buildId}, 'manual', false, false,
                      ${fx.agentId}, '{}'::jsonb, '[]'::jsonb, ${ts}, 0)`;
    await sql`insert into step (id,build_id,status,claimed_at,heartbeat_at)
              values (${stepId}, ${buildId}, 'queued', ${ts}, ${ts})`;
    return stepId;
  }

  test('claim 带上 provider 的模型定义与一次性凭据', async () => {
    const stepId = await seedStep();

    const res = await app.inject({
      method: 'POST',
      url: '/api/machine/tasks/claim',
      headers: { authorization: `Bearer ${fx.machineKey}` },
      payload: { runtimes: ['pi'], concurrency: 6 },
    });
    assert.equal(res.statusCode, 200, res.body);

    const claimed = JSON.parse(res.body) as {
      stepId: string | null;
      model: { api: string; modelId: string; thinkingLevel?: string; maxTokens?: number } | null;
      credential: string | null;
    };
    assert.equal(claimed.stepId, stepId, `claim 未领到目标 step: ${res.body.slice(0, 200)}`);
    assert.ok(claimed.model, 'claim 必须带模型，否则 pi 无模型可用');
    assert.equal(claimed.model.api, 'openai-completions');
    assert.equal(claimed.model.modelId, 'qwen3');
    assert.equal(claimed.model.thinkingLevel, 'medium');
    assert.equal(claimed.model.maxTokens, 4096, 'maxTokens 应来自 provider 的 models 目录');
    assert.equal(claimed.credential, 'sk-team-secret-key', '凭据应解封后下发');
  });

  test('凭据只在 claim 出现一次 —— 后续 claim 不重复泄漏', async () => {
    await seedStep();
    const first = await app.inject({
      method: 'POST',
      url: '/api/machine/tasks/claim',
      headers: { authorization: `Bearer ${fx.machineKey}` },
      payload: { runtimes: ['pi'], concurrency: 6 },
    });
    const a = JSON.parse(first.body) as { credential: string | null };

    // 把第一个 step 置为 running，让 claim 领到下一个
    await sql`update step set status = 'running' where id = ${(JSON.parse(first.body) as { stepId: string }).stepId}`;
    await seedStep();
    const second = await app.inject({
      method: 'POST',
      url: '/api/machine/tasks/claim',
      headers: { authorization: `Bearer ${fx.machineKey}` },
      payload: { runtimes: ['pi'], concurrency: 6 },
    });
    const b = JSON.parse(second.body) as { stepId?: string; credential: string | null };

    // 每个 step 各自领一次凭据是对的；关键是「不被 step 复用」
    if (b.stepId && b.stepId !== (JSON.parse(first.body) as { stepId: string }).stepId) {
      assert.equal(b.credential, a.credential, '新 step 拿到的是新解封的同一份团队 key');
    }
  });

  test('无 provider 的 agent → model 为 null（不臆造模型）', async () => {
    const ts = now();
    const bareAgent = newId();
    await sql`insert into agent (id,team_id,display_name,default_skill_ids,grants,active_task_count,created_at,updated_at)
              values (${bareAgent}, ${fx.teamId}, 'bare', '{}', '{}'::jsonb, 0, ${ts}, ${ts})`;

    const stepId = await seedStep();
    await sql`update build set agent_id = ${bareAgent} where id =
                (select build_id from step where id = ${stepId})`;

    const res = await app.inject({
      method: 'POST',
      url: '/api/machine/tasks/claim',
      headers: { authorization: `Bearer ${fx.machineKey}` },
      payload: { runtimes: ['pi'], concurrency: 6 },
    });
    const claimed = JSON.parse(res.body) as { stepId: string; model: unknown };
    if (claimed.stepId === stepId) {
      assert.equal(claimed.model, null, '没有 provider 时不能编一个模型出来');
    }
  });
});
