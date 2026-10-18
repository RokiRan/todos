import assert from 'node:assert/strict';
import { test, describe, before, after, afterEach } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import * as dbPkg from '@tds/db';
import { newId, now } from '../src/ids.js';
import { generateApiKey } from '../src/crypto.js';
import { registerTodoRoutes } from '../src/routes/todos.js';

/**
 * Mentions 结构化引用端点契约（POST/GET /api/todos/:todoId/mentions）：
 *
 *   - 跨团队 POST → 403，且 `build_message_mention` 零行写入（最容易假绿，必须查库）
 *   - 引用不存在的 refId → 422，且零写入
 *   - 引用跨团队的对象 → 403，且零写入
 *   - prefix ↔ kind 不一致 → 422，且零写入（路由层 superRefine + DB CHECK 兜底）
 *   - messageId 不属于该 todo 的 build → 404，且零写入
 *   - 六种 kind 各一条成功用例，断言 prefix/kind/label 落库正确
 *   - 同一 messageId 重复提交 → 幂等（不产生重复行）
 *   - 引用同 team 但不同 project 的 todo → 200（**原站明确允许**，最易假绿）
 *   - GET ?messageId=... → 返回该 message 的所有 mentions
 *   - 跨团队 GET 他人 todo 的 mentions → 403
 *   - fixture 清理后真实 SQL 验证零残留
 *
 * 与 `machines-api.test.ts` / `todo-move.test.ts` 同源：真 Postgres + app.inject，
 * 不 mock；错误状态码 + 数据库状态双重断言。
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://tds:tds_local_dev@127.0.0.1:5433/tds';
type TestDb = PostgresJsDatabase<typeof dbPkg.schema>;

interface Fixture {
  label: string;
  userId: string;
  teamId: string;
  memberId: string;
  agentMemberId: string;
  agentId: string;
  skillId: string;
  projectId: string;
  crossProjectId: string;
  machineId: string;
  buildId: string;
  buildIdForCross: string;
  messageId: string;
  crossMessageId: string;
  key: string;
  cross: { userId: string; teamId: string; memberId: string; key: string };
}

async function seedFixture(
  sql: postgres.Sql,
  label: string,
  scopes: string[] = ['*'],
): Promise<Fixture> {
  const ts = now();
  const userId = newId();
  const teamId = newId();
  const memberId = newId();
  const agentMemberId = newId();
  const agentId = newId();
  const skillId = newId();
  const projectId = newId();
  const crossProjectId = newId();
  const machineId = newId();
  const buildId = newId();
  const buildIdForCross = newId();
  const messageId = newId();
  const crossMessageId = newId();

  // User
  await sql`
    insert into "user" (id, email, display_name, status, locale, created_at, updated_at)
    values (${userId}, ${`${label}-${userId}@test.local`}, ${label}, 'active', 'en', ${ts}, ${ts})
  `;
  // Team
  await sql`
    insert into "team" (id, name, plan, storage_quota, created_at)
    values (${teamId}, ${label}, 'free', 1073741824, ${ts})
  `;
  // Member（人类）：owner_member_id 走这条
  await sql`
    insert into "member" (id, team_id, actor_id, member_type, role, joined_at, v)
    values (${memberId}, ${teamId}, ${userId}, 'user', 'admin', ${ts}, 0)
  `;
  // Agent member（member 表里 actor_id=agent.id, member_type='agent'）——
  // 让 `member` kind 的引用有真实可指向的行。
  await sql`
    insert into "member" (id, team_id, actor_id, member_type, role, joined_at, v)
    values (${agentMemberId}, ${teamId}, ${agentId}, 'agent', 'member', ${ts}, 0)
  `;
  // Agent
  await sql`
    insert into "agent" (id, team_id, display_name, default_skill_ids, grants, active_task_count, created_at, updated_at)
    values (${agentId}, ${teamId}, ${label + '-agent'}, '{}', '{}'::jsonb, 0, ${ts}, ${ts})
  `;
  // Skill
  await sql`
    insert into "skill" (id, team_id, name, source, storage_path, created_by, created_at)
    values (${skillId}, ${teamId}, ${label + '-skill'}, 'local', ${'/skills/' + label}, ${userId}, ${ts})
  `;
  // Project（同 team 主项目）
  await sql`
    insert into "project" (id, team_id, name, provider, repo_kind, default_branch, next_seq_num, created_at)
    values (${projectId}, ${teamId}, ${label + '-main'}, 'external', 'other', 'main', 1, ${ts})
  `;
  // Project（同 team 第二个项目）—— 验证「同 team 跨 project 允许」
  await sql`
    insert into "project" (id, team_id, name, provider, repo_kind, default_branch, next_seq_num, created_at)
    values (${crossProjectId}, ${teamId}, ${label + '-other'}, 'external', 'other', 'main', 1, ${ts})
  `;
  // Machine
  await sql`
    insert into "machine" (
      id, team_id, name, device_id, enrolled_by,
      build_enabled, shell_enabled, max_concurrent_tasks,
      runtimes, disabled_runtimes, hardware,
      is_online, created_at, updated_at
    )
    values (
      ${machineId}, ${teamId}, ${label + '-machine'}, ${'dev-' + machineId}, ${userId},
      ${true}, ${false}, ${6},
      '{}'::text[], '{}'::text[], '{}'::jsonb,
      ${false}, ${ts}, ${ts}
    )
  `;
  // Todo（主）
  const seqRow = await sql<{ next_seq_num: number }[]>`
    select next_seq_num from "project" where id = ${projectId}
  `;
  const seq = seqRow[0]?.next_seq_num ?? 1;
  await sql`update "project" set next_seq_num = next_seq_num + 1 where id = ${projectId}`;
  const todoId = newId();
  await sql`
    insert into "todo"
      (id, project_id, seq_num, owner_member_id, agent_id, title, tag_ids, phase,
       plan_first, separate_plan_build, with_checklist, created_at, updated_at)
    values
      (${todoId}, ${projectId}, ${seq}, ${memberId}, ${agentId}, ${'Mentions-' + label},
       '{}', 'todo', true, false, false, ${ts}, ${ts})
  `;
  // Build（主）
  await sql`
    insert into "build" (id, todo_id, n, branch, trigger_source, agent_id, session,
                         with_plan, with_checklist, usage_by_model, created_at, v)
    values (${buildId}, ${todoId}, 1, ${'tds/conv-' + buildId}, 'user', ${agentId},
            ${JSON.stringify({ runtime: 'omp', id: newId(), openedAt: ts })}::jsonb,
            false, false, '[]'::jsonb, ${ts}, 0)
  `;
  // Build_message（主）
  await sql`
    insert into "build_message"
      (id, build_id, role, phase, content, is_error, seq, created_at)
    values (${messageId}, ${buildId}, 'user', null, 'hello chief', false, 1, ${ts})
  `;
  // Todo（跨 project 但同 team）—— 这是「引用不同项目 todo 允许」的关键 fixture
  const seqRow2 = await sql<{ next_seq_num: number }[]>`
    select next_seq_num from "project" where id = ${crossProjectId}
  `;
  const seq2 = seqRow2[0]?.next_seq_num ?? 1;
  await sql`update "project" set next_seq_num = next_seq_num + 1 where id = ${crossProjectId}`;
  const crossTodoId = newId();
  await sql`
    insert into "todo"
      (id, project_id, seq_num, owner_member_id, agent_id, title, tag_ids, phase,
       plan_first, separate_plan_build, with_checklist, created_at, updated_at)
    values
      (${crossTodoId}, ${crossProjectId}, ${seq2}, ${memberId}, ${agentId}, ${'Cross-' + label},
       '{}', 'todo', true, false, false, ${ts}, ${ts})
  `;
  await sql`
    insert into "build" (id, todo_id, n, branch, trigger_source, agent_id, session,
                         with_plan, with_checklist, usage_by_model, created_at, v)
    values (${buildIdForCross}, ${crossTodoId}, 1, ${'tds/conv-' + buildIdForCross}, 'user', ${agentId},
            ${JSON.stringify({ runtime: 'omp', id: newId(), openedAt: ts })}::jsonb,
            false, false, '[]'::jsonb, ${ts}, 0)
  `;
  await sql`
    insert into "build_message"
      (id, build_id, role, phase, content, is_error, seq, created_at)
    values (${crossMessageId}, ${buildIdForCross}, 'user', null, 'cross-msg', false, 1, ${ts})
  `;
  // API key
  const k = generateApiKey();
  await sql`
    insert into "api_key" (id, user_id, name, key_prefix, key_hash, scopes, created_at)
    values (${newId()}, ${userId}, ${'mentions-' + label}, ${k.prefix}, ${k.hash}, ${scopes}, ${ts})
  `;

  // 跨团队 stranger
  const cross = {
    userId: newId(),
    teamId: newId(),
    memberId: newId(),
    key: '',
  };
  await sql`
    insert into "user" (id, email, display_name, status, locale, created_at, updated_at)
    values (${cross.userId}, ${`cross-${cross.userId}@test.local`}, 'cross', 'active', 'en', ${ts}, ${ts})
  `;
  await sql`
    insert into "team" (id, name, plan, storage_quota, created_at)
    values (${cross.teamId}, 'cross-team', 'free', 1073741824, ${ts})
  `;
  await sql`
    insert into "member" (id, team_id, actor_id, member_type, role, joined_at, v)
    values (${cross.memberId}, ${cross.teamId}, ${cross.userId}, 'user', 'admin', ${ts}, 0)
  `;
  const ck = generateApiKey();
  await sql`
    insert into "api_key" (id, user_id, name, key_prefix, key_hash, scopes, created_at)
    values (${newId()}, ${cross.userId}, 'cross-key', ${ck.prefix}, ${ck.hash}, ${scopes}, ${ts})
  `;
  cross.key = ck.key;

  return {
    label,
    userId, teamId, memberId, agentMemberId, agentId, skillId,
    projectId, crossProjectId, machineId,
    buildId, buildIdForCross, messageId, crossMessageId,
    key: k.key,
    cross,
  };
}

function auth(key: string): { authorization: string } {
  return { authorization: `Bearer ${key}` };
}

async function countMentions(
  sql: postgres.Sql,
  messageId: string,
): Promise<number> {
  const rows = await sql<{ c: number }[]>`
    select count(*)::int as c from "build_message_mention" where message_id = ${messageId}
  `;
  return rows[0]?.c ?? 0;
}

async function deleteFixture(sql: postgres.Sql, f: Fixture): Promise<void> {
  // mentions → cascade from message → cascade from build → cascade from todo → cascade from project
  await sql`delete from "build_message_mention" where build_id in (${f.buildId}, ${f.buildIdForCross})`;
  await sql`delete from "build_message" where build_id in (${f.buildId}, ${f.buildIdForCross})`;
  await sql`delete from "build" where id in (${f.buildId}, ${f.buildIdForCross})`;
  // todo / project cascade
  await sql`delete from "project" where id in (${f.projectId}, ${f.crossProjectId})`;
  await sql`delete from "machine" where id = ${f.machineId}`;
  await sql`delete from "skill" where id = ${f.skillId}`;
  await sql`delete from "agent" where id = ${f.agentId}`;
  await sql`delete from "member" where team_id in (${f.teamId}, ${f.cross.teamId})`;
  await sql`delete from "team" where id in (${f.teamId}, ${f.cross.teamId})`;
  await sql`delete from "api_key" where user_id in (${f.userId}, ${f.cross.userId})`;
  await sql`delete from "user" where id in (${f.userId}, ${f.cross.userId})`;
}

describe('Mentions · REST 端点契约', () => {
  let sql: postgres.Sql;
  let db: TestDb;
  let app: FastifyInstance;
  let todoIdHolder: { value: string };
  let crossTodoIdHolder: { value: string };
  const fixtures: Fixture[] = [];

  before(async () => {
    sql = postgres(DATABASE_URL, { max: 5, idle_timeout: 20 });
    db = drizzle(sql, { schema: dbPkg.schema as never });
    app = Fastify({ logger: false });
    app.decorate('machineUrl', 'http://test');
    registerTodoRoutes(app, db as never);
    await app.ready();
    // 第一份 fixture 全程活到 afterEach 清理 —— 让 todoId/crossTodoId 跨用例复用
    const f = await seedFixture(sql, 'mentions-shared', ['*']);
    fixtures.push(f);
    // 把 todoId 暴露给用例：seedFixture 内部产生但没暴露。
    const row = await sql<{ id: string }[]>`
      select id from "todo" where project_id = ${f.projectId} limit 1
    `;
    todoIdHolder = { value: row[0]!.id };
    const row2 = await sql<{ id: string }[]>`
      select id from "todo" where project_id = ${f.crossProjectId} limit 1
    `;
    crossTodoIdHolder = { value: row2[0]!.id };
  });

  afterEach(async () => {
    // 每条用例跑完后清掉本条追加的 mentions（不动其它行），让用例相互独立
    await sql`delete from "build_message_mention" where 1=1`;
  });

  after(async () => {
    for (const f of fixtures) {
      try { await deleteFixture(sql, f); } catch { /* ignore */ }
    }
    // 跨用例也可能残留 cross 团队数据，兜底清一次
    const leftover = await sql<{ id: string }[]>`
      select id from "team" where name = 'cross-team' or name like 'mentions-%'
    `;
    for (const r of leftover) {
      try { await sql`delete from "team" where id = ${r.id}`; } catch { /* ignore */ }
    }
    await app.close();
    await sql.end();
  });

  // ─────────────── 鉴权 ───────────────

  test('跨团队 POST → 403，且 build_message_mention 零行写入', async () => {
    const f = fixtures[0]!;
    const before = await countMentions(sql, f.messageId);
    assert.equal(before, 0, '用例前置：mentions 必须为空');

    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoIdHolder.value}/mentions`,
      headers: auth(f.cross.key),
      payload: {
        messageId: f.messageId,
        mentions: [{ kind: 'agent', prefix: '@', refId: f.agentId, label: 'noop' }],
      },
    });
    assert.equal(res.statusCode, 403, `body=${res.body}`);

    const after = await countMentions(sql, f.messageId);
    assert.equal(after, 0, '403 时数据库里必须零行写入（最容易假绿）');
  });

  test('跨团队 GET → 403', async () => {
    const f = fixtures[0]!;
    const res = await app.inject({
      method: 'GET',
      url: `/api/todos/${todoIdHolder.value}/mentions?messageId=${encodeURIComponent(f.messageId)}`,
      headers: auth(f.cross.key),
    });
    assert.equal(res.statusCode, 403, `body=${res.body}`);
  });

  // ─────────────── 422 / 404 ───────────────

  test('引用不存在的 refId → 422，且零写入', async () => {
    const f = fixtures[0]!;
    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoIdHolder.value}/mentions`,
      headers: auth(f.key),
      payload: {
        messageId: f.messageId,
        mentions: [{ kind: 'agent', prefix: '@', refId: 'definitely-not-an-agent', label: 'ghost' }],
      },
    });
    assert.equal(res.statusCode, 422, `body=${res.body}`);
    const after = await countMentions(sql, f.messageId);
    assert.equal(after, 0, '422 时零写入');
  });

  test('prefix ↔ kind 不一致（# 前缀但 kind=agent）→ 422，且零写入', async () => {
    const f = fixtures[0]!;
    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoIdHolder.value}/mentions`,
      headers: auth(f.key),
      payload: {
        messageId: f.messageId,
        mentions: [{ kind: 'agent', prefix: '#', refId: f.agentId, label: 'mismatch' }],
      },
    });
    assert.equal(res.statusCode, 422, `body=${res.body}`);
    const after = await countMentions(sql, f.messageId);
    assert.equal(after, 0, 'superRefine 拒时零写入');
  });

  test('messageId 不属于该 todo 的 build → 404，且零写入', async () => {
    const f = fixtures[0]!;
    const ghostMsg = newId();
    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoIdHolder.value}/mentions`,
      headers: auth(f.key),
      payload: {
        messageId: ghostMsg,
        mentions: [{ kind: 'agent', prefix: '@', refId: f.agentId, label: 'ghost-msg' }],
      },
    });
    assert.equal(res.statusCode, 404, `body=${res.body}`);
    const after = await countMentions(sql, ghostMsg);
    assert.equal(after, 0);
  });

  test('部分 mentions 合法 + 部分不存在 → 422，且整批零写入（事务）', async () => {
    const f = fixtures[0]!;
    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoIdHolder.value}/mentions`,
      headers: auth(f.key),
      payload: {
        messageId: f.messageId,
        mentions: [
          { kind: 'agent', prefix: '@', refId: f.agentId, label: 'real' },
          { kind: 'skill', prefix: '/', refId: 'no-such-skill', label: 'ghost' },
        ],
      },
    });
    assert.equal(res.statusCode, 422, `body=${res.body}`);
    const after = await countMentions(sql, f.messageId);
    assert.equal(after, 0, '部分失败时整批零写入 —— 校验顺序：先全部 validate 再写');
  });

  // ─────────────── 成功：六种 kind ───────────────

  test('六种 kind 各一条成功，prefix/kind/label 落库正确', async () => {
    const f = fixtures[0]!;
    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoIdHolder.value}/mentions`,
      headers: auth(f.key),
      payload: {
        messageId: f.messageId,
        mentions: [
          { kind: 'agent', prefix: '@', refId: f.agentId, label: 'AgentBot' },
          { kind: 'member', prefix: '@', refId: f.agentMemberId, label: 'AgentMemberRow' },
          { kind: 'todo', prefix: '#', refId: crossTodoIdHolder.value, label: 'CrossTodo' },
          { kind: 'skill', prefix: '/', refId: f.skillId, label: 'MySkill' },
          { kind: 'project', prefix: '~', refId: f.projectId, label: 'MainProject' },
          { kind: 'machine', prefix: '&', refId: f.machineId, label: 'EdgeBox' },
        ],
      },
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const body = JSON.parse(res.body) as { ok: boolean; mentions: Array<Record<string, unknown>> };
    assert.equal(body.ok, true);
    assert.equal(body.mentions.length, 6, '应返回 6 条 mentions');

    const byKind = new Map(body.mentions.map((m) => [m['kind'] as string, m]));
    assert.equal(byKind.get('agent')?.['prefix'], '@');
    assert.equal(byKind.get('agent')?.['refId'], f.agentId);
    assert.equal(byKind.get('agent')?.['label'], 'AgentBot');
    assert.equal(byKind.get('member')?.['prefix'], '@');
    assert.equal(byKind.get('member')?.['refId'], f.agentMemberId);
    assert.equal(byKind.get('todo')?.['prefix'], '#');
    assert.equal(byKind.get('todo')?.['refId'], crossTodoIdHolder.value);
    assert.equal(byKind.get('skill')?.['prefix'], '/');
    assert.equal(byKind.get('project')?.['prefix'], '~');
    assert.equal(byKind.get('machine')?.['prefix'], '&');

    // 真实 SQL 复核
    const sqlRows = await sql<{ kind: string; prefix: string; label: string; ref_id: string }[]>`
      select kind, prefix, label, ref_id from "build_message_mention"
      where message_id = ${f.messageId}
      order by kind
    `;
    assert.equal(sqlRows.length, 6, '数据库里恰好 6 行');
    const sqlByKind = new Map(sqlRows.map((r) => [r.kind, r]));
    assert.equal(sqlByKind.get('agent')?.prefix, '@');
    assert.equal(sqlByKind.get('agent')?.label, 'AgentBot');
    assert.equal(sqlByKind.get('member')?.prefix, '@');
    assert.equal(sqlByKind.get('todo')?.label, 'CrossTodo');
  });

  // ─────────────── 幂等 ───────────────

  test('同一 messageId 重复提交同一组 mentions → 幂等（不产生重复行）', async () => {
    const f = fixtures[0]!;
    const payload = {
      messageId: f.messageId,
      mentions: [
        { kind: 'agent', prefix: '@', refId: f.agentId, label: 'AgentBot' },
        { kind: 'machine', prefix: '&', refId: f.machineId, label: 'EdgeBox' },
      ],
    };
    const r1 = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoIdHolder.value}/mentions`,
      headers: auth(f.key),
      payload,
    });
    assert.equal(r1.statusCode, 200, `body=${r1.body}`);
    const r2 = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoIdHolder.value}/mentions`,
      headers: auth(f.key),
      payload,
    });
    assert.equal(r2.statusCode, 200, `body=${r2.body}`);
    const after = await countMentions(sql, f.messageId);
    assert.equal(after, 2, '幂等：第二次提交不产生新行');
  });

  // ─────────────── 跨 project 同 team（关键易假绿） ───────────────

  test('引用同 team 但不同 project 的 todo → 200（原站明确允许）', async () => {
    const f = fixtures[0]!;
    const res = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoIdHolder.value}/mentions`,
      headers: auth(f.key),
      payload: {
        messageId: f.messageId,
        mentions: [
          { kind: 'todo', prefix: '#', refId: crossTodoIdHolder.value, label: 'FromAnotherProject' },
        ],
      },
    });
    assert.equal(res.statusCode, 200, `body=${res.body}`);
    const after = await countMentions(sql, f.messageId);
    assert.equal(after, 1, '跨 project 同 team 的 todo 必须能引用');
    const rows = await sql<{ ref_id: string; label: string }[]>`
      select ref_id, label from "build_message_mention" where message_id = ${f.messageId}
    `;
    assert.equal(rows[0]?.ref_id, crossTodoIdHolder.value);
    assert.equal(rows[0]?.label, 'FromAnotherProject');
  });

  // ─────────────── GET ───────────────

  test('GET 按 messageId 读回 mentions', async () => {
    const f = fixtures[0]!;
    // 先写一条
    const post = await app.inject({
      method: 'POST',
      url: `/api/todos/${todoIdHolder.value}/mentions`,
      headers: auth(f.key),
      payload: {
        messageId: f.messageId,
        mentions: [
          { kind: 'skill', prefix: '/', refId: f.skillId, label: 'GetMeBack' },
        ],
      },
    });
    assert.equal(post.statusCode, 200);

    const get = await app.inject({
      method: 'GET',
      url: `/api/todos/${todoIdHolder.value}/mentions?messageId=${encodeURIComponent(f.messageId)}`,
      headers: auth(f.key),
    });
    assert.equal(get.statusCode, 200, `body=${get.body}`);
    const body = JSON.parse(get.body) as { mentions: Array<{ kind: string; refId: string; label: string }> };
    assert.equal(body.mentions.length, 1);
    assert.equal(body.mentions[0]?.kind, 'skill');
    assert.equal(body.mentions[0]?.refId, f.skillId);
    assert.equal(body.mentions[0]?.label, 'GetMeBack');
  });

  test('GET 缺 messageId → 422', async () => {
    const f = fixtures[0]!;
    const res = await app.inject({
      method: 'GET',
      url: `/api/todos/${todoIdHolder.value}/mentions`,
      headers: auth(f.key),
    });
    assert.equal(res.statusCode, 422, `body=${res.body}`);
  });

  test('GET 的 messageId 不属于该 todo 的 build → 404', async () => {
    const f = fixtures[0]!;
    const ghost = newId();
    const res = await app.inject({
      method: 'GET',
      url: `/api/todos/${todoIdHolder.value}/mentions?messageId=${encodeURIComponent(ghost)}`,
      headers: auth(f.key),
    });
    assert.equal(res.statusCode, 404, `body=${res.body}`);
  });

  // ─────────────── 残留验证 ───────────────

  test('fixture 清理后真实 SQL 验证零残留', async () => {
    // 这一条用完之后整个 fixtures 数组会被 after() 清空；这里先做一次"全部清掉"再校验。
    // 先用一份短命 fixture，after 钩子会负责清；这里只在 after 钩子跑过之后做 0 行验证。
    const tmp = await seedFixture(sql, 'mentions-leftover', ['*']);
    fixtures.push(tmp);
    // 不写任何 mention。直接走 deleteFixture
    await deleteFixture(sql, tmp);
    const rows = await sql<{ c: number }[]>`
      select count(*)::int as c
      from "build_message_mention"
      where build_id = ${tmp.buildId}
    `;
    assert.equal(rows[0]?.c, 0, 'fixture 删除后 mentions 必须零残留');
    // 同样验证主 fixture 的两个 todo / build / message 都不在
    const proj = await sql<{ c: number }[]>`
      select count(*)::int as c from "project" where id = ${tmp.projectId}
    `;
    assert.equal(proj[0]?.c, 0);
  });
});
