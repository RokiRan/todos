import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import postgres from 'postgres';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '@tds/db';
import { newId, now } from '../src/ids.js';
import {
  askUser,
  getTeamUsage,
  listDocs,
  listQuestionsForTodo,
  notifyUser,
} from '../src/services/chief-interaction.js';

/**
 * Chief interaction 类工具（`ask_user` `notify_user` `usage` `docs`）的服务层验证。
 *
 * 覆盖：
 *   - **正向**：四个工具各自返回符合语义的形状
 *   - **跨团队 403**：用第二个 fixture 调第一个 fixture 的资源 → HttpError(403)，
 *     措辞与既有 `not accessible to this key's owner` 同款；且查库证明未写入
 *   - **ask_user 落 question 文档**：写完能按 `kind='question'` 反查到，且
 *     version 单调递增（与 `services/todos.ts` 的 `input` 文档同款）
 *   - **notify_user 复用了 notify.ts**：决策走 `decideNotify`；
 *     Chief 触发的 `shouldNotify:false` 也会写一条 `notify_*` 审计
 *
 * 「MUTATION?」前缀：每个拒绝用例都查库证明未写、未改，只断言返回值不算证明。
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://tds:tds_local_dev@127.0.0.1:5433/tds';

interface Fixture {
  label: string;
  userId: string;
  teamId: string;
  memberId: string;
  projectId: string;
  todoId: string;
  agentId: string;
  buildId: string;
}

async function seedFixture(sql: postgres.Sql, label: string): Promise<Fixture> {
  const ts = now();
  const userId = newId();
  const teamId = newId();
  const memberId = newId();
  const projectId = newId();
  const todoId = newId();
  const agentId = newId();
  const buildId = newId();

  await sql`
    insert into "user" (id, email, display_name, status, locale, created_at, updated_at)
    values (${userId}, ${`${label}-${userId}@test.local`}, ${label}, 'active', 'en', ${ts}, ${ts})
  `;
  await sql`
    insert into "team" (id, name, plan, storage_quota, created_at)
    values (${teamId}, ${label}, 'free', 1073741824, ${ts})
  `;
  await sql`
    insert into "member" (id, team_id, actor_id, member_type, role, joined_at, v)
    values (${memberId}, ${teamId}, ${userId}, 'user', 'admin', ${ts}, 0)
  `;
  await sql`
    insert into "project" (id, team_id, name, provider, repo_kind, default_branch, next_seq_num, created_at)
    values (${projectId}, ${teamId}, ${label}, 'external', 'other', 'main', 1, ${ts})
  `;
  await sql`
    insert into "todo" (id, project_id, seq_num, owner_member_id, title, tag_ids, phase,
                        plan_first, separate_plan_build, with_checklist, created_at, updated_at)
    values (${todoId}, ${projectId}, 1, ${memberId}, ${'todo-' + label}, '{}', 'todo',
            true, false, false, ${ts}, ${ts})
  `;
  await sql`
    insert into "agent" (id, team_id, display_name, grants, default_skill_ids,
                         active_task_count, created_at, updated_at)
    values (${agentId}, ${teamId}, ${'agent-' + label}, '{}', '{}', 0, ${ts}, ${ts})
  `;
  // build 必填（ask_user 的文档要挂到 build 上）。
  const session = JSON.stringify({ runtime: 'pi', id: newId(), openedAt: ts });
  await sql`
    insert into "build" (id, todo_id, n, branch, prev_phase, trigger_source, with_plan, with_checklist,
                         agent_id, session, usage_by_model, created_at, v)
    values (${buildId}, ${todoId}, 1, ${'tds/conv-' + buildId}, 'todo', 'user', true, false,
            ${agentId}, ${session}::jsonb, '[]'::jsonb, ${ts}, 0)
  `;

  return { label, userId, teamId, memberId, projectId, todoId, agentId, buildId };
}

async function deleteFixture(sql: postgres.Sql, f: Fixture): Promise<void> {
  await sql`delete from "audit_event" where team_id = ${f.teamId}`;
  await sql`delete from "sse_event" where team_id = ${f.teamId}`;
  await sql`delete from "document" where build_id in (select id from "build" where todo_id in (select id from "todo" where project_id in (select id from "project" where team_id = ${f.teamId})))`;
  await sql`delete from "build" where todo_id in (select id from "todo" where project_id in (select id from "project" where team_id = ${f.teamId}))`;
  await sql`delete from "todo" where project_id in (select id from "project" where team_id = ${f.teamId})`;
  await sql`delete from "project" where team_id = ${f.teamId}`;
  await sql`delete from "agent" where team_id = ${f.teamId}`;
  await sql`delete from "member" where team_id = ${f.teamId}`;
  await sql`delete from "team" where id = ${f.teamId}`;
  await sql`delete from "user" where id = ${f.userId}`;
}

const sql = postgres(DATABASE_URL, { max: 4 });
const db = drizzle(sql, { schema });

const fixtures: Fixture[] = [];
const secondaryRefs: Array<{ teamId: string; userId: string }> = [];

before(async () => {
  // 把外层 drizzle 包成与生产同形（schema 提供 documents / todos / projects ...）。
  void db;
});

after(async () => {
  for (const f of fixtures) await deleteFixture(sql, f);
  for (const ref of secondaryRefs) {
    await sql`delete from "team" where id = ${ref.teamId}`;
    await sql`delete from "user" where id = ${ref.userId}`;
  }
  await sql.end();
});

describe('ask_user', () => {
  test('正向：给 todo 建一条 question 文档，version 单调递增', async () => {
    const f = await seedFixture(sql, 'ask-happy');
    fixtures.push(f);

    const first = await askUser(db, {
      teamId: f.teamId,
      actorId: f.userId,
      todoId: f.todoId,
      askedBy: { type: 'chief', id: 'chief-1', name: '统筹' },
      question: '要不要覆盖国内厂商？',
      options: [
        { id: 'yes', label: '要' },
        { id: 'no', label: '不要' },
      ],
      allowFreeText: true,
    });

    assert.equal(first.version, 1, '第一条 question 文档 version 应为 1');
    assert.equal(first.askedBy.type, 'chief');
    assert.equal(first.options.length, 2);

    const second = await askUser(db, {
      teamId: f.teamId,
      actorId: f.userId,
      todoId: f.todoId,
      askedBy: { type: 'agent', id: f.agentId, name: '调研员' },
      question: '要不要再来一遍？',
      options: [{ id: 'y', label: '好' }],
    });

    assert.equal(second.version, 2, '同 build 上第二条 question 应递增到 2');

    // 反查能查到两条 —— 这条链路必须能按 kind 查到，UI 才能展示。
    const all = await listQuestionsForTodo(db, f.teamId, f.todoId);
    assert.equal(all.length, 2, `应查到 2 条 question 文档，实际 ${all.length}`);
    assert.equal(all[0]?.version, 2);
    assert.equal(all[1]?.version, 1);

    // 审计双轨 —— 必须有一条 `question_asked` 落 audit_event。
    const auditRows = await sql<{ c: number }[]>`
      select count(*)::int as c from "audit_event"
      where team_id = ${f.teamId} and type = 'question_asked'
    `;
    assert.equal(auditRows[0]?.c ?? 0, 2, '应留 2 条 question_asked 审计');
  });

  test('跨 team：传别的 team 的 todoId → 403 且不留任何行', async () => {
    const a = await seedFixture(sql, 'ask-cross-a');
    const b = await seedFixture(sql, 'ask-cross-b');
    fixtures.push(a, b);

    const before = await sql<{ c: number }[]>`
      select count(*)::int as c from "document"
      where build_id in (select id from "build" where todo_id = ${a.todoId})
    `;
    const beforeAudit = await sql<{ c: number }[]>`
      select count(*)::int as c from "audit_event" where team_id = ${a.teamId}
    `;

    await assert.rejects(
      askUser(db, {
        teamId: b.teamId, // ← 拿 b 的 teamId 传 a 的 todoId
        actorId: b.userId,
        todoId: a.todoId,
        askedBy: { type: 'chief', id: 'c', name: 'c' },
        question: '跨团队提问应被拒',
        options: [{ id: 'x', label: 'x' }],
      }),
      (e: unknown) => {
        assert.ok(e instanceof Error, '必须抛 Error');
        assert.match(e.message, /not accessible to this key's owner/, `MUTATION? 403 措辞：${e.message}`);
        return true;
      },
    );

    const after = await sql<{ c: number }[]>`
      select count(*)::int as c from "document"
      where build_id in (select id from "build" where todo_id = ${a.todoId})
    `;
    const afterAudit = await sql<{ c: number }[]>`
      select count(*)::int as c from "audit_event" where team_id = ${a.teamId}
    `;
    assert.equal(
      after[0]?.c ?? 0,
      before[0]?.c ?? 0,
      'MUTATION? 跨团队不该给 a 的 todo 落任何 document',
    );
    assert.equal(
      afterAudit[0]?.c ?? 0,
      beforeAudit[0]?.c ?? 0,
      'MUTATION? 跨团队不该给 a 的 team 留审计',
    );
  });

  test('正向：question / options 任一为空 → 400', async () => {
    const f = await seedFixture(sql, 'ask-empty');
    fixtures.push(f);

    await assert.rejects(
      askUser(db, {
        teamId: f.teamId,
        actorId: f.userId,
        todoId: f.todoId,
        askedBy: { type: 'chief', id: 'c', name: 'c' },
        question: '',
        options: [{ id: 'x', label: 'x' }],
      }),
      (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.match(e.message, /must not be empty/, `MUTATION? 空 question 应报 400：${e.message}`);
        return true;
      },
    );
    await assert.rejects(
      askUser(db, {
        teamId: f.teamId,
        actorId: f.userId,
        todoId: f.todoId,
        askedBy: { type: 'chief', id: 'c', name: 'c' },
        question: '有选项吗？',
        options: [],
      }),
      (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.match(e.message, /at least one option/, `MUTATION? 空 options 应报 400：${e.message}`);
        return true;
      },
    );
  });
});

describe('notify_user', () => {
  test('正向：chief trigger → decision.shouldNotify=false，但审计留痕', async () => {
    const f = await seedFixture(sql, 'notify-chief');
    fixtures.push(f);

    const outcome = await notifyUser(db, {
      teamId: f.teamId,
      actorId: f.userId,
      todoId: f.todoId,
      event: 'agent_note',
      triggerBy: 'chief', // Chief 触发 —— 文档铁律：不推 banner
    });

    assert.equal(outcome.decision.shouldNotify, false, 'Chief 触发不该推 banner');
    assert.match(outcome.decision.reason, /chief tracks its own dispatch/, `MUTATION? 措辞：${outcome.decision.reason}`);
    assert.equal(outcome.audited, true, '即使不推也要写审计');

    const rows = await sql<{ type: string; payload: unknown }[]>`
      select type, payload from "audit_event"
      where team_id = ${f.teamId} and type = 'notify_agent_note'
      order by created_at desc limit 1
    `;
    assert.equal(rows.length, 1, '应留一条 notify_agent_note 审计');
    const payload = rows[0]?.payload as { shouldNotify: boolean; reason: string };
    assert.equal(payload.shouldNotify, false, '审计里也要记录决策结果');
  });

  test('正向：user trigger → shouldNotify=true', async () => {
    const f = await seedFixture(sql, 'notify-user');
    fixtures.push(f);

    const outcome = await notifyUser(db, {
      teamId: f.teamId,
      actorId: f.userId,
      todoId: f.todoId,
      event: 'build_finished',
      triggerBy: 'user',
    });
    assert.equal(outcome.decision.shouldNotify, true);
    assert.match(outcome.decision.reason, /owner receives build_finished/);
  });

  test('跨 team：传别的 team 的 todoId → 403 且不写审计', async () => {
    const a = await seedFixture(sql, 'notify-cross-a');
    const b = await seedFixture(sql, 'notify-cross-b');
    fixtures.push(a, b);

    const before = await sql<{ c: number }[]>`
      select count(*)::int as c from "audit_event" where team_id = ${a.teamId}
    `;

    await assert.rejects(
      notifyUser(db, {
        teamId: b.teamId,
        actorId: b.userId,
        todoId: a.todoId,
        event: 'agent_note',
        triggerBy: 'chief',
      }),
      (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.match(e.message, /not accessible to this key's owner/);
        return true;
      },
    );

    const after = await sql<{ c: number }[]>`
      select count(*)::int as c from "audit_event" where team_id = ${a.teamId}
    `;
    assert.equal(after[0]?.c ?? 0, before[0]?.c ?? 0, 'MUTATION? 跨团队不该给 a 的 team 留审计');
  });
});

describe('usage', () => {
  test('正向：返回 Free 档用量盘点 + 不存在 team → 403', async () => {
    const f = await seedFixture(sql, 'usage-happy');
    fixtures.push(f);

    const u = await getTeamUsage(db, f.teamId);
    assert.equal(u.teamId, f.teamId);
    assert.equal(u.plan, 'free');
    assert.equal(u.monthlyCredits.limit, 0, 'Free 档月度 credits 上限是 0');
    assert.equal(u.monthlyCredits.used, 0);
    assert.equal(u.storage.limitBytes, 1073741824);
    assert.equal(u.freeLimits.agents, 5);
    assert.ok(u.counts.agents >= 0, 'counts.agents 应存在');
    assert.ok(u.counts.projects >= 1, 'fixture 种了 1 个 project');

    // 不存在的 team → 403
    await assert.rejects(
      getTeamUsage(db, 'no-such-team'),
      (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.match(e.message, /not accessible to this key's owner/);
        return true;
      },
    );
  });
});

describe('docs', () => {
  test('正向：当前未确认语义 → 恒返回空数组', async () => {
    const f = await seedFixture(sql, 'docs-empty');
    fixtures.push(f);
    const docs = await listDocs(db, f.teamId);
    assert.ok(Array.isArray(docs), '必须返回数组（不是 404 / 抛错）');
    assert.equal(docs.length, 0, '原站语义未确认，固定回空');
  });
});
