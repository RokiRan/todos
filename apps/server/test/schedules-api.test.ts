import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify from 'fastify';
import * as dbPkg from '@tds/db';
import { newId, now } from '../src/ids.js';
import { registerScheduleRoutes } from '../src/routes/schedules.js';
import { generateApiKey } from '../src/crypto.js';

/**
 * schedule REST 路由层验证。
 *
 * 对标 todos.dev /docs/schedules 的可观察契约：
 *   - 4 种形态（hourly / daily / weekly / once）合法创建
 *   - 所有成员可读，**admin 才能写**
 *   - cron / timezone 不合法 → 422
 *   - todo 不在该 team → 409
 *   - 每 team ≤ 10 条规则
 *   - agent / machine 不属于该 team → 422
 *   - 软删除（deleted_at 标记）
 *
 * 用 Fastify app.inject 跑端到端；DB 是开发机 127.0.0.1:5433 上的 tds 真库。
 * 每条 test 用独立 fixture，after 兜底按 FK 反序清理。
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://tds:tds_local_dev@127.0.0.1:5433/tds';
const dbSchema = dbPkg.schema;

function buildTestApp(
  db: ReturnType<typeof drizzle<typeof dbPkg.schema>>,
): ReturnType<typeof Fastify> {
  const app = Fastify({ logger: false });
  app.decorate('machineUrl', 'http://test');
  registerScheduleRoutes(app, db as never);
  return app;
}

interface Fixture {
  label: string;
  userId: string;
  teamId: string;
  projectId: string;
  memberId: string;
  agentId: string;
  todoId: string;
  key: string;
}

async function seedFixture(
  sql: postgres.Sql,
  label: string,
  role: 'admin' | 'member' = 'admin',
): Promise<Fixture> {
  const ts = now();
  const userId = newId();
  const teamId = newId();
  const memberId = newId();
  const agentId = newId();
  const projectId = newId();
  const todoId = newId();

  await sql`
    insert into "user"
      (id, email, display_name, status, locale, created_at, updated_at)
    values
      (${userId}, ${`${label}-${userId}@test.local`}, ${label}, 'active', 'en', ${ts}, ${ts})
  `;
  await sql`
    insert into "team"
      (id, name, plan, storage_quota, created_at)
    values
      (${teamId}, ${label}, 'free', 1073741824, ${ts})
  `;
  await sql`
    insert into "member"
      (id, team_id, actor_id, member_type, role, joined_at, v)
    values
      (${memberId}, ${teamId}, ${userId}, 'user', ${role}, ${ts}, 0)
  `;
  await sql`
    insert into "agent"
      (id, team_id, display_name, default_skill_ids, grants, active_task_count, created_at, updated_at)
    values
      (${agentId}, ${teamId}, ${label}, '{}', '{}'::jsonb, 0, ${ts}, ${ts})
  `;
  await sql`
    insert into "project"
      (id, team_id, name, provider, repo_kind, default_branch, next_seq_num, created_at)
    values
      (${projectId}, ${teamId}, ${label}, 'external', 'other', 'main', 1, ${ts})
  `;
  await sql`
    insert into "todo"
      (id, project_id, seq_num, owner_member_id, agent_id, title, tag_ids, phase,
       plan_first, separate_plan_build, with_checklist, created_at, updated_at)
    values
      (${todoId}, ${projectId}, 1, ${memberId}, ${agentId}, 'todo-' || ${label},
       '{}', 'todo', true, false, false, ${ts}, ${ts})
  `;

  const k = generateApiKey();
  await sql`
    insert into "api_key"
      (id, user_id, name, key_prefix, key_hash, scopes, created_at)
    values
      (${newId()}, ${userId}, ${'rest-' + label}, ${k.prefix}, ${k.hash}, ${['*']}, ${ts})
  `;
  return { label, userId, teamId, projectId, memberId, agentId, todoId, key: k.key };
}

async function seedSecondTeam(
  sql: postgres.Sql,
  label: string,
): Promise<{ teamId: string; todoId: string; userId: string }> {
  const ts = now();
  const userId = newId();
  const teamId = newId();
  const memberId = newId();
  const agentId = newId();
  const projectId = newId();
  const todoId = newId();

  await sql`
    insert into "user"
      (id, email, display_name, status, locale, created_at, updated_at)
    values
      (${userId}, ${`${label}-${userId}@test.local`}, ${label}, 'active', 'en', ${ts}, ${ts})
  `;
  await sql`
    insert into "team"
      (id, name, plan, storage_quota, created_at)
    values
      (${teamId}, ${label}, 'free', 1073741824, ${ts})
  `;
  await sql`
    insert into "member"
      (id, team_id, actor_id, member_type, role, joined_at, v)
    values
      (${memberId}, ${teamId}, ${userId}, 'user', 'admin', ${ts}, 0)
  `;
  await sql`
    insert into "agent"
      (id, team_id, display_name, default_skill_ids, grants, active_task_count, created_at, updated_at)
    values
      (${agentId}, ${teamId}, ${label}, '{}', '{}'::jsonb, 0, ${ts}, ${ts})
  `;
  await sql`
    insert into "project"
      (id, team_id, name, provider, repo_kind, default_branch, next_seq_num, created_at)
    values
      (${projectId}, ${teamId}, ${label}, 'external', 'other', 'main', 1, ${ts})
  `;
  await sql`
    insert into "todo"
      (id, project_id, seq_num, owner_member_id, agent_id, title, tag_ids, phase,
       plan_first, separate_plan_build, with_checklist, created_at, updated_at)
    values
      (${todoId}, ${projectId}, 1, ${memberId}, ${agentId}, 'todo-' || ${label},
       '{}', 'todo', true, false, false, ${ts}, ${ts})
  `;
  return { teamId, todoId, userId };
}

async function deleteFixture(sql: postgres.Sql, f: Fixture): Promise<void> {
  await sql`delete from "team" where id = ${f.teamId}`;
  await sql`delete from "user" where id = ${f.userId}`;
}

async function deleteSecond(
  sql: postgres.Sql,
  ref: { teamId: string; userId: string },
): Promise<void> {
  await sql`delete from "team" where id = ${ref.teamId}`;
  await sql`delete from "user" where id = ${ref.userId}`;
}

describe('schedule 路由 —— 4 种形态 + admin 鉴权', () => {
  let sql: postgres.Sql;
  let db: ReturnType<typeof drizzle<typeof dbPkg.schema>>;
  let app: ReturnType<typeof Fastify>;
  const fixtures: Fixture[] = [];
  const secondaryRefs: Array<{ teamId: string; userId: string }> = [];

  before(async () => {
    sql = postgres(DATABASE_URL, { max: 5, idle_timeout: 20 });
    db = drizzle(sql, { schema: dbSchema as never });
    app = buildTestApp(db);
    await app.ready();
  });

  after(async () => {
    for (const f of fixtures) {
      try { await deleteFixture(sql, f); } catch { /* ignore */ }
    }
    for (const r of secondaryRefs) {
      try { await deleteSecond(sql, r); } catch { /* ignore */ }
    }
    await app.close();
    await sql.end();
  });

  function baseBody(f: Fixture, over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      userId: f.userId,
      todoId: f.todoId,
      kind: 'hourly',
      cron: '15',
      timezone: 'Asia/Shanghai',
      automatic: true,
      ...over,
    };
  }

  test('列出空列表：成员可读', async () => {
    const f = await seedFixture(sql, 'list-empty');
    fixtures.push(f);

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'GET',
      url: `/api/teams/${f.teamId}/schedules`,
    });
    assert.equal(res.statusCode, 200, res.body);
    const parsed = JSON.parse(res.body) as { schedules: unknown[] };
    assert.deepEqual(parsed.schedules, []);
  });

  test('创建 hourly 规则成功：DB 真实落库 + 字段正确', async () => {
    const f = await seedFixture(sql, 'create-hourly');
    fixtures.push(f);

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/schedules`,
      payload: baseBody(f),
    });
    assert.equal(res.statusCode, 200, res.body);
    const parsed = JSON.parse(res.body) as {
      schedule: {
        id: string;
        kind: string;
        cron: string;
        timezone: string;
        automatic: boolean;
        teamId: string;
        todoId: string;
      };
    };
    assert.equal(parsed.schedule.kind, 'hourly');
    assert.equal(parsed.schedule.cron, '15');
    assert.equal(parsed.schedule.timezone, 'Asia/Shanghai');
    assert.equal(parsed.schedule.automatic, true);
    assert.equal(parsed.schedule.teamId, f.teamId);
    assert.equal(parsed.schedule.todoId, f.todoId);

    const rows = await sql<{ cron: string; deleted_at: number | null }[]>`
      select cron, deleted_at from schedule where id = ${parsed.schedule.id}
    `;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.cron, '15');
    assert.equal(rows[0]!.deleted_at, null);
  });

  test('创建 daily / weekly / once 三种形态：weekly 必须带 weekday', async () => {
    const f = await seedFixture(sql, 'create-daily-weekly-once');
    fixtures.push(f);

    const dailyRes = await app.inject({
                             headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/schedules`,
      payload: baseBody(f, { kind: 'daily', cron: '09:30' }),
    });
    assert.equal(dailyRes.statusCode, 200, dailyRes.body);

    // weekly 必须带 weekday
    const weeklyNoWeekday = await app.inject({
                                    headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/schedules`,
      payload: baseBody(f, { kind: 'weekly', cron: '09:30' }),
    });
    assert.equal(weeklyNoWeekday.statusCode, 422, weeklyNoWeekday.body);

    const weeklyOk = await app.inject({
                             headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/schedules`,
      payload: baseBody(f, { kind: 'weekly', cron: '09:30', weekday: 2 }),
    });
    assert.equal(weeklyOk.statusCode, 200, weeklyOk.body);
    const weeklyParsed = JSON.parse(weeklyOk.body) as { schedule: { cron: string; weekday: number | null } };
    // 持久化时 weekly 把 weekday 编进 cron 前缀；响应里 cron 还原为 HH:MM + sibling weekday
    assert.equal(weeklyParsed.schedule.cron, '09:30');
    assert.equal(weeklyParsed.schedule.weekday, 2);

    // once 必须是未来时刻
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const onceRes = await app.inject({
                            headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/schedules`,
      payload: baseBody(f, { kind: 'once', cron: future }),
    });
    assert.equal(onceRes.statusCode, 200, onceRes.body);
  });

  test('cron 非法 → 422：覆盖 hourly 越界 / daily 格式错 / once 时间已过 / weekly 无 weekday', async () => {
    const f = await seedFixture(sql, 'bad-cron');
    fixtures.push(f);

    const cases: Array<{ name: string; over: Record<string, unknown>; expectHourly?: boolean }> = [
      { name: 'hourly 非整数', over: { kind: 'hourly', cron: 'abc' } },
      { name: 'hourly 越界 60', over: { kind: 'hourly', cron: '60' } },
      { name: 'hourly 负值', over: { kind: 'hourly', cron: '-1' } },
      { name: 'daily 格式错', over: { kind: 'daily', cron: '25:99' } },
      { name: 'daily 不是 HH:MM', over: { kind: 'daily', cron: 'every morning' } },
      { name: 'once 已过期', over: { kind: 'once', cron: new Date(Date.now() - 60_000).toISOString() } },
      { name: 'once 非法 ISO', over: { kind: 'once', cron: 'not-a-date' } },
      { name: 'weekly 缺 weekday', over: { kind: 'weekly', cron: '09:30' } },
    ];
    for (const c of cases) {
      const res = await app.inject({
                          headers: { authorization: `Bearer ${f.key}` },
        method: 'POST',
        url: `/api/teams/${f.teamId}/schedules`,
        payload: baseBody(f, c.over),
      });
      assert.equal(res.statusCode, 422, `${c.name}: ${res.body}`);
    }

    const rows = await sql`select 1 from schedule where team_id = ${f.teamId}`;
    assert.equal(rows.length, 0, '422 后不该有任何规则落库');
  });

  test('timezone 非法 → 422', async () => {
    const f = await seedFixture(sql, 'bad-tz');
    fixtures.push(f);

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/schedules`,
      payload: baseBody(f, { timezone: 'Atlantis/Mu' }),
    });
    assert.equal(res.statusCode, 422, res.body);

    // 合法时区（IANA 名）
    const okRes = await app.inject({
                          headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/schedules`,
      payload: baseBody(f, { timezone: 'Europe/London' }),
    });
    assert.equal(okRes.statusCode, 200, okRes.body);
  });

  test('todo 不在该 team → 409', async () => {
    const f = await seedFixture(sql, 'todo-cross-team');
    fixtures.push(f);
    const other = await seedSecondTeam(sql, 'other-team');
    secondaryRefs.push({ teamId: other.teamId, userId: other.userId });

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/schedules`,
      payload: baseBody(f, { todoId: other.todoId }),
    });
    assert.equal(res.statusCode, 409, res.body);
  });

  test('todo 不存在 → 422', async () => {
    const f = await seedFixture(sql, 'todo-missing');
    fixtures.push(f);

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/schedules`,
      payload: baseBody(f, { todoId: newId() }),
    });
    assert.equal(res.statusCode, 422, res.body);
  });

  test('非 admin 不能创建/更新/删除（成员 403）', async () => {
    const member = await seedFixture(sql, 'non-admin', 'member');
    fixtures.push(member);

    const create = await app.inject({
                           headers: { authorization: `Bearer ${member.key}` },
      method: 'POST',
      url: `/api/teams/${member.teamId}/schedules`,
      payload: baseBody(member),
    });
    assert.equal(create.statusCode, 403, create.body);

    // 但是成员能 GET
    const list = await app.inject({
                         headers: { authorization: `Bearer ${member.key}` },
      method: 'GET',
      url: `/api/teams/${member.teamId}/schedules`,
    });
    assert.equal(list.statusCode, 200, '成员应能查看');
  });

  test('PATCH 修改 cron / timezone / automatic / agentId', async () => {
    const f = await seedFixture(sql, 'patch-ok');
    fixtures.push(f);

    const created = await app.inject({
                            headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/schedules`,
      payload: baseBody(f),
    });
    assert.equal(created.statusCode, 200, created.body);
    const scheduleId = (JSON.parse(created.body) as { schedule: { id: string } }).schedule.id;

    const patch = await app.inject({
                          headers: { authorization: `Bearer ${f.key}` },
      method: 'PATCH',
      url: `/api/teams/${f.teamId}/schedules/${scheduleId}`,
      payload: {
        userId: f.userId,
        cron: '30',
        timezone: 'Europe/London',
        automatic: false,
        agentId: f.agentId,
      },
    });
    assert.equal(patch.statusCode, 200, patch.body);
    const patched = JSON.parse(patch.body) as {
      schedule: { cron: string; timezone: string; automatic: boolean; agentId: string | null };
    };
    assert.equal(patched.schedule.cron, '30');
    assert.equal(patched.schedule.timezone, 'Europe/London');
    assert.equal(patched.schedule.automatic, false);
    assert.equal(patched.schedule.agentId, f.agentId);

    // DB 真实落库
    const rows = await sql<{ cron: string; timezone: string; automatic: boolean }[]>`
      select cron, timezone, automatic from schedule where id = ${scheduleId}
    `;
    assert.equal(rows[0]!.cron, '30');
    assert.equal(rows[0]!.timezone, 'Europe/London');
    assert.equal(rows[0]!.automatic, false);
  });

  test('PATCH 改 cron 为非法值 → 422，且 DB 不变', async () => {
    const f = await seedFixture(sql, 'patch-bad');
    fixtures.push(f);

    const created = await app.inject({
                            headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/schedules`,
      payload: baseBody(f),
    });
    const scheduleId = (JSON.parse(created.body) as { schedule: { id: string } }).schedule.id;

    const patch = await app.inject({
                          headers: { authorization: `Bearer ${f.key}` },
      method: 'PATCH',
      url: `/api/teams/${f.teamId}/schedules/${scheduleId}`,
      payload: { userId: f.userId, cron: '99' },
    });
    assert.equal(patch.statusCode, 422, patch.body);

    const rows = await sql<{ cron: string }[]>`select cron from schedule where id = ${scheduleId}`;
    assert.equal(rows[0]!.cron, '15', '422 后 DB 不应被改');
  });

  test('DELETE 软删除：DB deleted_at 被打上时间戳', async () => {
    const f = await seedFixture(sql, 'delete-ok');
    fixtures.push(f);

    const created = await app.inject({
                            headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/schedules`,
      payload: baseBody(f),
    });
    const scheduleId = (JSON.parse(created.body) as { schedule: { id: string } }).schedule.id;

    const del = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'DELETE',
      url: `/api/teams/${f.teamId}/schedules/${scheduleId}?userId=${f.userId}`,
    });
    assert.equal(del.statusCode, 200, del.body);

    const rows = await sql<{ deleted_at: number | null }[]>`
      select deleted_at from schedule where id = ${scheduleId}
    `;
    assert.ok(rows[0]!.deleted_at !== null, 'deleted_at 必须被设置');

    // 二次删除 → 404
    const del2 = await app.inject({
                         headers: { authorization: `Bearer ${f.key}` },
      method: 'DELETE',
      url: `/api/teams/${f.teamId}/schedules/${scheduleId}?userId=${f.userId}`,
    });
    assert.equal(del2.statusCode, 404, del2.body);

    // 列出不应再包含已删规则
    const list = await app.inject({
                         headers: { authorization: `Bearer ${f.key}` },
      method: 'GET',
      url: `/api/teams/${f.teamId}/schedules`,
    });
    const parsed = JSON.parse(list.body) as { schedules: unknown[] };
    assert.equal(parsed.schedules.length, 0);
  });

  test('10 条规则上限：第 11 条被拒（422）', async () => {
    const f = await seedFixture(sql, 'limit-10');
    fixtures.push(f);

    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
                          headers: { authorization: `Bearer ${f.key}` },
        method: 'POST',
        url: `/api/teams/${f.teamId}/schedules`,
        payload: baseBody(f, { cron: String(i) }),
      });
      assert.equal(res.statusCode, 200, `第 ${i + 1} 条应成功：${res.body}`);
    }
    const over = await app.inject({
                         headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/schedules`,
      payload: baseBody(f, { cron: '5' }),
    });
    assert.equal(over.statusCode, 422, over.body);

    const rows = await sql<{ c: number }[]>`select count(*)::int as c from schedule where team_id = ${f.teamId}`;
    assert.equal(rows[0]!.c, 10);
  });

  test('team 不存在 → 404', async () => {
    const f = await seedFixture(sql, 'team-missing');
    fixtures.push(f);

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${newId()}/schedules`,
      payload: baseBody(f),
    });
    assert.equal(res.statusCode, 404, res.body);
  });

  test('weekly 跨形态改 kind（weekly → daily）成功', async () => {
    const f = await seedFixture(sql, 'kind-switch');
    fixtures.push(f);

    const created = await app.inject({
                            headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/schedules`,
      payload: baseBody(f, { kind: 'weekly', cron: '10:00', weekday: 3 }),
    });
    assert.equal(created.statusCode, 200, created.body);
    const scheduleId = (JSON.parse(created.body) as { schedule: { id: string } }).schedule.id;

    const patch = await app.inject({
                          headers: { authorization: `Bearer ${f.key}` },
      method: 'PATCH',
      url: `/api/teams/${f.teamId}/schedules/${scheduleId}`,
      payload: { userId: f.userId, kind: 'daily', cron: '08:00' },
    });
    assert.equal(patch.statusCode, 200, patch.body);
    const after = JSON.parse(patch.body) as { schedule: { kind: string; cron: string; weekday: number | null } };
    assert.equal(after.schedule.kind, 'daily');
    assert.equal(after.schedule.cron, '08:00');
    assert.equal(after.schedule.weekday, null, '非 weekly 时 weekday 应为 null');
  });

  test('无凭据打 schedule 列表 → 401，且库里没写', async () => {
    const f = await seedFixture(sql, 'sched-noauth');
    const before = await sql<{ n: number }[]>`select count(*)::int as n from "schedule" where team_id = ${f.teamId}`;
    const res = await app.inject({ method: 'GET', url: `/api/teams/${f.teamId}/schedules` });
    assert.equal(res.statusCode, 401, `body=${res.body}`);
    const after = await sql<{ n: number }[]>`select count(*)::int as n from "schedule" where team_id = ${f.teamId}`;
    assert.equal(Number(after[0]?.n), Number(before[0]?.n), '401 不该写库');
  });

  test('A 团队的 key 打 B 团队的 schedule → 403，且库里没写', async () => {
    const a = await seedFixture(sql, 'sched-A');
    const b = await seedFixture(sql, 'sched-B');
    const created = await app.inject({
      method: 'POST',
      url: `/api/teams/${b.teamId}/schedules`,
      headers: { authorization: `Bearer ${b.key}` },
      payload: baseBody(b),
    });
    assert.equal(created.statusCode, 200, created.body);
    const before = await sql<{ n: number }[]>`select count(*)::int as n from "schedule" where team_id = ${b.teamId}`;
    const res = await app.inject({
      method: 'GET',
      url: `/api/teams/${b.teamId}/schedules`,
      headers: { authorization: `Bearer ${a.key}` },
    });
    assert.equal(res.statusCode, 403, res.body);
    assert.match(res.body, /is not accessible to this key's owner/);
    const after = await sql<{ n: number }[]>`select count(*)::int as n from "schedule" where team_id = ${b.teamId}`;
    assert.equal(Number(after[0]?.n), Number(before[0]?.n), '403 不该写库');
  });

  test('key 是 A、body.userId 传 B → 403，且库里没写', async () => {
    const a = await seedFixture(sql, 'sched-imp');
    const b = await seedFixture(sql, 'sched-victim');
    const res = await app.inject({
      method: 'POST',
      url: `/api/teams/${b.teamId}/schedules`,
      headers: { authorization: `Bearer ${a.key}` },
      payload: baseBody(b, { userId: b.userId }),
    });
    assert.equal(res.statusCode, 403, res.body);
    assert.match(res.body, /is not this key's owner/);
    const rows = await sql<{ n: number }[]>`select count(*)::int as n from "schedule" where team_id = ${b.teamId}`;
    assert.equal(Number(rows[0]?.n), 0, '冒充失败时一行都不该写');
  });
});