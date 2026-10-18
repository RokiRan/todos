import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as dbPkg from '@tds/db';
import { newId, now } from '../src/ids.js';
import {
  deleteTodos,
  relayQuestion,
  type DeleteTodoOutcome,
  type DeleteTodosResult,
} from '../src/services/todo-lifecycle.js';
import { HttpError } from '../src/http.js';

/**
 * Chief 工具面 todo 生命周期（`delete_todos` `relay_question`）端到端验证。
 *
 * 关键事实（与 `services/todos.ts:deleteTodo` 注释一致）：
 *   - 指向 todo / build 的 FK 都是 `onDelete: 'cascade'`，所以「删 todo」
 *     自动带走 build / document / build_message / checklist / step / step_credential
 *   - `audit_event.todo_id` 是裸 text 列（FK 只指 team），所以**不会**自动带走；
 *     单条 `deleteTodo` 内部显式清；本批量入口也复用了它
 *   - `delete_todos` 在 spec 标了 `irreversible: true` —— 闸门由 `chief/executor.ts`
 *     负责；服务层只管执行，不重复卡
 *
 * DB 是开发机 127.0.0.1:5433 上的 tds 真库；每个 test 用独立 fixture，
 * after 兜底清理。拒绝用例的「未写入」必须按 `team_id = ${fx.teamId}` 限定
 * 查库，绝不能 `count(*) from todo` —— 后者会被同 DB 上的并行测试污染。
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://tds@127.0.0.1:5433/tds';

const dbSchema = dbPkg.schema;

interface Fixture {
  label: string;
  userId: string;
  teamId: string;
  memberId: string;
  projectId: string;
  agentId: string;
  /** 给「跨团队」测试用：另一个 fixture 的资源能拿来用。 */
  otherTeamId: string;
  otherUserId: string;
  /** 给「跨团队」测试用：另一个 fixture 的 todoId（不该被删）。 */
  otherTodoId: string;
  otherBuildId: string;
}

const fixtures: Fixture[] = [];

async function seedFixture(sql: postgres.Sql, label: string): Promise<Fixture> {
  const ts = now();
  const userId = newId();
  const teamId = newId();
  const memberId = newId();
  const projectId = newId();
  const agentId = newId();

  // 「跨团队」资源：另一个 team 的 user + project + todo + build。
  const otherUserId = newId();
  const otherTeamId = newId();
  const otherMemberId = newId();
  const otherProjectId = newId();
  const otherTodoId = newId();
  const otherBuildId = newId();

  await sql.begin(async (tx) => {
    await tx`insert into "user" (id, email, display_name, status, locale, created_at, updated_at)
              values (${userId}, ${`${label}-${userId}@test.local`}, ${label}, 'active', 'en', ${ts}, ${ts})`;
    await tx`insert into "team" (id, name, plan, storage_quota, created_at)
              values (${teamId}, ${label}, 'free', 1073741824, ${ts})`;
    await tx`insert into "member" (id, team_id, actor_id, member_type, role, joined_at, v)
              values (${memberId}, ${teamId}, ${userId}, 'user', 'admin', ${ts}, 0)`;
    await tx`insert into "project" (id, team_id, name, provider, repo_kind, default_branch, next_seq_num, created_at)
              values (${projectId}, ${teamId}, ${label}, 'external', 'other', 'main', 1, ${ts})`;
    await tx`insert into "agent" (id, team_id, display_name, grants, default_skill_ids,
                                  active_task_count, created_at, updated_at)
              values (${agentId}, ${teamId}, ${label + '-agent'}, '{}', '{}', 0, ${ts}, ${ts})`;

    // 另一个 fixture 的资源 —— 给「跨团队不该碰」那条断言用。
    await tx`insert into "user" (id, email, display_name, status, locale, created_at, updated_at)
              values (${otherUserId}, ${`${label}-other-${otherUserId}@test.local`}, ${label + '-other'},
                      'active', 'en', ${ts}, ${ts})`;
    await tx`insert into "team" (id, name, plan, storage_quota, created_at)
              values (${otherTeamId}, ${label + '-other-team'}, 'free', 1073741824, ${ts})`;
    await tx`insert into "member" (id, team_id, actor_id, member_type, role, joined_at, v)
              values (${otherMemberId}, ${otherTeamId}, ${otherUserId}, 'user', 'admin', ${ts}, 0)`;
    await tx`insert into "project" (id, team_id, name, provider, repo_kind, default_branch, next_seq_num, created_at)
              values (${otherProjectId}, ${otherTeamId}, ${label + '-other-proj'}, 'external', 'other', 'main', 1, ${ts})`;
    await tx`insert into "todo" (id, project_id, seq_num, owner_member_id, title, tag_ids, phase,
                                 plan_first, separate_plan_build, with_checklist, created_at, updated_at)
              values (${otherTodoId}, ${otherProjectId}, 1, ${otherMemberId},
                      ${label + '-other-todo'}, '{}', 'todo', true, false, false, ${ts}, ${ts})`;
    const session = JSON.stringify({ runtime: 'pi', id: newId(), openedAt: ts });
    await tx`insert into "build" (id, todo_id, n, branch, prev_phase, trigger_source, with_plan, with_checklist,
                                  agent_id, session, usage_by_model, created_at, v)
              values (${otherBuildId}, ${otherTodoId}, 1, ${'tds/conv-' + otherBuildId}, 'todo', 'user', true, false,
                      ${agentId}, ${session}::jsonb, '[]'::jsonb, ${ts}, 0)`;
  });

  return {
    label,
    userId,
    teamId,
    memberId,
    projectId,
    agentId,
    otherTeamId,
    otherUserId,
    otherTodoId,
    otherBuildId,
  };
}

/** 给一条 todo 顺带塞一份 build + document + build_message，验证 FK cascade 真的带走。 */
async function seedRichTodo(
  sql: postgres.Sql,
  args: { projectId: string; agentId: string; memberId: string; seqNum: number },
): Promise<{ todoId: string; buildId: string; docId: string; msgId: string }> {
  const ts = now();
  const todoId = newId();
  const buildId = newId();
  const docId = newId();
  const msgId = newId();
  await sql.begin(async (tx) => {
    await tx`insert into "todo" (id, project_id, seq_num, owner_member_id, title, tag_ids, phase,
                                 plan_first, separate_plan_build, with_checklist, created_at, updated_at)
              values (${todoId}, ${args.projectId}, ${args.seqNum},
                      ${args.memberId}, ${'rich-' + todoId}, '{}', 'todo', true, false, false, ${ts}, ${ts})`;
    const session = JSON.stringify({ runtime: 'pi', id: newId(), openedAt: ts });
    await tx`insert into "build" (id, todo_id, n, branch, prev_phase, trigger_source, with_plan, with_checklist,
                                  agent_id, session, usage_by_model, created_at, v)
              values (${buildId}, ${todoId}, 1, ${'tds/conv-' + buildId}, 'todo', 'user', true, false,
                      ${args.agentId}, ${session}::jsonb, '[]'::jsonb, ${ts}, 0)`;
    await tx`insert into "document" (id, build_id, kind, version, payload, created_at, updated_at)
              values (${docId}, ${buildId}, 'plan', 1, ${'{"text":"plan body"}'}::jsonb, ${ts}, ${ts})`;
    await tx`insert into "build_message" (id, build_id, role, content, seq, created_at)
              values (${msgId}, ${buildId}, 'user', ${'hi-' + msgId}::text, 1, ${ts})`;
  });
  return { todoId, buildId, docId, msgId };
}

async function cleanupFixture(sql: postgres.Sql, f: Fixture): Promise<void> {
  await sql`delete from "audit_event" where team_id = ${f.teamId}`;
  await sql`delete from "audit_event" where team_id = ${f.otherTeamId}`;
  await sql`delete from "sse_event" where team_id = ${f.teamId}`;
  await sql`delete from "sse_event" where team_id = ${f.otherTeamId}`;
  await sql`delete from "document" where build_id in (select id from "build" where todo_id in (select id from "todo" where project_id in (select id from "project" where team_id in (${f.teamId}, ${f.otherTeamId}))))`;
  await sql`delete from "build" where todo_id in (select id from "todo" where project_id in (select id from "project" where team_id in (${f.teamId}, ${f.otherTeamId})))`;
  await sql`delete from "todo" where project_id in (select id from "project" where team_id in (${f.teamId}, ${f.otherTeamId}))`;
  await sql`delete from "project" where team_id in (${f.teamId}, ${f.otherTeamId})`;
  await sql`delete from "agent" where team_id = ${f.teamId}`;
  await sql`delete from "member" where team_id in (${f.teamId}, ${f.otherTeamId})`;
  await sql`delete from "team" where id in (${f.teamId}, ${f.otherTeamId})`;
  await sql`delete from "user" where id in (${f.userId}, ${f.otherUserId})`;
}

type Db = PostgresJsDatabase<typeof dbSchema>;

let sql: postgres.Sql;
let db: Db;

before(async () => {
  sql = postgres(DATABASE_URL, { max: 5 });
  db = drizzle(sql, { schema: dbSchema }) as Db;
});

after(async () => {
  for (const f of fixtures) await cleanupFixture(sql, f);
  await sql.end();
});

describe('deleteTodos', () => {
  test('正向：单删一个 todo —— build / document / message 都被 FK cascade 带走', async () => {
    const fx = await seedFixture(sql, 'del-cascade');
    fixtures.push(fx);
    const rich = await seedRichTodo(sql, {
      projectId: fx.projectId,
      agentId: fx.agentId,
      memberId: fx.memberId,
      seqNum: 1,
    });

    // sanity：删前三条记录都在。
    const beforeDoc = await sql<{ c: number }[]>`select count(*)::int as c from "document" where id = ${rich.docId}`;
    const beforeMsg = await sql<{ c: number }[]>`select count(*)::int as c from "build_message" where id = ${rich.msgId}`;
    const beforeBuild = await sql<{ c: number }[]>`select count(*)::int as c from "build" where id = ${rich.buildId}`;
    assert.equal(beforeDoc[0]?.c, 1, 'sanity: document 行存在');
    assert.equal(beforeMsg[0]?.c, 1, 'sanity: build_message 行存在');
    assert.equal(beforeBuild[0]?.c, 1, 'sanity: build 行存在');

    const r: DeleteTodosResult = await deleteTodos(db, {
      teamId: fx.teamId,
      actorId: fx.userId,
      todoIds: [rich.todoId],
    });

    assert.equal(r.succeeded, 1, 'succeeded 必须为 1');
    assert.equal(r.failed, 0, 'failed 必须为 0');
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0]?.todoId, rich.todoId);
    assert.equal(r.results[0]?.ok, true);

    // FK cascade 验证（这条要查库逐表验）：
    const afterTodo = await sql<{ c: number }[]>`select count(*)::int as c from "todo" where id = ${rich.todoId}`;
    const afterBuild = await sql<{ c: number }[]>`select count(*)::int as c from "build" where id = ${rich.buildId}`;
    const afterDoc = await sql<{ c: number }[]>`select count(*)::int as c from "document" where id = ${rich.docId}`;
    const afterMsg = await sql<{ c: number }[]>`select count(*)::int as c from "build_message" where id = ${rich.msgId}`;
    assert.equal(afterTodo[0]?.c, 0, 'MUTATION? todo 应被删');
    assert.equal(afterBuild[0]?.c, 0, 'MUTATION? build 应被 FK cascade 带走');
    assert.equal(afterDoc[0]?.c, 0, 'MUTATION? document 应被 FK cascade 带走');
    assert.equal(afterMsg[0]?.c, 0, 'MUTATION? build_message 应被 FK cascade 带走');

    // 审计双轨：必须有一条 `todo_deleted` 落 audit_event。
    const audit = await sql<{ c: number }[]>`select count(*)::int as c from "audit_event"
                                              where team_id = ${fx.teamId} and type = 'todo_deleted'`;
    assert.equal(audit[0]?.c ?? 0, 1, 'MUTATION? 应留一条 todo_deleted 审计');
  });

  test('跨团队：传别的 team 的 todoId → ok:false 且库里未删', async () => {
    const fx = await seedFixture(sql, 'del-cross');
    fixtures.push(fx);

    const beforeOtherTodo = await sql<{ c: number }[]>`select count(*)::int as c from "todo" where id = ${fx.otherTodoId}`;
    const beforeOtherBuild = await sql<{ c: number }[]>`select count(*)::int as c from "build" where id = ${fx.otherBuildId}`;
    const beforeOwnAudit = await sql<{ c: number }[]>`select count(*)::int as c from "audit_event"
                                                    where team_id = ${fx.teamId}`;
    assert.equal(beforeOtherTodo[0]?.c, 1, 'sanity: otherTodoId 行存在');
    assert.equal(beforeOtherBuild[0]?.c, 1, 'sanity: otherBuildId 行存在');

    const r = await deleteTodos(db, {
      teamId: fx.teamId, // ← 拿自己的 teamId 删 otherTodoId
      actorId: fx.userId,
      todoIds: [fx.otherTodoId],
    });

    assert.equal(r.succeeded, 0, '跨团队不该 succeeded');
    assert.equal(r.failed, 1, '跨团队必须进 failed');
    assert.equal(r.results[0]?.ok, false);
    assert.match(
      r.results[0]?.reason ?? '',
      /not accessible to this key's owner/,
      `MUTATION? 403 措辞：${r.results[0]?.reason}`,
    );

    // 库里未删：otherTodoId 行还在、otherBuildId 行还在、自己 team 没新增审计。
    const afterOtherTodo = await sql<{ c: number }[]>`select count(*)::int as c from "todo" where id = ${fx.otherTodoId}`;
    const afterOtherBuild = await sql<{ c: number }[]>`select count(*)::int as c from "build" where id = ${fx.otherBuildId}`;
    const afterOwnAudit = await sql<{ c: number }[]>`select count(*)::int as c from "audit_event"
                                                   where team_id = ${fx.teamId}`;
    assert.equal(afterOtherTodo[0]?.c, 1, 'MUTATION? otherTodoId 不该被删');
    assert.equal(afterOtherBuild[0]?.c, 1, 'MUTATION? otherBuildId 不该被 FK 带走');
    assert.equal(
      afterOwnAudit[0]?.c ?? 0,
      beforeOwnAudit[0]?.c ?? 0,
      'MUTATION? 跨团队尝试不该留 todo_deleted 审计',
    );
  });

  test('跨团队：传不存在的 todoId → 与跨团队同款 reason（不泄露存在性）', async () => {
    const fx = await seedFixture(sql, 'del-missing');
    fixtures.push(fx);
    const ghost = newId();

    const r = await deleteTodos(db, {
      teamId: fx.teamId,
      actorId: fx.userId,
      todoIds: [ghost],
    });

    assert.equal(r.failed, 1);
    assert.equal(r.results[0]?.ok, false);
    assert.match(
      r.results[0]?.reason ?? '',
      /not accessible to this key's owner/,
      'MUTATION? 不存在与跨团队给同一个 403 措辞',
    );
  });

  test('批量：三项里一项失败不影响其它项', async () => {
    const fx = await seedFixture(sql, 'del-batch');
    fixtures.push(fx);
    const ok1 = await seedRichTodo(sql, {
      projectId: fx.projectId,
      agentId: fx.agentId,
      memberId: fx.memberId,
      seqNum: 1,
    });
    const ok2 = await seedRichTodo(sql, {
      projectId: fx.projectId,
      agentId: fx.agentId,
      memberId: fx.memberId,
      seqNum: 2,
    });

    const r = await deleteTodos(db, {
      teamId: fx.teamId,
      actorId: fx.userId,
      todoIds: [ok1.todoId, fx.otherTodoId, ok2.todoId], // 中间塞跨团队的
    });

    assert.equal(r.succeeded, 2, '只有两项 ok');
    assert.equal(r.failed, 1, '中间一项失败');
    assert.equal(r.results.length, 3);

    const outById: Record<string, DeleteTodoOutcome> = {};
    for (const o of r.results) outById[o.todoId] = o;
    assert.equal(outById[ok1.todoId]?.ok, true);
    assert.equal(outById[ok2.todoId]?.ok, true);
    assert.equal(outById[fx.otherTodoId]?.ok, false);
    assert.match(
      outById[fx.otherTodoId]?.reason ?? '',
      /not accessible to this key's owner/,
    );

    // 库里：ok1 / ok2 都该被删；otherTodoId 不该动。
    const afterOk1 = await sql<{ c: number }[]>`select count(*)::int as c from "todo" where id = ${ok1.todoId}`;
    const afterOk2 = await sql<{ c: number }[]>`select count(*)::int as c from "todo" where id = ${ok2.todoId}`;
    const afterOther = await sql<{ c: number }[]>`select count(*)::int as c from "todo" where id = ${fx.otherTodoId}`;
    assert.equal(afterOk1[0]?.c, 0, 'MUTATION? ok1 应被删');
    assert.equal(afterOk2[0]?.c, 0, 'MUTATION? ok2 应被删');
    assert.equal(afterOther[0]?.c, 1, 'MUTATION? otherTodoId 不该被删');

    // 审计双轨：成功项每条一条 todo_deleted，跨团队那项不留痕。
    const audit = await sql<{ c: number }[]>`select count(*)::int as c from "audit_event"
                                            where team_id = ${fx.teamId} and type = 'todo_deleted'`;
    assert.equal(audit[0]?.c ?? 0, 2, 'MUTATION? 应留 2 条 todo_deleted 审计（成功那 2 项）');
  });

  test('批量：空 todoIds → 空 results / 0/0，不报错', async () => {
    const fx = await seedFixture(sql, 'del-empty');
    fixtures.push(fx);
    const r = await deleteTodos(db, {
      teamId: fx.teamId,
      actorId: fx.userId,
      todoIds: [],
    });
    assert.equal(r.succeeded, 0);
    assert.equal(r.failed, 0);
    assert.equal(r.results.length, 0);
  });
});

describe('relayQuestion', () => {
  test('正向：转 agent 提问 → 落 question 文档，askedBy.type=agent', async () => {
    const fx = await seedFixture(sql, 'relay-happy');
    fixtures.push(fx);
    // relayQuestion 要 todo 上有 build（复用 askUser 的约束）—— 给 fx.teamId 建一个。
    const todoId = newId();
    const buildId = newId();
    const ts = now();
    const session = JSON.stringify({ runtime: 'pi', id: newId(), openedAt: ts });
    await sql.begin(async (tx) => {
      await tx`insert into "todo" (id, project_id, seq_num, owner_member_id, title, tag_ids, phase,
                                   plan_first, separate_plan_build, with_checklist, created_at, updated_at)
                values (${todoId}, ${fx.projectId}, 1, ${fx.memberId}, ${'relay-' + todoId}, '{}', 'todo',
                        true, false, false, ${ts}, ${ts})`;
      await tx`insert into "build" (id, todo_id, n, branch, prev_phase, trigger_source, with_plan, with_checklist,
                                    agent_id, session, usage_by_model, created_at, v)
                values (${buildId}, ${todoId}, 1, ${'tds/conv-' + buildId}, 'todo', 'user', true, false,
                        ${fx.agentId}, ${session}::jsonb, '[]'::jsonb, ${ts}, 0)`;
    });

    const doc = await relayQuestion(db, {
      teamId: fx.teamId,
      actorId: fx.userId,
      todoId,
      agent: { id: fx.agentId, name: '调研员' },
      question: '覆盖国内厂商？',
      options: [{ id: 'yes', label: '要' }, { id: 'no', label: '不要' }],
      allowFreeText: true,
    });

    assert.equal(doc.askedBy.type, 'agent', 'askedBy.type 必须为 agent');
    assert.equal(doc.askedBy.id, fx.agentId);
    assert.equal(doc.options.length, 2);

    // 反查：documents 表里能查到这条。
    const row = await sql<{ kind: string; payload: unknown }[]>`
      select kind, payload from "document" where id = ${doc.id}
    `;
    assert.equal(row[0]?.kind, 'question');
  });

  test('跨团队：传别的 team 的 todoId → 403 且库里未写 question / 未写 audit', async () => {
    const fx = await seedFixture(sql, 'relay-cross');
    fixtures.push(fx);

    const beforeDocCount = await sql<{ c: number }[]>`select count(*)::int as c from "document"
                                                     where build_id = ${fx.otherBuildId}`;
    const beforeAuditCount = await sql<{ c: number }[]>`select count(*)::int as c from "audit_event"
                                                      where team_id = ${fx.teamId}`;

    await assert.rejects(
      relayQuestion(db, {
        teamId: fx.teamId, // ← 拿自己的 teamId 写 otherTodoId
        actorId: fx.userId,
        todoId: fx.otherTodoId,
        agent: { id: fx.agentId, name: 'x' },
        question: '跨团队提问应被拒',
        options: [{ id: 'y', label: 'y' }],
      }),
      (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.match(
          e.message,
          /not accessible to this key's owner/,
          `MUTATION? 403 措辞：${e.message}`,
        );
        return true;
      },
    );

    const afterDocCount = await sql<{ c: number }[]>`select count(*)::int as c from "document"
                                                    where build_id = ${fx.otherBuildId}`;
    const afterAuditCount = await sql<{ c: number }[]>`select count(*)::int as c from "audit_event"
                                                     where team_id = ${fx.teamId}`;
    assert.equal(
      afterDocCount[0]?.c ?? 0,
      beforeDocCount[0]?.c ?? 0,
      'MUTATION? 跨团队不该给 otherBuildId 落任何 document',
    );
    assert.equal(
      afterAuditCount[0]?.c ?? 0,
      beforeAuditCount[0]?.c ?? 0,
      'MUTATION? 跨团队不该留 question_asked 审计',
    );
  });

  test('正向：question / options 任一为空 → 400', async () => {
    const fx = await seedFixture(sql, 'relay-empty');
    fixtures.push(fx);
    const todoId = newId();
    const buildId = newId();
    const ts = now();
    const session = JSON.stringify({ runtime: 'pi', id: newId(), openedAt: ts });
    await sql.begin(async (tx) => {
      await tx`insert into "todo" (id, project_id, seq_num, owner_member_id, title, tag_ids, phase,
                                   plan_first, separate_plan_build, with_checklist, created_at, updated_at)
                values (${todoId}, ${fx.projectId}, 1, ${fx.memberId}, ${'relay-empty-' + todoId}, '{}', 'todo',
                        true, false, false, ${ts}, ${ts})`;
      await tx`insert into "build" (id, todo_id, n, branch, prev_phase, trigger_source, with_plan, with_checklist,
                                    agent_id, session, usage_by_model, created_at, v)
                values (${buildId}, ${todoId}, 1, ${'tds/conv-' + buildId}, 'todo', 'user', true, false,
                        ${fx.agentId}, ${session}::jsonb, '[]'::jsonb, ${ts}, 0)`;
    });

    await assert.rejects(
      relayQuestion(db, {
        teamId: fx.teamId,
        actorId: fx.userId,
        todoId,
        agent: { id: fx.agentId, name: 'x' },
        question: '',
        options: [{ id: 'y', label: 'y' }],
      }),
      (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.match(e.message, /must not be empty/);
        return true;
      },
    );
    await assert.rejects(
      relayQuestion(db, {
        teamId: fx.teamId,
        actorId: fx.userId,
        todoId,
        agent: { id: fx.agentId, name: 'x' },
        question: '有选项吗？',
        options: [],
      }),
      (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.match(e.message, /at least one option/);
        return true;
      },
    );
  });
});

// 让 TS 闭嘴：HttpError 是 services 层抛的「内部信号」，这里只 import 避免
// 后续断言扩展时再次补 import。
void HttpError;
