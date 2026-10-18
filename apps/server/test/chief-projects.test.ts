/**
 * Chief 工具 `create_project` / `update_project` 服务层真库验证。
 *
 * 只验 `services/projects-admin.ts`，不走 routes（这两个工具本就是
 * MCP 面上无路由、Chief 直接走服务层）。
 *
 * 关键断言：
 *   - 正向 create 写一行 + nextSeqNum=1 + 审计齐
 *   - quota 拒绝时不写 project（查库证明 — `where team_id = ${fx.teamId}`）
 *   - 跨 team 更新 403 且查库证明该项目没被改
 *   - 部分更新只碰 patch 提到的字段，未提不动
 *   - repoUrl 形态校验在服务层抛 422
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
import { generateApiKey } from '../src/crypto.js';
import {
  createProject,
  updateProject,
  assertValidRepoUrl,
} from '../src/services/projects-admin.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://tds@127.0.0.1:5433/tds';

let sql: postgres.Sql;
let db: Db;
const fixtures: Array<{
  userId: string;
  teamA: string;
  teamB: string;
  memberId: string;
  keyA: string;
  keyB: string;
}> = [];

interface Fixture {
  userId: string;
  teamA: string;
  teamB: string;
  memberId: string;
  keyA: string;
  keyB: string;
}

async function seed(label = 'cp'): Promise<Fixture> {
  const ts = now();
  const userId = newId();
  const teamA = newId();
  const teamB = newId();
  const memberId = newId();
  const email = `${label}-${userId}@test.local`;
  const nameA = `${label}-A`;
  const nameB = `${label}-B`;
  await sql`insert into "user" (id,email,display_name,created_at,updated_at)
              values (${userId}, ${email}, ${label}, ${ts}, ${ts})`;
  await sql`insert into team (id,name,plan,storage_quota,created_at)
              values (${teamA}, ${nameA}, 'free', 1073741824, ${ts}),
                     (${teamB}, ${nameB}, 'free', 1073741824, ${ts})`;
  await sql`insert into member (id,team_id,actor_id,member_type,role,joined_at,v)
              values (${memberId}, ${teamA}, ${userId}, 'user', 'admin', ${ts}, 0)`;
  const ka = generateApiKey();
  const kb = generateApiKey();
  await sql`insert into "api_key" (id,user_id,name,key_prefix,key_hash,scopes,created_at)
              values (${newId()}, ${userId}, 'a', ${ka.prefix}, ${ka.hash}, ${['*']}, ${ts}),
                     (${newId()}, ${userId}, 'b', ${kb.prefix}, ${kb.hash}, ${['*']}, ${ts})`;
  const fx: Fixture = { userId, teamA, teamB, memberId, keyA: ka.key, keyB: kb.key };
  fixtures.push(fx);
  return fx;
}

async function cleanupAll(): Promise<void> {
  for (const f of fixtures) {
    await sql`delete from project where team_id = ${f.teamA} or team_id = ${f.teamB}`;
    await sql`delete from audit_event where team_id = ${f.teamA} or team_id = ${f.teamB}`;
    await sql`delete from member where team_id = ${f.teamA} or team_id = ${f.teamB}`;
    await sql`delete from team where id = ${f.teamA} or id = ${f.teamB}`;
    await sql`delete from "user" where id = ${f.userId}`;
  }
  fixtures.length = 0;
}

describe('createProject', () => {
  before(async () => {
    sql = postgres(DATABASE_URL, { max: 1 });
    db = drizzle(sql, { schema: dbPkg.schema });
  });

  after(async () => {
    await cleanupAll();
    await sql.end();
  });

  test('成功建一个项目：next_seq_num=1 + 审计 + 摘要字段对齐', async () => {
    const fx = await seed('cp-happy');
    const sum = await createProject(db, {
      teamId: fx.teamA,
      actorId: fx.userId,
      name: '  Alpha  ', // 故意带前导空白 — 该被 trim
      repoKind: 'github',
      repoFullName: 'octo/cat',
      repoUrl: 'git@github.com:octo/cat.git',
      defaultBranch: 'main',
      description: 'cat project',
    });

    assert.ok(sum.id);
    assert.equal(sum.teamId, fx.teamA);
    assert.equal(sum.name, 'Alpha', 'name 应被 trim 干净');
    assert.equal(sum.repoKind, 'github');
    assert.equal(sum.repoFullName, 'octo/cat');
    assert.equal(sum.repoUrl, 'git@github.com:octo/cat.git');
    assert.equal(sum.defaultBranch, 'main');
    assert.equal(sum.description, 'cat project');

    // 查库：nextSeqNum 必须为 1（todo 编号分配器起点）
    const rows = await sql<
      Array<{ next_seq_num: number }>
    >`select next_seq_num from project where id = ${sum.id}`;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.next_seq_num, 1, 'MUTATION? nextSeqNum 必须初始化为 1');

    // 审计行落到该 team
    const audit = await sql<
      Array<{ type: string; actor_id: string }>
    >`select type, actor_id from audit_event
        where team_id = ${fx.teamA} and type = 'project_created'`;
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.actor_id, fx.userId);
  });

  test('name 空 / 全空白拒绝 422', async () => {
    const fx = await seed('cp-name');
    await assert.rejects(
      () =>
        createProject(db, {
          teamId: fx.teamA,
          actorId: fx.userId,
          name: '   ',
        }),
      /name must not be empty/,
    );
    const rows = await sql`select id from project where team_id = ${fx.teamA}`;
    assert.equal(rows.length, 0, 'MUTATION? 空 name 拒绝后不应建出行');
  });

  test('repoUrl 非法形态拒绝 422', async () => {
    const fx = await seed('cp-url');
    await assert.rejects(
      () =>
        createProject(db, {
          teamId: fx.teamA,
          actorId: fx.userId,
          name: 'bad-url',
          repoUrl: 'ssh://evil.example/octocat', // 注意:不是 git@ 也不是 https
        }),
      /git@/,
    );
    const rows = await sql`select id from project where team_id = ${fx.teamA}`;
    assert.equal(rows.length, 0, 'MUTATION? 非法 repoUrl 拒绝后不应建出行');
  });

  test('合法 repoUrl 三种形态都过（git@ / https / file）', async () => {
    const fx = await seed('cp-url3');
    for (const url of [
      'git@github.com:o/r.git',
      'https://gitlab.example/o/r.git',
      'file:///tmp/repos/local.git',
    ]) {
      assert.doesNotThrow(() => assertValidRepoUrl(url), url);
    }
    // 也确认服务层都能成功落库
    for (const [i, url] of [
      'git@github.com:o/r.git',
      'https://gitlab.example/o/r.git',
      'file:///tmp/repos/local.git',
    ].entries()) {
      const sum = await createProject(db, {
        teamId: fx.teamA,
        actorId: fx.userId,
        name: `p-${i}`,
        repoUrl: url,
      });
      assert.equal(sum.repoUrl, url);
    }
  });

  test('超 Free 档 6 个项目上限：第 7 个拒绝且查库证明总数就是 6', async () => {
    const fx = await seed('cp-quota');
    for (let i = 0; i < 6; i++) {
      await createProject(db, {
        teamId: fx.teamA,
        actorId: fx.userId,
        name: `q-${i}`,
      });
    }
    await assert.rejects(
      () =>
        createProject(db, {
          teamId: fx.teamA,
          actorId: fx.userId,
          name: 'q-overflow',
        }),
      /项目数/,
    );
    // 关键：跨拒绝 *后* 仍然只有 6 行 — 服务层不应该静默多写
    const rows = await sql`select id from project where team_id = ${fx.teamA}`;
    assert.equal(rows.length, 6, 'MUTATION? 超限后库内总数应仍为 6');
  });
});

describe('updateProject', () => {
  before(async () => {
    sql = postgres(DATABASE_URL, { max: 1 });
    db = drizzle(sql, { schema: dbPkg.schema });
  });

  after(async () => {
    await cleanupAll();
    await sql.end();
  });

  test('部分更新：只 patch.name 改名字，其它列保持原值', async () => {
    const fx = await seed('upd-partial');
    const created = await createProject(db, {
      teamId: fx.teamA,
      actorId: fx.userId,
      name: 'orig',
      repoKind: 'github',
      repoFullName: 'octo/cat',
      repoUrl: 'git@github.com:octo/cat.git',
      defaultBranch: 'main',
      description: '原描述',
    });

    const after = await updateProject(db, {
      teamId: fx.teamA,
      projectId: created.id,
      actorId: fx.userId,
      patch: { name: 'renamed' },
    });

    assert.equal(after.name, 'renamed');
    assert.equal(after.repoKind, 'github', 'MUTATION? 未传字段不应被改');
    assert.equal(after.repoFullName, 'octo/cat');
    assert.equal(after.repoUrl, 'git@github.com:octo/cat.git');
    assert.equal(after.defaultBranch, 'main');
    assert.equal(after.description, '原描述');
  });

  test('空 patch：直接返回原值且不写审计', async () => {
    const fx = await seed('upd-empty');
    const created = await createProject(db, {
      teamId: fx.teamA,
      actorId: fx.userId,
      name: 'no-change',
    });
    const beforeAuditCount = await sql<{ c: number }[]>`
      select count(*)::int as c from audit_event where team_id = ${fx.teamA}`;

    const after = await updateProject(db, {
      teamId: fx.teamA,
      projectId: created.id,
      actorId: fx.userId,
      patch: {},
    });
    assert.deepEqual(after, created);

    const afterAuditCount = await sql<{ c: number }[]>`
      select count(*)::int as c from audit_event where team_id = ${fx.teamA}`;
    assert.equal(
      afterAuditCount[0]!.c,
      beforeAuditCount[0]!.c,
      'MUTATION? 空 patch 不应写新审计',
    );
  });

  test('defaultBranch 与 description 同时改：两字段都生效', async () => {
    const fx = await seed('upd-multi');
    const created = await createProject(db, {
      teamId: fx.teamA,
      actorId: fx.userId,
      name: 'multi',
      defaultBranch: 'main',
      description: 'old',
    });
    const after = await updateProject(db, {
      teamId: fx.teamA,
      projectId: created.id,
      actorId: fx.userId,
      patch: { defaultBranch: 'develop', description: 'new' },
    });
    assert.equal(after.defaultBranch, 'develop');
    assert.equal(after.description, 'new');
  });

  test('跨团队 update 403 + 查库证明该项目*没*被改', async () => {
    const fx = await seed('upd-cross');
    const created = await createProject(db, {
      teamId: fx.teamA,
      actorId: fx.userId,
      name: 'belongs-A',
      defaultBranch: 'main',
    });

    await assert.rejects(
      () =>
        updateProject(db, {
          // 用 teamB（不属于这个项目）冒充该项目的 owner
          teamId: fx.teamB,
          projectId: created.id,
          actorId: fx.userId,
          patch: { name: 'hijacked' },
        }),
      /team "[^"]+" is not accessible to this key's owner/,
    );

    // 查 A 队下的原项目 —— 名字必须仍为 'belongs-A'
    const rows = await sql<Array<{ name: string; default_branch: string }>>`
      select name, default_branch from project where id = ${created.id}`;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.name, 'belongs-A', 'MUTATION? 跨团队拒绝后项目未被改');
    assert.equal(rows[0]!.default_branch, 'main');
  });

  test('跨团队 + 项目不存在 也走 403（不泄露存在性）', async () => {
    const fx = await seed('upd-cross-miss');
    await assert.rejects(
      () =>
        updateProject(db, {
          teamId: fx.teamB,
          projectId: 'does-not-exist',
          actorId: fx.userId,
          patch: { name: 'x' },
        }),
      /team "[^"]+" is not accessible to this key's owner/,
    );
  });
});
