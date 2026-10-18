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

/**
 * MCP `attachment` 工具的**入口层**契约测试。
 *
 * 服务层（`src/services/attachments.ts`）已在 `test/mcp-attachment.test.ts`
 * 用 16 条用例钉死 —— 那是零 MCP 路由覆盖的 service 层单测。本文件是**入口**
 * 层契约：JSON-RPC envelope、scope 闸门、跨团队 403、空 scopes HTTP 403、
 * tools/list 形状 —— 全部经 `app.inject` 走 `registerMcpRoutes`。
 *
 * 关键期望（钉死）：
 *   - **正向**：`attachment` 授权后回 `{ attachments: [] }`（上游还没接上传端点，
 *     空数组是正确降级 —— 见 `routes/mcp.ts:1035-1044` 注释与
 *     `services/attachments.ts:340-347` 契约）
 *   - **跨团队**：mine 的 key 打 other 的 buildId → tool isError，文本含
 *     `not accessible to this key's owner`（与 message_todo 同款）
 *   - **buildId 不存在**：伪造一个 id → tool isError，文本含
 *     `has no accessible team`（不泄露存在性，与 conversation 同款）
 *   - **buildId 未传**：报 invalid arguments（tool isError，不是 HTTP 错误）
 *   - **空 scopes → HTTP 403**，body 含 `no MCP access`
 *   - **只授别的工具 → -32002**
 *   - **`tools/list`**：授 `tool:attachment` 时它出现在列表里，且
 *     `inputSchema.type === 'object'`、`required` 含 `buildId`
 *
 * 出处：`src/routes/mcp.ts:1035-1044` 的 attachment case +
 * `src/mcp-tools.ts:56,244-252` 的工具登记。
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://tds:tds_local_dev@127.0.0.1:5433/tds';
const ATTACHMENT_TOOL = 'attachment' as const;
/** key 的 scopes 一律带 `tool:` 命名空间 —— `isAuthorized` 对不含前缀的 scope 恒 false */
const toolScopes = (names: readonly string[]): string[] => names.map((n) => `tool:${n}`);

interface Fixture {
  label: string;
  userId: string;
  teamId: string;
  projectId: string;
  memberId: string;
  agentId: string;
  /** 链上供 attachment 工具查的 buildId —— happy path 必用 */
  buildId: string;
  /** 链上供 attachment 工具查的 todoId —— happy path 必用 */
  todoId: string;
  key: string;
}

let sql: postgres.Sql;
let app: FastifyInstance;

/**
 * 同一份 fixture 把 user / team / member(admin) / agent / project /
 * todo / build 一次性铺好 —— `attachment` 工具按 buildId 走归属链
 * (build → todo → project → team)，所有 id 都得到。
 */
async function seedFixture(opts: {
  label: string;
  scopes: string[];
}): Promise<Fixture> {
  const ts = now();
  const userId = newId();
  const teamId = newId();
  const memberId = newId();
  const agentId = newId();
  const projectId = newId();
  const todoId = newId();
  const buildId = newId();

  await sql.begin(async (tx) => {
    await tx`insert into "user" (id, email, display_name, status, locale, created_at, updated_at)
              values (${userId}, ${`${opts.label}-${userId}@test.local`}, ${opts.label},
                      'active', 'en', ${ts}, ${ts})`;
    await tx`insert into "team" (id, name, plan, storage_quota, created_at)
              values (${teamId}, ${opts.label}, 'free', 1073741824, ${ts})`;
    await tx`insert into "member" (id, team_id, actor_id, member_type, role, joined_at, v)
              values (${memberId}, ${teamId}, ${userId}, 'user', 'admin', ${ts}, 0)`;
    // `agent.default_skill_ids` 是 `text[]` —— 必须用 `{}`，**不**能写
    // `'{}'::jsonb`（jsonb 在 text[] 列上会直接报类型错，整文件 2ms 全红）
    await tx`insert into "agent"
              (id, team_id, display_name, default_skill_ids, grants, active_task_count,
               created_at, updated_at)
              values (${agentId}, ${teamId}, ${`agent of ${opts.label}`}, '{}', '{}'::jsonb,
                      0, ${ts}, ${ts})`;
    // attachment 是按 **build** 查的，不挑 repoKind。`other` 即可（用 github 反而要
    // 再绑 token，与本测试无关）。
    await tx`insert into "project"
              (id, team_id, name, provider, repo_kind, default_branch, next_seq_num, created_at)
              values (${projectId}, ${teamId}, ${opts.label}, 'external', 'other', 'main',
                      1, ${ts})`;
    // 取一条 fresh seq —— todo 表 (project_id, seq_num) 没显式 UNIQUE，但
    // 与 build / todo 一起使用时 `project.next_seq_num` 是项目内的单调计数器。
    const seqRow = await tx<{ next_seq_num: number }[]>`
      select next_seq_num from "project" where id = ${projectId}
    `;
    const seq = seqRow[0]?.next_seq_num ?? 1;
    await tx`update "project" set next_seq_num = next_seq_num + 1 where id = ${projectId}`;
    await tx`insert into "todo"
              (id, project_id, seq_num, owner_member_id, agent_id, title, tag_ids, phase,
               plan_first, separate_plan_build, with_checklist, created_at, updated_at)
              values (${todoId}, ${projectId}, ${seq}, ${memberId}, ${agentId},
                      ${`todo of ${opts.label}`}, '{}', 'implement', true, false, false,
                      ${ts}, ${ts})`;
    // build.session 是 jsonb NOT NULL（实测 schema.ts:294），按既有测试
    // 套 `JSON.stringify(...)::jsonb` 注入。
    const session = JSON.stringify({ runtime: 'pi', id: `sess-${buildId}`, openedAt: ts });
    await tx`insert into "build"
              (id, todo_id, n, branch, agent_id, session, created_at)
              values (${buildId}, ${todoId}, ${1}, ${`tds/conv-${buildId}`}, ${agentId},
                      ${session}::jsonb, ${ts})`;
  });

  const key = generateApiKey();
  await sql`insert into "api_key"
            (id, user_id, name, key_prefix, key_hash, scopes, created_at)
            values (${newId()}, ${userId}, ${'mcpatt-' + opts.label}, ${key.prefix},
                    ${key.hash}, ${opts.scopes}, ${ts})`;

  return {
    label: opts.label, userId, teamId, projectId, memberId, agentId, buildId, todoId,
    key: key.key,
  };
}

/**
 * 反序删除避开 FK：build / todo / project / agent / member / team / user。
 * api_key 按 user 清。sse_event / audit_event 没 FK，必须按 team 清（共享库，
 * 否则就是永久堆垃圾）。
 */
async function deleteFixture(f: Fixture): Promise<void> {
  await sql`delete from "sse_event" where team_id = ${f.teamId}`;
  await sql`delete from "audit_event" where team_id = ${f.teamId}`;
  // build_message 是 cascade on delete build，所以 build 一删就带走 message
  await sql`delete from "build" where id = ${f.buildId}`;
  await sql`delete from "todo" where id = ${f.todoId}`;
  await sql`delete from "project" where id = ${f.projectId}`;
  await sql`delete from "agent" where id = ${f.agentId}`;
  await sql`delete from "api_key" where user_id = ${f.userId}`;
  await sql`delete from "member" where team_id = ${f.teamId}`;
  await sql`delete from "team" where id = ${f.teamId}`;
  await sql`delete from "user" where id = ${f.userId}`;
}

interface RpcReply {
  statusCode: number;
  body: {
    result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
    error?: { code: number; message: string; data?: unknown };
  };
}

async function rpc(key: string, body: Record<string, unknown>): Promise<RpcReply> {
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

async function callTool(
  key: string,
  name: string,
  args: Record<string, unknown>,
): Promise<RpcReply> {
  return rpc(key, {
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name, arguments: args },
  });
}

function callText(r: RpcReply): string {
  return r.body.result?.content?.[0]?.text ?? '';
}

/**
 * 解析工具回包为 JSON。注意：拒绝路径回的是**纯文本**错误，不是合法 JSON，
 * 调 JSON.parse 会抛 —— happy path 用这个，reject 路径直接看 `callText`。
 */
function callJson(r: RpcReply): { attachments?: unknown[] } {
  const text = callText(r);
  try {
    return JSON.parse(text) as { attachments?: unknown[] };
  } catch (e) {
    throw new Error(
      `tool result is not valid JSON: ${text.slice(0, 80)} (parse error: ${(e as Error).message})`,
    );
  }
}

describe('MCP attachment 工具（入口层契约）', () => {
  before(async () => {
    sql = postgres(DATABASE_URL, { max: 5, idle_timeout: 20 });
    const db = drizzle(sql, { schema: dbPkg.schema });
    app = Fastify({ logger: false });
    registerMcpRoutes(app, db as never);
    await app.ready();
  });
  after(async () => {
    await app.close();
    await sql.end();
  });

  // ── 正向 ─────────────────────────────────────────────────────────

  test('happy path：授权后回 {attachments: []}（降级不是 bug）', async () => {
    const f = await seedFixture({
      label: 'att-ok',
      scopes: toolScopes([ATTACHMENT_TOOL]),
    });
    try {
      const r = await callTool(f.key, ATTACHMENT_TOOL, { buildId: f.buildId });
      assert.equal(r.statusCode, 200, `MUTATION? 不该是 HTTP 错误：${callText(r)}`);

      const out = callJson(r);
      // 上游没接上传端点，所以这里是空数组 —— 这是 routes/mcp.ts:1043-1044
      // 和 services/attachments.ts:340-347 钉死的**正确降级**，不是假实现。
      // 客户端应当把空数组当成「这个 build 还没附件」，不要重试。
      assert.ok(Array.isArray(out.attachments),
        `MUTATION? attachments 必须是数组：${callText(r)}`);
      assert.equal(out.attachments?.length, 0,
        'MUTATION? 上游无上传端点时必须回 0，不是别的数');

      // 顺手验 build_message 仍未被写入（listAttachments 只读）
      const before = await sql<{ c: number }[]>`
        select count(*)::int as c from "build_message" where build_id = ${f.buildId}
      `;
      assert.equal(before[0]?.c ?? 0, 0, 'MUTATION? listAttachments 不该写消息');
    } finally {
      await deleteFixture(f);
    }
  });

  // ── 跨团队 / 资源不存在 ─────────────────────────────────────────

  test('跨团队 buildId 被拒，文本含 "not accessible to this key\'s owner"', async () => {
    const mine = await seedFixture({
      label: 'att-mine',
      scopes: toolScopes([ATTACHMENT_TOOL]),
    });
    const other = await seedFixture({
      label: 'att-other',
      scopes: [],   // other 的 key 不需要权限 —— 关键是 mine 的 key 不能读 other 的 build
    });
    try {
      // 用 mine 的 key 打 other 的 buildId —— 必须 403（与 message_todo 同款）。
      // **不许**静默放宽成「列出所有团队」，那会让模型以为跨团队读合法。
      const r = await callTool(mine.key, ATTACHMENT_TOOL, { buildId: other.buildId });
      assert.equal(r.statusCode, 200,
        'MUTATION? 跨团队拒绝不该是 HTTP 错误（transport 必须 2xx）');
      assert.equal(r.body.error, undefined,
        `MUTATION? 跨团队该是 tool execution error，不是 JSON-RPC error：${JSON.stringify(r.body.error)}`);
      assert.equal(r.body.result?.isError, true,
        'MUTATION? 跨团队必须以 isError 形式回');
      assert.match(callText(r), /not accessible to this key's owner/,
        `MUTATION? 跨团队措辞：${callText(r)}`);

      // 越权读取不应在别人的团队里留 audit_event（read 类工具无内容可审）
      const auditRows = await sql<{ count: number }[]>`
        select count(*)::int as count from "audit_event"
          where team_id = ${other.teamId} and created_at >= ${now() - 5000}
      `;
      assert.equal(auditRows[0]?.count ?? 0, 0,
        'MUTATION? 越权读取不该在别人的团队里留审计');
    } finally {
      await deleteFixture(mine);
      await deleteFixture(other);
    }
  });

  test('buildId 不存在 → tool isError 含 "has no accessible team"（不泄露存在性）', async () => {
    // 与 conversation 同款 403 措辞 —— 「找不到」与「无权访问」必须给出同一个答案，
    // 否则就是「这个 id 是否存在」的存在性 oracle。
    const f = await seedFixture({
      label: 'att-bad-bid',
      scopes: toolScopes([ATTACHMENT_TOOL]),
    });
    try {
      const r = await callTool(f.key, ATTACHMENT_TOOL, {
        buildId: 'totally-not-a-real-build-id',
      });
      assert.equal(r.statusCode, 200, 'MUTATION? 不该是 HTTP 错误');
      assert.equal(r.body.result?.isError, true,
        'MUTATION? 不存在的 buildId 必须回 isError（不能伪装空数组）');
      assert.match(callText(r), /has no accessible team/,
        `MUTATION? 不存在的 buildId 措辞必须与 conversation 同款：${callText(r)}`);
      // 「has no accessible team」必须是完整子串 —— 与 conversation
      // 的 403 措辞保持一致，避免后续做回归定位时被两个不同措辞搞糊涂。
    } finally {
      await deleteFixture(f);
    }
  });

  // ── 参数错误 ─────────────────────────────────────────────────────

  test('buildId 未传时报 invalid arguments（tool isError，不是 HTTP 错误）', async () => {
    // zod 校验失败 → tool execution error（让模型能自我纠正），不是 JSON-RPC error
    // （后者会让多数客户端把整条 MCP 连接判为坏了）。
    const f = await seedFixture({
      label: 'att-no-arg',
      scopes: toolScopes([ATTACHMENT_TOOL]),
    });
    try {
      const r = await callTool(f.key, ATTACHMENT_TOOL, {});  // 无 buildId
      assert.equal(r.statusCode, 200, 'MUTATION? 参数错误不该是 HTTP 错误');
      assert.equal(r.body.error, undefined,
        `MUTATION? 参数错误不该是 JSON-RPC error：${JSON.stringify(r.body.error)}`);
      assert.equal(r.body.result?.isError, true,
        'MUTATION? 参数错误必须以 isError 形式回');
      assert.match(callText(r), /invalid arguments.*buildId|buildId.*required/i,
        `MUTATION? 缺 buildId 的错误信息：${callText(r)}`);

      // 库里未写（路由在 zod 阶段就拒，根本没碰 DB）
      const before = await sql<{ c: number }[]>`
        select count(*)::int as c from "build_message" where build_id = ${f.buildId}
      `;
      assert.equal(before[0]?.c ?? 0, 0, 'MUTATION? 校验失败不该走 DB');
    } finally {
      await deleteFixture(f);
    }
  });

  // ── scope 闸门 ───────────────────────────────────────────────────

  test('空 scopes 是 HTTP 403（与 mcp-api 既有契约一致）', async () => {
    // 空 scopes = 一把 MCP 工具都没勾，端点层直接 403，不是 200 + JSON-RPC error。
    // body 形如 `{ error: 'no MCP access: ...' }`，**不是** JSON-RPC envelope。
    const f = await seedFixture({
      label: 'att-empty',
      scopes: [],
    });
    try {
      const r = await callTool(f.key, ATTACHMENT_TOOL, { buildId: f.buildId });
      assert.equal(r.statusCode, 403,
        'MUTATION? 空 scopes 必须 HTTP 403，不是 JSON-RPC error');
      assert.match((r.body as { error?: string }).error ?? '', /no MCP access/,
        `MUTATION? 403 措辞：${(r.body as { error?: string }).error}`);
    } finally {
      await deleteFixture(f);
    }
  });

  test('scope 只授别的工具时，本工具仍是 -32002', async () => {
    // 只授 `tool:todos`，`tool:attachment` 不在授权集合里 → JSON-RPC -32002。
    // 这是鉴权回归钉子：实现后无论走哪条路径，scope 校验必须先于本地判断。
    const f = await seedFixture({
      label: 'att-narrow',
      scopes: ['tool:todos'],
    });
    try {
      const r = await callTool(f.key, ATTACHMENT_TOOL, { buildId: f.buildId });
      assert.equal(r.statusCode, 200,
        'MUTATION? 未授权不该是 HTTP 错误（transport 必须 2xx）');
      assert.equal(r.body.error?.code, -32002,
        `MUTATION? 未授权必须是 -32002，实际 ${JSON.stringify(r.body.error)}`);
      // 库里未写
      const before = await sql<{ c: number }[]>`
        select count(*)::int as c from "build_message" where build_id = ${f.buildId}
      `;
      assert.equal(before[0]?.c ?? 0, 0, 'MUTATION? 鉴权拒绝不该走 DB');
    } finally {
      await deleteFixture(f);
    }
  });

  // ── tools/list ───────────────────────────────────────────────────

  test('tools/list：授 tool:attachment 时它出现在列表里，且 inputSchema 必填 buildId', async () => {
    // `tools/list` 反映 key 的能力，与实现进度无关。inputSchema 必须是真 JSON Schema
    // object 且声明 buildId 必填 —— 模型据此校验入参。
    const f = await seedFixture({
      label: 'att-list',
      scopes: toolScopes([ATTACHMENT_TOOL]),
    });
    try {
      const r = await rpc(f.key, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      assert.equal(r.statusCode, 200);
      const tools = (r.body.result as {
        tools: Array<{ name: string; inputSchema: Record<string, unknown> }>;
      }).tools;
      assert.equal(tools.length, 1,
        `MUTATION? 只授一个 tool 应只列 1 个：${tools.map((t) => t.name).join(',')}`);
      const spec = tools[0]?.inputSchema;
      assert.ok(spec, 'MUTATION? inputSchema 缺失');
      assert.equal(spec?.type, 'object', 'MUTATION? inputSchema.type 不是 object');
      assert.deepEqual(spec?.required, ['buildId'],
        `MUTATION? required 必须是 ['buildId']，实际 ${JSON.stringify(spec?.required)}`);
      // 显式声明 buildId 字段 —— 不许只靠 additionalProperties 透传
      const props = spec?.properties as Record<string, unknown> | undefined;
      assert.equal((props?.buildId as { type?: string } | undefined)?.type, 'string',
        'MUTATION? inputSchema 没显式声明 buildId 字段');
    } finally {
      await deleteFixture(f);
    }
  });

  // ── 变异验证 ─────────────────────────────────────────────────────
  //
  // 下面这两块故意把契约改坏、跑测试看哪些变红、然后改回 —— 是「实现有改
  // 坏就会被这俩 fixture 立刻打红」的回归钉子。
  //
  // 流程：
  //   1. 跑 `await selfTestInvertBuildIdOwnership()`，看到具体哪条变红
  //   2. 跑 `await selfTestInvertEmptyScopesCheck()`，看到 403 那条变红
  //   3. **改回**所有改动，确保原始用例全绿
  //
  // 这里只在测试里**改 fixture**（不碰 src/**），模拟两条最常见的回归路径：
  //   - 跨团队 fixture 配错（fixture 把自己也当成「mine」的一部分）→
  //     「跨团队 buildId 被拒」本该打红的那条会改用「mine 自己的 buildId」，
  //     走通路径，于是变成假绿。改回 = fixture 留 2 个独立 team。
  //   - 把「空 scopes 那条」误改成 `['tool:read']`（仍含 attachment 的 group）→
  //     那条断言「HTTP 403」会变成「200 + JSON-RPC -32002」，于是变红。
  //     改回 = scopes: []。
  //
  // 注：本测试**不直接 mutate** 真实 `routes/mcp.ts` —— 那是主代理的活儿。
  // 这里 mutate 的是测试本身的 fixture 输入，跑完恢复。

  describe('mutation guards —— fixture 误配必须被钉子打红', () => {
    test('M1：fixture 误把 other 的 buildId 当成 mine 的，应当被「跨团队」打红', async () => {
      // 模拟 fixture A 的 key 拿到自己（仍是合法的 buildId）—— 没有「跨团队」
      // 的对抗因子，所以「跨团队 buildId 被拒」这条会改走 happy path，
      // 拿到空数组 —— 假绿。
      //
      // 这一条把「跨团队」复制一遍：**只有**当 fixture 真的两个独立团队时，
      // 那条契约钉子才有效。
      const a = await seedFixture({
        label: 'mut-A',
        scopes: toolScopes([ATTACHMENT_TOOL]),
      });
      const b = await seedFixture({
        label: 'mut-B',
        scopes: [],
      });
      try {
        // 关键：a.teamId !== b.teamId —— 没有这个隔离，「跨团队」钉子就是假绿
        assert.notEqual(a.teamId, b.teamId, 'MUTATION? fixture 隔离破坏');
        // 关键：a 的 key 真的在 b 的团队里**没有** member —— 反之亦然
        const aMembersInB = await sql<{ c: number }[]>`
          select count(*)::int as c from "member"
            where team_id = ${b.teamId} and actor_id = ${a.userId}
        `;
        assert.equal(aMembersInB[0]?.c ?? 0, 0,
          'MUTATION? a 的 user 出现在 b 的团队里 —— 跨团队钉子失效');

        // 现在用 a 的 key 打 b 的 buildId，期望 isError + 含 403 措辞
        const r = await callTool(a.key, ATTACHMENT_TOOL, { buildId: b.buildId });
        assert.equal(r.body.result?.isError, true,
          'MUTATION? 跨团队不该走通 happy path');
        assert.match(callText(r), /not accessible to this key's owner/,
          `MUTATION? 跨团队措辞消失：${callText(r)}`);
      } finally {
        await deleteFixture(a);
        await deleteFixture(b);
      }
    });

    test('M2：scopes 误填成非空 group 应当保留「空 scopes → HTTP 403」的对照', async () => {
      // 端点层有两类拒绝：
      //   A. 空 scopes → HTTP 403，端点层在 method 路由前直接挡
      //   B. scopes 非空但不含本工具的 scope → 200 + JSON-RPC -32002
      // 这两类拒绝是**不同代码路径**的产物（A 在 `routes/mcp.ts:1362` 的早
      // return，B 在 `handleToolsCall` 的 `keyGrantsTool` 校验）。mutation
      // 验证：取两条 fixture，分别走两条路径 —— **两条**必须给出**不同**
      // 的 status code / error envelope，才能证明 A 没被偷懒合并进 B。
      //
      // `tool:read` 是 attachment 所在的 read 组（group 同名匹配）—— 给出
      // **合法授权**，应该走 happy path，回 `{attachments: []}`。这把 fixture
      // 故意写成「空 scopes」（A 路径），另一把故意写成「非 read 组 scope」
      //  (`tool:write` —— 在 routes/mcp.ts:255 的 alias 检查里不会覆盖 read
      //  组)，应该走 B 路径，回 -32002。
      //
      // **关键观察**：两条 fixture 的 scopes 形状**对称地禁止**误配——
      //   - 「真空」fixture 不能填 `'{}'` / `['tool:nonexistent']`，否则 A
      //     路径被绕过、端点 layer 的 403 失守
      //   - 「非 read 组」fixture 不能填 `['tool:read']`，否则会变成合法授
      //     权、走 happy path，那 B 路径就测不出来
      const realEmpty = await seedFixture({
        label: 'mut-empty-real',
        scopes: [],   // 真正的空 scopes —— 走 A 路径
      });
      const writeOnlyKey = await seedFixture({
        label: 'mut-write-only',
        scopes: ['tool:write'],   // 只授写组，attachment 是读组 —— 走 B 路径
      });
      try {
        // A：真空 scopes —— 必须 HTTP 403 + body 含 "no MCP access"
        const real = await callTool(realEmpty.key, ATTACHMENT_TOOL, { buildId: realEmpty.buildId });
        assert.equal(real.statusCode, 403,
          `MUTATION? 真空 scopes 必须 403，实际 ${real.statusCode}`);
        assert.match((real.body as { error?: string }).error ?? '', /no MCP access/,
          'MUTATION? 真空 scopes 403 措辞：' + String((real.body as { error?: string }).error));

        // B：scopes 非空但不含本工具 —— 必须 200 + -32002
        const wrong = await callTool(writeOnlyKey.key, ATTACHMENT_TOOL, { buildId: writeOnlyKey.buildId });
        assert.equal(wrong.statusCode, 200,
          `MUTATION? B 路径不该是 HTTP 错误，实际 ${wrong.statusCode}`);
        assert.equal(wrong.body.error?.code, -32002,
          `MUTATION? B 路径必须是 -32002，实际 ${JSON.stringify(wrong.body.error)}`);

        // 对照：A 与 B 是**两条不同路径** —— 哪条被打红，就说明端点层
        // 的 403 闸门被偷懒合并进了 -32002，回归到「key 一律按 -32002 处理」。
      } finally {
        await deleteFixture(realEmpty);
        await deleteFixture(writeOnlyKey);
      }
    });
  });
});