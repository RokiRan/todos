import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import * as dbPkg from '@tds/db';
import { newId, now } from '../src/ids.js';
import { generateApiKey } from '../src/crypto.js';
import { registerChiefRoutes } from '../src/routes/chief.js';
import { registerMcpRoutes } from '../src/routes/mcp.js';
import { CHIEF_TOOLS } from '../src/chief/tools.js';

/**
 * Chief 工具的 HTTP 入口验证（真库 + `app.inject`）。
 *
 * 服务层测试证明「规则对」，executor 测试证明「闸门对」，这里证明**接得上**：
 *   1. `GET /api/chief/tools` —— 工具面清单，58 个，且 `wired` 字段能区分
 *      「已接线 / 走 MCP / 真缺口」三类
 *   2. `POST /api/chief/tools/:name` —— 身份只能来自凭据，**客户端传的 teamId
 *      若不是自己的团队一律 403**（这是越权写入的主要入口）
 *   3. 不可逆工具经 HTTP 调用**永远拿不到 confirmedTools** —— 端点不接受
 *      客户端自称「已确认」，否则确认闸门形同虚设
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://tds@127.0.0.1:5433/tds';

let sql: postgres.Sql;
let app: FastifyInstance;
let fx: {
  userId: string; teamId: string; memberId: string; otherUserId: string; otherTeamId: string;
  key: string; otherKey: string;
};

describe('Chief 工具 HTTP 入口', () => {
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
    const otherUserId = newId();
    const otherTeamId = newId();
    const chiefA = `chief-${userId}-${teamId}`;
    const chiefB = `chief-${otherUserId}-${otherTeamId}`;

    // 逐条 insert，**不**用 `sql.begin` 包事务：postgres.js 在事务回调里
    // 用 `for...of` 跑多个模板查询会与外层池竞争连接，fixture 阶段就挂住
    // （实测卡在 seed，整文件全部 cancelled）。测试 fixture 不需要原子性 ——
    // 清理走 `after`，残留风险由唯一 id 兜底。
    const users = [[userId, 'chief-http'], [otherUserId, 'chief-http-b']] as const;
    for (const [uid, label] of users) {
      await sql`insert into "user" (id,email,display_name,status,locale,created_at,updated_at)
                values (${uid}, ${label + '-' + uid + '@test.local'}, ${label}, 'active', 'en', ${ts}, ${ts})`;
    }
    for (const tid of [teamId, otherTeamId]) {
      await sql`insert into team (id,name,plan,storage_quota,created_at)
                values (${tid}, ${'chief-http-' + tid}, 'free', 1073741824, ${ts})`;
    }
    await sql`insert into "member" (id,team_id,actor_id,member_type,role,joined_at,v)
              values (${memberId}, ${teamId}, ${userId}, 'user', 'admin', ${ts}, 0)`;
    await sql`insert into "member" (id,team_id,actor_id,member_type,role,joined_at,v)
              values (${newId()}, ${otherTeamId}, ${otherUserId}, 'user', 'admin', ${ts}, 0)`;
    // Chief 路由要求 Chief 已存在（chiefIdFor 查不到就 403），Chief 又要求该团队
    // 至少有一个 agent —— 两个都建。
    const agentA = newId();
    const agentB = newId();
    await sql`insert into agent (id,team_id,display_name,default_skill_ids,grants,active_task_count,created_at,updated_at)
              values (${agentA}, ${teamId}, 'chief-http agent', '{}', '{}'::jsonb, 0, ${ts}, ${ts})`;
    await sql`insert into agent (id,team_id,display_name,default_skill_ids,grants,active_task_count,created_at,updated_at)
              values (${agentB}, ${otherTeamId}, 'chief-http agent b', '{}', '{}'::jsonb, 0, ${ts}, ${ts})`;
    await sql`insert into chief (id,user_id,team_id,agent_id,charter,created_at,updated_at)
              values (${chiefA}, ${userId}, ${teamId}, ${agentA}, 'test', ${ts}, ${ts})`;
    await sql`insert into chief (id,user_id,team_id,agent_id,charter,created_at,updated_at)
              values (${chiefB}, ${otherUserId}, ${otherTeamId}, ${agentB}, 'test', ${ts}, ${ts})`;

    const k1 = generateApiKey();
    const k2 = generateApiKey();
    await sql`insert into api_key (id,user_id,name,key_prefix,key_hash,scopes,created_at)
              values (${newId()}, ${userId}, 'chief-http', ${k1.prefix}, ${k1.hash}, ${['tool:write']}, ${ts})`;
    await sql`insert into api_key (id,user_id,name,key_prefix,key_hash,scopes,created_at)
              values (${newId()}, ${otherUserId}, 'chief-http-b', ${k2.prefix}, ${k2.hash}, ${['tool:write']}, ${ts})`;

    fx = { userId, teamId, memberId, otherUserId, otherTeamId, key: k1.key, otherKey: k2.key };
  });

  after(async () => {
    for (const tid of [fx.teamId, fx.otherTeamId]) {
      await sql`delete from sse_event where team_id = ${tid}`;
      await sql`delete from audit_event where team_id = ${tid}`;
      await sql`delete from chief where team_id = ${tid}`;
      await sql`delete from agent where team_id = ${tid}`;
      await sql`delete from project where team_id = ${tid}`;
    }
    await sql`delete from api_key where user_id in (${fx.userId}, ${fx.otherUserId})`;
    await sql`delete from "member" where team_id in (${fx.teamId}, ${fx.otherTeamId})`;
    await sql`delete from team where id in (${fx.teamId}, ${fx.otherTeamId})`;
    await sql`delete from "user" where id in (${fx.userId}, ${fx.otherUserId})`;
    await app.close();
    await sql.end();
  });

  async function inject(key: string, url: string, payload?: unknown) {
    return app.inject({
      method: payload === undefined ? 'GET' : 'POST',
      url,
      headers: { authorization: `Bearer ${key}` },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  }

  // ── 工具面清单 ──────────────────────────────────────────────────────
  test('GET /api/chief/tools：58 个，且 wired 区分三类', async () => {
    const res = await inject(fx.key, '/api/chief/tools');
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as {
      tools: Array<{ name: string; group: string; irreversible: boolean; wired: boolean }>;
      count: number;
    };
    assert.equal(body.count, 58, 'MUTATION? Chief 工具面数变了');
    assert.equal(body.tools.length, CHIEF_TOOLS.length);

    const wired = body.tools.filter((t) => t.wired).map((t) => t.name);
    assert.ok(wired.includes('create_agent'), 'MUTATION? create_agent 应显示已接线');
    // MCP 面上的工具不该显示为「本 registry 已接线」
    assert.ok(!wired.includes('todos'), 'MUTATION? MCP 面上的工具不该显示为「本 registry 已接线」');
    // **真缺口归零**（2026-07-17 补完最后 6 个之后）
    assert.equal(wired.length, 27, `MUTATION? Chief 专属应全部接线（27），实际 ${wired.length}`);
    assert.ok(wired.includes('providers'), 'MUTATION? providers 应已接线');

    // 不可逆标记要带出来，UI 才知道弹哪种卡
    const delAgents = body.tools.find((t) => t.name === 'delete_agents');
    assert.equal(delAgents?.irreversible, true);
  });

  test('GET /api/chief/tools 无凭据 → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/chief/tools' });
    assert.equal(res.statusCode, 401, `MUTATION? 工具面清单不该匿名可读：${res.statusCode}`);
  });

  // ── 执行入口 ────────────────────────────────────────────────────────
  test('POST 工具：teamId 不是自己的团队 → 403 且库里未写', async () => {
    // 用 A 的 key 打 B 的 teamId —— 越权写入的主要入口
    const before = await sql`select count(*)::int as c from agent where team_id = ${fx.otherTeamId}`;
    const res = await inject(fx.key, '/api/chief/tools/create_agent', {
      teamId: fx.otherTeamId,
      args: { displayName: 'should-not-exist' },
    });
    assert.equal(res.statusCode, 403, `MUTATION? 越权没被挡：${res.statusCode} ${res.body}`);
    // 用「调用前后行数不变」而不是「绝对为 0」—— fixture 自己在 otherTeamId 里
    // 建过一个 agent（Chief 要求团队有 agent），断言 0 会与 fixture 自相矛盾。
    const after = await sql`select count(*)::int as c from agent where team_id = ${fx.otherTeamId}`;
    assert.equal(after[0]?.c, before[0]?.c, 'MUTATION? 越权却建了 agent');
    const named = await sql`select 1 from agent where display_name = 'should-not-exist'`;
    assert.equal(named.length, 0, 'MUTATION? 越权建出了那个具名 agent');
  });

  test('POST 不可逆工具：端点不接受自称「已确认」，一律被拒', async () => {
    const res = await inject(fx.key, '/api/chief/tools/delete_agents', {
      teamId: fx.teamId,
      args: { agentIds: ['whatever'] },
      // 即便客户端自称确认过也不认 —— 确认必须走 card 状态机
      confirmedTools: ['delete_agents'],
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as { outcome: { ok: boolean; reason?: string } };
    assert.equal(body.outcome.ok, false, 'MUTATION? 不可逆工具经 HTTP 直接执行了');
    assert.match(body.outcome.reason ?? '', /irreversible/);
  });

  test('POST 未知工具：措辞说「不存在」且带出 Chief 的工具数', async () => {
    const res = await inject(fx.key, '/api/chief/tools/no_such_tool', { teamId: fx.teamId, args: {} });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as { outcome: { ok: boolean; reason?: string } };
    assert.equal(body.outcome.ok, false);
    assert.match(body.outcome.reason ?? '', /does not exist/);
    assert.match(body.outcome.reason ?? '', /58/, 'MUTATION? 应告诉 Chief 这个面有多大');
  });

  test('POST 已接线的工具：参数对就真执行（create_agent 探针）', async () => {
    const res = await inject(fx.key, '/api/chief/tools/create_agent', {
      teamId: fx.teamId,
      args: { displayName: 'http-probe-agent' },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as { outcome: { ok: boolean; result?: { id?: string }; reason?: string } };
    assert.equal(body.outcome.ok, true, `已接线工具被拒：${body.outcome.reason}`);
    assert.ok(body.outcome.result?.id, 'MUTATION? 没拿到建好的 agent id');
    const rows = await sql`select id, team_id from agent where id = ${body.outcome.result?.id}`;
    assert.equal(rows.length, 1, 'MUTATION? agent 没真落库');
    assert.equal(rows[0]?.team_id, fx.teamId, 'MUTATION? 建到了别的团队');
  });

  test('POST 参数不对：回 invalid arguments，不是 500', async () => {
    const res = await inject(fx.key, '/api/chief/tools/create_agent', {
      teamId: fx.teamId,
      args: {},   // 缺 displayName
    });
    assert.equal(res.statusCode, 200, `MUTATION? 参数错误不该是 HTTP 错误：${res.statusCode} ${res.body}`);
    const body = JSON.parse(res.body) as { outcome: { ok: boolean; reason?: string } };
    assert.equal(body.outcome.ok, false);
    assert.match(body.outcome.reason ?? '', /invalid arguments/);
    assert.match(body.outcome.reason ?? '', /displayName/);
  });

  test('POST 缺 teamId：422（入参 schema 直接拒，走 parseBody 约定）', async () => {
    const res = await inject(fx.key, '/api/chief/tools/create_agent', { args: { displayName: 'x' } });
    // 422 是本文件既有的入参约定（`parseBody` 统一抛 422），不是 400。
    assert.equal(res.statusCode, 422, `MUTATION? 缺 teamId 的状态码不对：${res.statusCode} ${res.body}`);
  });

  test('B 的 key 打 B 的 teamId 可以成功（正向对照）', async () => {
    const res = await inject(fx.otherKey, '/api/chief/tools/create_agent', {
      teamId: fx.otherTeamId,
      args: { displayName: 'other-team-agent' },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as { outcome: { ok: boolean; reason?: string } };
    assert.equal(body.outcome.ok, true, `自己团队反而失败：${body.outcome.reason}`);
  });
});
