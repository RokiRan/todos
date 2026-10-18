/**
 * Agent memory REST 路由验证 —— 补齐 Web 端唯一缺的接口。
 *
 * 业务规则（与 services/chief-memory.ts 锁步）：
 *   - 团队归属：非该团队成员 → 403，且**先验归属再摸业务资源**（防 timing oracle）
 *   - agent 归属：team 内查无此 agent → 404，不暴露跨团队存在性
 *   - chief 归属：bound chief 反查失败 → 404（agent 在团队内但没 chief）
 *   - CRUD 闭环：POST → GET 能读到；DELETE → GET 读不到；DB 行真删
 *   - 跨团队写/读/删：MUTATION 验证 + 库取证
 *   - 凭据缺失 → 401（不靠 preHandler，自己现验；本路由可独立测）
 *
 * 不跑全量 typecheck/test；只跑这一文件。
 * 跨团队拒绝用例断言"agent_memory 多一行都没有"用本 fixture 名下 team_id 与 agent_id 限定。
 */
import assert from 'node:assert/strict';
import { test, describe, before, after, beforeEach } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import * as dbPkg from '@tds/db';
import { newId, now } from '../src/ids.js';
import { registerAgentMemoryRoutes } from '../src/routes/agent-memory.js';
import { generateApiKey } from '../src/crypto.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://tds@127.0.0.1:5433/tds';

let sql: postgres.Sql;
let app: FastifyInstance;
const fixtures: Fixture[] = [];

interface Fixture {
  userId: string;
  teamId: string;
  memberId: string;
  /** 该 team 下拥有的 agent（必被绑 chief） */
  agentId: string;
  /** 同 fixture 用户在该 team 的 chief，与 agent 锁对应 */
  chiefId: string;
  /** Bearer api_key.full（plaintext）—— 路由层走 bearer 鉴权 */
  key: string;
  /** 第 2 个团队，专供 cross-team 拒绝用例；ownTeamId ≠ otherTeamId */
  otherUserId: string;
  otherTeamId: string;
  otherMemberId: string;
  otherAgentId: string;
  /** 完全没绑 chief 的 agent —— 给「chief 缺失」用例 */
  orphanAgentId: string;
}

describe('agent memory REST', () => {
  before(async () => {
    sql = postgres(DATABASE_URL, { max: 1 });
    const db = drizzle(sql, { schema: dbPkg.schema });
    app = Fastify({ logger: false });
    registerAgentMemoryRoutes(app, db as never);
    await app.ready();
  });

  after(async () => {
    await cleanup();
    await app.close();
    await sql.end();
  });

  beforeEach(async () => {
    await cleanup();
    fixtures.length = 0;
  });

  async function cleanup(): Promise<void> {
    for (const f of fixtures) {
      // agent_memory.agent_id 强 FK 到 agent；audit_event 没强 FK。
      // 审计行也要清 —— 新增的「未绑 chief」用例会真写一条 memory_created，
      // 只按 team_id 删太晚（它在 agent 删之前就该没，否则 FK 报错）。
      await sql`delete from audit_event where payload->>'agentId' in (${f.agentId}, ${f.otherAgentId}, ${f.orphanAgentId})`;
      await sql`delete from agent_memory where agent_id in (${f.agentId}, ${f.otherAgentId}, ${f.orphanAgentId})`;
      await sql`delete from chief where agent_id = ${f.agentId}`;
      await sql`delete from chief where agent_id = ${f.otherAgentId}`;
      await sql`delete from chief where agent_id = ${f.orphanAgentId}`;
      await sql`delete from agent where id = ${f.orphanAgentId}`;
      await sql`delete from agent where id = ${f.agentId}`;
      await sql`delete from agent where id = ${f.otherAgentId}`;
      await sql`delete from member where team_id = ${f.teamId}`;
      await sql`delete from member where team_id = ${f.otherTeamId}`;
      await sql`delete from audit_event where team_id = ${f.teamId}`;
      await sql`delete from audit_event where team_id = ${f.otherTeamId}`;
      await sql`delete from team where id = ${f.teamId}`;
      await sql`delete from team where id = ${f.otherTeamId}`;
      await sql`delete from "user" where id = ${f.userId}`;
      await sql`delete from "user" where id = ${f.otherUserId}`;
      // api_key 行：按 user 清
      await sql`delete from api_key where user_id = ${f.userId}`;
      await sql`delete from api_key where user_id = ${f.otherUserId}`;
    }
  }

  async function seed(): Promise<Fixture> {
    const ts = now();
    const userId = newId();
    const teamId = newId();
    const memberId = newId();
    const agentId = newId();
    const chiefId = `chief-${userId}-${teamId}`;

    // second team（同 schema，全套成员 + agent）
    const otherUserId = newId();
    const otherTeamId = newId();
    const otherMemberId = newId();
    const otherAgentId = newId();

    const orphanAgentId = newId();

    await sql`insert into "user" (id,email,display_name,created_at,updated_at)
              values (${userId}, ${`agent-mem-${userId}@test.local`}, ${'me'}, ${ts}, ${ts})`;
    await sql`insert into team (id,name,plan,storage_quota,created_at)
              values (${teamId}, ${'agent-mem-home'}, 'free', 1073741824, ${ts})`;
    await sql`insert into member (id,team_id,actor_id,member_type,role,joined_at,v)
              values (${memberId}, ${teamId}, ${userId}, 'user', 'admin', ${ts}, 0)`;
    await sql`insert into agent (id,team_id,display_name,default_skill_ids,grants,
                                  active_task_count,created_at,updated_at)
              values (${agentId}, ${teamId}, ${'home-agent'},
                      ${'{}'}::text[], ${'{}'}::jsonb, 0, ${ts}, ${ts})`;
    // 用户在该 team 的 chief 与 agent 绑定 —— 这是路由反查 chiefId 的前提
    await sql`insert into chief (id,user_id,team_id,agent_id,created_at,updated_at)
              values (${chiefId}, ${userId}, ${teamId}, ${agentId}, ${ts}, ${ts})`;

    // 第 2 团队：同样建齐，并给一份独立 user 让 cross-team 测试清晰
    await sql`insert into "user" (id,email,display_name,created_at,updated_at)
              values (${otherUserId}, ${`agent-mem-other-${otherUserId}@test.local`},
                      ${'other'}, ${ts}, ${ts})`;
    await sql`insert into team (id,name,plan,storage_quota,created_at)
              values (${otherTeamId}, ${'agent-mem-other'}, 'free', 1073741824, ${ts})`;
    await sql`insert into member (id,team_id,actor_id,member_type,role,joined_at,v)
              values (${otherMemberId}, ${otherTeamId}, ${otherUserId}, 'user', 'admin',
                      ${ts}, 0)`;
    await sql`insert into agent (id,team_id,display_name,default_skill_ids,grants,
                                  active_task_count,created_at,updated_at)
              values (${otherAgentId}, ${otherTeamId}, ${'other-agent'},
                      ${'{}'}::text[], ${'{}'}::jsonb, 0, ${ts}, ${ts})`;

    // orphan：属于本团队但**没有 chief 行** —— 触发 resolveAgentInTeam 的 404
    await sql`insert into agent (id,team_id,display_name,default_skill_ids,grants,
                                  active_task_count,created_at,updated_at)
              values (${orphanAgentId}, ${teamId}, ${'orphan'},
                      ${'{}'}::text[], ${'{}'}::jsonb, 0, ${ts}, ${ts})`;

    // 两份 api_key —— 给 REST 走 Bearer
    const k1 = generateApiKey();
    await sql`insert into "api_key" (id,user_id,name,key_prefix,key_hash,scopes,created_at)
              values (${newId()}, ${userId}, ${'rest-home'},
                      ${k1.prefix}, ${k1.hash}, ${['*']}, ${ts})`;
    const k2 = generateApiKey();
    await sql`insert into "api_key" (id,user_id,name,key_prefix,key_hash,scopes,created_at)
              values (${newId()}, ${otherUserId}, ${'rest-other'},
                      ${k2.prefix}, ${k2.hash}, ${['*']}, ${ts})`;

    const f: Fixture = {
      userId,
      teamId,
      memberId,
      agentId,
      chiefId,
      key: k1.key,
      otherUserId,
      otherTeamId,
      otherMemberId,
      otherAgentId,
      orphanAgentId,
    };
    fixtures.push(f);
    return f;
  }

  // ─────────────────── 鉴权 ───────────────────

  test('无凭据 → 401；非团队成员 → 403 且库零写入', async () => {
    const f = await seed();

    // 1) 完全无 Authorization
    const noAuth = await app.inject({
      method: 'GET',
      url: `/api/teams/${f.teamId}/agents/${f.agentId}/memories`,
    });
    assert.equal(noAuth.statusCode, 401, '无凭据必须 401');

    // 2) 用 home key 打 other team 的 agent：必须 403（团队归属失败）
    const crossTeam = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'GET',
      url: `/api/teams/${f.otherTeamId}/agents/${f.otherAgentId}/memories`,
    });
    assert.equal(crossTeam.statusCode, 403, '不是该团队成员 → 403');

    // 跨团队拒绝后，对面 team 的 agent_memory 一行也不能写
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM agent_memory WHERE agent_id = ${f.otherAgentId}
    `;
    assert.equal(rows[0]!.n, 0, 'MUTATION? 跨团队读拒绝后对面库一行没写');
  });

  // 2026-10-17 修正：原先这里断言「没绑 chief 的 agent → 404」，理由是
  // 「agent 必然带 chief 行」。实测证伪 —— Web UI 通过 `agents-admin` 建的
  // agent **不建 chief 行**，于是用户在自己建的 agent 上打开 Memory tab 必然
  // 404，而端点本身完全正常。记忆按 `agent_id` 存，chiefId 只进审计 actorId，
  // 不参与归属判定，所以未绑定 chief 的 agent 必须**放行**。
  //
  // 这里钉的是修好后的行为：GET 返回 200 空列表，且能真的写入一条记忆。
  test('未绑 chief 的 agent → 200（Web 建的 agent 没有 chief 行，必须放行）', async () => {
    const f = await seed();
    const url = `/api/teams/${f.teamId}/agents/${f.orphanAgentId}/memories`;

    const list = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'GET',
      url,
    });
    assert.equal(list.statusCode, 200, '没 chief 绑定也要能读（列表）');
    assert.deepEqual(list.json(), { memories: [] });

    const create = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      payload: { title: 'no-chief-key', content: '仍然能写', scope: 'team' },
      url,
    });
    assert.equal(create.statusCode, 200, '没 chief 绑定也要能写');
    assert.equal(create.json().memory.title, 'no-chief-key');

    // 审计必须有真实 actor：chiefId 为 null 时落 userId，而不是 null
    const rows = await sql`
      SELECT actor_type, actor_id FROM audit_event
      WHERE type = 'memory_created' AND payload->>'agentId' = ${f.orphanAgentId}
      ORDER BY created_at DESC LIMIT 1
    `;
    assert.equal(rows.length, 1, '应恰好一条 memory_created 审计');
    assert.equal(rows[0]!.actor_type, 'user', '没有 chief 时 actorType 走 user');
    assert.equal(rows[0]!.actor_id, f.userId, 'actorId 应落真实操作者 userId');
  });

  test('不存在的 agent → 404', async () => {
    const f = await seed();
    const res = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'GET',
      url: `/api/teams/${f.teamId}/agents/nope-not-real/memories`,
    });
    assert.equal(res.statusCode, 404);
  });

  // ─────────────────── CRUD 闭环 ───────────────────

  test('POST 创建 → GET 读得到 → DELETE → GET 读不到 + DB 行真删', async () => {
    const f = await seed();

    // 1) 创建
    const created = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/agents/${f.agentId}/memories`,
      payload: {
        userId: f.userId,
        title: 'release-tag-rule',
        content: 'always cut a tag and merge to main, no force-push',
        scope: 'team',
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    const parsed = JSON.parse(created.body) as { memory: { id: string; title: string; agentId: string; createdAt: number } };
    assert.ok(parsed.memory.id);
    assert.equal(parsed.memory.title, 'release-tag-rule');
    assert.equal(parsed.memory.agentId, f.agentId);

    // DB 取证：确实落表
    const row = (await sql<{ id: string; title: string }[]>`
      SELECT id, title FROM agent_memory WHERE id = ${parsed.memory.id}
    `)[0];
    assert.ok(row, 'agent_memory 真落了一行');
    assert.equal(row!.title, 'release-tag-rule');

    // audit_event 也落了
    const audit = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_event
       WHERE team_id = ${f.teamId}
         AND actor_type = 'chief'
         AND actor_id = ${f.chiefId}
         AND type = 'memory_created'
    `;
    assert.equal(audit[0]!.n, 1, 'memory_created 审计应落一条');

    // 2) GET 读得到
    const list = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'GET',
      url: `/api/teams/${f.teamId}/agents/${f.agentId}/memories`,
    });
    assert.equal(list.statusCode, 200);
    const listBody = JSON.parse(list.body) as { memories: Array<{ id: string; title: string }> };
    assert.equal(listBody.memories.length, 1);
    assert.equal(listBody.memories[0]!.id, parsed.memory.id);

    // 3) DELETE
    const del = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'DELETE',
      url: `/api/teams/${f.teamId}/agents/${f.agentId}/memories/${parsed.memory.id}`,
      payload: { userId: f.userId },
    });
    assert.equal(del.statusCode, 200, del.body);
    const delBody = JSON.parse(del.body) as { ok: boolean; deleted: string };
    assert.equal(delBody.ok, true);
    assert.equal(delBody.deleted, parsed.memory.id);

    // DB 真删
    const after = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM agent_memory WHERE id = ${parsed.memory.id}
    `;
    assert.equal(after[0]!.n, 0, 'MUTATION? delete 后 agent_memory 那行真的没了');

    // 4) GET 再读为空
    const listAfter = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'GET',
      url: `/api/teams/${f.teamId}/agents/${f.agentId}/memories`,
    });
    const listAfterBody = JSON.parse(listAfter.body) as { memories: unknown[] };
    assert.equal(listAfterBody.memories.length, 0);
  });

  test('POST 同 title 第二次 → upsert 不是双行', async () => {
    const f = await seed();

    const first = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/agents/${f.agentId}/memories`,
      payload: { userId: f.userId, title: 'lesson', content: 'old content', scope: 'team' },
    });
    assert.equal(first.statusCode, 200);
    const firstId = (JSON.parse(first.body) as { memory: { id: string } }).memory.id;

    const second = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/agents/${f.agentId}/memories`,
      payload: { userId: f.userId, title: 'lesson', content: 'new content', scope: 'team' },
    });
    assert.equal(second.statusCode, 200, second.body);
    const secondId = (JSON.parse(second.body) as { memory: { id: string; content: string } }).memory.id;
    assert.equal(secondId, firstId, 'upsert：id 保持稳定');
    assert.equal((JSON.parse(second.body) as { memory: { content: string } }).memory.content, 'new content');

    // DB 上确实只有一行
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM agent_memory
       WHERE agent_id = ${f.agentId} AND title = ${'lesson'}
    `;
    assert.equal(rows[0]!.n, 1, 'upsert by title → 一行不是两行');
  });

  // ─────────────────── 跨团队拒绝 ───────────────────

  test('用 home key 给 other agent 写 → 403 且其它 team 库零写入', async () => {
    const f = await seed();
    // 关键攻击：userId 真 = f.userId（路由会真过站），但 agent 是别人的
    const res = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.otherTeamId}/agents/${f.otherAgentId}/memories`,
      payload: {
        userId: f.userId,
        title: 'leak',
        content: 'cross-team write',
        scope: 'team',
      },
    });
    assert.equal(res.statusCode, 403, 'MUTATION? 跨团队必须 403');
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM agent_memory
       WHERE agent_id = ${f.otherAgentId} AND title = ${'leak'}
    `;
    assert.equal(rows[0]!.n, 0, 'MUTATION? 跨团队拒绝后其他 team 库一行没写');
  });

  test('home key 试图删除 other agent 的记忆 → 403 + DB 行不动', async () => {
    const f = await seed();
    // 先用 other team 自己的 key 在对面 agent 上落一条记忆（不通过我们的路由，
    // 直接 SQL，避免污染"被测路由"）
    const memoryId = newId();
    const ts = now();
    await sql`insert into agent_memory (id,agent_id,scope,title,content,expires_at,created_at,updated_at)
              values (${memoryId}, ${f.otherAgentId}, 'team',
                      ${'other-secret'}, ${'do-not-touch'}, NULL, ${ts}, ${ts})`;

    const res = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'DELETE',
      url: `/api/teams/${f.otherTeamId}/agents/${f.otherAgentId}/memories/${memoryId}`,
      payload: { userId: f.userId },
    });
    assert.equal(res.statusCode, 403);

    // 那条其它 team 的记忆还在
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM agent_memory WHERE id = ${memoryId}
    `;
    assert.equal(rows.length, 1, 'MUTATION? 跨团队删除被拒；原行不动');
  });

  // ─────────────────── 校验 ───────────────────

  test('title 空串 → 422；凭据形态 → 422；unknown memoryId → 404', async () => {
    const f = await seed();

    // title 缺
    const empty = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/agents/${f.agentId}/memories`,
      payload: { userId: f.userId, title: '', content: 'x', scope: 'team' },
    });
    assert.equal(empty.statusCode, 422);

    // 凭据拦截（服务层 validateMemory 接管，但要通到 422）
    const leak = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/agents/${f.agentId}/memories`,
      payload: {
        userId: f.userId,
        title: 'oops',
        content: 'api_key=supersecretvalue12345',
        scope: 'team',
      },
    });
    assert.equal(leak.statusCode, 422, '凭据形态必须 422');
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM agent_memory WHERE agent_id = ${f.agentId}
    `;
    assert.equal(rows[0]!.n, 0, 'MUTATION? 422 后不写库');

    // 编辑不存在 memoryId → 404
    const missing = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/agents/${f.agentId}/memories`,
      payload: {
        userId: f.userId,
        title: 'whatever',
        content: 'whatever',
        scope: 'team',
        memoryId: 'nope-not-real',
      },
    });
    assert.equal(missing.statusCode, 404, '不存在的 memoryId 编辑 → 404');
  });

  test('空的 GET → {memories:[]}（不报错，不 404）', async () => {
    const f = await seed();
    const res = await app.inject({
      headers: { authorization: `Bearer ${f.key}` },
      method: 'GET',
      url: `/api/teams/${f.teamId}/agents/${f.agentId}/memories`,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { memories: unknown[] };
    assert.deepEqual(body.memories, []);
  });
});
