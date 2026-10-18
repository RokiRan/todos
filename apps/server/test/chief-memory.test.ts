/**
 * Chief memory 组服务层测试 —— 8 个工具全覆盖 + 跨团队 403 + 库内"未写入"取证。
 *
 * 关键约束（来自 brief + 已被同库并行测试喂红三次的硬规则）：
 *   - 真库 postgres://tds@127.0.0.1:5433/tds
 *   - 每条拒绝用例必须查库证明"未写入"，且 **只用本 fixture 名下行**
 *     （where team_id = ${fx.teamId}）—— 不允许全表 count（库是共享的）
 *   - 断言消息统一带 MUTATION? 前缀；mutation 验证后源码不许留裸 MUTATION
 *   - fixture 里 agent.default_skill_ids 是 text[] not jsonb：'{}'::text[]
 *   - 不跑全量 typecheck/test；只跑这一文件
 *
 * 对照 chief/tools.ts:98-105 这 8 个工具，每个至少一条正向：
 *   memories / save_memory / delete_memory / watch_todos / unwatch_todos /
 *   set_wake / clear_wake / wakes
 *
 * 不可逆（delete_memory / delete_skills 等）由上层 confirmation card 决定，
 * service 层直接执行并落审计。
 */
import assert from 'node:assert/strict';
import { test, describe, before, after, beforeEach } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Db } from '@tds/db';
import * as dbPkg from '@tds/db';
import { newId, now } from '../src/ids.js';
import * as svc from '../src/services/chief-memory.js';
import { HttpError } from '../src/http.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://tds@127.0.0.1:5433/tds';

let sql: postgres.Sql;
let db: Db;
const fixtures: Fixture[] = [];

interface Fixture {
  userId: string;
  teamId: string;
  agentId: string;
  chiefId: string;
  threadId: string;
  projectId: string;
  todoId: string;
  /** 第二个团队，专门做跨团队 403 用 */
  otherTeamId: string;
  otherThreadId: string;
  otherTodoId: string;
  otherAgentId: string;
}

async function seed(): Promise<Fixture> {
  const ts = now();
  const userId = newId();
  const teamId = newId();
  const memberId = newId();
  const chiefId = `chief-${userId}-${teamId}`;
  const agentId = newId();
  const threadId = newId();
  const projectId = newId();
  const todoId = newId();
  // 第二个团队：让 cross-team 拒绝测试用的资源也齐全
  const otherUserId = newId();
  const otherTeamId = newId();
  const otherMemberId = newId();
  const otherChiefId = `chief-${otherUserId}-${otherTeamId}`;
  const otherAgentId = newId();
  const otherProjectId = newId();
  const otherThreadId = newId();
  const otherTodoId = newId();
  const session = { runtime: 'claude-code', id: newId(), openedAt: ts };

  await sql`insert into "user" (id,email,display_name,created_at,updated_at)
            values (${userId}, ${`chief-mem-${userId}@test.local`}, ${'me'}, ${ts}, ${ts})`;
  await sql`insert into team (id,name,plan,storage_quota,created_at)
            values (${teamId}, ${'chief-mem-home'}, 'free', 1073741824, ${ts})`;
  await sql`insert into member (id,team_id,actor_id,member_type,role,joined_at,v)
            values (${memberId}, ${teamId}, ${userId}, 'user', 'admin', ${ts}, 0)`;
  await sql`insert into agent (id,team_id,display_name,default_skill_ids,grants,
                                active_task_count,created_at,updated_at)
            values (${agentId}, ${teamId}, ${'chief'}, ${'{}'}, ${'{}'}::jsonb,
                    0, ${ts}, ${ts})`;
  await sql`insert into chief (id,user_id,team_id,agent_id,created_at,updated_at)
            values (${chiefId}, ${userId}, ${teamId}, ${agentId}, ${ts}, ${ts})`;
  await sql`insert into chief_thread (id,chief_id,title,session,tool_def_hashes,
                                       watched_todos,created_at,updated_at)
            values (${threadId}, ${chiefId}, ${'topic-mem'},
                    ${JSON.stringify(session)}::jsonb, ${'{}'}::jsonb, ${'{}'},
                    ${ts}, ${ts})`;
  await sql`insert into project (id,team_id,name,provider,repo_kind,
                                  default_branch,next_seq_num,created_at)
            values (${projectId}, ${teamId}, ${'p1'}, 'external', 'other',
                    'main', 1, ${ts})`;
  await sql`insert into todo (id,project_id,seq_num,owner_member_id,agent_id,
                               title,tag_ids,phase,plan_first,separate_plan_build,
                               with_checklist,created_at,updated_at)
            values (${todoId}, ${projectId}, 1, ${memberId}, ${agentId},
                    ${'memory-test'}, ${'{}'}, 'todo',
                    true, false, false, ${ts}, ${ts})`;

  // second team
  await sql`insert into "user" (id,email,display_name,created_at,updated_at)
            values (${otherUserId}, ${`chief-mem-other-${otherUserId}@test.local`},
                    ${'other'}, ${ts}, ${ts})`;
  await sql`insert into team (id,name,plan,storage_quota,created_at)
            values (${otherTeamId}, ${'chief-mem-other'}, 'free', 1073741824, ${ts})`;
  await sql`insert into member (id,team_id,actor_id,member_type,role,joined_at,v)
            values (${otherMemberId}, ${otherTeamId}, ${otherUserId}, 'user', 'admin',
                    ${ts}, 0)`;
  await sql`insert into agent (id,team_id,display_name,default_skill_ids,grants,
                                active_task_count,created_at,updated_at)
            values (${otherAgentId}, ${otherTeamId}, ${'otherChief'}, ${'{}'},
                    ${'{}'}::jsonb, 0, ${ts}, ${ts})`;
  await sql`insert into chief (id,user_id,team_id,agent_id,created_at,updated_at)
            values (${otherChiefId}, ${otherUserId}, ${otherTeamId},
                    ${otherAgentId}, ${ts}, ${ts})`;
  await sql`insert into chief_thread (id,chief_id,title,session,tool_def_hashes,
                                       watched_todos,created_at,updated_at)
            values (${otherThreadId}, ${otherChiefId}, ${'other-topic'},
                    ${JSON.stringify(session)}::jsonb, ${'{}'}::jsonb, ${'{}'},
                    ${ts}, ${ts})`;
  await sql`insert into project (id,team_id,name,provider,repo_kind,
                                  default_branch,next_seq_num,created_at)
            values (${otherProjectId}, ${otherTeamId}, ${'other-p'},
                    'external', 'other', 'main', 1, ${ts})`;
  await sql`insert into todo (id,project_id,seq_num,owner_member_id,agent_id,
                               title,tag_ids,phase,plan_first,separate_plan_build,
                               with_checklist,created_at,updated_at)
            values (${otherTodoId}, ${otherProjectId}, 1, ${otherMemberId},
                    ${otherAgentId}, ${'other-todo'}, ${'{}'},
                    'todo', true, false, false, ${ts}, ${ts})`;

  const f: Fixture = {
    userId, teamId, agentId, chiefId, threadId, projectId, todoId,
    otherTeamId, otherThreadId, otherTodoId, otherAgentId,
  };
  fixtures.push(f);
  return f;
}

async function cleanup(): Promise<void> {
  // 共享库：只删本 fixture 名下相关行（按 team_id 拉网），确保不踩其他测试
  for (const f of fixtures) {
    // chief_wake 是运行时建的（service 自管表），先看有没有再删
    const wakeExists = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'chief_wake'
    `;
    if (wakeExists[0]!.n > 0) {
      await sql`DELETE FROM chief_wake WHERE team_id = ${f.teamId}`;
      await sql`DELETE FROM chief_wake WHERE team_id = ${f.otherTeamId}`;
    }
    await sql`DELETE FROM audit_event WHERE team_id = ${f.teamId}`;
    await sql`DELETE FROM audit_event WHERE team_id = ${f.otherTeamId}`;
  }
  // rebuild the fixture list inside describe blocks; safer to keep array intact
}

describe('Chief memory service', () => {
  before(async () => {
    sql = postgres(DATABASE_URL, { max: 1 });
    db = drizzle(sql, { schema: dbPkg.schema });
  });
  after(async () => {
    await cleanup();
    await sql.end();
  });
  beforeEach(async () => {
    await cleanup();
    fixtures.length = 0;
  });

  // ────────────────── memories / save_memory / delete_memory ─────────
  describe('memories / save_memory / delete_memory', () => {
    test('saveMemory 新建一条；listMemories 读得回来', async () => {
      const f = await seed();
      const created = await svc.saveMemory(db, {
        teamId: f.teamId,
        chiefId: f.chiefId,
        agentId: f.agentId,
        title: 'deploy-from-release',
        content: 'always cut a tag and merge to main, never force-push',
        scope: 'team',
        projectId: null,
      });
      assert.equal(created.title, 'deploy-from-release');
      assert.ok(created.id.length > 0, 'id 被生成');

      const list = await svc.listMemories(db, { teamId: f.teamId, agentId: f.agentId });
      assert.equal(list.length, 1);
      assert.equal(list[0]!.id, created.id);

      // DB 取证：确实落表
      const rows = await sql<
        { id: string; title: string; agent_id: string }[]
      >`SELECT id, title, agent_id FROM agent_memory WHERE id = ${created.id}`;
      assert.equal(rows.length, 1, 'agent_memory 真落了一行');
      assert.equal(rows[0]!.agent_id, f.agentId);
    });

    test('saveMemory 同 key 第二次写入 → upsert 不是报错', async () => {
      const f = await seed();
      const first = await svc.saveMemory(db, {
        teamId: f.teamId, chiefId: f.chiefId, agentId: f.agentId,
        title: 'lesson-1', content: 'old version', scope: 'team',
      });
      const second = await svc.saveMemory(db, {
        teamId: f.teamId, chiefId: f.chiefId, agentId: f.agentId,
        title: 'lesson-1', content: 'updated content', scope: 'team',
      });
      assert.equal(second.id, first.id, 'id 保持稳定 = upsert');
      assert.equal(second.content, 'updated content');

      const rows = await sql<
        { id: string; content: string }[]
      >`SELECT id, content FROM agent_memory WHERE agent_id = ${f.agentId}`;
      assert.equal(rows.length, 1, 'agent_memory 只一行（同 key 覆盖）');
      assert.equal(rows[0]!.content, 'updated content');
    });

    test('saveMemory 凭据形态被拦截（复用 validateMemory）', async () => {
      const f = await seed();
      await assert.rejects(
        svc.saveMemory(db, {
          teamId: f.teamId, chiefId: f.chiefId, agentId: f.agentId,
          title: 'oops', content: 'api_key=supersecretvalue12345',
          scope: 'team',
        }),
        (e: unknown) => e instanceof HttpError
          && e.statusCode === 422
          && (e.message.includes('凭据') || e.message.includes('credential')),
        '必须 422 + 凭据提示',
      );
      const rows = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM agent_memory WHERE agent_id = ${f.agentId}
      `;
      assert.equal(rows[0]!.n, 0, '凭据拦截：agent_memory 一行都没写');
    });

    test('saveMemory 跨团队 → 403 且 agent_memory 没写', async () => {
      const f = await seed();
      await assert.rejects(
        svc.saveMemory(db, {
          // 拿自己 teamId 但 agent 是别的团队 → 跨团队
          teamId: f.teamId, chiefId: f.chiefId,
          agentId: f.otherAgentId,
          title: 'leak', content: 'should not write', scope: 'team',
        }),
        (e: unknown) => e instanceof HttpError && e.statusCode === 403,
        'MUTATION? 跨团队写入必须 403',
      );
      const rows = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM agent_memory
         WHERE agent_id = ${f.otherAgentId} AND title = ${'leak'}
      `;
      assert.equal(rows[0]!.n, 0, 'MUTATION? 跨团队拒绝后 agent_memory 没多行');
    });

    test('deleteMemory 删除后再读 → 0 条；不存在 → 403', async () => {
      const f = await seed();
      const m = await svc.saveMemory(db, {
        teamId: f.teamId, chiefId: f.chiefId, agentId: f.agentId,
        title: 'tmp', content: 'will be deleted', scope: 'team',
      });
      await svc.deleteMemory(db, {
        teamId: f.teamId, chiefId: f.chiefId,
        agentId: f.agentId, memoryId: m.id,
      });
      const after = await svc.listMemories(db, { teamId: f.teamId, agentId: f.agentId });
      assert.equal(after.length, 0, 'delete 后 listMemories 为空');

      const rows = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM agent_memory WHERE id = ${m.id}
      `;
      assert.equal(rows[0]!.n, 0, 'MUTATION? 真删了');

      // 不存在的 id：404/403 都行，但本批统一 403 不暴露存在性
      await assert.rejects(
        svc.deleteMemory(db, {
          teamId: f.teamId, chiefId: f.chiefId,
          agentId: f.agentId, memoryId: 'nope-not-real',
        }),
        (e: unknown) => e instanceof HttpError && e.statusCode === 403,
      );
    });
  });

  // ────────────────── watch_todos / unwatch_todos ─────────────────────
  describe('watch_todos / unwatch_todos', () => {
    test('watchTodo 加入 → listWatchedTodos 包含；watchedTodos 数组落表', async () => {
      const f = await seed();
      await svc.watchTodo(db, {
        teamId: f.teamId, chiefId: f.chiefId,
        threadId: f.threadId, todoId: f.todoId,
      });
      const list = await svc.listWatchedTodos(db, {
        teamId: f.teamId, threadId: f.threadId,
      });
      assert.equal(list.length, 1, 'watch 列表 1 条');
      assert.equal(list[0]!.todoId, f.todoId);

      const rows = await sql<{ watched_todos: string[] }[]>`
        SELECT watched_todos FROM chief_thread WHERE id = ${f.threadId}
      `;
      assert.deepEqual(rows[0]!.watched_todos, [f.todoId]);
    });

    test('watchTodo 同 todoId 重复 → 幂等不报错', async () => {
      const f = await seed();
      await svc.watchTodo(db, {
        teamId: f.teamId, chiefId: f.chiefId,
        threadId: f.threadId, todoId: f.todoId,
      });
      await svc.watchTodo(db, {
        teamId: f.teamId, chiefId: f.chiefId,
        threadId: f.threadId, todoId: f.todoId,
      });
      const list = await svc.listWatchedTodos(db, {
        teamId: f.teamId, threadId: f.threadId,
      });
      assert.equal(list.length, 1, '重复 watch 不重复 push');
    });

    test('watchTodo 跨团队 thread + 我 team todo → 403 数组不变', async () => {
      const f = await seed();
      // threadId 来自 otherTeam；teamId 传自己 team → assertSameTeam 必抛
      await assert.rejects(
        svc.watchTodo(db, {
          teamId: f.teamId, chiefId: f.chiefId,
          threadId: f.otherThreadId, todoId: f.todoId,
        }),
        (e: unknown) => e instanceof HttpError && e.statusCode === 403,
        'MUTATION? 跨团队 thread 必须 403',
      );
      const rows = await sql<{ watched_todos: string[] }[]>`
        SELECT watched_todos FROM chief_thread WHERE id = ${f.otherThreadId}
      `;
      assert.deepEqual(
        rows[0]!.watched_todos, [],
        'MUTATION? 跨团队拒绝后对方 thread.watchedTodos 必须是空',
      );
    });

    test('unwatchTodo 移除后 list 为空；幂等（不存在 → no-op）', async () => {
      const f = await seed();
      await svc.watchTodo(db, {
        teamId: f.teamId, chiefId: f.chiefId,
        threadId: f.threadId, todoId: f.todoId,
      });
      await svc.unwatchTodo(db, {
        teamId: f.teamId, chiefId: f.chiefId,
        threadId: f.threadId, todoId: f.todoId,
      });
      const list = await svc.listWatchedTodos(db, {
        teamId: f.teamId, threadId: f.threadId,
      });
      assert.equal(list.length, 0, 'unwatch 后 0 条');

      // 第二次再 unwatch（不存在）：应当 no-op 不抛
      await svc.unwatchTodo(db, {
        teamId: f.teamId, chiefId: f.chiefId,
        threadId: f.threadId, todoId: f.todoId,
      });
      const rows = await sql<{ watched_todos: string[] }[]>`
        SELECT watched_todos FROM chief_thread WHERE id = ${f.threadId}
      `;
      assert.deepEqual(rows[0]!.watched_todos, []);
    });
  });

  // ────────────────── set_wake / clear_wake / wakes ───────────────────
  describe('set_wake / clear_wake / wakes', () => {
    test('setWake 7 天内 → listWakes 读得到；超 7 天自动钳到 now+7d', async () => {
      const f = await seed();
      const ts = now();
      const ok = await svc.setWake(db, {
        teamId: f.teamId, chiefId: f.chiefId,
        threadId: f.threadId, todoId: f.todoId,
        fireAt: ts + 60 * 60 * 1000, // 1 hour
      });
      assert.ok(ok.fireAt >= ts, 'fireAt 没被钳回过去');
      assert.ok(ok.id.length > 0);

      const list = await svc.listWakes(db, { teamId: f.teamId });
      assert.equal(list.length, 1, 'wakes 列表 1 条');
      assert.equal(list[0]!.threadId, f.threadId);

      // 钳位测试：传远未来 → 钳到 now + 7d
      const tooLate = await svc.setWake(db, {
        teamId: f.teamId, chiefId: f.chiefId,
        threadId: f.threadId, todoId: f.todoId,
        fireAt: ts + 100 * 24 * 60 * 60 * 1000, // 100 天
      });
      const maxAllowed = ts + 7 * 24 * 60 * 60 * 1000 + 5_000; // 5s 误差
      assert.ok(tooLate.fireAt <= maxAllowed, 'MUTATION? 7 天上限必须钳');

      // 取证 — chief_wake 真落表
      const rows = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM chief_wake WHERE team_id = ${f.teamId}
      `;
      assert.equal(rows[0]!.n, 1, 'MUTATION? 同 thread+todo 替换 = 1 行');
    });

    test('setWake 跨团队 → 403 且 chief_wake 没新增（仅我自己 team 上验证）', async () => {
      const f = await seed();
      // 喂一行有效 wake 当 "基线"，然后跨团队再试
      await svc.setWake(db, {
        teamId: f.teamId, chiefId: f.chiefId,
        threadId: f.threadId, todoId: f.todoId,
        fireAt: Date.now() + 10_000,
      });
      const before = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM chief_wake WHERE team_id = ${f.teamId}
      `;
      assert.equal(before[0]!.n, 1, '基线：1 条');

      await assert.rejects(
        svc.setWake(db, {
          teamId: f.teamId, chiefId: f.chiefId,
          // thread 是别人 team 的 → assertSameTeam 必抛
          threadId: f.otherThreadId, todoId: f.otherTodoId,
          fireAt: Date.now() + 10_000,
        }),
        (e: unknown) => e instanceof HttpError && e.statusCode === 403,
        'MUTATION? 跨团队 setWake 必须 403',
      );
      // only on home team: count must NOT have grown
      const after = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM chief_wake WHERE team_id = ${f.teamId}
      `;
      assert.equal(after[0]!.n, 1, 'MUTATION? 跨团队拒绝后自己 team 的行数不变');

      // otherTeamId 上同样必须没新增
      const other = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM chief_wake WHERE team_id = ${f.otherTeamId}
      `;
      assert.equal(other[0]!.n, 0, 'MUTATION? 跨团队拒绝后对方 team 没新增');
    });

    test('clearWake 清除 → listWakes 立即为空；库上 cleared_at 非空', async () => {
      const f = await seed();
      await svc.setWake(db, {
        teamId: f.teamId, chiefId: f.chiefId,
        threadId: f.threadId, todoId: f.todoId,
        fireAt: Date.now() + 60_000,
      });
      await svc.clearWake(db, {
        teamId: f.teamId, chiefId: f.chiefId,
        threadId: f.threadId, todoId: f.todoId,
      });
      const list = await svc.listWakes(db, { teamId: f.teamId });
      assert.equal(list.length, 0, 'clear 后未清除过滤已生效');

      // listWakes 默认过滤 cleared_at IS NULL；要确认行确实存在但已 cleared
      const rows = await sql<{ cleared_at: number | null }[]>`
        SELECT cleared_at FROM chief_wake WHERE thread_id = ${f.threadId}
      `;
      assert.equal(rows.length, 1, '行还在（clear 是软删）');
      assert.ok(rows[0]!.cleared_at !== null, 'cleared_at 被写上了');

      // 没的再 clear → 404
      await assert.rejects(
        svc.clearWake(db, {
          teamId: f.teamId, chiefId: f.chiefId,
          threadId: f.threadId, todoId: f.todoId,
        }),
        (e: unknown) => e instanceof HttpError && e.statusCode === 404,
        '重复 clear 应该报 404（无 active）',
      );
    });

    test('wakes listWakes 跨团队 → 0 条（不暴露别人的 wake）', async () => {
      const f = await seed();
      await svc.setWake(db, {
        teamId: f.teamId, chiefId: f.chiefId,
        threadId: f.threadId, todoId: f.todoId,
        fireAt: Date.now() + 60_000,
      });
      // 把自己的 wake 灌好后，看另一 team
      const list = await svc.listWakes(db, { teamId: f.otherTeamId });
      assert.equal(list.length, 0, 'MUTATION? 列别的 team 必须空');
    });
  });

  // ────────────────── 审计落表 ──────────────────────────────────────
  describe('audit trail', () => {
    test('save / delete / watch / unwatch / set_wake / clear_wake 全部落 audit_event', async () => {
      const f = await seed();
      const m = await svc.saveMemory(db, {
        teamId: f.teamId, chiefId: f.chiefId, agentId: f.agentId,
        title: 'audited', content: 'record me', scope: 'team',
      });
      await svc.deleteMemory(db, {
        teamId: f.teamId, chiefId: f.chiefId,
        agentId: f.agentId, memoryId: m.id,
      });
      await svc.watchTodo(db, {
        teamId: f.teamId, chiefId: f.chiefId,
        threadId: f.threadId, todoId: f.todoId,
      });
      await svc.unwatchTodo(db, {
        teamId: f.teamId, chiefId: f.chiefId,
        threadId: f.threadId, todoId: f.todoId,
      });
      await svc.setWake(db, {
        teamId: f.teamId, chiefId: f.chiefId,
        threadId: f.threadId, todoId: f.todoId,
        fireAt: Date.now() + 60_000,
      });
      await svc.clearWake(db, {
        teamId: f.teamId, chiefId: f.chiefId,
        threadId: f.threadId, todoId: f.todoId,
      });

      const rows = await sql<{ type: string }[]>`
        SELECT type FROM audit_event
         WHERE team_id = ${f.teamId}
           AND actor_type = 'chief'
           AND actor_id = ${f.chiefId}
         ORDER BY created_at ASC
      `;
      const types = rows.map((r) => r.type);
      assert.ok(types.includes('memory_created'), 'memory_created 必落');
      assert.ok(types.includes('memory_deleted'), 'memory_deleted 必落');
      assert.ok(types.includes('watch_added'), 'watch_added 必落');
      assert.ok(types.includes('watch_removed'), 'watch_removed 必落');
      assert.ok(types.includes('wake_set'), 'wake_set 必落');
      assert.ok(types.includes('wake_cleared'), 'wake_cleared 必落');
    });
  });
});
