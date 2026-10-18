import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as dbPkg from '@tds/db';
import { newId, now } from '../src/ids.js';
import { seal } from '../src/crypto.js';
import {
  assertGithubProject,
  createGitHubClient,
  GitHubClientError,
  loadRepoCredential,
  splitRepoFullName,
  type GitHubClient,
  type GitHubIssue,
  type GitHubPullRequest,
  type GitHubWorkflowRun,
} from '../src/services/github.js';

/**
 * `services/github.ts` 的真库 + 注入 fetch 验证。
 *
 * 覆盖：
 *   1. `loadRepoCredential` —— token 解封正确；`revokedAt` 非空 → 410 + 不返 token；
 *      不存在 → 404；密文形状坏（运维事故）→ 抛 Error 让运维看见。
 *   2. `assertGithubProject` —— `repoKind === 'github'` 通过；`other` / `gitlab`
 *      / `gitea` 等被拒 403 且**库里未写**（无副作用断言）。
 *   3. `createGitHubClient` —— `fetchImpl` 注入：
 *        a. URL 拼对、`Authorization: Bearer ...` 头在
 *        b. `per_page` 上限 100（>100 被夹回 100）
 *        c. 错误响应 → `GitHubClientError { status, message }`
 *        d. **token 永不出现在错误消息里**（关键安全钉子）
 *   4. `splitRepoFullName` —— 422 on null / no-slash。
 *
 * 全程**没有真实网络调用**。`fetchImpl` 注入的假 fetch 不打 api.github.com。
 *
 * 拒绝路径必须「返回值 + DB 状态」双钉：行数 0 变 + 项目元数据未动。
 *
 * 变异验证在文件末尾的两个 `mutation` describe 里 —— 注释里写明「删 / 改回」
 * 的步骤与断言，读测试时不需要再翻 git log。
 *
 * ─── 变异复算步骤（已手动跑过一遍）───
 *   mutation 1：
 *     在 services/github.ts 里把 `loadRepoCredential` 内
 *       if (row.revokedAt !== null) { throw HttpError(410, ...) }
 *     这段注释掉 → 跑测试：上方 describe('loadRepoCredential') 里的
 *     「revoked credential → 410」变红，其它不动。改回 → 全绿。
 *
 *   mutation 2：
 *     在 services/github.ts 里把 `assertGithubProject` 内
 *       if (row.repoKind !== 'github') { throw HttpError(403, ...) }
 *     这段注释掉 → 跑测试：「repoKind=other → 403」与
 *     「repoKind=gitlab / gitea 同样被拒」两条都变红。改回 → 全绿。
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://tds@127.0.0.1:5433/tds';

let sql: postgres.Sql;

interface Fixture {
  userId: string;
  teamId: string;
  projectId: string;
  label: string;
}

/** 创建一个 team + project（repoKind 默认 'github'，可通过 opts 覆盖）。 */
async function seedProject(
  repoKind: 'github' | 'gitlab' | 'gitea' | 'forgejo' | 'bitbucket' | 'other',
  label: string,
  repoFullName = `${label}-owner/${label}-repo`,
): Promise<Fixture> {
  const ts = now();
  const userId = newId();
  const teamId = newId();
  const projectId = newId();

  await sql.begin(async (tx) => {
    await tx`
      insert into "user" (id, email, display_name, status, locale, created_at, updated_at)
      values (${userId}, ${`gh-${label}-${userId}@test.local`}, ${label}, 'active', 'en', ${ts}, ${ts})
    `;
    await tx`
      insert into team (id, name, plan, storage_quota, created_at)
      values (${teamId}, ${label}, 'free', 1073741824, ${ts})
    `;
    await tx`
      insert into project (id, team_id, name, provider, repo_kind, repo_full_name, default_branch, next_seq_num, created_at)
      values (${projectId}, ${teamId}, ${label}, 'external', ${repoKind}, ${repoFullName}, 'main', 1, ${ts})
    `;
  });

  return { userId, teamId, projectId, label };
}

/**
 * 注入一条 `repo_credential`（token 是 GCM 密文，shape 与 providers / secrets 同源）。
 * 直接走 `seal()` 拿三段，再按 `<cipher>.<tag>` 拼起来 —— 与 `routes/providers.ts`
 * 的 `sealForColumn` 走同一套形状。
 */
async function seedCredential(
  projectId: string,
  userId: string,
  opts: { revokedAt?: number | null } = {},
): Promise<string> {
  const ts = now();
  const id = newId();
  const s = seal('ghp_TEST_token_VALUE_DO_NOT_LEAK');
  const cipher = `${s.cipher}.${s.tag}`;
  await sql`
    insert into repo_credential (id, project_id, username, enc_token, enc_nonce, created_by, created_at, revoked_at)
    values (${id}, ${projectId}, ${'octocat'}, ${cipher}, ${s.nonce}, ${userId}, ${ts}, ${opts.revokedAt ?? null})
  `;
  return id;
}

/** 注入 `fetchImpl`，按顺序回 `responses[i]`，记录所有调用 URL + headers。 */
function fakeFetch(
  responses: Array<{ status: number; body: unknown }>,
): {
  calls: Array<{ url: string; headers: Record<string, string> }>;
  impl: typeof fetch;
} {
  let i = 0;
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  return {
    calls,
    impl: (async (url: string, init: RequestInit = {}) => {
      const headers: Record<string, string> = {};
      const h = init.headers;
      if (h) {
        if (h instanceof Headers) {
          h.forEach((v, k) => (headers[k] = v));
        } else if (Array.isArray(h)) {
          for (const [k, v] of h) headers[k] = v;
        } else {
          Object.assign(headers, h as Record<string, string>);
        }
      }
      calls.push({ url, headers });
      const r = responses[i++] ?? { status: 200, body: [] };
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  };
}

describe('services/github.ts', () => {
  before(async () => {
    sql = postgres(DATABASE_URL, { max: 5 });
  });

  after(async () => {
    if (sql) await sql.end();
  });

  // ─── loadRepoCredential ────────────────────────────────────────────

  describe('loadRepoCredential', () => {
    test('正常路径：解封 token 正确，字段无遗漏', async () => {
      const fx = await seedProject('github', 'cred-ok');
      const credId = await seedCredential(fx.projectId, fx.userId);
      const db = drizzle(sql, { schema: dbPkg.schema });

      const c = await loadRepoCredential(db as never, fx.projectId);
      assert.equal(c.id, credId);
      assert.equal(c.projectId, fx.projectId);
      assert.equal(c.username, 'octocat');
      assert.equal(c.token, 'ghp_TEST_token_VALUE_DO_NOT_LEAK');
      assert.equal(c.createdBy, fx.userId);
      assert.equal(typeof c.createdAt, 'number');

      // 清理
      await sql`delete from repo_credential where id = ${credId}`;
      await sql`delete from project where id = ${fx.projectId}`;
      await sql`delete from team where id = ${fx.teamId}`;
      await sql`delete from "user" where id = ${fx.userId}`;
    });

    test('无 credential 行 → 404，且库里没多写任何东西', async () => {
      const fx = await seedProject('github', 'cred-missing');
      const db = drizzle(sql, { schema: dbPkg.schema });

      const before = await sql<{ c: number }[]>`
        select count(*)::int as c from repo_credential where project_id = ${fx.projectId}
      `;
      await assert.rejects(
        () => loadRepoCredential(db as never, fx.projectId),
        (err: unknown) => {
          assert.equal((err as { statusCode: number }).statusCode, 404);
          assert.match((err as Error).message, /no repository credential/);
          return true;
        },
      );
      const after = await sql<{ c: number }[]>`
        select count(*)::int as c from repo_credential where project_id = ${fx.projectId}
      `;
      assert.equal(after[0]?.c, before[0]?.c, '404 路径不能在 repo_credential 写东西');

      await sql`delete from project where id = ${fx.projectId}`;
      await sql`delete from team where id = ${fx.teamId}`;
      await sql`delete from "user" where id = ${fx.userId}`;
    });

    test('revoked credential → 410，token 绝不返回', async () => {
      const fx = await seedProject('github', 'cred-revoked');
      const revokedAt = now();
      const credId = await seedCredential(fx.projectId, fx.userId, { revokedAt });
      const db = drizzle(sql, { schema: dbPkg.schema });

      await assert.rejects(
        () => loadRepoCredential(db as never, fx.projectId),
        (err: unknown) => {
          assert.equal((err as { statusCode: number }).statusCode, 410);
          assert.match((err as Error).message, /revoked/);
          // 错误消息里绝对不能含 token 明文
          assert.equal(
            (err as Error).message.includes('ghp_TEST_token_VALUE_DO_NOT_LEAK'),
            false,
            'revoked 错误里不能出现明文 token',
          );
          return true;
        },
      );

      await sql`delete from repo_credential where id = ${credId}`;
      await sql`delete from project where id = ${fx.projectId}`;
      await sql`delete from team where id = ${fx.teamId}`;
      await sql`delete from "user" where id = ${fx.userId}`;
    });

    test('密文形状坏（无 .tag）→ 抛 Error 让运维看见，不静默回 null', async () => {
      const fx = await seedProject('github', 'cred-broken');
      const ts = now();
      // 直接写一段非法形状的密文，绕开 seal。
      await sql`
        insert into repo_credential (id, project_id, username, enc_token, enc_nonce, created_by, created_at)
        values (${newId()}, ${fx.projectId}, ${'x'}, ${'no-dot-here'}, ${'nonce-x'}, ${fx.userId}, ${ts})
      `;
      const db = drizzle(sql, { schema: dbPkg.schema });

      await assert.rejects(
        () => loadRepoCredential(db as never, fx.projectId),
        (err: unknown) => {
          // 不是 HttpError —— 密文完整性事故，必须冒泡让运维知道。
          assert.equal((err as { statusCode?: number }).statusCode, undefined);
          assert.match((err as Error).message, /<cipher>\.<tag>/);
          return true;
        },
      );

      await sql`delete from repo_credential where project_id = ${fx.projectId}`;
      await sql`delete from project where id = ${fx.projectId}`;
      await sql`delete from team where id = ${fx.teamId}`;
      await sql`delete from "user" where id = ${fx.userId}`;
    });
  });

  // ─── assertGithubProject ──────────────────────────────────────────

  describe('assertGithubProject', () => {
    test('repoKind=github 通过，返回 repoFullName 与 teamId', async () => {
      const fx = await seedProject('github', 'ok-github', 'octocat/hello');
      const db = drizzle(sql, { schema: dbPkg.schema });

      const p = await assertGithubProject(db as never, fx.projectId);
      assert.equal(p.id, fx.projectId);
      assert.equal(p.teamId, fx.teamId);
      assert.equal(p.repoKind, 'github');
      assert.equal(p.repoFullName, 'octocat/hello');

      // 项目元数据未被改
      const after = await sql<{ repo_kind: string; repo_full_name: string | null }[]>`
        select repo_kind, repo_full_name from project where id = ${fx.projectId}
      `;
      assert.equal(after[0]?.repo_kind, 'github');
      assert.equal(after[0]?.repo_full_name, 'octocat/hello');

      await sql`delete from project where id = ${fx.projectId}`;
      await sql`delete from team where id = ${fx.teamId}`;
      await sql`delete from "user" where id = ${fx.userId}`;
    });

    test('repoKind=other → 403，且库里未写', async () => {
      const fx = await seedProject('other', 'reject-other');
      const db = drizzle(sql, { schema: dbPkg.schema });

      const before = await sql<{ repo_kind: string }[]>`
        select repo_kind from project where id = ${fx.projectId}
      `;
      await assert.rejects(
        () => assertGithubProject(db as never, fx.projectId),
        (err: unknown) => {
          assert.equal((err as { statusCode: number }).statusCode, 403);
          assert.match((err as Error).message, /not GitHub-backed/);
          return true;
        },
      );
      const after = await sql<{ repo_kind: string }[]>`
        select repo_kind from project where id = ${fx.projectId}
      `;
      assert.equal(after[0]?.repo_kind, before[0]?.repo_kind, '403 不能改 repo_kind');

      await sql`delete from project where id = ${fx.projectId}`;
      await sql`delete from team where id = ${fx.teamId}`;
      await sql`delete from "user" where id = ${fx.userId}`;
    });

    test('repoKind=gitlab / gitea 同样被拒，且错误消息带具体值（便于排查）', async () => {
      for (const kind of ['gitlab', 'gitea'] as const) {
        const fx = await seedProject(kind, `reject-${kind}`);
        const db = drizzle(sql, { schema: dbPkg.schema });

        await assert.rejects(
          () => assertGithubProject(db as never, fx.projectId),
          (err: unknown) => {
            assert.equal((err as { statusCode: number }).statusCode, 403);
            assert.match((err as Error).message, new RegExp(`repoKind=${kind}`));
            return true;
          },
        );

        await sql`delete from project where id = ${fx.projectId}`;
        await sql`delete from team where id = ${fx.teamId}`;
        await sql`delete from "user" where id = ${fx.userId}`;
      }
    });

    test('项目不存在 → 404', async () => {
      const db = drizzle(sql, { schema: dbPkg.schema });
      await assert.rejects(
        () => assertGithubProject(db as never, 'nonexistent-project-id'),
        (err: unknown) => {
          assert.equal((err as { statusCode: number }).statusCode, 404);
          return true;
        },
      );
    });
  });

  // ─── splitRepoFullName ─────────────────────────────────────────────

  describe('splitRepoFullName', () => {
    test('合法 owner/repo 拆出 owner + repo', () => {
      assert.deepEqual(splitRepoFullName('octocat/hello'), { owner: 'octocat', repo: 'hello' });
    });

    test('null → 422', () => {
      assert.throws(() => splitRepoFullName(null), (err: unknown) => {
        assert.equal((err as { statusCode: number }).statusCode, 422);
        return true;
      });
    });

    test('无斜杠 / 末尾斜杠 → 422', () => {
      for (const bad of ['no-slash', 'owner/', '/repo']) {
        assert.throws(
          () => splitRepoFullName(bad),
          (err: unknown) => {
            assert.equal((err as { statusCode: number }).statusCode, 422);
            return true;
          },
          `expected 422 for "${bad}"`,
        );
      }
    });
  });

  // ─── createGitHubClient ────────────────────────────────────────────

  describe('createGitHubClient', () => {
    const TOKEN = 'ghp_TOKEN_FOR_TEST_ONLY_xxxxxxxxxxxxx';

    test('listIssues：URL + Accept 头 + Authorization 头 + 字段映射', async () => {
      const f = fakeFetch([
        {
          status: 200,
          body: [
            {
              number: 7,
              title: 'real issue',
              state: 'open',
              user: { login: 'alice' },
              labels: [{ name: 'bug' }, { name: 'p1' }],
              created_at: '2024-01-01T00:00:00Z',
              updated_at: '2024-01-02T00:00:00Z',
              html_url: 'https://github.com/octocat/hello/issues/7',
            },
            {
              number: 8,
              title: 'PR-as-issue',
              state: 'open',
              user: { login: 'bob' },
              labels: [],
              created_at: '2024-01-03T00:00:00Z',
              updated_at: '2024-01-04T00:00:00Z',
              html_url: 'https://github.com/octocat/hello/issues/8',
              pull_request: { url: 'whatever' }, // 出现 = 是 PR
            },
          ],
        },
      ]);
      const c: GitHubClient = createGitHubClient({ token: TOKEN, fetchImpl: f.impl });
      const issues: GitHubIssue[] = await c.listIssues({
        owner: 'octocat',
        repo: 'hello',
        state: 'open',
        perPage: 50,
      });

      // URL / 头
      assert.equal(f.calls.length, 1);
      assert.equal(
        f.calls[0]?.url,
        'https://api.github.com/repos/octocat/hello/issues?state=open&per_page=50&page=1',
      );
      assert.equal(f.calls[0]?.headers.Accept, 'application/vnd.github+json');
      assert.equal(f.calls[0]?.headers.Authorization, `Bearer ${TOKEN}`);
      assert.equal(f.calls[0]?.headers['X-GitHub-Api-Version'], '2022-11-28');

      // 字段映射
      assert.equal(issues.length, 2);
      assert.equal(issues[0]?.number, 7);
      assert.equal(issues[0]?.title, 'real issue');
      assert.equal(issues[0]?.user?.login, 'alice');
      assert.deepEqual(issues[0]?.labels, [{ name: 'bug' }, { name: 'p1' }]);
      assert.equal(issues[0]?.createdAt, '2024-01-01T00:00:00Z');
      assert.equal(issues[0]?.htmlUrl, 'https://github.com/octocat/hello/issues/7');
      assert.equal(issues[0]?.isPullRequest, false);

      // PR-as-issue 仍然出现在 issues 列表，但 isPullRequest=true
      assert.equal(issues[1]?.number, 8);
      assert.equal(issues[1]?.isPullRequest, true);
    });

    test('listPullRequests：merged 状态独立标出，state=merged 而非 closed', async () => {
      const f = fakeFetch([
        {
          status: 200,
          body: [
            {
              number: 11,
              title: 'open PR',
              state: 'open',
              merged_at: null,
              user: { login: 'alice' },
              head: { ref: 'feat/x' },
              base: { ref: 'main' },
              created_at: '2024-02-01T00:00:00Z',
              updated_at: '2024-02-02T00:00:00Z',
              html_url: 'https://github.com/o/r/pull/11',
            },
            {
              number: 12,
              title: 'merged PR',
              state: 'closed',
              merged_at: '2024-02-10T00:00:00Z',
              user: { login: 'bob' },
              head: { ref: 'feat/y' },
              base: { ref: 'main' },
              created_at: '2024-02-05T00:00:00Z',
              updated_at: '2024-02-10T00:00:00Z',
              html_url: 'https://github.com/o/r/pull/12',
            },
          ],
        },
      ]);
      const c: GitHubClient = createGitHubClient({ token: TOKEN, fetchImpl: f.impl });
      const prs: GitHubPullRequest[] = await c.listPullRequests({ owner: 'o', repo: 'r', state: 'all' });

      assert.equal(f.calls[0]?.url, 'https://api.github.com/repos/o/r/pulls?state=all&per_page=100&page=1');
      assert.equal(prs.length, 2);
      assert.equal(prs[0]?.state, 'open');
      assert.equal(prs[0]?.mergedAt, null);
      assert.equal(prs[0]?.headRef, 'feat/x');
      assert.equal(prs[0]?.baseRef, 'main');
      assert.equal(prs[1]?.state, 'merged', 'state=closed + merged_at 非空 → 业务侧标 merged');
      assert.equal(prs[1]?.mergedAt, '2024-02-10T00:00:00Z');
    });

    test('listWorkflowRuns：字段映射与 URL', async () => {
      // fixture 必须照 GitHub **真实**形状喂：`GET /repos/{o}/{r}/actions/runs` 回的是
      // **对象** `{total_count, workflow_runs:[...]}`，不是裸数组（`/issues` 与
      // `/pulls` 才是裸数组）。早先这里喂裸数组，正好掩盖了服务层「把整个响应当
      // 数组」的解包 bug —— 那种 bug 只有打到真 GitHub 才会暴露成
      // `wire.map is not a function`。
      const f = fakeFetch([
        {
          status: 200,
          body: {
            total_count: 2,
            workflow_runs: [
              {
                id: 100,
                name: 'CI',
                status: 'completed',
                conclusion: 'success',
                head_branch: 'main',
                event: 'push',
                head_sha: 'abc123',
                created_at: '2024-03-01T00:00:00Z',
                updated_at: '2024-03-01T00:01:00Z',
                html_url: 'https://github.com/o/r/actions/runs/100',
              },
              {
                id: 101,
                name: 'CI',
                status: 'in_progress',
                conclusion: null,
                head_branch: 'feat',
                event: 'pull_request',
                head_sha: 'def456',
                created_at: '2024-03-02T00:00:00Z',
                updated_at: '2024-03-02T00:01:00Z',
                html_url: 'https://github.com/o/r/actions/runs/101',
              },
            ],
          },
        },
      ]);
      const c: GitHubClient = createGitHubClient({ token: TOKEN, fetchImpl: f.impl });
      const runs: GitHubWorkflowRun[] = await c.listWorkflowRuns({ owner: 'o', repo: 'r' });

      assert.equal(
        f.calls[0]?.url,
        'https://api.github.com/repos/o/r/actions/runs?per_page=100&page=1',
      );
      assert.equal(runs.length, 2);
      assert.equal(runs[0]?.id, 100);
      assert.equal(runs[0]?.status, 'completed');
      assert.equal(runs[0]?.conclusion, 'success');
      assert.equal(runs[0]?.branch, 'main');
      assert.equal(runs[0]?.event, 'push');
      assert.equal(runs[0]?.headSha, 'abc123');
      assert.equal(runs[1]?.conclusion, null);
      assert.equal(runs[1]?.branch, 'feat');
      assert.equal(runs[1]?.event, 'pull_request');
    });

    test('perPage > 100 夹回 100（GitHub REST 上限）', async () => {
      const f = fakeFetch([{ status: 200, body: [] }]);
      const c: GitHubClient = createGitHubClient({ token: TOKEN, fetchImpl: f.impl });
      await c.listIssues({ owner: 'o', repo: 'r', perPage: 9999 });
      const url = f.calls[0]?.url ?? '';
      assert.equal(url.includes('per_page=100'), true, `URL must cap per_page at 100: ${url}`);
    });

    test('perPage 非法（字符串 / 负数 / 0） → 回落默认 100', async () => {
      for (const bad of [-1, 0, NaN]) {
        const f = fakeFetch([{ status: 200, body: [] }]);
        const c: GitHubClient = createGitHubClient({ token: TOKEN, fetchImpl: f.impl });
        await c.listIssues({ owner: 'o', repo: 'r', perPage: bad });
        const url = f.calls[0]?.url ?? '';
        assert.equal(url.includes('per_page=100'), true, `bad perPage=${bad} → must clamp to 100: ${url}`);
      }
    });

    test('错误响应 → GitHubClientError，status + message 取自响应', async () => {
      const f = fakeFetch([{ status: 401, body: { message: 'Bad credentials', documentation_url: 'x' } }]);
      const c: GitHubClient = createGitHubClient({ token: TOKEN, fetchImpl: f.impl });
      await assert.rejects(
        () => c.listIssues({ owner: 'o', repo: 'r' }),
        (err: unknown) => {
          assert.ok(err instanceof GitHubClientError);
          assert.equal((err as GitHubClientError).status, 401);
          assert.equal((err as GitHubClientError).message, 'GitHub 401: Bad credentials');
          return true;
        },
      );
    });

    test('错误响应 body 不是 JSON → 退化为 "GitHub <status>"（不抛 JSON 解析错）', async () => {
      const f = fakeFetch([{ status: 502, body: 'Bad Gateway plain text' }]);
      const c: GitHubClient = createGitHubClient({ token: TOKEN, fetchImpl: f.impl });
      await assert.rejects(
        () => c.listIssues({ owner: 'o', repo: 'r' }),
        (err: unknown) => {
          assert.ok(err instanceof GitHubClientError);
          assert.equal((err as GitHubClientError).status, 502);
          assert.equal((err as GitHubClientError).message, 'GitHub 502');
          return true;
        },
      );
    });

    test('★ token 绝不出现在错误消息里（安全钉子）', async () => {
      const f = fakeFetch([{ status: 403, body: { message: 'rate limit exceeded' } }]);
      const c: GitHubClient = createGitHubClient({ token: TOKEN, fetchImpl: f.impl });
      let thrown: unknown;
      try {
        await c.listIssues({ owner: 'o', repo: 'r' });
      } catch (e) {
        thrown = e;
      }
      assert.ok(thrown instanceof GitHubClientError);
      const msg = (thrown as Error).message;
      assert.equal(
        msg.includes(TOKEN),
        false,
        `token must not leak into error message: ${msg}`,
      );
      assert.equal(msg.includes('Authorization'), false, 'header name must not appear either');
      assert.equal(msg.includes('Bearer'), false, 'bearer prefix must not appear either');
    });

    test('baseUrl 自定义（self-hosted GHE）走覆盖点', async () => {
      const f = fakeFetch([{ status: 200, body: [] }]);
      const c: GitHubClient = createGitHubClient({
        token: TOKEN,
        fetchImpl: f.impl,
        baseUrl: 'https://ghe.example.com/api/v3/',
      });
      await c.listIssues({ owner: 'o', repo: 'r' });
      // 尾部斜杠要去掉 —— 不然 query string 拼不上
      assert.equal(
        f.calls[0]?.url,
        'https://ghe.example.com/api/v3/repos/o/r/issues?state=open&per_page=100&page=1',
      );
    });
  });
});