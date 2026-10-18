import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Db } from '@tds/db';
import * as dbPkg from '@tds/db';
import { newId, now } from '../src/ids.js';
import {
  executeChiefTool,
  irreversibleChiefTools,
  adminGatedChiefTools,
  unwiredChiefTools,
  type ChiefExecContext,
  type ChiefToolRegistry,
} from '../src/chief/executor.js';
import { CHIEF_TOOLS, CHIEF_TOOL_COUNT } from '../src/chief/tools.js';

/**
 * Chief 执行器的闸门验证（真库）。
 *
 * 执行器只做**调度与闸门**，业务规则在各 `services/*` 里。所以这里测的是
 * 「闸门有没有拦住」以及「拦对了没有」—— 具体哪个 handler 被调到、由它落什么库，
 * 那是各 slice 的测试负责。
 *
 * 三条闸门各自的判据：
 *   ① 工具不存在 → 措辞说「不存在」（不是「还没实现」，否则 Chief 会反复重试）
 *   ② 不可逆未确认 → 拒绝，且**不进 handler**（handler 被打到就是闸门失效）
 *   ③ 需要 admin 而 actor 不是 admin → 拒绝，同样不进 handler
 *
 * 以及一条元测试：`unwiredChiefTools` 自查 —— 声明了 58 个，接线的会被列出来，
 * 这条让「接线进度」变成可测量的而不是靠人记。
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://tds@127.0.0.1:5433/tds';

let sql: postgres.Sql;
// 与各服务层同一个别名：执行器签名用的就是 Db
let db: Db;
let fx: {
  userId: string; teamId: string; memberId: string; agentId: string; projectId: string;
  adminUserId: string; adminMemberId: string; otherTeamId: string;
};

describe('Chief 执行器的三条闸门', () => {
  before(async () => {
    sql = postgres(DATABASE_URL, { max: 5 });
    db = drizzle(sql, { schema: dbPkg.schema });
    const ts = now();
    const userId = newId();
    const teamId = newId();
    const memberId = newId();
    const agentId = newId();
    const projectId = newId();
    const adminUserId = newId();
    const adminMemberId = newId();
    const otherTeamId = newId();

    await sql.begin(async (tx) => {
      for (const [uid, label] of [
        [userId, 'exec-member'],
        [adminUserId, 'exec-admin'],
      ] as const) {
        await tx`insert into "user" (id,email,display_name,status,locale,created_at,updated_at)
                  values (${uid}, ${`${label}-${uid}@test.local`}, ${label}, 'active', 'en', ${ts}, ${ts})`;
      }
      for (const tid of [teamId, otherTeamId]) {
        await tx`insert into team (id,name,plan,storage_quota,created_at)
                  values (${tid}, ${'exec-' + tid}, 'free', 1073741824, ${ts})`;
      }
      // 普通 member（role='member'）与 admin 各一条
      await tx`insert into "member" (id,team_id,actor_id,member_type,role,joined_at,v)
                values (${memberId}, ${teamId}, ${userId}, 'user', 'member', ${ts}, 0)`;
      await tx`insert into "member" (id,team_id,actor_id,member_type,role,joined_at,v)
                values (${adminMemberId}, ${teamId}, ${adminUserId}, 'user', 'admin', ${ts}, 0)`;
      await tx`insert into agent (id,team_id,display_name,default_skill_ids,grants,active_task_count,created_at,updated_at)
                values (${agentId}, ${teamId}, 'exec agent', '{}', '{}'::jsonb, 0, ${ts}, ${ts})`;
      await tx`insert into project (id,team_id,name,provider,repo_kind,default_branch,next_seq_num,created_at)
                values (${projectId}, ${teamId}, 'exec-p', 'external', 'other', 'main', 1, ${ts})`;
    });

    fx = { userId, teamId, memberId, agentId, projectId, adminUserId, adminMemberId, otherTeamId };
  });

  after(async () => {
    await sql`delete from sse_event where team_id in (${fx.teamId}, ${fx.otherTeamId})`;
    await sql`delete from audit_event where team_id in (${fx.teamId}, ${fx.otherTeamId})`;
    await sql`delete from project where team_id in (${fx.teamId}, ${fx.otherTeamId})`;
    await sql`delete from agent where team_id in (${fx.teamId}, ${fx.otherTeamId})`;
    await sql`delete from "member" where team_id in (${fx.teamId}, ${fx.otherTeamId})`;
    await sql`delete from team where id in (${fx.teamId}, ${fx.otherTeamId})`;
    await sql`delete from "user" where id in (${fx.userId}, ${fx.adminUserId})`;
    await sql.end();
  });

  /** 建一个「handler 被调到就抛」的 registry —— 用来证明闸门拦住时 handler 压根没跑。 */
  function registryWith(tools: readonly string[]): {
    registry: ChiefToolRegistry;
    calls: string[];
  } {
    const calls: string[] = [];
    const map: ChiefToolRegistry = new Map();
    for (const name of tools) {
      map.set(name, (ctx) => {
        calls.push(`${name}:${ctx.actorId}`);
        return Promise.resolve({ executed: true, by: ctx.actorId });
      });
    }
    return { registry: map, calls };
  }

  // ── ① 工具不存在 ────────────────────────────────────────────────────
  test('未知工具名：拒绝且措辞说「不存在」（不是「还没实现」）', async () => {
    const { registry, calls } = registryWith([]);
    const out = await executeChiefTool(registry, {
      db: db as never, actorId: fx.adminUserId, teamId: fx.teamId,
    }, 'definitely_not_a_chief_tool', {});

    assert.equal(out.ok, false);
    assert.match(out.reason ?? '', /does not exist/);
    assert.ok(!(out.reason ?? '').includes('not implemented'), `措辞不该说「还没实现」：${out.reason}`);
    assert.deepEqual(calls, [], 'MUTATION? 未知工具竟然进了 handler');
  });

  // ── ② 不可逆未确认 ──────────────────────────────────────────────────
  test('不可逆工具未确认：拒绝且不进 handler', async () => {
    // `delete_skills` 在 spec 里是 irreversible + needsAdminGrant（两个标记都有）
    // 注意 `delete_agents` 只有 irreversible、没有 needsAdminGrant —— 用它测 admin 闸门
    // 会因为闸门根本不触发而假绿。
    const { registry, calls } = registryWith(['delete_skills']);
    const out = await executeChiefTool(registry, {
      db: db as never, actorId: fx.adminUserId, teamId: fx.teamId,
    }, 'delete_skills', { skillIds: ['skill-1'] });

    assert.equal(out.ok, false, 'MUTATION? 不可逆工具未确认却放行了');
    assert.match(out.reason ?? '', /irreversible/);
    assert.match(out.reason ?? '', /confirm/);
    assert.deepEqual(calls, [], 'MUTATION? 闸门拒绝了却仍进了 handler');
    // 库里必须什么都没变
    const agents = await sql`select count(*)::int as c from agent where id = ${fx.agentId}`;
    assert.equal(agents[0]?.c, 1, 'MUTATION? 闸门拒绝却把 agent 删了');
  });

  test('不可逆工具已确认：才进 handler', async () => {
    const { registry, calls } = registryWith(['delete_skills']);
    const out = await executeChiefTool(registry, {
      db: db as never, actorId: fx.adminUserId, teamId: fx.teamId,
      confirmedTools: new Set(['delete_skills']),
    }, 'delete_skills', { skillIds: ['skill-1'] });

    assert.equal(out.ok, true, `已确认仍被拒：${out.reason}`);
    assert.deepEqual(calls, [`delete_skills:${fx.adminUserId}`]);
  });

  // ── ③ admin 闸门 ────────────────────────────────────────────────────
  test('需要 admin 的工具，member 角色被挡且不进 handler', async () => {
    const { registry, calls } = registryWith(['delete_skills']);
    const out = await executeChiefTool(registry, {
      db: db as never, actorId: fx.userId, teamId: fx.teamId, // role='member'
      confirmedTools: new Set(['delete_skills']),              // 已确认，单独测 admin 这一条
    }, 'delete_skills', { skillIds: ['skill-1'] });

    assert.equal(out.ok, false, 'MUTATION? member 角色通过了 admin 闸门');
    assert.match(out.reason ?? '', /requires team admin/);
    assert.deepEqual(calls, [], 'MUTATION? admin 闸门拒绝了却仍进了 handler');
  });

  test('需要 admin 的工具，admin 角色放行', async () => {
    const { registry, calls } = registryWith(['delete_skills']);
    const out = await executeChiefTool(registry, {
      db: db as never, actorId: fx.adminUserId, teamId: fx.teamId,
      confirmedTools: new Set(['delete_skills']),
    }, 'delete_skills', { skillIds: ['skill-1'] });

    assert.equal(out.ok, true, `admin 仍被拒：${out.reason}`);
    assert.deepEqual(calls, [`delete_skills:${fx.adminUserId}`]);
  });

  test('非该团队成员：按「不是 admin」处理（措辞说 not a member）', async () => {
    const { registry, calls } = registryWith(['delete_skills']);
    // fx.userId 是 teamId 的 member；用 otherTeamId 去查它 → 不是那个队的成员
    const out = await executeChiefTool(registry, {
      db: db as never, actorId: fx.userId, teamId: fx.otherTeamId,
      confirmedTools: new Set(['delete_skills']),
    }, 'delete_skills', { skillIds: ['skill-1'] });

    assert.equal(out.ok, false, 'MUTATION? 非成员通过了 admin 闸门');
    assert.match(out.reason ?? '', /not a member of team/);
    assert.deepEqual(calls, []);
  });

  // ── 闸门顺序 ────────────────────────────────────────────────────────
  test('闸门顺序：不可逆未确认时，admin 判定不该先暴露角色信息', async () => {
    // member + 不可逆未确认 → 应报「不可逆」，而不是先报「需要 admin」。
    // 顺序反了会把「这个 actor 是不是 admin」泄露给不该知道的人。
    const { registry } = registryWith(['delete_skills']);
    const out = await executeChiefTool(registry, {
      db: db as never, actorId: fx.userId, teamId: fx.teamId,
    }, 'delete_skills', { skillIds: ['skill-1'] });

    assert.match(out.reason ?? '', /irreversible/, `不该先报 admin 闸门：${out.reason}`);
    assert.ok(!(out.reason ?? '').includes('member'), `不该泄露角色：${out.reason}`);
  });

  // ── handler 抛错 ────────────────────────────────────────────────────
  test('handler 抛 HttpError：转成 ok:false + 状态码，不炸穿执行器', async () => {
    const { HttpError } = await import('../src/http.js');
    const map: ChiefToolRegistry = new Map();
    map.set('create_todo', () => Promise.reject(new HttpError(403, 'team "x" is not accessible to this key')));
    const out = await executeChiefTool(map as ChiefToolRegistry, {
      db: db as never, actorId: fx.adminUserId, teamId: fx.teamId,
    }, 'create_todo', {});

    assert.equal(out.ok, false);
    assert.match(out.reason ?? '', /^403: /, `应带状态码：${out.reason}`);
    assert.match(out.reason ?? '', /not accessible/);
  });

  // ── 元测试：声明与接线的差距要可测量 ────────────────────────────────
  test('CHIEF_TOOL_COUNT 仍是 58（外部契约锁死）', () => {
    assert.equal(CHIEF_TOOL_COUNT, 58, 'MUTATION? 工具声明数变了 —— 那是外部契约');
    assert.equal(CHIEF_TOOLS.length, 58);
  });

  test('unwiredChiefTools：空 registry 时应报全部 58 个', () => {
    const unwired = unwiredChiefTools(new Map());
    assert.equal(unwired.length, 58, 'MUTATION? 空 registry 时未接线数应等于声明数');
  });

  test('irreversible / adminGated 两个清单非空且都是真实声明的名字', () => {
    const names = new Set(CHIEF_TOOLS.map((t) => t.name));
    for (const n of irreversibleChiefTools()) {
      assert.ok(names.has(n), `${n} 不在 CHIEF_TOOLS 里`);
    }
    assert.ok(irreversibleChiefTools().includes('delete_agents'), 'delete_agents 应标 irreversible');
    assert.ok(irreversibleChiefTools().includes('delete_skills'), 'delete_skills 应标 irreversible');
    assert.ok(adminGatedChiefTools().length > 0, '应至少有一个 admin 闸门工具');
  });

  test('「声明了但没接实现」与「工具不存在」是两条不同的措辞', async () => {
    // `relay_question` 在 58 个里声明着，但本 registry 没接它。
    const { registry, calls } = registryWith([]);
    const declared = await executeChiefTool(registry, {
      db: db as never, actorId: fx.adminUserId, teamId: fx.teamId,
    }, 'relay_question', {});
    const unknown = await executeChiefTool(registry, {
      db: db as never, actorId: fx.adminUserId, teamId: fx.teamId,
    }, 'no_such_tool', {});

    assert.equal(declared.ok, false);
    assert.equal(unknown.ok, false);
    assert.match(declared.reason ?? '', /no executor wired/);
    assert.match(unknown.reason ?? '', /does not exist/);
    assert.notEqual(declared.reason, unknown.reason, 'MUTATION? 两条路径给了同一句措辞');
    assert.deepEqual(calls, []);
  });
});
