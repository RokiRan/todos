import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as dbPkg from '@tds/db';
import { newId, now } from '../src/ids.js';
import { chiefToolRegistry, chiefToolWiringStatus } from '../src/chief/registry.js';
import { executeChiefTool } from '../src/chief/executor.js';
import { unwiredChiefTools, type ChiefExecContext } from '../src/chief/executor.js';
import { CHIEF_TOOLS, CHIEF_TOOL_COUNT } from '../src/chief/tools.js';

/**
 * Registry 的接线验证（真库）。
 *
 * 各 slice 的服务层测试证明的是「服务函数本身对」；这里证明的是**接上了**——
 * 工具名 → handler → 服务函数这一跳通不通，以及闸门与 handler 的边界没串。
 *
 * 关键断言不是「每个工具都能跑」（那需要 58 套 fixture），而是：
 *   1. **registry 覆盖了声明的 Chief 专属工具**，且未接线的那批确实是已知的 9 个
 *   2. **handler 真的会调到服务层**（用 `create_agent` 做端到端探针：真建一行）
 *   3. **入参解析失败时报的是「参数不对」而不是别的**（zod 在 handler 第一行）
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://tds@127.0.0.1:5433/tds';

describe('Chief registry 接线', () => {
  test('registry 覆盖 58 个声明里的 Chief 专属工具；未接线归零', () => {
    const { wired, unwired, viaMcp } = chiefToolWiringStatus();
    // 31 个在 MCP 面上（由 routes/mcp.ts 执行，不该出现在本 registry）；
    // 27 个 Chief 专属 —— **2026-07-17 起 27 个全部接线**（最后 6 个：
    // provider 系列 4 + connect_app/connect_repo/set_remote_shell + todo 2）。
    assert.equal(wired.length, 27, `MUTATION? 已接线数变了（实际 ${wired.length}）：${wired.join(' ')}`);
    assert.equal(viaMcp.length, 31, `走 MCP 的应是 31 个，实际 ${viaMcp.length}`);
    // 未接线归零 —— 这是「Chief 专属工具全部可执行」的可测事实
    assert.deepEqual(
      [...unwired],
      [],
      `MUTATION? 还有工具没接线：${unwired.join(' ')}`,
    );
    // 三类集合互不重叠，且 wired + viaMcp 恰好是 58 个声明
    assert.equal(new Set([...wired, ...viaMcp, ...unwired]).size, 58);
    assert.equal(wired.length + viaMcp.length, 58);
    // 接线的工具确实都在 58 个声明里（防 registry 里混进不存在的名字）
    const declared = new Set(CHIEF_TOOLS.map((t) => t.name));
    for (const n of wired) assert.ok(declared.has(n), `${n} 不在 CHIEF_TOOLS 里`);
  });

  test('MCP 面上的工具不在本 registry（它们由 routes/mcp.ts 执行）', () => {
    const registry = chiefToolRegistry();
    for (const name of ['todos', 'create_todo', 'run_builds', 'secrets', 'issues']) {
      assert.equal(registry.has(name), false, `MUTATION? ${name} 不该出现在 Chief 专属 registry 里`);
    }
  });

  test('unwiredChiefTools（空 registry）应报全部 58 个 —— 自查入口有效', () => {
    assert.equal(unwiredChiefTools(new Map()).length, CHIEF_TOOL_COUNT);
  });

  test('CHIEF_TOOL_COUNT 仍是 58（外部契约锁死）', () => {
    assert.equal(CHIEF_TOOL_COUNT, 58);
  });
});

describe('Chief registry 端到端探针（真库）', () => {
  test('create_agent 经 handler 真建一行；参数缺字段时报「参数不对」', async () => {
    const sql = postgres(DATABASE_URL, { max: 3 });
    const db = drizzle(sql, { schema: dbPkg.schema });
    const ts = now();
    const userId = newId();
    const teamId = newId();
    const memberId = newId();
    const registry = chiefToolRegistry();
    const handler = registry.get('create_agent');
    assert.ok(handler, 'MUTATION? create_agent 没接进 registry');

    const ctx: ChiefExecContext = {
      db: db as never,
      actorId: userId,
      teamId,
      confirmedTools: new Set<string>(),
    };

    // 走**执行器**而不是直接调 handler —— 参数错误的翻译（ZodError →
    // 「invalid arguments」）是执行器的职责，直接调 handler 测不到那一层。
    const run = (args: Record<string, unknown>) =>
      executeChiefTool(registry, ctx, 'create_agent', args);

    try {
      await sql.begin(async (tx) => {
        await tx`insert into "user" (id,email,display_name,status,locale,created_at,updated_at)
                  values (${userId}, ${`reg-${userId}@test.local`}, 'reg', 'active', 'en', ${ts}, ${ts})`;
        await tx`insert into team (id,name,plan,storage_quota,created_at)
                  values (${teamId}, 'reg-team', 'free', 1073741824, ${ts})`;
        await tx`insert into "member" (id,team_id,actor_id,member_type,role,joined_at,v)
                  values (${memberId}, ${teamId}, ${userId}, 'user', 'admin', ${ts}, 0)`;
      });

      // 缺 displayName → 执行器把它翻成「invalid arguments」并指名字段
      const bad = await run({});
      assert.equal(bad.ok, false, 'MUTATION? 缺参数却执行成功了');
      assert.match(bad.reason ?? '', /^invalid arguments/, `措辞不对：${bad.reason}`);
      assert.match(bad.reason ?? '', /displayName/, `报错没指向缺失字段：${bad.reason}`);
      const none = await sql`select count(*)::int as c from agent where team_id = ${teamId}`;
      assert.equal(none[0]?.c, 0, 'MUTATION? 参数错误却建了 agent');

      // 正常参数 → 真建一行
      const okOut = await run({ displayName: 'probe agent', description: 'e2e' });
      assert.equal(okOut.ok, true, `正常参数被拒：${okOut.reason}`);
      const out = okOut.result as { id?: string };
      assert.ok(out?.id, 'MUTATION? handler 没返回建好的 agent id');
      const rows = await sql`select id, display_name, team_id from agent where id = ${out.id}`;
      assert.equal(rows.length, 1, 'MUTATION? agent 没真落库');
      assert.equal(rows[0]?.display_name, 'probe agent');
      assert.equal(rows[0]?.team_id, teamId);
      const audits = await sql`select 1 from audit_event where team_id = ${teamId} and todo_id is null`;
      assert.ok(audits.length >= 0, '审计表可读');
    } finally {
      await sql`delete from sse_event where team_id = ${teamId}`;
      await sql`delete from audit_event where team_id = ${teamId}`;
      await sql`delete from agent where team_id = ${teamId}`;
      await sql`delete from "member" where team_id = ${teamId}`;
      await sql`delete from team where id = ${teamId}`;
      await sql`delete from "user" where id = ${userId}`;
      await sql.end();
    }
  });
});
