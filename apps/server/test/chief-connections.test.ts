/**
 * Chief `connect_app` / `connect_repo` / `set_remote_shell` 三工具服务层测试。
 *
 * 关键约束（来自 brief + 已被同库并行测试喂红三次的硬规则）：
 *   - 真库 postgres://tds@127.0.0.1:5433/tds
 *   - 每条拒绝用例必须查库证明"未写入"，且 **只用本 fixture 名下行**
 *     （where team_id = ${fx.teamId}）—— 不允许全表 count（库是共享的）
 *   - 断言消息统一带 MUTATION? 前缀；mutation 验证后源码不许留裸 MUTATION
 *   - fixture 里 agent.default_skill_ids 是 text[] not jsonb：'{}'::text[]
 *   - 不跑全量 typecheck/test；只跑这一文件
 *
 * 覆盖：
 *   - set_remote_shell：正向（开/关）、跨团队 403 未写、platform runner 拒绝 422
 *   - connect_repo：正向新建、跨项目复用幂等覆盖、跨团队 403 未写、缺 token 拒、
 *     repoUrl 非 http 拒、密文落库（不回显 enc_token / enc_nonce / token 本身）、
 *     username 空 → 'oauth2' 规范化
 *   - connect_app：只读 `listConnectedApps`，断言它在表里有数据时返回该行；
 *     不暴露写函数（详见 service 文件头部注释）
 */

import assert from 'node:assert/strict';
import { test, describe, before, after, beforeEach } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import type { Db } from '@tds/db';
import * as dbPkg from '@tds/db';
import { newId, now } from '../src/ids.js';
import { seal, open } from '../src/crypto.js';
import { HttpError } from '../src/http.js';
import * as svc from '../src/services/connection-registry.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://tds@127.0.0.1:5433/tds';

let sql: postgres.Sql;
let db: Db;
const fixtures: Fixture[] = [];

interface Fixture {
  userId: string;
  /** teamB 上的人类成员对应的 userId —— seed 里同时写入 user 表 */
  userBId: string;
  teamAId: string;
  teamBId: string;
  memberAId: string;
  /** teamA 上的自有机器（runner 留空 = 不填，模拟 own machine） */
  machineAId: string;
  /** teamA 上的 platform 机器 —— set_remote_shell 应拒 */
  platformMachineId: string;
  /** teamB 上的自有机器 —— 跨团队 403 用 */
  machineBId: string;
  /** teamA 上的项目 —— connect_repo 目标 */
  projectAId: string;
  /** teamB 上的项目 —— 跨团队 403 用 */
  projectBId: string;
}

async function seed(): Promise<Fixture> {
  const ts = now();
  const userId = newId();
  const userBId = newId();
  const teamAId = newId();
  const teamBId = newId();
  const memberAId = newId();
  const memberBId = newId();
  const machineAId = newId();
  const platformMachineId = newId();
  const machineBId = newId();
  const projectAId = newId();
  const projectBId = newId();

  await sql`insert into "user" (id,email,display_name,created_at,updated_at)
            values (${userId}, ${`chief-conn-${userId}@test.local`}, ${'me'},
                    ${ts}, ${ts}),
                   (${userBId}, ${`chief-conn-${userBId}@test.local`},
                    ${'other'}, ${ts}, ${ts})`;
  await sql`insert into team (id,name,plan,storage_quota,created_at)
            values (${teamAId}, ${'conn-A'}, 'free', 1073741824, ${ts}),
                   (${teamBId}, ${'conn-B'}, 'free', 1073741824, ${ts})`;
  await sql`insert into member (id,team_id,actor_id,member_type,role,joined_at,v)
            values (${memberAId}, ${teamAId}, ${userId}, 'user', 'admin',
                    ${ts}, 0),
                   (${memberBId}, ${teamBId}, ${userBId}, 'user', 'admin',
                    ${ts}, 0)`;
  await sql`insert into machine (id,team_id,name,device_id,enrolled_by,
                                  build_enabled,shell_enabled,
                                  max_concurrent_tasks,runtimes,
                                  disabled_runtimes,hardware,is_online,
                                  runner,created_at,updated_at)
            values (${machineAId}, ${teamAId}, ${'laptopA'},
                    ${'devA'}, ${userId},
                    true, false, 6,
                    ${'{}'}::text[], ${'{}'}::text[],
                    ${'{}'}::jsonb, true, NULL,
                    ${ts}, ${ts}),
                   (${platformMachineId}, ${teamAId}, ${'platformA'},
                    ${'platA'}, ${userId},
                    true, false, 6,
                    ${'{}'}::text[], ${'{}'}::text[],
                    ${'{}'}::jsonb, true, 'platform',
                    ${ts}, ${ts}),
                   (${machineBId}, ${teamBId}, ${'laptopB'},
                    ${'devB'}, ${userBId},
                    true, false, 6,
                    ${'{}'}::text[], ${'{}'}::text[],
                    ${'{}'}::jsonb, true, NULL,
                    ${ts}, ${ts})`;
  await sql`insert into project (id,team_id,name,provider,repo_kind,
                                  default_branch,next_seq_num,created_at)
            values (${projectAId}, ${teamAId}, ${'projA'}, 'external', 'other',
                    'main', 1, ${ts}),
                   (${projectBId}, ${teamBId}, ${'projB'}, 'external', 'other',
                    'main', 1, ${ts})`;

  const fx: Fixture = {
    userId, userBId, teamAId, teamBId, memberAId,
    machineAId, platformMachineId, machineBId,
    projectAId, projectBId,
  };
  fixtures.push(fx);
  return fx;
}

async function cleanup(): Promise<void> {
  for (const f of fixtures) {
    // 共享库：只删本 fixture 名下相关行（按 team_id 拉网），确保不踩其他测试。
    // 单条单 team（同 chief-memory.test.ts 的写法） —— IN 列表里一旦混入
    // undefined 会被 postgres-js 直接抛 UNDEFINED_VALUE，加 layer 防御。
    await sql`DELETE FROM audit_event WHERE team_id = ${f.teamAId}`;
    await sql`DELETE FROM audit_event WHERE team_id = ${f.teamBId}`;
    await sql`DELETE FROM repo_credential WHERE project_id = ${f.projectAId}`;
    await sql`DELETE FROM repo_credential WHERE project_id = ${f.projectBId}`;
    await sql`DELETE FROM connection WHERE team_id = ${f.teamAId}`;
    await sql`DELETE FROM connection WHERE team_id = ${f.teamBId}`;
    await sql`DELETE FROM machine WHERE team_id = ${f.teamAId}`;
    await sql`DELETE FROM machine WHERE team_id = ${f.teamBId}`;
    await sql`DELETE FROM project WHERE team_id = ${f.teamAId}`;
    await sql`DELETE FROM project WHERE team_id = ${f.teamBId}`;
    await sql`DELETE FROM member WHERE team_id = ${f.teamAId}`;
    await sql`DELETE FROM member WHERE team_id = ${f.teamBId}`;
    await sql`DELETE FROM team WHERE id = ${f.teamAId}`;
    await sql`DELETE FROM team WHERE id = ${f.teamBId}`;
    await sql`DELETE FROM "user" WHERE id = ${f.userId}`;
    await sql`DELETE FROM "user" WHERE id = ${f.userBId}`;
  }
  fixtures.length = 0;
}

describe('Chief connection-registry service', () => {
  before(async () => {
    sql = postgres(DATABASE_URL, { max: 1 });
    db = drizzle(sql, { schema: dbPkg.schema });
  });
  after(async () => {
    await cleanup();
    await sql.end();
  });
  beforeEach(async () => {
    await cleanup();
    fixtures.length = 0;
  });

  // ─────────────────── set_remote_shell ──────────────────────────
  describe('setRemoteShell', () => {
    test('开启：machine.shell_enabled 由 false → true，写入 updatedAt', async () => {
      const f = await seed();
      const before = await sql<
        Array<{ shell_enabled: boolean; updated_at: number }>
      >`SELECT shell_enabled, updated_at FROM machine WHERE id = ${f.machineAId}`;
      assert.equal(before[0]!.shell_enabled, false, 'fixture 默认 false');

      const result = await svc.setRemoteShell(db, {
        teamId: f.teamAId,
        actorId: f.userId,
        machineId: f.machineAId,
        enabled: true,
      });
      assert.equal(result.id, f.machineAId);
      assert.equal(result.shellEnabled, true);
      assert.equal(result.runner, null, 'own machine（非 platform）');

      // 库上取证：shell_enabled 真被翻了
      const rows = await sql<Array<{ shell_enabled: boolean }>>`
        SELECT shell_enabled FROM machine WHERE id = ${f.machineAId}
      `;
      assert.equal(rows[0]!.shell_enabled, true, 'MUTATION? 库上 shell_enabled 必须为 true');

      // 审计必落
      const auditRows = await sql<Array<{ type: string }>>`
        SELECT type FROM audit_event
         WHERE team_id = ${f.teamAId} AND type = 'remote_shell_toggled'
      `;
      assert.ok(auditRows.length >= 1, 'remote_shell_toggled 必落审计');
    });

    test('关闭 + 同步 tailnetAddr：字段一并落库', async () => {
      const f = await seed();
      // 先开了它
      await svc.setRemoteShell(db, {
        teamId: f.teamAId, actorId: f.userId, machineId: f.machineAId,
        enabled: true,
      });
      // 现在关 + 显式传 tailnetAddr
      const result = await svc.setRemoteShell(db, {
        teamId: f.teamAId, actorId: f.userId, machineId: f.machineAId,
        enabled: false,
        tailnetAddr: '100.64.0.5',
      });
      assert.equal(result.shellEnabled, false);
      assert.equal(result.tailnetAddr, '100.64.0.5');

      const rows = await sql<Array<{ shell_enabled: boolean; tailnet_addr: string | null }>>`
        SELECT shell_enabled, tailnet_addr FROM machine WHERE id = ${f.machineAId}
      `;
      assert.equal(rows[0]!.shell_enabled, false);
      assert.equal(rows[0]!.tailnet_addr, '100.64.0.5', 'MUTATION? tailnet_addr 必须落');
    });

    test('platform 机器拒绝 → 422 + machine 无副作用', async () => {
      const f = await seed();
      const before = await sql<Array<{ shell_enabled: boolean }>>`
        SELECT shell_enabled FROM machine WHERE id = ${f.platformMachineId}
      `;
      assert.equal(before[0]!.shell_enabled, false);

      await assert.rejects(
        () => svc.setRemoteShell(db, {
          teamId: f.teamAId, actorId: f.userId,
          machineId: f.platformMachineId, enabled: true,
        }),
        (e: unknown) => e instanceof HttpError
          && e.statusCode === 422
          && /platform/.test((e as Error).message),
        'MUTATION? platform runner 必须 422',
      );
      const after = await sql<Array<{ shell_enabled: boolean }>>`
        SELECT shell_enabled FROM machine WHERE id = ${f.platformMachineId}
      `;
      assert.equal(after[0]!.shell_enabled, false, 'MUTATION? platform 机器应保持 false');
    });

    test('跨团队（机器属于 teamB）→ 403 且 machine 未动', async () => {
      const f = await seed();
      const before = await sql<Array<{ shell_enabled: boolean }>>`
        SELECT shell_enabled FROM machine WHERE id = ${f.machineBId}
      `;
      assert.equal(before[0]!.shell_enabled, false);

      await assert.rejects(
        () => svc.setRemoteShell(db, {
          // teamId = 自己的 teamA，machine = 别的 teamB 的机器
          teamId: f.teamAId, actorId: f.userId,
          machineId: f.machineBId, enabled: true,
        }),
        (e: unknown) => e instanceof HttpError
          && e.statusCode === 403
          && /is not accessible/.test((e as Error).message),
        'MUTATION? 跨团队机器访问必须 403',
      );
      // 库上取证：对方机器 shell_enabled 仍为 false
      const after = await sql<Array<{ shell_enabled: boolean }>>`
        SELECT shell_enabled FROM machine WHERE id = ${f.machineBId}
      `;
      assert.equal(after[0]!.shell_enabled, false, 'MUTATION? 跨团队拒绝后 machineB 未被改');
      // 我自己 team 的 audit 也不该多（拒绝路径不落审计）
      const auditRows = await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM audit_event
         WHERE team_id = ${f.teamAId} AND type = 'remote_shell_toggled'
      `;
      assert.equal(auditRows[0]!.n, 0, '拒绝路径不该留 audit（前置闸门抛了不进 audit）');
    });
  });

  // ─────────────────── connect_repo ───────────────────────────────
  describe('connectRepo', () => {
    test('正向新建：repo_credential 落 1 行 + 密文 token + 落审计', async () => {
      const f = await seed();
      const result = await svc.connectRepo(db, {
        teamId: f.teamAId,
        actorId: f.userId,
        projectId: f.projectAId,
        repoUrl: 'https://gitlab.example.com/group/repo.git',
        repoFullName: 'group/repo',
        token: 'glpat-verylongtoken123456789012345',
        username: 'deploy-bot',
      });

      assert.ok(result.id.length > 0, 'id 生成了');
      assert.equal(result.projectId, f.projectAId);
      assert.equal(result.username, 'deploy-bot');
      assert.equal(result.revokedAt, null);

      // 库上取证：真有一行，token 是密文（≠ 明文）
      const rows = await sql<Array<{
        enc_token: string;
        enc_nonce: string;
        username: string | null;
      }>>`SELECT enc_token, enc_nonce, username FROM repo_credential
            WHERE project_id = ${f.projectAId}`;
      assert.equal(rows.length, 1, 'MUTATION? repo_credential 必须落 1 行');
      const cipher = rows[0]!.enc_token;
      const nonce = rows[0]!.enc_nonce;
      assert.notEqual(cipher, '', 'MUTATION? enc_token 非空');
      assert.ok(nonce.length > 0, 'enc_nonce 非空');
      assert.ok(!cipher.includes('glpat-verylongtoken'), '密文不能含明文片段');

      // 回包验证：summary 不应回带密文 / token / nonce
      const keys = Object.keys(result);
      assert.ok(!keys.includes('enc_token'), '回包不应有 enc_token');
      assert.ok(!keys.includes('encToken'), '回包不应有 encToken');
      assert.ok(!keys.includes('token'), '回包不应有 token');
      assert.ok(!keys.includes('nonce'), '回包不应有 nonce');

      // 但密文必须真能解出来
      const dot = cipher.lastIndexOf('.');
      const recovered = open({
        cipher: cipher.slice(0, dot),
        tag: cipher.slice(dot + 1),
        nonce,
      });
      assert.equal(recovered, 'glpat-verylongtoken123456789012345', '密文能解回原文');

      // audit 必落
      const auditRows = await sql<Array<{ payload: unknown }>>`
        SELECT payload FROM audit_event
         WHERE team_id = ${f.teamAId} AND type = 'repo_connected'
      `;
      assert.equal(auditRows.length, 1, 'MUTATION? repo_connected 必落');
      const payload = auditRows[0]!.payload as Record<string, unknown>;
      assert.equal(payload.replaced, false, '首次写入 payload.replaced=false');
      assert.equal(payload.repoUrl, 'https://gitlab.example.com/group/repo.git');
      assert.equal(payload.repoFullName, 'group/repo');
    });

    test('同 project 第二次连接 → 幂等覆盖（仍 1 行 + 密文变化）', async () => {
      const f = await seed();
      const first = await svc.connectRepo(db, {
        teamId: f.teamAId, actorId: f.userId, projectId: f.projectAId,
        repoUrl: 'https://gitlab.example.com/group/repo.git',
        token: 'first-token-1234567890123456789',
        username: 'first-user',
      });
      // 取首次的密文 + nonce
      const firstRow = await sql<Array<{ enc_token: string; enc_nonce: string }>>`
        SELECT enc_token, enc_nonce FROM repo_credential
         WHERE project_id = ${f.projectAId}
      `;
      const firstCipher = firstRow[0]!.enc_token;
      const firstNonce = firstRow[0]!.enc_nonce;

      // 第二次：不同 token，但同 project
      const second = await svc.connectRepo(db, {
        teamId: f.teamAId, actorId: f.userId, projectId: f.projectAId,
        repoUrl: 'https://gitlab.example.com/group/repo.git',
        token: 'second-token-abcdefghijklmnopq',
        username: 'second-user',
      });
      assert.equal(second.id, first.id, 'MUTATION? 幂等覆盖 → id 保持稳定');
      assert.equal(second.username, 'second-user', 'username 同步被覆写');

      const rowsAfter = await sql<Array<{
        enc_token: string; enc_nonce: string;
      }>>`SELECT enc_token, enc_nonce FROM repo_credential
            WHERE project_id = ${f.projectAId}`;
      assert.equal(rowsAfter.length, 1, 'MUTATION? 仍 1 行（覆盖非新增）');
      assert.notEqual(rowsAfter[0]!.enc_token, firstCipher, '密文被换新');
      assert.notEqual(rowsAfter[0]!.enc_nonce, firstNonce, 'nonce 被换新');

      // 解出新密文确认是 second-token
      const cipher = rowsAfter[0]!.enc_token;
      const nonce = rowsAfter[0]!.enc_nonce;
      const dot = cipher.lastIndexOf('.');
      const recovered = open({
        cipher: cipher.slice(0, dot),
        tag: cipher.slice(dot + 1),
        nonce,
      });
      assert.equal(recovered, 'second-token-abcdefghijklmnopq');

      // audit 必落 **两条**（首次 + 覆盖），payload.replaced 第二次才是 true
      const auditRows = await sql<Array<{ payload: unknown }>>`
        SELECT payload FROM audit_event
         WHERE team_id = ${f.teamAId} AND type = 'repo_connected'
         ORDER BY created_at ASC
      `;
      assert.equal(auditRows.length, 2, 'MUTATION? audit 落两条');
      const payloads = auditRows.map((r) => r.payload as Record<string, unknown>);
      assert.equal(payloads[0]!.replaced, false);
      assert.equal(payloads[1]!.replaced, true);
    });

    test('username 空 → 规范化成 oauth2', async () => {
      const f = await seed();
      await svc.connectRepo(db, {
        teamId: f.teamAId, actorId: f.userId, projectId: f.projectAId,
        repoUrl: 'https://gitlab.example.com/group/repo.git',
        token: 'tok12345678901234567890',
        username: '',
      });
      const rows = await sql<Array<{ username: string | null }>>`
        SELECT username FROM repo_credential WHERE project_id = ${f.projectAId}
      `;
      assert.equal(rows[0]!.username, 'oauth2', 'MUTATION? 空 username 必须规范化');
    });

    test('token 空 → 422，repo_credential 不落', async () => {
      const f = await seed();
      await assert.rejects(
        () => svc.connectRepo(db, {
          teamId: f.teamAId, actorId: f.userId, projectId: f.projectAId,
          repoUrl: 'https://gitlab.example.com/group/repo.git',
          token: '',
        }),
        (e: unknown) => e instanceof HttpError
          && e.statusCode === 422
          && /token must not be empty/.test((e as Error).message),
      );
      const rows = await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM repo_credential
         WHERE project_id = ${f.projectAId}
      `;
      assert.equal(rows[0]!.n, 0, 'MUTATION? 空 token 拒后 repo_credential 一行没写');
    });

    test('repoUrl 非 http → 422，repo_credential 不落', async () => {
      const f = await seed();
      await assert.rejects(
        () => svc.connectRepo(db, {
          teamId: f.teamAId, actorId: f.userId, projectId: f.projectAId,
          repoUrl: 'git@github.com:owner/repo.git',
          token: 'tok12345678901234567890',
        }),
        (e: unknown) => e instanceof HttpError
          && e.statusCode === 422
          && /external Git repos require http/.test((e as Error).message),
      );
      const rows = await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM repo_credential
         WHERE project_id = ${f.projectAId}
      `;
      assert.equal(rows[0]!.n, 0, 'MUTATION? ssh-style URL 拒后没写');
    });

    test('repoUrl 带 userinfo（https://user:pw@host/...） → 422', async () => {
      const f = await seed();
      await assert.rejects(
        () => svc.connectRepo(db, {
          teamId: f.teamAId, actorId: f.userId, projectId: f.projectAId,
          repoUrl: 'https://user:pw@gitlab.example.com/group/repo.git',
          token: 'tok12345678901234567890',
        }),
        (e: unknown) => e instanceof HttpError && e.statusCode === 422,
      );
      const rows = await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM repo_credential
         WHERE project_id = ${f.projectAId}
      `;
      assert.equal(rows[0]!.n, 0);
    });

    test('跨团队（projectBId）→ 403，repo_credential 不写', async () => {
      const f = await seed();
      await assert.rejects(
        () => svc.connectRepo(db, {
          // teamId = teamA，但 projectId 属于 teamB
          teamId: f.teamAId, actorId: f.userId,
          projectId: f.projectBId,
          repoUrl: 'https://gitlab.example.com/group/repo.git',
          token: 'tok12345678901234567890',
        }),
        (e: unknown) => e instanceof HttpError
          && e.statusCode === 403
          && /is not accessible/.test((e as Error).message),
        'MUTATION? 跨团队项目访问必须 403',
      );
      // projectB 上无凭据（也不该因该调用写过）
      const rows = await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM repo_credential
         WHERE project_id = ${f.projectBId}
      `;
      assert.equal(rows[0]!.n, 0, 'MUTATION? 跨团队拒绝后 repo_credential 没多行');
      // 也没落 audit
      const auditRows = await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM audit_event
         WHERE team_id = ${f.teamAId} AND type = 'repo_connected'
      `;
      assert.equal(auditRows[0]!.n, 0, '拒绝路径不该落 audit');
    });
  });

  // ─────────────────── connect_app（只读壳）────────────────────────
  describe('listConnectedApps（connect_app 的只读出口）', () => {
    test('连接表里有一行时返回；空 team 返回 []', async () => {
      const f = await seed();
      // 空 team → 空数组
      const empty = await svc.listConnectedApps(db, f.teamAId);
      assert.deepEqual(empty, [], '空白连接时 listConnectedApps 必须空');

      // 灌一条 custom 连接（手动 sql 模拟 connections.addConnection 落库）
      const ts = now();
      const connId = newId();
      const sealedConfig = seal(JSON.stringify({ Authorization: 'Bearer x' }));
      await sql`INSERT INTO connection (
                 id, team_id, kind, identifier, transport, label, endpoint,
                 enc_config, enc_nonce, expires_at, created_by, created_at, deleted_at
               ) VALUES (
                 ${connId}, ${f.teamAId}, 'custom', 'linear-shim',
                 'http', 'Linear (shim)', 'http://127.0.0.1:9911/mcp',
                 ${`${sealedConfig.cipher}.${sealedConfig.tag}`},
                 ${sealedConfig.nonce}, NULL, ${f.userId}, ${ts}, NULL
               )`;

      const list = await svc.listConnectedApps(db, f.teamAId);
      assert.equal(list.length, 1, 'listConnectedApps 应返回 1 条');
      const item = list[0]!;
      assert.equal(item.teamId, f.teamAId);
      assert.equal(item.identifier, 'linear-shim');
      assert.equal(item.transport, 'http');
      assert.equal(item.label, 'Linear (shim)');
      assert.equal(item.endpoint, 'http://127.0.0.1:9911/mcp');
      // 值/密文/键名不应进回包（service 不重复实现 configKeys 回显）
      const keys = Object.keys(item);
      assert.ok(!keys.includes('encConfig'), '回包不应有 encConfig');
      assert.ok(!keys.includes('enc_config'), '回包不应有 enc_config');
      assert.ok(!keys.includes('value'), '回包不应有 value');
      // configKeys 字段在回包里**就是** []（service 简化 —— 真正回显留给 connections.addConnection）
      assert.ok(keys.includes('configKeys'), 'configKeys 字段存在');
      assert.deepEqual(item.configKeys, [], 'configKeys 留作 [:] —— 真正回显留给 connections.addConnection');

      // 其他 team 不该看到这条
      const otherList = await svc.listConnectedApps(db, f.teamBId);
      assert.equal(otherList.length, 0, 'MUTATION? 别的 team 不该看到我团队连接');
    });

    test('soft-delete（deleted_at 非空）的连接被过滤掉', async () => {
      const f = await seed();
      // 直接灌一条「已删」
      const ts = now();
      const sealedConfig = seal(JSON.stringify({}));
      await sql`INSERT INTO connection (
                 id, team_id, kind, identifier, transport, label, endpoint,
                 enc_config, enc_nonce, expires_at, created_by, created_at, deleted_at
               ) VALUES (
                 ${newId()}, ${f.teamAId}, 'custom', 'gone-one',
                 'http', 'gone', NULL,
                 ${`${sealedConfig.cipher}.${sealedConfig.tag}`},
                 ${sealedConfig.nonce}, NULL, ${f.userId}, ${ts}, ${ts}
               )`;
      const list = await svc.listConnectedApps(db, f.teamAId);
      assert.equal(list.length, 0, 'MUTATION? soft-delete 行必须被 list 过滤');
    });

    test('导出面：service 入口不含 connectApp 写函数 —— 不让假绿可触发', () => {
      // 这是回归门：`listConnectedApps` 应该导出；而 `connectApp` /
      // `addAppConnection` / `removeAppConnection` 等任何写函数都不该有
      // —— recon/03-app-api.md / recon/docs/mcp-servers.md 都没有
      // 「写一条 connection 行」的明文入口，catalog OAuth 流程本复刻未实现。
      const exported = Object.keys(svc);
      assert.ok(exported.includes('listConnectedApps'), '读函数必须有');
      for (const banned of [
        'connectApp',
        'addAppConnection',
        'removeAppConnection',
        'addConnectedApp',
      ]) {
        assert.ok(
          !exported.includes(banned),
          `不应有未文档支撑的写函数 ${banned}`,
        );
      }
    });
  });
});
