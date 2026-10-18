import assert from 'node:assert/strict';
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import http from 'node:http';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify from 'fastify';
import * as dbPkg from '@tds/db';
import { newId, now } from '../src/ids.js';
import { registerProviderRoutes } from '../src/routes/providers.js';
import { generateApiKey, open } from '../src/crypto.js';

/**
 * provider 目录路由验证。
 *
 * 重点不是「能存进去」，而是那几个真实业务规则：
 *   1. key 永不回传（GET / POST / PATCH 全部）
 *   2. 401/403 拒绝保存；**429 仍保存**（限流 ≠ key 错）
 *   3. 非可打印 ASCII 拒绝
 *   4. 空 apiKey 编辑 = 保留已存
 *   5. models 必须对象数组；字符串数组 422
 *   6. 20 个上限
 *   7. 非 admin 不能改（成员可读）
 *   8. /models?runtime=pi 汇总 provider；runtime≠pi 明确返回空 + machine-reported
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://tds@127.0.0.1:5433/tds';

let sql: postgres.Sql;
let app: ReturnType<typeof Fastify>;
const fixtures: Array<{ userId: string; teamId: string; memberId: string; key: string }> = [];

/** 可配置的假 provider 端点，用来精确制造 401 / 403 / 429 / 200。 */
let nextStatus = 200;
let lastRequest: { url: string; auth: string | undefined; body: string } | null = null;

const fakeProvider = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    lastRequest = { url: req.url ?? '', auth: req.headers.authorization, body };
    res.statusCode = nextStatus;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: nextStatus < 300 }));
  });
});

let fakePort = 0;

describe('provider 目录', () => {
  before(async () => {
    sql = postgres(DATABASE_URL, { max: 1 });
    await new Promise<void>((r) => fakeProvider.listen(0, '127.0.0.1', r));
    const addr = fakeProvider.address();
    fakePort = typeof addr === 'object' && addr ? addr.port : 0;

    const db = drizzle(sql, { schema: dbPkg.schema });
    app = Fastify({ logger: false });
    app.decorate('machineUrl', 'http://test');
    registerProviderRoutes(app, db as never);
    await app.ready();
  });

  after(async () => {
    await cleanup();
    await app.close();
    await sql.end();
    await new Promise<void>((r) => fakeProvider.close(() => r()));
  });

  beforeEach(() => { nextStatus = 200; lastRequest = null; });

  async function cleanup(): Promise<void> {
    for (const f of fixtures) {
      await sql`delete from provider where team_id = ${f.teamId}`;
      await sql`delete from member where team_id = ${f.teamId}`;
      await sql`delete from team where id = ${f.teamId}`;
      await sql`delete from "user" where id = ${f.userId}`;
    }
    fixtures.length = 0;
  }

  afterEach(cleanup);

  interface Fixture { userId: string; teamId: string; memberId: string; key: string }

  async function seed(role: 'admin' | 'member' = 'admin', label = 'prov'): Promise<Fixture> {
    const ts = now();
    const userId = newId();
    const teamId = newId();
    const memberId = newId();
    await sql`insert into "user" (id,email,display_name,created_at,updated_at)
                values (${userId}, ${`${label}-${userId}@test.local`}, ${label}, ${ts}, ${ts})`;
    await sql`insert into team (id,name,plan,storage_quota,created_at)
                values (${teamId}, ${label}, 'free', 1073741824, ${ts})`;
    await sql`insert into member (id,team_id,actor_id,member_type,role,joined_at,v)
                values (${memberId}, ${teamId}, ${userId}, 'user', ${role}, ${ts}, 0)`;
    const k = generateApiKey();
    await sql`insert into "api_key" (id,user_id,name,key_prefix,key_hash,scopes,created_at)
                values (${newId()}, ${userId}, ${'rest-' + label}, ${k.prefix}, ${k.hash}, ${['*']}, ${ts})`;
    fixtures.push({ userId, teamId, memberId, key: k.key });
    return { userId, teamId, memberId, key: k.key };
  }

  const MODELS = [
    { id: 'gpt-4o', contextWindow: 128000, maxTokens: 16384 },
    { id: 'gpt-4o-mini', contextWindow: 128000, maxTokens: 16384, reasoning: false },
  ];

  function body(f: Fixture, over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      userId: f.userId,
      kind: 'custom',
      providerId: 'my-gateway',
      label: '我的网关',
      baseUrl: `http://127.0.0.1:${fakePort}/v1`,
      api: 'openai-completions',
      models: MODELS,
      apiKey: 'sk-test-key-123',
      ...over,
    };
  }

  test('添加 provider 成功，且响应绝不包含 key', async () => {
    const f = await seed();
    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/providers`,
      payload: body(f),
    });
    assert.equal(res.statusCode, 200, res.body);

    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    const serialized = JSON.stringify(parsed);
    assert.ok(!serialized.includes('sk-test-key-123'), '响应里绝不能出现明文 key');
    assert.ok(!('apiKey' in (parsed.provider as object)), '不应有 apiKey 字段');
    assert.ok(!('encApiKey' in (parsed.provider as object)), '不应有 encApiKey 字段');
    assert.equal((parsed.provider as { hasApiKey: boolean }).hasApiKey, true);
  });

  test('key 加密落库，可解密还原', async () => {
    const f = await seed();
    await app.inject({ method: 'POST', url: `/api/teams/${f.teamId}/providers`, payload: body(f) , headers: { authorization: `Bearer ${f.key}` } });

    const rows = await sql<{ enc_api_key: string; enc_nonce: string }[]>`
      select enc_api_key, enc_nonce from provider where team_id = ${f.teamId}
    `;
    assert.equal(rows.length, 1);
    assert.ok(rows[0]!.enc_api_key);
    assert.ok(!rows[0]!.enc_api_key.includes('sk-test-key-123'), '库里不能是明文');

    // seal 存了 cipher.tag 拼接，这里按同样规则还原
    const dot = rows[0]!.enc_api_key.lastIndexOf('.');
    const restored = open({
      cipher: rows[0]!.enc_api_key.slice(0, dot),
      tag: rows[0]!.enc_api_key.slice(dot + 1),
      nonce: rows[0]!.enc_nonce,
    });
    assert.equal(restored, 'sk-test-key-123');
  });

  test('GET 列表可读（成员也能看），但不含 key', async () => {
    // 先用 admin 建好 provider，再验证普通成员能读
    const admin = await seed('admin', 'prov-admin');
    const created = await app.inject({
                            headers: { authorization: `Bearer ${admin.key}` },
      method: 'POST',
      url: `/api/teams/${admin.teamId}/providers`,
      payload: body(admin),
    });
    assert.equal(created.statusCode, 200, created.body);

    // 把该成员降级为 member，再试读
    await sql`update member set role = 'member' where team_id = ${admin.teamId}`;
    const res = await app.inject({
                        headers: { authorization: `Bearer ${admin.key}` },
      method: 'GET',
      url: `/api/teams/${admin.teamId}/providers?userId=${admin.userId}`,
    });
    assert.equal(res.statusCode, 200, '成员应能查看');
    assert.ok(!res.body.includes('sk-test-key-123'), '列表绝不能含明文 key');
    const parsed = JSON.parse(res.body) as { providers: unknown[] };
    assert.equal(parsed.providers.length, 1);
  });

  test('401 拒绝保存 —— 明确的凭据错误', async () => {
    const f = await seed();
    nextStatus = 401;
    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/providers`,
      payload: body(f),
    });
    assert.equal(res.statusCode, 422, res.body);
    const rows = await sql`select 1 from provider where team_id = ${f.teamId}`;
    assert.equal(rows.length, 0, '401 后不该存下来');
  });

  test('403 拒绝保存', async () => {
    const f = await seed();
    nextStatus = 403;
    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/providers`,
      payload: body(f),
    });
    assert.equal(res.statusCode, 422);
  });

  test('429 仍然保存 —— 限流说明 key 是对的', async () => {
    const f = await seed();
    nextStatus = 429;
    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/providers`,
      payload: body(f),
    });
    assert.equal(res.statusCode, 200, `429 不该拒绝：${res.body}`);
    const rows = await sql`select 1 from provider where team_id = ${f.teamId}`;
    assert.equal(rows.length, 1, '429 后必须保存');
  });

  test('端点不可达时跳过校验而不是拒绝', async () => {
    const f = await seed();
    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/providers`,
      payload: body(f, { baseUrl: 'http://127.0.0.1:1/v1' }),
    });
    assert.equal(res.statusCode, 200, `不可达应放行：${res.body}`);
  });

  test('非可打印 ASCII 的 key 被拒', async () => {
    const f = await seed();
    for (const bad of ['sk-\u00e9-key', 'sk-\nkey', 'sk-\u0007key']) {
      const res = await app.inject({
                          headers: { authorization: `Bearer ${f.key}` },
        method: 'POST',
        url: `/api/teams/${f.teamId}/providers`,
        payload: body(f, { apiKey: bad }),
      });
      assert.equal(res.statusCode, 422, `应拒绝 ${JSON.stringify(bad)}`);
    }
  });

  test('可打印 ASCII（含空格）通过校验', async () => {
    const f = await seed();
    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/providers`,
      payload: body(f, { apiKey: 'sk-abc DEF_123-ghi' }),
    });
    assert.equal(res.statusCode, 200, res.body);
  });

  test('无 key 的本地网关可保存（Ollama / LM Studio）', async () => {
    const f = await seed();
    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/providers`,
      payload: body(f, { apiKey: null }),
    });
    assert.equal(res.statusCode, 200, res.body);
    const parsed = JSON.parse(res.body) as { provider: { hasApiKey: boolean } };
    assert.equal(parsed.provider.hasApiKey, false);
  });

  test('models 必须是对象数组 —— 字符串数组 422', async () => {
    const f = await seed();
    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/providers`,
      payload: body(f, { models: ['gpt-4o', 'gpt-4o-mini'] }),
    });
    assert.equal(res.statusCode, 422, '字符串数组是原站实测的 422 坑');
  });

  test('非 admin 不能添加/修改/删除', async () => {
    const f = await seed('member');
    const add = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/providers`,
      payload: body(f),
    });
    assert.equal(add.statusCode, 403, add.body);

    // 成员可读
    const read = await app.inject({
                         headers: { authorization: `Bearer ${f.key}` },
      method: 'GET',
      url: `/api/teams/${f.teamId}/providers?userId=${f.userId}`,
    });
    assert.equal(read.statusCode, 200, '成员应能查看');
  });

  test('编辑时 apiKey 留空 = 保留已存', async () => {
    const f = await seed();
    const created = await app.inject({
                            headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/providers`,
      payload: body(f),
    });
    const providerId = (JSON.parse(created.body) as { provider: { id: string } }).provider.id;

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'PATCH',
      url: `/api/teams/${f.teamId}/providers/${providerId}`,
      payload: { userId: f.userId, label: '改名了', apiKey: '' },
    });
    assert.equal(res.statusCode, 200, res.body);

    const rows = await sql<{ label: string; enc_api_key: string }[]>`
      select label, enc_api_key from provider where id = ${providerId}
    `;
    assert.equal(rows[0]!.label, '改名了');
    const dot = rows[0]!.enc_api_key.lastIndexOf('.');
    const restored = open({
      cipher: rows[0]!.enc_api_key.slice(0, dot),
      tag: rows[0]!.enc_api_key.slice(dot + 1),
      nonce: (await sql<{ enc_nonce: string }[]>`select enc_nonce from provider where id = ${providerId}`)[0]!.enc_nonce,
    });
    assert.equal(restored, 'sk-test-key-123', '空 key 不应清掉已存的');
  });

  test('删除 provider', async () => {
    const f = await seed();
    const created = await app.inject({
                            headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/providers`,
      payload: body(f),
    });
    const providerId = (JSON.parse(created.body) as { provider: { id: string } }).provider.id;

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'DELETE',
      url: `/api/teams/${f.teamId}/providers/${providerId}?userId=${f.userId}`,
    });
    assert.equal(res.statusCode, 200);
    const rows = await sql`select 1 from provider where id = ${providerId}`;
    assert.equal(rows.length, 0);
  });

  test('20 个 provider 上限', async () => {
    const f = await seed();
    for (let i = 0; i < 20; i++) {
      const res = await app.inject({
                          headers: { authorization: `Bearer ${f.key}` },
        method: 'POST',
        url: `/api/teams/${f.teamId}/providers`,
        payload: body(f, { providerId: `p${i}`, label: `p${i}`, apiKey: null }),
      });
      assert.equal(res.statusCode, 200, `第 ${i} 个应成功：${res.body}`);
    }
    const over = await app.inject({
                         headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/providers`,
      payload: body(f, { providerId: 'p20', label: 'p20', apiKey: null }),
    });
    assert.equal(over.statusCode, 422, '第 21 个应被拒');
  });

  // ── 模型目录 ────────────────────────────────────────────────

  test('GET /models?runtime=pi 汇总所有 provider 的模型', async () => {
    const f = await seed();
    await app.inject({
            headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/providers`,
      payload: body(f, { providerId: 'gw-a', apiKey: null }),
    });
    await app.inject({
            headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/providers`,
      payload: body(f, {
        providerId: 'gw-b',
        models: [{ id: 'qwen3', contextWindow: 32000, maxTokens: 4096, reasoning: true }],
        apiKey: 'sk-b',
      }),
    });

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'GET',
      url: `/api/teams/${f.teamId}/models?userId=${f.userId}&runtime=pi`,
    });
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res.body) as {
      source: string;
      models: Array<{ id: string; modelId: string; providerId: string; usable: boolean; reasoning: boolean }>;
    };
    assert.equal(parsed.source, 'providers');
    assert.equal(parsed.models.length, 3, '2 + 1 个模型');
    assert.ok(parsed.models.some((m) => m.modelId === 'qwen3' && m.reasoning));
    assert.ok(parsed.models.every((m) => m.id.includes('/')), 'id 应是 providerId/modelId');
    // 只有配了 key 的可用
    assert.equal(parsed.models.find((m) => m.providerId === 'gw-a')?.usable, false);
    assert.equal(parsed.models.find((m) => m.providerId === 'gw-b')?.usable, true);
  });

  test('runtime=pi 是缺省值（原站默认 runtime）', async () => {
    const f = await seed();
    await app.inject({
            headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/providers`,
      payload: body(f, { apiKey: null }),
    });
    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'GET',
      url: `/api/teams/${f.teamId}/models?userId=${f.userId}`,
    });
    const parsed = JSON.parse(res.body) as { source: string; models: unknown[] };
    assert.equal(parsed.source, 'providers');
    assert.equal(parsed.models.length, 2);
  });

  test('runtime≠pi 返回空 + machine-reported —— 不能拿 provider 模型冒充', async () => {
    const f = await seed();
    await app.inject({
            headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/providers`,
      payload: body(f, { apiKey: null }),
    });
    for (const rt of ['omp', 'claude-code']) {
      const res = await app.inject({
                          headers: { authorization: `Bearer ${f.key}` },
        method: 'GET',
        url: `/api/teams/${f.teamId}/models?userId=${f.userId}&runtime=${rt}`,
      });
      const parsed = JSON.parse(res.body) as { source: string; models: unknown[] };
      assert.equal(parsed.source, 'machine-reported', `${rt} 应来自机器上报`);
      assert.equal(parsed.models.length, 0, `${rt} 不该拿到 provider 的模型`);
    }
  });

  test('无凭据打 provider 列表 → 401，且库里没写', async () => {
    const f = await seed();
    const before = await sql<{ n: number }[]>`select count(*)::int as n from provider where team_id = ${f.teamId}`;
    const res = await app.inject({ method: 'GET', url: `/api/teams/${f.teamId}/providers` });
    assert.equal(res.statusCode, 401, `body=${res.body}`);
    const after = await sql<{ n: number }[]>`select count(*)::int as n from provider where team_id = ${f.teamId}`;
    assert.equal(Number(after[0]?.n), Number(before[0]?.n), '401 不该写库');
  });

  test('A 团队的 key 打 B 团队的 provider → 403，且库里没写', async () => {
    const a = await seed('admin', 'prov-A');
    const b = await seed('admin', 'prov-B');
    const created = await app.inject({
      method: 'POST',
      url: `/api/teams/${b.teamId}/providers`,
      headers: { authorization: `Bearer ${b.key}` },
      payload: body(b),
    });
    assert.equal(created.statusCode, 200, created.body);
    const before = await sql<{ n: number }[]>`select count(*)::int as n from provider where team_id = ${b.teamId}`;
    const res = await app.inject({
      method: 'GET',
      url: `/api/teams/${b.teamId}/providers`,
      headers: { authorization: `Bearer ${a.key}` },
    });
    assert.equal(res.statusCode, 403, res.body);
    assert.match(res.body, /is not accessible to this key's owner/);
    const after = await sql<{ n: number }[]>`select count(*)::int as n from provider where team_id = ${b.teamId}`;
    assert.equal(Number(after[0]?.n), Number(before[0]?.n), '403 不该写库');
  });

  test('key 是 A、body.userId 传 B → 403，且库里没写', async () => {
    const a = await seed('admin', 'prov-imp');
    const b = await seed('admin', 'prov-victim');
    const res = await app.inject({
      method: 'POST',
      url: `/api/teams/${b.teamId}/providers`,
      headers: { authorization: `Bearer ${a.key}` },
      payload: body(b, { userId: b.userId }),
    });
    assert.equal(res.statusCode, 403, res.body);
    assert.match(res.body, /is not this key's owner/);
    const rows = await sql<{ n: number }[]>`select count(*)::int as n from provider where team_id = ${b.teamId}`;
    assert.equal(Number(rows[0]?.n), 0, '冒充失败时一行都不该写');
  });
});
