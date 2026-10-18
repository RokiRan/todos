import postgres from 'postgres';
import crypto from 'node:crypto';

/**
 * Chief 端到端验证：真实建 team + user + agent，走 HTTP 端点建 Chief、建 topic、派工。
 * 结束后清理。
 */
const DB = 'postgres://tds@127.0.0.1:5433/tds';
const BASE = 'http://127.0.0.1:4000';

const sql = postgres(DB, { max: 1 });
const newId = () => crypto.randomBytes(18).toString('base64url');
const ts = Date.now();

const userId = newId();
const teamId = newId();
const memberId = newId();
const agentId = newId();
// email 有唯一约束 —— 必须每轮唯一，否则上次崩溃的残留会挡住
const email = `chief-e2e-${Date.now()}@test.local`;

// 先清掉历次崩溃留下的孤儿（team 已被删但 user 还在）
await sql`DELETE FROM "user" WHERE email LIKE 'chief-e2e-%@test.local'`;

await sql.begin(async (tx) => {
  await tx`INSERT INTO "user" (id,email,display_name,created_at,updated_at)
            VALUES (${userId}, ${email}, ${'Chief E2E'}, ${ts}, ${ts})`;
  await tx`INSERT INTO team (id,name,plan,created_at) VALUES (${teamId}, ${'Chief E2E'}, ${'free'}, ${ts})`;
  await tx`INSERT INTO member (id,team_id,actor_id,member_type,role,joined_at)
            VALUES (${memberId}, ${teamId}, ${userId}, ${'user'}, ${'admin'}, ${ts})`;
  await tx`INSERT INTO agent (id,team_id,display_name,description,created_at,updated_at)
            VALUES (${agentId}, ${teamId}, ${'调研员'}, ${'做市场调研。'}, ${ts}, ${ts})`;
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
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

try {
  console.log('── 1. 取 Chief（首次应为空）──');
  const c0 = await call('GET', `/api/teams/${teamId}/chief?userId=${userId}`);
  check('端点可达', c0.status === 200, `status ${c0.status} ${JSON.stringify(c0.json).slice(0, 100)}`);

  console.log('── 2. 更新 charter ──');
  const charter = '## 我的团队\n做工业自动化软件。\n\n### 谁来统筹\n- 全流程统筹';
  const put = await call('PUT', `/api/teams/${teamId}/chief/charter`, { userId: userId, charter });
  check('charter 可写', put.status === 200 || put.status === 201,
    `status ${put.status} ${JSON.stringify(put.json).slice(0, 120)}`);

  const c1 = await call('GET', `/api/teams/${teamId}/chief?userId=${userId}`);
  const chiefObj = (c1.json as { chief?: { id?: string; charter?: string } })?.chief;
  check('charter 已保存', Boolean(chiefObj?.charter?.includes('工业自动化')),
    JSON.stringify(c1.json).slice(0, 150));
  check('chiefId 形如 chief-<userId>-<teamId>',
    chiefObj?.id === `chief-${userId}-${teamId}`, `实际 ${chiefObj?.id}`);

  console.log('── 3. 建 topic ──');
  const t = await call('POST', `/api/teams/${teamId}/chief/threads`, {
    userId, title: '帮我组建团队',
  });
  const thread = (t.json as { thread?: { id?: string } })?.thread
    ?? (t.json as { id?: string }) as { id?: string };
  check('topic 已创建', Boolean(thread?.id), JSON.stringify(t.json).slice(0, 150));

  console.log('── 4. 派工 ──');
  // dispatch 的契约是 teamId/projectId/ownerMemberId（不是 userId）
  const projectId = newId();
  // project 没有 updated_at，必填列是 id/team_id/name/next_seq_num
  await sql`INSERT INTO project (id,team_id,name,next_seq_num,created_at)
            VALUES (${projectId}, ${teamId}, ${'E2E 项目'}, ${1}, ${ts})`;

  const d = await call('POST', `/api/chief/threads/${thread?.id}/dispatch`, {
    teamId,
    projectId,
    ownerMemberId: memberId,
    agentId,
    title: '输出市场调研报告',
    spec: '调研 OPC 工业自动化市场，输出报告到 调研/目录。',
  });
  check('派工端点可达', d.status === 200 || d.status === 201,
    `status ${d.status} ${JSON.stringify(d.json).slice(0, 200)}`);
  // 响应是扁平的 { todoId, buildId, stepId, phase }
  const dispatched = d.json as { todoId?: string; buildId?: string; stepId?: string | null; phase?: string };
  check('todo 已创建', Boolean(dispatched.todoId), JSON.stringify(d.json).slice(0, 200));
  check('无机器时不凭空造 step', dispatched.stepId === null,
    `实际 stepId=${String(dispatched.stepId)}`);
  check('无机器时 phase=queued', dispatched.phase === 'queued', `实际 ${dispatched.phase}`);

  console.log('── 5. 校验闸门与分支命名 ──');
  if (dispatched.todoId) {
    const rows = await sql`SELECT t.phase, b.branch, b.id AS build_id
                         FROM todo t JOIN build b ON b.todo_id = t.id
                         WHERE t.id = ${dispatched.todoId}`;
    const row = rows[0];
    check('branch 形如 tds/conv-<buildId>',
      row?.branch === `tds/conv-${row?.build_id}`, `实际 ${row?.branch}`);
    check('库中 phase 与响应一致',
      row?.phase === dispatched.phase, `库 ${row?.phase} vs 响应 ${dispatched.phase}`);
  }

  console.log('── 6. topic 列表 ──');
  const list = await call('GET', `/api/teams/${teamId}/chief/threads?userId=${userId}`);
  const threads = (list.json as { threads?: unknown[] })?.threads;
  check('能列出 topic', Array.isArray(threads) && threads.length >= 1,
    JSON.stringify(list.json).slice(0, 150));
} catch (err) {
  // 不加这层的话，try 里抛异常会被 finally 的 process.exit 吞掉，
  // 打印出「全部通过」的假绿。
  console.log(`  ✗ 抛出异常: ${err instanceof Error ? err.message : String(err)}`);
  failures++;
} finally {
  // 先取出本团队的 todo/build id，再用它们清理 —— 避免深层嵌套子查询
  const todoIds = (await sql`SELECT id FROM todo
                           WHERE project_id IN (SELECT id FROM project WHERE team_id = ${teamId})`)
    .map((r) => r.id);
  const buildIds = todoIds.length
    ? (await sql`SELECT id FROM build WHERE todo_id = ANY(${todoIds})`).map((r) => r.id)
    : [];

  if (buildIds.length > 0) {
    await sql`DELETE FROM audit_event WHERE build_id = ANY(${buildIds})`;
    await sql`DELETE FROM build_message WHERE build_id = ANY(${buildIds})`;
    await sql`DELETE FROM document WHERE build_id = ANY(${buildIds})`;
    await sql`DELETE FROM step WHERE build_id = ANY(${buildIds})`;
    await sql`DELETE FROM step_credential WHERE step_id IN (SELECT id FROM step WHERE build_id = ANY(${buildIds}))`;
    await sql`DELETE FROM build WHERE id = ANY(${buildIds})`;
  }
  if (todoIds.length > 0) {
    await sql`DELETE FROM checklist_item WHERE todo_id = ANY(${todoIds})`;
    await sql`DELETE FROM todo WHERE id = ANY(${todoIds})`;
  }
  await sql`DELETE FROM audit_event WHERE team_id = ${teamId}`;
  await sql`DELETE FROM project WHERE team_id = ${teamId}`;
  await sql`DELETE FROM chief_thread WHERE chief_id = ${`chief-${userId}-${teamId}`}`;
  await sql`DELETE FROM chief WHERE team_id = ${teamId}`;
  await sql`DELETE FROM agent WHERE team_id = ${teamId}`;
  await sql`DELETE FROM member WHERE team_id = ${teamId}`;
  await sql`DELETE FROM team WHERE id = ${teamId}`;
  await sql`DELETE FROM "user" WHERE id = ${userId}`;
  await sql.end();
  console.log(failures === 0 ? '\n全部通过（已清理）' : `\n${failures} 项失败（已清理）`);
  process.exit(failures === 0 ? 0 : 1);
}
