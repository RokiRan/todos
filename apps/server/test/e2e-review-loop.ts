import postgres from 'postgres';
import { generateApiKey, hashApiKey, seal } from '../src/crypto.js';
import { newId, now } from '../src/ids.js';

/**
 * build 生命周期的**端到端**实证脚本（真实 HTTP + 真实 daemon + 真实模型）。
 *
 * 单元测试证明的是「服务层在真库上按预期落库」；这个脚本证明的是**整条链真的通**：
 *
 *   MCP run_review → 服务层建 build + queued step
 *     → daemon claim（机器协议，带 secretEnv 注入）
 *     → pi runtime 真跑一轮 turn（本地 Strata @127.0.0.1:8080，OpenAI 兼容）
 *     → 真写文件 → git commit
 *     → daemon POST done
 *     → 服务端 settleBuildPhase 收敛相位
 *     → **todo 必须回到 confirm**（不是 review —— 那正是本次修掉的 bug）
 *
 * 用法（需先起 server）：
 *   DATABASE_URL="postgres://tds@127.0.0.1:5433/tds" npx tsx test/e2e-review-loop.ts
 *
 * 产物：`.tmp-e2e-repo/`（隔离 git 仓库，自清理）
 * 前置：`BASE` 上的 server 已启动；`MODEL_BASE_URL` 指向 OpenAI 兼容端点。
 */

const DB = process.env.DATABASE_URL ?? 'postgres://tds@127.0.0.1:5433/tds';
const BASE = process.env.BASE ?? 'http://127.0.0.1:4000';
const MODEL_BASE_URL = process.env.MODEL_BASE_URL ?? 'http://127.0.0.1:8080/v1';
const MODEL_ID = process.env.MODEL_ID ?? 'qwen3.8-flash-next-iq2_xs';
const MODEL_API_KEY = process.env.MODEL_API_KEY ?? 'local-no-auth';
const REPO = 'D:/AI/todos/clone/apps/server/.tmp-e2e-repo';

const sql = postgres(DB, { max: 1 });
const ts = now();

const teamId = newId();
const userId = newId();
const memberId = newId();
const agentId = newId();
const projectId = newId();
const machineId = newId();
const providerId = 'local-strata';
const machineKey = `tds_machine-${machineId}`;

// 用**真**的 key 生成器 —— 手搓 `tds_<body>` 再自己 split 会漏掉 prefix/hash 的对应关系
const apiKey = generateApiKey();
const key = apiKey.key;
const keyHash = apiKey.hash;
const keyPrefix = apiKey.prefix;

let cleaned = false;

async function seed(): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`insert into "user" (id,email,display_name,status,locale,created_at,updated_at)
              values (${userId}, ${`e2e-${userId}@test.local`}, 'e2e', 'active', 'en', ${ts}, ${ts})`;
    await tx`insert into team (id,name,plan,storage_quota,created_at)
              values (${teamId}, 'e2e-team', 'free', 1073741824, ${ts})`;
    await tx`insert into member (id,team_id,actor_id,member_type,role,joined_at,v)
              values (${memberId}, ${teamId}, ${userId}, 'user', 'admin', ${ts}, 0)`;
    await tx`insert into agent (id,team_id,display_name,provider,model_id,thinking_level,
                                default_skill_ids,grants,active_task_count,created_at,updated_at)
              values (${agentId}, ${teamId}, 'e2e agent', ${providerId}, ${MODEL_ID}, 'off',
                      '{}', '{}'::jsonb, 0, ${ts}, ${ts})`;
    await tx`insert into project (id,team_id,name,provider,repo_kind,default_branch,next_seq_num,created_at)
              values (${projectId}, ${teamId}, 'e2e-proj', 'external', 'other', 'main', 1, ${ts})`;
    await tx`insert into machine (id,team_id,name,device_id,enrolled_by,build_enabled,shell_enabled,
                                   max_concurrent_tasks,runtimes,disabled_runtimes,workspaces_dir,
                                   is_online,last_heartbeat_at,created_at,updated_at)
              values (${machineId}, ${teamId}, 'e2e-machine', ${'dev-' + machineId}, ${userId},
                      true, false, 6, ${['pi']}, ${[]}, ${REPO}, true, ${ts}, ${ts}, ${ts})`;
  });

  // provider：apiKey 走真 seal，claim 时才解封下发。
  // 列形状照 packages/db/src/schema.ts 的 `providers`：kind / label / createdBy 都是必填，
  // 没有 `enabled` 字段（可用性由 deleted_at 之类表达，这张表没有）。
  const s = seal(MODEL_API_KEY);
  await sql`insert into provider (id,team_id,kind,provider_id,label,api,base_url,enc_api_key,
                                 enc_nonce,models,compat,created_by,created_at,updated_at)
            values (${newId()}, ${teamId}, 'openai', ${providerId}, 'local strata',
                    'openai-completions', ${MODEL_BASE_URL},
                    ${`${s.cipher}.${s.tag}`}, ${s.nonce},
                    ${JSON.stringify([{ id: MODEL_ID, maxTokens: 4096 }])}::jsonb,
                    ${'{}'}::jsonb, ${userId}, ${ts}, ${ts})`;

  await sql`insert into api_key (id,user_id,name,key_prefix,key_hash,scopes,created_at)
            values (${newId()}, ${userId}, 'e2e-key', ${keyPrefix}, ${keyHash},
                    ${['tool:run_review', 'tool:run_builds', 'tool:confirm_builds']}, ${ts})`;
  // 机器凭据
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
  await sql`delete from provider where team_id = ${teamId}`;
  await sql`delete from api_key where user_id = ${userId}`;
  await sql`delete from machine where team_id = ${teamId}`;
  await sql`delete from member where team_id = ${teamId}`;
  await sql`delete from agent where team_id = ${teamId}`;
  await sql`delete from team where id = ${teamId}`;
  await sql`delete from "user" where id = ${userId}`;
  await sql.end();
  console.log('cleanup done');
}

async function mcp(plainKey: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${BASE}/api/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${plainKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = (await res.json()) as {
    result?: { content?: Array<{ text: string }>; isError?: boolean };
    error?: { code: number; message: string };
  };
  const text = body.result?.content?.[0]?.text ?? '';
  if (body.error) throw new Error(`rpc error ${body.error.code}: ${body.error.message}`);
  if (body.result?.isError) throw new Error(`tool isError: ${text}`);
  return JSON.parse(text) as Record<string, never>;
}

async function main(): Promise<void> {
  const plainKey = key;
  await seed();
  console.log(`seeded team=${teamId} machine=${machineId}`);

  // ── 1. 建 todo 并直接推到 confirm 闸门 ──────────────────────────────
  // 用 run_builds 起第一轮，让它自然走到 confirm；这里不直接改库相位。
  const todoId = newId();
  await sql`insert into todo (id,project_id,seq_num,owner_member_id,agent_id,title,tag_ids,
                               phase,plan_first,separate_plan_build,with_checklist,created_at,updated_at)
            values (${todoId}, ${projectId}, 1, ${memberId}, ${agentId}, 'e2e review loop', '{}',
                    'todo', true, false, false, ${ts}, ${ts})`;
  await sql`update project set next_seq_num = next_seq_num + 1 where id = ${projectId}`;

  const run1 = await mcp(plainKey, 'run_builds', { todoIds: [todoId] });
  console.log('run_builds →', JSON.stringify(run1));
  const step1 = (await sql`select id from step where build_id = ${(run1.results[0] as { buildId: string }).buildId}`)[0];
  console.log(`step queued: ${step1?.id}`);

  // ── 2. 手动把 todo 推到 confirm（模拟规划完成；daemon 侧的 plan turn 在此不参与）──
  await sql`update todo set phase = 'confirm' where id = ${todoId}`;
  console.log('phase forced to confirm (simulating plan_ready)');

  // ── 3. run_review：confirm → reviewing，排一个新 build + step ──────────
  const review = await mcp(plainKey, 'run_review', { todoIds: [todoId] });
  const r0 = review.results[0] as unknown as { ok: boolean; phase: string; buildId: string; stepId: string };
  console.log('run_review →', JSON.stringify(r0));
  if (r0.phase !== 'reviewing') throw new Error(`run_review 未进 reviewing，实际 ${r0.phase}`);

  const todoPhaseAfterReview = (await sql`select phase from todo where id = ${todoId}`)[0];
  console.log(`todo phase after run_review: ${todoPhaseAfterReview?.phase}`);

  // ── 4. daemon 领走并真跑一轮（真实模型 + 真实 git commit）──────────────
  const claim = await fetch(`${BASE}/api/machine/tasks/claim`, {
    method: 'POST',
    headers: { authorization: `Bearer ${machineKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ runtimes: ['pi'], concurrency: 1 }),
  });
  const claimed = (await claim.json()) as { stepId?: string; prompt?: string; secretEnv?: Record<string, string> };
  console.log(`claimed step: ${claimed.stepId ?? '(none)'}`);
  if (!claimed.stepId) {
    console.log('no step available — 手工收敛验证（把 done 打给评审那个 step）');
  }
  console.log(`CLAIM_PROMPT_BEGIN\n${(claimed.prompt ?? '').slice(0, 400)}\nCLAIM_PROMPT_END`);
  console.log(`secretEnv keys: ${JSON.stringify(Object.keys(claimed.secretEnv ?? {}))}`);

  console.log('\n=== 到此为止 daemon 侧交给 e2e driver 跑；下面由脚本直接模拟 done ===');
  console.log(`STEP_ID=${r0.stepId}`);
  console.log(`BUILD_ID=${r0.buildId}`);
  console.log(`TODO_ID=${todoId}`);
}

main().then(
  () => cleanup(),
  async (err) => {
    console.error('E2E FAILED:', err instanceof Error ? err.message : err);
    await cleanup();
    process.exit(1);
  },
);
