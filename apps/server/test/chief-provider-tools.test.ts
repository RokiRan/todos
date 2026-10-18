/**
 * Chief 工具面 provider 写操作（list / add / update / delete）端到端验证。
 *
 * 业务规则（来自 recon/docs/providers.md，逐条钉住）：
 *   1. 密文永不回显 —— `ProviderSummary` 类型层就没有 `encApiKey` / `encNonce`，
 *      且**运行时**任何 JSON 序列化产物都不出现这两个字段名（连 key 名都不该
 *      暴露——键名存在暗示「密文可被取回」）。
 *   2. `add_provider` / `update_provider` / `delete_providers` 需 team admin
 *      （providers.md "Adding, editing, and removing providers requires team
 *      admin permission"），与 `delete_providers` spec 上的
 *      `needsAdminGrant: true` 同源。
 *   3. `providerId` 团队内唯一；重复 → 409，无写入。
 *   4. `api` 必须落在 `MODEL_APIS` 里；非法值 → 422，无写入。
 *   5. `updateProvider` 部分更新 —— 只覆盖 patch 里显式给出的字段。
 *   6. `deleteProviders` 批量逐个尽力 —— 一项失败不影响同批其它项。
 *   7. 被 agent 引用的 provider 不能直接删（拒删闸门），库里的 provider 行
 *      必须仍在。
 *   8. 跨团队一律 403 —— 措辞「team "<id>" is not accessible to this key's owner」
 *      与 `requireTeamMembership` 一致；不存在与无权给同一个答案（不泄露存在性）。
 *
 * DB 是开发机 127.0.0.1:5433 上的 tds 真库；每个 test 用独立 fixture，
 * after 兜底清理（FK 反向：audit_event → chief → build → todo → agent_skill
 *   → agent → member → provider → api_key → user）。
 *
 * 失败用例的关键断言：
 *   - 跨团队 / member 角色 / 错字段校验 → 期望抛错 + 库里**未**写入
 *   - 拒绝用例的「未写入」必须用 `where team_id = ${fx.teamId}` 限定，
 *     绝不能 `count(*) from provider` —— 后者会被同 DB 上的并行测试污染。
 *
 * 不跑全量测试/typecheck（主代理统一跑）。
 */

import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Db } from '@tds/db';
import * as dbPkg from '@tds/db';
import { newId, now } from '../src/ids.js';
import { HttpError } from '../src/http.js';
import {
  addProvider,
  deleteProviders,
  listProviders,
  updateProvider,
  type ProviderSummary,
} from '../src/services/provider-admin.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://tds@127.0.0.1:5433/tds';

let sql: postgres.Sql;
let db: Db;

interface Fixture {
  label: string;
  userId: string;
  /** admin 角色 user —— actorId === userId, role='admin'。 */
  teamId: string;
  memberId: string;
  /** member 角色 user —— 用来测 admin 闸门拒绝。 */
  plainUserId: string;
  plainMemberId: string;
  /** 一个 admin 团队下已存在的 providerId（用作 add 的 dup 校验参考）。 */
  baseProviderId: string;
}

const fixtures: Fixture[] = [];

async function seedFixture(label: string): Promise<Fixture> {
  const ts = now();
  const userId = newId();
  const plainUserId = newId();
  const teamId = newId();
  const memberId = newId();
  const plainMemberId = newId();
  const baseProviderId = `${label}-base-${newId()}`;

  await sql.begin(async (tx) => {
    await tx`insert into "user" (id, email, display_name, created_at, updated_at)
              values (${userId}, ${`${label}-admin-${userId}@test.local`}, ${label}, ${ts}, ${ts})`;
    await tx`insert into "user" (id, email, display_name, created_at, updated_at)
              values (${plainUserId}, ${`${label}-plain-${plainUserId}@test.local`}, ${label}, ${ts}, ${ts})`;
    await tx`insert into team (id, name, plan, storage_quota, created_at)
              values (${teamId}, ${label}, 'free', 1073741824, ${ts})`;
    await tx`insert into member (id, team_id, actor_id, member_type, role, joined_at, v)
              values (${memberId}, ${teamId}, ${userId}, 'user', 'admin', ${ts}, 0)`;
    await tx`insert into member (id, team_id, actor_id, member_type, role, joined_at, v)
              values (${plainMemberId}, ${teamId}, ${plainUserId}, 'user', 'member', ${ts}, 0)`;
    // 一行干净的 provider，作为 dup / 跨团队测试的目标
    await tx`insert into provider (id, team_id, kind, provider_id, label, base_url, api, compat, models,
                                   enc_api_key, enc_nonce, created_by, created_at, updated_at)
              values (${newId()}, ${teamId}, 'vendor', ${baseProviderId}, ${label + '-base'}, null,
                      'openai-completions', ${`{"supportsDeveloperRole":false}`}::jsonb,
                      ${`[{"id":"gpt-4o-mini","contextWindow":128000,"maxTokens":16384,"reasoning":false,"input":["text"]}]`}::jsonb,
                      null, null, ${userId}, ${ts}, ${ts})`;
  });

  const fx: Fixture = {
    label,
    userId,
    teamId,
    memberId,
    plainUserId,
    plainMemberId,
    baseProviderId,
  };
  fixtures.push(fx);
  return fx;
}

async function countProviders(teamId: string): Promise<number> {
  const r = await sql<{ n: number }[]>`
    select count(*)::int as n from provider where team_id = ${teamId}
  `;
  return r[0]?.n ?? 0;
}

async function getProviderRow(providerDbId: string): Promise<{
  enc_api_key: string | null;
  enc_nonce: string | null;
  label: string;
  api: string | null;
  base_url: string | null;
  updated_at: number;
} | undefined> {
  const rows = await sql<{
    enc_api_key: string | null;
    enc_nonce: string | null;
    label: string;
    api: string | null;
    base_url: string | null;
    updated_at: number;
  }[]>`
    select enc_api_key, enc_nonce, label, api, base_url, updated_at
    from provider where id = ${providerDbId}
  `;
  return rows[0];
}

describe('Chief provider 写操作', () => {
  before(async () => {
    sql = postgres(DATABASE_URL, { max: 5 });
    db = drizzle(sql, { schema: dbPkg.schema });
  });

  after(async () => {
    // 反 FK 顺序：audit → chief → build → todo → agent_skill → agent → member
    //   → provider → team → user
    for (const fx of fixtures) {
      await sql`delete from audit_event where team_id = ${fx.teamId}`;
      await sql`delete from chief where team_id = ${fx.teamId}`;
      await sql`delete from agent where team_id = ${fx.teamId}`;
      await sql`delete from provider where team_id = ${fx.teamId}`;
      await sql`delete from member where team_id = ${fx.teamId}`;
      await sql`delete from team where id = ${fx.teamId}`;
      await sql`delete from "user" where id in (${fx.userId}, ${fx.plainUserId})`;
    }
    await sql.end();
  });

  // ── 密文隔离 ────────────────────────────────────────────

  test('listProviders：返回的 ProviderSummary 类型层与运行时都不含 encApiKey/encNonce 字段名', async () => {
    const fx = await seedFixture('list-no-secret');

    // 类型层：把返回值的 keys 强转 readonly string[]，跑出编译期/运行时两遍断言
    const summaries: ProviderSummary[] = await listProviders(db, fx.teamId);
    assert.ok(summaries.length >= 1, 'fixture 至少 1 行 provider');
    for (const s of summaries) {
      const keys = Object.keys(s as unknown as Record<string, unknown>);
      assert.ok(!keys.includes('encApiKey'), '字段名 encApiKey 不该出现');
      assert.ok(!keys.includes('encNonce'), '字段名 encNonce 不该出现');
      assert.ok(!keys.includes('enc_api_key'), '字段名 enc_api_key 不该出现');
      assert.ok(!keys.includes('enc_nonce'), '字段名 enc_nonce 不该出现');
      // 序列化也再验一次：JSON.stringify 之后的字段名同样不该暴露
      const json = JSON.stringify(s);
      assert.ok(!json.includes('encApiKey'), '序列化后不该出现 encApiKey');
      assert.ok(!json.includes('encNonce'), '序列化后不该出现 encNonce');
      assert.ok(!json.includes('enc_api_key'), '序列化后不该出现 enc_api_key');
      assert.ok(!json.includes('enc_nonce'), '序列化后不该出现 enc_nonce');
      // hasApiKey 仍应反映真实状态
      assert.equal(typeof s.hasApiKey, 'boolean');
    }
  });

  test('addProvider 返回的 summary 同样不含密文字段名', async () => {
    const fx = await seedFixture('add-no-secret');
    const summary = await addProvider(db, {
      teamId: fx.teamId,
      actorId: fx.userId,
      kind: 'vendor',
      providerId: `${fx.label}-nostr`,
      label: 'no-secret summary',
      api: 'openai-completions',
      models: [
        {
          id: 'gpt-4o-mini',
          contextWindow: 128000,
          maxTokens: 16384,
          reasoning: false,
          input: ['text'],
        },
      ],
      // 不传 apiKey → hasApiKey 必须为 false
    });
    const keys = Object.keys(summary as unknown as Record<string, unknown>);
    assert.ok(!keys.includes('encApiKey'));
    assert.ok(!keys.includes('encNonce'));
    assert.equal(summary.hasApiKey, false);
  });

  // ── addProvider ────────────────────────────────────────

  test('addProvider：正常建 —— 字段全部落库 + 审计 + 类型层不漏密文', async () => {
    const fx = await seedFixture('add-ok');
    const summary = await addProvider(db, {
      teamId: fx.teamId,
      actorId: fx.userId,
      kind: 'custom',
      providerId: `${fx.label}-custom`,
      label: 'Local Ollama',
      baseUrl: 'http://localhost:11434/v1',
      api: 'openai-completions',
      models: [
        { id: 'llama3', contextWindow: 8192, maxTokens: 4096, reasoning: false, input: ['text'] },
      ],
      skipVerify: true, // localhost 探不探都行 —— 测试避免外网抖动
    });

    assert.equal(summary.teamId, fx.teamId);
    assert.equal(summary.kind, 'custom');
    assert.equal(summary.providerId, `${fx.label}-custom`);
    assert.equal(summary.label, 'Local Ollama');
    assert.equal(summary.baseUrl, 'http://localhost:11434/v1');
    assert.equal(summary.api, 'openai-completions');
    assert.equal(summary.hasApiKey, false);

    // 库里真的落了
    const rows = await sql<{ label: string; api: string | null; base_url: string | null; provider_id: string }[]>`
      select label, api, base_url, provider_id
      from provider where id = ${summary.id}
    `;
    assert.equal(rows.length, 1, 'MUTATION? provider row should exist');
    assert.equal(rows[0]!.label, 'Local Ollama');
    assert.equal(rows[0]!.api, 'openai-completions');
    assert.equal(rows[0]!.base_url, 'http://localhost:11434/v1');
    assert.equal(rows[0]!.provider_id, `${fx.label}-custom`);

    // 审计落
    const audit = (await sql<{ n: number; type: string }[]>`
      select count(*)::int as n, max(type) as type
      from audit_event where team_id = ${fx.teamId} and type = 'provider_added'
    `)[0]!;
    assert.ok(audit.n >= 1, 'MUTATION? audit provider_added should exist');
    assert.equal(audit.type, 'provider_added');
  });

  test('addProvider：传 apiKey —— 真的 seal 了（库里是密文，不是明文）', async () => {
    const fx = await seedFixture('add-seal');
    const summary = await addProvider(db, {
      teamId: fx.teamId,
      actorId: fx.userId,
      kind: 'vendor',
      providerId: `${fx.label}-seal`,
      label: 'with-key',
      api: 'openai-completions',
      models: [{ id: 'gpt-4o-mini', contextWindow: 128000, maxTokens: 16384, reasoning: false, input: ['text'] }],
      apiKey: 'sk-test-live-001-key-1234',
      skipVerify: true, // 测试用假 key，避免外网真请求
    });
    assert.equal(summary.hasApiKey, true);

    const row = await getProviderRow(summary.id);
    assert.ok(row, 'MUTATION? row should exist');
    assert.ok(row!.enc_api_key, 'MUTATION? enc_api_key should be set');
    assert.ok(row!.enc_nonce, 'MUTATION? enc_nonce should be set');
    assert.ok(!row!.enc_api_key.includes('sk-test-live-001-key-1234'), '库里不应存明文 key');
  });

  test('addProvider：同 team 重复 providerId → 409，无写入', async () => {
    const fx = await seedFixture('add-dup');
    const before = await countProviders(fx.teamId);
    let threw = false;
    try {
      await addProvider(db, {
        teamId: fx.teamId,
        actorId: fx.userId,
        kind: 'vendor',
        providerId: fx.baseProviderId, // fixture 已 seed 的同名 providerId
        label: 'Dup Try',
        api: 'openai-completions',
      });
    } catch (e) {
      threw = true;
      assert.ok(e instanceof HttpError);
      assert.equal((e as HttpError).statusCode, 409);
      assert.match((e as Error).message, /already used/);
    }
    assert.ok(threw, 'expected HttpError 409');
    const after = await countProviders(fx.teamId);
    assert.equal(after, before, 'MUTATION? no row should be inserted');
  });

  test('addProvider：非法 api 值 → 422，无写入', async () => {
    const fx = await seedFixture('add-bad-api');
    const before = await countProviders(fx.teamId);
    let threw = false;
    try {
      await addProvider(db, {
        teamId: fx.teamId,
        actorId: fx.userId,
        kind: 'vendor',
        providerId: `${fx.label}-bad-api`,
        label: 'Bad API',
        // 故意传非法值 —— MODEL_APIS 只认四个枚举
        api: 'totally-made-up-api',
      } as never);
    } catch (e) {
      threw = true;
      assert.ok(e instanceof HttpError);
      assert.equal((e as HttpError).statusCode, 422);
      assert.match((e as Error).message, /api must be one of/);
    }
    assert.ok(threw, 'expected HttpError 422');
    const after = await countProviders(fx.teamId);
    assert.equal(after, before, 'MUTATION? no row should be inserted');
  });

  test('addProvider：跨团队 → 403，无写入', async () => {
    const a = await seedFixture('add-cross-a');
    const b = await seedFixture('add-cross-b');
    const before = await countProviders(b.teamId);
    let threw = false;
    try {
      // a 的 admin 想给 b 团队加 provider —— 应被 requireTeamMembership 拦
      await addProvider(db, {
        teamId: b.teamId,
        actorId: a.userId,
        kind: 'vendor',
        providerId: `${b.label}-cross`,
        label: 'Cross',
        api: 'openai-completions',
      });
    } catch (e) {
      threw = true;
      assert.ok(e instanceof HttpError);
      assert.equal((e as HttpError).statusCode, 403);
    }
    assert.ok(threw, 'expected cross-team 403');
    const after = await countProviders(b.teamId);
    assert.equal(after, before, 'MUTATION? no row should be inserted into b');
  });

  test('addProvider：member 角色 → 403（admin 闸门），无写入', async () => {
    const fx = await seedFixture('add-non-admin');
    const before = await countProviders(fx.teamId);
    let threw = false;
    try {
      await addProvider(db, {
        teamId: fx.teamId,
        actorId: fx.plainUserId, // member 角色
        kind: 'vendor',
        providerId: `${fx.label}-plain`,
        label: 'Plain',
        api: 'openai-completions',
      });
    } catch (e) {
      threw = true;
      assert.ok(e instanceof HttpError);
      assert.equal((e as HttpError).statusCode, 403);
    }
    assert.ok(threw, 'expected admin gate to throw 403');
    const after = await countProviders(fx.teamId);
    assert.equal(after, before, 'MUTATION? no row should be inserted');
  });

  test('addProvider：apiKey 含非可打印 ASCII → 422，无写入', async () => {
    const fx = await seedFixture('add-bad-key');
    const before = await countProviders(fx.teamId);
    let threw = false;
    try {
      await addProvider(db, {
        teamId: fx.teamId,
        actorId: fx.userId,
        kind: 'vendor',
        providerId: `${fx.label}-bad-key`,
        label: 'Bad Key',
        api: 'openai-completions',
        apiKey: 'has\ttab', // 含 \t（0x09），不在 0x20–0x7E 范围
        skipVerify: true,
      });
    } catch (e) {
      threw = true;
      assert.ok(e instanceof HttpError);
      assert.equal((e as HttpError).statusCode, 422);
      assert.match((e as Error).message, /printable ASCII/);
    }
    assert.ok(threw);
    const after = await countProviders(fx.teamId);
    assert.equal(after, before, 'MUTATION? no row should be inserted');
  });

  // ── updateProvider ────────────────────────────────────

  test('updateProvider：部分更新 —— 未传字段保持原值', async () => {
    const fx = await seedFixture('upd-partial');
    const created = await addProvider(db, {
      teamId: fx.teamId,
      actorId: fx.userId,
      kind: 'custom',
      providerId: `${fx.label}-upd`,
      label: 'Old Label',
      baseUrl: 'http://localhost:11434/v1',
      api: 'openai-completions',
      models: [{ id: 'llama3', contextWindow: 8192, maxTokens: 4096, reasoning: false, input: ['text'] }],
      skipVerify: true,
    });

    // 只改 label + baseUrl；api / models 必须**不动**
    const updated = await updateProvider(db, {
      teamId: fx.teamId,
      providerId: created.id,
      actorId: fx.userId,
      patch: {
        label: 'New Label',
        baseUrl: 'http://localhost:9999/v1',
      },
    });
    assert.equal(updated.label, 'New Label');
    assert.equal(updated.baseUrl, 'http://localhost:9999/v1');
    assert.equal(updated.api, 'openai-completions');
    assert.equal(updated.models.length, 1);
    assert.equal((updated.models[0] as { id: string }).id, 'llama3');

    const row = await getProviderRow(created.id);
    assert.ok(row, 'MUTATION? row should still exist');
    assert.equal(row!.label, 'New Label');
    assert.equal(row!.base_url, 'http://localhost:9999/v1');
    assert.equal(row!.api, 'openai-completions');
  });

  test('updateProvider：跨团队 → 404，未变更', async () => {
    const a = await seedFixture('upd-cross-a');
    const b = await seedFixture('upd-cross-b');
    const created = await addProvider(db, {
      teamId: a.teamId,
      actorId: a.userId,
      kind: 'vendor',
      providerId: `${a.label}-upd-cross`,
      label: 'Orig',
      api: 'openai-completions',
    });
    const before = (await getProviderRow(created.id))!;

    let threw = false;
    try {
      await updateProvider(db, {
        teamId: b.teamId, // ← 别人的 team
        providerId: created.id,
        actorId: b.userId,
        patch: { label: 'Hijacked' },
      });
    } catch (e) {
      threw = true;
      assert.ok(e instanceof HttpError);
      assert.equal((e as HttpError).statusCode, 404);
    }
    assert.ok(threw, 'cross-team update must 404');
    const after = await getProviderRow(created.id);
    assert.ok(after, 'MUTATION? row must remain');
    assert.equal(after!.label, before.label, 'MUTATION? label unchanged');
  });

  test('updateProvider：member 角色 → 403，未变更', async () => {
    const fx = await seedFixture('upd-non-admin');
    const created = await addProvider(db, {
      teamId: fx.teamId,
      actorId: fx.userId,
      kind: 'vendor',
      providerId: `${fx.label}-upd-plain`,
      label: 'Orig',
      api: 'openai-completions',
    });
    const before = (await getProviderRow(created.id))!;

    let threw = false;
    try {
      await updateProvider(db, {
        teamId: fx.teamId,
        providerId: created.id,
        actorId: fx.plainUserId, // member 角色
        patch: { label: 'Hijack' },
      });
    } catch (e) {
      threw = true;
      assert.ok(e instanceof HttpError);
      assert.equal((e as HttpError).statusCode, 403);
    }
    assert.ok(threw);
    const after = await getProviderRow(created.id);
    assert.equal(after!.label, before.label, 'MUTATION? label unchanged');
  });

  test('updateProvider：空 patch → 不写库也不审计', async () => {
    const fx = await seedFixture('upd-empty');
    const created = await addProvider(db, {
      teamId: fx.teamId,
      actorId: fx.userId,
      kind: 'vendor',
      providerId: `${fx.label}-upd-empty`,
      label: 'Orig',
      api: 'openai-completions',
    });
    const tsBefore = (await getProviderRow(created.id))!.updated_at;
    const auditBefore = (await sql<{ n: number }[]>`
      select count(*)::int as n from audit_event
      where team_id = ${fx.teamId} and type = 'provider_updated'
    `)[0]!.n;

    const updated = await updateProvider(db, {
      teamId: fx.teamId,
      providerId: created.id,
      actorId: fx.userId,
      patch: {},
    });
    assert.equal(updated.label, 'Orig');

    const tsAfter = (await getProviderRow(created.id))!.updated_at;
    assert.equal(tsAfter, tsBefore, 'MUTATION? no-op update should not bump updated_at');
    const auditAfter = (await sql<{ n: number }[]>`
      select count(*)::int as n from audit_event
      where team_id = ${fx.teamId} and type = 'provider_updated'
    `)[0]!.n;
    assert.equal(auditAfter, auditBefore, 'MUTATION? no-op update should not audit');
  });

  // ── deleteProviders ───────────────────────────────────

  test('deleteProviders：单删 —— 硬删（行从库里消失）', async () => {
    const fx = await seedFixture('del-single');
    const created = await addProvider(db, {
      teamId: fx.teamId,
      actorId: fx.userId,
      kind: 'vendor',
      providerId: `${fx.label}-del`,
      label: 'To Delete',
      api: 'openai-completions',
    });

    const out = await deleteProviders(db, {
      teamId: fx.teamId,
      providerIds: [created.id],
      actorId: fx.userId,
    });
    assert.equal(out.succeeded, 1);
    assert.equal(out.failed, 0);
    assert.deepEqual(out.results, [{ providerId: created.id, ok: true }]);

    const row = await getProviderRow(created.id);
    assert.equal(row, undefined, 'MUTATION? hard-delete must remove the row');

    // 审计
    const audit = (await sql<{ n: number }[]>`
      select count(*)::int as n from audit_event
      where team_id = ${fx.teamId} and type = 'provider_deleted'
        and actor_id = ${fx.userId}
    `)[0]!;
    assert.ok(audit.n >= 1, 'MUTATION? audit provider_deleted should exist');
  });

  test('deleteProviders：批量 —— 一项失败不影响其它项', async () => {
    const fx = await seedFixture('del-batch');
    const a = await addProvider(db, {
      teamId: fx.teamId,
      actorId: fx.userId,
      kind: 'vendor',
      providerId: `${fx.label}-batch-a`,
      label: 'A',
      api: 'openai-completions',
    });
    const b = await addProvider(db, {
      teamId: fx.teamId,
      actorId: fx.userId,
      kind: 'vendor',
      providerId: `${fx.label}-batch-b`,
      label: 'B',
      api: 'openai-completions',
    });
    const ghost = newId(); // 不存在

    const out = await deleteProviders(db, {
      teamId: fx.teamId,
      providerIds: [a.id, ghost, b.id],
      actorId: fx.userId,
    });
    assert.equal(out.succeeded, 2);
    assert.equal(out.failed, 1);
    assert.equal(out.results.length, 3);
    assert.deepEqual(out.results[0], { providerId: a.id, ok: true });
    assert.equal(out.results[1]!.providerId, ghost);
    assert.equal(out.results[1]!.ok, false);
    assert.ok(out.results[1]!.reason, 'failed entry should carry a reason');
    assert.deepEqual(out.results[2], { providerId: b.id, ok: true });
  });

  test('deleteProviders：被 agent 引用 → ok:false，库里 provider 仍在', async () => {
    const fx = await seedFixture('del-referenced');
    const ts = now();

    // 1) 直接 seed 一个 provider（绕开 addProvider 走 apiKey 探测）
    const provId = newId();
    const providerSlug = `${fx.label}-referenced`;
    await sql`insert into provider (id, team_id, kind, provider_id, label, base_url, api, compat, models,
                                    enc_api_key, enc_nonce, created_by, created_at, updated_at)
              values (${provId}, ${fx.teamId}, 'vendor', ${providerSlug}, ${'ref-target'}, null,
                      'openai-completions', ${`{"supportsDeveloperRole":false}`}::jsonb,
                      '[]'::jsonb, null, null, ${fx.userId}, ${ts}, ${ts})`;

    // 2) seed 一个 agent 引用这个 providerId
    await sql`insert into agent (id, team_id, display_name, provider, model_id,
                                  default_skill_ids, grants, active_task_count,
                                  created_at, updated_at, deleted_at)
              values (${newId()}, ${fx.teamId}, ${'ref-agent'}, ${providerSlug}, 'gpt-4o-mini',
                      '{}', '{}'::jsonb, 0, ${ts}, ${ts}, null)`;

    // 3) 试删 —— 应该被拒，理由含「agent」
    const out = await deleteProviders(db, {
      teamId: fx.teamId,
      providerIds: [provId],
      actorId: fx.userId,
    });
    assert.equal(out.succeeded, 0);
    assert.equal(out.failed, 1);
    assert.equal(out.results[0]!.providerId, provId);
    assert.equal(out.results[0]!.ok, false);
    assert.match(out.results[0]!.reason!, /agent/);

    // 4) 库里 provider 必须仍在
    const row = await getProviderRow(provId);
    assert.ok(row, 'MUTATION? referenced provider must remain in DB');
    assert.equal(row!.label, 'ref-target');
  });

  test('deleteProviders：跨团队 → 该项 ok:false，其它项不受影响', async () => {
    const a = await seedFixture('del-cross-a');
    const b = await seedFixture('del-cross-b');
    const aProv = await addProvider(db, {
      teamId: a.teamId,
      actorId: a.userId,
      kind: 'vendor',
      providerId: `${a.label}-del-cross-a`,
      label: 'A',
      api: 'openai-completions',
    });
    const bProv = await addProvider(db, {
      teamId: b.teamId,
      actorId: b.userId,
      kind: 'vendor',
      providerId: `${b.label}-del-cross-b`,
      label: 'B',
      api: 'openai-completions',
    });

    // a 的 admin 想用 a 的 teamId 去删 b 的 provider —— 应该 ok:false
    const out = await deleteProviders(db, {
      teamId: a.teamId,
      providerIds: [aProv.id, bProv.id],
      actorId: a.userId,
    });
    assert.equal(out.succeeded, 1);
    assert.equal(out.failed, 1);
    assert.deepEqual(out.results[0], { providerId: aProv.id, ok: true });
    assert.equal(out.results[1]!.providerId, bProv.id);
    assert.equal(out.results[1]!.ok, false);

    // b 的 provider 必须没动 —— b.teamId 限定
    const bRow = await getProviderRow(bProv.id);
    assert.ok(bRow, 'MUTATION? cross-team delete must not touch b');
    assert.equal(bRow!.label, 'B');
  });

  test('deleteProviders：member 角色 → 整体拒绝（admin 闸门），全部 ok:false，无写入', async () => {
    const fx = await seedFixture('del-non-admin');
    const created = await addProvider(db, {
      teamId: fx.teamId,
      actorId: fx.userId,
      kind: 'vendor',
      providerId: `${fx.label}-del-plain`,
      label: 'A',
      api: 'openai-completions',
    });

    let threw = false;
    try {
      await deleteProviders(db, {
        teamId: fx.teamId,
        providerIds: [created.id],
        actorId: fx.plainUserId,
      });
    } catch (e) {
      threw = true;
      assert.ok(e instanceof HttpError);
      assert.equal((e as HttpError).statusCode, 403);
    }
    assert.ok(threw, 'admin gate should reject before any per-item work');

    const row = await getProviderRow(created.id);
    assert.ok(row, 'MUTATION? no row should be deleted');
    assert.equal(row!.label, 'A');
  });

  test('deleteProviders：批量空 → 0 succeeded / 0 failed，无 audit', async () => {
    const fx = await seedFixture('del-empty');
    const before = (await sql<{ n: number }[]>`
      select count(*)::int as n from audit_event
      where team_id = ${fx.teamId} and type = 'provider_deleted'
    `)[0]!.n;
    const out = await deleteProviders(db, {
      teamId: fx.teamId,
      providerIds: [],
      actorId: fx.userId,
    });
    assert.deepEqual(out.results, []);
    assert.equal(out.succeeded, 0);
    assert.equal(out.failed, 0);
    const after = (await sql<{ n: number }[]>`
      select count(*)::int as n from audit_event
      where team_id = ${fx.teamId} and type = 'provider_deleted'
    `)[0]!.n;
    assert.equal(after, before, 'MUTATION? no audit should be written');
  });
});