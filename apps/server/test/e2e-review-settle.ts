import postgres from 'postgres';
import { stepApi } from '@tds/protocol';
import { generateApiKey, hashApiKey, seal } from '../src/crypto.js';
import { newId, now } from '../src/ids.js';

/**
 * **本次修掉的 bug 的端到端实证**：reviewing 相位跑完后必须回 `confirm`。
 *
 * 背景：`routes/machine.ts` 的 `POST done` 曾按 `body.status` 硬编码
 * `succeeded → 'review'`，不看 todo 当时的相位 —— 于是 `run_review` 把 todo
 * 送进 `reviewing` 后，跑完一轮就被硬写成 `review`，**直接跳过 Confirm 闸门**。
 * 单元测试（`test/machine-done-settlement.test.ts`）在真库上钉住了这一点；
 * 这个脚本用**真实 HTTP**（真 server 进程 + 真 MCP 工具 + 真机器协议）再走一遍，
 * 排除「只有 app.inject 能复现、真实链路其实不同」的可能。
 *
 * 用法（需先起 server）：
 *   TDS_KEK=<32 字节 base64> DATABASE_URL="postgres://tds@127.0.0.1:5433/tds" \
 *   npx tsx test/e2e-review-settle.ts
 */

const DB = process.env.DATABASE_URL ?? 'postgres://tds@127.0.0.1:5433/tds';
const BASE = process.env.BASE ?? 'http://127.0.0.1:4000';

const sql = postgres(DB, { max: 1 });
const ts = now();

const teamId = newId();
const userId = newId();
const memberId = newId();
const agentId = newId();
const projectId = newId();
const machineId = newId();
const machineKey = `tds_machine-${machineId}`;
const apiKey = generateApiKey();

let cleaned = false;

async function seed(): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`insert into "user" (id,email,display_name,status,locale,created_at,updated_at)
              values (${userId}, ${`e2es-${userId}@test.local`}, 'e2es', 'active', 'en', ${ts}, ${ts})`;
    await tx`insert into team (id,name,plan,storage_quota,created_at)
              values (${teamId}, 'e2es-team', 'free', 1073741824, ${ts})`;
    await tx`insert into member (id,team_id,actor_id,member_type,role,joined_at,v)
              values (${memberId}, ${teamId}, ${userId}, 'user', 'admin', ${ts}, 0)`;
    await tx`insert into agent (id,team_id,display_name,default_skill_ids,grants,active_task_count,created_at,updated_at)
              values (${agentId}, ${teamId}, 'e2es agent', '{}', '{}'::jsonb, 0, ${ts}, ${ts})`;
    await tx`insert into project (id,team_id,name,provider,repo_kind,default_branch,next_seq_num,created_at)
              values (${projectId}, ${teamId}, 'e2es-proj', 'external', 'other', 'main', 1, ${ts})`;
    await tx`insert into machine (id,team_id,name,device_id,enrolled_by,build_enabled,shell_enabled,
                                   max_concurrent_tasks,runtimes,disabled_runtimes,workspaces_dir,
                                   is_online,last_heartbeat_at,created_at,updated_at)
              values (${machineId}, ${teamId}, 'e2es-machine', ${'dev-' + machineId}, ${userId},
                      true, false, 6, ${['pi']}, ${[]}, 'C:/ws', true, ${ts}, ${ts}, ${ts})`;
  });
  await sql`insert into api_key (id,user_id,name,key_prefix,key_hash,scopes,created_at)
            values (${newId()}, ${userId}, 'e2es-key', ${apiKey.prefix}, ${apiKey.hash},
                    ${['tool:run_review']}, ${ts})`;
  await sql`insert into api_key (id,user_id,name,key_prefix,key_hash,scopes,created_at)
            values (${newId()}, ${userId}, ${'machine:' + machineId}, ${'tds_'},
                    ${hashApiKey(machineKey)}, ${['machine:run']}, ${ts})`;
}

async function cleanup(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  const todos = (await sql`select id from todo where project_id = ${projectId}`).map((r) => r.id);
  if (todos.length > 0) {
    const builds = (await sql`select id from build where todo_id = any(${todos})`).map((r) => r.id);
    if (builds.length > 0) await sql`delete from step where build_id = any(${builds})`;
    await sql`delete from build where todo_id = any(${todos})`;
  }
  await sql`delete from todo where project_id = ${projectId}`;
  await sql`delete from sse_event where team_id = ${teamId}`;
  await sql`delete from audit_event where team_id = ${teamId}`;
  await sql`delete from project where id = ${projectId}`;
  await sql`delete from api_key where user_id = ${userId}`;
  await sql`delete from machine where team_id = ${teamId}`;
  await sql`delete from member where team_id = ${teamId}`;
  await sql`delete from agent where team_id = ${teamId}`;
  await sql`delete from team where id = ${teamId}`;
  await sql`delete from "user" where id = ${userId}`;
  await sql.end();
}

async function mcp(name: string, args: Record<string, unknown>) {
  const res = await fetch(`${BASE}/api/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = (await res.json()) as {
    result?: { content?: Array<{ text: string }>; isError?: boolean };
    error?: { code: number; message: string };
  };
  if (body.error) throw new Error(`rpc error ${body.error.code}: ${body.error.message}`);
  const text = body.result?.content?.[0]?.text ?? '';
  if (body.result?.isError) throw new Error(`tool isError: ${text}`);
  return JSON.parse(text) as { results: Array<{ todoId: string; ok: boolean; phase: string; buildId: string; stepId: string }> };
}

async function machineDone(stepId: string, status: 'succeeded' | 'failed' | 'cancelled') {
  const res = await fetch(`${BASE}${stepApi.done(stepId)}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${machineKey}`, 'content-type': 'application/json' },
    // stepId 要同时出现在 URL 与 body（DoneSchema 要求）
    body: JSON.stringify({ stepId, status }),
  });
  const text = await res.text();
  return { status: res.status, body: text };
}

async function phaseOf(todoId: string): Promise<string> {
  return (await sql`select phase from todo where id = ${todoId} limit 1`)[0]?.phase ?? '';
}

async function main(): Promise<void> {
  await seed();

  const todoId = newId();
  await sql`insert into todo (id,project_id,seq_num,owner_member_id,agent_id,title,tag_ids,
                               phase,plan_first,separate_plan_build,with_checklist,created_at,updated_at)
            values (${todoId}, ${projectId}, 1, ${memberId}, ${agentId}, 'e2e settle', '{}',
                    'confirm', true, false, false, ${ts}, ${ts})`;
  await sql`update project set next_seq_num = next_seq_num + 1 where id = ${projectId}`;
  console.log(`1. todo 建在 confirm 闸门：${await phaseOf(todoId)}`);

  const review = (await mcp('run_review', { todoIds: [todoId] })).results[0];
  console.log(`2. run_review → phase=${review.phase} buildId=${review.buildId} stepId=${review.stepId}`);
  if (review.phase !== 'reviewing') throw new Error(`run_review 未进 reviewing：${review.phase}`);

  // 机器领走评审那个 step 并报成功（真实 HTTP 机器协议）
  const claim = await fetch(`${BASE}/api/machine/tasks/claim`, {
    method: 'POST',
    headers: { authorization: `Bearer ${machineKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ runtimes: ['pi'], concurrency: 1 }),
  });
  const claimed = (await claim.json()) as { stepId?: string };
  if (claimed.stepId !== review.stepId) {
    console.log(`   (claim 领到的是 ${claimed.stepId}，与评审 step ${review.stepId} 不同)`);
  }
  const doneRes = await machineDone(review.stepId, 'succeeded');
  console.log(`3. POST done(succeeded) → HTTP ${doneRes.status} ${doneRes.body}`);

  const settled = await phaseOf(todoId);
  console.log(`4. 收敛后 todo 相位 = ${settled}`);

  if (settled === 'review') {
    throw new Error('BUG 仍在：reviewing 跑完落到了 review —— Confirm 闸门被跳过了');
  }
  if (settled !== 'confirm') {
    throw new Error(`落点既不是 confirm 也不是 review，实际 ${settled} —— 与预期不符`);
  }
  console.log('\n✅ reviewing 跑完回到 confirm，Confirm 闸门没有被跳过');

  // 审计里应能看到 step_succeeded 且 step/build 都落终态
  const buildRow = await sql`select finished_at from build where id = ${review.buildId}`;
  const stepRow = await sql`select status, finished_at from step where id = ${review.stepId}`;
  console.log(`   build.finished_at=${buildRow[0]?.finished_at}  step.status=${stepRow[0]?.status} finished=${stepRow[0]?.finished_at}`);
  if (!buildRow[0]?.finished_at) throw new Error('build 没标终态');
  if (stepRow[0]?.status !== 'succeeded') throw new Error('step 状态不对');

  // phase_changed 必须双发（看板 team: + 详情页 todo:）
  const scopes = (await sql<{ scope: string }[]>`
    select scope from sse_event where payload->>'todoId' = ${todoId} and type = 'phase_changed'
  `).map((r) => r.scope);
  console.log(`   phase_changed scopes: ${JSON.stringify(scopes)}`);
  if (!scopes.includes(`team:${teamId}`) || !scopes.includes(`todo:${todoId}`)) {
    throw new Error(`phase_changed 没双发：${JSON.stringify(scopes)}`);
  }
  console.log('✅ 双 scope 事件齐全');
}

main().then(
  async () => { await cleanup(); console.log('cleanup done'); },
  async (err) => {
    console.error('E2E FAILED:', err instanceof Error ? err.message : err);
    await cleanup();
    process.exit(1);
  },
);
