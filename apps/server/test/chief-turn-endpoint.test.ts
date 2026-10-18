/**
 * `POST /api/chief/threads/:threadId/messages` 的 HTTP 层契约验证。
 *
 *   body: `{ message: string }`
 *   200:  `{ text, toolCalls, lastSeq, stoppedBy }`
 *
 * 主代理负责在本文件中只写这一个测试，路由层 (routes/chief.ts)与服务层
 * (services/chief-turn.ts) 都还没有接好 —— 这**正是预期**：测试给出红
 * 信号，等主代理把它们接上再转绿。
 *
 * ## 模型调用必须可注入
 *
 * `setModelFetchImpl` 注入模块级 fetch；`afterEach` 清空，避免污染兄弟测试。
 * `fakeFetch` 完全是 `test/chief-model.test.ts` 的同款（顺序消费预设响应，
 * 记录 {url, headers, body} 给断言）。
 *
 * **接线预期**：路由层建 `ModelCaller` 时应**不传** `fetchImpl`（或干脆
 * 不显式传，让 `pickFetch` 的 `opts.fetchImpl ?? fetchOverride` 走模块
 * setter）。否则这个 setter 不会生效 —— 主代理接线时请走这条路。这
 * 也是 `services/chief-model.ts::pickFetch` 的官方约定。
 *
 * ## fixture 形状（照抄 chief-http.test.ts）
 *
 *   user, team, member(admin), agent(带 provider + modelId),
 *   chief(表名 `chief`！), chief_thread(session={runtime,id,openedAt}, session.id
 *   是伪 buildId),
 *   api_key, provider(api='openai-completions' + base_url, apiKey 用真 seal())。
 *
 * ## 每条拒绝用例都查库证明未写
 *
 * 比如「B 的 key 打 A 的 threadId → 403」必须配合
 * `A 的 chief_message 行数在调用前后一致`,**不要**用全表 count。
 *
 * ## 变异验证（写在文件末尾）
 *
 *   M1) 把假响应里 `reasoning_content` 字段名拼成 `reasoningContent` →
 *       `content:null + reasoning_content` 那条变红。改回 → 全红（这文件路由
 *       还没接，所以是 404 别的红）。
 *
 * **不要跑全量测试 / typecheck / lint**（主代理统一跑）。
 */

import assert from 'node:assert/strict';
import { test, describe, before, after, afterEach } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import * as dbPkg from '@tds/db';
import { newId, now } from '../src/ids.js';
import { generateApiKey, seal } from '../src/crypto.js';
import { registerChiefRoutes } from '../src/routes/chief.js';
import { registerMcpRoutes } from '../src/routes/mcp.js';
import { setModelFetchImpl } from '../src/services/chief-model.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://tds@127.0.0.1:5433/tds';

let sql: postgres.Sql;
let app: FastifyInstance;
let fx: {
  userId: string;
  teamId: string;
  memberId: string;
  agentId: string;
  chiefId: string;
  threadId: string;
  /** thread.session.id —— 伪 buildId，chief_message.build_id 用这个 */
  buildIdStub: string;
  providerId: string;
  /** 用 `seal()` 加密的明文 apiKey —— 泄漏断言的对照 */
  apiKeyPlaintext: string;
  key: string;
  otherUserId: string;
  otherTeamId: string;
  otherMemberId: string;
  otherAgentId: string;
  otherChiefId: string;
  otherThreadId: string;
  otherBuildIdStub: string;
  otherKey: string;
};

/** 注入式 fake fetch —— 与 chief-model.test.ts 同款 */
interface FakeResponse {
  status: number;
  body: unknown;
}

interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function fakeFetch(responses: FakeResponse[]): {
  calls: FakeCall[];
  impl: typeof fetch;
} {
  let i = 0;
  const calls: FakeCall[] = [];
  return {
    calls,
    impl: (async (url: string, init: RequestInit = {}) => {
      const headers: Record<string, string> = {};
      const h = init.headers;
      if (h) {
        if (h instanceof Headers) {
          h.forEach((v, k) => (headers[k] = v));
        } else if (Array.isArray(h)) {
          for (const [k, v] of h) headers[k] = v;
        } else {
          Object.assign(headers, h as Record<string, string>);
        }
      }
      const bodyText =
        typeof init.body === 'string'
          ? init.body
          : init.body instanceof Uint8Array
            ? new TextDecoder().decode(init.body)
            : '';
      calls.push({
        url,
        method: (init.method ?? 'GET').toUpperCase(),
        headers,
        body: bodyText,
      });

      const r = responses[i++];
      if (!r) {
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  };
}

/**
 * 将 `fakeFetch` 注册到模块级 setter —— 任何调 `createModelCaller` 且没传
 * `fetchImpl` 的代码都会走到这条。
 *
 * 主代理的 chief-turn 服务层可能直接传 `fetchImpl`，也可能走 module 级
 * setter —— 两种都覆盖到。
 */
function installFakeFetch(responses: FakeResponse[]): { calls: FakeCall[] } {
  const f = fakeFetch(responses);
  setModelFetchImpl(f.impl);
  return { calls: f.calls };
}

function clearFakeFetch(): void {
  setModelFetchImpl(undefined);
}

describe('POST /api/chief/threads/:threadId/messages', () => {
  before(async () => {
    sql = postgres(DATABASE_URL, { max: 5 });
    const db = drizzle(sql, { schema: dbPkg.schema });
    app = Fastify({ logger: false });
    registerMcpRoutes(app, db as never, 'http://test');
    registerChiefRoutes(app, db as never);
    await app.ready();

    const ts = now();
    const userId = newId();
    const teamId = newId();
    const memberId = newId();
    const agentId = newId();
    const providerId = `prov-chief-turn-${newId()}`;
    const chiefA = `chief-${userId}-${teamId}`;
    const threadId = newId();
    // **关键**：`thread.session.id` = 伪 buildId。Chief turn 写入的
    // `chief_message.build_id` 就取这个 —— 见 routes/chief.ts 的
    // `GET /api/conversations/:convId/messages` 注释。
    const buildIdStub = newId();
    const apiKeyPlaintext =
      'sk-TEST_KEY_chief_turn_DO_NOT_LEAK_in_responses_' +
      'x9Z_2026_' +
      newId().slice(0, 8);

    const otherUserId = newId();
    const otherTeamId = newId();
    const otherMemberId = newId();
    const otherAgentId = newId();
    const otherChiefId = `chief-${otherUserId}-${otherTeamId}`;
    const otherThreadId = newId();
    const otherBuildIdStub = newId();

    // ─── user / team / member (A) ───────────────────────────────────
    await sql`insert into "user" (id,email,display_name,status,locale,created_at,updated_at)
              values (${userId}, ${'chief-turn-' + userId + '@test.local'},
                      'chief-turn', 'active', 'en', ${ts}, ${ts})`;
    await sql`insert into team (id,name,plan,storage_quota,created_at)
              values (${teamId}, ${'chief-turn-team-' + teamId}, 'free',
                      1073741824, ${ts})`;
    await sql`insert into "member" (id,team_id,actor_id,member_type,role,joined_at,v)
              values (${memberId}, ${teamId}, ${userId}, 'user', 'admin',
                      ${ts}, 0)`;
    // ─── agent (A) —— 必须带 provider + modelId，Chief turn 要拿这俩去
    //     建 ModelCaller
    await sql`insert into agent (id,team_id,display_name,provider,model_id,thinking_level,
                                default_skill_ids,grants,active_task_count,
                                created_at,updated_at)
              values (${agentId}, ${teamId}, 'chief-turn agent', ${providerId},
                      'qwen3.8-flash-next-iq2_xs', 'off',
                      '{}', '{}'::jsonb, 0, ${ts}, ${ts})`;
    await sql`insert into chief (id,user_id,team_id,agent_id,charter,created_at,updated_at)
              values (${chiefA}, ${userId}, ${teamId}, ${agentId}, 'test', ${ts}, ${ts})`;
    // chief_thread.session 形状：`{runtime,id,openedAt}` —— `id` 即伪 buildId
    await sql`insert into chief_thread (id,chief_id,title,session,tool_def_hashes,
                                         watched_todos,created_at,updated_at,v)
              values (${threadId}, ${chiefA}, 'turn test',
                      ${JSON.stringify({ runtime: 'claude-code', id: buildIdStub, openedAt: ts })}::jsonb,
                      ${'{}'}::jsonb, ${'{}'}, ${ts}, ${ts}, 0)`;

    // ─── provider (A) —— apiKey 用真 seal() 加密
    const sealed = seal(apiKeyPlaintext);
    await sql`insert into provider (id,team_id,kind,provider_id,label,api,base_url,
                                    enc_api_key,enc_nonce,compat,models,
                                    created_by,created_at,updated_at)
              values (${newId()}, ${teamId}, 'vendor', ${providerId},
                      'chief-turn prov', 'openai-completions',
                      'http://127.0.0.1:8080/v1',
                      ${`${sealed.cipher}.${sealed.tag}`}, ${sealed.nonce},
                      ${`{"supportsDeveloperRole":false}`}::jsonb,
                      ${`[{"id":"qwen3.8-flash-next-iq2_xs","maxTokens":8192}]`}::jsonb,
                      ${userId}, ${ts}, ${ts})`;

    // ─── api_key (A) —— client key，跟 seal() 的 apiKey 没关系，那个是模型网关的
    const k1 = generateApiKey();
    await sql`insert into api_key (id,user_id,name,key_prefix,key_hash,scopes,created_at)
              values (${newId()}, ${userId}, 'chief-turn-key', ${k1.prefix},
                      ${k1.hash}, ${['tool:run_builds']}, ${ts})`;

    // ─── B 团队 —— 给跨 team 403 用
    await sql`insert into "user" (id,email,display_name,status,locale,created_at,updated_at)
              values (${otherUserId}, ${'chief-turn-b-' + otherUserId + '@test.local'},
                      'chief-turn-b', 'active', 'en', ${ts}, ${ts})`;
    await sql`insert into team (id,name,plan,storage_quota,created_at)
              values (${otherTeamId}, ${'chief-turn-team-b-' + otherTeamId},
                      'free', 1073741824, ${ts})`;
    await sql`insert into "member" (id,team_id,actor_id,member_type,role,joined_at,v)
              values (${otherMemberId}, ${otherTeamId}, ${otherUserId}, 'user',
                      'admin', ${ts}, 0)`;
    await sql`insert into agent (id,team_id,display_name,default_skill_ids,grants,
                                active_task_count,created_at,updated_at)
              values (${otherAgentId}, ${otherTeamId},
                      'chief-turn-b agent', '{}', '{}'::jsonb, 0, ${ts}, ${ts})`;
    await sql`insert into chief (id,user_id,team_id,agent_id,charter,created_at,updated_at)
              values (${otherChiefId}, ${otherUserId}, ${otherTeamId},
                      ${otherAgentId}, 'test', ${ts}, ${ts})`;
    await sql`insert into chief_thread (id,chief_id,title,session,tool_def_hashes,
                                         watched_todos,created_at,updated_at,v)
              values (${otherThreadId}, ${otherChiefId}, 'b thread',
                      ${JSON.stringify({ runtime: 'claude-code', id: otherBuildIdStub, openedAt: ts })}::jsonb,
                      ${'{}'}::jsonb, ${'{}'}, ${ts}, ${ts}, 0)`;
    const k2 = generateApiKey();
    await sql`insert into api_key (id,user_id,name,key_prefix,key_hash,scopes,created_at)
              values (${newId()}, ${otherUserId}, 'chief-turn-b-key', ${k2.prefix},
                      ${k2.hash}, ${['tool:run_builds']}, ${ts})`;

    fx = {
      userId,
      teamId,
      memberId,
      agentId,
      chiefId: chiefA,
      threadId,
      buildIdStub,
      providerId,
      apiKeyPlaintext,
      key: k1.key,
      otherUserId,
      otherTeamId,
      otherMemberId,
      otherAgentId,
      otherChiefId,
      otherThreadId,
      otherBuildIdStub,
      otherKey: k2.key,
    };
  });

  after(async () => {
    // 清 A
    await sql`delete from chief_message where thread_id = ${fx.threadId}`;
    await sql`delete from sse_event where team_id = ${fx.teamId}`;
    await sql`delete from audit_event where team_id = ${fx.teamId}`;
    await sql`delete from chief_thread where chief_id = ${fx.chiefId}`;
    await sql`delete from chief where id = ${fx.chiefId}`;
    await sql`delete from provider where team_id = ${fx.teamId}`;
    await sql`delete from agent where team_id = ${fx.teamId}`;
    await sql`delete from project where team_id = ${fx.teamId}`;
    // 清 B
    await sql`delete from chief_message where thread_id = ${fx.otherBuildIdStub}`;
    await sql`delete from sse_event where team_id = ${fx.otherTeamId}`;
    await sql`delete from audit_event where team_id = ${fx.otherTeamId}`;
    await sql`delete from chief_thread where chief_id = ${fx.otherChiefId}`;
    await sql`delete from chief where id = ${fx.otherChiefId}`;
    await sql`delete from agent where team_id = ${fx.otherTeamId}`;
    // api_key / member / team / user
    await sql`delete from api_key where user_id in (${fx.userId}, ${fx.otherUserId})`;
    await sql`delete from member where team_id in (${fx.teamId}, ${fx.otherTeamId})`;
    await sql`delete from team where id in (${fx.teamId}, ${fx.otherTeamId})`;
    await sql`delete from "user" where id in (${fx.userId}, ${fx.otherUserId})`;
    await app.close();
    await sql.end();
  });

  afterEach(() => clearFakeFetch());

  async function inject(key: string | null, body?: unknown) {
    const headers: Record<string, string> = {};
    if (key !== null) headers['authorization'] = `Bearer ${key}`;
    return app.inject({
      method: 'POST',
      url: `/api/chief/threads/${fx.threadId}/messages`,
      headers,
      ...(body === undefined ? {} : { payload: body as object }),
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // 1) 正向纯文本 —— user + assistant 两行都进 chief_message
  // ─────────────────────────────────────────────────────────────────
  test('正向纯文本：200，user + assistant 都落进 chief_message', async () => {
    installFakeFetch([
      {
        status: 200,
        body: {
          choices: [
            {
              finish_reason: 'stop',
              message: { content: '已处理' },
            },
          ],
        },
      },
    ]);

    const before = await sql`select count(*)::int as c from chief_message
                              where thread_id = ${fx.threadId}`;
    const res = await inject(fx.key, { message: '在吗？' });
    assert.equal(res.statusCode, 200, `MUTATION? 期望 200 拿到 ${res.statusCode}: ${res.body}`);

    const out = JSON.parse(res.body) as {
      text: string;
      toolCalls: Array<{ name: string; ok: boolean; reason?: string }>;
      lastSeq: number;
      stoppedBy: string;
    };
    assert.equal(out.text, '已处理', `MUTATION? text 没回传：${out.text}`);
    assert.deepEqual(out.toolCalls, [], 'MUTATION? 没调工具不该有 toolCalls');
    assert.equal(out.stoppedBy, 'text', `MUTATION? 期望 text 出口：${out.stoppedBy}`);
    assert.ok(typeof out.lastSeq === 'number' && out.lastSeq >= 0, 'MUTATION? lastSeq 应是非负数');

    // ── 查库：chief_message 行数 +2（user + assistant），thread_id = session.id
    const after = await sql`select count(*)::int as c from chief_message
                             where thread_id = ${fx.threadId}`;
    assert.equal(
      after[0]!.c - before[0]!.c,
      2,
      `MUTATION? 期望 user+assistant 两行，实际新增 ${after[0]!.c - before[0]!.c}`,
    );

    // 内容：user「在吗？」 + assistant「已处理」
    const userRow = await sql`select role, content from chief_message
                              where thread_id = ${fx.threadId} and role = 'user'
                              order by seq desc limit 1`;
    assert.equal(userRow.length, 1, 'MUTATION? user 消息没落库');
    assert.equal(userRow[0]!.content, '在吗？');

    const assistantRow = await sql`select role, content from chief_message
                                   where thread_id = ${fx.threadId} and role = 'assistant'
                                   order by seq desc limit 1`;
    assert.equal(assistantRow.length, 1, 'MUTATION? assistant 消息没落库');
    assert.equal(assistantRow[0]!.content, '已处理');
  });

  // ─────────────────────────────────────────────────────────────────
  // 2) 正向带工具 —— 两次消费：tool_calls → stop
  // ─────────────────────────────────────────────────────────────────
  test('正向带工具：toolCalls 里有那一条，且 tool 结果也落库', async () => {
    const { calls } = installFakeFetch([
      {
        status: 200,
        body: {
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call_seed_1',
                    type: 'function',
                    function: {
                      // 用**已接线**的工具名：`usage` 是只读、无 admin 闸门、
                      // 非不可逆（见 chief/tools.ts）。原来写 `noop` 会被执行器正确拒绝
                      // —— 那是测试自己造了个不存在的工具名。
                      name: 'usage',
                      arguments: '{}',
                    },
                  },
                ],
              },
            },
          ],
        },
      },
      {
        status: 200,
        body: {
          choices: [
            {
              finish_reason: 'stop',
              message: { content: '调过了' },
            },
          ],
        },
      },
    ]);

    const res = await inject(fx.key, { message: '帮我查一下 todos' });
    assert.equal(res.statusCode, 200, `MUTATION? 期望 200 拿到 ${res.statusCode}: ${res.body}`);

    const out = JSON.parse(res.body) as {
      text: string;
      toolCalls: Array<{ name: string; ok: boolean; reason?: string }>;
      lastSeq: number;
      stoppedBy: string;
    };
    assert.equal(out.text, '调过了');
    assert.equal(out.toolCalls.length, 1, `MUTATION? 应该执行 1 个工具：${out.toolCalls.length}`);
    assert.equal(out.toolCalls[0]!.name, 'usage');
    assert.equal(out.toolCalls[0]!.ok, true, 'MUTATION? 工具应成功');
    assert.equal(out.stoppedBy, 'text');

    // ── 两次模型调用（顺序消费）
    assert.equal(calls.length, 2, `MUTATION? 期望 2 次 fetch，实际 ${calls.length}`);
    assert.match(calls[0]!.url, /\/v1\/chat\/completions$/);
    assert.match(calls[1]!.url, /\/v1\/chat\/completions$/);

    // 第二次 fetch 的 body 里应包含 tool 回灌（messages 数组里看到 assistant.tool_calls 与 tool role）
    const secondReq = JSON.parse(calls[1]!.body) as {
      messages: Array<{
        role: string;
        content?: string;
        tool_calls?: unknown[];
        tool_call_id?: string;
      }>;
    };
    const assistantMsgWithToolCalls = secondReq.messages.find(
      (m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
    );
    assert.ok(
      assistantMsgWithToolCalls,
      `MUTATION? 第二轮请求应包含 assistant.tool_calls 回灌；messages: ${JSON.stringify(secondReq.messages)}`,
    );
    const toolMsg = secondReq.messages.find(
      (m) => m.role === 'tool' && m.tool_call_id === 'call_seed_1',
    );
    assert.ok(toolMsg, 'MUTATION? 第二轮应包含 tool 回灌，且 tool_call_id=call_seed_1');

    // ── 查库：chief_message 应至少有 user + assistant（含 tool_calls 标记）+ tool + assistant
    //       共 4 行（具体条数取决于实现，但要 >=3 且必须含 tool 的那条）
    const toolRow = await sql`select role from chief_message
                              where thread_id = ${fx.threadId} and role = 'tool'
                              order by seq desc limit 1`;
    assert.equal(toolRow.length, 1, 'MUTATION? tool 消息没落库');
  });

  // ─────────────────────────────────────────────────────────────────
  // 3) content:null + reasoning_content —— 拿 reasoning 当 text 回
  //    真实 Strata qwen3.8-flash-next-iq2_xs 的响应形状
  // ─────────────────────────────────────────────────────────────────
  test('content:null + reasoning_content：text 应来自 reasoning_content', async () => {
    installFakeFetch([
      {
        status: 200,
        body: {
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: null,
                reasoning_content: '用户在问 hi，我回 hello there。\nhello there',
              },
            },
          ],
        },
      },
    ]);

    const res = await inject(fx.key, { message: 'hi' });
    assert.equal(res.statusCode, 200, `MUTATION? 期望 200 拿到 ${res.statusCode}: ${res.body}`);
    const out = JSON.parse(res.body) as { text: string; toolCalls: unknown[]; stoppedBy: string };
    // 真实 Strata 模型 behavior，**root contract**：content 是 null 但
    // Chief 还能给出合理的 text —— 失败时 revert to reasoning_content。
    assert.ok(out.text.includes('hello'), `MUTATION? text 应来自 reasoning_content：${out.text}`);
    assert.equal(out.stoppedBy, 'text');
  });

  // ─────────────────────────────────────────────────────────────────
  // 4) 模型凭据不泄漏 —— 假响应里 echo apiKey，端点不能把它带出来
  // ─────────────────────────────────────────────────────────────────
  test('模型凭据不泄漏：假响应里 echo apiKey 时，端点任何字段都不含它', async () => {
    // 用真 seal() 加密过的那把 key 当对照：必须「absent」。这个 key 是 fixture 里
    // seal() 的原文（apps/server/src/crypto.ts seal() 默认走 development KEK）——
    // 与 e2e-daemon-turn.ts 一样的开发链路。
    const plaintext = fx.apiKeyPlaintext;
    installFakeFetch([
      {
        status: 401,
        body: { error: { message: `echoed: ${plaintext}`, type: 'auth_error' } },
      },
    ]);

    const res = await inject(fx.key, { message: '随便' });
    // 路由还没接时这里是 404；接好之后是 500（fetchImpl 返的不是 Error 路径），
    // 或 502/401/500 之一 —— 但**任何**状态码下，回包里都不应包含真 key。
    const blob = JSON.stringify({
      status: res.statusCode,
      body: res.body,
      headers: res.headers,
    });
    assert.equal(
      blob.includes(plaintext),
      false,
      `MUTATION? 凭据明文进了响应:\n  status=${res.statusCode}\n  body=${res.body}\n  headers=${JSON.stringify(res.headers)}`,
    );

    // 也防 log / error message 路径：Fastify 这里没把 body 印出来，但万一
    // 实现里把 fetch 错误塞进 500 body —— 同样不能漏。
    assert.notEqual(res.statusCode, 404, 'MUTATION? 路由 404 说明还没接，不能算这条过了');
  });

  // ─────────────────────────────────────────────────────────────────
  // 5) thread 不存在 → 404
  // ─────────────────────────────────────────────────────────────────
  test('thread 不存在 → 404', async () => {
    installFakeFetch([{ status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: 'x' } }] } }]);
    const missing = newId();
    const res = await app.inject({
      method: 'POST',
      url: `/api/chief/threads/${missing}/messages`,
      headers: { authorization: `Bearer ${fx.key}` },
      payload: { message: 'hi' },
    });
    assert.equal(
      res.statusCode,
      404,
      `MUTATION? thread 不存在应 404，拿到 ${res.statusCode}: ${res.body}`,
    );
  });

  // ─────────────────────────────────────────────────────────────────
  // 6) 跨 team —— B 的 key 打 A 的 threadId → 403；B 团队的 chief_message 行数不变
  //    **最重要的一条**
  // ─────────────────────────────────────────────────────────────────
  test('跨 team：B 的 key 打 A 的 threadId → 403 且 A 的 chief_message 行未增', async () => {
    installFakeFetch([
      // 万一被允许调模型，这条不能影响断言 —— 拒绝应发生在凭据校验，更早
      { status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: 'b 越权' } }] } },
    ]);

    const before = await sql`select count(*)::int as c from chief_message
                              where thread_id = ${fx.threadId}`;
    const res = await app.inject({
      method: 'POST',
      url: `/api/chief/threads/${fx.threadId}/messages`,
      headers: { authorization: `Bearer ${fx.otherKey}` },
      payload: { message: '我是 B' },
    });
    assert.equal(
      res.statusCode,
      403,
      `MUTATION? 跨 team 应 403，拿到 ${res.statusCode}: ${res.body}`,
    );
    const after = await sql`select count(*)::int as c from chief_message
                             where thread_id = ${fx.threadId}`;
    assert.equal(
      after[0]!.c,
      before[0]!.c,
      `MUTATION? 403 但 chief_message 多了 ${after[0]!.c - before[0]!.c} 行`,
    );
  });

  // ─────────────────────────────────────────────────────────────────
  // 7) 缺 / 空 message → 422（项目 parseBody 约定）
  // ─────────────────────────────────────────────────────────────────
  test('缺 message → 422', async () => {
    installFakeFetch([{ status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: 'x' } }] } }]);
    const res = await inject(fx.key, {});
    assert.equal(
      res.statusCode,
      422,
      `MUTATION? 缺 message 应 422，拿到 ${res.statusCode}: ${res.body}`,
    );
  });

  test('message 为空 → 422', async () => {
    installFakeFetch([{ status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: 'x' } }] } }]);
    const res = await inject(fx.key, { message: '' });
    assert.equal(
      res.statusCode,
      422,
      `MUTATION? message 空应 422，拿到 ${res.statusCode}: ${res.body}`,
    );
  });

  // ─────────────────────────────────────────────────────────────────
  // 8) 无凭据 → 401
  // ─────────────────────────────────────────────────────────────────
  test('无凭据 → 401', async () => {
    installFakeFetch([{ status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: 'x' } }] } }]);
    const res = await inject(null, { message: 'no auth' });
    assert.equal(
      res.statusCode,
      401,
      `MUTATION? 无凭据应 401，拿到 ${res.statusCode}: ${res.body}`,
    );
  });

  // ─────────────────────────────────────────────────────────────────
  // 9) 模型调用不可达（fetchImpl 抛）—— 不能 500 崩掉，要有归因错误状态
  // ─────────────────────────────────────────────────────────────────
  test('模型不可达 → 返回可归因错误（**不是**500）', async () => {
    // 用 `abort: true` 模拟上游不可达（fetchImpl 抛 AbortError）——
    // 模拟器侧 `setModelFetchImpl` 走 fakeFetch，需要让它抛。
    // 这里直接装一个抛的 fetchImpl：
    setModelFetchImpl(
      (async () => {
        throw new DOMException('This operation was aborted', 'AbortError');
      }) as typeof fetch,
    );

    const res = await inject(fx.key, { message: '调一下' });
    // 关键钉子：不崩成 500 才是路由层「模型挂了归因于上游、不归因于我」的产物。
    // 建议状态码：502 (Bad Gateway) —— 模型是第三方端点，比 503 更准确；
    // 或者 503 Service Unavailable 也可以。但绝不能 500，那是把上游问题当自己 bug。
    // 也不要 401 / 403 / 404：那是凭据/资源问题，跟模型无关。
    assert.notEqual(
      res.statusCode,
      500,
      `MUTATION? 模型挂了不该 5xx of self-bug，实际 ${res.statusCode}: ${res.body}`,
    );
    assert.notEqual(res.statusCode, 401);
    assert.notEqual(res.statusCode, 403);
    assert.notEqual(res.statusCode, 404);
    assert.ok(
      res.statusCode >= 400 && res.statusCode < 600,
      `MUTATION? 期望 4xx/5xx（带归因），实际 ${res.statusCode}: ${res.body}`,
    );
  });
});
