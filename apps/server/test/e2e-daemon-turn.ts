import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { generateApiKey, hashApiKey, seal } from '../src/crypto.js';
import { newId, now } from '../src/ids.js';
// 静态 import：Worker / ServerClient 的路径在写代码时就已知，无需动态加载。
// daemon 被 server 的测试脚本直接 import —— 两者共用 `@tds/db` 与 `@tds/protocol`，
// 跑在同一个 tsx 进程里。
import { Worker } from '../../daemon/src/worker.js';
import { ServerClient } from '../../daemon/src/server-client.js';
import { PATHS } from '../../daemon/src/paths.js';

/**
 * daemon 端到端实证：**模型真的改代码**那一段。
 *
 * 已经实证过的段（`test/e2e-review-settle.ts`）：
 *   MCP run_review → 建 build+step → claim → POST done → 相位收敛回 confirm
 * 缺的正是这一段：daemon 领到 step 后，**pi runtime 真调一次本地模型**、
 * 真写文件、真 git commit、真抓 diff、真上报 done。
 *
 * 这条链此前只有单元测试（daemon 49 + server 608）。单元测试证明的是
 * 「给定 fake driver 时 worker 的编排正确」，证明不了：
 *   - pi driver 能不能真的把 prompt 送到 OpenAI 兼容端点并拿到回复
 *   - `reasoning_content` 吃掉 max_tokens 时会不会解析成空回复
 *   - git 那三步（commit / collectDiff / 落地）在真仓库上成不成立
 *
 * 用法（需先起 server）。`TDS_HOME` / `TDS_WORKSPACES_DIR` 要在这条命令里给
 * —— 它们是 daemon `paths.ts` import 时读的，进程起来之后再赋就晚了：
 *   TDS_KEK=<32 字节 base64> DATABASE_URL="postgres://tds@127.0.0.1:5433/tds" \
 *   MODEL_BASE_URL=http://127.0.0.1:8080/v1 \
 *   E2E_REPO_DIR=… E2E_HOME=… TDS_HOME=$E2E_HOME npx tsx test/e2e-daemon-turn.ts
 */

const exec = promisify(execFile);
const DB = process.env.DATABASE_URL ?? 'postgres://tds@127.0.0.1:5433/tds';
const BASE = process.env.BASE ?? 'http://127.0.0.1:4000';
const MODEL_BASE_URL = process.env.MODEL_BASE_URL ?? 'http://127.0.0.1:8080/v1';
const MODEL_ID = process.env.MODEL_ID ?? 'qwen3.8-flash-next-iq2_xs';
const MODEL_API_KEY = process.env.MODEL_API_KEY ?? 'local-no-auth';
/**
 * 隔离仓库 / daemon home 放在仓库内，脚本结束自清理。
 *
 * 为什么走 env 而不是写死：这两个值原本是硬编码的 Windows 绝对路径
 * `D:/AI/todos/clone/...`。换到别的机器（例如服务端跑在树莓派上）就是无效路径
 * —— `mkdirSync('D:/AI/...')` 在 Linux 上会创建一个名叫 `D:` 的目录而不是报错，
 * 症状是「跑起来了但工作区在奇怪的地方」。`repo_url` 也是从这里拼出来的
 * （`'file:///' + REPO_DIR`），所以必须跟着一起可覆盖。
 */
const REPO_DIR = process.env.E2E_REPO_DIR ?? 'D:/AI/todos/clone/apps/server/.tmp-e2e-turn-repo';
const TDS_HOME = process.env.E2E_HOME ?? 'D:/AI/todos/clone/apps/server/.tmp-e2e-turn-home';

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
const apiKey = generateApiKey();

let cleaned = false;

/** build 工作区的实际落点（`PATHS.workspaces/<buildId>`），cleanup 用它收尾 */
let workspaceBuildId: string | null = null;

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, windowsHide: true });
  return stdout.trim();
}

/** 建一个真实的 git 仓库当 build 的工作区（daemon 会 clone 它）。 */
async function seedRepo(): Promise<void> {
  // 用 fs 而不是 powershell：`Remove-Item` 在路径不存在时返回 exit 1，
  // 即便加了 -ErrorAction SilentlyContinue 也会把脚本带崩。
  fs.rmSync(REPO_DIR, { recursive: true, force: true });
  fs.mkdirSync(REPO_DIR, { recursive: true });
  // `git init -b <branch>` 要 git ≥2.28。树莓派上 Ubuntu 20.04 自带 git 2.25.1，
  // 直接报 `unknown switch 'b'`（实测踩过）。`symbolic-ref HEAD` 是所有版本都
  // 支持的等价写法，且必须在首次 commit 之前执行。
  await git(['init'], REPO_DIR);
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], REPO_DIR);
  await git(['config', 'user.email', 'e2e@test.local'], REPO_DIR);
  await git(['config', 'user.name', 'e2e'], REPO_DIR);
  fs.writeFileSync(`${REPO_DIR}/README.md`, '# e2e repo\n\n原文件，别改。\n', 'utf8');
  await git(['add', '.'], REPO_DIR);
  await git(['commit', '-m', 'init'], REPO_DIR);
}

async function seed(): Promise<void> {
  await seedRepo();
  await sql.begin(async (tx) => {
    await tx`insert into "user" (id,email,display_name,status,locale,created_at,updated_at)
              values (${userId}, ${`e2et-${userId}@test.local`}, 'e2et', 'active', 'en', ${ts}, ${ts})`;
    await tx`insert into team (id,name,plan,storage_quota,created_at)
              values (${teamId}, 'e2et-team', 'free', 1073741824, ${ts})`;
    await tx`insert into member (id,team_id,actor_id,member_type,role,joined_at,v)
              values (${memberId}, ${teamId}, ${userId}, 'user', 'admin', ${ts}, 0)`;
    await tx`insert into agent (id,team_id,display_name,provider,model_id,thinking_level,
                                default_skill_ids,grants,active_task_count,created_at,updated_at)
              values (${agentId}, ${teamId}, 'e2et agent', ${providerId}, ${MODEL_ID}, 'off',
                      '{}', '{}'::jsonb, 0, ${ts}, ${ts})`;
    // repoUrl 指本地真实仓库 —— daemon 会 `git clone --mirror` 它
    await tx`insert into project (id,team_id,name,provider,repo_kind,repo_url,repo_full_name,
                                  default_branch,next_seq_num,created_at)
              values (${projectId}, ${teamId}, 'e2et-proj', 'external', 'other',
                      ${'file:///' + REPO_DIR}, 'e2et/local', 'main', 1, ${ts})`;
    await tx`insert into machine (id,team_id,name,device_id,enrolled_by,build_enabled,shell_enabled,
                                   max_concurrent_tasks,runtimes,disabled_runtimes,workspaces_dir,
                                   is_online,last_heartbeat_at,created_at,updated_at)
              values (${machineId}, ${teamId}, 'e2et-machine', ${'dev-' + machineId}, ${userId},
                      true, false, 6, ${['pi']}, ${[]}, ${TDS_HOME}, true, ${ts}, ${ts}, ${ts})`;
  });

  const s = seal(MODEL_API_KEY);
  await sql`insert into provider (id,team_id,kind,provider_id,label,api,base_url,enc_api_key,
                                 enc_nonce,models,compat,created_by,created_at,updated_at)
            values (${newId()}, ${teamId}, 'openai', ${providerId}, 'local strata',
                    'openai-completions', ${MODEL_BASE_URL}, ${`${s.cipher}.${s.tag}`}, ${s.nonce},
                    ${JSON.stringify([{ id: MODEL_ID, maxTokens: 4096 }])}::jsonb,
                    ${'{}'}::jsonb, ${userId}, ${ts}, ${ts})`;

  await sql`insert into api_key (id,user_id,name,key_prefix,key_hash,scopes,created_at)
            values (${newId()}, ${userId}, 'e2et-key', ${apiKey.prefix}, ${apiKey.hash},
                    ${['tool:run_builds']}, ${ts})`;
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
  await sql`delete from build_message where build_id in (select id from build where todo_id in
              (select id from todo where project_id = ${projectId}))`;
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
  fs.rmSync(REPO_DIR, { recursive: true, force: true });
  fs.rmSync(TDS_HOME, { recursive: true, force: true });
  // 工作区不在 TDS_HOME 下面就一定清不掉：`paths.ts:14` 在 **import 时**就把
  // `TDS_HOME` 定稿，脚本里再赋 `process.env.TDS_HOME` 已经晚了（实测：工作区
  // 落进了真实的 `~/.tds/workspaces/<buildId>`，跑完还留在那儿）。所以按
  // `PATHS.workspaces` 这个**真实**落点删，而不是按脚本自己拼的路径。
  if (workspaceBuildId) {
    fs.rmSync(`${PATHS.workspaces}/${workspaceBuildId}`, { recursive: true, force: true });
  }
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

async function main(): Promise<void> {
  await seed();
  console.log(`1. seeded repo=${REPO_DIR} team=${teamId}`);

  // ── 起一个 todo 并用 MCP run_builds 起第一轮 ──────────────────────────
  const todoId = newId();
  await sql`insert into todo (id,project_id,seq_num,owner_member_id,agent_id,title,spec,tag_ids,
                               phase,plan_first,separate_plan_build,with_checklist,created_at,updated_at)
            values (${todoId}, ${projectId}, 1, ${memberId}, ${agentId}, '写一个 hello.js 并运行它',
                    ${'在仓库根目录创建 hello.js，内容是 console.log("hello from e2e")；然后用 node 运行它，把输出贴在总结里。'},
                    '{}', 'todo', true, false, false, ${ts}, ${ts})`;
  await sql`update project set next_seq_num = next_seq_num + 1 where id = ${projectId}`;

  const run = (await mcp('run_builds', { todoIds: [todoId] })).results[0];
  if (!run?.ok) throw new Error(`run_builds 失败：${JSON.stringify(run)}`);
  workspaceBuildId = run.buildId;
  console.log(`2. run_builds → phase=${run.phase} build=${run.buildId} step=${run.stepId}`);

  // ── 起真 daemon：真 claim → 真调模型 → 真写文件 → 真 commit → 真上报 ────
  // `TDS_HOME` / `TDS_WORKSPACES_DIR` 必须在**进程启动前**就在环境里
  // （`paths.ts:14` import 时定稿），这里赋值已经不起作用 —— 真正生效的是
  // 调用命令里带的 env。见文件头 usage。
  // `ClientOptions` 的字段是 `server`（不是 baseUrl），也没有 teamId ——
  // team 归属靠 machineKey 在服务端解析。
  const client = new ServerClient({ server: BASE, apiKey: machineKey, timeoutMs: 120_000 });

  const controller = new AbortController();
  const worker = new Worker({
    client,
    concurrency: 1,
    runtimeIds: ['pi'],
    signal: controller.signal,
  });

  const t0 = Date.now();
  const runPromise = worker.run();
  const budgetMs = Number(process.env.E2E_BUDGET_MS ?? 300_000);
  const timer = setTimeout(() => controller.abort(), budgetMs);

  // 轮询等 todo 离开瞬态（planning/implement/reviewing）
  const settled = await (async () => {
    while (Date.now() - t0 < budgetMs) {
      const row = await sql`select phase from todo where id = ${todoId} limit 1`;
      const phase = row[0]?.phase ?? '';
      if (phase === 'review' || phase === 'failed' || phase === 'closed' || phase === 'confirm') {
        return phase;
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 1500);
      await promise;
    }
    return 'TIMEOUT';
  })();

  clearTimeout(timer);
  controller.abort();
  await runPromise.catch(() => undefined);

  console.log(`3. ${((Date.now() - t0) / 1000).toFixed(1)}s 后 todo 相位 = ${settled}`);
  if (settled === 'TIMEOUT') throw new Error('超时：todo 没离开瞬态');

  // ── 取证：build / step / message / changes 文档 / 源仓库是否仍干净 ──────
  const builds = await sql`select id, n, branch, finished_at, error_message from build where todo_id = ${todoId} order by n`;
  const steps = await sql`select id, status, error from step where build_id in (select id from build where todo_id = ${todoId})`;
  const msgs = await sql`select role, left(content, 160) as c, is_error from build_message
                     where build_id in (select id from build where todo_id = ${todoId}) order by seq`;
  const docs = await sql`select kind, version, payload from document
                     where build_id in (select id from build where todo_id = ${todoId}) order by kind`;

  console.log(`   builds: ${JSON.stringify(builds)}`);
  console.log(`   steps:  ${JSON.stringify(steps)}`);
  console.log(`   messages: ${msgs.length} 条`);
  for (const m of msgs) console.log(`     [${m.role}${m.is_error ? ' ERR' : ''}] ${m.c}`);
  // 注意（2026-10-17 实测）：本地 qwen3.8-flash-next 这一档模型**经常回空 `text`** ——
  // 它把预算花在 `reasoning_content` 与写文件上，总结那句话没写出来。于是
  // `/changes` 的 `finalText` 为空、`routes/machine.ts` 不落 assistant 消息、
  // `build_message` 为 0 条。**这不是断链**：commit、diff、changes 文档、done 全都到位。
  // 断言的是「文件真被创建了」，而不是「模型一定写了总结」—— 后者依赖模型心情，
  // 钉它只会让这条 e2e 变得不稳定。
  for (const d of docs) {
    const p = d.payload as Record<string, unknown>;
    console.log(`   doc[${d.kind}] v${d.version}: ${JSON.stringify(p).slice(0, 200)}`);
  }

  // 源仓库必须仍干净（build 跑在隔离 worktree 上）
  const srcStatus = await git(['status', '--porcelain'], REPO_DIR);
  const srcHead = await git(['log', '--oneline', '-1'], REPO_DIR);
  console.log(`   源仓库 status='${srcStatus}' head='${srcHead}'`);
  if (srcStatus !== '') {
    throw new Error(`MUTATION? 源仓库被 build 污染了：${srcStatus}`);
  }

  // 落点：**plan-first 流**下 `planning` 收成功 → `confirm`（要先批准计划才实施），
  // 这正是状态机 `planning` 分支的语义（`planFirst ? 'confirm' : 'implement'`）。
  // 所以这里**不该**断言 review —— 那要等 Confirm 闸门被批准之后才可能出现。
  if (settled !== 'confirm') {
    throw new Error(`plan-first 落点应是 confirm，实际 ${settled}`);
  }
  const chg = docs.find((d) => d.kind === 'changes');
  if (!chg) throw new Error('没有 changes 文档 —— 说明 daemon 没抓 diff（或模型没改文件）');
  const p = chg.payload as { filesChanged?: number; insertions?: number };
  if (!p.filesChanged || p.filesChanged < 1) {
    throw new Error(`changes 文档里没有实际改动：${JSON.stringify(p).slice(0, 200)}`);
  }
  console.log(`\n✅ 模型真跑了一轮：写了 ${p.filesChanged} 个文件、+${p.insertions} 行，落在 Confirm 闸门，源仓库干净`);
}

main().then(
  async () => { await cleanup(); console.log('cleanup done'); },
  async (err) => {
    console.error('E2E FAILED:', err instanceof Error ? err.message : err);
    await cleanup();
    process.exit(1);
  },
);
