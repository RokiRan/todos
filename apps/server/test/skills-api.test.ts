import assert from 'node:assert/strict';
import { test, describe, before, after, beforeEach } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import * as dbPkg from '@tds/db';
import { newId, now } from '../src/ids.js';
import { registerSkillRoutes } from '../src/routes/skills.js';
import { generateApiKey } from '../src/crypto.js';

/**
 * skill CRUD 路由验证。
 *
 * 业务规则（来自 recon/docs/skills.md 与 agents.md）：
 *   1. skill.source ∈ {'folder','github','files','chief'}（schema 约束）
 *   2. size ≤ 10 MiB；file_count ≤ 256（schema 注释 + 路由层兜底）
 *   3. 创建/改/删需 team admin；普通成员可读
 *   4. 删除是**硬删除**（docs/skills.md "cannot be undone"），且
 *      agent.defaultSkillIds 里的残留 skillId 会被同步清掉
 *   5. agent defaultSkillIds ≤ 10（agents.md 硬上限）
 *   6. storage_path 必须真实存在，路径穿越被挡
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://tds@127.0.0.1:5433/tds';
const STORAGE_ROOT = path.join(os.tmpdir(), `tds-skills-test-${process.pid}-${Date.now()}`);

let sql: postgres.Sql;
let app: FastifyInstance;
const fixtures: Array<{ userId: string; teamId: string; memberId: string; agentId?: string; key: string }> = [];

describe('skill CRUD', () => {
  before(async () => {
    process.env.TDS_STORAGE_DIR = STORAGE_ROOT;
    sql = postgres(DATABASE_URL, { max: 1 });
    await fs.mkdir(STORAGE_ROOT, { recursive: true });

    const db = drizzle(sql, { schema: dbPkg.schema });
    app = Fastify({ logger: false });
    registerSkillRoutes(app, db as never);
    await app.ready();
  });

  after(async () => {
    await cleanupAll();
    await app.close();
    await sql.end();
    await fs.rm(STORAGE_ROOT, { recursive: true, force: true });
  });

  beforeEach(cleanupAll);

  async function cleanupAll(): Promise<void> {
    // 按 FK 反向顺序清理 —— skill → agent_skill → agent → member → team → user
    for (const f of fixtures) {
      await sql`delete from skill where team_id = ${f.teamId}`;
      if (f.agentId) await sql`delete from agent where id = ${f.agentId}`;
      await sql`delete from member where team_id = ${f.teamId}`;
      await sql`delete from team where id = ${f.teamId}`;
      await sql`delete from "user" where id = ${f.userId}`;
    }
    fixtures.length = 0;
  }

  interface Fixture {
    userId: string;
    teamId: string;
    memberId: string;
    agentId?: string;
    key: string;
  }

  async function seed(role: 'admin' | 'member' = 'admin', label = 'sk'): Promise<Fixture> {
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
    const fixture: Fixture = { userId, teamId, memberId, key: k.key };
    fixtures.push(fixture);
    return fixture;
  }

  async function seedAgent(f: Fixture, displayName = 'agent-1'): Promise<string> {
    const ts = now();
    const agentId = newId();
    await sql`insert into agent (id,team_id,display_name,default_skill_ids,grants,active_task_count,created_at,updated_at)
                values (${agentId}, ${f.teamId}, ${displayName}, '{}'::text[], '{}'::jsonb, 0, ${ts}, ${ts})`;
    f.agentId = agentId;
    return agentId;
  }

  function body(f: Fixture, over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      userId: f.userId,
      name: 'deploy-checklist',
      skillMd: '# Deploy\n\nRun tests first.',
      source: 'files',
      sourceUrl: null,
      assets: [],
      ...over,
    };
  }

  // ── 列表 / 创建 ────────────────────────────────────────────────

  test('创建 skill：写盘成功 + DB 行 + sizeBytes/fileCount 正确', async () => {
    const f = await seed();
    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/skills`,
      payload: body(f, {
        name: 'checklist',
        skillMd: '# Checklist\n\nStep 1',
        assets: [{ name: 'extra.txt', contentBase64: Buffer.from('hello').toString('base64') }],
      }),
    });
    assert.equal(res.statusCode, 200, res.body);
    const parsed = JSON.parse(res.body) as { skill: { id: string; name: string; sizeBytes: number; fileCount: number; storagePath: string } };
    assert.ok(parsed.skill.id);
    assert.equal(parsed.skill.name, 'checklist');
    // SKILL.md (12 chars in utf-8) + extra.txt (5 bytes)
    assert.ok(parsed.skill.sizeBytes >= 17);
    assert.equal(parsed.skill.fileCount, 2);

    // storagePath 必须真实存在且 SKILL.md 内容正确
    const skDir = parsed.skill.storagePath;
    const stat = await fs.stat(skDir);
    assert.ok(stat.isDirectory(), 'storage_path 应是目录');
    const md = await fs.readFile(path.join(skDir, 'SKILL.md'), 'utf8');
    assert.equal(md, '# Checklist\n\nStep 1');
    const extra = await fs.readFile(path.join(skDir, 'extra.txt'), 'utf8');
    assert.equal(extra, 'hello');
  });

  test('GET 列出团队 skill（成员也能看）', async () => {
    const admin = await seed('admin', 'sk-list-admin');
    await app.inject({
            headers: { authorization: `Bearer ${admin.key}` },
      method: 'POST',
      url: `/api/teams/${admin.teamId}/skills`,
      payload: body(admin, { name: 'one' }),
    });
    await app.inject({
            headers: { authorization: `Bearer ${admin.key}` },
      method: 'POST',
      url: `/api/teams/${admin.teamId}/skills`,
      payload: body(admin, { name: 'two' }),
    });

    // 降级为 member，再读
    await sql`update member set role = 'member' where team_id = ${admin.teamId}`;
    const res = await app.inject({
                        headers: { authorization: `Bearer ${admin.key}` },
      method: 'GET',
      url: `/api/teams/${admin.teamId}/skills?userId=${admin.userId}`,
    });
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res.body) as { skills: Array<{ name: string }> };
    assert.equal(parsed.skills.length, 2);
    assert.deepEqual(
      parsed.skills.map((s) => s.name).sort(),
      ['one', 'two'],
    );
  });

  test('改 SKILL.md 正文：磁盘同步刷新 + sizeBytes 重算', async () => {
    const f = await seed();
    const created = await app.inject({
                            headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/skills`,
      payload: body(f, { skillMd: '# Old' }),
    });
    const skillId = (JSON.parse(created.body) as { skill: { id: string; storagePath: string } }).skill.id;
    const dir = (JSON.parse(created.body) as { skill: { storagePath: string } }).skill.storagePath;

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'PATCH',
      url: `/api/teams/${f.teamId}/skills/${skillId}`,
      payload: { userId: f.userId, skillMd: '# New and longer content here' },
    });
    assert.equal(res.statusCode, 200, res.body);
    const parsed = JSON.parse(res.body) as { skill: { sizeBytes: number } };
    assert.equal(parsed.skill.sizeBytes, '# New and longer content here'.length);

    // 磁盘上必须是新内容，不能留旧 SKILL.md
    const md = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8');
    assert.equal(md, '# New and longer content here');
  });

  test('改名 + 无关字段不动', async () => {
    const f = await seed();
    const created = await app.inject({
                            headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/skills`,
      payload: body(f, { name: 'before' }),
    });
    const skillId = (JSON.parse(created.body) as { skill: { id: string } }).skill.id;

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'PATCH',
      url: `/api/teams/${f.teamId}/skills/${skillId}`,
      payload: { userId: f.userId, name: 'after' },
    });
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res.body) as { skill: { name: string } };
    assert.equal(parsed.skill.name, 'after');
  });

  test('删 skill：硬删除 + 磁盘清掉 + agent.defaultSkillIds 残留引用清掉', async () => {
    const f = await seed();
    const agentId = await seedAgent(f);
    const created = await app.inject({
                            headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/skills`,
      payload: body(f),
    });
    const skillId = (JSON.parse(created.body) as { skill: { id: string; storagePath: string } }).skill.id;
    const dir = (JSON.parse(created.body) as { skill: { storagePath: string } }).skill.storagePath;

    // 绑定为 agent default
    const bind = await app.inject({
                         headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/agents/${agentId}/skills`,
      payload: { userId: f.userId, defaultSkillIds: [skillId] },
    });
    assert.equal(bind.statusCode, 200, bind.body);

    // 再加一个不相关的 skill，验证只有这个被清掉
    const other = await app.inject({
                          headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/skills`,
      payload: body(f, { name: 'keep-me' }),
    });
    const otherId = (JSON.parse(other.body) as { skill: { id: string } }).skill.id;
    await app.inject({
            headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/agents/${agentId}/skills`,
      payload: { userId: f.userId, defaultSkillIds: [skillId, otherId] },
    });

    // 删第一个
    const del = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'DELETE',
      url: `/api/teams/${f.teamId}/skills/${skillId}?userId=${f.userId}`,
    });
    assert.equal(del.statusCode, 200, del.body);

    // 1) DB 行没了
    const rows = await sql`select 1 from skill where id = ${skillId}`;
    assert.equal(rows.length, 0, '硬删除 —— skill 行必须消失');

    // 2) 磁盘清掉
    await assert.rejects(fs.stat(dir), /ENOENT/, '磁盘目录必须被删');

    // 3) agent.defaultSkillIds 不再含已删 id，但保留另一个
    const agentRows = await sql<{ default_skill_ids: string[] }[]>`
      select default_skill_ids from agent where id = ${agentId}
    `;
    assert.equal(agentRows.length, 1);
    const ids = agentRows[0]!.default_skill_ids;
    assert.ok(!ids.includes(skillId), '已删 skillId 必须从残留数组里移除');
    assert.ok(ids.includes(otherId), '未删的 skillId 必须保留');
  });

  // ── 鉴权 ─────────────────────────────────────────────────────

  test('非 admin 不能创建（403）', async () => {
    const f = await seed('member');
    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/skills`,
      payload: body(f),
    });
    assert.equal(res.statusCode, 403, res.body);
    // 也不能写盘 —— 检查目录里没有这个 teamId
    const teamDir = path.join(STORAGE_ROOT, f.teamId);
    await assert.rejects(fs.stat(teamDir), /ENOENT/, '403 后不能落盘');
  });

  test('非 admin 不能改/删（403）', async () => {
    const admin = await seed('admin', 'sk-auth-a');
    const created = await app.inject({
                            headers: { authorization: `Bearer ${admin.key}` },
      method: 'POST',
      url: `/api/teams/${admin.teamId}/skills`,
      payload: body(admin),
    });
    const skillId = (JSON.parse(created.body) as { skill: { id: string } }).skill.id;

    const member = await seed('member', 'sk-auth-m');
    // member 不能改
    const upd = await app.inject({
                        headers: { authorization: `Bearer ${member.key}` },
      method: 'PATCH',
      url: `/api/teams/${admin.teamId}/skills/${skillId}`,
      payload: { userId: member.userId, name: 'hijack' },
    });
    assert.equal(upd.statusCode, 403, upd.body);
    // member 不能删
    const del = await app.inject({
                        headers: { authorization: `Bearer ${member.key}` },
      method: 'DELETE',
      url: `/api/teams/${admin.teamId}/skills/${skillId}?userId=${member.userId}`,
    });
    assert.equal(del.statusCode, 403, del.body);
  });

  test('非团队成员读列表被 403', async () => {
    const team = await seed('admin', 'sk-fg');
    const outsider = await seed('admin', 'sk-outsider');
    const res = await app.inject({
                        headers: { authorization: `Bearer ${outsider.key}` },
      method: 'GET',
      url: `/api/teams/${team.teamId}/skills?userId=${outsider.userId}`,
    });
    assert.equal(res.statusCode, 403, res.body);
  });

  // ── default skill 数量硬上限 ───────────────────────────────

  test('绑第 11 个 default skill 被拒（422）', async () => {
    const f = await seed();
    const agentId = await seedAgent(f);
    // 建 11 个 skill
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
        method: 'POST',
        url: `/api/teams/${f.teamId}/skills`,
        payload: body(f, { name: `s-${i}` }),
      });
      assert.equal(r.statusCode, 200, r.body);
      ids.push((JSON.parse(r.body) as { skill: { id: string } }).skill.id);
    }

    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/agents/${agentId}/skills`,
      payload: { userId: f.userId, defaultSkillIds: ids },
    });
    assert.equal(res.statusCode, 422, res.body);
    assert.match(res.body, /10/, '错误信息里要包含 10 这个上限数字');

    // 绑定 10 个应该成功
    const ok = await app.inject({
                       headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/agents/${agentId}/skills`,
      payload: { userId: f.userId, defaultSkillIds: ids.slice(0, 10) },
    });
    assert.equal(ok.statusCode, 200, ok.body);
  });

  // ── 路径穿越 / 大小限制 ────────────────────────────────────

  test('asset name 带 `../` 被挡（422），磁盘不污染', async () => {
    const f = await seed();
    const before = await fs.readdir(STORAGE_ROOT);
    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/skills`,
      payload: body(f, {
        assets: [{ name: '../escape.txt', contentBase64: Buffer.from('pwn').toString('base64') }],
      }),
    });
    assert.equal(res.statusCode, 422, res.body);
    const after = await fs.readdir(STORAGE_ROOT);
    assert.deepEqual(after, before, '422 后不能落盘');
  });

  test('asset name 是绝对路径或 SKILL.md 重名也被挡', async () => {
    const f = await seed();
    for (const bad of ['/etc/passwd', 'SKILL.md', '..']) {
      const res = await app.inject({
                          headers: { authorization: `Bearer ${f.key}` },
        method: 'POST',
        url: `/api/teams/${f.teamId}/skills`,
        payload: body(f, {
          assets: [{ name: bad, contentBase64: Buffer.from('x').toString('base64') }],
        }),
      });
      assert.equal(res.statusCode, 422, `name=${JSON.stringify(bad)} 应被拒`);
    }
  });

  test('skill 内容超过 10 MiB 被拒，且不留半成品', async () => {
    const f = await seed();
    // SKILL.md 写到 11 MiB
    const big = 'a'.repeat(11 * 1024 * 1024);
    const before = await fs.readdir(STORAGE_ROOT).catch(() => []);
    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/skills`,
      payload: body(f, { skillMd: big }),
    });
    assert.equal(res.statusCode, 422, res.body);
    // 不能落盘成功 —— 列出目录，确认没新建任何文件
    const after = await fs.readdir(STORAGE_ROOT);
    const newFiles = after.filter((n) => !before.includes(n));
    assert.equal(newFiles.length, 0, '失败回滚：磁盘不应有半成品');
  });

  // ── 关联校验 ──────────────────────────────────────────────

  test('绑不属于本团队的 skillId 被拒', async () => {
    const f = await seed();
    const other = await seed('admin', 'sk-cross');
    const otherSkill = await app.inject({
                               headers: { authorization: `Bearer ${other.key}` },
      method: 'POST',
      url: `/api/teams/${other.teamId}/skills`,
      payload: body(other, { name: 'cross-team' }),
    });
    const otherId = (JSON.parse(otherSkill.body) as { skill: { id: string } }).skill.id;

    const agentId = await seedAgent(f);
    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'POST',
      url: `/api/teams/${f.teamId}/agents/${agentId}/skills`,
      payload: { userId: f.userId, defaultSkillIds: [otherId] },
    });
    assert.equal(res.statusCode, 422, res.body);
  });

  test('删不存在的 skill → 404', async () => {
    const f = await seed();
    const res = await app.inject({
                        headers: { authorization: `Bearer ${f.key}` },
      method: 'DELETE',
      url: `/api/teams/${f.teamId}/skills/${newId()}?userId=${f.userId}`,
    });
    assert.equal(res.statusCode, 404, res.body);
  });

  test('无凭据打 skill 列表 → 401，且库里没写', async () => {
    const f = await seed();
    const before = await sql<{ n: number }[]>`select count(*)::int as n from skill where team_id = ${f.teamId}`;
    const res = await app.inject({ method: 'GET', url: `/api/teams/${f.teamId}/skills` });
    assert.equal(res.statusCode, 401, `body=${res.body}`);
    const after = await sql<{ n: number }[]>`select count(*)::int as n from skill where team_id = ${f.teamId}`;
    assert.equal(Number(after[0]?.n), Number(before[0]?.n), '401 不该写库');
  });

  test('A 团队的 key 打 B 团队的 skill → 403，且库里没写', async () => {
    const a = await seed('admin', 'skill-A');
    const b = await seed('admin', 'skill-B');
    const created = await app.inject({
      method: 'POST',
      url: `/api/teams/${b.teamId}/skills`,
      headers: { authorization: `Bearer ${b.key}` },
      payload: body(b, { skillMd: '# ok' }),
    });
    assert.equal(created.statusCode, 200, created.body);
    const before = await sql<{ n: number }[]>`select count(*)::int as n from skill where team_id = ${b.teamId}`;
    const res = await app.inject({
      method: 'GET',
      url: `/api/teams/${b.teamId}/skills`,
      headers: { authorization: `Bearer ${a.key}` },
    });
    assert.equal(res.statusCode, 403, res.body);
    assert.match(res.body, /is not accessible to this key's owner/);
    const after = await sql<{ n: number }[]>`select count(*)::int as n from skill where team_id = ${b.teamId}`;
    assert.equal(Number(after[0]?.n), Number(before[0]?.n), '403 不该写库');
  });

  test('key 是 A、body.userId 传 B → 403，且库里没写', async () => {
    const a = await seed('admin', 'skill-imp');
    const b = await seed('admin', 'skill-victim');
    const res = await app.inject({
      method: 'POST',
      url: `/api/teams/${b.teamId}/skills`,
      headers: { authorization: `Bearer ${a.key}` },
      payload: body(b, { userId: b.userId, skillMd: '# ok' }),
    });
    assert.equal(res.statusCode, 403, res.body);
    assert.match(res.body, /is not this key's owner/);
    const rows = await sql<{ n: number }[]>`select count(*)::int as n from skill where team_id = ${b.teamId}`;
    assert.equal(Number(rows[0]?.n), 0, '冒充失败时一行都不该写');
  });
});
