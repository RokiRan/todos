/**
 * Chief 对话持久化层测试。
 *
 * 覆盖：
 *   - buildTurnMessages 纯函数形状
 *   - runChiefTurnWithPersistence: 正常一轮 / 调了工具 / thread 不存在 404 /
 *     跨 team 403 + 库内「未写入」取证 / seq 在已有消息时正确续号 /
 *     maxIterations 用尽时 stoppedBy='max_iterations'
 *   - 下一轮读回的 history 含 assistant.tool_calls 与 tool 回灌
 *   - MUTATION? 变异验证至少两处
 *
 * 关键约束：
 *   - 真库 postgres://tds@127.0.0.1:5433/tds
 *   - 每条拒绝用例必须查库证明「未写入」，且 **只用本 fixture 名下行**
 *     （where thread_id = ${f.threadId}）—— 不允许全表 count（库是共享的）
 *   - 断言消息统一带 MUTATION? 前缀；mutation 验证后源码不许留裸 MUTATION
 *   - fixture 里 agent.default_skill_ids 是 text[] not jsonb：'{}'::text[]
 *   - 不跑全量 typecheck/test；只跑这一文件
 *
 * 不打真模型 —— callModel 由 `scriptedCaller` 注入，与 chief-loop.test.ts 同源。
 */
import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Db } from '@tds/db';
import * as dbPkg from '@tds/db';
import { newId, now } from '../src/ids.js';
import {
  buildTurnMessages,
  runChiefTurnWithPersistence,
  type ChiefTurnDeps,
  type ModelMessage,
  type ModelToolSpec,
  type ModelCallResult,
  type ChiefToolOutcome,
} from '../src/services/chief-turn.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://tds:tds@127.0.0.1:5433/tds';

interface Fixture {
  label: string;
  userId: string;
  otherUserId: string;
  teamId: string;
  otherTeamId: string;
  memberId: string;
  agentId: string;
  chiefId: string;
  otherChiefId: string;
  threadId: string;
  /** thread.session.id —— 伪 buildId，且必须与下面 build.id 一致 */
  sessionId: string;
  /** 给「跨团队 403」测试用的另一个 thread —— 属于 otherTeam */
  crossTeamThreadId: string;
  crossTeamSessionId: string;
  projectId: string;
  todoId: string;
}

const sql = postgres(DATABASE_URL, { max: 4 });
const db = drizzle(sql, { schema: dbPkg.schema as never }) as Db;
const fixtures: Fixture[] = [];

async function seed(label: string, options?: { withCrossTeam?: boolean }): Promise<Fixture> {
  const ts = now();
  const userId = newId();
  const teamId = newId();
  const memberId = newId();
  const chiefId = `chief-${userId}-${teamId}`;
  const agentId = newId();
  const projectId = newId();
  const todoId = newId();
  const sessionId = newId();
  const threadId = newId();

  await sql`insert into "user" (id,email,display_name,status,locale,created_at,updated_at)
            values (${userId}, ${`chief-turn-${label}-${userId}@test.local`},
                    ${label}, 'active', 'en', ${ts}, ${ts})`;
  await sql`insert into team (id,name,plan,storage_quota,created_at)
            values (${teamId}, ${label}, 'free', 1073741824, ${ts})`;
  await sql`insert into member (id,team_id,actor_id,member_type,role,joined_at,v)
            values (${memberId}, ${teamId}, ${userId}, 'user', 'admin', ${ts}, 0)`;
  await sql`insert into agent (id,team_id,display_name,default_skill_ids,grants,
                                active_task_count,created_at,updated_at)
            values (${agentId}, ${teamId}, ${'agent-' + label}, ${'{}'},
                    ${'{}'}::jsonb, 0, ${ts}, ${ts})`;
  await sql`insert into project (id,team_id,name,provider,repo_kind,
                                  default_branch,next_seq_num,created_at)
            values (${projectId}, ${teamId}, ${label}, 'external', 'other',
                    'main', 1, ${ts})`;
  await sql`insert into todo (id,project_id,seq_num,owner_member_id,agent_id,
                               title,tag_ids,phase,plan_first,separate_plan_build,
                               with_checklist,created_at,updated_at)
            values (${todoId}, ${projectId}, 1, ${memberId}, ${agentId},
                    ${'todo-' + label}, ${'{}'}, 'todo',
                    true, false, false, ${ts}, ${ts})`;
  await sql`insert into chief (id,user_id,team_id,agent_id,charter,created_at,updated_at)
            values (${chiefId}, ${userId}, ${teamId}, ${agentId},
                    ${'charter-' + label}, ${ts}, ${ts})`;
  // **不再建 build 行** —— 换成 chief_message 之后，Chief 对话的归属就是
  // thread_id，不需要那套「伪 buildId」底座（build_message.build_id 有真外键，
  // 伪 buildId 写不进去）。
  await sql`insert into chief_thread (id,chief_id,title,session,tool_def_hashes,
                                       watched_todos,created_at,updated_at)
            values (${threadId}, ${chiefId}, ${'topic-' + label},
                    ${JSON.stringify({ runtime: 'claude-code', id: sessionId, openedAt: ts })}::jsonb,
                    ${'{}'}::jsonb, ${'{}'}, ${ts}, ${ts})`;

  let otherUserId = '';
  let otherTeamId = '';
  let otherChiefId = '';
  let crossTeamThreadId = '';
  let crossTeamSessionId = '';
  if (options?.withCrossTeam) {
    otherUserId = newId();
    otherTeamId = newId();
    otherChiefId = `chief-${otherUserId}-${otherTeamId}`;
    crossTeamSessionId = newId();
    crossTeamThreadId = newId();
    const otherMemberId = newId();
    const otherProjectId = newId();
    const otherTodoId = newId();
    const otherAgentId = newId();
    await sql`insert into "user" (id,email,display_name,status,locale,created_at,updated_at)
              values (${otherUserId}, ${`chief-turn-x-${label}-${otherUserId}@test.local`},
                      ${'other-' + label}, 'active', 'en', ${ts}, ${ts})`;
    await sql`insert into team (id,name,plan,storage_quota,created_at)
              values (${otherTeamId}, ${'other-' + label}, 'free', 1073741824, ${ts})`;
    await sql`insert into member (id,team_id,actor_id,member_type,role,joined_at,v)
              values (${otherMemberId}, ${otherTeamId}, ${otherUserId}, 'user', 'admin', ${ts}, 0)`;
    await sql`insert into agent (id,team_id,display_name,default_skill_ids,grants,
                                  active_task_count,created_at,updated_at)
              values (${otherAgentId}, ${otherTeamId}, ${'other-agent-' + label}, ${'{}'},
                      ${'{}'}::jsonb, 0, ${ts}, ${ts})`;
    await sql`insert into project (id,team_id,name,provider,repo_kind,
                                    default_branch,next_seq_num,created_at)
              values (${otherProjectId}, ${otherTeamId}, ${'p-' + label}, 'external', 'other',
                      'main', 1, ${ts})`;
    await sql`insert into todo (id,project_id,seq_num,owner_member_id,agent_id,
                                 title,tag_ids,phase,plan_first,separate_plan_build,
                                 with_checklist,created_at,updated_at)
              values (${otherTodoId}, ${otherProjectId}, 1, ${otherMemberId}, ${otherAgentId},
                      ${'todo-other-' + label}, ${'{}'}, 'todo',
                      true, false, false, ${ts}, ${ts})`;
    await sql`insert into chief (id,user_id,team_id,agent_id,created_at,updated_at)
              values (${otherChiefId}, ${otherUserId}, ${otherTeamId},
                      ${otherAgentId}, ${ts}, ${ts})`;
    await sql`insert into build (id,todo_id,n,branch,prev_phase,trigger_source,
                                  with_plan,with_checklist,agent_id,session,usage_by_model,
                                  created_at,v)
              values (${crossTeamSessionId}, ${otherTodoId}, 1,
                      ${'tds/conv-' + crossTeamSessionId}, 'todo', 'chief', true, false,
                      ${otherAgentId},
                      ${JSON.stringify({ runtime: 'claude-code', id: crossTeamSessionId, openedAt: ts })}::jsonb,
                      ${'[]'}::jsonb, ${ts}, 0)`;
    await sql`insert into chief_thread (id,chief_id,title,session,tool_def_hashes,
                                         watched_todos,created_at,updated_at)
              values (${crossTeamThreadId}, ${otherChiefId}, ${'cross-topic-' + label},
                      ${JSON.stringify({ runtime: 'claude-code', id: crossTeamSessionId, openedAt: ts })}::jsonb,
                      ${'{}'}::jsonb, ${'{}'}, ${ts}, ${ts})`;
  }

  return {
    label,
    userId,
    otherUserId,
    teamId,
    otherTeamId,
    memberId,
    agentId,
    chiefId,
    otherChiefId,
    threadId,
    sessionId,
    crossTeamThreadId,
    crossTeamSessionId,
    projectId,
    todoId,
  };
}

async function cleanup(f: Fixture): Promise<void> {
  await sql`delete from "audit_event" where team_id = ${f.teamId}`;
  await sql`delete from "sse_event" where team_id = ${f.teamId}`;
  // 删本 fixture 名下的 chief_message（用 build_id 范围限定）
  await sql`delete from "chief_message" where thread_id = ${f.threadId}`;
  await sql`delete from "chief_thread" where id = ${f.threadId}`;
  await sql`delete from "chief" where id = ${f.chiefId}`;
  await sql`delete from "document" where thread_id = ${f.threadId}`;
  await sql`delete from "step" where thread_id = ${f.threadId}`;
  await sql`delete from "build" where id = ${f.threadId}`;
  await sql`delete from "todo" where id = ${f.todoId}`;
  await sql`delete from "project" where id = ${f.projectId}`;
  await sql`delete from "agent" where id = ${f.agentId}`;
  await sql`delete from "member" where id = ${f.memberId}`;
  await sql`delete from "team" where id = ${f.teamId}`;
  await sql`delete from "user" where id = ${f.userId}`;

  if (f.otherTeamId) {
    await sql`delete from "chief_message" where thread_id = ${f.crossTeamThreadId}`;
    await sql`delete from "chief_thread" where id = ${f.crossTeamThreadId}`;
    await sql`delete from "chief" where id = ${f.otherChiefId}`;
    await sql`delete from "build" where id = ${f.crossTeamSessionId}`;
    await sql`delete from "team" where id = ${f.otherTeamId}`;
    await sql`delete from "user" where id = ${f.otherUserId}`;
  }
}

// ── 假模型 callModel —— 与 chief-loop.test.ts 同源。 ───────────────────

interface ScriptStep {
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  text?: string;
  finishReason?: string;
}

function scriptedCaller(
  script: ReadonlyArray<ScriptStep>,
  recorder?: { messages: ModelMessage[] },
): (messages: ModelMessage[], _tools?: ModelToolSpec[]) => Promise<ModelCallResult> {
  let i = 0;
  return async (messages, _tools) => {
    if (recorder) recorder.messages.push(...messages);
    const step = script[i++];
    if (!step) {
      throw new Error(
        `scriptedCaller: 剧本耗尽（已用 ${i - 1}/${script.length} 步）—— 写少了`,
      );
    }
    const toolCalls = step.toolCalls ?? [];
    const fr = step.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop');
    return {
      toolCalls,
      text: step.text ?? '',
      usage: { inputTokens: 10, outputTokens: 5 },
      finishReason: fr,
    };
  };
}

function scriptedExecutor(
  handlers: Record<string, (args: Record<string, unknown>) => ChiefToolOutcome | Promise<ChiefToolOutcome>>,
): (name: string, args: Record<string, unknown>) => Promise<ChiefToolOutcome> {
  return async (name, args) => {
    const h = handlers[name];
    if (!h) return { tool: name, ok: false, reason: `unknown tool "${name}"` };
    return await h(args);
  };
}

before(async () => { /* 连接在文件顶层初始化 */ });
after(async () => {
  for (const f of fixtures) {
    try { await cleanup(f); } catch { /* ignore */ }
  }
  await sql.end();
});

describe('buildTurnMessages 纯函数', () => {
  test('顺序：system → history → user', () => {
    const r = buildTurnMessages({
      systemPrompt: 'SYS',
      history: [
        { role: 'user', content: '上轮问' },
        { role: 'assistant', content: '上轮答' },
      ],
      userMessage: '这轮问',
    });
    assert.equal(r.length, 4);
    assert.equal(r[0]?.role, 'system');
    assert.equal(r[0]?.content, 'SYS');
    assert.equal(r[1]?.role, 'user');
    assert.equal(r[2]?.role, 'assistant');
    assert.equal(r[3]?.role, 'user');
    assert.equal(r[3]?.content, '这轮问');
  });

  test('幂等：同一入参两次调用结果一致', () => {
    const input = {
      systemPrompt: 'S',
      history: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b', toolCalls: [{ id: 'x', name: 'noop', args: {} }] },
      ],
      userMessage: 'c',
    };
    assert.deepEqual(buildTurnMessages(input), buildTurnMessages(input));
  });

  test('history 第一条若是 system，跳过重复注入', () => {
    const r = buildTurnMessages({
      systemPrompt: 'OUTER',
      history: [{ role: 'system', content: 'INNER' }],
      userMessage: '问',
    });
    const systems = r.filter((m) => m.role === 'system');
    assert.equal(systems.length, 1, 'MUTATION? 不许同时拥有 INNER 和 OUTER');
    assert.equal(systems[0]?.content, 'INNER');
  });
});

describe('runChiefTurnWithPersistence — 鉴权', () => {
  test('thread 不存在 → 404，且本 fixture 名下 chief_message 仍为零行', async () => {
    const f = await seed('auth-404');
    fixtures.push(f);
    const deps: ChiefTurnDeps = {
      db,
      callModel: scriptedCaller([{ toolCalls: [], text: 'x' }]),
      executeTool: scriptedExecutor({}),
    };
    const before = await sql<{ n: number }[]>`
      select count(*)::int as n from "chief_message" where thread_id = ${f.threadId}
    `;
    assert.equal(before[0]?.n, 0, '前置：本 fixture 名下零行');
    await assert.rejects(
      runChiefTurnWithPersistence(deps, {
        threadId: 'definitely-not-a-thread',
        teamId: f.teamId,
        actorId: f.userId,
        userMessage: 'hi',
      }),
      (err: Error) => {
        assert.match(err.message, /thread not found/);
        return true;
      },
    );
    const after = await sql<{ n: number }[]>`
      select count(*)::int as n from "chief_message" where thread_id = ${f.threadId}
    `;
    assert.equal(after[0]?.n, 0, 'MUTATION? 404 拒绝后 chief_message 仍为零行');
  });

  test('跨 team → 403，且本 fixture 名下 chief_message 仍为零行', async () => {
    const f = await seed('auth-403', { withCrossTeam: true });
    fixtures.push(f);
    const deps: ChiefTurnDeps = {
      db,
      callModel: scriptedCaller([{ toolCalls: [], text: 'x' }]),
      executeTool: scriptedExecutor({}),
    };
    const before = await sql<{ n: number }[]>`
      select count(*)::int as n
      from "chief_message" where thread_id = ${f.crossTeamThreadId}
    `;
    assert.equal(before[0]?.n, 0, '前置：跨团队 thread 名下零行');
    await assert.rejects(
      runChiefTurnWithPersistence(deps, {
        threadId: f.crossTeamThreadId,
        teamId: f.teamId, // 本 user 在 home team 里，但 thread 不属于他
        actorId: f.userId,
        userMessage: 'hi',
      }),
      (err: Error) => {
        assert.match(err.message, /not accessible/);
        return true;
      },
    );
    const after = await sql<{ n: number }[]>`
      select count(*)::int as n
      from "chief_message" where thread_id = ${f.crossTeamThreadId}
    `;
    assert.equal(after[0]?.n, 0, 'MUTATION? 403 拒绝后跨团队 chief_message 仍为零行');
  });
});

describe('runChiefTurnWithPersistence — 一轮对话', () => {
  test('纯文本收口：user + assistant 都落库，lastTurnAt 更新，lastSeq=2', async () => {
    const f = await seed('turn-text');
    fixtures.push(f);
    const deps: ChiefTurnDeps = {
      db,
      callModel: scriptedCaller([{ toolCalls: [], text: '好的，已经收到', finishReason: 'stop' }]),
      executeTool: scriptedExecutor({}),
    };
    const res = await runChiefTurnWithPersistence(deps, {
      threadId: f.threadId,
      teamId: f.teamId,
      actorId: f.userId,
      userMessage: '帮我看下设计',
    });
    assert.equal(res.stoppedBy, 'text');
    assert.equal(res.text, '好的，已经收到');
    assert.deepEqual(res.toolCalls, []);
    assert.equal(res.lastSeq, 2, 'user=1 + assistant=2');

    const rows = await sql<{ role: string; seq: number; content: string; trigger_by: string | null }[]>`
      select role, seq, content, trigger_by
      from "chief_message"
      where thread_id = ${f.threadId}
      order by seq asc
    `;
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.role, 'user');
    assert.equal(rows[0]?.content, '帮我看下设计');
    assert.equal(rows[0]?.trigger_by, 'user');
    assert.equal(rows[1]?.role, 'assistant');
    assert.equal(rows[1]?.content, '好的，已经收到');
    assert.equal(rows[1]?.trigger_by, 'assistant');

    const threadRows = await sql<{ last_turn_at: number | null; v: number }[]>`
      select last_turn_at, v from "chief_thread" where id = ${f.threadId}
    `;
    assert.ok((threadRows[0]?.last_turn_at ?? 0) > 0, 'lastTurnAt 必须已写');
    assert.ok((threadRows[0]?.v ?? 0) >= 1, 'v 必须递增');
  });

  test('调了一次工具：tool 行也落库，seq 连续', async () => {
    const f = await seed('turn-tool');
    fixtures.push(f);
    const deps: ChiefTurnDeps = {
      db,
      callModel: scriptedCaller([
        {
          toolCalls: [{ id: 'c1', name: 'list_todos', args: {} }],
          finishReason: 'tool_calls',
        },
        { toolCalls: [], text: '我查了一下', finishReason: 'stop' },
      ]),
      executeTool: scriptedExecutor({
        list_todos: () => ({ tool: 'list_todos', ok: true, result: [{ id: 't1' }] }),
      }),
    };
    const res = await runChiefTurnWithPersistence(deps, {
      threadId: f.threadId,
      teamId: f.teamId,
      actorId: f.userId,
      userMessage: '查 todo',
    });
    assert.equal(res.stoppedBy, 'text');
    assert.deepEqual(res.toolCalls, [{ name: 'list_todos', ok: true }]);
    // user + assistant (tool_calls 包) + tool 回灌 + assistant 文本 = 4
    assert.equal(res.lastSeq, 4, 'MUTATION? tool 结果必须落库 (seq 跳号说明漏写)');

    const rows = await sql<{ role: string; seq: number }[]>`
      select role, seq from "chief_message"
      where thread_id = ${f.threadId}
      order by seq asc
    `;
    assert.deepEqual(
      rows.map((r) => r.role),
      ['user', 'assistant', 'tool', 'assistant'],
      'MUTATION? tool 回灌那一行必须在库内，且 seq 连续',
    );
    assert.deepEqual(rows.map((r) => Number(r.seq)), [1, 2, 3, 4]);
  });

  test('seq 在已有消息时正确续号（先插 seq=5/6 → 新消息从 7 起）', async () => {
    const f = await seed('turn-seq');
    fixtures.push(f);
    const ts = now();
    // 手工插两条已有消息（如同 thread 之前已经跑过其他轮）
    await sql`insert into "chief_message"
              (id,thread_id,role,content,seq,created_at,is_error,trigger_by)
              values
              (${newId()}, ${f.threadId}, 'user', ${'历史问'}, 5, ${ts}, false, 'user'),
              (${newId()}, ${f.threadId}, 'assistant', ${'历史答'}, 6, ${ts}, false, 'assistant')`;
    const deps: ChiefTurnDeps = {
      db,
      callModel: scriptedCaller([{ toolCalls: [], text: '新答', finishReason: 'stop' }]),
      executeTool: scriptedExecutor({}),
    };
    const res = await runChiefTurnWithPersistence(deps, {
      threadId: f.threadId,
      teamId: f.teamId,
      actorId: f.userId,
      userMessage: '新问',
    });
    assert.equal(res.lastSeq, 8, 'MUTATION? 新消息必须从 max+1=7 起续号，不能从 1 重来');

    const rows = await sql<{ seq: number; role: string }[]>`
      select seq, role from "chief_message"
      where thread_id = ${f.threadId}
      order by seq asc
    `;
    const seqs = rows.map((r) => Number(r.seq));
    assert.deepEqual(seqs, [5, 6, 7, 8], 'MUTATION? 续号：5, 6 旧 + 7 新 user + 8 新 assistant');
    assert.equal(rows[2]?.role, 'user');
    assert.equal(rows[3]?.role, 'assistant');
  });

  test('maxIterations 用尽 → stoppedBy=max_iterations，且工具调用的全部入档', async () => {
    const f = await seed('turn-maxiter');
    fixtures.push(f);
    const deps: ChiefTurnDeps = {
      db,
      callModel: scriptedCaller(
        Array.from({ length: 2 }, (_, i) => ({
          toolCalls: [{ id: `c${i}`, name: 'noop', args: {} }],
          finishReason: 'tool_calls',
        })),
      ),
      executeTool: scriptedExecutor({
        noop: () => ({ tool: 'noop', ok: true, result: 'ok' }),
      }),
    };
    const res = await runChiefTurnWithPersistence(deps, {
      threadId: f.threadId,
      teamId: f.teamId,
      actorId: f.userId,
      userMessage: 'loop',
      maxIterations: 2,
    });
    assert.equal(res.stoppedBy, 'max_iterations');
    assert.equal(res.text, '');
    assert.equal(res.toolCalls.length, 2);
    // 库内：user + assistant(t0) + tool + assistant(t1) + tool = 5 行
    const rows = await sql<{ role: string; seq: number }[]>`
      select role, seq from "chief_message"
      where thread_id = ${f.threadId}
      order by seq asc
    `;
    const roles = rows.map((r) => r.role);
    assert.deepEqual(
      roles,
      ['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant'],
      'maxIterations 用尽时仍要把每一轮的工具调用都落库（包括收口的 assistant text 行）',
    );
    assert.equal(res.lastSeq, 6);
  });
});

describe('runChiefTurnWithPersistence — 历史读回', () => {
  test('下一轮读回的 history 含上一轮的 assistant.tool_calls 与 tool 回灌', async () => {
    const f = await seed('turn-history');
    fixtures.push(f);
    await runChiefTurnWithPersistence(
      {
        db,
        callModel: scriptedCaller([
          { toolCalls: [{ id: 'c1', name: 'list_todos', args: {} }], finishReason: 'tool_calls' },
          { toolCalls: [], text: '好', finishReason: 'stop' },
        ]),
        executeTool: scriptedExecutor({
          list_todos: () => ({ tool: 'list_todos', ok: true, result: { total: 3 } }),
        }),
      },
      { threadId: f.threadId, teamId: f.teamId, actorId: f.userId, userMessage: '第一问' },
    );

    const seen: { messages: ModelMessage[] } = { messages: [] };
    const r2 = await runChiefTurnWithPersistence(
      {
        db,
        callModel: scriptedCaller([{ toolCalls: [], text: '再答', finishReason: 'stop' }], seen),
        executeTool: scriptedExecutor({}),
      },
      { threadId: f.threadId, teamId: f.teamId, actorId: f.userId, userMessage: '第二问' },
    );
    assert.equal(r2.stoppedBy, 'text');
    // 第二轮 callModel 看到的 messages 顺序：
    //   system（runChiefTurn 加的） + [上轮 user / assistant(t_calls) / tool / assistant text] + 本轮 user
    const roles = seen.messages.map((m) => m.role);
    assert.deepEqual(
      roles,
      ['system', 'user', 'assistant', 'tool', 'assistant', 'user'],
      '历史读回：system + 上一轮 4 条 + 本轮 user',
    );
    const assistantToolMsg = seen.messages.find(
      (m) => m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0,
    );
    assert.ok(assistantToolMsg, 'assistant 的 tool_calls 必须从库里重建出来');
    assert.equal(assistantToolMsg?.toolCalls?.[0]?.name, 'list_todos');
    const toolMsg = seen.messages.find((m) => m.role === 'tool');
    assert.ok(toolMsg?.toolCallId, 'tool 消息必须带 toolCallId');
  });
});

describe('runChiefTurnWithPersistence — MUTATION? 变异验证', () => {
  test('MUTATION? seq 不可以从 0 起写（必须读 max+1）', async () => {
    const f = await seed('mut-seq');
    fixtures.push(f);
    const ts = now();
    await sql`insert into "chief_message"
              (id,thread_id,role,content,seq,created_at,is_error,trigger_by)
              values
              (${newId()}, ${f.threadId}, 'user', ${'脏问'}, 100, ${ts}, false, 'user'),
              (${newId()}, ${f.threadId}, 'assistant', ${'脏答'}, 101, ${ts}, false, 'assistant')`;

    await runChiefTurnWithPersistence(
      {
        db,
        callModel: scriptedCaller([{ toolCalls: [], text: '新', finishReason: 'stop' }]),
        executeTool: scriptedExecutor({}),
      },
      { threadId: f.threadId, teamId: f.teamId, actorId: f.userId, userMessage: '本轮问' },
    );
    const rows = await sql<{ seq: number; role: string }[]>`
      select seq, role from "chief_message"
      where thread_id = ${f.threadId}
      order by seq asc
    `;
    const seqs = rows.map((r) => Number(r.seq));
    assert.ok(!seqs.includes(1), 'MUTATION? 不许从 seq=1 起写');
    assert.ok(!seqs.includes(2), 'MUTATION? 不许出现 seq=2');
    assert.deepEqual(seqs, [100, 101, 102, 103], 'MUTATION? 必须读 max(101) + 1 = 102 起续号');
  });

  test('MUTATION? 工具结果必须落库（不允许漏写）', async () => {
    const f = await seed('mut-tool');
    fixtures.push(f);
    const deps: ChiefTurnDeps = {
      db,
      callModel: scriptedCaller([
        { toolCalls: [{ id: 't1', name: 'fail', args: {} }], finishReason: 'tool_calls' },
        { toolCalls: [], text: '放弃了', finishReason: 'stop' },
      ]),
      executeTool: scriptedExecutor({
        fail: () => ({ tool: 'fail', ok: false, reason: '闸门挡了' }),
      }),
    };
    const res = await runChiefTurnWithPersistence(deps, {
      threadId: f.threadId,
      teamId: f.teamId,
      actorId: f.userId,
      userMessage: 'try',
    });
    // 4 行：user / assistant(t_calls) / tool / assistant text
    assert.equal(res.lastSeq, 4, 'MUTATION? 漏掉 tool 行时 lastSeq 会掉到 3');
    const rows = await sql<{ role: string; seq: number }[]>`
      select role, seq from "chief_message"
      where thread_id = ${f.threadId}
      order by seq asc
    `;
    const toolRows = rows.filter((r) => r.role === 'tool');
    assert.equal(toolRows.length, 1, 'MUTATION? 必须落一条 tool 行');
    const seqs = rows.map((r) => Number(r.seq));
    assert.deepEqual(seqs, [1, 2, 3, 4], 'MUTATION? seq 必须连续，漏 tool 会断号');
  });

  test('MUTATION? lastTurnAt 不写时本测试应失败——验证字段不漏', async () => {
    const f = await seed('mut-thread');
    fixtures.push(f);
    const deps: ChiefTurnDeps = {
      db,
      callModel: scriptedCaller([{ toolCalls: [], text: 'ok', finishReason: 'stop' }]),
      executeTool: scriptedExecutor({}),
    };
    await runChiefTurnWithPersistence(deps, {
      threadId: f.threadId,
      teamId: f.teamId,
      actorId: f.userId,
      userMessage: 'hi',
    });
    const r = await sql<{ last_turn_at: number | null; v: number }[]>`
      select last_turn_at, v from "chief_thread" where id = ${f.threadId}
    `;
    assert.ok(r[0]?.last_turn_at !== null, 'MUTATION? lastTurnAt 必须被更新');
    assert.ok((r[0]?.v ?? 0) >= 1, 'MUTATION? v 必须递增至少 1');
  });
});
