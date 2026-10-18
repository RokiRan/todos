/**
 * Project（板上的仓库）的服务层 —— Chief 工具 `create_project` / `update_project`
 * 的唯一真源。
 *
 * 与 `services/secrets.ts` / `services/connections.ts` / `services/schedules.ts`
 * 同构：纯服务层，不认 HTTP、不认 JSON-RPC，抛 `HttpError`。授权判定（是不是
 * 这个团队、是不是 admin）由调用方先做 —— REST 侧是 `actorForTeam`，MCP 侧是
 * `requireTeamAccess`。这里只管项目本身的业务规则。
 *
 * ── 项目语义（recon/docs/projects.md）──
 *   - 一个项目对应**一个仓库**；建好后**仓库不可改**（文档：「Once connected,
 *     a project's repository cannot be changed. Connecting a repository
 *     requires a team admin」）。
 *   - Free 档一个 team 最多 6 个项目（`FREE_LIMITS.projects`），由
 *     `packages/protocol/src/quota.ts` 的 `quota.projects(current)` 给规整错误。
 *   - 已连接仓库后再改 `repoUrl` / `repoKind` / `repoFullName` 一律拒绝 —
 *     必须走「先删再建」流程；本服务层不该有这条语义，但 `updateProject` 的
 *     `patch` 不带这三个字段，调用方传也会被这里静默忽略（防御性）。
 *   - `next_seq_num` 是 todo 的人类编号分配器，**创建时必须初始化为 1**（已有
 *     seed 行就是 1，复刻原站行为）。
 *   - `default_branch` 改是允许的（文档：项目设置里「changable at any time」），
 *     但要小心 `builds` / `steps` 没强 FK 拽住旧分支。
 *
 * ── 跨团队访问的措辞 ──
 *   一律 403：`team "<id>" is not accessible to this key's owner` ——
 *   复用 `routes/mcp.ts:548` / `auth.ts:152` 的现有措辞。
 */

import { and, count, eq } from 'drizzle-orm';
import { quota } from '@tds/protocol';
import type { Db } from '@tds/db';
import { auditEvents, projects } from '@tds/db';
import { HttpError } from '../http.js';
import { newId, now } from '../ids.js';

/** repo URL 的形态校验 —— 仅允许 `git@` / `https://` / `file://`。 */
const REPO_URL_SCHEMES = [/^git@[^:]+:/, /^https:\/\//, /^file:\/\//] as const;

/**
 * 服务层对外的**只读摘要** —— 不含内部列细节，调用方拿到即可。
 *
 * 故意不返回 `nextSeqNum` / `iconUrl` 这些 UI 不消费的列；模型只需要核对信息。
 */
export interface ProjectSummary {
  id: string;
  teamId: string;
  name: string;
  provider: string;
  repoKind: string;
  repoFullName: string | null;
  repoUrl: string | null;
  defaultBranch: string;
  description: string | null;
  createdAt: number;
}

/** 创建项目（连接仓库前的 stub 也走这条 — 没传 repoUrl 也合法）。 */
export interface CreateProjectInput {
  teamId: string;
  actorId: string;
  name: string;
  /** 默认 'external'（MVP 只做 external；保留 platform 枚举位）。 */
  provider?: 'external' | 'platform' | undefined;
  /** 默认 'other'；连外部 Git 时按真实厂商给。 */
  repoKind?: 'github' | 'gitlab' | 'gitea' | 'forgejo' | 'bitbucket' | 'other' | undefined;
  /** 'owner/repo' 或本地文件路径。给的话要过 `assertValidRepoUrl`。 */
  repoUrl?: string | null | undefined;
  repoFullName?: string | null | undefined;
  /** 默认 'main'（实测)。 */
  defaultBranch?: string | undefined;
  description?: string | null | undefined;
}

/** 部分更新 —— 没传字段保持原值。仓库三件套（kind/url/fullName）不允许改。 */
export interface UpdateProjectInput {
  teamId: string;
  projectId: string;
  actorId: string;
  patch: {
    name?: string | undefined;
    defaultBranch?: string | undefined;
    description?: string | null | undefined;
  };
}

/**
 * 校验 `repoUrl`：必须是 `git@host:` 或 `https://...` 或 `file:///...`。
 *
 * 依据是 `recon/docs/projects.md` 的四种「File source」选项：
 *   - GitHub / GitLab / Gitee / 自建 → 必然是 https
 *   - SSH-style → `git@host:owner/repo.git`
 *   - 本地文件夹导入 → `file:///...`
 */
export function assertValidRepoUrl(repoUrl: string): void {
  if (repoUrl.length === 0) {
    throw new HttpError(422, 'repoUrl must not be empty');
  }
  if (!REPO_URL_SCHEMES.some((re) => re.test(repoUrl))) {
    throw new HttpError(
      422,
      `repoUrl must start with one of git@<host>:, https://, file:// (got "${repoUrl.slice(0, 32)}")`,
    );
  }
}

function toSummary(row: typeof projects.$inferSelect): ProjectSummary {
  return {
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    provider: row.provider,
    repoKind: row.repoKind,
    repoFullName: row.repoFullName,
    repoUrl: row.repoUrl,
    defaultBranch: row.defaultBranch,
    description: row.description,
    createdAt: row.createdAt,
  };
}

/** Free 档硬上限校验。teamId 必须事先确认属于 key owner —— 这里不再判。 */
async function assertProjectQuota(db: Db, teamId: string): Promise<void> {
  const row = (
    await db.select({ c: count() }).from(projects).where(eq(projects.teamId, teamId))
  )[0];
  const current = row?.c ?? 0;
  const check = quota.projects(current);
  if (!check.ok) {
    throw new HttpError(422, check.message);
  }
}

/**
 * 建一个项目。配额在前(quota.projects)→ repoUrl 形态校验 → insert → 审计。
 *
 * 失败路径(quota / 形态)不会写审计。`actorId` 是 userId,记进 audit.audit_event
 * 的 `actor_id`;创建这种资源类操作不挂 todo_id / build_id。
 */
export async function createProject(
  db: Db,
  input: CreateProjectInput,
): Promise<ProjectSummary> {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new HttpError(422, 'project name must not be empty');
  }
  if (input.repoUrl != null && input.repoUrl.length > 0) {
    assertValidRepoUrl(input.repoUrl);
  }
  await assertProjectQuota(db, input.teamId);

  const id = newId();
  const ts = now();
  const row = {
    id,
    teamId: input.teamId,
    name,
    provider: input.provider ?? 'external',
    repoKind: input.repoKind ?? 'other',
    repoFullName: input.repoFullName ?? null,
    repoUrl: input.repoUrl ?? null,
    defaultBranch: input.defaultBranch ?? 'main',
    description: input.description ?? null,
    // 项目的人类编号分配器—— todoService.todos.create 写 todo 时从这里
    // 取自增数列号,本服务层必须初始化为 1(seed 行的实际值)。
    nextSeqNum: 1,
    createdAt: ts,
  };
  await db.insert(projects).values(row);
  const inserted = (
    await db.select().from(projects).where(eq(projects.id, id)).limit(1)
  )[0];
  if (!inserted) throw new HttpError(500, 'project insert lost its row');
  // 写审计——资源类操作,actorType 写 'user'。
  await db.insert(auditEvents).values({
    teamId: input.teamId,
    actorType: 'user',
    actorId: input.actorId,
    todoId: null,
    buildId: null,
    type: 'project_created',
    payload: {
      projectId: id,
      name,
      provider: row.provider,
      repoKind: row.repoKind,
    },
    createdAt: ts,
  });
  return toSummary(inserted);
}

/**
 * 部分更新项目设置。**仓库三件套**(provider / repoKind / repoFullName / repoUrl)
 * 不在本服务的 patch 上故意没暴露,绕过 patch 接口也改不动仓库。
 *
 * 跨团队:`teamId` 与 project 实际所属 team 不一致 → 403(同款措辞)。
 */
export async function updateProject(
  db: Db,
  input: UpdateProjectInput,
): Promise<ProjectSummary> {
  const current = (
    await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, input.projectId), eq(projects.teamId, input.teamId)))
      .limit(1)
  )[0];
  if (!current) {
    // 不区分不存在 vs 跨团队——两种都返回"不属于这个团队",避免泄露存在性。
    throw new HttpError(403, `team "${input.teamId}" is not accessible to this key's owner`);
  }

  const patch: Partial<typeof projects.$inferInsert> = {};
  if (input.patch.name !== undefined) {
    const trimmed = input.patch.name.trim();
    if (trimmed.length === 0) {
      throw new HttpError(422, 'project name must not be empty');
    }
    patch.name = trimmed;
  }
  if (input.patch.defaultBranch !== undefined) {
    const branch = input.patch.defaultBranch.trim();
    if (branch.length === 0) {
      throw new HttpError(422, 'defaultBranch must not be empty');
    }
    patch.defaultBranch = branch;
  }
  if (input.patch.description !== undefined) {
    patch.description = input.patch.description;
  }

  // 没有传任何可改字段 → 直接回原值,不写审计(空写白写)。
  if (Object.keys(patch).length === 0) {
    return toSummary(current);
  }

  await db.update(projects).set(patch).where(eq(projects.id, input.projectId));
  const after = (
    await db.select().from(projects).where(eq(projects.id, input.projectId)).limit(1)
  )[0];
  if (!after) throw new HttpError(404, `project "${input.projectId}" not found`);

  const ts = now();
  await db.insert(auditEvents).values({
    teamId: input.teamId,
    actorType: 'user',
    actorId: input.actorId,
    todoId: null,
    buildId: null,
    type: 'project_updated',
    payload: { projectId: input.projectId, patch },
    createdAt: ts,
  });
  return toSummary(after);
}
