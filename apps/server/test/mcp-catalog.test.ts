import assert from 'node:assert/strict';
import { test, describe, before, after, afterEach } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import * as dbPkg from '@tds/db';
import { newId, now } from '../src/ids.js';
import { generateApiKey } from '../src/crypto.js';
import {
  MCP_CATALOG,
  MCP_CATALOG_CATEGORIES,
  TEAM_CONNECTION_LIMIT,
  catalogCategories,
  findCatalogEntry,
} from '@tds/protocol';
import { registerConnectionCatalogRoutes } from '../src/routes/connection-catalog.js';

/**
 * Settings → Connections 目录端点 + 协议层 `MCP_CATALOG` 数据契约验证。
 *
 * 覆盖：
 *   1. 协议层：`MCP_CATALOG` 至少 23 条、identifier 无重复、本地预设两条存在且
 *      是 stdio；所有 http 条目 endpoint 非空；分类集合与目录一致。
 *   2. 端点：跨团队 → 403 且对方库里没动；无凭据 → 401；正常 → 200 且
 *      `catalog.length === MCP_CATALOG.length`、`teamConnectionCount` 正确反映
 *      该团队的活跃连接数；两次 GET 返回的 catalog 内容**完全一致**（证明不是
 *      按请求随机化）。
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://tds@127.0.0.1:5433/tds';

let sql: postgres.Sql;
let app: FastifyInstance;

interface Fixture {
  userId: string;
  teamId: string;
  memberId: string;
  key: string;
  connectionId?: string;
}

const fixtures: Fixture[] = [];

async function seed(label: string): Promise<Fixture> {
  const ts = now();
  const userId = newId();
  const teamId = newId();
  const memberId = newId();
  await sql`insert into "user" (id,email,display_name,created_at,updated_at)
              values (${userId}, ${`cat-${label}-${userId}@test.local`}, ${label}, ${ts}, ${ts})`;
  await sql`insert into team (id,name,plan,storage_quota,created_at)
              values (${teamId}, ${label}, 'free', 1073741824, ${ts})`;
  await sql`insert into member (id,team_id,actor_id,member_type,role,joined_at,v)
              values (${memberId}, ${teamId}, ${userId}, 'user', 'admin', ${ts}, 0)`;
  const k = generateApiKey();
  await sql`insert into "api_key" (id,user_id,name,key_prefix,key_hash,scopes,created_at)
              values (${newId()}, ${userId}, ${'rest-' + label}, ${k.prefix}, ${k.hash}, ${['*']}, ${ts})`;
  const f: Fixture = { userId, teamId, memberId, key: k.key };
  fixtures.push(f);
  return f;
}

async function seedConnection(f: Fixture, identifier: string, label: string): Promise<string> {
  const ts = now();
  const id = newId();
  await sql`insert into connection (id,team_id,kind,identifier,transport,label,endpoint,enc_config,enc_nonce,created_by,created_at)
              values (${id}, ${f.teamId}, 'catalog', ${identifier}, 'http', ${label}, ${'https://example/' + identifier}, null, null, ${f.userId}, ${ts})`;
  f.connectionId = id;
  return id;
}

function auth(key: string): { authorization: string } {
  return { authorization: `Bearer ${key}` };
}

describe('MCP catalog (协议层)', () => {
  test('至少 23 条目、identifier 无重复', () => {
    assert.ok(
      MCP_CATALOG.length >= 23,
      `目录条数 ${MCP_CATALOG.length} 少于原站承诺的 21 + 2 = 23`,
    );
    const ids = MCP_CATALOG.map((e) => e.identifier);
    assert.equal(new Set(ids).size, ids.length, 'identifier 出现重复');
  });

  test('本地预设：playwright + cua-driver 都是 stdio + command 非空 + 无 OAuth', () => {
    const playwright = findCatalogEntry('playwright');
    const cua = findCatalogEntry('cua-driver');
    assert.ok(playwright, 'playwright 条目必须存在');
    assert.ok(cua, 'cua-driver 条目必须存在');
    for (const e of [playwright!, cua!]) {
      assert.equal(e.transport, 'stdio', `${e.identifier} 必须 stdio`);
      assert.ok(e.command && e.command.length > 0, `${e.identifier} 必须 command 非空`);
      assert.ok(e.args && e.args.length > 0, `${e.identifier} 必须 args 非空`);
      assert.equal(e.requiresOAuth, false, `${e.identifier} 必须无 OAuth`);
      assert.equal(e.endpointVerified, true, `${e.identifier} 命令来自文档原文，照抄必须 verified`);
      assert.equal(e.endpoint, null, `${e.identifier} stdio 不该有 http endpoint`);
    }
  });

  test('http 条目：endpoint 非空', () => {
    for (const e of MCP_CATALOG) {
      if (e.transport !== 'http') continue;
      assert.ok(e.endpoint && e.endpoint.length > 0, `${e.identifier} http 条目必须 endpoint 非空`);
      assert.match(e.endpoint, /^https?:\/\//, `${e.identifier} endpoint 必须 http(s) 协议`);
      assert.equal(e.command, null, `${e.identifier} http 不该有 command`);
      assert.equal(e.args, null, `${e.identifier} http 不该有 args`);
      assert.equal(e.requiresOAuth, true, `${e.identifier} 远程 app 必须 OAuth`);
    }
  });

  test('MCP_CATALOG_CATEGORIES 与目录里出现的分类一一对应（不多不少）', () => {
    const fromEntries = new Set(MCP_CATALOG.map((e) => e.category));
    assert.equal(fromEntries.size, MCP_CATALOG_CATEGORIES.length, '分类数量不一致');
    for (const c of MCP_CATALOG_CATEGORIES) {
      assert.ok(fromEntries.has(c), `分类 ${c} 在 MCP_CATALOG_CATEGORIES 里但没有条目用`);
    }
    // catalogCategories() 自身的返回与常量一致
    assert.deepEqual(
      catalogCategories(),
      Array.from(MCP_CATALOG_CATEGORIES),
    );
  });

  test('findCatalogEntry 找不到时返回 null', () => {
    assert.equal(findCatalogEntry('definitely-not-real'), null);
  });
});

describe('GET /api/teams/:teamId/connection-catalog', () => {
  before(async () => {
    sql = postgres(DATABASE_URL, { max: 5 });
    const db = drizzle(sql, { schema: dbPkg.schema });
    app = Fastify({ logger: false });
    app.decorate('machineUrl', 'http://test');
    registerConnectionCatalogRoutes(app, db as never);
    await app.ready();
  });

  after(async () => {
    await app.close();
    await sql.end();
  });

  afterEach(async () => {
    while (fixtures.length > 0) {
      const f = fixtures.pop();
      if (!f) break;
      await sql`delete from connection where team_id = ${f.teamId}`;
      await sql`delete from member where team_id = ${f.teamId}`;
      await sql`delete from team where id = ${f.teamId}`;
      await sql`delete from "api_key" where user_id = ${f.userId}`;
      await sql`delete from "user" where id = ${f.userId}`;
    }
  });

  test('正常：返回 catalog / categories / teamConnectionCount / limit', async () => {
    const f = await seed('cat-ok');
    await seedConnection(f, 'linear', 'Linear'); // 1 条活跃

    const res = await app.inject({
      method: 'GET',
      url: `/api/teams/${f.teamId}/connection-catalog`,
      headers: auth(f.key),
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as {
      catalog: unknown[];
      categories: string[];
      teamConnectionCount: number;
      limit: number;
    };
    assert.equal(body.catalog.length, MCP_CATALOG.length);
    assert.deepEqual(body.categories, Array.from(MCP_CATALOG_CATEGORIES));
    assert.equal(body.teamConnectionCount, 1, 'teamConnectionCount 应反映 1 条活跃连接');
    assert.equal(body.limit, TEAM_CONNECTION_LIMIT);
  });

  test('teamConnectionCount 不计 soft-deleted 行', async () => {
    const f = await seed('cat-soft');
    await seedConnection(f, 'linear', 'Linear');
    // 软删那条
    await sql`update connection set deleted_at = ${now()} where team_id = ${f.teamId}`;

    const res = await app.inject({
      method: 'GET',
      url: `/api/teams/${f.teamId}/connection-catalog`,
      headers: auth(f.key),
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as { teamConnectionCount: number };
    assert.equal(body.teamConnectionCount, 0, '软删后计数必须为 0');
  });

  test('无凭据 → 401', async () => {
    const f = await seed('cat-noauth');
    const res = await app.inject({
      method: 'GET',
      url: `/api/teams/${f.teamId}/connection-catalog`,
    });
    assert.equal(res.statusCode, 401, res.body);
  });

  test('跨团队 → 403（且对方团队的连接没动）', async () => {
    const a = await seed('cat-cross-a');
    const b = await seed('cat-cross-b');
    await seedConnection(b, 'linear', 'Linear');

    const res = await app.inject({
      method: 'GET',
      url: `/api/teams/${b.teamId}/connection-catalog`,
      headers: auth(a.key),
    });
    assert.equal(res.statusCode, 403, res.body);

    // b 团队的连接数仍应是 1 —— 403 不能写库。
    const rows = await sql<{ c: number }[]>`
      select count(*)::int as c from connection
        where team_id = ${b.teamId} and deleted_at is null
    `;
    assert.equal(rows[0]?.c, 1, '跨团队被拒时对方团队连接数必须不变');
  });

  test('catalog 数据是只读公共常量：两次 GET 完全一致', async () => {
    const f = await seed('cat-stable');
    const a = await app.inject({
      method: 'GET',
      url: `/api/teams/${f.teamId}/connection-catalog`,
      headers: auth(f.key),
    });
    const b = await app.inject({
      method: 'GET',
      url: `/api/teams/${f.teamId}/connection-catalog`,
      headers: auth(f.key),
    });
    assert.equal(a.statusCode, 200);
    assert.equal(b.statusCode, 200);
    // catalog 数组的 identifier 顺序逐项一致
    const aBody = JSON.parse(a.body) as { catalog: Array<{ identifier: string }> };
    const bBody = JSON.parse(b.body) as { catalog: Array<{ identifier: string }> };
    assert.deepEqual(
      aBody.catalog.map((e) => e.identifier),
      bBody.catalog.map((e) => e.identifier),
      'catalog 内容必须稳定，不能按请求随机化',
    );
  });
});
