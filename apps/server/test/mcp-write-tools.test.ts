import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import * as dbPkg from '@tds/db';
import { newId, now } from '../src/ids.js';
import { generateApiKey } from '../src/crypto.js';
import { registerMcpRoutes } from '../src/routes/mcp.js';
import { deleteTodo } from '../src/services/todos.js';

/**
 * MCP 工具写路径的验证（真库 + `app.inject`）。
 *
 * 覆盖：
 *   1. teamId 越权必须**显式报错**，不许静默回退成「全部团队」
 *      （TASK-1 修掉的真 bug：旧代码
 *      `wantedTeamId && teamIds.includes(...) ? ... : teamIds` 会让调用方以为自己
 *      按团队筛过，实际拿到跨团队全量，且无任何信号）
 *   2. 未授权工具仍是 -32002（防止后续任务加 case 时意外放宽鉴权）
 *   3. 已登记为 pending 的工具给出**可追踪**措辞，与表外未实现区分开
 *   4. tools/list 不因 pending 而缩水
 *   5. create_todo / update_todo：落库、配额边界两侧、`phase` 显式拒绝
 *   6. 生命周期三工具的**逐个尽力**批量语义、闸门拒绝时库里 phase 未变、
 *      以及 phase 变化必须**双 scope** 发 SSE（看板订阅 team:、详情页订阅 todo:）
 *   7. 调度与对话薄壳（`schedules` `schedule_todo` `unschedule_todo` `conversation`）：
 *      它们与 REST 共用 `src/services/schedules.ts` / `src/services/conversations.ts`，
 *      所以这里钉的是「两个入口的行为真的同源」—— weekly 拆合、10 条上限、
 *      跨团队 403、member 角色的 admin 闸门，全部在 MCP 入口上再验一遍
 *
 * 每个「拒绝」用例都同时查库确认未写入 / 未变更 —— 只断言返回值不算证明。
 *
 * 出处：recon/docs/mcp.md、MCP-WRITES-PLAN.md §3、clone/CONTRACT.md
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://tds:tds_local_dev@127.0.0.1:5433/tds';

interface Fixture {
  label: string;
  userId: string;
  teamId: string;
  projectId: string;
  memberId: string;
  key: string;
}

async function seedFixture(sql: postgres.Sql, opts: {
  label: string;
  scopes: string[];
}): Promise<Fixture> {
  const ts = now();
  const userId = newId();
  const teamId = newId();
  const memberId = newId();
  const projectId = newId();

  await sql`
    insert into "user" (id, email, display_name, status, locale, created_at, updated_at)
    values (${userId}, ${`${opts.label}-${userId}@test.local`}, ${opts.label}, 'active', 'en', ${ts}, ${ts})
  `;
  await sql`
    insert into "team" (id, name, plan, storage_quota, created_at)
    values (${teamId}, ${opts.label}, 'free', 1073741824, ${ts})
  `;
  await sql`
    insert into "member" (id, team_id, actor_id, member_type, role, joined_at, v)
    values (${memberId}, ${teamId}, ${userId}, 'user', 'admin', ${ts}, 0)
  `;
  await sql`
    insert into "project" (id, team_id, name, provider, repo_kind, default_branch, next_seq_num, created_at)
    values (${projectId}, ${teamId}, ${opts.label}, 'external', 'other', 'main', 1, ${ts})
  `;

  const key = generateApiKey();
  await sql`
    insert into "api_key" (id, user_id, name, key_prefix, key_hash, scopes, created_at)
    values (${newId()}, ${userId}, ${'mcpw-' + opts.label}, ${key.prefix}, ${key.hash}, ${opts.scopes}, ${ts})
  `;

  return { label: opts.label, userId, teamId, projectId, memberId, key: key.key };
}

/** 在指定 fixture 的项目下建一条 todo。`phase` 默认 'todo'；生命周期测试必须按 phase
 *  播种（review / implement / closed 等），否则测不出「闸门接受 vs 拒绝」的差别。 */
async function seedTodo(
  sql: postgres.Sql,
  f: Fixture,
  phase = 'todo',
): Promise<string> {
  const id = newId();
  const ts = now();
  const seqRow = await sql<{ next_seq_num: number }[]>`
    select next_seq_num from "project" where id = ${f.projectId}
  `;
  const seq = seqRow[0]?.next_seq_num ?? 1;
  await sql`update "project" set next_seq_num = next_seq_num + 1 where id = ${f.projectId}`;
  await sql`
    insert into "todo"
      (id, project_id, seq_num, owner_member_id, title, tag_ids, phase,
       plan_first, separate_plan_build, with_checklist, created_at, updated_at)
    values
      (${id}, ${f.projectId}, ${seq}, ${f.memberId}, ${'todo of ' + f.label}, '{}', ${phase},
       true, false, false, ${ts}, ${ts})
  `;
  return id;
}

async function deleteFixture(sql: postgres.Sql, f: Fixture): Promise<void> {
  // `sse_event` / `audit_event` **完全没有 FK**（`todo` 删了它们也不会级联）——
  // 不清就是往共享库里永久堆垃圾，下一轮测试的计数断言会被上一轮污染。
  await sql`delete from "sse_event" where team_id = ${f.teamId}`;
  await sql`delete from "audit_event" where team_id = ${f.teamId}`;
  // todo 按团队清（不是只清 fixture 自带的那个 project）—— 测试里会在同团队
  // 插第二个项目，只清第一个项目会漏掉第二个项目下的 todo。
  await sql`delete from "todo" where project_id in (select id from "project" where team_id = ${f.teamId})`;
  await sql`delete from "project" where team_id = ${f.teamId}`;
  await sql`delete from "api_key" where user_id = ${f.userId}`;
  await sql`delete from "member" where team_id = ${f.teamId}`;
  await sql`delete from "team" where id = ${f.teamId}`;
  await sql`delete from "user" where id = ${f.userId}`;
}

interface RpcReply {
  statusCode: number;
  body: {
    result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
    error?: { code: number; message: string };
  };
}

async function rpc(
  app: FastifyInstance,
  key: string,
  body: Record<string, unknown>,
): Promise<RpcReply> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/mcp',
    headers: { authorization: `Bearer ${key}` },
    payload: body,
  });
  let parsed: RpcReply['body'] = {};
  try { parsed = JSON.parse(res.body) as RpcReply['body']; } catch { /* keep empty */ }
  return { statusCode: res.statusCode, body: parsed };
}

/** 取 tools/call 回给模型的文本 */
function callText(body: RpcReply['body']): string {
  return body.result?.content?.[0]?.text ?? '';
}

/** 项目内 todo 数 —— 用来验证「拒绝时确实没写入」，不能只断言返回值 */
async function countTodos(sql: postgres.Sql, projectId: string): Promise<number> {
  const rows = await sql<{ c: number }[]>`
    select count(*)::int as c from "todo" where project_id = ${projectId}
  `;
  return rows[0]?.c ?? 0;
}

interface TodoRow {
  title: string;
  phase: string;
  owner_member_id: string;
  spec: string | null;
}

async function readTodo(sql: postgres.Sql, todoId: string): Promise<TodoRow | undefined> {
  const rows = await sql<TodoRow[]>`
    select title, phase, owner_member_id, spec from "todo" where id = ${todoId} limit 1
  `;
  return rows[0];
}

/** 某类 SSE 事件实际落库的订阅 scope 集合。`phase_changed` 之外还有
 *  `todo_updated` / `todo_deleted` / `todo_created` / `dispatched` —— 看板订阅
 *  `team:`、详情页订阅 `todo:`，少发一帧从返回值上完全看不出来。 */
async function eventScopes(
  sql: postgres.Sql,
  type: string,
  todoId: string,
): Promise<string[]> {
  const rows = await sql<{ scope: string }[]>`
    select distinct scope from "sse_event"
    where type = ${type} and payload->>'todoId' = ${todoId}
  `;
  return rows.map((r) => r.scope).sort();
}

/** 三个生命周期工具返回同一个形状，回包解析写一处。 */
interface BatchReply {
  results: Array<{ todoId: string; ok: boolean; phase?: string; reason?: string }>;
  succeeded: number;
  failed: number;
}

function parseBatch(body: RpcReply['body']): BatchReply {
  return JSON.parse(callText(body)) as BatchReply;
}

/** `build.agent_id` 是 NOT NULL FK → agent，所以种 build 之前必须先有 agent。 */
async function seedAgent(sql: postgres.Sql, f: Fixture): Promise<string> {
  const id = newId();
  const ts = now();
  await sql`
    insert into "agent" (id, team_id, display_name, grants, default_skill_ids,
                         active_task_count, created_at, updated_at)
    values (${id}, ${f.teamId}, ${'agent of ' + f.label}, '{}', '{}', 0, ${ts}, ${ts})
  `;
  return id;
}

/** 给 todo 挂一条 build（含 document + build_message），用来验证级联真的带走它们。 */
async function seedBuild(
  sql: postgres.Sql,
  f: Fixture,
  todoId: string,
  agentId: string,
  pinnedMachineId: string | null = null,
): Promise<string> {
  const id = newId();
  const ts = now();
  // jsonb 参数走仓库既有写法：`JSON.stringify(...)` + `::jsonb`
  // （见 test/chief-routes.test.ts:329-335）。直接塞 JS 对象会**同时**撞上
  // postgres-js 的参数类型联合（TS2769）和 Bind 阶段的字符串写入（TypeError）。
  const session = JSON.stringify({ runtime: 'pi', id: 'sess-' + id, openedAt: ts });
  await sql`
    insert into "build"
      (id, todo_id, n, branch, agent_id, session, pinned_machine_id, created_at)
    values
      (${id}, ${todoId}, ${1}, ${'tds/conv-' + id}, ${agentId},
       ${session}::jsonb, ${pinnedMachineId}, ${ts})
  `;
  await sql`
    insert into "document" (id, build_id, kind, version, payload, created_at, updated_at)
    values (${id + '-doc'}, ${id}, 'plan', 1, '{}'::jsonb, ${ts}, ${ts})
  `;
  await sql`
    insert into "build_message" (id, build_id, role, content, seq, is_error, created_at)
    values (${id + '-msg'}, ${id}, 'user', 'hello', ${1}, false, ${ts})
  `;
  return id;
}


/** tools/call 回包的 JSON 解析 —— 批量之外的工具形状各异，用泛型。 */
function callJson<T>(body: RpcReply['body']): T {
  return JSON.parse(callText(body)) as T;
}

interface ProjectRow {
  name: string;
  description: string | null;
  default_branch: string;
  next_seq_num: number;
}

async function readProject(
  sql: postgres.Sql,
  projectId: string,
): Promise<ProjectRow | undefined> {
  const rows = await sql<ProjectRow[]>`
    select name, description, default_branch, next_seq_num from "project"
    where id = ${projectId} limit 1
  `;
  return rows[0];
}

/** 一次 generate_series 灌 N 条 open todo —— 逐条 insert 跑 400 次太慢 */
async function seedBulkOpenTodos(sql: postgres.Sql, f: Fixture, n: number): Promise<void> {
  const ts = now();
  await sql`
    insert into "todo"
      (id, project_id, seq_num, owner_member_id, title, tag_ids, phase,
       plan_first, separate_plan_build, with_checklist, created_at, updated_at)
    select md5(${f.projectId} || gs::text), ${f.projectId}, gs, ${f.memberId},
      'bulk open todo', '{}', 'todo', true, false, false, ${ts}, ${ts}
    from generate_series(1, ${n}) gs
  `;
  // 灌完必须把计数器推到 `n + 1`：生产里每条 todo 都是走计数器建的（REST / Chief /
  // MCP 三条路径共用 `project.next_seq_num`）。计数器落后于 max 时 `create_todo` 会撞
  // `(project_id, seq_num)` 唯一约束 —— 这个 fixture 之前模拟的是一个计数器失真的库。
  await sql`
    update "project" set next_seq_num = greatest(next_seq_num, ${n} + 1)
    where id = ${f.projectId}
  `;
}

/** 种一条 skill。`deletedAt` 非空 = 已删，用来验证列表必须过滤它。 */
async function seedSkill(
  sql: postgres.Sql,
  f: Fixture,
  name: string,
  deletedAt: number | null = null,
): Promise<string> {
  const id = newId();
  const ts = now();
  await sql`
    insert into "skill"
      (id, team_id, name, source, source_url, storage_path, size_bytes, file_count,
       created_by, created_at, deleted_at)
    values (${id}, ${f.teamId}, ${name}, 'upload', 'https://example.test/skill',
      ${'/var/skills/' + id}, 1024, 3, ${f.userId}, ${ts}, ${deletedAt})
  `;
  return id;
}

/** 给 build 补一种 kind 的文档 —— 用来验证读单条时按 kind 分组、不丢 kind。 */
async function seedDocument(sql: postgres.Sql, buildId: string, kind: string): Promise<string> {
  const id = newId();
  const ts = now();
  await sql`
    insert into "document" (id, build_id, kind, version, payload, created_at, updated_at)
    values (${id}, ${buildId}, ${kind}, 1, ${'{"note":"x"}'}::jsonb, ${ts}, ${ts})
  `;
  return id;
}

async function callTool(
  app: FastifyInstance,
  key: string,
  name: string,
  args: Record<string, unknown>,
): Promise<RpcReply> {
  return rpc(app, key, {
    jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args },
  });
}

describe('MCP 工具写路径（真库）', () => {
  let sql: postgres.Sql;
  let db: ReturnType<typeof drizzle<typeof dbPkg.schema>>;
  let app: FastifyInstance;
  const fixtures: Fixture[] = [];

  before(async () => {
    sql = postgres(DATABASE_URL, { max: 5, idle_timeout: 20 });
    db = drizzle(sql, { schema: dbPkg.schema });
    app = Fastify({ logger: false });
    app.decorate('machineUrl', 'http://test');
    registerMcpRoutes(app, db as never);
    await app.ready();
  });

  after(async () => {
    const cleanupErrors: string[] = [];
    for (const f of fixtures) {
      // 清理失败**不许静默吞**：吞掉之后脏数据留在共享库里，下一轮测试的
      // 「计数」断言会被上一轮的数据喂成假绿。
      try { await deleteFixture(sql, f); } catch (e) {
        cleanupErrors.push(`${f.label}: ${(e as Error).message}`);
      }
    }
    await app.close();
    await sql.end();
    if (cleanupErrors.length > 0) {
      throw new Error(`${cleanupErrors.length} 个 fixture 清理失败：${cleanupErrors.join('; ')}`);
    }
  });

  test('传不属于调用方的 teamId 必须显式 403，不得静默回退成全部团队', async () => {
    // A 只属于 teamA；B 属于另一个团队
    const a = await seedFixture(sql, { label: 'skel-a', scopes: ['tool:todos'] });
    const b = await seedFixture(sql, { label: 'skel-b', scopes: ['tool:todos'] });
    fixtures.push(a, b);

    // A 的团队里确实有数据 —— 旧 bug 会把它返回出来
    const todoId = await seedTodo(sql, a);

    const res = await rpc(app, a.key, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'todos', arguments: { teamId: b.teamId } },
    });

    assert.equal(res.statusCode, 200, 'MCP transport 必须始终 2xx');
    assert.equal(res.body.error, undefined, '越权应是 tool execution error，不是 JSON-RPC error');
    assert.equal(res.body.result?.isError, true, '越权必须以 isError 文本回给模型');
    assert.match(callText(res.body), /403/);
    assert.match(callText(res.body), new RegExp(b.teamId));

    // 关键：旧行为会把 A 自己团队的 todo 静默返回。现在必须是错误，不含数据。
    assert.ok(!callText(res.body).includes(todoId), '越权时不得返回任何 todo 数据');
  });

  test('teamId 属于调用方时正常返回该团队数据', async () => {
    const a = await seedFixture(sql, { label: 'skel-ok', scopes: ['tool:todos'] });
    fixtures.push(a);
    const todoId = await seedTodo(sql, a);

    const res = await rpc(app, a.key, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'todos', arguments: { teamId: a.teamId } },
    });

    assert.equal(res.body.result?.isError, undefined, '合法 teamId 不该报错');
    assert.ok(callText(res.body).includes(todoId), '应返回该团队的 todo');
  });

  test('未授权工具仍是 -32002（加 case 不得放宽鉴权）', async () => {
    const a = await seedFixture(sql, { label: 'skel-deny', scopes: ['tool:todos'] });
    fixtures.push(a);
    // 参数必须**合法**：空 `arguments` 时就算鉴权被整个跳过也写不进去（zod 先炸），
    // 于是「鉴权被放宽」这个 bug 测不出来。
    const before = await countTodos(sql, a.projectId);
    const res = await rpc(app, a.key, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: {
        name: 'create_todo',
        arguments: { teamId: a.teamId, projectId: a.projectId, title: '未授权也该被挡' },
      },
    });
    assert.equal(res.body.error?.code, -32002, '未授权必须是 JSON-RPC -32002');
    assert.match(res.body.error?.message ?? '', /not granted/);
    assert.equal(await countTodos(sql, a.projectId), before,
      '鉴权被绕过时这条才会写进库 —— 库里必须一条都没多');
  });

  test('不在工具面上的名字在授权层被拒（-32002），措辞说「不存在」且不引用计划', async () => {
    const a = await seedFixture(sql, { label: 'skel-outside', scopes: ['tool:write'] });
    fixtures.push(a);

    const res = await rpc(app, a.key, {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'not_a_real_tool', arguments: {} },
    });

    // **MCP 面 31 个工具已全部实现**（2026-10-17），所以「已授权但未实现」这个
    // 类别不存在了。未知工具名在**授权检查之前**就被守卫拦下（routes/mcp.ts 的
    // `mcpToolSpec(name)`），回的是 JSON-RPC -32002 而非 tool isError envelope。
    // 措辞必须说「不存在」而不是「还没实现」—— 否则模型以为稍后可用、反复重试。
    assert.equal(res.body.error?.code, -32002);
    assert.match(res.body.error?.message ?? '', /does not exist on this MCP server/);
    assert.ok(!(res.body.error?.message ?? '').includes('not implemented'), '措辞不该说「还没实现」');
    assert.ok(!(res.body.error?.message ?? '').includes('MCP-WRITES-PLAN'), '不该引用计划文档');
  });

  test('tools/list 不因未实现而缩水 —— list 必须反映 key 的授权能力', async () => {
    const a = await seedFixture(sql, {
      label: 'skel-list',
      scopes: ['tool:todo', 'tool:board'],   // Chief 分组别名，收敛后仍接受
    });
    fixtures.push(a);

    const res = await rpc(app, a.key, {
      jsonrpc: '2.0', id: 6, method: 'tools/list', params: {},
    });

    const tools = (res.body.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? [];
    const names = new Set(tools.map((t) => t.name));

    // MCP 面（31）里 Chief `todo` 组占 12、`board` 组占 4 → 16。
    // Chief 的 14 + 6 里，`delete_todos` `relay_question` `create_project`
    // `update_project` 不在 MCP 面上，所以**不该**出现在 list 里。
    assert.equal(tools.length, 16, `todo+board 在 MCP 面上应列出 16 个，实际 ${tools.length}`);
    for (const n of ['create_todo', 'run_builds', 'projects', 'issues']) {
      assert.ok(names.has(n), `未实现的工具也必须出现在 list 里：${n}`);
    }
    for (const n of ['delete_todos', 'create_project', 'update_project', 'relay_question']) {
      assert.ok(!names.has(n), `${n} 是 Chief 专属，MCP 面上不该有它`);
    }
  });

  // ── TASK-2 · create_todo / update_todo ──────────────────────────────

  test('create_todo 正常建：库里确有该行且 phase=todo', async () => {
    const a = await seedFixture(sql, { label: 'c1', scopes: ['tool:create_todo'] });
    fixtures.push(a);

    const res = await callTool(app, a.key, 'create_todo', {
      teamId: a.teamId, projectId: a.projectId, title: '写类工具验收',
    });
    assert.equal(res.body.result?.isError, undefined, callText(res.body));

    const out = JSON.parse(callText(res.body)) as { todoId: string; seqNum: number; phase: string };
    assert.equal(out.phase, 'todo');
    assert.equal(out.seqNum, 1, '项目内第一条 seq_num 应为 1');

    const row = await readTodo(sql, out.todoId);
    assert.ok(row, '库里必须真有这一行');
    assert.equal(row.title, '写类工具验收');
    assert.equal(row.phase, 'todo');
  });

  test('create_todo 省略 ownerMemberId 时补真实 member（该列 NOT NULL）', async () => {
    const a = await seedFixture(sql, { label: 'c2', scopes: ['tool:create_todo'] });
    fixtures.push(a);

    const res = await callTool(app, a.key, 'create_todo', {
      teamId: a.teamId, projectId: a.projectId, title: 'owner 兜底',
    });
    const out = JSON.parse(callText(res.body)) as { todoId: string };
    const row = await readTodo(sql, out.todoId);
    assert.ok(row?.owner_member_id, 'owner_member_id 是 NOT NULL，必须有值');
    assert.equal(row.owner_member_id, a.memberId, '应取该团队已有的 member');
  });

  test('create_todo 省略 ownerMemberId：多成员团队里必须归到 key 所有者名下', async () => {
    const a = await seedFixture(sql, { label: 'c2-owner', scopes: ['tool:create_todo'] });
    fixtures.push(a);
    // 同团队再塞一个 member，且 id 排在 `a.memberId` 之前。修复前是「`limit(1)`
    // 且无 `orderBy` 的任一 member」，这条 decoy 会被捞走，todo 就建到别人名下了。
    // `member.actor_id` 没有 FK（schema.ts:59），所以不用真建 user 行。
    const decoyMemberId = '00000000-decoy-0000-0000-000000000000';
    const ts = now();
    await sql`
      insert into "member" (id, team_id, actor_id, member_type, role, joined_at, v)
      values (${decoyMemberId}, ${a.teamId}, ${'decoy-actor-' + a.teamId}, 'user', 'member', ${ts}, 0)
    `;

    const res = await callTool(app, a.key, 'create_todo', {
      teamId: a.teamId, projectId: a.projectId, title: 'owner 归 key 所有者',
    });
    const out = JSON.parse(callText(res.body)) as { todoId: string };
    const row = await readTodo(sql, out.todoId);
    assert.ok(row, '库里必须真有这一行');
    assert.equal(
      row.owner_member_id, a.memberId,
      'docs/mcp.md「MCP calls act as the key\'s owner」：省略时必须归 key 所有者，' +
      '不是团队里随便捞一个',
    );
    assert.notEqual(row.owner_member_id, decoyMemberId, '不能落到 decoy member 名下');
  });

  test('create_todo 显式 ownerMemberId：属于该团队时照它建（不被默认逻辑覆盖）', async () => {
    const a = await seedFixture(sql, { label: 'c2-exp', scopes: ['tool:create_todo'] });
    fixtures.push(a);
    // 用一个**不是** key 所有者的 member（同团队）当显式 owner，才测得出
    // 「显式优先于默认」这条。
    const chosen = '00000000-explicit-0000-0000-000000000000';
    const ts = now();
    await sql`
      insert into "member" (id, team_id, actor_id, member_type, role, joined_at, v)
      values (${chosen}, ${a.teamId}, ${'chosen-actor-' + a.teamId}, 'user', 'member', ${ts}, 0)
    `;
    const res = await callTool(app, a.key, 'create_todo', {
      teamId: a.teamId, projectId: a.projectId, title: '显式 owner', ownerMemberId: chosen,
    });
    const out = JSON.parse(callText(res.body)) as { todoId: string };
    const row = await readTodo(sql, out.todoId);
    assert.ok(row, '库里必须真有这一行');
    assert.equal(row.owner_member_id, chosen, '显式传了就必须照它，不能换成 key 所有者');
  });

  test('create_todo 显式 ownerMemberId 属别的团队时拒绝且不写库', async () => {
    const a = await seedFixture(sql, { label: 'c2-x1', scopes: ['tool:create_todo'] });
    const b = await seedFixture(sql, { label: 'c2-x2', scopes: ['tool:create_todo'] });
    fixtures.push(a, b);
    const before = await countTodos(sql, a.projectId);
    const res = await callTool(app, a.key, 'create_todo', {
      teamId: a.teamId, projectId: a.projectId, title: '跨团队 owner', ownerMemberId: b.memberId,
    });
    assert.equal(res.body.result?.isError, true);
    assert.match(callText(res.body), /403/);
    assert.equal(await countTodos(sql, a.projectId), before, '拒绝时不得写入任何行');
  });

  test('create_todo 的 projectId 属别的团队时拒绝且不写库', async () => {
    const a = await seedFixture(sql, { label: 'c3a', scopes: ['tool:create_todo'] });
    const b = await seedFixture(sql, { label: 'c3b', scopes: ['tool:create_todo'] });
    fixtures.push(a, b);

    const before = await countTodos(sql, b.projectId);
    const res = await callTool(app, a.key, 'create_todo', {
      teamId: a.teamId, projectId: b.projectId, title: '跨团队',
    });
    assert.equal(res.body.result?.isError, true);
    assert.match(callText(res.body), /403/);
    assert.equal(await countTodos(sql, b.projectId), before, '拒绝时不得写入任何行');
  });

  test('key 所有者不属于该 team 时 403 且不写库', async () => {
    const a = await seedFixture(sql, { label: 'c4a', scopes: ['tool:create_todo'] });
    const b = await seedFixture(sql, { label: 'c4b', scopes: ['tool:create_todo'] });
    fixtures.push(a, b);

    const before = await countTodos(sql, b.projectId);
    const res = await callTool(app, a.key, 'create_todo', {
      teamId: b.teamId, projectId: b.projectId, title: '越权团队',
    });
    assert.equal(res.body.result?.isError, true);
    assert.match(callText(res.body), /403/);
    assert.equal(await countTodos(sql, b.projectId), before);
  });

  test('title 超 280 被拒且无写入', async () => {
    const a = await seedFixture(sql, { label: 'c5', scopes: ['tool:create_todo'] });
    fixtures.push(a);
    const before = await countTodos(sql, a.projectId);

    const res = await callTool(app, a.key, 'create_todo', {
      teamId: a.teamId, projectId: a.projectId, title: 'x'.repeat(281),
    });
    assert.equal(res.body.result?.isError, true);
    assert.match(callText(res.body), /title/);
    assert.equal(await countTodos(sql, a.projectId), before);
  });

  test('spec 超 800 被拒且无写入', async () => {
    const a = await seedFixture(sql, { label: 'c6', scopes: ['tool:create_todo'] });
    fixtures.push(a);
    const before = await countTodos(sql, a.projectId);

    const res = await callTool(app, a.key, 'create_todo', {
      teamId: a.teamId, projectId: a.projectId, title: '长 spec', spec: 'y'.repeat(801),
    });
    assert.equal(res.body.result?.isError, true);
    assert.match(callText(res.body), /spec/);
    assert.equal(await countTodos(sql, a.projectId), before);
  });

  test('title 刚好 280 通过（内侧边界，原样落库）', async () => {
    const a = await seedFixture(sql, { label: 'c5b', scopes: ['tool:create_todo'] });
    fixtures.push(a);
    const res = await callTool(app, a.key, 'create_todo', {
      teamId: a.teamId, projectId: a.projectId, title: 'x'.repeat(280),
    });
    assert.equal(res.body.result?.isError, undefined, callText(res.body));
    const out = JSON.parse(callText(res.body)) as { todoId: string };
    assert.equal((await readTodo(sql, out.todoId))?.title.length, 280,
      '280 字符必须原样落库，不许被截断');
  });

  test('spec 刚好 800 通过（内侧边界，原样落库）', async () => {
    const a = await seedFixture(sql, { label: 'c6b', scopes: ['tool:create_todo'] });
    fixtures.push(a);
    const res = await callTool(app, a.key, 'create_todo', {
      teamId: a.teamId, projectId: a.projectId, title: '刚好 800', spec: 'y'.repeat(800),
    });
    assert.equal(res.body.result?.isError, undefined, callText(res.body));
    const out = JSON.parse(callText(res.body)) as { todoId: string };
    assert.equal((await readTodo(sql, out.todoId))?.spec?.length, 800,
      '800 字符必须原样落库');
  });

  test('projectId 不存在回 404 —— TASK-1 的 HttpError→isError 映射在此落地', async () => {
    const a = await seedFixture(sql, { label: 'c7', scopes: ['tool:create_todo'] });
    fixtures.push(a);

    const res = await callTool(app, a.key, 'create_todo', {
      teamId: a.teamId, projectId: 'no-such-project', title: '不存在项目',
    });
    assert.equal(res.body.error, undefined, '404 必须是 tool execution error，不是 JSON-RPC error');
    assert.equal(res.body.result?.isError, true);
    assert.match(callText(res.body), /^404/, '服务层的 HttpError 必须被 runTool 映射成 404 前缀文本');
  });

  test('同一项目连建两个 → seq_num 递增为 1, 2', async () => {
    const a = await seedFixture(sql, { label: 'c8', scopes: ['tool:create_todo'] });
    fixtures.push(a);

    const call1 = await callTool(app, a.key, 'create_todo', {
      teamId: a.teamId, projectId: a.projectId, title: '第一条',
    });
    assert.equal(call1.body.result?.isError, undefined, callText(call1.body));
    const r1 = JSON.parse(callText(call1.body)) as { seqNum: number };

    const call2 = await callTool(app, a.key, 'create_todo', {
      teamId: a.teamId, projectId: a.projectId, title: '第二条',
    });
    assert.equal(call2.body.result?.isError, undefined, callText(call2.body));
    const r2 = JSON.parse(callText(call2.body)) as { seqNum: number };
    assert.equal(r1.seqNum, 1);
    assert.equal(r2.seqNum, 2);
  });

  test('create_todo 递增 project.next_seq_num —— REST 路径接着建不会撞唯一约束', async () => {
    const a = await seedFixture(sql, { label: 'c8b', scopes: ['tool:create_todo'] });
    fixtures.push(a);

    const res = await callTool(app, a.key, 'create_todo', {
      teamId: a.teamId, projectId: a.projectId, title: 'MCP 建的',
    });
    assert.equal(res.body.result?.isError, undefined, callText(res.body));

    const row = await readProject(sql, a.projectId);
    assert.ok(row, 'project 行必须在');
    assert.equal(
      row.next_seq_num, 2,
      'MCP 建一条后计数器必须推到 2；停在 1 的话 REST 下一次拿号就撞 (project_id, seq_num)',
    );

    // 再用 REST(`routes/todos.ts`) 的拿号方式建一条：读计数器 → 拿它当 seq → 递增。
    // 计数器没被 MCP 推过就会撞唯一约束 —— 这正是「两套算法并存」的真实失败形态。
    const restSeq = (await sql<{ next_seq_num: number }[]>`
      select next_seq_num from "project" where id = ${a.projectId}
    `)[0]!.next_seq_num;
    await sql`
      insert into "todo"
        (id, project_id, seq_num, owner_member_id, title, tag_ids, phase,
         plan_first, separate_plan_build, with_checklist, created_at, updated_at)
      values
        (md5('rest-' || ${a.projectId}), ${a.projectId}, ${restSeq}, ${a.memberId},
         'REST 建的', '{}', 'todo', true, false, false, ${now()}, ${now()})
    `;
    await sql`update "project" set next_seq_num = next_seq_num + 1 where id = ${a.projectId}`;
    const seqs = await sql<{ seq_num: number }[]>`
      select seq_num from "todo" where project_id = ${a.projectId} order by seq_num
    `;
    assert.deepEqual(seqs.map((r) => r.seq_num), [1, 2], '共用计数器时两条路径的号不重');
  });

  test('第 400 个 open todo 仍允许（配额边界内侧）', async () => {
    const a = await seedFixture(sql, { label: 'c9ok', scopes: ['tool:create_todo'] });
    fixtures.push(a);
    await seedBulkOpenTodos(sql, a, 399);

    const res = await callTool(app, a.key, 'create_todo', {
      teamId: a.teamId, projectId: a.projectId, title: '第 400 条',
    });
    assert.equal(res.body.result?.isError, undefined, `边界内应允许：${callText(res.body)}`);
    assert.equal(await countTodos(sql, a.projectId), 400);
  });

  test('第 401 个被 Free 配额拒绝且库里仍是 400', async () => {
    const a = await seedFixture(sql, { label: 'c9no', scopes: ['tool:create_todo'] });
    fixtures.push(a);
    await seedBulkOpenTodos(sql, a, 400);

    const res = await callTool(app, a.key, 'create_todo', {
      teamId: a.teamId, projectId: a.projectId, title: '第 401 条',
    });
    assert.equal(res.body.result?.isError, true);
    assert.match(callText(res.body), /Free 上限/);
    assert.equal(await countTodos(sql, a.projectId), 400, '拒绝时不得写入');
  });

  test('create_todo 写入 todo_created 事件（重连客户端也要看到）', async () => {
    const a = await seedFixture(sql, { label: 'c10', scopes: ['tool:create_todo'] });
    fixtures.push(a);

    const res = await callTool(app, a.key, 'create_todo', {
      teamId: a.teamId, projectId: a.projectId, title: '带事件',
    });
    const out = JSON.parse(callText(res.body)) as { todoId: string };

    const rows = await sql<{ type: string; payload: unknown }[]>`
      select type, payload from "sse_event"
      where team_id = ${a.teamId} and type = 'todo_created'
      order by seq desc limit 1
    `;
    const evt = rows[0];
    assert.ok(evt, '建 todo 必须发 team scope 事件，否则看板不会刷新');
    assert.equal((evt.payload as { todoId: string }).todoId, out.todoId);
  });

  test('update_todo 改 title 真的落库，并发 team scope 的 todo_updated', async () => {
    const a = await seedFixture(sql, { label: 'u1', scopes: ['tool:update_todo'] });
    fixtures.push(a);
    const todoId = await seedTodo(sql, a);

    const res = await callTool(app, a.key, 'update_todo', { todoId, title: '改过的标题' });
    assert.equal(res.body.result?.isError, undefined, callText(res.body));
    assert.equal((await readTodo(sql, todoId))?.title, '改过的标题');
    // 事件断言：`updateTodo` 发 `team:<teamId>` 的 `todo_updated`（services/todos.ts:351）。
    // 看板订阅的就是 team scope —— 少发一帧从返回值完全看不出来，看板一直不刷新。
    assert.deepEqual(
      await eventScopes(sql, 'todo_updated', todoId), [`team:${a.teamId}`],
      '改完必须发 todo_updated（team scope）',
    );
  });

  test('deleteTodo（服务层）：库里删行 + team scope 的 todo_deleted', async () => {
    // `delete_todos` 已从 MCP 面上移除（recon §8 的 31 里没有它），所以现在**没有
    // 任何端点会调 deleteTodo** —— 只能直接驱动服务层。这条钉的是「删行 + 发事件」
    // 这个副作用对，不是某个入口；入口换了也照样守得住。
    const a = await seedFixture(sql, { label: 'u1d', scopes: ['tool:todos'] });
    fixtures.push(a);
    const todoId = await seedTodo(sql, a);

    await deleteTodo(db as never, todoId, a.teamId);

    assert.equal(await countTodos(sql, a.projectId), 0, 'todo 行必须真被删掉');
    assert.deepEqual(
      await eventScopes(sql, 'todo_deleted', todoId), [`team:${a.teamId}`],
      '删除必须发 todo_deleted（team scope），否则看板还挂着那条已删的 todo',
    );
  });

  test('update_todo 传 phase 被明确拒绝，且是全有或全无', async () => {
    const a = await seedFixture(sql, { label: 'u2', scopes: ['tool:update_todo'] });
    fixtures.push(a);
    const todoId = await seedTodo(sql, a);

    const res = await callTool(app, a.key, 'update_todo', {
      todoId, title: '顺带改 phase', phase: 'done',
    });
    assert.equal(res.body.result?.isError, true);
    assert.match(callText(res.body), /phase cannot be set directly/);

    const row = await readTodo(sql, todoId);
    assert.equal(row?.phase, 'todo');
    assert.equal(row?.title, 'todo of ' + a.label,
      '拒绝必须是全有或全无 —— 不能 title 改了而 phase 没改');
  });

  test('update_todo 空 patch 被拒且数据未变', async () => {
    const a = await seedFixture(sql, { label: 'u3', scopes: ['tool:update_todo'] });
    fixtures.push(a);
    const todoId = await seedTodo(sql, a);
    const before = (await readTodo(sql, todoId))?.title;

    const res = await callTool(app, a.key, 'update_todo', { todoId });
    assert.equal(res.body.result?.isError, true);
    assert.match(callText(res.body), /at least one/);
    assert.equal((await readTodo(sql, todoId))?.title, before);
  });

  test('update_todo 跨团队被拒且 title 未变', async () => {
    const a = await seedFixture(sql, { label: 'u4a', scopes: ['tool:update_todo'] });
    const b = await seedFixture(sql, { label: 'u4b', scopes: ['tool:update_todo'] });
    fixtures.push(a, b);
    const todoId = await seedTodo(sql, b);   // todo 属于 B
    const before = (await readTodo(sql, todoId))?.title;

    const res = await callTool(app, a.key, 'update_todo', { todoId, title: 'A 想改 B 的' });
    assert.equal(res.body.result?.isError, true);
    assert.match(callText(res.body), /403/);
    assert.equal((await readTodo(sql, todoId))?.title, before, '越权时 title 不得变');
  });

  test('update_todo 对不存在的 todoId 回 404', async () => {
    const a = await seedFixture(sql, { label: 'u5', scopes: ['tool:update_todo'] });
    fixtures.push(a);

    const res = await callTool(app, a.key, 'update_todo', { todoId: 'no-such-todo', title: 'x' });
    assert.equal(res.body.result?.isError, true);
    assert.match(callText(res.body), /^404/);
  });

  // ── TASK-3 · 生命周期三工具 ──────────────────────────────────────────

  test('complete_todos 把 review 中的 todo 推到 done，并双 scope 发 phase_changed', async () => {
    const a = await seedFixture(sql, { label: 'l1', scopes: ['tool:complete_todos'] });
    fixtures.push(a);
    const todoId = await seedTodo(sql, a, 'review');

    const res = await callTool(app, a.key, 'complete_todos', { todoIds: [todoId] });
    assert.equal(res.body.result?.isError, undefined, callText(res.body));
    const payload = parseBatch(res.body);
    assert.equal(payload.succeeded, 1);
    assert.equal(payload.failed, 0);
    assert.equal(payload.results.find((r) => r.todoId === todoId)?.ok, true);
    assert.equal((await readTodo(sql, todoId))?.phase, 'done', '库里必须真的推进');
    assert.deepEqual(
      await eventScopes(sql, 'phase_changed', todoId),
      [`team:${a.teamId}`, `todo:${todoId}`].sort(),
      '少一个 scope，另一侧的订阅者就一直不更新',
    );
  });

  test('complete_todos 带 merge=true 走合并分支（implement，不是 done）', async () => {
    const a = await seedFixture(sql, { label: 'l2', scopes: ['tool:complete_todos'] });
    fixtures.push(a);
    const todoId = await seedTodo(sql, a, 'review');

    const res = await callTool(app, a.key, 'complete_todos', { todoIds: [todoId], merge: true });
    assert.equal(parseBatch(res.body).results.find((r) => r.todoId === todoId)?.phase, 'implement');
    assert.equal((await readTodo(sql, todoId))?.phase, 'implement', 'merge 的落点必须是 implement');
  });

  test('close_todos 关闭未完成的 todo（库里变 closed）', async () => {
    const a = await seedFixture(sql, { label: 'l3', scopes: ['tool:close_todos'] });
    fixtures.push(a);
    const todoId = await seedTodo(sql, a, 'implement');

    const res = await callTool(app, a.key, 'close_todos', { todoIds: [todoId] });
    assert.equal(res.body.result?.isError, undefined, callText(res.body));
    assert.equal(parseBatch(res.body).succeeded, 1);
    assert.equal((await readTodo(sql, todoId))?.phase, 'closed');
    assert.deepEqual(
      await eventScopes(sql, 'phase_changed', todoId),
      [`team:${a.teamId}`, `todo:${todoId}`].sort(),
      'close 成功也必须双 scope 发 phase_changed（看板 + 详情页）',
    );
  });

  test('close_todos 对已落定的 todo 被拒且库里 phase 未变', async () => {
    const a = await seedFixture(sql, { label: 'l4', scopes: ['tool:close_todos'] });
    fixtures.push(a);
    const todoId = await seedTodo(sql, a, 'done');

    const res = await callTool(app, a.key, 'close_todos', { todoIds: [todoId] });
    const item = parseBatch(res.body).results.find((r) => r.todoId === todoId);
    assert.equal(item?.ok, false);
    assert.match(item?.reason ?? '', /settled/);
    assert.equal((await readTodo(sql, todoId))?.phase, 'done', '拒绝不该动 phase');
  });

  test('reopen_todos 把 closed 的 todo 拉回上一个静止闸门（review）', async () => {
    const a = await seedFixture(sql, { label: 'l5', scopes: ['tool:reopen_todos'] });
    fixtures.push(a);
    const todoId = await seedTodo(sql, a, 'closed');

    const res = await callTool(app, a.key, 'reopen_todos', { todoIds: [todoId] });
    assert.equal(res.body.result?.isError, undefined, callText(res.body));
    assert.equal(parseBatch(res.body).results.find((r) => r.todoId === todoId)?.phase, 'review');
    assert.equal((await readTodo(sql, todoId))?.phase, 'review');
    assert.deepEqual(
      await eventScopes(sql, 'phase_changed', todoId),
      [`team:${a.teamId}`, `todo:${todoId}`].sort(),
      'reopen 成功也必须**双 scope**发 phase_changed —— 此前只有 complete_todos 测过，' +
      'close/reopen 少发一帧看板就不刷新，而返回值完全看不出来',
    );
  });

  test('闸门拒绝时回 ok:false 且库里 phase 未变', async () => {
    const a = await seedFixture(sql, { label: 'l6', scopes: ['tool:complete_todos'] });
    fixtures.push(a);
    const todoId = await seedTodo(sql, a, 'todo');   // todo 阶段只认 claim / plan_ready

    const res = await callTool(app, a.key, 'complete_todos', { todoIds: [todoId] });
    // 「逐个尽力」语义下拒绝是**结果**，不是异常 —— 不能回 isError
    assert.equal(res.body.result?.isError, undefined, callText(res.body));
    const item = parseBatch(res.body).results.find((r) => r.todoId === todoId);
    assert.equal(item?.ok, false);
    assert.match(item?.reason ?? '', /rejects/);
    assert.equal((await readTodo(sql, todoId))?.phase, 'todo', '拒绝时 phase 必须保持原样');
  });

  test('批量是逐个尽力：3 个里 1 个被拒，另 2 个照常推进', async () => {
    const a = await seedFixture(sql, { label: 'l7', scopes: ['tool:complete_todos'] });
    fixtures.push(a);
    const ok1 = await seedTodo(sql, a, 'review');
    const ok2 = await seedTodo(sql, a, 'review');
    const bad = await seedTodo(sql, a, 'todo');

    const res = await callTool(app, a.key, 'complete_todos', { todoIds: [ok1, bad, ok2] });
    const payload = parseBatch(res.body);
    assert.equal(payload.succeeded, 2);
    assert.equal(payload.failed, 1);
    assert.deepEqual(payload.results.map((r) => r.todoId), [ok1, bad, ok2],
      '回包必须保持入参顺序，模型才能把失败项对回它自己请求的那一个');
    assert.equal((await readTodo(sql, ok1))?.phase, 'done');
    assert.equal((await readTodo(sql, ok2))?.phase, 'done');
    assert.equal((await readTodo(sql, bad))?.phase, 'todo');
  });

  test('批量里不存在的 todoId 只让那一项失败，其余照常', async () => {
    const a = await seedFixture(sql, { label: 'l8', scopes: ['tool:complete_todos'] });
    fixtures.push(a);
    const good = await seedTodo(sql, a, 'review');

    const res = await callTool(app, a.key, 'complete_todos', {
      todoIds: ['no-such-todo', good],
    });
    const payload = parseBatch(res.body);
    assert.equal(payload.succeeded, 1);
    assert.equal(payload.failed, 1);
    assert.match(payload.results[0]?.reason ?? '', /404/);
    assert.equal(payload.results[1]?.ok, true);
    assert.equal((await readTodo(sql, good))?.phase, 'done', '一项失败不能拖累同批其它项');
  });

  test('跨团队的生命周期操作被拒且库里 phase 未变', async () => {
    const a = await seedFixture(sql, { label: 'l9a', scopes: ['tool:close_todos'] });
    const b = await seedFixture(sql, { label: 'l9b', scopes: ['tool:close_todos'] });
    fixtures.push(a, b);
    const todoId = await seedTodo(sql, b, 'implement');   // todo 属于 B

    const res = await callTool(app, a.key, 'close_todos', { todoIds: [todoId] });
    const item = parseBatch(res.body).results.find((r) => r.todoId === todoId);
    assert.equal(item?.ok, false);
    assert.match(item?.reason ?? '', /403/);
    assert.equal((await readTodo(sql, todoId))?.phase, 'implement', '越权不得改 phase');
  });

  test('空 todoIds 是合法空操作，不报错', async () => {
    const a = await seedFixture(sql, { label: 'l10', scopes: ['tool:complete_todos'] });
    fixtures.push(a);

    const res = await callTool(app, a.key, 'complete_todos', { todoIds: [] });
    assert.equal(res.body.result?.isError, undefined, callText(res.body));
    const payload = parseBatch(res.body);
    assert.equal(payload.succeeded, 0);
    assert.equal(payload.failed, 0);
    assert.deepEqual(payload.results, []);
  });

  // ── TASK-6 · 读类补齐（单条 todo / skills / limit 上限） ─────────────

  test('todos 带不存在的 todoId 回 404', async () => {
    const a = await seedFixture(sql, { label: 'r1', scopes: ['tool:todos'] });
    fixtures.push(a);

    const res = await callTool(app, a.key, 'todos', { todoId: 'no-such-todo' });
    assert.equal(res.body.result?.isError, true);
    assert.match(callText(res.body), /^404/, '不存在的 todo 该报 404，不该回一个空对象');
  });

  test('todos 带跨团队 todoId 回 403 且不返回任何字段', async () => {
    const a = await seedFixture(sql, { label: 'r2a', scopes: ['tool:todos'] });
    const b = await seedFixture(sql, { label: 'r2b', scopes: ['tool:todos'] });
    fixtures.push(a, b);
    const theirs = await seedTodo(sql, b);   // title = 'todo of r2b'

    const res = await callTool(app, a.key, 'todos', { todoId: theirs });
    assert.equal(res.body.result?.isError, true);
    const text = callText(res.body);
    assert.match(text, /403/);
    assert.ok(!text.includes('"title"'), '越权读取必须一个字段都不带回来');
    assert.ok(!text.includes('r2b'), '更不能把对方的内容带回来');
  });

  test('todos 带 todoId 返回完整上下文', async () => {
    const a = await seedFixture(sql, { label: 'r3', scopes: ['tool:todos'] });
    fixtures.push(a);
    const todoId = await seedTodo(sql, a);
    await sql`update "todo" set spec = '完整规格' where id = ${todoId}`;
    const agentId = await seedAgent(sql, a);
    await seedBuild(sql, a, todoId, agentId);   // 顺带种一条 plan 文档

    const res = await callTool(app, a.key, 'todos', { todoId });
    assert.equal(res.body.result?.isError, undefined, callText(res.body));
    const reply = callJson<{
      todo: { title: string; spec: string | null; phase: string; projectName: string };
      builds: Array<{ n: number }>;
      documents: Record<string, Array<{ buildN: number | null }>>;
    }>(res.body);
    assert.equal(reply.todo.title, 'todo of r3');
    assert.equal(reply.todo.spec, '完整规格', 'spec 是接手工作的关键输入，不能省');
    assert.equal(reply.todo.phase, 'todo');
    assert.equal(reply.todo.projectName, 'r3');
    assert.equal(reply.builds.length, 1);
    assert.equal(reply.builds[0]?.n, 1);
    assert.equal(reply.documents['plan']?.[0]?.buildN, 1,
      '文档必须标出属于第几轮 build，否则模型分不清新旧');
  });

  test('单条读取不含任何凭据字段', async () => {
    const a = await seedFixture(sql, { label: 'r4', scopes: ['tool:todos'] });
    fixtures.push(a);
    const todoId = await seedTodo(sql, a);
    const agentId = await seedAgent(sql, a);
    await seedBuild(sql, a, todoId, agentId);

    const res = await callTool(app, a.key, 'todos', { todoId });
    const text = callText(res.body);
    for (const secret of ['enc_', 'step_credential', 'storage_path', 'storagePath']) {
      assert.ok(!text.includes(secret), `返回值里不该出现 ${secret}`);
    }
  });

  test('单条读取的 documents 按 kind 分组且六种 kind 都在', async () => {
    const a = await seedFixture(sql, { label: 'r5', scopes: ['tool:todos'] });
    fixtures.push(a);
    const todoId = await seedTodo(sql, a);
    const agentId = await seedAgent(sql, a);
    const buildId = await seedBuild(sql, a, todoId, agentId);   // 已含一条 plan
    await seedDocument(sql, buildId, 'changes');
    await seedDocument(sql, buildId, 'input');

    const res = await callTool(app, a.key, 'todos', { todoId });
    const reply = callJson<{ documents: Record<string, unknown[]> }>(res.body);
    assert.deepEqual(Object.keys(reply.documents).sort(),
      ['changes', 'confirm', 'input', 'plan', 'question', 'review'],
      'doc_kind 有六种（packages/db/src/schema.ts:23），少一种就是静默丢数据');
    assert.equal(reply.documents['changes']?.length, 1);
    assert.equal(reply.documents['input']?.length, 1);
    assert.equal(reply.documents['plan']?.length, 1);
    assert.equal(reply.documents['confirm']?.length, 0, '没有的 kind 该是空数组而不是缺 key');
  });

  test('skills 过滤掉已删除的', async () => {
    const a = await seedFixture(sql, { label: 'r6', scopes: ['tool:skills'] });
    fixtures.push(a);
    await seedSkill(sql, a, '活着的技能');
    await seedSkill(sql, a, '已删的技能', now());

    const res = await callTool(app, a.key, 'skills', {});
    assert.equal(res.body.result?.isError, undefined, callText(res.body));
    const names = callJson<{ skills: Array<{ name: string }> }>(res.body).skills
      .map((s) => s.name);
    assert.ok(names.includes('活着的技能'));
    assert.ok(!names.includes('已删的技能'),
      'deleted_at 非空必须过滤 —— 否则模型会去用一个已经不存在的技能');
  });

  test('skills 不返回 storage_path', async () => {
    const a = await seedFixture(sql, { label: 'r7', scopes: ['tool:skills'] });
    fixtures.push(a);
    await seedSkill(sql, a, '一个技能');

    const text = callText((await callTool(app, a.key, 'skills', {})).body);
    assert.ok(!text.includes('storage_path') && !text.includes('storagePath'),
      '服务器本地目录对模型无意义');
    assert.ok(!text.includes('/var/skills'), '更不能把真实路径泄露出去');
  });

  test('skills 传别人的 teamId 回 403', async () => {
    const a = await seedFixture(sql, { label: 'r8a', scopes: ['tool:skills'] });
    const b = await seedFixture(sql, { label: 'r8b', scopes: ['tool:skills'] });
    fixtures.push(a, b);
    await seedSkill(sql, b, 'B 的技能');

    const res = await callTool(app, a.key, 'skills', { teamId: b.teamId });
    assert.equal(res.body.result?.isError, true);
    assert.match(callText(res.body), /403/);
  });

  test('todos 的 limit 生效', async () => {
    const a = await seedFixture(sql, { label: 'r9', scopes: ['tool:todos'] });
    fixtures.push(a);
    await seedBulkOpenTodos(sql, a, 60);

    const res = await callTool(app, a.key, 'todos', { limit: 10 });
    assert.equal(callJson<{ todos: unknown[] }>(res.body).todos.length, 10);
  });

  test('todos 不给 limit 时默认 50', async () => {
    const a = await seedFixture(sql, { label: 'r10', scopes: ['tool:todos'] });
    fixtures.push(a);
    await seedBulkOpenTodos(sql, a, 60);

    const res = await callTool(app, a.key, 'todos', {});
    assert.equal(callJson<{ todos: unknown[] }>(res.body).todos.length, 50,
      '默认值必须生效 —— 否则「limit 有硬上限」这条验收是假的');
  });

  test('todos 的 limit=0 回退默认 50（不是 0 条）', async () => {
    const a = await seedFixture(sql, { label: 'r10b', scopes: ['tool:todos'] });
    fixtures.push(a);
    await seedBulkOpenTodos(sql, a, 60);
    const res = await callTool(app, a.key, 'todos', { limit: 0 });
    assert.equal(callJson<{ todos: unknown[] }>(res.body).todos.length, 50,
      'limit=0 必须回退默认 —— 回 0 条会让模型以为团队里没有 todo');
  });

  test('todos 的 limit 为负数时同样回退默认 50', async () => {
    const a = await seedFixture(sql, { label: 'r10c', scopes: ['tool:todos'] });
    fixtures.push(a);
    await seedBulkOpenTodos(sql, a, 60);
    const res = await callTool(app, a.key, 'todos', { limit: -5 });
    assert.equal(callJson<{ todos: unknown[] }>(res.body).todos.length, 50,
      '负数 limit 不得变成「全量」或 SQL 报错');
  });

  test('todos 的 limit 被硬夹到 200', async () => {
    const a = await seedFixture(sql, { label: 'r11', scopes: ['tool:todos'] });
    fixtures.push(a);
    await seedBulkOpenTodos(sql, a, 210);

    const res = await callTool(app, a.key, 'todos', { limit: 9999 });
    assert.equal(callJson<{ todos: unknown[] }>(res.body).todos.length, 200,
      '不给硬上限就会一次回 210 条，撑爆模型上下文');
  });

  test('todos 按 phase 过滤：只回该 phase 的行', async () => {
    const a = await seedFixture(sql, { label: 'r12', scopes: ['tool:todos'] });
    fixtures.push(a);
    await seedBulkOpenTodos(sql, a, 5);   // 5 条 phase='todo'
    await seedTodo(sql, a, 'review');
    await seedTodo(sql, a, 'done');

    const res = await callTool(app, a.key, 'todos', { phase: 'review' });
    const rows = callJson<{ todos: Array<{ phase: string }> }>(res.body).todos;
    assert.ok(rows.length >= 1, '过滤必须至少命中一条（否则「只回 review」是空集重言式）');
    assert.ok(
      rows.every((r) => r.phase === 'review'),
      `phase 过滤必须只回 review，实际：${rows.map((r) => r.phase).join(',')}`,
    );
  });

  test('todos 带非法 phase 回 400，不是静默空列表', async () => {
    const a = await seedFixture(sql, { label: 'r14', scopes: ['tool:todos'] });
    fixtures.push(a);
    await seedBulkOpenTodos(sql, a, 3);   // 库里确实有 todo
    const res = await callTool(app, a.key, 'todos', { phase: 'don' });
    assert.equal(res.body.result?.isError, true, '拼错的 phase 必须是工具错误');
    assert.match(callText(res.body), /400: phase must be one of/,
      '必须报 400 并列出合法取值 —— 此前 `phase:"don"` 会静默回空列表，' +
      '模型会以为「团队里没有 done 的 todo」，而实际是它自己拼错了');
  });

  test('todos 按 projectId 过滤：同团队另一个项目的行不得混进来', async () => {
    const a = await seedFixture(sql, { label: 'r13', scopes: ['tool:todos'] });
    fixtures.push(a);
    await seedTodo(sql, a);   // fixture 自带的项目里也要有行 —— 否则过滤是空集重言式
    const projectId2 = newId();
    await sql`
      insert into "project" (id, team_id, name, provider, repo_kind, default_branch, next_seq_num, created_at)
      values (${projectId2}, ${a.teamId}, 'r13-other', 'external', 'other', 'main', 1, ${now()})
    `;
    await sql`
      insert into "todo"
        (id, project_id, seq_num, owner_member_id, title, tag_ids, phase,
         plan_first, separate_plan_build, with_checklist, created_at, updated_at)
      values (${newId()}, ${projectId2}, 1, ${a.memberId}, '另一个项目的 todo', '{}', 'todo',
        true, false, false, ${now()}, ${now()})
    `;

    const res = await callTool(app, a.key, 'todos', { projectId: projectId2 });
    const rows = callJson<{ todos: Array<{ projectId: string }> }>(res.body).todos;
    assert.ok(rows.length >= 1, '过滤必须命中另一项目的那条');
    assert.ok(
      rows.every((r) => r.projectId === projectId2),
      `projectId 过滤必须只回该项目，实际：${rows.map((r) => r.projectId).join(',')}`,
    );
  });

  // ── 调度与对话（MCP 薄壳：业务规则全走 services/） ───────────────

  test('schedule_todo 建规则：库里确有该行，created_by 是 key 所有者', async () => {
    const a = await seedFixture(sql, { label: 'sc1', scopes: ['tool:schedule_todo'] });
    fixtures.push(a);
    const todoId = await seedTodo(sql, a);

    const res = await callTool(app, a.key, 'schedule_todo', {
      teamId: a.teamId, todoId, kind: 'daily', cron: '08:30', timezone: 'Asia/Shanghai',
    });
    assert.equal(res.body.result?.isError, undefined, callText(res.body));

    const rows = await sql<{ c: number; created_by: string; cron: string }[]>`
      select count(*)::int as c, min(created_by) as created_by, min(cron) as cron
      from "schedule" where team_id = ${a.teamId}
    `;
    assert.equal(rows[0]?.c, 1, callText(res.body));
    assert.equal(rows[0]?.created_by, a.userId, 'created_by 必须是 key 所有者，不是客户端传的');
    assert.equal(rows[0]?.cron, '08:30');
  });

  test('schedule_todo weekly：weekday 拼进持久化 cron，读回来时拆成两个字段', async () => {
    const a = await seedFixture(sql, { label: 'sc2', scopes: ['tool:schedule_todo'] });
    fixtures.push(a);
    const todoId = await seedTodo(sql, a);

    const res = await callTool(app, a.key, 'schedule_todo', {
      teamId: a.teamId, todoId, kind: 'weekly', cron: '10:00', weekday: 3, timezone: 'UTC',
    });
    assert.equal(res.body.result?.isError, undefined, callText(res.body));

    const shape = callJson<{ schedule: { cron: string; weekday: number | null } }>(res.body).schedule;
    assert.equal(shape.cron, '10:00', '对模型暴露的 cron 不该带 <dow> 前缀');
    assert.equal(shape.weekday, 3);
    const rows = await sql<{ cron: string }[]>`
      select cron from "schedule" where team_id = ${a.teamId}
    `;
    assert.equal(rows[0]?.cron, 'Wed 10:00', '库里存的是 <dow> <HH:MM>');
  });

  test('schedule_todo 跨团队拒绝且不写库', async () => {
    const a = await seedFixture(sql, { label: 'sc3a', scopes: ['tool:schedule_todo'] });
    const b = await seedFixture(sql, { label: 'sc3b', scopes: ['tool:schedule_todo'] });
    fixtures.push(a, b);
    const todoId = await seedTodo(sql, b);

    const res = await callTool(app, a.key, 'schedule_todo', {
      teamId: b.teamId, todoId, kind: 'daily', cron: '09:00', timezone: 'UTC',
    });
    assert.equal(res.body.result?.isError, true);
    assert.match(callText(res.body), /is not accessible to this key's owner/);
    const rows = await sql<{ c: number }[]>`
      select count(*)::int as c from "schedule" where team_id = ${b.teamId}
    `;
    assert.equal(rows[0]?.c, 0, '拒绝时一条规则都不能落库');
  });

  test('schedule_todo 非法 cron 被拒且不写库（校验与 REST 同源）', async () => {
    const a = await seedFixture(sql, { label: 'sc4', scopes: ['tool:schedule_todo'] });
    fixtures.push(a);
    const todoId = await seedTodo(sql, a);

    const res = await callTool(app, a.key, 'schedule_todo', {
      teamId: a.teamId, todoId, kind: 'hourly', cron: '99', timezone: 'UTC',
    });
    assert.equal(res.body.result?.isError, true);
    assert.match(callText(res.body), /hourly cron must be an integer 0-59/);
    const rows = await sql<{ c: number }[]>`
      select count(*)::int as c from "schedule" where team_id = ${a.teamId}
    `;
    assert.equal(rows[0]?.c, 0);
  });

  test('schedule_todo 缺 timezone 是入参错误，不是未实现', async () => {
    const a = await seedFixture(sql, { label: 'sc5', scopes: ['tool:schedule_todo'] });
    fixtures.push(a);
    const todoId = await seedTodo(sql, a);

    const res = await callTool(app, a.key, 'schedule_todo', {
      teamId: a.teamId, todoId, kind: 'daily', cron: '09:00',
    });
    assert.equal(res.body.result?.isError, true);
    assert.match(callText(res.body), /invalid arguments/);
    assert.ok(!callText(res.body).includes('not implemented'), '参数缺失不该被当成未实现');
  });

  test('schedule_todo 超过 10 条上限被拒（第 11 条）', async () => {
    const a = await seedFixture(sql, { label: 'sc6', scopes: ['tool:schedule_todo'] });
    fixtures.push(a);
    const todoId = await seedTodo(sql, a);
    for (let i = 0; i < 10; i++) {
      const ok = await callTool(app, a.key, 'schedule_todo', {
        teamId: a.teamId, todoId, kind: 'daily', cron: `0${i}:00`, timezone: 'UTC',
      });
      assert.equal(ok.body.result?.isError, undefined, `第 ${i + 1} 条不该被拒：${callText(ok.body)}`);
    }
    const before = await sql<{ c: number }[]>`
      select count(*)::int as c from "schedule" where team_id = ${a.teamId}
    `;
    const res = await callTool(app, a.key, 'schedule_todo', {
      teamId: a.teamId, todoId, kind: 'daily', cron: '23:00', timezone: 'UTC',
    });
    assert.equal(res.body.result?.isError, true);
    assert.match(callText(res.body), /schedule limit reached \(10 per team\)/);
    const after = await sql<{ c: number }[]>`
      select count(*)::int as c from "schedule" where team_id = ${a.teamId}
    `;
    assert.equal(after[0]?.c, before[0]?.c, '被拒时库里不能多出半条');
  });

  test('schedule_todo 需要该团队 admin：member 角色被拒且一行都没写', async () => {
    const member = await seedFixture(sql, { label: 'sc7', scopes: ['tool:schedule_todo'] });
    fixtures.push(member);
    // fixture 默认是 admin；降成 member 才能单独测出 admin 闸门（团队归属是另一条闸门）
    await sql`update "member" set role = 'member' where id = ${member.memberId}`;
    const todoId = await seedTodo(sql, member);

    const res = await callTool(app, member.key, 'schedule_todo', {
      teamId: member.teamId, todoId, kind: 'daily', cron: '09:00', timezone: 'UTC',
    });
    assert.equal(res.body.result?.isError, true);
    assert.match(callText(res.body), /managing schedule rules requires team admin/);
    const rows = await sql<{ c: number }[]>`
      select count(*)::int as c from "schedule" where team_id = ${member.teamId}
    `;
    assert.equal(rows[0]?.c, 0, '非 admin 写入必须一行都没有');
  });

  test('unschedule_todo 软删规则：库里 deleted_at 被打上', async () => {
    const a = await seedFixture(sql, {
      label: 'us1', scopes: ['tool:schedule_todo', 'tool:unschedule_todo'],
    });
    fixtures.push(a);
    const todoId = await seedTodo(sql, a);
    const created = await callTool(app, a.key, 'schedule_todo', {
      teamId: a.teamId, todoId, kind: 'daily', cron: '08:30', timezone: 'Asia/Shanghai',
    });
    const scheduleId = callJson<{ schedule: { id: string } }>(created.body).schedule.id;

    const res = await callTool(app, a.key, 'unschedule_todo', { teamId: a.teamId, scheduleId });
    assert.equal(res.body.result?.isError, undefined, callText(res.body));
    assert.equal(callJson<{ ok: boolean; deleted: string }>(res.body).deleted, scheduleId);

    const rows = await sql<{ deleted_at: number | null }[]>`
      select deleted_at from "schedule" where id = ${scheduleId}
    `;
    assert.ok(rows[0]?.deleted_at, 'deleted_at 必须被打上（soft-delete，不是硬删）');
  });

  test('unschedule_todo 删别的团队的规则 → 403，且那行没被动过', async () => {
    const a = await seedFixture(sql, {
      label: 'us2a', scopes: ['tool:schedule_todo', 'tool:unschedule_todo'],
    });
    const b = await seedFixture(sql, {
      label: 'us2b', scopes: ['tool:schedule_todo', 'tool:unschedule_todo'],
    });
    fixtures.push(a, b);
    const bTodo = await seedTodo(sql, b);
    const created = await callTool(app, b.key, 'schedule_todo', {
      teamId: b.teamId, todoId: bTodo, kind: 'daily', cron: '08:30', timezone: 'UTC',
    });
    const scheduleId = callJson<{ schedule: { id: string } }>(created.body).schedule.id;

    const res = await callTool(app, a.key, 'unschedule_todo', { teamId: b.teamId, scheduleId });
    assert.equal(res.body.result?.isError, true);
    assert.match(callText(res.body), /is not accessible to this key's owner/);
    const rows = await sql<{ deleted_at: number | null }[]>`
      select deleted_at from "schedule" where id = ${scheduleId}
    `;
    assert.equal(rows[0]?.deleted_at, null, '被拒时别人的规则不能被软删');
  });

  test('unschedule_todo 删不存在的规则 → 404（不静默成功）', async () => {
    const a = await seedFixture(sql, { label: 'us3', scopes: ['tool:unschedule_todo'] });
    fixtures.push(a);

    const res = await callTool(app, a.key, 'unschedule_todo', {
      teamId: a.teamId, scheduleId: newId(),
    });
    assert.equal(res.body.result?.isError, true);
    assert.match(callText(res.body), /404: schedule not found/);
  });

  test('unschedule_todo 需要 admin：member 角色被拒且规则还在', async () => {
    const a = await seedFixture(sql, {
      label: 'us4', scopes: ['tool:schedule_todo', 'tool:unschedule_todo'],
    });
    fixtures.push(a);
    const todoId = await seedTodo(sql, a);
    const created = await callTool(app, a.key, 'schedule_todo', {
      teamId: a.teamId, todoId, kind: 'daily', cron: '08:30', timezone: 'UTC',
    });
    const scheduleId = callJson<{ schedule: { id: string } }>(created.body).schedule.id;
    await sql`update "member" set role = 'member' where id = ${a.memberId}`;

    const res = await callTool(app, a.key, 'unschedule_todo', { teamId: a.teamId, scheduleId });
    assert.equal(res.body.result?.isError, true);
    assert.match(callText(res.body), /managing schedule rules requires team admin/);
    const rows = await sql<{ deleted_at: number | null }[]>`
      select deleted_at from "schedule" where id = ${scheduleId}
    `;
    assert.equal(rows[0]?.deleted_at, null, '非 admin 删不得生效');
  });

  test('schedules 读列表：过滤掉已软删的规则', async () => {
    const a = await seedFixture(sql, {
      label: 'ls1', scopes: ['tool:schedule_todo', 'tool:unschedule_todo', 'tool:schedules'],
    });
    fixtures.push(a);
    const todoId = await seedTodo(sql, a);
    const created = await callTool(app, a.key, 'schedule_todo', {
      teamId: a.teamId, todoId, kind: 'daily', cron: '07:15', timezone: 'UTC',
    });
    const deadId = callJson<{ schedule: { id: string } }>(created.body).schedule.id;
    await callTool(app, a.key, 'unschedule_todo', { teamId: a.teamId, scheduleId: deadId });
    const live = await callTool(app, a.key, 'schedule_todo', {
      teamId: a.teamId, todoId, kind: 'daily', cron: '09:45', timezone: 'UTC',
    });
    const liveId = callJson<{ schedule: { id: string } }>(live.body).schedule.id;

    const res = await callTool(app, a.key, 'schedules', { teamId: a.teamId });
    assert.equal(res.body.result?.isError, undefined, callText(res.body));
    const rows = callJson<{ schedules: Array<{ id: string }> }>(res.body).schedules;
    assert.deepEqual(rows.map((r) => r.id), [liveId], '已软删的规则不该出现在列表里');
  });

  test('schedules 读别人的团队 → 403，且不返回他的数据', async () => {
    const a = await seedFixture(sql, { label: 'ls2a', scopes: ['tool:schedules'] });
    const b = await seedFixture(sql, {
      label: 'ls2b', scopes: ['tool:schedule_todo', 'tool:schedules'],
    });
    fixtures.push(a, b);
    const bTodo = await seedTodo(sql, b);
    await callTool(app, b.key, 'schedule_todo', {
      teamId: b.teamId, todoId: bTodo, kind: 'daily', cron: '09:00', timezone: 'UTC',
    });

    const res = await callTool(app, a.key, 'schedules', { teamId: b.teamId });
    assert.equal(res.body.result?.isError, true);
    assert.match(callText(res.body), /is not accessible to this key's owner/);
    assert.ok(!callText(res.body).includes('09:00'), '被拒时不能带出别人团队的规则内容');
  });

  test('conversation 读 build 对话：按 seq 升序', async () => {
    const a = await seedFixture(sql, { label: 'cv1', scopes: ['tool:conversation'] });
    fixtures.push(a);
    const todoId = await seedTodo(sql, a);
    const agentId = await seedAgent(sql, a);
    const buildId = await seedBuild(sql, a, todoId, agentId);
    // seedBuild 已写了一条 seq=1 的 user 消息；补两条让排序与增量都有意义
    const ts = now();
    await sql`
      insert into "build_message" (id, build_id, role, content, seq, is_error, created_at)
      values
        (${buildId + '-m2'}, ${buildId}, 'assistant', '第二条', 2, false, ${ts}),
        (${buildId + '-m3'}, ${buildId}, 'user', '第三条', 3, false, ${ts})
    `;

    const res = await callTool(app, a.key, 'conversation', { buildId });
    assert.equal(res.body.result?.isError, undefined, callText(res.body));
    const out = callJson<{ buildId: string; messages: Array<{ seq: number }> }>(res.body);
    assert.equal(out.buildId, buildId);
    assert.deepEqual(out.messages.map((m) => m.seq), [1, 2, 3]);
  });

  test('conversation 的 sinceSeq 只回增量', async () => {
    const a = await seedFixture(sql, { label: 'cv2', scopes: ['tool:conversation'] });
    fixtures.push(a);
    const todoId = await seedTodo(sql, a);
    const agentId = await seedAgent(sql, a);
    const buildId = await seedBuild(sql, a, todoId, agentId);
    const ts = now();
    await sql`
      insert into "build_message" (id, build_id, role, content, seq, is_error, created_at)
      values (${buildId + '-m2'}, ${buildId}, 'assistant', '第二条', 2, false, ${ts})
    `;

    const res = await callTool(app, a.key, 'conversation', { buildId, sinceSeq: 1 });
    const out = callJson<{ messages: Array<{ seq: number }> }>(res.body);
    assert.deepEqual(out.messages.map((m) => m.seq), [2], 'sinceSeq 之后的消息不该被重发');
  });

  test('conversation 读别的团队的 build → 403，且不泄露任何消息', async () => {
    const a = await seedFixture(sql, { label: 'cv3a', scopes: ['tool:conversation'] });
    const b = await seedFixture(sql, { label: 'cv3b', scopes: ['tool:conversation'] });
    fixtures.push(a, b);
    const bTodo = await seedTodo(sql, b);
    const bAgent = await seedAgent(sql, b);
    const bBuild = await seedBuild(sql, b, bTodo, bAgent);

    const res = await callTool(app, a.key, 'conversation', { buildId: bBuild });
    assert.equal(res.body.result?.isError, true);
    assert.match(callText(res.body), /is not accessible to this key's owner/);
    assert.ok(!callText(res.body).includes('hello'), '被拒时不能带出任何消息内容');
  });

  test('conversation 读不存在的 build → 403（不泄露存在性）', async () => {
    const a = await seedFixture(sql, { label: 'cv4', scopes: ['tool:conversation'] });
    fixtures.push(a);

    const res = await callTool(app, a.key, 'conversation', { buildId: newId() });
    assert.equal(res.body.result?.isError, true);
    assert.match(callText(res.body), /conversation has no accessible team/);
  });

  test('conversation 缺 buildId 是入参错误', async () => {
    const a = await seedFixture(sql, { label: 'cv5', scopes: ['tool:conversation'] });
    fixtures.push(a);

    const res = await callTool(app, a.key, 'conversation', {});
    assert.equal(res.body.result?.isError, true);
    assert.match(callText(res.body), /invalid arguments/);
  });

  test('工具面未变：31 个里的新工具照 scope 列出，不存在的工具名回「不存在」', async () => {
    const a = await seedFixture(sql, {
      label: 'cnt1',
      scopes: ['tool:schedules', 'tool:schedule_todo', 'tool:unschedule_todo', 'tool:conversation', 'tool:run_review'],
    });
    fixtures.push(a);

    const list = await rpc(app, a.key, { jsonrpc: '2.0', id: 3, method: 'tools/list' });
    // tools/list 的回包是 JSON-RPC envelope（不是 tool envelope）—— callJson
    // 取的是 result.content[0].text，这里要直接读 body.result.tools。
    const names = ((list.body as { result?: { tools?: Array<{ name: string }> } }).result?.tools ?? [])
      .map((t) => t.name);
    assert.deepEqual(
      [...names].sort(),
      ['conversation', 'run_review', 'schedule_todo', 'schedules', 'unschedule_todo'],
      'tools/list 仍只列 key 被授权的工具',
    );

    // 「已授权但未实现」这个类别现在**不存在了**（31 个全部接线，2026-10-17）。
    // 未知工具名在授权层就被 -32002 挡下（措辞「does not exist」而非「not implemented」）。
    const b = await seedFixture(sql, { label: 'cnt1-nosuch', scopes: ['tool:write'] });
    fixtures.push(b);
    const res = await callTool(app, b.key, 'definitely_not_a_tool', {});
    assert.equal(res.body.error?.code, -32002);
    assert.match(res.body.error?.message ?? '', /does not exist on this MCP server/);
  });


  // ── 凭据类（secrets / connections）：写阅契约 + admin 闸门 ────────

  test('set_secret 落库为密文，回包不含明文', async () => {
    const a = await seedFixture(sql, { label: 'sec1', scopes: ['tool:set_secret', 'tool:secrets'] });
    fixtures.push(a);

    const res = await callTool(app, a.key, 'set_secret', {
      teamId: a.teamId, name: 'STRIPE_API_KEY', value: 'sk_live_do_not_leak', description: 'Stripe',
    });
    assert.equal(res.body.result?.isError, undefined, callText(res.body));
    const text = callText(res.body);
    assert.ok(!text.includes('sk_live_do_not_leak'), `回包泄露了明文：${text}`);
    assert.ok(!text.includes('encValue'), `回包带出了密文字段：${text}`);

    const rows = await sql<{ name: string; enc_value: string; description: string | null }[]>`
      select name, enc_value, description from "secret" where team_id = ${a.teamId}
    `;
    assert.equal(rows.length, 1, callText(res.body));
    assert.equal(rows[0]?.name, 'STRIPE_API_KEY');
    assert.ok(!rows[0]?.enc_value.includes('sk_live_do_not_leak'), '库里也不该有明文');
    assert.ok((rows[0]?.enc_value.length ?? 0) > 20, 'enc_value 必须是密文');
  });

  test('set_secret 读回只含名称与描述（写阅契约）', async () => {
    const a = await seedFixture(sql, { label: 'sec2', scopes: ['tool:set_secret', 'tool:secrets'] });
    fixtures.push(a);
    await callTool(app, a.key, 'set_secret', {
      teamId: a.teamId, name: 'DEPLOY_TOKEN', value: 'plaintext-token', description: '部署用',
    });

    const res = await callTool(app, a.key, 'secrets', { teamId: a.teamId });
    const text = callText(res.body);
    assert.ok(!text.includes('plaintext-token'), 'secrets 读接口绝不能返回值');
    const rows = callJson<{ secrets: Array<{ name: string; description: string | null }> }>(res.body).secrets;
    assert.deepEqual(rows.map((s) => s.name), ['DEPLOY_TOKEN']);
    assert.equal(rows[0]?.description, '部署用');
  });

  test('set_secret 名字不合规被拒且不写库', async () => {
    const a = await seedFixture(sql, { label: 'sec3', scopes: ['tool:set_secret'] });
    fixtures.push(a);

    const res = await callTool(app, a.key, 'set_secret', {
      teamId: a.teamId, name: 'lowercase-bad', value: 'v',
    });
    assert.equal(res.body.result?.isError, true);
    assert.match(callText(res.body), /invalid secret name/);
    const rows = await sql<{ c: number }[]>`select count(*)::int as c from "secret" where team_id = ${a.teamId}`;
    assert.equal(rows[0]?.c, 0);
  });

  test('set_secret 同名不带 overwrite → 409，且旧值不变', async () => {
    const a = await seedFixture(sql, { label: 'sec4', scopes: ['tool:set_secret'] });
    fixtures.push(a);
    await callTool(app, a.key, 'set_secret', { teamId: a.teamId, name: 'API_KEY', value: 'first-value' });

    const res = await callTool(app, a.key, 'set_secret', { teamId: a.teamId, name: 'API_KEY', value: 'second-value' });
    assert.equal(res.body.result?.isError, true);
    assert.match(callText(res.body), /already exists/);

    const rows = await sql<{ enc_value: string }[]>`
      select enc_value from "secret" where team_id = ${a.teamId} and name = 'API_KEY'
    `;
    assert.equal(rows.length, 1);
    assert.ok(!rows[0]?.enc_value.includes('second-value'), '被拒时旧值必须保持不变');
  });

  test('set_secret 显式 overwrite → 覆盖成功且仍不回明文', async () => {
    const a = await seedFixture(sql, { label: 'sec5', scopes: ['tool:set_secret'] });
    fixtures.push(a);
    await callTool(app, a.key, 'set_secret', { teamId: a.teamId, name: 'API_KEY', value: 'first-value' });

    const res = await callTool(app, a.key, 'set_secret', {
      teamId: a.teamId, name: 'API_KEY', value: 'second-value', overwrite: true,
    });
    assert.equal(res.body.result?.isError, undefined, callText(res.body));
    assert.ok(!callText(res.body).includes('second-value'));
    const rows = await sql<{ enc_value: string }[]>`
      select enc_value from "secret" where team_id = ${a.teamId} and name = 'API_KEY'
    `;
    assert.equal(rows.length, 1, '覆盖不该新建一行');
    assert.ok(!rows[0]?.enc_value.includes('first-value'), '旧密文必须被换掉');
  });

  test('set_secret project scope 但 projectId 不属于该团队 → 拒绝且不写库', async () => {
    const a = await seedFixture(sql, { label: 'sec6a', scopes: ['tool:set_secret'] });
    const b = await seedFixture(sql, { label: 'sec6b', scopes: ['tool:set_secret'] });
    fixtures.push(a, b);

    const res = await callTool(app, a.key, 'set_secret', {
      teamId: a.teamId, name: 'DB_URL', value: 'postgres://x', scope: 'project', projectId: b.projectId,
    });
    assert.equal(res.body.result?.isError, true);
    const rows = await sql<{ c: number }[]>`select count(*)::int as c from "secret" where team_id = ${a.teamId}`;
    assert.equal(rows[0]?.c, 0, '跨团队的 projectId 不能建出 secret');
  });

  test('set_secret 跨团队拒绝且不写库', async () => {
    const a = await seedFixture(sql, { label: 'sec7a', scopes: ['tool:set_secret'] });
    const b = await seedFixture(sql, { label: 'sec7b', scopes: ['tool:set_secret'] });
    fixtures.push(a, b);

    const res = await callTool(app, a.key, 'set_secret', { teamId: b.teamId, name: 'X_KEY', value: 'v' });
    assert.equal(res.body.result?.isError, true);
    assert.match(callText(res.body), /is not accessible to this key's owner/);
    const rows = await sql<{ c: number }[]>`select count(*)::int as c from "secret" where team_id = ${b.teamId}`;
    assert.equal(rows[0]?.c, 0);
  });

  test('set_secret 需要 admin：member 角色被 -32002 挡，且一行都没写', async () => {
    const a = await seedFixture(sql, { label: 'sec8', scopes: ['tool:set_secret'] });
    fixtures.push(a);
    await sql`update "member" set role = 'member' where id = ${a.memberId}`;

    const res = await callTool(app, a.key, 'set_secret', { teamId: a.teamId, name: 'X_KEY', value: 'v' });
    // 凭据类工具在 case 之前就被 `chiefHandlesSecret` 那道闸门拦下（docs/mcp.md：
    // 「all of these need the key's owner to be a team admin」），回的是 JSON-RPC
    // error -32002，不是 tool isError envelope。
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.error?.code, -32002, JSON.stringify(res.body));
    assert.match(res.body.error?.message ?? '', /team admin/);
    const rows = await sql<{ c: number }[]>`select count(*)::int as c from "secret" where team_id = ${a.teamId}`;
    assert.equal(rows[0]?.c, 0);
  });

  test('set_secret 的 per-team admin 闸门：在别的团队是 admin 不算数', async () => {
    // 闸门顺序：`chiefHandlesSecret` 只问「任意团队是不是 admin」（owner 确实是 admin，
    // 放行），真正的 per-team 判定在 case 里 —— 目标团队是 member 就必须被拒。
    // 这一条钉的就是这个分层：owner 在 A 团队当 admin，不能因此写 B 团队的凭据。
    const a = await seedFixture(sql, { label: 'sec8b', scopes: ['tool:set_secret'] });
    const b = await seedFixture(sql, { label: 'sec8c', scopes: ['tool:set_secret'] });
    fixtures.push(a, b);
    // a 的 owner 在 a 团队保持 admin；b 团队里塞一个同 actor 的 member 行（role=member）
    await sql`
      insert into "member" (id, team_id, actor_id, member_type, role, joined_at, v)
      values (${newId()}, ${b.teamId}, ${a.userId}, 'user', 'member', ${now()}, 0)
    `;

    const res = await callTool(app, a.key, 'set_secret', { teamId: b.teamId, name: 'X_KEY', value: 'v' });
    assert.equal(res.body.result?.isError, true, JSON.stringify(res.body));
    assert.match(callText(res.body), /managing secrets requires team admin/);
    const rows = await sql<{ c: number }[]>`select count(*)::int as c from "secret" where team_id = ${b.teamId}`;
    assert.equal(rows[0]?.c, 0, '非 admin 团队不能建出 secret');
  });

  test('delete_secrets 按 scope + names 删，删不存在的整条失败', async () => {
    const a = await seedFixture(sql, { label: 'sec9', scopes: ['tool:set_secret', 'tool:delete_secrets'] });
    fixtures.push(a);
    await callTool(app, a.key, 'set_secret', { teamId: a.teamId, name: 'ONE', value: 'v1' });
    await callTool(app, a.key, 'set_secret', { teamId: a.teamId, name: 'TWO', value: 'v2' });

    const bad = await callTool(app, a.key, 'delete_secrets', { teamId: a.teamId, names: ['ONE', 'NOPE'] });
    assert.equal(bad.body.result?.isError, true);
    assert.match(callText(bad.body), /secret not found in this scope/);
    const after = await sql<{ c: number }[]>`select count(*)::int as c from "secret" where team_id = ${a.teamId}`;
    assert.equal(after[0]?.c, 2, '部分找不到时不该删掉已找到的那条');

    const ok = await callTool(app, a.key, 'delete_secrets', { teamId: a.teamId, names: ['ONE', 'TWO'] });
    assert.equal(ok.body.result?.isError, undefined, callText(ok.body));
    const rows = await sql<{ c: number }[]>`select count(*)::int as c from "secret" where team_id = ${a.teamId}`;
    assert.equal(rows[0]?.c, 0);
  });

  test('delete_secrets 跨团队拒绝，且对方的 secret 还在', async () => {
    const a = await seedFixture(sql, { label: 'sec10a', scopes: ['tool:set_secret', 'tool:delete_secrets'] });
    const b = await seedFixture(sql, { label: 'sec10b', scopes: ['tool:set_secret', 'tool:delete_secrets'] });
    fixtures.push(a, b);
    await callTool(app, b.key, 'set_secret', { teamId: b.teamId, name: 'KEEP', value: 'v' });

    const res = await callTool(app, a.key, 'delete_secrets', { teamId: b.teamId, names: ['KEEP'] });
    assert.equal(res.body.result?.isError, true);
    assert.match(callText(res.body), /is not accessible to this key's owner/);
    const rows = await sql<{ c: number }[]>`select count(*)::int as c from "secret" where team_id = ${b.teamId}`;
    assert.equal(rows[0]?.c, 1, '被拒时对方的 secret 必须完好');
  });

  test('secrets 读名称是只读操作：member 角色也能调（与 Chief 侧 needsAdminGrant 一致）', async () => {
    // 文档：「Adding, updating, and deleting secrets requires team admin permission;
    // regular members can see the names and descriptions.」
    // chief/tools.ts 那边用 `needsAdminGrant` 表达了这件事（secrets 标 false）。
    const a = await seedFixture(sql, { label: 'sec-read', scopes: ['tool:set_secret', 'tool:secrets'] });
    fixtures.push(a);
    await callTool(app, a.key, 'set_secret', { teamId: a.teamId, name: 'VISIBLE', value: 'v' });
    await sql`update "member" set role = 'member' where id = ${a.memberId}`;

    const res = await callTool(app, a.key, 'secrets', { teamId: a.teamId });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.error, undefined, '只读不该被 -32002 挡');
    assert.equal(res.body.result?.isError, undefined, callText(res.body));
    const rows = callJson<{ secrets: Array<{ name: string }> }>(res.body).secrets;
    assert.deepEqual(rows.map((s) => s.name), ['VISIBLE']);
  });

  test('secrets 读别人的团队 → 403，且不带出任何名称', async () => {
    const a = await seedFixture(sql, { label: 'sec11a', scopes: ['tool:secrets'] });
    const b = await seedFixture(sql, { label: 'sec11b', scopes: ['tool:set_secret', 'tool:secrets'] });
    fixtures.push(a, b);
    await callTool(app, b.key, 'set_secret', { teamId: b.teamId, name: 'PRIVATE_NAME', value: 'v' });

    const res = await callTool(app, a.key, 'secrets', { teamId: b.teamId });
    assert.equal(res.body.result?.isError, true);
    assert.ok(!callText(res.body).includes('PRIVATE_NAME'), '被拒时不能带出别人的 secret 名称');
  });

  test('add_mcp_server 建连接：凭据只回键名，库里是密文', async () => {
    const a = await seedFixture(sql, { label: 'cx1', scopes: ['tool:add_mcp_server', 'tool:mcp_servers'] });
    fixtures.push(a);

    const res = await callTool(app, a.key, 'add_mcp_server', {
      teamId: a.teamId,
      identifier: 'internal-api',
      label: 'Internal API',
      transport: 'http',
      endpoint: 'https://mcp.example.test/mcp',
      config: { Authorization: 'Bearer super-secret-token' },
    });
    assert.equal(res.body.result?.isError, undefined, callText(res.body));
    const text = callText(res.body);
    assert.ok(!text.includes('super-secret-token'), `回包泄露了凭据：${text}`);
    assert.ok(text.includes('configKeys'), '编辑回显需要键名');

    const rows = await sql<{ identifier: string; enc_config: string | null }[]>`
      select identifier, enc_config from "connection" where team_id = ${a.teamId}
    `;
    assert.equal(rows[0]?.identifier, 'internal-api');
    assert.ok(!((rows[0]?.enc_config ?? '')).includes('super-secret-token'), '库里也必须是密文');
  });

  test('add_mcp_server identifier 重复 → 409，且不新建', async () => {
    const a = await seedFixture(sql, { label: 'cx2', scopes: ['tool:add_mcp_server'] });
    fixtures.push(a);
    const args = {
      teamId: a.teamId, identifier: 'dup', label: 'Dup', transport: 'http', endpoint: 'https://x.test/mcp',
    };
    assert.equal((await callTool(app, a.key, 'add_mcp_server', args)).body.result?.isError, undefined);

    const res = await callTool(app, a.key, 'add_mcp_server', { ...args, label: 'Dup2' });
    assert.equal(res.body.result?.isError, true);
    assert.match(callText(res.body), /already used by connection/);
    const rows = await sql<{ c: number }[]>`select count(*)::int as c from "connection" where team_id = ${a.teamId}`;
    assert.equal(rows[0]?.c, 1, '冲突时不该多建一行');
  });

  test('add_mcp_server http 缺 endpoint 被拒且不写库', async () => {
    const a = await seedFixture(sql, { label: 'cx3', scopes: ['tool:add_mcp_server'] });
    fixtures.push(a);

    const res = await callTool(app, a.key, 'add_mcp_server', {
      teamId: a.teamId, identifier: 'no-endpoint', label: 'X', transport: 'http',
    });
    assert.equal(res.body.result?.isError, true);
    assert.match(callText(res.body), /requires an endpoint URL/);
    const rows = await sql<{ c: number }[]>`select count(*)::int as c from "connection" where team_id = ${a.teamId}`;
    assert.equal(rows[0]?.c, 0);
  });

  test('add_mcp_server 需要 admin：member 角色被 -32002 挡，且一行都没写', async () => {
    const a = await seedFixture(sql, { label: 'cx4', scopes: ['tool:add_mcp_server'] });
    fixtures.push(a);
    await sql`update "member" set role = 'member' where id = ${a.memberId}`;

    const res = await callTool(app, a.key, 'add_mcp_server', {
      teamId: a.teamId, identifier: 'm', label: 'M', transport: 'http', endpoint: 'https://x.test/mcp',
    });
    // 同 set_secret：`handlesSecret` 闸门在 case 之前，回 JSON-RPC error
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.error?.code, -32002, JSON.stringify(res.body));
    const rows = await sql<{ c: number }[]>`select count(*)::int as c from "connection" where team_id = ${a.teamId}`;
    assert.equal(rows[0]?.c, 0);
  });

  test('update_mcp_server 按键合并凭据：没传的键保留', async () => {
    const a = await seedFixture(sql, { label: 'cx5', scopes: ['tool:add_mcp_server', 'tool:update_mcp_server'] });
    fixtures.push(a);
    const created = await callTool(app, a.key, 'add_mcp_server', {
      teamId: a.teamId, identifier: 'merge-me', label: 'M', transport: 'http', endpoint: 'https://x.test/mcp',
      config: { Authorization: 'token-a', 'X-Extra': 'keep-me' },
    });
    const connectionId = callJson<{ connection: { id: string } }>(created.body).connection.id;

    const res = await callTool(app, a.key, 'update_mcp_server', {
      teamId: a.teamId, connectionId, config: { Authorization: 'token-b' },
    });
    assert.equal(res.body.result?.isError, undefined, callText(res.body));
    const text = callText(res.body);
    assert.ok(!text.includes('token-b'), `回包泄露了凭据：${text}`);
    // 「没传的键保留」是外部可观测的：整体替换会让 X-Extra 消失
    const keys = callJson<{ connection: { configKeys: string[] } }>(res.body).connection.configKeys;
    assert.deepEqual(keys, ['Authorization', 'X-Extra'], '没传的键不该消失');

    const after = await sql<{ enc_config: string | null }[]>`
      select enc_config from "connection" where team_id = ${a.teamId}
    `;
    assert.equal(after.length, 1, '更新不该新建一行');
    const cipher = after[0]?.enc_config ?? '';
    assert.ok(!cipher.includes('token-b') && !cipher.includes('token-a'), '库里仍是密文');
  });

  test('add_mcp_server 超过 20 条上限被拒（第 21 条）', async () => {
    const a = await seedFixture(sql, { label: 'cx-limit', scopes: ['tool:add_mcp_server'] });
    fixtures.push(a);
    const ts = now();
    // 直接批量种 20 条：配额边界要测的是「判定」，不是「建 20 次」的往返
    await sql`
      insert into "connection"
        (id, team_id, kind, identifier, transport, label, endpoint, created_by, created_at)
      select md5(${a.teamId} || gs::text), ${a.teamId}, 'custom', 'bulk-' || gs::text,
        'http', 'bulk ' || gs::text, 'https://x.test/mcp', ${a.userId}, ${ts}
      from generate_series(1, 20) gs
    `;

    const res = await callTool(app, a.key, 'add_mcp_server', {
      teamId: a.teamId, identifier: 'one-too-many', label: 'X', transport: 'http',
      endpoint: 'https://x.test/mcp',
    });
    assert.equal(res.body.result?.isError, true, callText(res.body));
    const rows = await sql<{ c: number }[]>`
      select count(*)::int as c from "connection"
      where team_id = ${a.teamId} and deleted_at is null
    `;
    assert.equal(rows[0]?.c, 20, '被拒时库里不能多出第 21 条');
  });

  test('delete_mcp_servers 软删后不再出现在列表里', async () => {
    const a = await seedFixture(sql, {
      label: 'cx6', scopes: ['tool:add_mcp_server', 'tool:delete_mcp_servers', 'tool:mcp_servers'],
    });
    fixtures.push(a);
    await callTool(app, a.key, 'add_mcp_server', {
      teamId: a.teamId, identifier: 'bye', label: 'Bye', transport: 'stdio',
    });

    const res = await callTool(app, a.key, 'delete_mcp_servers', { teamId: a.teamId, identifiers: ['bye'] });
    assert.equal(res.body.result?.isError, undefined, callText(res.body));

    const rows = await sql<{ deleted_at: number | null }[]>`
      select deleted_at from "connection" where team_id = ${a.teamId} and identifier = 'bye'
    `;
    assert.ok(rows[0]?.deleted_at, 'deleted_at 必须被打上（soft-delete）');

    const list = await callTool(app, a.key, 'mcp_servers', { teamId: a.teamId });
    assert.deepEqual(callJson<{ connections: unknown[] }>(list.body).connections, [], '软删后不该再列出');
  });

  test('delete_mcp_servers 删不存在的 → 404（不静默成功）', async () => {
    const a = await seedFixture(sql, { label: 'cx7', scopes: ['tool:delete_mcp_servers'] });
    fixtures.push(a);

    const res = await callTool(app, a.key, 'delete_mcp_servers', { teamId: a.teamId, identifiers: ['nope'] });
    assert.equal(res.body.result?.isError, true);
    assert.match(callText(res.body), /404: connection not found/);
  });

  test('delete_mcp_servers 跨团队拒绝，且对方的连接没被软删', async () => {
    const a = await seedFixture(sql, {
      label: 'cx8a', scopes: ['tool:add_mcp_server', 'tool:delete_mcp_servers'],
    });
    const b = await seedFixture(sql, {
      label: 'cx8b', scopes: ['tool:add_mcp_server', 'tool:delete_mcp_servers'],
    });
    fixtures.push(a, b);
    await callTool(app, b.key, 'add_mcp_server', {
      teamId: b.teamId, identifier: 'keepme', label: 'K', transport: 'http', endpoint: 'https://x.test/mcp',
    });

    const res = await callTool(app, a.key, 'delete_mcp_servers', { teamId: b.teamId, identifiers: ['keepme'] });
    assert.equal(res.body.result?.isError, true);
    assert.match(callText(res.body), /is not accessible to this key's owner/);
    const rows = await sql<{ deleted_at: number | null }[]>`
      select deleted_at from "connection" where team_id = ${b.teamId}
    `;
    assert.equal(rows[0]?.deleted_at, null, '被拒时对方的连接不能被软删');
  });

  test('mcp_servers 读别人的团队 → 403', async () => {
    const a = await seedFixture(sql, { label: 'cx9a', scopes: ['tool:mcp_servers'] });
    const b = await seedFixture(sql, { label: 'cx9b', scopes: ['tool:add_mcp_server', 'tool:mcp_servers'] });
    fixtures.push(a, b);
    await callTool(app, b.key, 'add_mcp_server', {
      teamId: b.teamId, identifier: 'private', label: 'P', transport: 'http', endpoint: 'https://x.test/mcp',
    });

    const res = await callTool(app, a.key, 'mcp_servers', { teamId: b.teamId });
    assert.equal(res.body.result?.isError, true);
    assert.ok(!callText(res.body).includes('private'), '被拒时不能带出别人的连接');
  });

});
