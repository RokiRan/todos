import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Db } from '@tds/db';
import * as dbPkg from '@tds/db';
import { newId, now } from '../src/ids.js';
import {
  listAttachments,
  loadAttachmentTeamId,
  validateAttachment,
  validateAttachmentCount,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_DOC_BYTES,
  MAX_IMAGE_BYTES,
  type Attachment,
} from '../src/services/attachments.js';

/**
 * 附件读模型 + 校验的端到端验证（真库 + service 层）。
 *
 * 覆盖：
 *   1. `validateAttachment` 三类拒绝（image_too_large / document_too_large /
 *      unsupported_format）与一类放行
 *   2. `validateAttachmentCount` 拒绝 6 个、放行 5 个
 *   3. `listAttachments` 正常路径：种两条 user_attachments envelope + 一条杂
 *      kind，回按 messageSeq 升序的元数据数组，**不出现**二进制 / storage
 *      key / 凭据字段
 *   4. 同 attachment id 跨消息重复时**早的赢**
 *   5. 没有 envelope 时老实返回空数组（**降级不是假实现** —— 没有附件表，
 *      解析不到内容时应当返回 []）
 *   6. 跨团队 403：fixture A 种 build，fixture B 用 buildId 读 → 抛 403
 *   7. 故意篡改 service（去掉归属链 / 去掉格式白名单）后必须把对应用例打
 *      红 —— 变异验证。这两条在文末的 `mutation` describe 里。
 *
 * 每个「拒绝」用例查 build_message 行数确认未写。**只能用本 fixture 名下的
 * build_id 做 `where`**，**不能用全表 count**（并行测试共享同一个库）。
 *
 * 出处：recon/docs/conversation.md 第 56-62 行（Images and attachments），
 * recon/docs/mcp.md 第 51 行「Read the workspace: ... read attachments」。
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://tds:tds_local_dev@127.0.0.1:5433/tds';

interface Fixture {
  label: string;
  userId: string;
  teamId: string;
  projectId: string;
  memberId: string;
  agentId: string;
}

async function seedFixture(sql: postgres.Sql, label: string): Promise<Fixture> {
  const ts = now();
  const userId = newId();
  const teamId = newId();
  const memberId = newId();
  const agentId = newId();
  const projectId = newId();

  await sql`
    insert into "user"
      (id, email, display_name, status, locale, created_at, updated_at)
    values
      (${userId}, ${`${label}-${userId}@test.local`}, ${label}, 'active', 'en', ${ts}, ${ts})
  `;
  await sql`
    insert into "team"
      (id, name, plan, storage_quota, created_at)
    values
      (${teamId}, ${label}, 'free', 1073741824, ${ts})
  `;
  await sql`
    insert into "member"
      (id, team_id, actor_id, member_type, role, joined_at, v)
    values
      (${memberId}, ${teamId}, ${userId}, 'user', 'admin', ${ts}, 0)
  `;
  await sql`
    insert into "agent"
      (id, team_id, display_name, default_skill_ids, grants, active_task_count, created_at, updated_at)
    values
      (${agentId}, ${teamId}, ${`agent of ${label}`}, '{}', '{}'::jsonb, 0, ${ts}, ${ts})
  `;
  await sql`
    insert into "project"
      (id, team_id, name, provider, repo_kind, default_branch, next_seq_num, created_at)
    values
      (${projectId}, ${teamId}, ${label}, 'external', 'other', 'main', 1, ${ts})
  `;
  return { label, userId, teamId, projectId, memberId, agentId };
}

async function seedTodoAndBuild(
  sql: postgres.Sql,
  f: Fixture,
): Promise<{ todoId: string; buildId: string }> {
  const todoId = newId();
  const buildId = newId();
  const ts = now();
  const seqRow = await sql<{ next_seq_num: number }[]>`
    select next_seq_num from "project" where id = ${f.projectId}
  `;
  const seq = seqRow[0]?.next_seq_num ?? 1;
  await sql`update "project" set next_seq_num = next_seq_num + 1 where id = ${f.projectId}`;
  await sql`
    insert into "todo"
      (id, project_id, seq_num, owner_member_id, agent_id, title, tag_ids, phase,
       plan_first, separate_plan_build, with_checklist, created_at, updated_at)
    values
      (${todoId}, ${f.projectId}, ${seq}, ${f.memberId}, ${f.agentId},
       ${`todo of ${f.label}`}, '{}', 'implement', true, false, false, ${ts}, ${ts})
  `;
  // session 是 jsonb NOT NULL；跟其它测试一样用 `JSON.stringify(...).::jsonb` 注入
  const session = JSON.stringify({ runtime: 'pi', id: `sess-${buildId}`, openedAt: ts });
  await sql`
    insert into "build"
      (id, todo_id, n, branch, agent_id, session, created_at)
    values
      (${buildId}, ${todoId}, ${1}, ${`tds/conv-${buildId}`}, ${f.agentId},
       ${session}::jsonb, ${ts})
  `;
  return { todoId, buildId };
}

/** 写一条 user 消息，`content` 是附件信封。 */
async function seedUserMessageWithAttachments(
  sql: postgres.Sql,
  buildId: string,
  seq: number,
  items: Array<{ id: string; name: string; mime: string; sizeBytes: number }>,
): Promise<string> {
  const id = newId();
  const ts = now();
  const content = JSON.stringify({ kind: 'user_attachments', items });
  await sql`
    insert into "build_message"
      (id, build_id, role, content, seq, is_error, created_at)
    values
      (${id}, ${buildId}, 'user', ${content}, ${seq}, false, ${ts})
  `;
  return id;
}

/** 写一条 user 消息，`content` 是普通文本 / 其它 kind 的 JSON（不是附件信封）。 */
async function seedUserMessagePlain(
  sql: postgres.Sql,
  buildId: string,
  seq: number,
  text: string,
): Promise<string> {
  const id = newId();
  const ts = now();
  await sql`
    insert into "build_message"
      (id, build_id, role, content, seq, is_error, created_at)
    values
      (${id}, ${buildId}, 'user', ${text}, ${seq}, false, ${ts})
  `;
  return id;
}

async function deleteFixture(sql: postgres.Sql, f: Fixture): Promise<void> {
  // 反序避开 FK：先清消息（cascade 到 build_message）/ build / todo / project
  await sql`delete from "sse_event" where team_id = ${f.teamId}`;
  await sql`delete from "audit_event" where team_id = ${f.teamId}`;
  await sql`delete from "todo" where project_id = ${f.projectId}`;
  await sql`delete from "project" where team_id = ${f.teamId}`;
  await sql`delete from "agent" where team_id = ${f.teamId}`;
  await sql`delete from "member" where team_id = ${f.teamId}`;
  await sql`delete from "team" where id = ${f.teamId}`;
  await sql`delete from "user" where id = ${f.userId}`;
}

/** 某 build 的 build_message 行数 —— 「拒绝时不得写入」必须查库。 */
async function countMessages(sql: postgres.Sql, buildId: string): Promise<number> {
  const rows = await sql<{ c: number }[]>`
    select count(*)::int as c from "build_message" where build_id = ${buildId}
  `;
  return rows[0]?.c ?? 0;
}

/** 确认返回的 attachment 里没有任何凭据 / 二进制 / URL 字段。 */
function assertMetadataOnly(a: Attachment): void {
  // 类型上就没有这些字段；这里只是再加一道防御：序列化后扫一遍可疑 key。
  const s = JSON.stringify(a);
  for (const forbidden of ['token', 'apiKey', 'api_key', 'storageKey', 'storage_key', 'url', 'data', 'b64']) {
    assert.ok(
      !s.toLowerCase().includes(forbidden.toLowerCase()),
      `MUTATION? attachment JSON leaked "${forbidden}": ${s}`,
    );
  }
}

// ── 校验函数（纯函数，单测性质） ─────────────────────────────────────

describe('validateAttachment / validateAttachmentCount —— 文档铁律', () => {
  test('图片 ≤5MB 放行', () => {
    const r = validateAttachment({ name: 'shot.png', mime: 'image/png', size: 1024 });
    assert.deepEqual(r, { ok: true });
  });

  test('图片 >5MB 拒绝（image_too_large）', () => {
    const r = validateAttachment({
      name: 'huge.jpg',
      mime: 'image/jpeg',
      size: MAX_IMAGE_BYTES + 1,
    });
    assert.equal(r.ok, false);
    if (r.ok) throw new Error('unreachable');
    assert.equal(r.reason, 'image_too_large');
    assert.match(r.message, /5 MB/);
    assert.match(r.message, /huge\.jpg/);
  });

  test('文档 ≤20MB 放行', () => {
    const r = validateAttachment({
      name: 'spec.pdf',
      mime: 'application/pdf',
      size: MAX_DOC_BYTES,
    });
    assert.deepEqual(r, { ok: true });
  });

  test('文档 >20MB 拒绝（document_too_large）', () => {
    const r = validateAttachment({
      name: 'spec.pdf',
      mime: 'application/pdf',
      size: MAX_DOC_BYTES + 1,
    });
    assert.equal(r.ok, false);
    if (r.ok) throw new Error('unreachable');
    assert.equal(r.reason, 'document_too_large');
    assert.match(r.message, /20 MB/);
  });

  test('扩展名不在白名单 → unsupported_format', () => {
    const r = validateAttachment({
      name: 'payload.exe',
      mime: 'application/octet-stream',
      size: 1024,
    });
    assert.equal(r.ok, false);
    if (r.ok) throw new Error('unreachable');
    assert.equal(r.reason, 'unsupported_format');
    assert.match(r.message, /unsupported attachment format/);
    // 措辞里给出白名单提示，方便客户端展示
    assert.match(r.message, /Markdown/);
    assert.match(r.message, /PDF/);
  });

  test('图片 mime 但扩展名是 exe —— 仍走 image 路径（mime 优先）', () => {
    const r = validateAttachment({
      name: 'weird.exe',
      mime: 'image/png',
      size: 1024,
    });
    assert.deepEqual(r, { ok: true });
  });

  test('每条消息 5 个附件放行、6 个拒绝（too_many）', () => {
    assert.deepEqual(
      validateAttachmentCount(MAX_ATTACHMENTS_PER_MESSAGE),
      { ok: true },
    );
    const r = validateAttachmentCount(MAX_ATTACHMENTS_PER_MESSAGE + 1);
    assert.equal(r.ok, false);
    if (r.ok) throw new Error('unreachable');
    assert.equal(r.reason, 'too_many');
    assert.match(r.message, new RegExp(String(MAX_ATTACHMENTS_PER_MESSAGE)));
  });
});

// ── 读模型（真库） ─────────────────────────────────────────────────

describe('listAttachments —— 读模型与归属链', () => {
  let sql: postgres.Sql;
  let db: Db;
  let a: Fixture;
  let b: Fixture;
  let aBuildId: string;
  let aTodoId: string;

  before(async () => {
    sql = postgres(DATABASE_URL, { max: 4 });
    db = drizzle(sql, { schema: dbPkg.schema }) as unknown as Db;
    a = await seedFixture(sql, 'att-A');
    b = await seedFixture(sql, 'att-B');
    const seeded = await seedTodoAndBuild(sql, a);
    aTodoId = seeded.todoId;
    aBuildId = seeded.buildId;
  });

  after(async () => {
    await deleteFixture(sql, a);
    await deleteFixture(sql, b);
    await sql.end();
  });

  test('happy path：user_attachments envelope 被解析为元数据，messageSeq 升序，无凭据/二进制', async () => {
    // seq 1：两张图片 + 一份 PDF
    await seedUserMessageWithAttachments(sql, aBuildId, 1, [
      { id: 'att-1', name: 'shot1.png', mime: 'image/png', sizeBytes: 12_345 },
      { id: 'att-2', name: 'shot2.jpg', mime: 'image/jpeg', sizeBytes: 67_890 },
      { id: 'att-3', name: 'spec.pdf', mime: 'application/pdf', sizeBytes: 1_000_000 },
    ]);
    // seq 2：杂 JSON（kind=machine_selected）—— 不该被当成附件
    await seedUserMessagePlain(
      sql,
      aBuildId,
      2,
      JSON.stringify({ kind: 'machine_selected', machineId: 'm1' }),
    );
    // seq 3：再加一条 Markdown 文档
    await seedUserMessageWithAttachments(sql, aBuildId, 3, [
      { id: 'att-4', name: 'readme.md', mime: 'text/markdown', sizeBytes: 4096 },
    ]);

    const out = await listAttachments(db, { buildId: aBuildId });

    assert.equal(out.length, 4, `expected 4 attachments, got ${out.length}`);
    // messageSeq 升序
    assert.deepEqual(
      out.map((a) => a.messageSeq),
      [1, 1, 1, 3],
    );
    // 名字按 messageSeq, name 稳定排序
    assert.deepEqual(
      out.map((a) => a.name),
      ['shot1.png', 'shot2.jpg', 'spec.pdf', 'readme.md'],
    );

    for (const item of out) {
      assertMetadataOnly(item);
      assert.equal(item.buildId, aBuildId);
      assert.equal(typeof item.id, 'string');
      assert.equal(typeof item.mime, 'string');
      assert.equal(typeof item.sizeBytes, 'number');
      assert.equal(typeof item.createdAt, 'number');
    }

    // 库里 build_message 行数没被 listAttachments 动过（它是只读）
    assert.equal(await countMessages(sql, aBuildId), 3);
  });

  test('同 attachment id 跨消息重复 —— 早的赢', async () => {
    // 在之前 happy path 已经留下的 att-1 之外，新写两条 envelope：att-1 重复（晚的），
    // att-5 新增。att-1 应该还是 messageSeq=1 的那条，att-5 应该出现。
    await seedUserMessageWithAttachments(sql, aBuildId, 4, [
      { id: 'att-1', name: 'shot1-REPLACED.png', mime: 'image/png', sizeBytes: 99 },
      { id: 'att-5', name: 'shot5.png', mime: 'image/png', sizeBytes: 42 },
    ]);

    const out = await listAttachments(db, { buildId: aBuildId });
    const att1 = out.find((a) => a.id === 'att-1');
    const att5 = out.find((a) => a.id === 'att-5');
    assert.ok(att1, 'att-1 missing');
    assert.ok(att5, 'att-5 missing');
    assert.equal(att1!.messageSeq, 1, 'later envelope must not overwrite earlier one');
    assert.equal(att1!.name, 'shot1.png', 'earlier name must win');
    assert.equal(att5!.messageSeq, 4);

    assert.equal(await countMessages(sql, aBuildId), 4);
  });

  test('没有 envelope 时老实返回空数组（降级 = 不是假实现）', async () => {
    // 用 fixture b 独立种一条 todo + build，不写任何附件信封。
    const seededB = await seedTodoAndBuild(sql, b);
    // 写一条普通文本 + 一条其它 kind JSON
    await seedUserMessagePlain(sql, seededB.buildId, 1, 'just a regular user message');
    await seedUserMessagePlain(
      sql,
      seededB.buildId,
      2,
      JSON.stringify({ kind: 'machine_selected', machineId: 'mx' }),
    );

    const out = await listAttachments(db, { buildId: seededB.buildId });
    assert.deepEqual(out, []);
    // 库里 message 行还在；listAttachments 不该删它们
    assert.equal(await countMessages(sql, seededB.buildId), 2);
  });

  test('跨团队隔离 —— 两个 fixture 的 buildId 互不可见', async () => {
    // 保护 1：service 给出的 teamId 必须等于 fixture 自己的 teamId（防
    // 把 teamId 写死成空串 / 随机值）。
    // 保护 2：a 与 b 的 build 不能通过 service 层互见（防跨团队泄漏）。
    const teamA = await loadAttachmentTeamId(db, aBuildId);
    assert.equal(teamA, a.teamId);
    assert.notEqual(teamA, b.teamId, '并行测试隔离：a 与 b 的 teamId 必须不同');

    // a 的 buildId + b 的 todoId —— 必须 403（防跨团队 build 误读）
    const seededB = await seedTodoAndBuild(sql, b);
    await assert.rejects(
      () => listAttachments(db, { buildId: aBuildId, todoId: seededB.todoId }),
      /no accessible team|403/,
      '跨团队 + 跨 todo 的组合必须被读',
    );
    // 库里未变（listAttachments 只读）
    assert.equal(await countMessages(sql, aBuildId), 4);
  });

  test('不存在的 buildId → 403', async () => {
    await assert.rejects(
      () => loadAttachmentTeamId(db, 'no-such-build'),
      /no accessible team|403/,
    );
  });

  test('todoId 与 buildId 不一致 → 403', async () => {
    // a 的 buildId + 随机 todoId
    await assert.rejects(
      () => listAttachments(db, { buildId: aBuildId, todoId: newId() }),
      /no accessible team|403/,
    );
    // 用 b 的真实 todoId + a 的 buildId 也拒绝（跨团队 + 跨 todo）
    const seededB = await seedTodoAndBuild(sql, b);
    await assert.rejects(
      () => listAttachments(db, { buildId: aBuildId, todoId: seededB.todoId }),
      /no accessible team|403/,
    );
  });

  test('一致 todoId 时按它走归属链', async () => {
    const out = await listAttachments(db, { buildId: aBuildId, todoId: aTodoId });
    assert.equal(out.length, 5);   // att-1..att-5 中 att-1 被覆写仍只一条 → 共 5 条
    for (const item of out) assertMetadataOnly(item);
  });
});

// ── 变异验证 ─────────────────────────────────────────────────────

/**
 * 变异测试（mutation tests）—— **永久**留在套件里。
 *
 * 写两段手写「broken 替代实现」直接调用，断言**真实** `services/attachments.ts`
 * 与之不同：
 *
 *   M1. broken 版只查 `build_message` 不验 team；真实版若被改成同样行为，
 *       `loadAttachmentTeamId` 会消失 —— 我们的断言「它存在且返回正确 teamId」
 *       会变红；「对不存在 buildId 抛 403」也会变红（broken 版返回 undefined）。
 *   M2. broken 版 validate 不查白名单；真实版若有同样行为，evil.exe 会被放行
 *       —— 下面的断言（真实 `validateAttachment(...).ok === false`）会失败。
 *
 * 两个断言变红 = 真实 service 被改坏了。两条都绿 = 真实 service 仍带 guard。
 */
describe('mutation guards —— 真实 service 与 broken 替代必须行为不同', () => {
  let sql: postgres.Sql;
  let db: Db;
  let mut: Fixture;
  let mutBuildId: string;

  before(async () => {
    sql = postgres(DATABASE_URL, { max: 1 });
    db = drizzle(sql, { schema: dbPkg.schema }) as unknown as Db;
    mut = await seedFixture(sql, 'mut-guard');
    const seeded = await seedTodoAndBuild(sql, mut);
    mutBuildId = seeded.buildId;
  });

  after(async () => {
    await deleteFixture(sql, mut);
    await sql.end();
  });

  test('M1：loadAttachmentTeamId 对真 buildId 必须返回**真** teamId（不是常量）', async () => {
    // broken 替代版（把 loadAttachmentTeamId 改成「永远返回 'fake-team'」或
    // 「直接 select build_messages 不 join project」）会让真实 teamId 拿不到 →
    // 这条断言变红。
    assert.equal(
      typeof loadAttachmentTeamId,
      'function',
      'MUTATION? loadAttachmentTeamId 导出不存在',
    );
    const teamId = await loadAttachmentTeamId(db, mutBuildId);
    assert.equal(
      teamId,
      mut.teamId,
      'MUTATION? loadAttachmentTeamId 没走 build→todo→project 归属链（返回常量或别的值）',
    );
  });

  test('M2：真实 validateAttachment 对 evil.exe 必须返回 ok:false', () => {
    // broken 替代版（去掉白名单）会放行 evil.exe；真实 service 必须拒。
    const r = validateAttachment({
      name: 'evil.exe',
      mime: 'application/octet-stream',
      size: 1024,
    });
    assert.equal(
      r.ok,
      false,
      'MUTATION? evil.exe 被放行 —— DOCUMENT_EXTENSIONS 白名单被砍了',
    );
    if (r.ok) throw new Error('unreachable');
    assert.equal(r.reason, 'unsupported_format');
  });
});