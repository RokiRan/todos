/**
 * Chief 工具面 agent 写操作（create / update / delete）端到端验证。
 *
 * 业务规则（来自 recon/docs/agents.md）：
 *   1. 增删改要 team admin —— spec 上 `delete_agents` 标了 `needsAdminGrant`,
 *      agents.md 文档铁律一致（"Changes require a team admin"）。
 *   2. description ≤ 800 字符；defaultSkillIds ≤ 10；每 team ≤ 5 个 agent。
 *   3. 跨团队 403 —— 措辞「team "<id>" is not accessible to this key's owner」
 *      与 requireTeamMembership 一致。
 *   4. updateAgent 部分更新 —— 只覆盖 patch 里显式给出的字段。
 *   5. deleteAgents 批量逐个尽力 —— 一项失败不影响同批其它项。
 *
 * DB 是开发机 127.0.0.1:5433 上的 tds 真库；每个 test 用独立 fixture，
 * after 兜底清理（FK 反向：chief → build → todo → agent_skill → agent
 *   → member → project → provider → api_key → user）。
 *
 * 失败用例的关键断言：
 *   - 跨团队 / member 角色 / 错字段校验 → 期望抛错 + 库里**未**写入
 *   - 拒绝用例的「未写入」必须用 `where team_id = ${fx.teamId}` 限定，
 *     绝不能 `count(*) from agent` —— 后者会被同 DB 上的并行测试污染。
 */

import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as dbPkg from '@tds/db';
import { newId, now } from '../src/ids.js';
import {
  createAgent,
  updateAgent,
  deleteAgents,
  type AgentSummary,
} from '../src/services/agents-admin.js';
import { HttpError } from '../src/http.js';

type Db = PostgresJsDatabase<typeof dbPkg.schema>;

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://tds@127.0.0.1:5433/tds';

let sql: postgres.Sql;
let db: Db;

interface Fixture {
  label: string;
  userId: string;
  teamId: string;
  memberId: string;
  /** admin 角色 member —— actorId === userId, role='admin'。 */
  adminMemberId: string;
  /** member 角色 member —— 用来测 admin 闸门拒绝。 */
  plainMemberId: string;
  plainUserId: string;
  /** 一个 admin 团队下已存在的 provider —— 测 provider/modelId 跨团队校验。 */
  providerId: string;
  /** 一个 admin 团队下已存在的 skill —— 测 defaultSkillIds 跨团队校验。 */
  skillId: string;
}

const fixtures: Fixture[] = [];

async function seedFixture(label: string): Promise<Fixture> {
  const ts = now();
  const userId = newId();
  const plainUserId = newId();
  const teamId = newId();
  const memberId = newId();
  const plainMemberId = newId();
  const providerId = `prov-${label}-${newId()}`;
  const skillId = newId();

  await sql.begin(async (tx) => {
    await tx`insert into "user" (id, email, display_name, created_at, updated_at)
              values (${userId}, ${`${label}-admin-${userId}@test.local`}, ${label}, ${ts}, ${ts})`;
    await tx`insert into "user" (id, email, display_name, created_at, updated_at)
              values (${plainUserId}, ${`${label}-plain-${plainUserId}@test.local`}, ${label}, ${ts}, ${ts})`;
    await tx`insert into "team" (id, name, plan, storage_quota, created_at)
              values (${teamId}, ${label}, 'free', 1073741824, ${ts})`;
    await tx`insert into "member" (id, team_id, actor_id, member_type, role, joined_at, v)
              values (${memberId}, ${teamId}, ${userId}, 'user', 'admin', ${ts}, 0)`;
    await tx`insert into "member" (id, team_id, actor_id, member_type, role, joined_at, v)
              values (${plainMemberId}, ${teamId}, ${plainUserId}, 'user', 'member', ${ts}, 0)`;
    await tx`insert into "agent" (id, team_id, display_name, default_skill_ids, grants, active_task_count, created_at, updated_at)
              values (${newId()}, ${teamId}, ${label + '-seed'}, '{}', '{}'::jsonb, 0, ${ts}, ${ts})`;
    await tx`insert into "provider" (id, team_id, kind, provider_id, label, base_url, api, compat, models, enc_api_key, enc_nonce, created_by, created_at, updated_at)
              values (${newId()}, ${teamId}, 'vendor', ${providerId}, ${label + '-p'}, null, 'openai-completions',
                      ${`{"supportsDeveloperRole":false}`}::jsonb,
                      ${`[{"id":"gpt-4o-mini","contextWindow":128000,"maxTokens":16384,"reasoning":false,"input":["text"]},{"id":"o1","contextWindow":200000,"maxTokens":100000,"reasoning":true,"input":["text"]}]`}::jsonb,
                      null, null, ${userId}, ${ts}, ${ts})`;
    await tx`insert into "skill" (id, team_id, name, source, source_url, storage_path, size_bytes, file_count, created_by, created_at, deleted_at)
              values (${skillId}, ${teamId}, ${label + '-skill'}, 'files', null, ${'/tmp/skill-' + skillId}, 0, 0, ${userId}, ${ts}, null)`;
  });

  const fx: Fixture = {
    label,
    userId,
    teamId,
    memberId,
    adminMemberId: memberId,
    plainMemberId,
    plainUserId,
    providerId,
    skillId,
  };
  fixtures.push(fx);
  return fx;
}

describe('Chief agent 写操作', () => {
  before(async () => {
    sql = postgres(DATABASE_URL, { max: 5 });
    db = drizzle(sql, { schema: dbPkg.schema }) as unknown as Db;
  });

  after(async () => {
    // 反 FK 顺序：audit_event 引用 chief 也引用 team，先按 team 清。
    for (const fx of fixtures) {
      await sql`delete from audit_event where team_id = ${fx.teamId}`;
      await sql`delete from agent_skill where agent_id in (select id from agent where team_id = ${fx.teamId})`;
      await sql`delete from agent where team_id = ${fx.teamId}`;
      await sql`delete from member where team_id = ${fx.teamId}`;
      await sql`delete from provider where team_id = ${fx.teamId}`;
      await sql`delete from skill where team_id = ${fx.teamId}`;
      await sql`delete from team where id = ${fx.teamId}`;
      await sql`delete from "user" where id in (${fx.userId}, ${fx.plainUserId})`;
    }
    await sql.end();
  });

  // ── createAgent ──────────────────────────────────────────────

  test('createAgent：正常建 —— 字段全部落库 + agent_skill 同步 + audit 落', async () => {
    const fx = await seedFixture('create-ok');
    const created = await createAgent(db, {
      teamId: fx.teamId,
      actorId: fx.userId,
      displayName: 'Backend',
      description: 'Owns the API.',
      provider: fx.providerId,
      modelId: 'gpt-4o-mini',
      thinkingLevel: 'low',
      defaultSkillIds: [fx.skillId],
      grants: { push_branch: true },
    });

    assert.equal(created.teamId, fx.teamId);
    assert.equal(created.displayName, 'Backend');
    assert.equal(created.description, 'Owns the API.');
    assert.equal(created.provider, fx.providerId);
    assert.equal(created.modelId, 'gpt-4o-mini');
    assert.equal(created.thinkingLevel, 'low');
    assert.deepEqual(created.defaultSkillIds, [fx.skillId]);
    assert.equal(created.grants.push_branch, true);
    assert.equal(created.deletedAt, null);

    const row = (await sql<AgentSummary[]>`
      select id, team_id, display_name, description, provider, model_id,
             thinking_level, default_skill_ids, grants, active_task_count,
             created_at, updated_at, deleted_at
      from agent where id = ${created.id}
    `)[0];
    assert.ok(row, 'MUTATION? agent row should exist');
    assert.equal(row!.display_name, 'Backend');
    assert.equal(row!.provider, fx.providerId);

    const link = (await sql<{ n: number }[]>`
      select count(*)::int as n from agent_skill where agent_id = ${created.id}
    `)[0];
    assert.equal(link!.n, 1, 'MUTATION? agent_skill link should exist');

    const audit = (await sql<{ n: number; type: string }[]>`
      select count(*)::int as n, max(type) as type
      from audit_event where team_id = ${fx.teamId} and type = 'agent_created'
    `)[0];
    assert.ok((audit!.n ?? 0) >= 1, 'MUTATION? audit agent_created should exist');
    assert.equal(audit!.type, 'agent_created');
  });

  test('createAgent：displayName 空 → 422，无写入', async () => {
    const fx = await seedFixture('create-name-empty');
    const before = await sql<{ n: number }[]>`
      select count(*)::int as n from agent where team_id = ${fx.teamId}
    `;
    let threw = false;
    try {
      await createAgent(db, {
        teamId: fx.teamId,
        actorId: fx.userId,
        displayName: '   ',
      });
    } catch (e) {
      threw = true;
      assert.ok(e instanceof HttpError);
      assert.equal((e as HttpError).statusCode, 422);
    }
    assert.ok(threw, 'expected HttpError');
    const after = await sql<{ n: number }[]>`
      select count(*)::int as n from agent where team_id = ${fx.teamId}
    `;
    assert.equal(after[0]!.n, before[0]!.n, 'MUTATION? no row should be inserted');
  });

  test('createAgent：description 超 800 → 422，无写入', async () => {
    const fx = await seedFixture('create-desc-cap');
    const before = await sql<{ n: number }[]>`
      select count(*)::int as n from agent where team_id = ${fx.teamId}
    `;
    let threw = false;
    try {
      await createAgent(db, {
        teamId: fx.teamId,
        actorId: fx.userId,
        displayName: 'X',
        description: 'a'.repeat(801),
      });
    } catch (e) {
      threw = true;
      assert.equal((e as HttpError).statusCode, 422);
    }
    assert.ok(threw);
    const after = await sql<{ n: number }[]>`
      select count(*)::int as n from agent where team_id = ${fx.teamId}
    `;
    assert.equal(after[0]!.n, before[0]!.n, 'MUTATION? no row should be inserted');
  });

  test('createAgent：defaultSkillIds 跨团队 → 422，无写入', async () => {
    const a = await seedFixture('create-skill-a');
    const b = await seedFixture('create-skill-b');
    // a 的 admin 想挂 b 团队的 skill —— 应该被拒
    const before = await sql<{ n: number }[]>`
      select count(*)::int as n from agent where team_id = ${a.teamId}
    `;
    let threw = false;
    try {
      await createAgent(db, {
        teamId: a.teamId,
        actorId: a.userId,
        displayName: 'X',
        defaultSkillIds: [b.skillId],
      });
    } catch (e) {
      threw = true;
      assert.equal((e as HttpError).statusCode, 422);
    }
    assert.ok(threw);
    const after = await sql<{ n: number }[]>`
      select count(*)::int as n from agent where team_id = ${a.teamId}
    `;
    assert.equal(after[0]!.n, before[0]!.n, 'MUTATION? no row should be inserted');
  });

  test('createAgent：provider 跨团队 → 422，无写入', async () => {
    const a = await seedFixture('create-prov-a');
    const b = await seedFixture('create-prov-b');
    const before = await sql<{ n: number }[]>`
      select count(*)::int as n from agent where team_id = ${a.teamId}
    `;
    let threw = false;
    try {
      await createAgent(db, {
        teamId: a.teamId,
        actorId: a.userId,
        displayName: 'X',
        provider: b.providerId,
        modelId: 'gpt-4o-mini',
      });
    } catch (e) {
      threw = true;
      assert.equal((e as HttpError).statusCode, 422);
    }
    assert.ok(threw);
    const after = await sql<{ n: number }[]>`
      select count(*)::int as n from agent where team_id = ${a.teamId}
    `;
    assert.equal(after[0]!.n, before[0]!.n, 'MUTATION? no row should be inserted');
  });

  test('createAgent：modelId 不在 provider.models[] → 422', async () => {
    const fx = await seedFixture('create-model-missing');
    let threw = false;
    try {
      await createAgent(db, {
        teamId: fx.teamId,
        actorId: fx.userId,
        displayName: 'X',
        provider: fx.providerId,
        modelId: 'gpt-99-not-real',
      });
    } catch (e) {
      threw = true;
      assert.equal((e as HttpError).statusCode, 422);
    }
    assert.ok(threw);
  });

  test('createAgent：member 角色 → 403（admin 闸门），无写入', async () => {
    const fx = await seedFixture('create-non-admin');
    const before = await sql<{ n: number }[]>`
      select count(*)::int as n from agent where team_id = ${fx.teamId}
    `;
    let threw = false;
    try {
      await createAgent(db, {
        teamId: fx.teamId,
        actorId: fx.plainUserId, // member 角色
        displayName: 'X',
      });
    } catch (e) {
      threw = true;
      assert.equal((e as HttpError).statusCode, 403);
    }
    assert.ok(threw, 'expected admin gate to throw 403');
    const after = await sql<{ n: number }[]>`
      select count(*)::int as n from agent where team_id = ${fx.teamId}
    `;
    assert.equal(after[0]!.n, before[0]!.n, 'MUTATION? no row should be inserted');
  });

  test('createAgent：defaultSkillIds > 10 → 422，无写入', async () => {
    const fx = await seedFixture('create-skills-cap');
    // seed 1 个真 skill，剩下的 id 全不存在（先撞长度上限再撞「unknown」）
    const wanted: string[] = [fx.skillId];
    for (let i = 0; i < 10; i += 1) wanted.push(newId());
    const before = await sql<{ n: number }[]>`
      select count(*)::int as n from agent where team_id = ${fx.teamId}
    `;
    let threw = false;
    try {
      await createAgent(db, {
        teamId: fx.teamId,
        actorId: fx.userId,
        displayName: 'X',
        defaultSkillIds: wanted,
      });
    } catch (e) {
      threw = true;
      assert.equal((e as HttpError).statusCode, 422);
    }
    assert.ok(threw);
    const after = await sql<{ n: number }[]>`
      select count(*)::int as n from agent where team_id = ${fx.teamId}
    `;
    assert.equal(after[0]!.n, before[0]!.n, 'MUTATION? no row should be inserted');
  });

  test('createAgent：defaultSkillIds 含重复 → 422', async () => {
    const fx = await seedFixture('create-skills-dup');
    let threw = false;
    try {
      await createAgent(db, {
        teamId: fx.teamId,
        actorId: fx.userId,
        displayName: 'X',
        defaultSkillIds: [fx.skillId, fx.skillId],
      });
    } catch (e) {
      threw = true;
      assert.equal((e as HttpError).statusCode, 422);
    }
    assert.ok(threw);
  });

  // ── updateAgent ──────────────────────────────────────────────

  test('updateAgent：部分更新 —— 未传字段保持原值', async () => {
    const fx = await seedFixture('update-partial');
    const created = await createAgent(db, {
      teamId: fx.teamId,
      actorId: fx.userId,
      displayName: 'Old Name',
      description: 'Old desc',
      provider: fx.providerId,
      modelId: 'gpt-4o-mini',
      thinkingLevel: 'low',
      defaultSkillIds: [fx.skillId],
      grants: { push_branch: true },
    });

    // 只改 displayName —— description / provider / modelId / thinkingLevel /
    // defaultSkillIds / grants 必须**不动**。
    const updated = await updateAgent(db, {
      teamId: fx.teamId,
      agentId: created.id,
      actorId: fx.userId,
      patch: { displayName: 'New Name' },
    });
    assert.equal(updated.displayName, 'New Name');
    assert.equal(updated.description, 'Old desc');
    assert.equal(updated.provider, fx.providerId);
    assert.equal(updated.modelId, 'gpt-4o-mini');
    assert.equal(updated.thinkingLevel, 'low');
    assert.deepEqual([...updated.defaultSkillIds], [fx.skillId]);
    assert.equal(updated.grants.push_branch, true);
  });

  test('updateAgent：defaultSkillIds 跨团队 → 422，未变更', async () => {
    const a = await seedFixture('upd-skill-a');
    const b = await seedFixture('upd-skill-b');
    const created = await createAgent(db, {
      teamId: a.teamId,
      actorId: a.userId,
      displayName: 'A',
      defaultSkillIds: [a.skillId],
    });

    const beforeSkills = [...created.defaultSkillIds];
    let threw = false;
    try {
      await updateAgent(db, {
        teamId: a.teamId,
        agentId: created.id,
        actorId: a.userId,
        patch: { defaultSkillIds: [b.skillId] },
      });
    } catch (e) {
      threw = true;
      assert.equal((e as HttpError).statusCode, 422);
    }
    assert.ok(threw);
    const row = (await sql<{ default_skill_ids: string[] }[]>`
      select default_skill_ids from agent where id = ${created.id}
    `)[0];
    assert.deepEqual(row!.default_skill_ids, beforeSkills, 'MUTATION? skills unchanged');
  });

  test('updateAgent：跨团队 → 404，未变更', async () => {
    const a = await seedFixture('upd-cross-a');
    const b = await seedFixture('upd-cross-b');
    const created = await createAgent(db, {
      teamId: a.teamId,
      actorId: a.userId,
      displayName: 'A',
    });
    const before = (await sql<{ display_name: string }[]>`
      select display_name from agent where id = ${created.id}
    `)[0]!;

    let threw = false;
    try {
      await updateAgent(db, {
        teamId: b.teamId, // ← 别人的 team
        agentId: created.id,
        actorId: b.userId,
        patch: { displayName: 'Hijacked' },
      });
    } catch (e) {
      threw = true;
      assert.equal((e as HttpError).statusCode, 404);
    }
    assert.ok(threw, 'cross-team update must 404');
    const after = (await sql<{ display_name: string }[]>`
      select display_name from agent where id = ${created.id}
    `)[0]!;
    assert.equal(after.display_name, before.display_name, 'MUTATION? name unchanged');
  });

  test('updateAgent：member 角色 → 403，未变更', async () => {
    const fx = await seedFixture('upd-non-admin');
    const created = await createAgent(db, {
      teamId: fx.teamId,
      actorId: fx.userId,
      displayName: 'Orig',
    });
    const before = (await sql<{ display_name: string }[]>`
      select display_name from agent where id = ${created.id}
    `)[0]!;

    let threw = false;
    try {
      await updateAgent(db, {
        teamId: fx.teamId,
        agentId: created.id,
        actorId: fx.plainUserId,
        patch: { displayName: 'Hijack' },
      });
    } catch (e) {
      threw = true;
      assert.equal((e as HttpError).statusCode, 403);
    }
    assert.ok(threw);
    const after = (await sql<{ display_name: string }[]>`
      select display_name from agent where id = ${created.id}
    `)[0]!;
    assert.equal(after.display_name, before.display_name, 'MUTATION? name unchanged');
  });

  test('updateAgent：空 patch → 不写库也不审计', async () => {
    const fx = await seedFixture('upd-empty');
    const created = await createAgent(db, {
      teamId: fx.teamId,
      actorId: fx.userId,
      displayName: 'Orig',
    });
    const tsBefore = (await sql<{ updated_at: number }[]>`
      select updated_at from agent where id = ${created.id}
    `)[0]!.updated_at;
    const auditBefore = (await sql<{ n: number }[]>`
      select count(*)::int as n from audit_event
      where team_id = ${fx.teamId} and type = 'agent_updated'
    `)[0]!.n;

    const updated = await updateAgent(db, {
      teamId: fx.teamId,
      agentId: created.id,
      actorId: fx.userId,
      patch: {},
    });
    assert.equal(updated.displayName, 'Orig');

    const tsAfter = (await sql<{ updated_at: number }[]>`
      select updated_at from agent where id = ${created.id}
    `)[0]!.updated_at;
    assert.equal(tsAfter, tsBefore, 'MUTATION? no-op update should not bump updated_at');
    const auditAfter = (await sql<{ n: number }[]>`
      select count(*)::int as n from audit_event
      where team_id = ${fx.teamId} and type = 'agent_updated'
    `)[0]!.n;
    assert.equal(auditAfter, auditBefore, 'MUTATION? no-op update should not audit');
  });

  test('updateAgent：description 可清空（传 null）', async () => {
    const fx = await seedFixture('upd-clear-desc');
    const created = await createAgent(db, {
      teamId: fx.teamId,
      actorId: fx.userId,
      displayName: 'X',
      description: 'has desc',
    });
    assert.equal(created.description, 'has desc');
    const updated = await updateAgent(db, {
      teamId: fx.teamId,
      agentId: created.id,
      actorId: fx.userId,
      patch: { description: null },
    });
    assert.equal(updated.description, null);
  });

  // ── deleteAgents ─────────────────────────────────────────────

  test('deleteAgents：单删 —— soft-delete（deletedAt 被打时间戳，行仍在）', async () => {
    const fx = await seedFixture('del-single');
    const created = await createAgent(db, {
      teamId: fx.teamId,
      actorId: fx.userId,
      displayName: 'To Delete',
    });
    const out = await deleteAgents(db, {
      teamId: fx.teamId,
      agentIds: [created.id],
      actorId: fx.userId,
    });
    assert.equal(out.succeeded, 1);
    assert.equal(out.failed, 0);
    assert.deepEqual(out.results, [{ agentId: created.id, ok: true }]);

    const row = (await sql<{ deleted_at: number | null; display_name: string }[]>`
      select deleted_at, display_name from agent where id = ${created.id}
    `)[0];
    assert.ok(row, 'MUTATION? soft-delete must NOT remove the row');
    assert.ok(row!.deleted_at !== null, 'deletedAt should be set');
    assert.equal(row!.display_name, 'To Delete');

    // audit_event 落了一条
    const audit = (await sql<{ n: number }[]>`
      select count(*)::int as n from audit_event
      where team_id = ${fx.teamId} and type = 'agent_deleted'
        and actor_id = ${fx.userId}
    `)[0]!;
    assert.ok(audit.n >= 1, 'MUTATION? audit agent_deleted should exist');
  });

  test('deleteAgents：批量 —— 一项失败不影响其它项', async () => {
    const fx = await seedFixture('del-batch');
    const a = await createAgent(db, {
      teamId: fx.teamId,
      actorId: fx.userId,
      displayName: 'A',
    });
    const b = await createAgent(db, {
      teamId: fx.teamId,
      actorId: fx.userId,
      displayName: 'B',
    });
    const ghost = newId(); // 不存在

    const out = await deleteAgents(db, {
      teamId: fx.teamId,
      agentIds: [a.id, ghost, b.id],
      actorId: fx.userId,
    });
    assert.equal(out.succeeded, 2);
    assert.equal(out.failed, 1);
    assert.equal(out.results.length, 3);
    assert.deepEqual(out.results[0], { agentId: a.id, ok: true });
    assert.equal(out.results[1]!.agentId, ghost);
    assert.equal(out.results[1]!.ok, false);
    assert.ok(out.results[1]!.reason, 'failed entry should carry a reason');
    assert.deepEqual(out.results[2], { agentId: b.id, ok: true });

    // ghost 没误删任何其它 agent —— 用 fx.teamId 限定。
    const survivors = await sql<{ n: number }[]>`
      select count(*)::int as n from agent where team_id = ${fx.teamId} and deleted_at is null
    `;
    assert.equal(survivors[0]!.n, 1, 'MUTATION? exactly the seed agent remains active');
  });

  test('deleteAgents：跨团队 → 该项 ok:false，其它项不受影响', async () => {
    const a = await seedFixture('del-cross-a');
    const b = await seedFixture('del-cross-b');
    const aAgent = await createAgent(db, {
      teamId: a.teamId,
      actorId: a.userId,
      displayName: 'A',
    });
    const bAgent = await createAgent(db, {
      teamId: b.teamId,
      actorId: b.userId,
      displayName: 'B',
    });

    // a 的 admin 想用 a 的 teamId 去删 b 的 agent —— 应该 ok:false
    const out = await deleteAgents(db, {
      teamId: a.teamId,
      agentIds: [aAgent.id, bAgent.id],
      actorId: a.userId,
    });
    assert.equal(out.succeeded, 1);
    assert.equal(out.failed, 1);
    assert.deepEqual(out.results[0], { agentId: aAgent.id, ok: true });
    assert.equal(out.results[1]!.agentId, bAgent.id);
    assert.equal(out.results[1]!.ok, false);

    // b 的 agent 必须没动 —— b.teamId 限定
    const bRow = (await sql<{ deleted_at: number | null }[]>`
      select deleted_at from agent where id = ${bAgent.id}
    `)[0]!;
    assert.equal(bRow.deleted_at, null, 'MUTATION? cross-team delete must not touch b');
  });

  test('deleteAgents：member 角色 → 整体拒绝（admin 闸门），全部 ok:false，无写入', async () => {
    const fx = await seedFixture('del-non-admin');
    const a = await createAgent(db, {
      teamId: fx.teamId,
      actorId: fx.userId,
      displayName: 'A',
    });
    const before = (await sql<{ deleted_at: number | null }[]>`
      select deleted_at from agent where id = ${a.id}
    `)[0]!.deleted_at;

    let threw = false;
    try {
      await deleteAgents(db, {
        teamId: fx.teamId,
        agentIds: [a.id],
        actorId: fx.plainUserId,
      });
    } catch (e) {
      threw = true;
      assert.equal((e as HttpError).statusCode, 403);
    }
    assert.ok(threw, 'admin gate should reject before any per-item work');

    const after = (await sql<{ deleted_at: number | null }[]>`
      select deleted_at from agent where id = ${a.id}
    `)[0]!.deleted_at;
    assert.equal(after, before, 'MUTATION? no row should be soft-deleted');
  });

  test('deleteAgents：批量空 → 0 succeeded / 0 failed，无 audit', async () => {
    const fx = await seedFixture('del-empty');
    const before = (await sql<{ n: number }[]>`
      select count(*)::int as n from audit_event
      where team_id = ${fx.teamId} and type = 'agent_deleted'
    `)[0]!.n;
    const out = await deleteAgents(db, {
      teamId: fx.teamId,
      agentIds: [],
      actorId: fx.userId,
    });
    assert.deepEqual(out.results, []);
    assert.equal(out.succeeded, 0);
    assert.equal(out.failed, 0);
    const after = (await sql<{ n: number }[]>`
      select count(*)::int as n from audit_event
      where team_id = ${fx.teamId} and type = 'agent_deleted'
    `)[0]!.n;
    assert.equal(after, before, 'MUTATION? no audit should be written');
  });
});
