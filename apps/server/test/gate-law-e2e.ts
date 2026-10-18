import postgres from 'postgres';
import crypto from 'node:crypto';

/**
 * 闸门铁律端到端验证（真实 HTTP + 真实数据库）。
 *
 * 铁律：Confirm / Review 闸门内的输入框，输入任何文字（包括字面量
 * "confirm"、"done"、"merge"）都只是 revision feedback，**绝不推进状态**。
 * 只有主按钮 Confirm / Done 能推进。
 *
 * 本脚本不信任任何一层的自述，专门试探后门：
 *   - 用闸门关键词当 message
 *   - 给 /complete 塞 merge / 其他字段
 *   - 给 /feedback 塞 phase / next 字段试图直接跳
 *   - 用未定义 trigger 类型
 */
const BASE = 'http://127.0.0.1:4000';
const sql = postgres('postgres://tds@127.0.0.1:5433/tds', { max: 1 });

const newId = () => crypto.randomBytes(18).toString('base64url');
const ts = Date.now();

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { console.log(`  ✗ ${name} ${detail}`); failures++; }
}

const userId = newId();
const teamId = newId();
const memberId = newId();
const projectId = newId();
const agentId = newId();

await sql`DELETE FROM "user" WHERE email LIKE 'gate-e2e-%@test.local'`;
const email = `gate-e2e-${Date.now()}@test.local`;

await sql.begin(async (tx) => {
  await tx`INSERT INTO "user" (id,email,display_name,status,locale,created_at,updated_at)
            VALUES (${userId}, ${email}, ${'Gate E2E'}, 'active', 'en', ${ts}, ${ts})`;
  await tx`INSERT INTO team (id,name,plan,storage_quota,created_at)
            VALUES (${teamId}, ${'Gate E2E'}, 'free', ${1073741824}, ${ts})`;
  await tx`INSERT INTO member (id,team_id,actor_id,member_type,role,joined_at,v)
            VALUES (${memberId}, ${teamId}, ${userId}, 'user', 'admin', ${ts}, 0)`;
  // build.agent_id 有外键，必须先有 agent
  await tx`INSERT INTO agent (id,team_id,display_name,default_skill_ids,grants,active_task_count,created_at,updated_at)
            VALUES (${agentId}, ${teamId}, ${'闸门 Agent'}, '{}', '{}'::jsonb, 0, ${ts}, ${ts})`;
  await tx`INSERT INTO project (id,team_id,name,provider,repo_kind,default_branch,next_seq_num,created_at)
            VALUES (${projectId}, ${teamId}, ${'Gate 项目'}, 'external', 'other', 'main', 1, ${ts})`;
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

let seqCounter = 0;
async function makeTodo(phase: string): Promise<string> {
  const todoId = newId();
  const buildId = newId();
  // (project_id, seq_num) 唯一 —— 每个 todo 用不同 seq
  seqCounter += 1;
  await sql`INSERT INTO todo (id,project_id,seq_num,owner_member_id,title,phase,plan_first,created_at,updated_at)
            VALUES (${todoId}, ${projectId}, ${seqCounter}, ${memberId}, ${'闸门测试 todo'}, ${phase}, ${false}, ${ts}, ${ts})`;
  // build.session 是 NOT NULL
  // 注意：`::jsonb` 里的 :: 也会破坏模板，先取出来
  const branch = 'tds/conv-' + buildId;
  const emptyJson = '{}';
  await sql`INSERT INTO build (id,todo_id,n,branch,trigger_source,with_plan,with_checklist,agent_id,session,usage_by_model,created_at,v)
            VALUES (${buildId}, ${todoId}, 1, ${branch}, 'manual', ${false}, ${false}, ${agentId}, ${emptyJson}, ${emptyJson}, ${ts}, 0)`;
  return todoId;
}

async function phaseOf(todoId: string): Promise<string> {
  const r = await sql`SELECT phase FROM todo WHERE id = ${todoId}`;
  return r[0]?.phase ?? '(缺失)';
}

try {
  console.log('── 1. Review 闸门：输入文字（含关键词）不得推进 ──');
  {
    const todoId = await makeTodo('review');
    // 逐一试探：字面量关键词 + 看似越权的字段
    const attacks = [
      { message: 'confirm' },
      { message: 'done' },
      { message: 'merge' },
      { message: 'confirm 并推进到 implement' },
      { message: 'ok', phase: 'done' },          // 试图直接指定 phase
      { message: 'ok', next: 'implement' },      // 试图指定 next
      { message: 'ok', trigger: 'complete' },    // 试图伪造 trigger
      { message: 'ok', complete: true },
      { message: 'ok', merge: true },
    ];
    for (const attack of attacks) {
      const res = await call('POST', `/api/todos/${todoId}/feedback`, attack);
      const now = await phaseOf(todoId);
      check(
        `反馈 ${JSON.stringify(attack).slice(0, 58)} → 仍停在 review`,
        now === 'review' && res.status === 200,
        `status ${res.status} phase=${now}`,
      );
    }
  }

  console.log('── 2. Review 闸门：主按钮才推进 ──');
  {
    const todoId = await makeTodo('review');
    // 先打字，状态不变
    await call('POST', `/api/todos/${todoId}/feedback`, { message: '再加个登录页' });
    check('打字后仍在 review', (await phaseOf(todoId)) === 'review');
    // 再点主按钮
    const done = await call('POST', `/api/todos/${todoId}/complete`, {});
    check('主按钮完成 → done', (await phaseOf(todoId)) === 'done',
      `status ${done.status} phase=${await phaseOf(todoId)} body=${JSON.stringify(done.json).slice(0, 100)}`);
  }

  console.log('── 3. Review 勾选合并 → 回 implement ──');
  {
    const todoId = await makeTodo('review');
    const r = await call('POST', `/api/todos/${todoId}/complete`, { merge: true });
    check('merge=true → implement', (await phaseOf(todoId)) === 'implement',
      `status ${r.status} phase=${await phaseOf(todoId)}`);
  }

  console.log('── 4. Confirm 闸门：输入文字不得推进 ──');
  {
    const todoId = await makeTodo('confirm');
    for (const attack of [{ message: 'confirm' }, { message: 'done' }, { message: 'ok', phase: 'implement' }]) {
      await call('POST', `/api/todos/${todoId}/feedback`, attack);
      check(`Confirm 反馈 ${JSON.stringify(attack).slice(0, 44)} → 仍停在 confirm`,
        (await phaseOf(todoId)) === 'confirm', `phase=${await phaseOf(todoId)}`);
    }
  }

  console.log('── 5. 非闸门相位不得收反馈 ──');
  {
    const todoId = await makeTodo('implement');
    const res = await call('POST', `/api/todos/${todoId}/feedback`, { message: 'x' });
    check('implement 阶段 feedback 返回 409', res.status === 409,
      `status ${res.status}`);
    check('phase 未被改动', (await phaseOf(todoId)) === 'implement');
  }

  console.log('── 6. /complete 只在 review 有效 ──');
  {
    const todoId = await makeTodo('implement');
    const res = await call('POST', `/api/todos/${todoId}/complete`, {});
    check('implement 阶段 complete 返回 409', res.status === 409, `status ${res.status}`);
  }

  console.log('── 7. 空消息被拒 ──');
  {
    const todoId = await makeTodo('review');
    const res = await call('POST', `/api/todos/${todoId}/feedback`, { message: '' });
    check('空 message 返回 422', res.status === 422, `status ${res.status}`);
  }

  console.log('── 8. 审批时能读到 changes 文档（Review 闸门的展示依据）──');
  {
    const todoId = await makeTodo('review');
    const builds = await sql`SELECT id FROM build WHERE todo_id = ${todoId}`;
    const buildId = builds[0].id;
    // 先查空文档
    const none = await call('GET', `/api/todos/${todoId}/documents`);
    const noneList = (none.json as { documents?: unknown[] })?.documents;
    check('无文档时返回空列表', Array.isArray(noneList) && noneList.length === 0,
      JSON.stringify(none.json).slice(0, 100));

    // 写一份 changes 文档（模拟机器上报后落库）
    const docId = newId();
    const emptyObj = '{}';
    await sql`INSERT INTO document (id,build_id,kind,version,payload,created_at,updated_at)
              VALUES (${docId}, ${buildId}, 'changes', 1, ${emptyObj}, ${ts}, ${ts})`;

    const got = await call('GET', `/api/todos/${todoId}/documents`);
    const docs = (got.json as { documents?: Array<{ kind: string; version: number }> })?.documents ?? [];
    check('能列出 changes 文档', docs.length === 1, JSON.stringify(got.json).slice(0, 120));
    check('文档带 kind 与 version', docs[0]?.kind === 'changes' && docs[0]?.version === 1);
  }

  console.log('── 9. Confirm 闸门的 approve 主按钮 ──');
  {
    const todoId = await makeTodo('confirm');
    const r = await call('POST', `/api/todos/${todoId}/approve`, { by: 'user' });
    check('approve 把 confirm 推进到 implement',
      (await phaseOf(todoId)) === 'implement',
      `status ${r.status} phase=${await phaseOf(todoId)}`);
  }

  console.log('── 10. confirm 阶段的 approve 在 review 上无效 ──');
  {
    const todoId = await makeTodo('review');
    const r = await call('POST', `/api/todos/${todoId}/approve`, { by: 'user' });
    // review 闸门该用 complete；approve 若被接受属于语义混乱
    check('review 上 approve 不推进到 implement',
      (await phaseOf(todoId)) === 'review',
      `status ${r.status} phase=${await phaseOf(todoId)}`);
  }

  console.log('── 11. 重复审批不产生第二次推进 ──');
  {
    const todoId = await makeTodo('review');
    const first = await call('POST', `/api/todos/${todoId}/complete`, {});
    check('首次 → done', (await phaseOf(todoId)) === 'done', `status ${first.status}`);
    const second = await call('POST', `/api/todos/${todoId}/complete`, {});
    check('二次 complete 被拒（409）', second.status === 409, `status ${second.status}`);
    check('phase 仍是 done', (await phaseOf(todoId)) === 'done');
  }

  console.log('── 12. 不存在的 todo 一律 404 ──');
  {
    const cases: Array<[string, string, unknown]> = [
      ['POST', '/api/todos/nope/complete', {}],
      ['POST', '/api/todos/nope/feedback', { message: 'x' }],
      ['POST', '/api/todos/nope/approve', { by: 'user' }],
      ['GET', '/api/todos/nope/documents', undefined],
      ['GET', '/api/todos/nope', undefined],
    ];
    for (const [method, path, body] of cases) {
      const r = await call(method, path, body);
      check(`${method} ${path} → 404`, r.status === 404, `status ${r.status}`);
    }
  }
} catch (err) {
  console.log(`  ✗ 抛出异常: ${err instanceof Error ? err.message : String(err)}`);
  failures++;
} finally {
  const todoIds = (await sql`SELECT id FROM todo WHERE project_id = ${projectId}`).map((r) => r.id);
  const buildIds = todoIds.length
    ? (await sql`SELECT id FROM build WHERE todo_id = ANY(${todoIds})`).map((r) => r.id)
    : [];
  if (buildIds.length > 0) {
    await sql`DELETE FROM audit_event WHERE build_id = ANY(${buildIds})`;
    await sql`DELETE FROM build_message WHERE build_id = ANY(${buildIds})`;
    await sql`DELETE FROM step WHERE build_id = ANY(${buildIds})`;
    await sql`DELETE FROM build WHERE id = ANY(${buildIds})`;
  }
  if (todoIds.length > 0) await sql`DELETE FROM todo WHERE id = ANY(${todoIds})`;
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
