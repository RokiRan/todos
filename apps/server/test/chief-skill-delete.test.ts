import assert from 'node:assert/strict';
import { test, describe, before, after, beforeEach } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as dbPkg from '@tds/db';
import { newId, now } from '../src/ids.js';
import { deleteSkills } from '../src/services/skill-deletion.js';

/**
 * Chief 工具面 `delete_skills` 服务层验证。
 *
 * 与 `skills-api.test.ts` 的关系：本文件只验服务层（不挂 Fastify），
 * 磁盘验证是真切的「打开目录、列文件、stat ENOENT」。两者共用同一份
 * fixture / cleanup 风格，方便后续加新 case 时直接复用 `seed` /
 * `seedSkillWithFiles` 模板。
 *
 * 必查清单（不查库只查库等于没验）：
 *   1. 库行消失（硬删除）
 *   2. **磁盘目录消失**（核心：这是本单的危险点）
 *   3. agent.defaultSkillIds 里残留 skillId 被清掉
 *   4. 跨 team 403 —— DB 与磁盘都没动
 *   5. 批量：单项失败不影响其它项
 *   6. 磁盘已缺失时仍 ok:true（幂等）
 *   7. 审计行（audit_event.actor_type='chief'，payload 含 skillId）
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://tds@127.0.0.1:5433/tds';
const STORAGE_ROOT = path.join(
  os.tmpdir(),
  `tds-chief-skill-delete-test-${process.pid}-${Date.now()}`,
);

let sql: postgres.Sql;
const fixtures: Array<{ userId: string; teamId: string; memberId: string; agentId?: string }> = [];

describe('Chief delete_skills 服务层', () => {
  before(async () => {
    process.env.TDS_STORAGE_DIR = STORAGE_ROOT;
    sql = postgres(DATABASE_URL, { max: 1 });
    await fs.mkdir(STORAGE_ROOT, { recursive: true });
  });

  after(async () => {
    await cleanupAll();
    await sql.end();
    await fs.rm(STORAGE_ROOT, { recursive: true, force: true });
  });

  beforeEach(cleanupAll);

  async function cleanupAll(): Promise<void> {
    // 按 FK 反向顺序清理：audit_event → skill → agent_skill → agent → member → team → user
    // 注意 audit_event 也带 team_id FK，所以要先清。
    for (const f of fixtures) {
      await sql`delete from audit_event where team_id = ${f.teamId}`;
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
  }

  async function seed(label = 'cs'): Promise<Fixture> {
    const ts = now();
    const userId = newId();
    const teamId = newId();
    const memberId = newId();
    await sql`insert into "user" (id,email,display_name,created_at,updated_at)
                values (${userId}, ${`${label}-${userId}@test.local`}, ${label}, ${ts}, ${ts})`;
    await sql`insert into team (id,name,plan,storage_quota,created_at)
                values (${teamId}, ${label}, 'free', 1073741824, ${ts})`;
    await sql`insert into member (id,team_id,actor_id,member_type,role,joined_at,v)
                values (${memberId}, ${teamId}, ${userId}, 'user', 'admin', ${ts}, 0)`;
    const fixture: Fixture = { userId, teamId, memberId };
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

  /**
   * 真落盘 + 插 DB 行（不走 REST 路由，因为本测试只验服务层）。
   * 路径布局：`<STORAGE_ROOT>/<teamId>/<skillId>/SKILL.md` + 可选 companion file。
   * 返回 skillId 与落盘目录绝对路径。
   */
  async function seedSkillWithFiles(
    f: Fixture,
    opts: { name: string; skillMd?: string; assets?: Array<{ name: string; content: string }> } = { name: 'skill' },
  ): Promise<{ skillId: string; dir: string }> {
    const skillId = newId();
    const ts = now();
    const skillMd = opts.skillMd ?? `# ${opts.name}\n\nbody`;
    const assets = opts.assets ?? [];

    const dir = path.join(STORAGE_ROOT, f.teamId, skillId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), skillMd);
    for (const a of assets) {
      await fs.writeFile(path.join(dir, a.name), a.content);
    }

    let sizeBytes = Buffer.byteLength(skillMd);
    let fileCount = 1 + assets.length;
    await sql`insert into skill (id,team_id,name,source,source_url,storage_path,size_bytes,file_count,created_by,created_at)
                values (${skillId}, ${f.teamId}, ${opts.name}, 'files', null,
                        ${dir}, ${sizeBytes}, ${fileCount}, ${f.userId}, ${ts})`;

    return { skillId, dir };
  }

  // ── 正向 ──────────────────────────────────────────────────────

  test('删一个 skill：库行消失 + 磁盘目录消失 + agent 残留引用被清掉', async () => {
    const f = await seed('cs-happy');
    const agentId = await seedAgent(f);
    const a = await seedSkillWithFiles(f, { name: 'a', assets: [{ name: 'extra.txt', content: 'hi' }] });
    const b = await seedSkillWithFiles(f, { name: 'b' });

    // 把 a、b 都绑到 agent default_skill_ids
    await sql`update agent set default_skill_ids = ${sql.array([a.skillId, b.skillId])}::text[]
                where id = ${agentId}`;

    const before = await sql<{ default_skill_ids: string[] }[]>`
      select default_skill_ids from agent where id = ${agentId}
    `;
    assert.deepEqual(before[0]!.default_skill_ids.sort(), [a.skillId, b.skillId].sort());

    const out = await deleteSkills(
      drizzle(sql, { schema: dbPkg.schema }) as never,
      { teamId: f.teamId, skillIds: [a.skillId], actorId: f.userId },
    );

    assert.equal(out.succeeded, 1);
    assert.equal(out.failed, 0);
    assert.equal(out.results.length, 1);
    assert.deepEqual(out.results[0], { skillId: a.skillId, ok: true });

    // 1) DB 行没了
    const rows = await sql`select 1 from skill where id = ${a.skillId}`;
    assert.equal(rows.length, 0, '硬删除 —— skill 行必须消失');

    // 2) 磁盘清掉（**这是本单的核心**）
    await assert.rejects(fs.stat(a.dir), /ENOENT/, `磁盘目录必须被删：${a.dir}`);

    // 3) 另一个 skill 仍在
    const survivor = await sql<{ id: string }[]>`select id from skill where id = ${b.skillId}`;
    assert.equal(survivor.length, 1, '未删的 skill 必须保留');
    const bStat = await fs.stat(b.dir);
    assert.ok(bStat.isDirectory(), '未删 skill 的磁盘目录必须保留');

    // 4) agent.defaultSkillIds 里残留的 a 被清掉，b 保留
    const after = await sql<{ default_skill_ids: string[] }[]>`
      select default_skill_ids from agent where id = ${agentId}
    `;
    const ids = after[0]!.default_skill_ids;
    assert.ok(!ids.includes(a.skillId), '已删 skillId 必须从残留数组里移除');
    assert.ok(ids.includes(b.skillId), '未删的 skillId 必须保留');

    // 5) 审计 —— actorType='chief'，type='skill_deleted'，payload 含 skillId
    const audits = await sql<{ actor_type: string; actor_id: string; type: string; payload: Record<string, unknown> }[]>`
      select actor_type, actor_id, type, payload from audit_event
        where team_id = ${f.teamId} and type = 'skill_deleted'
    `;
    assert.equal(audits.length, 1, '应恰好一条 skill_deleted 审计行');
    assert.equal(audits[0]!.actor_type, 'chief');
    assert.equal(audits[0]!.actor_id, f.userId);
    assert.equal((audits[0]!.payload as { skillId: string }).skillId, a.skillId);
  });

  test('批量：成功项真删 + 失败项不影响其它项', async () => {
    const f = await seed('cs-batch');
    const real = await seedSkillWithFiles(f, { name: 'real' });
    const ghostId = newId(); // 从未存在

    const out = await deleteSkills(
      drizzle(sql, { schema: dbPkg.schema }) as never,
      { teamId: f.teamId, skillIds: [ghostId, real.skillId], actorId: f.userId },
    );

    assert.equal(out.results.length, 2);
    assert.equal(out.succeeded, 1);
    assert.equal(out.failed, 1);

    const ghostResult = out.results.find((r) => r.skillId === ghostId)!;
    const realResult = out.results.find((r) => r.skillId === real.skillId)!;
    assert.equal(ghostResult.ok, false);
    assert.match(ghostResult.reason ?? '', /is not accessible to this key's owner/);
    assert.equal(realResult.ok, true);

    // 真删了的那个：库 + 盘都没了
    const rows = await sql`select 1 from skill where id = ${real.skillId}`;
    assert.equal(rows.length, 0);
    await assert.rejects(fs.stat(real.dir), /ENOENT/);

    // ghost 那条不该留任何 audit（失败 → 没写审计） —— 避免污染运维查询
    const audits = await sql`select 1 from audit_event where team_id = ${f.teamId}`;
    assert.equal(audits.length, 1, '失败项不写审计');
  });

  test('跨 team：403，库与磁盘都没变', async () => {
    const owner = await seed('cs-own');
    const attacker = await seed('cs-atk');
    const target = await seedSkillWithFiles(owner, { name: 'private' });

    const out = await deleteSkills(
      drizzle(sql, { schema: dbPkg.schema }) as never,
      { teamId: attacker.teamId, skillIds: [target.skillId], actorId: attacker.userId },
    );

    assert.equal(out.succeeded, 0);
    assert.equal(out.failed, 1);
    assert.equal(out.results[0]!.ok, false);
    assert.match(out.results[0]!.reason ?? '', /is not accessible to this key's owner/);

    // DB 必须原样
    const rows = await sql<{ id: string }[]>`select id from skill where id = ${target.skillId}`;
    assert.equal(rows.length, 1, '跨团队失败时库必须原样');

    // 磁盘必须原样 —— 这是「不让边界静默」的核心
    const stat = await fs.stat(target.dir);
    assert.ok(stat.isDirectory(), '跨团队失败时磁盘目录必须原样');
    const md = await fs.readFile(path.join(target.dir, 'SKILL.md'), 'utf8');
    assert.match(md, /private/);

    // 攻击者团队没有任何 skill —— 不能让跨团队探测出现副作用
    const atkSkills = await sql<{ n: number }[]>`select count(*)::int as n from skill where team_id = ${attacker.teamId}`;
    assert.equal(Number(atkSkills[0]!.n), 0);

    // 不能写审计
    const atkAudits = await sql<{ n: number }[]>`select count(*)::int as n from audit_event where team_id = ${attacker.teamId}`;
    assert.equal(Number(atkAudits[0]!.n), 0, '跨团队失败时不写审计');
  });

  test('磁盘已缺失：删除仍 ok:true（幂等，不让重试卡住）', async () => {
    const f = await seed('cs-idem');
    const { skillId, dir } = await seedSkillWithFiles(f, { name: 'half-gone' });

    // 提前把磁盘目录删掉，模拟「中途异常后只剩 DB 行」
    await fs.rm(dir, { recursive: true, force: true });
    await assert.rejects(fs.stat(dir), /ENOENT/);

    const out = await deleteSkills(
      drizzle(sql, { schema: dbPkg.schema }) as never,
      { teamId: f.teamId, skillIds: [skillId], actorId: f.userId },
    );

    // 幂等：fs.rm({force:true}) 对 ENOENT 静默成功 → 应判 ok:true
    assert.equal(out.succeeded, 1);
    assert.equal(out.failed, 0);
    assert.equal(out.results[0]!.ok, true);

    // 库行也得消失（这是「重试」的预期终点）
    const rows = await sql`select 1 from skill where id = ${skillId}`;
    assert.equal(rows.length, 0);
  });

  test('空数组是合法 no-op', async () => {
    const f = await seed('cs-empty');
    const out = await deleteSkills(
      drizzle(sql, { schema: dbPkg.schema }) as never,
      { teamId: f.teamId, skillIds: [], actorId: f.userId },
    );
    assert.deepEqual(out, { results: [], succeeded: 0, failed: 0 });
  });

  test('重复 id 在同一批里只算一次', async () => {
    const f = await seed('cs-dup');
    const { skillId, dir } = await seedSkillWithFiles(f, { name: 'dup' });

    const out = await deleteSkills(
      drizzle(sql, { schema: dbPkg.schema }) as never,
      { teamId: f.teamId, skillIds: [skillId, skillId, skillId], actorId: f.userId },
    );

    // 服务层去重：同一 id 在一批里只跑一次，避免「成功 → 失败 → 失败」
    // 的混乱结果。重复 id 是 caller 的脏数据，不是服务层要表达的语义。
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0]!.ok, true);
    assert.equal(out.results[0]!.skillId, skillId);
    assert.equal(out.succeeded, 1);
    assert.equal(out.failed, 0);

    await assert.rejects(fs.stat(dir), /ENOENT/, '磁盘只清一次');
  });

  test('路径穿越：含 .. 的 id 不会删 STORAGE_ROOT 外的东西', async () => {
    // 双层探针：service 的 resolveSkillDir 必须守住不让 fs.rm 飞出 STORAGE_ROOT。
    //
    // 真实路径穿越向量 = teamId 含 `path.sep`（如 `../escape`）。完整 service 有
    // 两层防御：(1) `path.basename(teamId) !== teamId` 直接拒；
    // (2) `path.resolve()` 后 `!full.startsWith(root + sep)` 拒。
    //
    // 我们用 `<STORAGE_ROOT>/../<evilSkillId>` 当 sentinel —— 把 fs.rm 飞出去
    // 的目标文件名起成 evilSkillId 的 basename，让「sentinel 是否还在」既能探
    // 测 service 是否真的把 raw input 喂给了 fs.rm、又能 catch 即便 service「默
    // 认删除成功」（无异常）但其实写了上级目录的情况。
    //
    // 用动态 run 后缀避免和前次崩溃的 raw 行撞 PK；fs.rm 万一飞出去也只删
    // 自己的 sentinel，不污染别的 case。
    const run = `${process.pid}-${Date.now()}`;
    const sentinelBasename = `tds-cs-trav-${run}.txt`;
    const parentSentinel = path.join(STORAGE_ROOT, '..', sentinelBasename);
    const grandparentSentinel = path.join(STORAGE_ROOT, '..', '..', `tds-cs-trav-grand-${run}.txt`);
    // 哨兵要写在 STORAGE_ROOT 的**上级**，而 STORAGE_ROOT 在 os.tmpdir() 里。
    // 当 TMPDIR 被指到文件系统根（如某些 CI 的 `TMPDIR=/`）时，上两级就是 `/`，
    // 非 root 用户写不进去 —— 那是环境限制，不是被测行为。这里写不进去就
    // 记下来、下面按对应哨兵跳过对应 stat 断言，**不能**让环境把这条契约测红。
    let parentSentinelOk = true;
    let grandparentSentinelOk = true;
    try {
      await fs.writeFile(parentSentinel, 'parent-must-stay');
      await fs.writeFile(grandparentSentinel, 'grand-must-stay');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EACCES' && code !== 'EPERM' && code !== 'EROFS') throw err;
      const which = (err as NodeJS.ErrnoException).path === parentSentinel ? 'parent' : 'grandparent';
      if (which === 'parent') parentSentinelOk = false;
      else grandparentSentinelOk = false;
      console.warn(
        `[skipped-assert] ${which} sentinel unwritable (${code} at ${(err as NodeJS.ErrnoException).path}); ` +
          '该条路径防御断言本轮不执行',
      );
    }

    // evilTeamId 含 `/`（path.sep）：full service 下 path.basename 会剥成
    // `escape-${run}`，与原 string 不等 → 抛 422。
    // 若 `path.basename` 被去掉：path.resolve(root, '../escape-...', sentinelBasename)
    //   = <STORAGE_ROOT_PARENT>/<sentinelBasename> → 与 parentSentinel 同路径，
    //   service 沉默成功，sentinel 被删。
    const evilTeamId = `escape-${run}`;
    const evilSkillId = sentinelBasename;
    // 把 teamId 设为 '../' + evilTeamId 这种形式时，path.basename 会剥成 evilTeamId，
    // 但原串以 `../` 开头，所以 `basename !== raw` → 走 422 分支。
    // 我们用 raw SQL 直接写 team_id 列，让 DB 行存在但其值就是 `../${evilTeamId}`。
    const evilDbTeamId = `../${evilTeamId}`;

    let f: Fixture | null = null;
    try {
      f = await seed('cs-trav');

      // ── 第一层：DB-layer 拒绝 ──
      // 用一个 traversal-shaped skillId 直接调 —— DB 必然查不到，
      // assertSkillInTeam 直接 403。这条线保证 service 不会把 caller 提供的
      // raw skillId 喂给 fs.rm。
      const dbMiss = await deleteSkills(
        drizzle(sql, { schema: dbPkg.schema }) as never,
        {
          teamId: f.teamId,
          skillIds: ['../../' + sentinelBasename],
          actorId: f.userId,
        },
      );
      assert.equal(dbMiss.succeeded, 0, 'DB 必查不到 → succeeded 必须 0');
      assert.equal(dbMiss.failed, 1);
      assert.equal(dbMiss.results[0]!.ok, false);
      assert.match(dbMiss.results[0]!.reason ?? '', /is not accessible to this key's owner/);
      const rowCount = await sql<{ n: number }[]>`select count(*)::int as n from skill where team_id = ${f.teamId}`;
      assert.equal(Number(rowCount[0]!.n), 0, 'traversal 输入不应在 DB 留下痕迹');
      if (parentSentinelOk) {
        const parentStat = await fs.stat(parentSentinel);
        assert.ok(parentStat.isFile(), 'DB 拒绝后 STORAGE_ROOT 上级哨兵必须原样');
      }
      if (grandparentSentinelOk) {
        const grandStat = await fs.stat(grandparentSentinel);
        assert.ok(grandStat.isFile(), 'DB 拒绝后 STORAGE_ROOT 上两级哨兵必须原样');
      }

      // ── 第二层：FS-layer 拒绝 ──
      // 模拟最坏情况：DB 行已存在但 team_id 列是穿越向量（攻击者能灌 DB
      // 行的罕见情况）。assertSkillInTeam 因此能匹配，但 resolveSkillDir 必须
      // 继续挡。
      const ts = now();
      await sql`insert into team (id,name,plan,storage_quota,created_at)
                  values (${evilDbTeamId}, 'evil-team', 'free', 1073741824, ${ts})`;
      await sql`insert into member (id,team_id,actor_id,member_type,role,joined_at,v)
                  values (${newId()}, ${evilDbTeamId}, ${f.userId}, 'user', 'admin', ${ts}, 0)`;
      await sql`insert into skill (id,team_id,name,source,source_url,storage_path,size_bytes,file_count,created_by,created_at)
                  values (${evilSkillId}, ${evilDbTeamId}, 'trav-evil', 'files', null,
                          ${path.join(STORAGE_ROOT, evilSkillId)}, ${100}, ${0}, ${f.userId}, ${ts})`;

      const fsHit = await deleteSkills(
        drizzle(sql, { schema: dbPkg.schema }) as never,
        {
          teamId: evilDbTeamId, // 直接传 raw `../escape-...`
          skillIds: [evilSkillId],
          actorId: f.userId,
        },
      );
      // 完整 service 下 path.basename('../escape-...') = 'escape-...' ≠ raw → 422。
      // 若任一防御层被拿掉：
      //   (a) 只去掉 basename：path.resolve(root, '../escape-...', sentinel) = parent/sentinel
      //       → escape check 仍然接住（full 不以 root+sep 开头）→ 也是 422
      //   (b) 两层都去掉：success:1，且 sentinel 被 fs.rm 删掉
      // 这条断言里 succeeded 必须 0 —— 任何 0/1/4 之外的状态都属于「service 已被
      // 攻穿」。
      assert.equal(fsHit.succeeded, 0, 'raw ../escape-... 必须被 resolveSkillDir 挡掉');
      assert.equal(fsHit.failed, 1);
      assert.equal(fsHit.results[0]!.ok, false);
      assert.match(fsHit.results[0]!.reason ?? '', /illegal characters|escapes storage root/);

      // 哨兵不能丢（哨兵压根没写成功的，见上面 skipped-assert 注释）
      if (parentSentinelOk) {
        const stillParent = await fs.stat(parentSentinel);
        assert.ok(stillParent.isFile(), 'FS-layer 拒绝后 STORAGE_ROOT 上级哨兵必须原样');
      }
      if (grandparentSentinelOk) {
        const stillGrand = await fs.stat(grandparentSentinel);
        assert.ok(stillGrand.isFile(), 'FS-layer 拒绝后 STORAGE_ROOT 上两级哨兵必须原样');
      }
    } finally {
      try {
        await sql`delete from skill where team_id = ${evilDbTeamId}`;
        await sql`delete from member where team_id = ${evilDbTeamId}`;
        await sql`delete from team where id = ${evilDbTeamId}`;
      } catch {
        // ignore
      }
      await fs.rm(parentSentinel, { force: true });
      await fs.rm(grandparentSentinel, { force: true });
    }
  });
});