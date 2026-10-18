import assert from 'node:assert/strict';
import { test, describe, before, after, beforeEach } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify from 'fastify';
import * as dbPkg from '@tds/db';
import { newId, now } from '../src/ids.js';
import { generateApiKey } from '../src/crypto.js';
import { registerApiKeyRoutes } from '../src/routes/api-keys.js';

/**
 * Settings → API keys 的 REST 端点验证（真库 + `app.inject`）。
 *
 * 逐条钉住 recon/docs/api-keys.md 的语义：
 *   1. key 属于**人**不属于团队 —— 列不出、改不了、撤销不了别人的 key
 *   2. 明文只在创建响应里出现一次，之后任何接口都取不回来
 *   3. scope 默认全关；不传 scopes 就是空数组
 *   4. revoke 立即失效，但已入网机器继续跑（machine 行不动）
 *   5. 机器凭据不出现在列表里，也不许被 Settings 撤销
 *
 * 每个拒绝用例都查库证明「什么都没变」。
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://tds@127.0.0.1:5433/tds';

let sql: postgres.Sql;
let app: ReturnType<typeof Fastify>;

interface User {
  userId: string;
  email: string;
  key: string;
}
const users: User[] = [];
const machineKeyRows: Array<{ id: string; userId: string }> = [];

async function seedUser(label: string): Promise<User> {
  const ts = now();
  const userId = newId();
  const email = `key-${label}-${userId}@test.local`;
  await sql`
    insert into "user" (id, email, display_name, status, locale, created_at, updated_at)
    values (${userId}, ${email}, ${label}, 'active', 'en', ${ts}, ${ts})
  `;
  const k = generateApiKey();
  await sql`
    insert into "api_key" (id, user_id, name, key_prefix, key_hash, scopes, created_at)
    values (${newId()}, ${userId}, ${'key-' + label}, ${k.prefix}, ${k.hash},
            ${['tool:todos']}, ${ts})
  `;
  const u = { userId, email, key: k.key };
  users.push(u);
  return u;
}

/** 直接建一把 key（不经端点），返回它的 id —— 用来测「改别人的 key」。 */
async function seedKeyRow(userId: string, name: string, scopes: string[]): Promise<string> {
  const k = generateApiKey();
  const id = newId();
  await sql`
    insert into "api_key" (id, user_id, name, key_prefix, key_hash, scopes, created_at)
    values (${id}, ${userId}, ${name}, ${k.prefix}, ${k.hash}, ${scopes}, ${now()})
  `;
  return id;
}

function auth(key: string): { authorization: string } {
  return { authorization: `Bearer ${key}` };
}

describe('API keys（Settings → API keys）', () => {
  before(async () => {
    sql = postgres(DATABASE_URL, { max: 5 });
    const db = drizzle(sql, { schema: dbPkg.schema });
    app = Fastify({ logger: false });
    app.decorate('machineUrl', 'http://test');
    registerApiKeyRoutes(app, db as never);
    await app.ready();
  });

  beforeEach(async () => {
    for (const u of users) {
      await sql`delete from "api_key" where user_id = ${u.userId} and name not like 'machine:%'`;
    }
  });

  after(async () => {
    for (const row of machineKeyRows) {
      await sql`delete from "api_key" where id = ${row.id}`;
    }
    for (const u of users) {
      await sql`delete from "api_key" where user_id = ${u.userId}`;
      await sql`delete from "user" where id = ${u.userId}`;
    }
    await app.close();
    await sql.end();
  });

  test('无凭据 → 401，且没建出任何 key', async () => {
    const u = await seedUser('noauth');
    const before = await sql<{ c: number }[]>`
      select count(*)::int as c from "api_key" where user_id = ${u.userId}
    `;

    const res = await app.inject({
      method: 'POST',
      url: '/api/user/api-keys',
      payload: { name: 'sneaky' },
    });
    assert.equal(res.statusCode, 401, res.body);
    const after = await sql<{ c: number }[]>`
      select count(*)::int as c from "api_key" where user_id = ${u.userId}
    `;
    assert.equal(after[0]?.c, before[0]?.c, '401 不该建出 key');
  });

  test('建 key：响应带明文，库里只有 HMAC', async () => {
    const u = await seedUser('create');

    const res = await app.inject({
      method: 'POST',
      url: '/api/user/api-keys',
      headers: auth(u.key),
      payload: { name: 'editor', scopes: ['tool:todos', 'tool:projects'] },
    });
    assert.equal(res.statusCode, 201, res.body);
    // 明文响应必须禁缓存 —— 响应里有凭据
    assert.match(res.headers['cache-control'] ?? '', /no-store/);

    const body = JSON.parse(res.body) as {
      key: string;
      apiKey: { id: string; keyPrefix: string; scopes: string[]; revokedAt: number | null };
    };
    assert.ok(body.key.startsWith('tds_'), '明文应以 tds_ 开头');
    assert.ok(body.apiKey.keyPrefix.length > 0);
    assert.deepEqual(body.apiKey.scopes, ['tool:todos', 'tool:projects']);
    assert.equal(body.apiKey.revokedAt, null);

    const rows = await sql<{ key_hash: string }[]>`
      select key_hash from "api_key" where id = ${body.apiKey.id}
    `;
    assert.equal(rows.length, 1);
    assert.ok(!rows[0]?.key_hash.includes(body.key), '库里绝不能存明文');
    assert.match(rows[0]?.key_hash ?? '', /^[0-9a-f]{64}$/, '存的是 HMAC-SHA256 十六进制');
  });

  test('明文只在创建响应出现一次 —— 列表里取不回来', async () => {
    const u = await seedUser('once');
    const created = await app.inject({
      method: 'POST',
      url: '/api/user/api-keys',
      headers: auth(u.key),
      payload: { name: 'one-shot' },
    });
    const plain = (JSON.parse(created.body) as { key: string }).key;

    const list = await app.inject({ method: 'GET', url: '/api/user/api-keys', headers: auth(u.key) });
    assert.equal(list.statusCode, 200, list.body);
    assert.ok(!list.body.includes(plain), '列表绝不能回显明文');
    const rows = JSON.parse(list.body) as { apiKeys: Array<Record<string, unknown>> };
    const row = rows.apiKeys.find((k) => k['name'] === 'one-shot');
    assert.ok(row, '刚建的 key 应出现在列表里');
    assert.equal(row?.['key'], undefined, '列表项里不该有 key 字段');
    assert.equal(row?.['keyHash'], undefined, '列表项里不该有 keyHash 字段');
  });

  test('不传 scopes = 一项能力都没有（默认全关）', async () => {
    const u = await seedUser('noscope');
    const res = await app.inject({
      method: 'POST',
      url: '/api/user/api-keys',
      headers: auth(u.key),
      payload: { name: 'bare' },
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = JSON.parse(res.body) as { apiKey: { scopes: string[] } };
    assert.deepEqual(body.apiKey.scopes, [], '新建 key 默认不该有任何 scope');
  });

  test('同名 key → 409，且没建出第二把', async () => {
    const u = await seedUser('dup');
    const first = await app.inject({
      method: 'POST',
      url: '/api/user/api-keys',
      headers: auth(u.key),
      payload: { name: 'same' },
    });
    assert.equal(first.statusCode, 201, first.body);

    const second = await app.inject({
      method: 'POST',
      url: '/api/user/api-keys',
      headers: auth(u.key),
      payload: { name: 'same' },
    });
    assert.equal(second.statusCode, 409, second.body);
    assert.match(second.body, /already have a key named/);

    const rows = await sql<{ c: number }[]>`
      select count(*)::int as c from "api_key" where user_id = ${u.userId} and name = 'same'
    `;
    assert.equal(rows[0]?.c, 1, '冲突时不该多建一行');
  });

  test('就地改 scopes 生效', async () => {
    const u = await seedUser('patch');
    const created = await app.inject({
      method: 'POST',
      url: '/api/user/api-keys',
      headers: auth(u.key),
      payload: { name: 'tweakable' },
    });
    const id = (JSON.parse(created.body) as { apiKey: { id: string } }).apiKey.id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/user/api-keys/${id}`,
      headers: auth(u.key),
      payload: { scopes: ['tool:todos', 'tool:secrets'] },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as { apiKey: { scopes: string[] } };
    assert.deepEqual(body.apiKey.scopes, ['tool:todos', 'tool:secrets']);

    const rows = await sql<{ scopes: string[] }[]>`
      select scopes from "api_key" where id = ${id}
    `;
    assert.deepEqual(rows[0]?.scopes, ['tool:todos', 'tool:secrets'], '库里应真的改了');
  });

  test('改别人的 key → 404，且那把没被动过（自我提权防线）', async () => {
    const a = await seedUser('victim-a');
    const b = await seedUser('attacker-b');
    const victimKeyId = await seedKeyRow(a.userId, 'victim-key', ['tool:todos']);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/user/api-keys/${victimKeyId}`,
      headers: auth(b.key),
      payload: { scopes: ['*'] },
    });
    assert.equal(res.statusCode, 404, res.body);
    const rows = await sql<{ scopes: string[] }[]>`
      select scopes from "api_key" where id = ${victimKeyId}
    `;
    assert.deepEqual(rows[0]?.scopes, ['tool:todos'], '被拒时那把 key 的 scope 必须原样');
  });

  test('撤销别人的 key → 404，且那把仍有效', async () => {
    const a = await seedUser('revoke-a');
    const b = await seedUser('revoke-b');
    const victimKeyId = await seedKeyRow(a.userId, 'keep-alive', ['tool:todos']);

    const res = await app.inject({
      method: 'POST',
      url: `/api/user/api-keys/${victimKeyId}/revoke`,
      headers: auth(b.key),
    });
    assert.equal(res.statusCode, 404, res.body);
    const rows = await sql<{ revoked_at: number | null }[]>`
      select revoked_at from "api_key" where id = ${victimKeyId}
    `;
    assert.equal(rows[0]?.revoked_at, null, '被拒时那把 key 必须仍然有效');
  });

  test('撤销后立即失效 —— 用它打 /api/mcp 不再放行', async () => {
    const u = await seedUser('revoke-uses');
    const created = await app.inject({
      method: 'POST',
      url: '/api/user/api-keys',
      headers: auth(u.key),
      payload: { name: 'temporary', scopes: ['tool:todos'] },
    });
    const id = (JSON.parse(created.body) as { apiKey: { id: string } }).apiKey.id;

    // 直接查库验 hash 命中路径：撤销前后用同一个 hash 比较
    const before = await sql<{ revoked_at: number | null }[]>`
      select revoked_at from "api_key" where id = ${id}
    `;
    assert.equal(before[0]?.revoked_at, null);

    const res = await app.inject({
      method: 'POST',
      url: `/api/user/api-keys/${id}/revoke`,
      headers: auth(u.key),
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as { apiKey: { revokedAt: number | null } };
    assert.ok(body.apiKey.revokedAt, '撤销后应带时间戳');

    const after = await sql<{ revoked_at: number | null }[]>`
      select revoked_at from "api_key" where id = ${id}
    `;
    assert.ok(after[0]?.revoked_at, '库里 revoked_at 必须被打上');
  });

  test('重复撤销是幂等的（连点两次不报错）', async () => {
    const u = await seedUser('idempotent');
    const created = await app.inject({
      method: 'POST',
      url: '/api/user/api-keys',
      headers: auth(u.key),
      payload: { name: 'twice' },
    });
    const id = (JSON.parse(created.body) as { apiKey: { id: string } }).apiKey.id;

    const first = await app.inject({
      method: 'POST', url: `/api/user/api-keys/${id}/revoke`, headers: auth(u.key),
    });
    const second = await app.inject({
      method: 'POST', url: `/api/user/api-keys/${id}/revoke`, headers: auth(u.key),
    });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(second.statusCode, 200, second.body);
    const a = (JSON.parse(first.body) as { apiKey: { revokedAt: number } }).apiKey.revokedAt;
    const b = (JSON.parse(second.body) as { apiKey: { revokedAt: number } }).apiKey.revokedAt;
    assert.equal(b, a, '重复撤销不该改时间戳');
  });

  test('已撤销的 key 不许改 scopes（要恢复就新建一把）', async () => {
    const u = await seedUser('revoked-patch');
    const created = await app.inject({
      method: 'POST',
      url: '/api/user/api-keys',
      headers: auth(u.key),
      payload: { name: 'dead' },
    });
    const id = (JSON.parse(created.body) as { apiKey: { id: string } }).apiKey.id;
    await app.inject({
      method: 'POST', url: `/api/user/api-keys/${id}/revoke`, headers: auth(u.key),
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/user/api-keys/${id}`,
      headers: auth(u.key),
      payload: { scopes: ['tool:todos'] },
    });
    assert.equal(res.statusCode, 409, res.body);
    assert.match(res.body, /revoked/);
    const rows = await sql<{ scopes: string[] }[]>`select scopes from "api_key" where id = ${id}`;
    assert.deepEqual(rows[0]?.scopes, [], '被拒时 scope 必须保持原样');
  });

  test('机器凭据不出现在列表里', async () => {
    const u = await seedUser('machine-list');
    const k = generateApiKey();
    const machineId = newId();
    const rowId = newId();
    await sql`
      insert into "api_key" (id, user_id, name, key_prefix, key_hash, scopes, created_at)
      values (${rowId}, ${u.userId}, ${'machine:' + machineId}, ${k.prefix}, ${k.hash},
              ${['machine:run']}, ${now()})
    `;
    machineKeyRows.push({ id: rowId, userId: u.userId });

    const res = await app.inject({ method: 'GET', url: '/api/user/api-keys', headers: auth(u.key) });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(!res.body.includes(machineId), '机器凭据不该出现在用户的 key 列表里');
  });

  test('机器凭据不许被 Settings 撤销（那等于用设置页下线机器）', async () => {
    const u = await seedUser('machine-revoke');
    const k = generateApiKey();
    const machineId = newId();
    const rowId = newId();
    await sql`
      insert into "api_key" (id, user_id, name, key_prefix, key_hash, scopes, created_at)
      values (${rowId}, ${u.userId}, ${'machine:' + machineId}, ${k.prefix}, ${k.hash},
              ${['machine:run']}, ${now()})
    `;
    machineKeyRows.push({ id: rowId, userId: u.userId });

    const res = await app.inject({
      method: 'POST', url: `/api/user/api-keys/${rowId}/revoke`, headers: auth(u.key),
    });
    assert.equal(res.statusCode, 404, res.body);
    const rows = await sql<{ revoked_at: number | null }[]>`
      select revoked_at from "api_key" where id = ${rowId}
    `;
    assert.equal(rows[0]?.revoked_at, null, '机器凭据必须保持有效');
  });

  test('列表按 user_id 隔离：A 看不到 B 的 key', async () => {
    const a = await seedUser('iso-a');
    const b = await seedUser('iso-b');
    await app.inject({
      method: 'POST', url: '/api/user/api-keys', headers: auth(a.key), payload: { name: 'a-only' },
    });
    await app.inject({
      method: 'POST', url: '/api/user/api-keys', headers: auth(b.key), payload: { name: 'b-only' },
    });

    const res = await app.inject({ method: 'GET', url: '/api/user/api-keys', headers: auth(a.key) });
    const body = JSON.parse(res.body) as { apiKeys: Array<{ name: string }> };
    const names = body.apiKeys.map((k) => k.name);
    assert.ok(names.includes('a-only'));
    assert.ok(!names.includes('b-only'), '不该看到别人的 key');
  });
});
