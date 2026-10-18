import postgres from 'postgres';
import crypto from 'node:crypto';
import { hashApiKey } from '../src/crypto.js';

/**
 * diff → document 落库验证（真实 HTTP 上报，走 daemon 用的同一端点）。
 *
 * 验三件事：
 *   1. succeeded + diff → 写 kind='changes' 文档，且 todo 进入 review
 *   2. 同一 build 二次上报 → version 递增（版本化，不是覆盖）
 *   3. failed / 无 diff → 不写文档，也不进 review
 */
const BASE = 'http://127.0.0.1:4000';
const sql = postgres('postgres://tds@127.0.0.1:5433/tds', { max: 1 });

const newId = () => crypto.randomBytes(18).toString('base64url');
const ts = Date.now();

const teamId = newId();
const memberId = newId();
const userId = newId();
const projectId = newId();
const agentId = newId();

await sql.begin(async (tx) => {
  await tx`INSERT INTO "user" (id,email,display_name,status,locale,created_at,updated_at)
            VALUES (${userId}, ${`diff-e2e-${Date.now()}@test.local`}, ${'Diff E2E'}, 'active', 'en', ${ts}, ${ts})`;
  await tx`INSERT INTO team (id,name,plan,storage_quota,created_at)
            VALUES (${teamId}, ${'Diff E2E'}, 'free', ${1073741824}, ${ts})`;
  await tx`INSERT INTO member (id,team_id,actor_id,member_type,role,joined_at,v)
            VALUES (${memberId}, ${teamId}, ${userId}, 'user', 'admin', ${ts}, 0)`;
  await tx`INSERT INTO agent (id,team_id,display_name,default_skill_ids,grants,active_task_count,created_at,updated_at)
            VALUES (${agentId}, ${teamId}, ${'Diff Agent'}, '{}', '{}'::jsonb, 0, ${ts}, ${ts})`;
  await tx`INSERT INTO project (id,team_id,name,provider,repo_kind,default_branch,repo_url,repo_full_name,next_seq_num,created_at)
            VALUES (${projectId}, ${teamId}, ${'Diff 项目'}, 'external', 'github', 'main',
                    ${'https://example.invalid/o/r.git'}, ${'o/r'}, 1, ${ts})`;
});

// 入队 key 的哈希必须与 server 端一致（HMAC + KEK），直接复用其函数
const humanKey = 'tds_' + crypto.randomBytes(24).toString('base64url');
const enrollScopes = ['machine:enroll'];
await sql`INSERT INTO api_key (id,user_id,name,key_prefix,key_hash,scopes,created_at)
          VALUES (${newId()}, ${userId}, ${teamId}, ${'tds_'}, ${hashApiKey(humanKey)},
                  ${enrollScopes}, ${ts})`;

const enroll = await fetch(`${BASE}/api/machine/enroll`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    apiKey: humanKey,
    teamId,
    device: {
      deviceId: 'dev-diff-e2e',
      name: 'diff-e2e 机器',
      arch: 'x64',
      platform: 'win32',
      workspacesDir: 'C:/tmp/ws',
      cliVersion: '0.1.66',
    },
  }),
});
if (!enroll.ok) {
  const body = await enroll.text();
  await sql.end();
  throw new Error(`enroll 失败 ${enroll.status}: ${body.slice(0, 200)}`);
}
const enrolled = (await enroll.json()) as { machineId: string; apiKey: string };
const token = enrolled.apiKey;
const machineId = enrolled.machineId;

async function call(method: string, path: string, body?: unknown, bearer = token): Promise<{ status: number; json: unknown }> {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = text;
  try { json = JSON.parse(text); } catch { /* 保留原文 */ }
  return { status: res.status, json };
}

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { console.log(`  ✗ ${name} ${detail}`); failures++; }
}

let seqCounter = 0;
async function seedBuild(): Promise<{ todoId: string; buildId: string; stepId: string }> {
  const todoId = newId();
  const buildId = newId();
  const stepId = newId();
  seqCounter += 1;
  await sql`INSERT INTO todo (id,project_id,seq_num,owner_member_id,title,phase,plan_first,created_at,updated_at)
            VALUES (${todoId}, ${projectId}, ${seqCounter}, ${memberId}, ${'diff todo'}, 'implement', ${false}, ${ts}, ${ts})`;
  await sql`INSERT INTO build (id,todo_id,n,branch,trigger_source,with_plan,with_checklist,agent_id,session,usage_by_model,created_at,v)
            VALUES (${buildId}, ${todoId}, 1, ${'tds/conv-' + buildId}, 'manual', ${false}, ${false}, ${agentId}, ${'{}'}, ${'{}'}, ${ts}, 0)`;
  // step 无 created_at 列：id,build_id,machine_id,status,claimed_at,heartbeat_at,finished_at,error
  await sql`INSERT INTO step (id,build_id,machine_id,status,claimed_at,heartbeat_at)
            VALUES (${stepId}, ${buildId}, ${machineId}, 'running', ${ts}, ${ts})`;
  return { todoId, buildId, stepId };
}

// DoneSchema 在 body 里也要带 stepId（协议要求），路径也是 /done/:stepId
const DIFF = {
  filesChanged: 2, insertions: 30, deletions: 4, truncated: false,
  body: 'diff --git a/x.ts b/x.ts\n+新增一行\n',
};

async function report(stepId: string, body: Record<string, unknown>, bearer = token) {
  return call('POST', `/api/machine/done/${stepId}`, { stepId, branchPushed: false, ...body }, bearer);
}

try {
  console.log('── 1. succeeded + diff → 写 changes 文档并进 review ──');
  {
    const { todoId, buildId, stepId } = await seedBuild();
    const r = await report(stepId, { status: 'succeeded', commitSha: 'abc123', diff: DIFF });
    check('上报成功', r.status === 200, `status ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);

    const docs = await sql`SELECT id, version, payload FROM document
                        WHERE build_id = ${buildId} AND kind = 'changes'`;
    check('写入 1 份 changes 文档', docs.length === 1, `实际 ${docs.length}`);
    const p = docs[0]?.payload as Record<string, unknown> | undefined;
    check('version 从 1 开始', docs[0]?.version === 1, `实际 ${docs[0]?.version}`);
    check('payload 含 diff 正文', String(p?.body).includes('新增一行'));
    check('payload 含统计', p?.filesChanged === 2 && p?.insertions === 30 && p?.deletions === 4,
      JSON.stringify({ f: p?.filesChanged, i: p?.insertions, d: p?.deletions }));
    check('payload 记录 commitSha', p?.commitSha === 'abc123');
    check('payload 记录分支', p?.branch === 'tds/conv-' + buildId);
    check('summary 可读', typeof p?.summary === 'string' && String(p.summary).includes('2 files'));

    const t = await sql`SELECT phase FROM todo WHERE id = ${todoId}`;
    check('todo 进入 review', t[0]?.phase === 'review', `实际 ${t[0]?.phase}`);
  }

  console.log('── 2. 同一 build 二次上报 → version 递增 ──');
  {
    const { todoId, buildId, stepId } = await seedBuild();
    await report(stepId, { status: 'succeeded', commitSha: 'a1', diff: DIFF });
    await sql`UPDATE todo SET phase='implement' WHERE id = ${todoId}`;
    await sql`UPDATE step SET status='running' WHERE id = ${stepId}`;

    const r2 = await report(stepId, { status: 'succeeded', commitSha: 'b2', diff: DIFF });
    check('二次上报成功', r2.status === 200, `status ${r2.status}`);

    const docs = await sql`SELECT version FROM document
                        WHERE build_id = ${buildId} AND kind='changes' ORDER BY version`;
    check('有 2 个版本', docs.length === 2, `实际 ${docs.length}`);
    check('版本号为 1 和 2（递增不覆盖）',
      docs[0]?.version === 1 && docs[1]?.version === 2,
      JSON.stringify(docs.map((d) => d.version)));
  }

  console.log('── 3. failed 不写文档、不进 review ──');
  {
    const { todoId, buildId, stepId } = await seedBuild();
    const r = await report(stepId, { status: 'failed', error: '编译器报错', diff: DIFF });
    check('上报成功', r.status === 200, `status ${r.status}`);
    const docs = await sql`SELECT id FROM document WHERE build_id = ${buildId} AND kind='changes'`;
    check('failed 不写 changes 文档', docs.length === 0, `实际 ${docs.length}`);
    const t = await sql`SELECT phase FROM todo WHERE id = ${todoId}`;
    check('todo 进入 failed', t[0]?.phase === 'failed', `实际 ${t[0]?.phase}`);
  }

  console.log('── 4. succeeded 但无 diff → 不写文档 ──');
  {
    const { buildId, stepId, todoId } = await seedBuild();
    const r = await report(stepId, { status: 'succeeded', commitSha: 'x' });
    check('上报成功', r.status === 200, `status ${r.status}`);
    const docs = await sql`SELECT id FROM document WHERE build_id = ${buildId} AND kind='changes'`;
    check('无 diff 不写文档', docs.length === 0, `实际 ${docs.length}`);
    const t = await sql`SELECT phase FROM todo WHERE id = ${todoId}`;
    check('仍进 review（改动为空也是完成的 build）', t[0]?.phase === 'review', `实际 ${t[0]?.phase}`);
  }

  console.log('── 5. 未授权上报被拒 ──');
  {
    const { stepId } = await seedBuild();
    const r = await report(stepId, { status: 'succeeded' }, 'wrong-token');
    check('错误 token 返回 401', r.status === 401, `status ${r.status}`);
  }
} catch (err) {
  console.log(`  ✗ 抛出异常: ${err instanceof Error ? err.message : String(err)}`);
  failures++;
} finally {
  const todoIds = (await sql`SELECT id FROM todo WHERE project_id = ${projectId}`).map((r) => r.id);
  const buildIds = todoIds.length ? (await sql`SELECT id FROM build WHERE todo_id = ANY(${todoIds})`).map((r) => r.id) : [];
  if (buildIds.length > 0) {
    await sql`DELETE FROM audit_event WHERE build_id = ANY(${buildIds})`;
    await sql`DELETE FROM build_message WHERE build_id = ANY(${buildIds})`;
    await sql`DELETE FROM step WHERE build_id = ANY(${buildIds})`;
    await sql`DELETE FROM document WHERE build_id = ANY(${buildIds})`;
    await sql`DELETE FROM build WHERE id = ANY(${buildIds})`;
  }
  if (todoIds.length > 0) await sql`DELETE FROM todo WHERE id = ANY(${todoIds})`;
  await sql`DELETE FROM machine WHERE team_id = ${teamId}`;
  await sql`DELETE FROM api_key WHERE user_id = ${userId}`;
  await sql`DELETE FROM audit_event WHERE team_id = ${teamId}`;
  await sql`DELETE FROM project WHERE team_id = ${teamId}`;
  await sql`DELETE FROM agent WHERE team_id = ${teamId}`;
  await sql`DELETE FROM member WHERE team_id = ${teamId}`;
  await sql`DELETE FROM team WHERE id = ${teamId}`;
  await sql`DELETE FROM "user" WHERE id = ${userId}`;
  await sql.end();
  console.log(failures === 0 ? '\n全部通过（已清理）' : `\n${failures} 项失败（已清理）`);
  process.exit(failures === 0 ? 0 : 1);
}
