/**
 * GitHub REST 客户端 + 凭据/项目层 —— MCP 读类工具
 * （`issues` / `pull_requests` / `workflow_runs`）的**唯一真源**。
 *
 * 与 `services/secrets.ts` / `services/conversations.ts` 同构：纯服务层，
 * 不认 HTTP / JSON-RPC，抛 `HttpError`。授权判定（MCP 侧 key 所属团队成员、
 * 是否 admin）由调用方先做。本文件只负责三件事：
 *
 *   1. **从 `repo_credential` 表取凭据**（`loadRepoCredential`），
 *      `revokedAt IS NOT NULL` 视为不可用 —— 不能拿一个被吊销的 token 去打 GitHub。
 *   2. **项目必须是 GitHub-backed**（`assertGithubProject`）——
 *      `projects.repoKind === 'github'`，否则抛 403。文档：
 *      GitHub 读类工具仅对 GitHub-backed 项目有意义（其它来源是 gitlab/gitea/…）。
 *   3. **薄 REST 客户端**（`createGitHubClient`）—— 走 GitHub `vnd.github+json`，
 *      单页 + `per_page ≤ 100`，**不做无限翻页**。错误响应被规整为
 *      `GitHubClientError { status, message }`，`message` 只用 GitHub 自己返回的
 *      message 字段，**绝不**把 token / Authorization 头塞进异常消息里。
 *
 * `fetchImpl` 注入是为了在测试里完全替代 `fetch`（`node:test` + `tsx` 跑测试时
 * 不能真打 api.github.com），生产代码不动它，走 Node 20+ 内置 `fetch`。
 *
 * 注：本文件不引入 `octokit` 之类的依赖 —— `package.json` 依赖面在
 * CONVERSATION-CONTRACT 之外，加包要走单独审批，不值当为这一层薄壳去推。
 */
import { eq } from 'drizzle-orm';
import type { Db } from '@tds/db';
import { projects, repoCredentials } from '@tds/db';
import { open } from '../crypto.js';
import { HttpError } from '../http.js';

// ─── 公用形状 ─────────────────────────────────────────────────────────

/** 凭据层一行（密文 + 元数据）—— token 已解封。 */
export interface RepoCredential {
  id: string;
  projectId: string;
  username: string | null;
  token: string;
  createdBy: string;
  createdAt: number;
}

/** GitHub Issue 的最小公开字段子集（recon 要求的「人能给模型读懂的字段」）。 */
export interface GitHubIssue {
  number: number;
  title: string;
  state: 'open' | 'closed';
  user: { login: string } | null;
  labels: Array<{ name: string }>;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  /** GitHub REST 列表响应里 PR 也出现在 issues 列表 —— 用这个布尔区分。 */
  isPullRequest: boolean;
}

/** GitHub Pull Request 最小字段。 */
export interface GitHubPullRequest {
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  user: { login: string } | null;
  headRef: string;
  baseRef: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  mergedAt: string | null;
}

/** GitHub Actions workflow run 最小字段。 */
export interface GitHubWorkflowRun {
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed' | 'requested' | 'waiting';
  conclusion:
    | 'success'
    | 'failure'
    | 'neutral'
    | 'cancelled'
    | 'skipped'
    | 'timed_out'
    | 'action_required'
    | null;
  branch: string;
  event: string;
  headSha: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
}

/** REST 客户端对外暴露的三条读路径 —— 列表只取第一页 + `per_page ≤ 100`。 */
export interface GitHubClient {
  listIssues(opts: { owner: string; repo: string; state?: 'open' | 'closed' | 'all'; perPage?: number }): Promise<GitHubIssue[]>;
  listPullRequests(opts: { owner: string; repo: string; state?: 'open' | 'closed' | 'all'; perPage?: number }): Promise<GitHubPullRequest[]>;
  listWorkflowRuns(opts: { owner: string; repo: string; perPage?: number }): Promise<GitHubWorkflowRun[]>;
}

// ─── 凭据层 ────────────────────────────────────────────────────────────

/**
 * 拿项目的 GitHub 凭据（明文 token 已解封）。
 *
 * - 项目没有 `repo_credential` 行 → 404「no credential」。
 *   与「revoked」分开：客户端看到 404 知道要去 add_mcp_server / 上传凭据；
 *   看到 410 知道要去把这条吊销的清掉。
 * - `revokedAt IS NOT NULL` → 410「credential revoked」，token **永不**回给调用方。
 *
 * `open()` 失败（密文被改 / KEK 漂过）会原样抛 `Error`，由调用方决定是否包成 500。
 * 这里是凭据完整性事故，必须暴露给上层 —— 不能静默回 null 让调用方发出去一个空请求。
 */
export async function loadRepoCredential(db: Db, projectId: string): Promise<RepoCredential> {
  const row = (
    await db
      .select({
        id: repoCredentials.id,
        projectId: repoCredentials.projectId,
        username: repoCredentials.username,
        encToken: repoCredentials.encToken,
        encNonce: repoCredentials.encNonce,
        createdBy: repoCredentials.createdBy,
        createdAt: repoCredentials.createdAt,
        revokedAt: repoCredentials.revokedAt,
      })
      .from(repoCredentials)
      .where(eq(repoCredentials.projectId, projectId))
      .orderBy(repoCredentials.createdAt)
      .limit(1)
  )[0];

  if (!row) {
    throw new HttpError(404, 'no repository credential for project');
  }
  if (row.revokedAt !== null) {
    throw new HttpError(410, 'repository credential revoked');
  }

  // 密文形状 `<cipher>.<tag>`（`routes/providers.ts` 的 `sealForColumn` 同源）：
  // provider / connection / secret 都用同一套。tag 拼在 cipher 后面是为了少改一列
  // （表只有 enc_token / enc_nonce 两列），反解必须按 `.` 切开 —— 不能当 base64 直解。
  const dot = row.encToken.lastIndexOf('.');
  if (dot <= 0) {
    // 形状坏了：意味着 `sealForColumn` 之外有人写入了 row，必须冒泡 500 让运维知道。
    throw new Error(`repo_credential.encToken is not in <cipher>.<tag> shape (id=${row.id})`);
  }
  const token = open({
    cipher: row.encToken.slice(0, dot),
    tag: row.encToken.slice(dot + 1),
    nonce: row.encNonce,
  });

  return {
    id: row.id,
    projectId: row.projectId,
    username: row.username,
    token,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

// ─── 项目层 ────────────────────────────────────────────────────────────

/**
 * 断言项目存在 + `repoKind === 'github'`。
 *
 * - 项目不存在 → 404「project not found」。该值与 GitHub 无关，是上游 MCP 路径
 *   （`requireTeamAccess`）会用的反查点。
 * - 项目存在但 `repoKind !== 'github'` → 403「project is not GitHub-backed」。
 *   用 403 不暴露「是不是这个 id」语义，避免被拿来做资源存在性枚举。
 *
 * 同时把 `teamId` 与 `repoFullName` 一并返回（多数调用方下一步要它们，省一次往返）。
 */
export interface GitHubProject {
  id: string;
  teamId: string;
  repoKind: string;
  repoFullName: string | null;
  repoUrl: string | null;
}

export async function assertGithubProject(db: Db, projectId: string): Promise<GitHubProject> {
  const row = (
    await db
      .select({
        id: projects.id,
        teamId: projects.teamId,
        repoKind: projects.repoKind,
        repoFullName: projects.repoFullName,
        repoUrl: projects.repoUrl,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1)
  )[0];

  if (!row) {
    throw new HttpError(404, 'project not found');
  }
  if (row.repoKind !== 'github') {
    throw new HttpError(403, `project is not GitHub-backed (repoKind=${row.repoKind})`);
  }
  return row;
}

/**
 * 从 `projects.repoFullName` 拆出 owner / repo。
 *
 * `repoFullName` 在 GitHub 体系下形如 `owner/repo`（不带 `.git` / 不带协议）。
 * 解析不出来 → 422「malformed repoFullName」。**绝不**默认给空串然后让 GitHub 报 404
 * —— 那等于把上游的 404 噪音拉进来排查。
 */
export function splitRepoFullName(repoFullName: string | null): { owner: string; repo: string } {
  if (!repoFullName) {
    throw new HttpError(422, 'project.repoFullName is empty');
  }
  const slash = repoFullName.indexOf('/');
  if (slash <= 0 || slash === repoFullName.length - 1) {
    throw new HttpError(422, `project.repoFullName must be owner/repo (got "${repoFullName}")`);
  }
  return {
    owner: repoFullName.slice(0, slash),
    repo: repoFullName.slice(slash + 1),
  };
}

// ─── REST 客户端层 ─────────────────────────────────────────────────────

/**
 * GitHub REST 错误规整：只暴露 `status` + `message`。
 *
 * `message` 来自 GitHub 响应体的 `message` 字段（不要把响应体整个塞进来，
 * 会泄露 `documentation_url` 之外的东西），**永不**把 `Authorization` /
 * token 拼到异常字符串里。测试用例「token 不泄漏」专门钉这一条。
 */
export class GitHubClientError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GitHubClientError';
  }
}

/**
 * 把 `perPage` 夹到 [1, 100] 区间；非法值回落 100。
 *
 * GitHub REST API 单页条数硬上限是 100（实测文档：`per_page` 最大 100），
 * 模型读 issue 列表时 30 以下常常不够、100 以上会撑爆上下文，所以默认 100
 * 让上游用 limit 自己夹 —— 测试可以验「>100 被夹回 100」这条契约。
 */
function clampPerPage(perPage: number | undefined): number {
  if (typeof perPage !== 'number' || !Number.isFinite(perPage) || perPage <= 0) {
    return 100;
  }
  return Math.min(Math.floor(perPage), 100);
}

/** 默认 `baseUrl`，覆盖点给测试或 self-hosted GHE 用。 */
const DEFAULT_BASE_URL = 'https://api.github.com';

interface CreateGitHubClientOpts {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * 全局 fetch 覆盖点 —— **只给测试用**。
 *
 * MCP 的三个 case 在 `routes/mcp.ts` 内部构造客户端，调用方拿不到
 * `CreateGitHubClientOpts`，所以没法把 `fetchImpl` 一路传下去。测试要打的是
 * 「参数怎么拼、响应怎么归一化、错误怎么映射」这些纯逻辑，**不该发真实网络**。
 *
 * 用一个模块级 setter 而不是 `vi.mock` 之类的测试框架钩子：本项目测试是裸
 * `node:test`，没有 mock 库（也不打算为此加依赖）。
 *
 * `undefined` = 恢复真实 fetch。生产代码永远不调 `setGitHubFetchImpl`。
 */
let fetchOverride: typeof fetch | undefined;

/** 测试专用：注入假 fetch。传 `undefined` 恢复真实实现。 */
export function setGitHubFetchImpl(impl: typeof fetch | undefined): void {
  fetchOverride = impl;
}

export function createGitHubClient(opts: CreateGitHubClientOpts): GitHubClient {
  const fetchImpl = opts.fetchImpl ?? fetchOverride ?? globalThis.fetch.bind(globalThis);
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${opts.token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'tds-server',
  } as const;

  /** 单页 GET：拼 URL、走 `fetchImpl`、把错误规整成 `GitHubClientError`。 */
  async function getJson<T>(pathAndQuery: string): Promise<T> {
    const url = `${baseUrl}${pathAndQuery}`;
    const res = await fetchImpl(url, { method: 'GET', headers });
    if (!res.ok) {
      // GitHub 错误响应体里 `message` 是给开发者看的纯文本，不含敏感字段，
      // 但如果哪天改了我们就用 fallback 而不是把响应体整个塞进异常。
      let msg = `GitHub ${res.status}`;
      try {
        const body = (await res.json()) as { message?: unknown };
        if (typeof body.message === 'string' && body.message.length > 0) {
          msg = `GitHub ${res.status}: ${body.message}`;
        }
      } catch {
        // 响应不是 JSON（少见：502 / CDN 拦截）。原样 `GitHub <status>` 抛出。
      }
      throw new GitHubClientError(res.status, msg);
    }
    return (await res.json()) as T;
  }

  return {
    async listIssues({ owner, repo, state = 'open', perPage }) {
      const pp = clampPerPage(perPage);
      const qs = new URLSearchParams({
        state,
        per_page: String(pp),
        page: '1',
      });
      type IssueWire = {
        number: number;
        title: string;
        state: 'open' | 'closed';
        user: { login: string } | null;
        labels: Array<{ name: string }>;
        created_at: string;
        updated_at: string;
        html_url: string;
        pull_request?: unknown;
      };
      const wire = await getJson<IssueWire[]>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?${qs}`,
      );
      return wire.map((i) => ({
        number: i.number,
        title: i.title,
        state: i.state,
        user: i.user,
        labels: i.labels,
        createdAt: i.created_at,
        updatedAt: i.updated_at,
        htmlUrl: i.html_url,
        // GitHub REST 把 PR 也列在 /issues 里 —— 业务侧要的就是这一区分。
        isPullRequest: i.pull_request !== undefined && i.pull_request !== null,
      }));
    },

    async listPullRequests({ owner, repo, state = 'open', perPage }) {
      const pp = clampPerPage(perPage);
      const qs = new URLSearchParams({
        state,
        per_page: String(pp),
        page: '1',
      });
      type PrWire = {
        number: number;
        title: string;
        state: 'open' | 'closed';
        merged_at: string | null;
        user: { login: string } | null;
        head: { ref: string };
        base: { ref: string };
        created_at: string;
        updated_at: string;
        html_url: string;
      };
      const wire = await getJson<PrWire[]>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?${qs}`,
      );
      return wire.map((p) => ({
        number: p.number,
        title: p.title,
        // GitHub API 在 PR 已合并且未关时 state='closed' + merged_at 非空。
        // 这里把这种合并状态显式标 'merged'，比让模型自己判断更稳。
        state: p.merged_at ? 'merged' : p.state,
        user: p.user,
        headRef: p.head.ref,
        baseRef: p.base.ref,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
        htmlUrl: p.html_url,
        mergedAt: p.merged_at,
      }));
    },

    async listWorkflowRuns({ owner, repo, perPage }) {
      const pp = clampPerPage(perPage);
      const qs = new URLSearchParams({
        per_page: String(pp),
        page: '1',
      });
      type RunWire = {
        id: number;
        name: string;
        status: 'queued' | 'in_progress' | 'completed' | 'requested' | 'waiting';
        conclusion:
          | 'success'
          | 'failure'
          | 'neutral'
          | 'cancelled'
          | 'skipped'
          | 'timed_out'
          | 'action_required'
          | null;
        head_branch: string;
        event: string;
        head_sha: string;
        created_at: string;
        updated_at: string;
        html_url: string;
      };
      // **注意响应形状**：GitHub 的 `GET /repos/{owner}/{repo}/actions/runs` 回的是
      // `{ total_count, workflow_runs: [...] }` —— 一个**对象**，不是裸数组
      // （`/issues` 与 `/pulls` 才是裸数组）。这里按数组解会在真请求上直接
      // `wire.map is not a function`，而且只有打到真 GitHub 才暴露。
      const wire = await getJson<{ total_count: number; workflow_runs: RunWire[] }>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs?${qs}`,
      );
      return (wire.workflow_runs ?? []).map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        conclusion: r.conclusion,
        branch: r.head_branch,
        event: r.event,
        headSha: r.head_sha,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        htmlUrl: r.html_url,
      }));
    },
  };
}
/**
 * 由 projectId 反查 teamId —— GitHub 三个读工具的授权前置。
 *
 * **必须在 `assertGithubProject` 之前调用**：先确认这个项目对 key 的 owner 可访问，
 * 再谈 repoKind 与凭据。反过来的话，无权访问的项目会通过「repoKind 不是 github」
 * 这条回包泄露它存在 —— 403 的存在性语义要和 `conversations.ts` 一致。
 *
 * 解析不到一律 403（不泄露存在性）。
 */
export async function loadProjectTeamId(db: Db, projectId: string): Promise<string> {
  const row = (await db
    .select({ teamId: projects.teamId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1))[0];
  if (!row) throw new HttpError(403, `project "${projectId}" has no accessible team`);
  return row.teamId;
}
