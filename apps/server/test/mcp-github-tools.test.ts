import assert from 'node:assert/strict';
import { test, describe, before, after, afterEach } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import * as dbPkg from '@tds/db';
import { generateApiKey, seal } from '../src/crypto.js';
import { setGitHubFetchImpl } from '../src/services/github.js';
import { newId, now } from '../src/ids.js';
import { generateApiKey } from '../src/crypto.js';
import { registerMcpRoutes } from '../src/routes/mcp.js';

/**
 * MCP 三个 GitHub 读工具 (`issues` / `pull_requests` / `workflow_runs`) 的契约测试。
 *
 * 这是**契约层**测试，先只写「期望的行为」，让它们在工具未实现时先红着。
 * 主代理完成服务层接线后这些用例变绿：
 *   - `apps/server/src/services/github.ts` 导出 `createGitHubClient({ fetchImpl })`
 *     以支持 fetch 注入；以及 `listIssues(db, projectId, opts)` /
 *     `listPullRequests(db, projectId, opts)` /
 *     `listWorkflowRuns(db, projectId, opts)` 三个薄壳
 *   - `apps/server/src/routes/mcp.ts` 的 `executeTool` 给这三个工具加 case：
 *     - `repoKind !== 'github'` 走拒绝分支（**不是**返回空数组 —— GitHub
 *       工具配一个 `other` 仓库是错配，不是「没有 issues 可读」）
 *     - 归属由 project 反查 team（`loadProjectTeamId` 假设的新助手），按
 *       `listTeamIdsForUser` 校验；不传 teamId 输入参数
 *     - 三者返回形状统一为 `{ issues: [...] }` / `{ pullRequests: [...] }` /
 *       `{ workflowRuns: [...] }`
 *   - 每个 case 调 `createGitHubClient({ fetchImpl })` 拿客户端，调 `fetchImpl`
 *     走假 GitHub API（测试里覆盖），再把返回结构过 `{x → T[]}`
 *
 * 出处（事实）：
 *   - `packages/db/src/schema.ts:208` 项目 `repo_kind` 枚举含 `'github'`
 *   - `repo_credential` 表存在（GitHub token 走它，密文存）
 *   - `apps/server/src/mcp-tools.ts` 把这三个工具登记在 read 组
 *   - 「解析不出来的 todo/build/conversation 一律 403」与既有 `conversations.ts`
 *     一致 —— 这里把同样的铁律推广到 `loadProjectTeamId`
 *   - 跨团队 / scope 闸门与 build 工具相同（既已验证）
 *
 * ── 关键期望（钉死，主代理据此实现）──
 *   - `repoKind !== 'github'` → 工具级 `isError`，正文含「github」字样，
 *     **绝不**回 `{issues: []}`（错配不是「没有 issues」）
 *   - 跨团队 project → 工具级 `isError`，正文含 `not accessible to this key's owner`
 *     （与 message_todo 走同一条路，`assertTeamIn`）
 *   - `repo_credential` 不存在 → 工具级 `isError`，正文含 `credential` /
 *     `token` 字样（区别于 repoKind 错配）
 *   - 项目不存在 → 工具级 `isError`，正文与既有 403 措辞同款「has no accessible team」
 *   - 未授权 → JSON-RPC -32002；空 scopes → HTTP 403
 *   - `tools/list` 永远反映 key 的能力（三个工具都会出现，不因未实现而缩水）
 *   - **当前预期**：所有正向返回路径全红，因为服务层 case 尚未接线 —— 工具走
 *     `executeTool` 的 `default` 分支抛 `not implemented in this build`
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://tds@127.0.0.1:5433/tds';

const GITHUB_TOOLS = ['issues', 'pull_requests', 'workflow_runs'] as const;
/** key 的 scopes 一律带 `tool:` 命名空间 —— `isAuthorized` 对不含前缀的 scope 恒 false */
const toolScopes = (names: readonly string[]): string[] => names.map((n) => `tool:${n}`);

interface Fixture {
  label: string;
  userId: string;
  teamId: string;
  projectId: string;
  memberId: string;
  key: string;
}

let sql: postgres.Sql;
let app: FastifyInstance;

async function seedFixture(opts: {
  label: string;
  scopes: string[];
  repoKind?: string;
  withCredential?: boolean;
}): Promise<Fixture> {
  const ts = now();
  const userId = newId();
  const teamId = newId();
  const memberId = newId();
  const projectId = newId();
  const repoKind = opts.repoKind ?? 'github';

  await sql.begin(async (tx) => {
    await tx`insert into "user" (id, email, display_name, status, locale, created_at, updated_at)
              values (${userId}, ${`${opts.label}-${userId}@test.local`}, ${opts.label}, 'active', 'en', ${ts}, ${ts})`;
    await tx`insert into "team" (id, name, plan, storage_quota, created_at)
              values (${teamId}, ${opts.label}, 'free', 1073741824, ${ts})`;
    await tx`insert into "member" (id, team_id, actor_id, member_type, role, joined_at, v)
              values (${memberId}, ${teamId}, ${userId}, 'user', 'admin', ${ts}, 0)`;
    // repo_full_name 给 github 仓填一个 owner/name，让 GitHub 客户端能拼 URL；
    // other 仓则填空（schema 允许 null）
    const repoFullName = repoKind === 'github' ? 'acme/widgets' : null;
    await tx`insert into "project" (id, team_id, name, provider, repo_kind, repo_full_name,
                                     default_branch, next_seq_num, created_at)
              values (${projectId}, ${teamId}, ${opts.label}, 'external', ${repoKind},
                      ${repoFullName}, 'main', 1, ${ts})`;
    if (opts.withCredential) {
      // GitHub token 走**真** seal —— `loadRepoCredential` 会用 `open()` 解封，
      // 占位字节会让它抛错。用假密文的话，测的就不是「凭据能不能取到」而是
      // 「取到之后能不能解」，两件事混在一起，失败时看不出是哪一步坏的。
      const s = seal('ghp_fixture_token_for_tests_only');
      await tx`insert into "repo_credential" (id, project_id, username, enc_token, enc_nonce,
                                              created_by, created_at)
                values (${newId()}, ${projectId}, 'octocat', ${`${s.cipher}.${s.tag}`}, ${s.nonce},
                        ${userId}, ${ts})`;
    }
  });

  const key = generateApiKey();
  await sql`insert into "api_key" (id, user_id, name, key_prefix, key_hash, scopes, created_at)
            values (${newId()}, ${userId}, ${'gh-' + opts.label}, ${key.prefix}, ${key.hash}, ${opts.scopes}, ${ts})`;

  return { label: opts.label, userId, teamId, projectId, memberId, key: key.key };
}

async function deleteFixture(f: Fixture): Promise<void> {
  // 只清本 fixture 名下的行（`where team_id = ${f.teamId}` 等），
  // **绝不用全表 count** —— 并行测试共享同一个库。
  await sql`delete from "repo_credential" where project_id = ${f.projectId}`;
  await sql`delete from "api_key" where user_id = ${f.userId}`;
  await sql`delete from "project" where team_id = ${f.teamId}`;
  await sql`delete from "member" where team_id = ${f.teamId}`;
  await sql`delete from "team" where id = ${f.teamId}`;
  await sql`delete from "user" where id = ${f.userId}`;
}

interface RpcReply {
  statusCode: number;
  body: {
    result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
    error?: { code: number; message: string; data?: unknown };
  };
}

async function rpc(key: string, body: Record<string, unknown>): Promise<RpcReply> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/mcp',
    headers: { authorization: `Bearer ${key}` },
    payload: body,
  });
  let parsed: RpcReply['body'] = {};
  try { parsed = JSON.parse(res.body) as RpcReply['body']; } catch { /* keep empty */ }
  return { statusCode: res.statusCode, body: parsed };
}

async function callTool(key: string, name: string, args: Record<string, unknown>): Promise<RpcReply> {
  return rpc(key, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
}

function callText(r: RpcReply): string {
  return r.body.result?.content?.[0]?.text ?? '';
}

/**
 * 解析工具回包为 JSON。注意：**未实现时回的是 `not implemented in this build`
 * 这段纯文本**，不是合法 JSON —— 调用前应当先用 `r.body.result?.isError` 判一下。
 * 这里故意不在 happy path 用一个会「JSON.parse 炸」的写法 —— 那会让红用例的失败
 * 信息变成 `SyntaxError`，看不到真正的契约钉子。
 */
function callJson(r: RpcReply): { issues?: unknown[]; pullRequests?: unknown[]; workflowRuns?: unknown[] } {
  const text = callText(r);
  try {
    return JSON.parse(text) as never;
  } catch (e) {
    throw new Error(
      `tool result is not valid JSON: ${text.slice(0, 80)} (parse error: ${(e as Error).message})`,
    );
  }
}

describe('MCP GitHub 读工具 (issues / pull_requests / workflow_runs)', () => {
  before(async () => {
    sql = postgres(DATABASE_URL, { max: 5 });
    const db = drizzle(sql, { schema: dbPkg.schema });
    app = Fastify({ logger: false });
    registerMcpRoutes(app, db as never, 'http://test');
    await app.ready();
  });
  after(async () => {
    await app.close();
    await sql.end();
  });

  // ── 已实现路径 ───────────────────────────────────────────────────
  //
  // 全部经 `setGitHubFetchImpl` 注入假响应 —— **不打真实网络**。测的是
  // 「参数怎么拼、响应怎么归一化、错误怎么映射」这些纯逻辑。
  //
  // 用例原先假设「fixture 没注 fetchImpl 所以列表是空的」—— 那是接线前的假设，
  // 接线后真打到了 api.github.com（630ms），拿假 token 换回 401，于是回 `{error}`
  // 而不是 `{issues: []}`。**那才是对的行为**：凭据失败时回空数组等于骗模型说
  // 「这个仓没有 issue」。所以这里改成注入 fetch 并断言真实归一化。

  /** 造一个假 GitHub 响应。记录下被请求的 URL 供断言用。 */
  function fakeGitHub(body: unknown, status = 200) {
    const calls: string[] = [];
    const impl = (async (url: string | URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  afterEach(() => setGitHubFetchImpl(undefined));

  test('issues 正常返回：列表形状、字段映射、URL 带 owner/repo', async () => {
    const f = await seedFixture({
      label: 'issues-ok',
      scopes: toolScopes(['issues']),
      repoKind: 'github',
      repoFullName: 'acme/widgets',
      withCredential: true,
    });
    const { impl, calls } = fakeGitHub([
      {
        id: 1, number: 42, title: '崩溃了', state: 'open',
        updated_at: '2026-10-17T00:00:00Z', html_url: 'https://github.com/acme/widgets/issues/42',
        user: { login: 'octocat' },
      },
    ]);
    setGitHubFetchImpl(impl);
    try {
      const r = await callTool(f.key, 'issues', { projectId: f.projectId });
      assert.equal(r.statusCode, 200, `MUTATION? 不该是 HTTP 错误：${callText(r)}`);
      const out = callJson(r);
      assert.ok(Array.isArray(out.issues), `MUTATION? issues 必须回数组：${callText(r)}`);
      assert.equal(out.issues.length, 1, 'MUTATION? 归一化后丢了一条');
      const issue = (out.issues as Array<Record<string, unknown>>)[0] ?? {};
      assert.equal(issue.number, 42);
      assert.equal(issue.title, '崩溃了');
      assert.equal(issue.updatedAt, '2026-10-17T00:00:00Z', 'MUTATION? updated_at 没归一化成 updatedAt');
      // 归一化后字段是 `htmlUrl`/`user`（不是 wire 的 `html_url`/`author`）。
      // 服务层 map: `{ ... i, htmlUrl: i.html_url }`（`src/services/github.ts`）。
      assert.match(String(issue.htmlUrl), /issues\/42$/, 'MUTATION? html_url 没归一化成 htmlUrl');
      assert.deepEqual(issue.user, { login: 'octocat' }, 'MUTATION? user 字段没透传');
      assert.match(calls[0] ?? '', /\/repos\/acme\/widgets\/issues/, `MUTATION? URL 不对：${calls[0]}`);
    } finally {
      await deleteFixture(f);
    }
  });

  test('issues 上游 401 时回 error，**不是**空数组（不骗模型「没有 issue」）', async () => {
    const f = await seedFixture({
      label: 'issues-401',
      scopes: toolScopes(['issues']),
      repoKind: 'github',
      repoFullName: 'acme/widgets',
      withCredential: true,
    });
    // 上游错误必须**原样带出状态码**，但**绝不带 token**。
    const { impl } = fakeGitHub({ message: 'Bad credentials' }, 401);
    setGitHubFetchImpl(impl);
    try {
      const r = await callTool(f.key, 'issues', { projectId: f.projectId });
      const out = callJson(r);
      assert.equal(out.issues, undefined, 'MUTATION? 上游失败却回空数组 —— 等于骗模型这个仓没有 issue');
      assert.match(String(out.error), /401/, `MUTATION? 没带出上游状态码：${callText(r)}`);
      assert.ok(
        !callText(r).includes('ghp_fixture_token'),
        `MUTATION? 回包泄露了 token：${callText(r)}`,
      );
    } finally {
      await deleteFixture(f);
    }
  });

  test('pull_requests 正常返回：列表形状、merged 从 merged_at 归一化成 state=merged', async () => {
    const f = await seedFixture({
      label: 'pr-ok',
      scopes: toolScopes(['pull_requests']),
      repoKind: 'github',
      repoFullName: 'acme/widgets',
      withCredential: true,
    });
    // wire 必给齐 head / base / merged_at（mapper 会读 p.head.ref / p.base.ref，
    // 缺这两个字段会让 mapper 抛 TypeError，被路由兜成 JSON-RPC -32603，
    // 测的就不是归一化而是错误处理了）。state='open' + merged_at 非空：
    // 服务层 map 把它显式折成 state='merged'（**不是** merged: boolean）。
    const { impl, calls } = fakeGitHub([
      {
        id: 7, number: 9, title: '修一下', state: 'open',
        merged_at: '2026-10-16T10:00:00Z',
        created_at: '2026-10-15T10:00:00Z', updated_at: '2026-10-16T10:00:00Z',
        html_url: 'https://github.com/acme/widgets/pull/9',
        user: { login: 'hubot' },
        head: { ref: 'feature/repair' }, base: { ref: 'main' },
      },
    ]);
    setGitHubFetchImpl(impl);
    try {
      const r = await callTool(f.key, 'pull_requests', { projectId: f.projectId });
      assert.equal(r.statusCode, 200, `MUTATION? ${callText(r)}`);
      const out = callJson(r);
      assert.ok(Array.isArray(out.pullRequests), `MUTATION? 必须回数组：${callText(r)}`);
      const pr = (out.pullRequests as Array<Record<string, unknown>>)[0] ?? {};
      assert.equal(pr.number, 9);
      assert.equal(pr.title, '修一下');
      // 核心断言：服务层把 merged_at 非空折成 state='merged'，没有 merged: boolean。
      assert.equal(pr.state, 'merged', 'MUTATION? merged_at 没归一化成 state:"merged"');
      assert.equal(pr.merged, undefined, 'MUTATION? 服务层不应输出 merged:boolean 字段');
      assert.equal(pr.mergedAt, '2026-10-16T10:00:00Z', 'MUTATION? merged_at 没透传成 mergedAt');
      assert.equal(pr.headRef, 'feature/repair', 'MUTATION? head.ref 没归一化成 headRef');
      assert.equal(pr.baseRef, 'main', 'MUTATION? base.ref 没归一化成 baseRef');
      assert.deepEqual(pr.user, { login: 'hubot' });
      assert.match(String(pr.htmlUrl), /pull\/9$/);
      assert.match(calls[0] ?? '', /\/repos\/acme\/widgets\/pulls/, `MUTATION? URL 不对：${calls[0]}`);
    } finally {
      await deleteFixture(f);
    }
  });

  test('workflow_runs 正常返回：列表形状、conclusion 可为 null', async () => {
    const f = await seedFixture({
      label: 'runs-ok',
      scopes: toolScopes(['workflow_runs']),
      repoKind: 'github',
      repoFullName: 'acme/widgets',
      withCredential: true,
    });
    // wire 必给齐 mapper 读的全字段（head_branch / event / head_sha / 时间戳
    // 全部参与 map，缺任一会抛 TypeError，被路由兜成 JSON-RPC -32603；
    // 测的就变成「错误处理」而不是「归一化」了）。
    //
    // ⚠️ fixture **照 GitHub 真实形状**喂：GitHub 的 `/actions/runs` 回的是**对象**
    // `{total_count, workflow_runs:[...]}`，不是裸数组（`/issues` 与 `/pulls` 才是）。
    // 本条测试原先用裸数组，正好掩盖了服务层「把整个响应当数组」的解包 bug ——
    // 那种 bug 只有打到真 GitHub 才暴露（`wire.map is not a function`）。
    // 服务层已修（见 `src/services/github.ts` 的 `listWorkflowRuns` 注释）。
    const { impl, calls } = fakeGitHub({
      total_count: 1,
      workflow_runs: [
        {
          id: 100, name: 'CI', status: 'in_progress', conclusion: null,
          head_branch: 'main', head_sha: 'abc123',
          event: 'push',
          created_at: '2026-10-17T01:00:00Z', updated_at: '2026-10-17T01:01:00Z',
          html_url: 'https://github.com/acme/widgets/actions/runs/100',
        },
      ],
    });
    setGitHubFetchImpl(impl);
    try {
      const r = await callTool(f.key, 'workflow_runs', { projectId: f.projectId });
      assert.equal(r.statusCode, 200, `MUTATION? ${callText(r)}`);
      const out = callJson(r);
      assert.ok(Array.isArray(out.workflowRuns), `MUTATION? 必须回数组：${callText(r)}`);
      const run = (out.workflowRuns as Array<Record<string, unknown>>)[0] ?? {};
      assert.equal(run.id, 100);
      assert.equal(run.name, 'CI');
      assert.equal(run.status, 'in_progress');
      // 运行中的 conclusion 应为 null，不该被抹成空串。
      assert.equal(run.conclusion, null, 'MUTATION? 运行中的 conclusion 应为 null，不该被抹成空串');
      // 字段名是 camelCase（head_branch → branch / head_sha → headSha），与
      // issue / PR 同一套规约。
      assert.equal(run.branch, 'main', 'MUTATION? head_branch 没归一化成 branch');
      assert.equal(run.headSha, 'abc123', 'MUTATION? head_sha 没归一化成 headSha');
      assert.equal(run.event, 'push');
      assert.equal(run.createdAt, '2026-10-17T01:00:00Z');
      assert.equal(run.updatedAt, '2026-10-17T01:01:00Z');
      assert.match(String(run.htmlUrl), /actions\/runs\/100$/);
      assert.match(calls[0] ?? '', /\/repos\/acme\/widgets\/actions\/runs/, `MUTATION? URL 不对：${calls[0]}`);
    } finally {
      await deleteFixture(f);
    }
  });

  test('上游返回空列表时回空数组（真的没有 issue 与「查失败」要分得开）', async () => {
    const f = await seedFixture({
      label: 'issues-empty',
      scopes: toolScopes(['issues']),
      repoKind: 'github',
      repoFullName: 'acme/widgets',
      withCredential: true,
    });
    setGitHubFetchImpl(fakeGitHub([]).impl);
    try {
      const out = callJson(await callTool(f.key, 'issues', { projectId: f.projectId }));
      assert.deepEqual(out.issues, [], 'MUTATION? 上游真空列表应回空数组');
      assert.equal(out.error, undefined, 'MUTATION? 成功时不该带 error');
    } finally {
      await deleteFixture(f);
    }
  });

  // ── 拒绝路径（与既有 build 工具同语义，钉的是**边界**）────────────

  test('repoKind 不是 github 时被拒（不是返回空数组）', async () => {
    // 用 `other` 仓库试 issues / pull_requests / workflow_runs —— 这三个工具
    // 只对 github 仓有意义，other 仓调它们是**错配**而不是「没有 issues」，
    // 错配必须告诉调用方。空数组会让模型以为「这个仓库没有 issues」，
    // 实际上是工具用错了。
    const f = await seedFixture({
      label: 'repo-other',
      scopes: toolScopes(['issues', 'pull_requests', 'workflow_runs']),
      repoKind: 'other',
      withCredential: false,
    });
    try {
      for (const tool of GITHUB_TOOLS) {
        const r = await callTool(f.key, tool, { projectId: f.projectId });
        assert.equal(r.statusCode, 200, `MUTATION? ${tool} 拒绝不该是 HTTP 错误`);
        assert.equal(r.body.result?.isError, true, `MUTATION? ${tool} 错配仓库必须回 isError，不是空数组`);
        // 服务层 `assertGithubProject` 在 repoKind 不匹配时抛
        // `HttpError(403, 'project is not GitHub-backed (repoKind=other)')`
        // （见 `src/services/github.ts`），被路由层的 runTool 包成
        // `ToolCallError('403: project is not GitHub-backed (repoKind=other)')`，
        // tool envelope 走 `isError=true` + 文本。真实措辞含「GitHub」首字母大写，
        // 用大小写不敏感正则防住。
        assert.match(callText(r), /github/i, `MUTATION? ${tool} 错配仓库的措辞必须提到 GitHub（让模型知道换工具）：${callText(r)}`);
        assert.ok(!callText(r).includes('"issues": []') && !callText(r).includes('"pullRequests": []'),
          `MUTATION? ${tool} 错配仓库不能伪装空数组：${callText(r)}`);
      }
    } finally {
      await deleteFixture(f);
    }
  });

  test('跨团队 project 被拒，且未触发外部请求（库里未写 = 无 audit）', async () => {
    const mine = await seedFixture({
      label: 'gh-mine',
      scopes: toolScopes(GITHUB_TOOLS),
      repoKind: 'github',
      withCredential: true,
    });
    const other = await seedFixture({
      label: 'gh-other',
      scopes: [],
      repoKind: 'github',
      withCredential: true,
    });
    try {
      // 用 mine 的 key 读 other 的 project —— 必须 403（与 message_todo 同款）。
      // 不许静默放宽成「列出所有团队」（这是 TASK-1 修过的真 bug）
      for (const tool of GITHUB_TOOLS) {
        const r = await callTool(mine.key, tool, { projectId: other.projectId });
        assert.equal(r.statusCode, 200, `MUTATION? 跨团队不该是 HTTP 错误`);
        assert.equal(r.body.result?.isError, true, `MUTATION? ${tool} 跨团队没标 isError`);
        assert.match(callText(r), /not accessible to this key's owner/,
          `MUTATION? ${tool} 跨团队措辞：${callText(r)}`);
      }

      // 跨团队拒绝不应落 audit_event（这些是读类工具，没东西可审 —— 但
      // 万一主代理加 audit，这里要求「mine 没替 other 写入任何东西」）
      const auditRows = await sql<{ count: number }[]>`
        select count(*)::int as count from "audit_event"
          where team_id = ${other.teamId} and created_at >= ${now() - 5000}
      `;
      assert.equal(auditRows[0]?.count ?? 0, 0,
        'MUTATION? 越权读取不该在别人的团队里留审计');
    } finally {
      await deleteFixture(mine);
      await deleteFixture(other);
    }
  });

  test('projectId 不存在时被拒（与 conversation 的 403 同款），不泄露存在性', async () => {
    // projectId 必须是 key 所有者能访问的；伪造一个不存在的 projectId
    // 不应回 200 空数组（泄露「这个 id 不在库里」），而应回 isError，
    // 与 conversation 的「has no accessible team」同款措辞。
    const f = await seedFixture({
      label: 'gh-bad-pid',
      scopes: toolScopes(GITHUB_TOOLS),
      repoKind: 'github',
      withCredential: true,
    });
    try {
      for (const tool of GITHUB_TOOLS) {
        const r = await callTool(f.key, tool, { projectId: 'totally-not-a-real-project-id' });
        assert.equal(r.statusCode, 200);
        assert.equal(r.body.result?.isError, true,
          `MUTATION? ${tool} 不该回 200 空数组（那等于在说「这个 id 没 issue」）`);
        assert.match(callText(r), /no accessible team|not accessible/i,
          `MUTATION? ${tool} 不存在的 projectId 必须回 403 措辞：${callText(r)}`);
      }
    } finally {
      await deleteFixture(f);
    }
  });

  test('projectId 未传（缺必填）时报 invalid arguments，不调用 fetchImpl', async () => {
    // 这三个工具都必填 projectId —— 客户端漏传时应在 zod 校验层挡下，
    // 不会走到 `createGitHubClient({ fetchImpl })` 那一支（避免发真实请求）。
    // 校验失败 = tool execution error（不是 JSON-RPC error），让模型能自我纠正。
    const f = await seedFixture({
      label: 'gh-no-arg',
      scopes: toolScopes(GITHUB_TOOLS),
      repoKind: 'github',
      withCredential: true,
    });
    try {
      for (const tool of GITHUB_TOOLS) {
        const r = await callTool(f.key, tool, {});   // 无 projectId
        assert.equal(r.statusCode, 200, `MUTATION? ${tool} 参数错误不该是 HTTP 错误`);
        assert.equal(r.body.error, undefined,
          `MUTATION? ${tool} 参数错误不该是 JSON-RPC error：${JSON.stringify(r.body.error)}`);
        assert.equal(r.body.result?.isError, true,
          `MUTATION? ${tool} 参数错误必须以 isError 形式回`);
        assert.match(callText(r), /invalid arguments.*projectId|projectId.*required/i,
          `MUTATION? ${tool} 缺 projectId 的错误信息：${callText(r)}`);
      }
    } finally {
      await deleteFixture(f);
    }
  });

  test('repo_credential 缺失时被拒（区别于 repoKind 错配），不静默回空', async () => {
    // github 仓但没绑 GitHub token —— 这是另一种错配（没有凭据），措辞必须
    // 区别于「不是 github 仓」那条路，否则排查时不知道是补 token 还是改仓库类型。
    const f = await seedFixture({
      label: 'gh-no-cred',
      scopes: toolScopes(GITHUB_TOOLS),
      repoKind: 'github',
      withCredential: false,   // 故意不绑
    });
    try {
      for (const tool of GITHUB_TOOLS) {
        const r = await callTool(f.key, tool, { projectId: f.projectId });
        assert.equal(r.statusCode, 200);
        assert.equal(r.body.result?.isError, true,
          `MUTATION? ${tool} 缺凭据必须回 isError，不能伪装空数组`);
        assert.match(callText(r), /credential|token|repository credential/i,
          `MUTATION? ${tool} 缺凭据的措辞必须提到 credential/token：${callText(r)}`);
        // 不许回「github」那条措辞 —— 仓库类型是对的，缺的是凭据
        assert.ok(!/not.*github|github.*required/i.test(callText(r)),
          `MUTATION? ${tool} 凭据缺失不该用「不是 github 仓」的措辞：${callText(r)}`);
      }
    } finally {
      await deleteFixture(f);
    }
  });

  // ── scope 与 tools/list（与既有 build 工具完全同款）──────────────

  test('scope 只授别的工具时，本工具仍是 -32002（防止加 case 时放宽鉴权）', async () => {
    // 只授 `tool:todos`，这三个 GitHub 工具不在授权集合里 → JSON-RPC -32002。
    // 这是与 build 工具同款的鉴权回归钉子：实现后无论走哪条路径，scope
    // 校验必须先于本地判断。
    const f = await seedFixture({
      label: 'gh-narrow',
      scopes: ['tool:todos'],
      repoKind: 'github',
      withCredential: true,
    });
    try {
      for (const tool of GITHUB_TOOLS) {
        const r = await callTool(f.key, tool, { projectId: f.projectId });
        assert.equal(r.statusCode, 200, `MUTATION? 未授权不该是 HTTP 错误`);
        assert.equal(r.body.error?.code, -32002,
          `MUTATION? ${tool} 未授权必须是 -32002，实际 ${JSON.stringify(r.body.error)}`);
      }
    } finally {
      await deleteFixture(f);
    }
  });

  test('空 scopes 是 HTTP 403（与 mcp-api 既有契约一致）', async () => {
    // 空 scopes = 一把 MCP 工具都没勾，端点层直接 403，不是 200 + JSON-RPC error。
    const f = await seedFixture({
      label: 'gh-empty',
      scopes: [],
      repoKind: 'github',
      withCredential: true,
    });
    try {
      const r = await callTool(f.key, 'issues', { projectId: f.projectId });
      assert.equal(r.statusCode, 403, 'MUTATION? 空 scopes 必须 HTTP 403');
      assert.match((r.body as { error?: string }).error ?? '', /no MCP access/,
        `MUTATION? 403 措辞：${(r.body as { error?: string }).error}`);
    } finally {
      await deleteFixture(f);
    }
  });

  test('tools/list 按 scope 列出：3 个 GitHub 工具都在，且 inputSchema 声明了必填 projectId', async () => {
    // `tools/list` 反映 key 的能力，与实现进度无关 —— 未实现的也必须列。
    // inputSchema 必须真是 JSON Schema object 且声明 projectId 必填。
    const f = await seedFixture({
      label: 'gh-list',
      scopes: toolScopes(GITHUB_TOOLS),
      repoKind: 'github',
      withCredential: true,
    });
    try {
      const r = await rpc(f.key, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      assert.equal(r.statusCode, 200);
      const tools = (r.body.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools;
      // 给 3 个具名 scope → 正好 3 个
      assert.equal(tools.length, 3, `MUTATION? tools/list 与 scope 不符：${tools.map((t) => t.name).join(',')}`);
      const names = tools.map((t) => t.name).sort();
      assert.deepEqual(names, [...GITHUB_TOOLS].sort());

      for (const name of GITHUB_TOOLS) {
        const spec = tools.find((t) => t.name === name)?.inputSchema;
        assert.equal(spec?.type, 'object', `${name} 的 inputSchema 不是 object`);
        assert.deepEqual(spec?.required, ['projectId'],
          `MUTATION? ${name} 的 required 必须是 ['projectId']`);
        // 显式声明 projectId 字段 —— 不许只靠 additionalProperties 透传
        const props = spec?.properties as Record<string, unknown> | undefined;
        assert.equal((props?.projectId as { type?: string } | undefined)?.type, 'string',
          `MUTATION? ${name} 没显式声明 projectId 字段`);
      }
    } finally {
      await deleteFixture(f);
    }
  });

  test('整组 tool:read scope 能看到全部 13 个读工具（含这 3 个 GitHub）', async () => {
    // GitHub 这三个在 read 组 —— 整组 tool:read 授权下必须出现。
    // 反过来证明归组正确（写错组的话 tool:read 看不到它们）。
    const f = await seedFixture({
      label: 'gh-read-group',
      scopes: ['tool:read'],
      repoKind: 'github',
      withCredential: true,
    });
    try {
      const r = await rpc(f.key, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const tools = (r.body.result as { tools: Array<{ name: string }> }).tools;
      const names = new Set(tools.map((t) => t.name));
      for (const name of GITHUB_TOOLS) {
        assert.ok(names.has(name), `tool:read 下少了 ${name}`);
      }
      assert.equal(tools.length, 13, `tool:read 应列 13 个读工具，实际 ${tools.length}`);
    } finally {
      await deleteFixture(f);
    }
  });

  // ── 变异验证：见报告 ────────────────────────────────────────────────
  //
  // 本文件**不在执行时跑变异**：不修改 `routes/mcp.ts` / `services/*.ts`（那是
  // 主代理的活儿），所以没法亲手把「去掉 repoKind 校验 / 去掉 credential 校验」
  // 等偷懒改法应用一遍。但上面 9 条契约钉子就是**变异打红的总集合**：
  //   - 去掉 repoKind 校验 → 「repoKind 不是 github 时被拒」变红
  //   - 去掉 credential 缺失分支 → 「repo_credential 缺失时被拒」变红
  //   - 把 zod 校验改成 silent-pass → 「projectId 未传时报 invalid arguments」变红
  //   - 把项目不存在静默成 200 空数组 → 「projectId 不存在时被拒」变红
  //   - 把 `assertTeamIn` 拿掉 / 换成静默回退 → 「跨团队 project 被拒」变红
  //   - 把 scope 校验去掉 → 「scope 只授别的工具时，本工具仍是 -32002」变红
  //   - 把工具挪出 read 组 → 「整组 tool:read scope 能看到全部 13 个读工具」变红
  // 主代理接线后若发现某个正向回归被默许了，上面任何一条变红就能立刻定位。
});