import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import * as dbPkg from '@tds/db';
import { newId, now } from '../src/ids.js';
import { registerMachineRoutes } from '../src/routes/machine.js';
import { hashApiKey, seal } from '../src/crypto.js';

/**
 * `/api/machine/tasks/claim` 的 runtime 选择契约（2026-10-18 切面）。
 *
 * 根因（旧实现 `apps/server/src/routes/machine.ts:310` 原本 `body.runtimes[0] ?? null`）：
 *   daemon 上报的 `runtimes` 列表顺序与 build agent 的 provider api 无关，
 *   选 `runtimes[0]` 会把不兼容的 driver 领到活（claude-code 拿到 openai 端点
 *   → `--model qwen…` + `ANTHROPIC_API_KEY=<sk-team>` 但没 `ANTHROPIC_BASE_URL`
 *   → 静默卡死 19 分钟）。
 *
 * 兼容表实测依据：
 *   pi           ALL                              apps/daemon/src/drivers/pi.ts:117-129
 *   claude-code  anthropic-messages               apps/daemon/src/drivers/claude-code.ts:122-148
 *   omp          openai-completions/responses     apps/daemon/src/drivers/omp.ts:175-185
 *   codex        (STUB，不读 model/credential)    apps/daemon/src/drivers/codex.ts:90-99
 *
 * 三条契约：
 *   1. provider api=openai-completions + runtimes=[pi,claude-code,omp] → runtime=pi
 *      （兼容表里 pi 唯一兼容 openai-completions；claude-code/omp 不出现在
 *       这里是因为测试 agent 选的是 openai-completions。注：omp 也兼容
 *       openai-completions，这里加 omp 是为了证明「不是无脑取 0」）
 *   2. provider api=anthropic-messages → 选第一个 anthropic 兼容的 runtime
 *      （claude-code 排第一；pi 也兼容，但选第一个）
 *   3. 没有任何上报 runtime 兼容时 → 响应 stepId=null + audit_event 有记录
 *      + step.status 保持 queued（绝不静默标 failed）
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://tds@127.0.0.1:5433/tds';

let sql: postgres.Sql;
let app: FastifyInstance;
interface Fixture {
  userId: string;
  teamId: string;
  memberId: string;
  agentId: string;
  machineKey: string;
  machineId: string;
  projectId: string;
  providerId: string;
}
let fx: Fixture;

async function resetAgentProvider(providerId: string, modelId: string, api: string): Promise<void> {
  // 把 agent 的 provider/modelId 与团队 provider 配齐；用真 seal 让解封链路
  // 不掩盖接线问题。
  await sql`update agent set provider = ${providerId}, model_id = ${modelId} where id = ${fx.agentId}`;
  await sql`update provider set api = ${api} where id = ${fx.providerId}`;
}

describe('claim runtime × provider api 兼容选择', () => {
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
    const projectId = newId();
    const providerId = newId();
    const deviceId = 'dev-' + newId();
    const machineKey = `tds_machine-${machineId}`;
    const email = `claim-rt-${teamId}@test.local`;

    await sql.begin(async (tx) => {
      await tx`insert into "user" (id,email,display_name,created_at,updated_at)
                values (${userId}, ${email}, 'claim-rt', ${ts}, ${ts})`;
      await tx`insert into team (id,name,plan,storage_quota,created_at)
                values (${teamId}, 'claim-rt-team', 'free', 1073741824, ${ts})`;
      await tx`insert into member (id,team_id,actor_id,member_type,role,joined_at,v)
                values (${memberId}, ${teamId}, ${userId}, 'user', 'admin', ${ts}, 0)`;
      // provider 留到具体 test 再覆写 api（openai-completions / anthropic-messages）。
      // 模型列表里给一个固定的 modelId，agent 用这个 id。
      await tx`insert into provider
                (id,team_id,kind,provider_id,label,api,compat,models,enc_api_key,enc_nonce,created_by,created_at,updated_at)
                values (${providerId}, ${teamId}, 'custom', 'rt-gw', 'RT 网关', 'openai-completions',
                        ${'{}'}::jsonb,
                        ${JSON.stringify([{ id: 'm-1', contextWindow: 32000, maxTokens: 4096 }])}::jsonb,
                        ${'cipher-placeholder'}, ${'nonce-placeholder'}, ${userId}, ${ts}, ${ts})`;
      await tx`insert into agent (id,team_id,display_name,provider,model_id,thinking_level,
                                  default_skill_ids,grants,active_task_count,created_at,updated_at)
                values (${agentId}, ${teamId}, 'rt agent', 'rt-gw', 'm-1', 'medium',
                        ${'{}'}::text[], ${'{}'}::jsonb, 0, ${ts}, ${ts})`;
      await tx`insert into project (id,team_id,name,provider,repo_kind,default_branch,next_seq_num,created_at)
                values (${projectId}, ${teamId}, 'p', 'external', 'other', 'main', 1, ${ts})`;
      await tx`insert into machine (id,team_id,name,device_id,enrolled_by,build_enabled,shell_enabled,
                                   max_concurrent_tasks,runtimes,disabled_runtimes,workspaces_dir,
                                   is_online,last_heartbeat_at,created_at,updated_at)
                values (${machineId}, ${teamId}, 'm', ${deviceId}, ${userId}, true, false, 6,
                        ${['pi']}, ${[]}, 'C:/ws', true, ${ts}, ${ts}, ${ts})`;

    });

    // provider 用真 seal 解封（解封路径与生产一致；解封失败会掩盖 wiring 问题）
    const s = seal('sk-rt-test-team-secret');
    await sql`update provider set enc_api_key = ${`${s.cipher}.${s.tag}`}, enc_nonce = ${s.nonce}
               where id = ${providerId}`;

    await sql`insert into api_key (id,user_id,name,key_prefix,key_hash,scopes,created_at)
              values (${newId()}, ${userId}, ${'machine:' + machineId}, ${'tds_'},
                      ${hashApiKey(machineKey)}, ${['machine:run']}, ${ts})`;

    fx = { userId, teamId, memberId, agentId, machineKey, machineId, projectId, providerId };
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
      await sql`delete from audit_event where team_id = ${fx.teamId}`;
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

  let seqCounter = 0;

  async function seedStep(): Promise<string> {
    const ts = now();
    const todoId = newId();
    const buildId = newId();
    const stepId = newId();
    // `todo_project_seq_uq` 是 (project_id, seq_num) 唯一。三条 test 各 seed 一次，
    // 写死 seq_num=1 会在第二条撞唯一键（实测 `duplicate key value violates
    // unique constraint "todo_project_seq_uq"`）。每轮递增并同步推进
    // project.next_seq_num，免得服务层再算序号时撞上。
    seqCounter += 1;
    await sql`insert into todo (id,project_id,seq_num,owner_member_id,title,phase,plan_first,created_at,updated_at)
              values (${todoId}, ${fx.projectId}, ${seqCounter}, ${fx.memberId}, 't', 'implement', false, ${ts}, ${ts})`;
    await sql`update project set next_seq_num = ${seqCounter + 1} where id = ${fx.projectId}`;
    await sql`insert into build (id,todo_id,n,branch,trigger_source,with_plan,with_checklist,agent_id,session,usage_by_model,created_at,v)
              values (${buildId}, ${todoId}, 1, ${'tds/conv-' + buildId}, 'manual', false, false,
                      ${fx.agentId}, ${'{}'}::jsonb, ${'[]'}::jsonb, ${ts}, 0)`;
    await sql`insert into step (id,build_id,status,claimed_at,heartbeat_at)
              values (${stepId}, ${buildId}, 'queued', ${ts}, ${ts})`;
    return stepId;
  }

  /**
   * 第一条契约：provider api = openai-completions，daemon 上报
   *   runtimes = ['pi', 'claude-code', 'omp']
   * → 下发的 runtime 必须是 `pi`（兼容表里 pi 唯一兼容 openai-completions
   *   的「真 SDK driver」，claude-code 必失败 env 错配）。
   *
   * 旧实现取 `runtimes[0]` 也会返回 'pi'，但**仅当**这台机器的列表顺序碰巧
   * 是这个。本测试用更长的列表避免顺序偶然性。
   * 关键证据：claude-code 不出现在返回里。
   */
  test('openai-completions + runtimes=[pi,claude-code,omp] → runtime=pi', async () => {
    await resetAgentProvider('rt-gw', 'm-1', 'openai-completions');
    const stepId = await seedStep();

    const res = await app.inject({
      method: 'POST',
      url: '/api/machine/tasks/claim',
      headers: { authorization: `Bearer ${fx.machineKey}` },
      payload: { runtimes: ['pi', 'claude-code', 'omp'], concurrency: 6 },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as {
      stepId: string | null;
      runtime: string | null;
      model: { api: string; modelId: string } | null;
    };
    assert.equal(body.stepId, stepId, `claim 未领到目标 step: ${res.body.slice(0, 200)}`);
    assert.equal(body.runtime, 'pi', `openai-completions 下必须选 pi；收到 ${body.runtime}`);
    assert.equal(body.model?.api, 'openai-completions');
  });

  /**
   * 第二条契约：provider api = anthropic-messages。
   * 上报 runtimes = ['omp', 'pi', 'claude-code']
   * → 选第一个 anthropic 兼容的 runtime（这里 omp 不兼容、pi 兼容、claude-code 兼容；
   *   旧实现 `body.runtimes[0]` 会错选 'omp'，本测试钉这条）。
   */
  test('anthropic-messages + runtimes=[omp,pi,claude-code] → runtime=pi（第一个 anthropic 兼容的）', async () => {
    await resetAgentProvider('rt-gw', 'm-1', 'anthropic-messages');
    const stepId = await seedStep();

    const res = await app.inject({
      method: 'POST',
      url: '/api/machine/tasks/claim',
      headers: { authorization: `Bearer ${fx.machineKey}` },
      payload: { runtimes: ['omp', 'pi', 'claude-code'], concurrency: 6 },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as {
      stepId: string | null;
      runtime: string | null;
      model: { api: string } | null;
    };
    assert.equal(body.stepId, stepId, `claim 未领到目标 step: ${res.body.slice(0, 200)}`);
    // omp 是 openai only；claim 必须跳过 omp 选 pi（第一个 anthropic 兼容的）
    assert.equal(body.runtime, 'pi', `anthropic-messages 下首个 anthropic 兼容的必须是 pi（旧 bug 会选 omp）；收到 ${body.runtime}`);
    assert.equal(body.model?.api, 'anthropic-messages');
  });

  /**
   * 第三条契约：provider api 配了（anthropic-messages），但 daemon 上报的
   * `runtimes` 里**没有任何**兼容的（这里只报 omp —— openai only）。
   * → 响应 stepId=null（不能编一个 runtime 出来）
   * → step.status 仍是 queued（不能悄悄标 failed —— 让用户以为 agent 跑挂）
   * → audit_event 落一条 type='step_claim_rejected'，payload 里能读到原因
   */
  test('没有任何上报 runtime 兼容 → stepId=null + step 不动 + audit_event 留痕', async () => {
    await resetAgentProvider('rt-gw', 'm-1', 'anthropic-messages');
    const stepId = await seedStep();

    const res = await app.inject({
      method: 'POST',
      url: '/api/machine/tasks/claim',
      headers: { authorization: `Bearer ${fx.machineKey}` },
      payload: { runtimes: ['omp'], concurrency: 6 },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as {
      stepId: string | null;
      runtime: string | null;
      model: unknown;
    };
    assert.equal(body.stepId, null, '无人兼容 runtime 时不能 claim 出 stepId');
    assert.equal(body.runtime, null);
    assert.equal(body.model, null);

    // step 必须保持 queued（关键约束：禁止静默标 failed，那会让用户误判 agent 挂了）
    const stepAfter = (await sql`select status from step where id = ${stepId}`).map((r) => r.status);
    assert.equal(stepAfter[0], 'queued', `step 必须是 queued（禁止改 failed）；收到 ${stepAfter[0]}`);

    // audit_event 必须落一条 step_claim_rejected，能读到原因
    const rows = await sql`
      select type, payload from audit_event
      where team_id = ${fx.teamId}
        and type = 'step_claim_rejected'
        and payload->>'stepId' = ${stepId}
      order by id desc limit 1
    `;
    assert.equal(rows.length, 1, '必须落一条 step_claim_rejected audit 记录');
    const payload = rows[0].payload as Record<string, unknown>;
    assert.match(String(payload.reason ?? ''), /anthropic-messages/, 'reason 要带 provider api');
    assert.deepEqual(payload.runtimes, ['omp']);
    assert.equal(payload.providerApi, 'anthropic-messages');
  });
});