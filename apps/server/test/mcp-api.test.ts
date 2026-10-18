import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify from 'fastify';
import * as dbPkg from '@tds/db';
import { newId, now } from '../src/ids.js';
import { hashApiKey, generateApiKey } from '../src/crypto.js';
import { registerMcpRoutes } from '../src/routes/mcp.js';
import { mcpToolNames } from '../src/mcp-tools.js';
import { registerUserRoutes } from '../src/routes/user.js';

/**
 * MCP 入站端点的端到端验证。
 *
 * 必须覆盖（acceptance 提炼）：
 *   - 无效 key → 401
 *   - tools/list 只返回授权工具
 *   - tools/call 调未授权工具被拒
 *   - 凭据类工具要求 admin
 *   - 读类工具返回真实 DB 数据
 *
 * 设计要点：
 *   - 真实 PostgreSQL + app.inject
 *   - API key 直接 insert 到 api_key 表，控制 scopes/owner name/角色
 *   - 每个测试独立 fixture，after 兜底反序清理
 *
 * 文档/契约出处：
 *   recon/docs/mcp.md
 *   recon/docs/api-keys.md
 *   clone/CONTRACT.md
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://tds:tds_local_dev@127.0.0.1:5433/tds';

interface Fixture {
  label: string;
  userId: string;
  teamId: string;
  projectId: string;
  memberId: string;
  agentId: string;
  machineId: string;
}

interface Key {
  /** plaintext key string, starts with 'tds_' */
  key: string;
  prefix: string;
  hash: string;
}

interface SeedOptions {
  label: string;
  /** 'admin' 才能调凭据类；'member' 则被挡 */
  memberRole: 'admin' | 'member';
  /** 给 api_key 装的 scopes */
  scopes: string[];
}

interface Seeded extends Fixture {
  key: Key;
}

function buildTestApp(
  db: ReturnType<typeof drizzle<typeof dbPkg.schema>>,
): ReturnType<typeof Fastify> {
  const app = Fastify({ logger: false });
  app.decorate('machineUrl', 'http://test');
  registerMcpRoutes(app, db as never);
  registerUserRoutes(app, db as never);
  return app;
}

async function seedFixture(
  sql: postgres.Sql,
  opts: SeedOptions,
): Promise<Seeded> {
  const ts = now();
  const userId = newId();
  const teamId = newId();
  const memberId = newId();
  const agentId = newId();
  const projectId = newId();
  const machineId = newId();

  await sql`
    insert into "user"
      (id, email, display_name, status, locale, created_at, updated_at)
    values
      (${userId}, ${`${opts.label}-${userId}@test.local`}, ${opts.label}, 'active', 'en', ${ts}, ${ts})
  `;
  await sql`
    insert into "team"
      (id, name, plan, storage_quota, created_at)
    values
      (${teamId}, ${opts.label}, 'free', 1073741824, ${ts})
  `;
  await sql`
    insert into "member"
      (id, team_id, actor_id, member_type, role, joined_at, v)
    values
      (${memberId}, ${teamId}, ${userId}, 'user', ${opts.memberRole}, ${ts}, 0)
  `;
  await sql`
    insert into "agent"
      (id, team_id, display_name, default_skill_ids, grants, active_task_count, created_at, updated_at)
    values
      (${agentId}, ${teamId}, ${opts.label}, '{}', '{}'::jsonb, 0, ${ts}, ${ts})
  `;
  await sql`
    insert into "project"
      (id, team_id, name, provider, repo_kind, default_branch, next_seq_num, created_at)
    values
      (${projectId}, ${teamId}, ${opts.label}, 'external', 'other', 'main', 1, ${ts})
  `;
  await sql`
    insert into "machine"
      (id, team_id, name, device_id, enrolled_by, build_enabled, shell_enabled,
       max_concurrent_tasks, runtimes, disabled_runtimes, workspaces_dir,
       is_online, last_heartbeat_at, created_at, updated_at)
    values
      (${machineId}, ${teamId}, 'm', ${'dev-' + machineId}, ${userId}, true, false, 6,
       ${['pi']}, ${[]}, '/ws', true, ${ts}, ${ts}, ${ts})
  `;

  // 生成 api_key 并入库 —— kek 取默认 (开发 KEK)
  const key = generateApiKey();
  await sql`
    insert into "api_key"
      (id, user_id, name, key_prefix, key_hash, scopes, created_at)
    values
      (${newId()}, ${userId}, ${'mcp-test-' + opts.label},
       ${key.prefix}, ${key.hash}, ${opts.scopes}, ${ts})
  `;

  return {
    label: opts.label,
    userId, teamId, projectId, memberId, agentId, machineId,
    key,
  };
}

async function seedTodoRow(
  sql: postgres.Sql,
  f: Fixture,
  phase: 'todo' | 'queued' | 'implement' = 'todo',
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
      (id, project_id, seq_num, owner_member_id, agent_id, title, tag_ids, phase,
       plan_first, separate_plan_build, with_checklist, created_at, updated_at)
    values
      (${id}, ${f.projectId}, ${seq}, ${f.memberId}, ${f.agentId},
       ${'todo of ' + f.label}, '{}', ${phase},
       true, false, false, ${ts}, ${ts})
  `;
  return id;
}

async function deleteFixture(sql: postgres.Sql, f: Fixture): Promise<void> {
  // `sse_event` / `audit_event` **完全没有 FK**（`todo` 删了它们也不会级联）——
  // 不清就是往共享库里永久堆垃圾，下一轮测试的计数断言会被上一轮污染。
  await sql`delete from "sse_event" where team_id = ${f.teamId}`;
  await sql`delete from "audit_event" where team_id = ${f.teamId}`;
  // 反序避开 FK
  await sql`delete from "todo" where project_id = ${f.projectId}`;
  // secret 挂在 team 上（project_id 可空），team 删之前先清 —— 留着会被下一轮
  // 「同名 secret 冲突」的断言喂成脏数据。
  await sql`delete from "secret" where team_id = ${f.teamId}`;
  await sql`delete from "machine" where team_id = ${f.teamId}`;
  await sql`delete from "project" where team_id = ${f.teamId}`;
  await sql`delete from "agent" where team_id = ${f.teamId}`;
  await sql`delete from "api_key" where user_id = ${f.userId}`;
  await sql`delete from "member" where team_id = ${f.teamId}`;
  await sql`delete from "team" where id = ${f.teamId}`;
  await sql`delete from "user" where id = ${f.userId}`;
}

/** 某团队的 project 条数 —— 「拒绝时不得写入」必须查库，返回值看不出来。 */
async function countProjects(sql: postgres.Sql, teamId: string): Promise<number> {
  const rows = await sql<{ c: number }[]>`
    select count(*)::int as c from "project" where team_id = ${teamId}
  `;
  return rows[0]?.c ?? 0;
}

/** 某 project 的 todo 条数 —— 「拒绝时不得写入」必须查库。 */
async function countTodos(sql: postgres.Sql, projectId: string): Promise<number> {
  const rows = await sql<{ c: number }[]>`
    select count(*)::int as c from "todo" where project_id = ${projectId}
  `;
  return rows[0]?.c ?? 0;
}

async function rpc(
  app: ReturnType<typeof Fastify>,
  key: string,
  body: Record<string, unknown>,
): Promise<{ statusCode: number; body: unknown }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/mcp',
    headers: { authorization: `Bearer ${key}` },
    payload: body,
  });
  let parsed: unknown = res.body;
  try { parsed = JSON.parse(res.body); } catch { /* keep raw */ }
  return { statusCode: res.statusCode, body: parsed };
}

// ── 测试套 ──────────────────────────────────────────────────────────

describe('MCP 入站端点', () => {
  let sql: postgres.Sql;
  let db: ReturnType<typeof drizzle<typeof dbPkg.schema>>;
  let app: ReturnType<typeof Fastify>;
  const fixtures: Fixture[] = [];

  before(async () => {
    sql = postgres(DATABASE_URL, { max: 5, idle_timeout: 20 });
    db = drizzle(sql, { schema: dbPkg.schema });
    app = buildTestApp(db);
    await app.ready();
  });

  after(async () => {
    const cleanupErrors: string[] = [];
    for (const f of fixtures) {
      // 清理失败**不许静默吞**：脏数据留在共享库里会把下一轮的计数断言喂成假绿。
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

  // ── 鉴权（HTTP 401，transport 层拒绝） ─────────────────────

  test('缺 Authorization 头 → 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/mcp', payload: { jsonrpc: '2.0', method: 'ping' } });
    assert.equal(res.statusCode, 401);
  });

  test('Authorization 形式错（不是 Bearer） → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp',
      headers: { authorization: 'Basic abc' },
      payload: { jsonrpc: '2.0', method: 'ping' },
    });
    assert.equal(res.statusCode, 401);
  });

  test('Bearer 但无 tds_ 前缀 → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp',
      headers: { authorization: 'Bearer not_a_tds_key' },
      payload: { jsonrpc: '2.0', method: 'ping' },
    });
    assert.equal(res.statusCode, 401);
  });

  test('随机伪造的 tds_ key（不在表里） → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp',
      headers: { authorization: 'Bearer tds_randomfakethisshouldneverexist' },
      payload: { jsonrpc: '2.0', method: 'ping' },
    });
    assert.equal(res.statusCode, 401);
  });

  test('已 revoke 的 key → 401', async () => {
    const fx = await seedFixture(sql, { label: 'revoked', memberRole: 'admin', scopes: ['tool:todo'] });
    fixtures.push(fx);
    await sql`update "api_key" set revoked_at = ${now()} where key_hash = ${fx.key.hash}`;
    const res = await rpc(app, fx.key.key, { jsonrpc: '2.0', method: 'ping' });
    assert.equal(res.statusCode, 401);
  });

  // ── initialize / ping ─────────────────────────────────────

test('initialize → 200 + protocolVersion / capabilities.tools', async () => {
    const fx = await seedFixture(sql, { label: 'init', memberRole: 'admin', scopes: ['tool:todo'] });
    fixtures.push(fx);
    const res = await rpc(app, fx.key.key, { jsonrpc: '2.0', id: 1, method: 'initialize' });
    assert.equal(res.statusCode, 200);
    const body = res.body as { result: { protocolVersion: string; serverInfo: { name: string }; capabilities: { tools: unknown } } };
    assert.ok(typeof body.result.protocolVersion === 'string');
    assert.equal(body.result.serverInfo.name, 'tds');
    assert.ok(body.result.capabilities.tools !== undefined, 'capabilities.tools 必须声明');
  });

  test('ping → 200 + {ok:true}', async () => {
    const fx = await seedFixture(sql, { label: 'ping', memberRole: 'admin', scopes: ['tool:todos'] });
    fixtures.push(fx);
    const res = await rpc(app, fx.key.key, { jsonrpc: '2.0', id: 7, method: 'ping' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual((res.body as { result: { ok: boolean } }).result, { ok: true });
  });

  test('未知 method → JSON-RPC error -32601，HTTP 仍 200', async () => {
    const fx = await seedFixture(sql, { label: 'unknown', memberRole: 'admin', scopes: ['tool:todos'] });
    fixtures.push(fx);
    const res = await rpc(app, fx.key.key, { jsonrpc: '2.0', id: 9, method: 'totally/not/jsonrpc/method' });
    assert.equal(res.statusCode, 200, 'transport 必须 200，错误用 JSON-RPC error');
    const body = res.body as { error: { code: number; message: string } };
    assert.equal(body.error.code, -32601);
    assert.match(body.error.message, /not supported/);
  });

  test('非 JSON-RPC envelope（缺 jsonrpc:"2.0"） → -32600', async () => {
    const fx = await seedFixture(sql, { label: 'bad-env', memberRole: 'admin', scopes: ['tool:todos'] });
    fixtures.push(fx);
    const res = await rpc(app, fx.key.key, { id: 1, method: 'ping' });
    assert.equal(res.statusCode, 200);
    const body = res.body as { error: { code: number } };
    assert.equal(body.error.code, -32600);
  });

  // ── tools/list 授权过滤 ────────────────────────────────

  test('空 scopes 的 key 打整个端点 → HTTP 403（不是 200 + -32001）', async () => {
    // docs/mcp.md 的 Errors 表：「403, no MCP access — The key has no MCP tools
    // selected. Enable MCP access and select at least one」。recon 里没有空 scope
    // key 打 `/api/mcp` 的抓包，所以按官方文档实现（此前我们回的是 200 + -32001）。
    const fx = await seedFixture(sql, { label: 'noscope', memberRole: 'admin', scopes: [] });
    fixtures.push(fx);

    for (const method of ['initialize', 'ping', 'tools/list', 'tools/call']) {
      const res = await rpc(app, fx.key.key, { jsonrpc: '2.0', id: 1, method });
      assert.equal(res.statusCode, 403, `${method} 该被 403 挡下，实际 ${res.statusCode}`);
      const body = res.body as { error: string };
      assert.match(body.error, /no MCP access/);
      assert.match(body.error, /at least one tool/);
    }

    // 有 scope 的 key 完全不受影响（403 只属于「一个工具都没勾」）
    const ok = await seedFixture(sql, {
      label: 'noscope-ok', memberRole: 'admin', scopes: ['tool:todos'],
    });
    fixtures.push(ok);
    const init = await rpc(app, ok.key.key, { jsonrpc: '2.0', id: 1, method: 'initialize' });
    assert.equal(init.statusCode, 200, '有 scope 的 key initialize 必须照常 200');
    const list = await rpc(app, ok.key.key, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.equal(list.statusCode, 200);
    assert.ok(((list.body as { result: { tools: unknown[] } }).result.tools).length >= 1);
  });

  test('tools/list 精确授权 tool:create_todo → 只列该工具', async () => {
    const fx = await seedFixture(sql, { label: 'list-exact', memberRole: 'admin', scopes: ['tool:create_todo'] });
    fixtures.push(fx);
    const res = await rpc(app, fx.key.key, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(res.statusCode, 200);
    const tools = ((res.body as { result: { tools: Array<{ name: string }> } }).result.tools).map((t) => t.name);
    assert.deepEqual(tools, ['create_todo']);
  });

  test('tools/list tool:todo（Chief 分组别名） → 只列 MCP 面内的那 12 个', async () => {
    const fx = await seedFixture(sql, { label: 'list-group', memberRole: 'admin', scopes: ['tool:todo'] });
    fixtures.push(fx);
    const res = await rpc(app, fx.key.key, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const tools = ((res.body as { result: { tools: Array<{ name: string }> } }).result.tools).map((t) => t.name);
    // Chief 的 `todo` 组有 14 个，MCP 面上只剩 12 —— `delete_todos` 与
    // `relay_question` 是 Chief 专属（recon §8 的 31 里没有它们）。
    const mcpTodoGroup = [
      'create_todo', 'update_todo', 'todos', 'complete_todos', 'close_todos',
      'reopen_todos', 'merge_builds', 'cancel_builds', 'confirm_builds',
      'run_builds', 'run_review', 'message_todo',
    ];
    assert.deepEqual([...tools].sort(), [...mcpTodoGroup].sort(),
      '分组别名只能授到 MCP 面上的工具');
    assert.ok(!tools.includes('projects'), '其它分组不能漏出');
  });

  test('tools/list 多个 scope（精确 + 分组）→ 并集且无重复', async () => {
    const fx = await seedFixture(sql, { label: 'list-mix', memberRole: 'admin', scopes: ['tool:todo', 'tool:projects'] });
    fixtures.push(fx);
    const res = await rpc(app, fx.key.key, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const tools = ((res.body as { result: { tools: Array<{ name: string }> } }).result.tools).map((t) => t.name);
    const set = new Set(tools);
    assert.equal(set.size, tools.length, '无重复');
    assert.ok(tools.includes('create_todo'));
    assert.ok(tools.includes('projects'));
  });

  test('tools/list 返回的每个工具有 name/description/inputSchema', async () => {
    const fx = await seedFixture(sql, { label: 'list-shape', memberRole: 'admin', scopes: ['tool:todo'] });
    fixtures.push(fx);
    const res = await rpc(app, fx.key.key, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const tool = ((res.body as { result: { tools: Array<{ name: string; description: string; inputSchema: { type: string } }> } }).result.tools)[0]!;
    assert.equal(typeof tool.name, 'string');
    assert.equal(typeof tool.description, 'string');
    assert.equal(tool.inputSchema.type, 'object');
  });

  test('tools/list tool:read / tool:write（MCP 自己的分组） → 13 / 18', async () => {
    // recon/03-app-api.md §8：`group` 就是 key 勾选 UI 的粒度，所以 `tool:read`
    // 与 `tool:write` 必须是可授的分组 scope，且数量对得上（13 / 18 = 31）。
    const r = await seedFixture(sql, { label: 'list-read', memberRole: 'admin', scopes: ['tool:read'] });
    const w = await seedFixture(sql, { label: 'list-write', memberRole: 'admin', scopes: ['tool:write'] });
    fixtures.push(r, w);

    const namesOf = async (key: string): Promise<string[]> => {
      const res = await rpc(app, key, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      assert.equal(res.statusCode, 200);
      return ((res.body as { result: { tools: Array<{ name: string }> } }).result.tools).map((t) => t.name);
    };

    const readNames = await namesOf(r.key.key);
    const writeNames = await namesOf(w.key.key);
    assert.equal(readNames.length, 13, `read 组应为 13，实际 ${readNames.length}`);
    assert.equal(writeNames.length, 18, `write 组应为 18，实际 ${writeNames.length}`);
    assert.ok(readNames.includes('secrets') && !readNames.includes('set_secret'),
      'secrets 在 read 组、set_secret 在 write 组（recon §8 的读写分离）');
    assert.deepEqual(new Set([...readNames, ...writeNames]), new Set(mcpToolNames()),
      'read ∪ write 必须恰好等于 MCP 的 31');
  });

  test('全授权 key → tools/list 恰好 31，且与 `src/mcp-tools.ts` 同源', async () => {
    const fx = await seedFixture(sql, {
      label: 'list-all', memberRole: 'admin',
      scopes: ['tool:read', 'tool:write', 'tool:delete_todos', 'tool:create_project', 'tool:update_project'],
    });
    fixtures.push(fx);
    const res = await rpc(app, fx.key.key, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const tools = ((res.body as { result: { tools: Array<{ name: string }> } }).result.tools);
    const names = tools.map((t) => t.name);
    assert.equal(tools.length, 31, `全授权 key 应列出 31 个，实际 ${tools.length}`);
    assert.equal(new Set(names).size, 31, '无重复');
    assert.deepEqual(new Set(names), new Set(mcpToolNames()), 'list 必须等于 MCP 工具表，一份清单');
    // 显式授了也不许漏出：这三个是 Chief 专属，MCP 面上「不存在」
    for (const n of ['delete_todos', 'create_project', 'update_project']) {
      assert.ok(!names.includes(n), `${n} 即使被 scope 点名也不该出现在 MCP list 里`);
    }
  });

  // ── GET /api/user/mcp-tools（Settings → API keys 的勾选目录，recon §8） ──

  test('GET /api/user/mcp-tools → 31 项、read 13 / write 18、与 tools/list 全授权集合相等', async () => {
    const fx = await seedFixture(sql, {
      label: 'catalog', memberRole: 'admin', scopes: ['tool:read', 'tool:write'],
    });
    fixtures.push(fx);
    const res = await app.inject({
      method: 'GET',
      url: '/api/user/mcp-tools',
      headers: { authorization: `Bearer ${fx.key.key}` },
    });
    assert.equal(res.statusCode, 200);
    const items = JSON.parse(res.body) as Array<{ name: string; label: string; group: string }>;
    assert.equal(items.length, 31, `目录应为 31 项，实际 ${items.length}`);
    assert.equal(items.filter((i) => i.group === 'read').length, 13, 'read 组必须 13 项');
    assert.equal(items.filter((i) => i.group === 'write').length, 18, 'write 组必须 18 项');
    for (const it of items) {
      assert.ok(typeof it.name === 'string' && it.name.length > 0);
      assert.ok(typeof it.label === 'string' && it.label.length > 0, '勾选 UI 得有 label 可显示');
      assert.ok(it.group === 'read' || it.group === 'write', `group 只能是 read/write，实际 ${it.group}`);
    }
    // 同源：目录与 `tools/list` 必须是**同一份**清单（改工具表两边一起变）
    const catalog = new Set(items.map((i) => i.name));
    assert.deepEqual(catalog, new Set(mcpToolNames()), '目录必须等于 `src/mcp-tools.ts`');
    const list = await rpc(app, fx.key.key, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const granted = new Set(
      ((list.body as { result: { tools: Array<{ name: string }> } }).result.tools).map((t) => t.name),
    );
    assert.deepEqual(catalog, granted, '目录必须等于全授权 key 的 tools/list');
  });

  test('GET /api/user/mcp-tools 鉴权：无 Bearer / 已 revoke → 401', async () => {
    const noHeader = await app.inject({ method: 'GET', url: '/api/user/mcp-tools' });
    assert.equal(noHeader.statusCode, 401);

    const fx = await seedFixture(sql, {
      label: 'catalog-revoked', memberRole: 'admin', scopes: ['tool:read'],
    });
    fixtures.push(fx);
    await sql`update "api_key" set revoked_at = ${now()} where key_hash = ${fx.key.hash}`;
    const revoked = await app.inject({
      method: 'GET',
      url: '/api/user/mcp-tools',
      headers: { authorization: `Bearer ${fx.key.key}` },
    });
    assert.equal(revoked.statusCode, 401, 'revoke 后必须即时失效（api-keys.md）');
  });

  test('Chief 有、MCP 没有的三个工具：不可见、不可调（-32002 does not exist）且库里没执行', async () => {
    const fx = await seedFixture(sql, {
      label: 'chief-only', memberRole: 'admin',
      scopes: ['tool:read', 'tool:write', 'tool:delete_todos', 'tool:create_project', 'tool:update_project'],
    });
    fixtures.push(fx);
    const todoId = await seedTodoRow(sql, fx, 'todo');
    const projectsBefore = await countProjects(sql, fx.teamId);

    const call = async (name: string, args: Record<string, unknown>) =>
      rpc(app, fx.key.key, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

    // 「不存在」而不是「未实现」：措辞必须是 does not exist
    const del = await call('delete_todos', { todoIds: [todoId] });
    assert.equal(del.statusCode, 200);
    assert.equal((del.body as { error: { code: number } }).error.code, -32002);
    assert.match((del.body as { error: { message: string } }).error.message, /does not exist/);
    const stillThere = await sql`select id from "todo" where id = ${todoId}`;
    assert.equal(stillThere.length, 1, 'delete_todos 被拒后 todo 必须还在库里');

    const created = await call('create_project', { teamId: fx.teamId, name: '不该建出来' });
    assert.equal((created.body as { error: { code: number } }).error.code, -32002);
    assert.equal(await countProjects(sql, fx.teamId), projectsBefore, 'create_project 不得写库');

    const updated = await call('update_project', { projectId: fx.projectId, name: '不该改' });
    assert.equal((updated.body as { error: { code: number } }).error.code, -32002);
    const row = await sql<{ name: string }[]>`select name from "project" where id = ${fx.projectId}`;
    assert.equal(row[0]?.name, 'chief-only', 'update_project 不得改库');
  });

  // ── T4：未预期异常不得变成 HTTP 500 ──────────────────────────────

  test('create_todo 传不存在的 agentId（真 DB 外键错误）→ HTTP 200 + JSON-RPC -32603', async () => {
    // `todo.agent_id` 有 FK（schema.ts:245）而 `create_todo` 不校验它，所以这是
    // 一条**真实**的 Postgres 错误（23503），不是模拟。修复前这里是 HTTP 500
    // `{"error":"internal error"}`，和「tools/call 永远 200」的契约自相矛盾。
    const fx = await seedFixture(sql, { label: 'boom', memberRole: 'admin', scopes: ['tool:create_todo'] });
    fixtures.push(fx);
    const before = await countTodos(sql, fx.projectId);
    const res = await rpc(app, fx.key.key, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'create_todo',
        arguments: {
          teamId: fx.teamId,
          projectId: fx.projectId,
          title: 'FK 炸',
          agentId: 'no-such-agent-id',
        },
      },
    });
    assert.equal(
      res.statusCode, 200,
      `tools/call 的失败必须回 200 + JSON-RPC error，实际 ${res.statusCode}：${res.body}`,
    );
    const body = res.body as { error?: { code: number; message: string }; result?: unknown };
    assert.ok(body.error, `必须回 JSON-RPC error，实际 ${JSON.stringify(body)}`);
    assert.equal(body.error!.code, -32603, '未预期异常用 JSON-RPC 的 internal error 码');
    // 详情只进服务端日志：客户端不能看到 SQL、驱动措辞或堆栈
    const shown = JSON.stringify(body.error).toLowerCase();
    for (const leak of ['violates', 'foreign key', 'insert into', 'duplicate key', '23503', 'at ', 'traceback']) {
      assert.ok(!shown.includes(leak), `错误里漏出了服务端细节「${leak}」：${shown}`);
    }
    // 事务必须整体回滚：不能留下半条 todo
    assert.equal(await countTodos(sql, fx.projectId), before, 'FK 失败必须回滚，不留 todo');
  });

  // ── tools/call 授权 / 闸门 ───────────────────────────────

  test('tools/call 未授权工具 → -32002 ToolNotPermitted，HTTP 仍 200', async () => {
    const fx = await seedFixture(sql, { label: 'call-unauth', memberRole: 'admin', scopes: ['tool:todo'] });
    fixtures.push(fx);
    // todo 分组有 todos（读），故意调不在 scope 里的 projects
    const res = await rpc(app, fx.key.key, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'projects', arguments: {} },
    });
    assert.equal(res.statusCode, 200);
    const body = res.body as { error: { code: number; message: string; data: unknown } };
    assert.equal(body.error.code, -32002);
    assert.match(body.error.message, /not granted/);
  });

  test('tools/call 未知工具名 → -32002', async () => {
    const fx = await seedFixture(sql, { label: 'call-unknown', memberRole: 'admin', scopes: ['tool:this_does_not_exist_xxxxx'] });
    fixtures.push(fx);
    // 注意：scopes 里有同名才能通过 isAuthorized 的第一项；但工具名不在 CHIEF_TOOLS 里同样被挡
    const res = await rpc(app, fx.key.key, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'this_does_not_exist_xxxxx', arguments: {} },
    });
    assert.equal(res.statusCode, 200);
    assert.equal((res.body as { error: { code: number } }).error.code, -32002);
  });

  test('tools/call 凭据类工具且 member 角色 → 被 admin 闸门挡', async () => {
    // set_secret handlesSecret=true 要求 admin；member 角色不能调
    const fx = await seedFixture(sql, { label: 'cred-member', memberRole: 'member', scopes: ['tool:infra'] });
    fixtures.push(fx);
    const res = await rpc(app, fx.key.key, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'set_secret', arguments: { teamId: fx.teamId, name: 'x', value: 'y' } },
    });
    assert.equal(res.statusCode, 200);
    const body = res.body as { error: { code: number; message: string } };
    assert.equal(body.error.code, -32002);
    assert.match(body.error.message, /team admin/);
  });

  test('tools/call 凭据类工具且 admin 角色 → 真落到库里（2026-10-17 薄壳后不再报未实现）', async () => {
    const fx = await seedFixture(sql, { label: 'cred-admin', memberRole: 'admin', scopes: ['tool:set_secret'] });
    fixtures.push(fx);
    const res = await rpc(app, fx.key.key, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'set_secret', arguments: { teamId: fx.teamId, name: 'X_API_KEY', value: 'super-secret' } },
    });
    // tools/call 走 MCP envelope，成功时 isError 不设置
    assert.equal(res.statusCode, 200);
    const result = (res.body as { result: { content: Array<{ text: string }>; isError?: true } }).result;
    assert.equal(result.isError, undefined, result.content[0]!.text);
    const text = result.content[0]!.text;
    // 值绝不能出现在回包里（写阅契约），但库里必须有密文
    assert.ok(!text.includes('super-secret'), `回包泄露了明文值：${text}`);
    const rows = await sql<{ c: number }[]>`
      select count(*)::int as c from "secret" where team_id = ${fx.teamId} and name = 'X_API_KEY'
    `;
    assert.equal(rows[0]?.c, 1, 'admin 调用应真的建出这一行');
  });

  // ── 读类工具真实数据 ──────────────────────────────────

  test('tools/call todos → 返回真实 DB 数据（含真实 todo id）', async () => {
    const fx = await seedFixture(sql, { label: 'todos-call', memberRole: 'admin', scopes: ['tool:todo'] });
    fixtures.push(fx);
    const realTodoId = await seedTodoRow(sql, fx, 'todo');

    const res = await rpc(app, fx.key.key, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'todos', arguments: {} },
    });
    assert.equal(res.statusCode, 200);
    const result = (res.body as { result: { content: Array<{ text: string }> } }).result;
    const parsed = JSON.parse(result.content[0]!.text) as { todos: Array<{ id: string; title: string; phase: string }> };
    assert.equal(parsed.todos.length, 1);
    assert.equal(parsed.todos[0]!.id, realTodoId);
    assert.match(parsed.todos[0]!.title, /todo of todos-call/);
    assert.equal(parsed.todos[0]!.phase, 'todo');
  });

  test('tools/call projects → 返回本团队的项目，别团队的一条都不许有', async () => {
    const fx = await seedFixture(sql, { label: 'projects-call', memberRole: 'admin', scopes: ['tool:projects'] });
    const other = await seedFixture(sql, { label: 'projects-call-other', memberRole: 'admin', scopes: ['tool:projects'] });
    fixtures.push(fx, other);
    const res = await rpc(app, fx.key.key, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'projects', arguments: {} },
    });
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse((res.body as { result: { content: Array<{ text: string }> } }).result.content[0]!.text) as { projects: Array<{ id: string; teamId: string }> };
    assert.ok(parsed.projects.some((p) => p.id === fx.projectId), '本团队的项目必须在');
    assert.equal(parsed.projects.some((p) => p.id === other.projectId), false,
      '别的团队的项目不得混进来 —— 原测试只证明「自己的在」，跨团队泄漏测不出来');
    assert.ok(parsed.projects.every((p) => p.teamId === fx.teamId), '每一项都必须属于调用者的团队');
  });

  test('tools/call agents → 真实 agent 名册 + 跨团队隔离 + 过滤 deleted_at', async () => {
    const fx = await seedFixture(sql, { label: 'agents-call', memberRole: 'admin', scopes: ['tool:agents'] });
    const other = await seedFixture(sql, { label: 'agents-call-other', memberRole: 'admin', scopes: ['tool:agents'] });
    fixtures.push(fx, other);
    // 同团队再塞一个**已软删**的 agent：`agents` 带 `deleted_at IS NULL`（mcp.ts:453），
    // 此前只有 skills 测过这条过滤。
    const deadId = newId();
    await sql`
      insert into "agent"
        (id, team_id, display_name, default_skill_ids, grants, active_task_count,
         created_at, updated_at, deleted_at)
      values (${deadId}, ${fx.teamId}, 'agents-call-dead', '{}', '{}'::jsonb, 0,
        ${now()}, ${now()}, ${now()})
    `;
    const res = await rpc(app, fx.key.key, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'agents', arguments: {} },
    });
    const parsed = JSON.parse((res.body as { result: { content: Array<{ text: string }> } }).result.content[0]!.text) as { agents: Array<{ id: string; teamId: string }> };
    assert.ok(parsed.agents.some((a) => a.id === fx.agentId), '本团队的活 agent 必须在');
    assert.equal(parsed.agents.some((a) => a.id === other.agentId), false, '别团队的 agent 不得混进来');
    assert.equal(parsed.agents.some((a) => a.id === deadId), false,
      'deleted_at 非空的 agent 必须被过滤 —— 模型会挑到已离职的 agent');
    assert.ok(parsed.agents.every((a) => a.teamId === fx.teamId), '每一项都必须属于调用者的团队');
  });

  test('tools/call machines → 真实机器名册 + isOnline + 跨团队隔离', async () => {
    const fx = await seedFixture(sql, { label: 'machines-call', memberRole: 'admin', scopes: ['tool:machines'] });
    const other = await seedFixture(sql, { label: 'machines-call-other', memberRole: 'admin', scopes: ['tool:machines'] });
    fixtures.push(fx, other);
    const real = await rpc(app, fx.key.key, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'machines', arguments: {} },
    });
    assert.equal(real.statusCode, 200);
    const parsed = JSON.parse((real.body as { result: { content: Array<{ text: string }> } }).result.content[0]!.text) as { machines: Array<{ id: string; teamId: string; isOnline: boolean }> };
    assert.ok(parsed.machines.some((m) => m.id === fx.machineId && m.isOnline === true), '本团队的在线机器必须在');
    assert.equal(parsed.machines.some((m) => m.id === other.machineId), false,
      '别的团队的机器不得混进来 —— 原测试只证明「自己的在」，跨团队泄漏测不出来');
    assert.ok(parsed.machines.every((m) => m.teamId === fx.teamId), '每一项都必须属于调用者的团队');
  });

  // ── 跨 owner 隔离（key owner 看不到别的团队的 todo） ──

  test('key owner 看不到别的 team 的 todo（跨 owner 隔离）', async () => {
    // 两个独立 fixture；mine 的 key 调 todos，应只看见 mine 的 todo
    const mine = await seedFixture(sql, { label: 'mine', memberRole: 'admin', scopes: ['tool:todo'] });
    const other = await seedFixture(sql, { label: 'other', memberRole: 'admin', scopes: ['tool:todo'] });
    fixtures.push(mine, other);
    const mineTodoId = await seedTodoRow(sql, mine, 'todo');
    await seedTodoRow(sql, other, 'todo');

    const res = await rpc(app, mine.key.key, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'todos', arguments: {} },
    });
    const parsed = JSON.parse((res.body as { result: { content: Array<{ text: string }> } }).result.content[0]!.text) as { todos: Array<{ id: string; projectId: string }> };

    // 应该只看到 mine 团队的 todo（按 projectId 过滤）
    assert.equal(parsed.todos.length, 1);
    assert.equal(parsed.todos[0]!.id, mineTodoId);
    assert.equal(parsed.todos[0]!.projectId, mine.projectId);
  });

  // ── 反例：hash 真的对才能验证 ───────────────────────────

  test('hashApiKey 对固定 KEK 的已知答案（原测试是自我一致性，等于没测）', () => {
    // 原断言 `hashApiKey('tds_abc') === hashApiKey('tds_abc')` 对**任何**确定性函数
    // 都成立 —— 把 HMAC 换成裸 sha256、换成 md5、甚至永远返回空串都照样绿。
    // 这里钉的是「HMAC-SHA256(key, kek) 的十六进制」这个具体值。
    const kek = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
    assert.equal(
      hashApiKey('tds_abc', kek),
      '323957a5121db4229a44869263432cf9e6e2b4b44206822dfa1cfc26359a60a9',
      '算法或编码一变这个向量就对不上（用 node:crypto 独立算出来的）',
    );
  });

  test('未设 TDS_KEK 时默认 KEK = sha256(开发常量)，同样钉已知答案', (t) => {
    if (process.env.TDS_KEK) { t.skip('TDS_KEK 已设，默认派生不适用'); return; }
    assert.equal(
      hashApiKey('tds_abc'),
      'c5ab01c701b1a916658ad5f24d324072ecb1707e01add487848513041cb52a2b',
      '默认 KEK 的派生方式（crypto.ts:33）变了就对不上',
    );
  });

  test('notifications/* 回 202 空体（HTTP transport 对通知的规定）', async () => {
    const f = await seedFixture(sql, {
      label: 'notif', memberRole: 'admin', scopes: ['tool:todos'],
    });
    fixtures.push(f);

    const initialized = await rpc(app, f.key.key, {
      jsonrpc: '2.0', method: 'notifications/initialized',
    });
    assert.equal(initialized.statusCode, 202, '通知必须回 202，不该是 200 + -32601');
    assert.equal(initialized.body, '', '202 该是空体');

    // 通知之后同一个 key 照常能用 —— 证明 202 不是「把连接打断了」
    const list = await rpc(app, f.key.key, {
      jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
    });
    assert.equal(list.statusCode, 200);

    // 非通知的未知方法仍然是 -32601，没被顺手放宽
    const unknown = await rpc(app, f.key.key, {
      jsonrpc: '2.0', id: 2, method: 'resources/list', params: {},
    });
    assert.match(JSON.stringify(unknown.body), /-32601/);
  });

  test('带 id 的 notifications/* 不是通知：回 -32601 而不是 202 空体', async () => {
    const f = await seedFixture(sql, {
      label: 'notif-id', memberRole: 'admin', scopes: ['tool:todos'],
    });
    fixtures.push(f);
    // JSON-RPC 定义「通知」= **没有 id**。带 id 的请求若被当通知回 202 空体，
    // 客户端会一直等它的响应。此前这里只看方法名前缀，这条请求就被静默吞掉了。
    const res = await rpc(app, f.key.key, {
      jsonrpc: '2.0', id: 7, method: 'notifications/initialized', params: {},
    });
    assert.equal(res.statusCode, 200, '带 id 就必须回一个 JSON 响应，不是 202');
    const body = res.body as { id: unknown; error?: { code: number } };
    assert.equal(body.id, 7, '响应必须回同一个 id');
    assert.equal(body.error?.code, -32601, '未实现的带 id 方法必须是 MethodNotFound');
  });
});
