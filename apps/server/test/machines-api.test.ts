import assert from 'node:assert/strict';
import { test, describe, before, after, afterEach } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import * as dbPkg from '@tds/db';
import { newId, now } from '../src/ids.js';
import { generateApiKey } from '../src/crypto.js';
import { registerMachineAdminRoutes } from '../src/routes/machines.js';

/**
 * Settings → Machines 的 REST 端点验证（真库 + `app.inject`）。
 *
 * 按 `recon-live/GAP-ANALYSIS.md` 的「有后端没界面」缺口钉住：
 *   1. 跨团队 PATCH/DELETE → 403，且**机器没动**（最容易假绿，必须查库）
 *   2. 不存在 → 404
 *   3. `maxConcurrentTasks` 越界 → 422
 *   4. 列表响应里**不含**凭据类敏感字段（虽 `machine` 表自身没凭据列，但显式
 *      钉住字段集合能挡住未来有人往表里加 `tunnel_secret` 之类的列）
 *   5. PATCH `buildEnabled` 真生效
 *   6. DELETE 真删了
 *
 * 鉴权：与 `api-keys.test.ts` 一致 —— Bearer API key 落 `req.ctx`。
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://tds@127.0.0.1:5433/tds';

let sql: postgres.Sql;
let app: FastifyInstance;

interface MachineFixture {
  userId: string;
  teamId: string;
  memberId: string;
  key: string;
  machineId: string;
}

const fixtures: MachineFixture[] = [];

async function seedFixture(label: string): Promise<MachineFixture> {
  const ts = now();
  const userId = newId();
  const teamId = newId();
  const memberId = newId();
  const machineId = newId();

  await sql`insert into "user" (id,email,display_name,created_at,updated_at)
              values (${userId}, ${`mac-${label}-${userId}@test.local`}, ${label}, ${ts}, ${ts})`;
  await sql`insert into team (id,name,plan,storage_quota,created_at)
              values (${teamId}, ${label}, 'free', 1073741824, ${ts})`;
  await sql`insert into member (id,team_id,actor_id,member_type,role,joined_at,v)
              values (${memberId}, ${teamId}, ${userId}, 'user', 'admin', ${ts}, 0)`;

  const k = generateApiKey();
  const scopes: string[] = ['*'];
  await sql`insert into "api_key" (id,user_id,name,key_prefix,key_hash,scopes,created_at)
              values (${newId()}, ${userId}, ${'rest-' + label}, ${k.prefix}, ${k.hash}, ${scopes}, ${ts})`;

  await sql`
    insert into machine (
      id, team_id, name, device_id, enrolled_by,
      build_enabled, shell_enabled, max_concurrent_tasks,
      runtimes, disabled_runtimes, hardware,
      is_online, created_at, updated_at
    ) values (
      ${machineId}, ${teamId}, ${'machine-' + label}, ${'dev-' + machineId}, ${userId},
      ${true}, ${false}, ${6},
      '{}'::text[], '{}'::text[], '{}'::jsonb,
      ${false}, ${ts}, ${ts}
    )
  `;
  const f = { userId, teamId, memberId, key: k.key, machineId };
  fixtures.push(f);
  return f;
}

function auth(key: string): { authorization: string } {
  return { authorization: `Bearer ${key}` };
}

describe('Machines（Settings → Machines）', () => {
  before(async () => {
    sql = postgres(DATABASE_URL, { max: 5 });
    const db = drizzle(sql, { schema: dbPkg.schema });
    app = Fastify({ logger: false });
    app.decorate('machineUrl', 'http://test');
    registerMachineAdminRoutes(app, db as never);
    await app.ready();
  });

  after(async () => {
    for (const f of fixtures) {
      await sql`delete from machine where id = ${f.machineId}`;
      await sql`delete from member where team_id = ${f.teamId}`;
      await sql`delete from team where id = ${f.teamId}`;
      await sql`delete from "api_key" where user_id = ${f.userId}`;
      await sql`delete from "user" where id = ${f.userId}`;
    }
    await app.close();
    await sql.end();
  });

  afterEach(async () => {
    // 每条用例走完后清掉本用例追加的 fixture，避免数据库长期积累
    while (fixtures.length > 0) {
      const f = fixtures.pop();
      if (!f) break;
      await sql`delete from machine where id = ${f.machineId}`;
      await sql`delete from member where team_id = ${f.teamId}`;
      await sql`delete from team where id = ${f.teamId}`;
      await sql`delete from "api_key" where user_id = ${f.userId}`;
      await sql`delete from "user" where id = ${f.userId}`;
    }
  });

  test('GET 列表：返回当前团队的机器，且不含凭据字段', async () => {
    const f = await seedFixture('list-ok');

    const res = await app.inject({
      method: 'GET',
      url: `/api/machines?teamId=${encodeURIComponent(f.teamId)}`,
      headers: auth(f.key),
    });
    assert.equal(res.statusCode, 200, res.body);

    const body = JSON.parse(res.body) as { machines: Array<Record<string, unknown>> };
    assert.equal(body.machines.length, 1, '应能列到 1 条自己团队的机器');
    const m = body.machines[0]!;
    assert.equal(m['id'], f.machineId);
    // 显式字段集合白名单 —— schema 的 `machine` 表本身没凭据列，但硬钉这条
    // 能挡住以后往表里新增 `tunnel_secret` / `api_key` 之类。
    for (const banned of [
      'tunnelSecret', 'apiKey', 'token', 'sshKey', 'privateKey',
      'password', 'hash', 'encSecret',
    ]) {
      assert.equal(m[banned], undefined, `响应里不该出现 ${banned} 字段`);
    }
    assert.ok(Array.isArray(m['runtimes']), 'runtimes 应是数组');
    assert.ok(Array.isArray(m['disabledRuntimes']), 'disabledRuntimes 应是数组');
  });

  test('GET 列表：不带 teamId 时按当前用户所属 team 收窄（看不到别人的机器）', async () => {
    const f = await seedFixture('list-mine');

    const res = await app.inject({
      method: 'GET',
      url: '/api/machines',
      headers: auth(f.key),
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as { machines: Array<{ id: string }> };
    const ids = body.machines.map((m) => m.id);
    assert.ok(ids.includes(f.machineId), '应至少能看到自己团队的机器');
  });

  test('GET 列表：无凭据 → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/machines' });
    assert.equal(res.statusCode, 401, res.body);
  });

  test('PATCH `buildEnabled: false` 生效，且响应带回最新行', async () => {
    const f = await seedFixture('patch-build');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/machines/${encodeURIComponent(f.machineId)}`,
      headers: auth(f.key),
      payload: { buildEnabled: false },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as { machine: { buildEnabled: boolean } };
    assert.equal(body.machine.buildEnabled, false);

    const rows = await sql<{ build_enabled: boolean }[]>`
      select build_enabled from machine where id = ${f.machineId}
    `;
    assert.equal(rows[0]?.build_enabled, false, '库里的 build_enabled 必须真改了');
  });

  test('PATCH `shellEnabled: true` 生效（默认关是闸门）', async () => {
    const f = await seedFixture('patch-shell');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/machines/${encodeURIComponent(f.machineId)}`,
      headers: auth(f.key),
      payload: { shellEnabled: true },
    });
    assert.equal(res.statusCode, 200, res.body);
    const rows = await sql<{ shell_enabled: boolean }[]>`
      select shell_enabled from machine where id = ${f.machineId}
    `;
    assert.equal(rows[0]?.shell_enabled, true);
  });

  test('PATCH `maxConcurrentTasks: 999` → 422，且库里不变', async () => {
    const f = await seedFixture('patch-over');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/machines/${encodeURIComponent(f.machineId)}`,
      headers: auth(f.key),
      payload: { maxConcurrentTasks: 999 },
    });
    assert.equal(res.statusCode, 422, res.body);

    const rows = await sql<{ max_concurrent_tasks: number }[]>`
      select max_concurrent_tasks from machine where id = ${f.machineId}
    `;
    assert.equal(rows[0]?.max_concurrent_tasks, 6, '422 时库里必须仍是 6');
  });

  test('PATCH `maxConcurrentTasks: 0` → 422（下界）', async () => {
    const f = await seedFixture('patch-zero');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/machines/${encodeURIComponent(f.machineId)}`,
      headers: auth(f.key),
      payload: { maxConcurrentTasks: 0 },
    });
    assert.equal(res.statusCode, 422, res.body);
  });

  test('PATCH `name` 生效', async () => {
    const f = await seedFixture('patch-name');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/machines/${encodeURIComponent(f.machineId)}`,
      headers: auth(f.key),
      payload: { name: 'renamed-box' },
    });
    assert.equal(res.statusCode, 200, res.body);
    const rows = await sql<{ name: string }[]>`
      select name from machine where id = ${f.machineId}
    `;
    assert.equal(rows[0]?.name, 'renamed-box');
  });

  test('PATCH 空 body → 422', async () => {
    const f = await seedFixture('patch-empty');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/machines/${encodeURIComponent(f.machineId)}`,
      headers: auth(f.key),
      payload: {},
    });
    assert.equal(res.statusCode, 422, res.body);
  });

  test('PATCH 不存在的机器 → 404', async () => {
    const f = await seedFixture('patch-404');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/machines/${encodeURIComponent(newId())}`,
      headers: auth(f.key),
      payload: { name: 'noop' },
    });
    assert.equal(res.statusCode, 404, res.body);
  });

  test('跨团队 PATCH 他人机器 → 403，且那台机器的字段没动', async () => {
    const a = await seedFixture('cross-a');
    const b = await seedFixture('cross-b');
    // a 想改 b 名下的机器
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/machines/${encodeURIComponent(b.machineId)}`,
      headers: auth(a.key),
      payload: { name: 'pwned' },
    });
    assert.equal(res.statusCode, 403, res.body);

    const rows = await sql<{ name: string; build_enabled: boolean }[]>`
      select name, build_enabled from machine where id = ${b.machineId}
    `;
    assert.equal(rows[0]?.name, `machine-cross-b`, '被拒时 name 必须原样');
    assert.equal(rows[0]?.build_enabled, true, '被拒时 build_enabled 必须原样');
    // 把 a 也清干净
    await sql`delete from machine where id = ${a.machineId}`;
  });

  test('DELETE 真删了机器（cascade 带走 runtime_usage）', async () => {
    const f = await seedFixture('delete-ok');
    // seed 一行 machine_runtime_usage，DELETE 后应被 cascade 清掉
    await sql`
      insert into machine_runtime_usage (machine_id, runtime, fetched_at, status, account, windows, models)
      values (${f.machineId}, 'claude-code', ${now()}, 'ok',
              '{"id":null,"plan":null,"email":null}'::jsonb,
              '[]'::jsonb, '[]'::jsonb)
    `;
    const before = await sql<{ c: number }[]>`
      select count(*)::int as c from machine where id = ${f.machineId}
    `;
    assert.equal(before[0]?.c, 1, '删除前应存在');

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/machines/${encodeURIComponent(f.machineId)}`,
      headers: auth(f.key),
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as { ok: boolean; note: string };
    assert.equal(body.ok, true);
    assert.match(body.note, /cascade/i);

    const after = await sql<{ c: number }[]>`
      select count(*)::int as c from machine where id = ${f.machineId}
    `;
    assert.equal(after[0]?.c, 0, '删除后必须为 0');
    const usage = await sql<{ c: number }[]>`
      select count(*)::int as c from machine_runtime_usage where machine_id = ${f.machineId}
    `;
    assert.equal(usage[0]?.c, 0, 'machine_runtime_usage 必须 cascade 清掉');
  });

  test('DELETE 不存在的机器 → 404', async () => {
    const f = await seedFixture('delete-404');

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/machines/${encodeURIComponent(newId())}`,
      headers: auth(f.key),
    });
    assert.equal(res.statusCode, 404, res.body);
  });

  test('跨团队 DELETE 他人机器 → 403，且那台机器还在', async () => {
    const a = await seedFixture('cross-del-a');
    const b = await seedFixture('cross-del-b');

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/machines/${encodeURIComponent(b.machineId)}`,
      headers: auth(a.key),
    });
    assert.equal(res.statusCode, 403, res.body);

    const rows = await sql<{ c: number }[]>`
      select count(*)::int as c from machine where id = ${b.machineId}
    `;
    assert.equal(rows[0]?.c, 1, '被拒时那台机器必须仍存在');
    await sql`delete from machine where id = ${a.machineId}`;
  });
});
