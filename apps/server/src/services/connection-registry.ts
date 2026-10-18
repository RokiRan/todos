/**
 * Chief 「connect_app / connect_repo / set_remote_shell」三工具的服务层。
 *
 * 给 `chief/registry.ts` 接入用，是 **唯一真源** —— 不许 routes 或 MCP 再写一份。
 * 上层 `chief/executor.ts` 已经把「不可逆确认 / admin / 工具存在」三条闸门走完，
 * 本文件 **不重复** 这些判断，只做事：
 *   1. 校验资源属于传入的 teamId（跨团队一律 403，措辞与既有 services 同款）
 *   2. 写或读业务表
 *   3. 落 audit_event（type 各自 snake_case）
 *   4. 凭据类（`encToken`）走 GCM 密文，回包永不回显值或字段名
 *
 * ## 三个工具的语义与来源（按「读了多少 recon」逐条摆明）
 *
 * ### `set_remote_shell`
 *
 * 依据：
 *   - recon/docs/remote-shell.md 第 25 行 "Remote shell … controlled, dual-switch path
 *     onto a machine you own"
 *   - recon/docs/remote-shell.md 第 31 行 "Two switches must be on: Remote shell on the
 *     target machine, and Remote shell on the agent"
 *   - recon/docs/remote-shell.md 第 44 行 "Flipping the switch requires a team admin"
 *     （这条由 executor 的 admin 闸门处理，service 层不重复）
 *   - recon/docs/remote-shell.md 第 52 行 "Only a machine you run yourself …
 *     can be a remote shell target. A platform machine runs without the tunnel …
 *     the switch is unavailable there"
 *   - recon/docs/remote-shell.md 第 58 行 "The machines list shows a Remote shell
 *     badge next to every machine that has it enabled"
 *
 * 不确定项：
 *   - `tailnetAddr` 是否在切 remote_shell 时一同写入？recon 只说机器有一个
 *     `tailnetAddr` 列（schema.ts:218 已建好），没说与 `shell_enabled` 联动。
 *     **未确认**：此处按最保守理解：保留 `tailnetAddr` 作为可选独立参数，
 *     不与 `enabled` 联动，不在函数内部自动派生。
 *   - 是否允许「打开」时清掉 `tunnelError`？recon/docs/remote-shell.md 末段
 *     "tunnel will not come up … check its network path" 没规定。
 *     **未确认**：此处不清 `tunnelError` —— 让它继续上报运维状态。
 *
 * 实现：单 toggle，写 `machines.shell_enabled` + `machines.updated_at`，可选写
 * `tailnetAddr`；machine 必须属于 `teamId` 且 `runner != 'platform'`（平台机无 tunnel）。
 *
 * ### `connect_repo`
 *
 * 依据：
 *   - recon/docs/external-git.md "Connect one" 段第 16-22 行：字段是
 *     {Repository URL, Username (Optional), Access token, Base branch}
 *   - recon/docs/external-git.md 第 28 行 "The token is stored encrypted. It is used
 *     only to read the branch list and sent only to the machine that runs a task for
 *     the project, and is never shown again"
 *   - recon/docs/external-git.md 第 76 行 "Update credential replaces the stored
 *     username and token" —— 反复连接同 project = 幂等更新而非报错
 *
 * 不确定项：
 *   - 同 `(projectId, token-username组合)` 多次连接时，是否拒绝？
 *     recon 只说 "Update credential replaces"，没给拒的入口。
 *     本文件按 **幂等覆盖** 实现（同 projectId 重新连接 = 改用户名/Token）。
 *   - `repoFullName` 字段在哪一行？recon 里 GitHub 用 fullName（"owner/repo"），
 *     外部 Git 用 URL。这里接受两种作为可选输入，写到 `projects.repo_full_name` /
 *     `projects.repo_url` 是不对的：本服务层不打算改 `project` 表（仓库一旦
 *     connected 文档铁律「cannot be changed」）—— 所以 **未确认**：`repoFullName`
 *     与 `repoUrl` 入参目前只做 shape 校验，不写 `project` 行；
 *     落表只动 `repo_credential`（`username` + 密文 `encToken`/`encNonce`）。
 *   - "Base branch" 是否要校验已读到？recon 说 "pick it from the repository's
 *     branches" —— 这要求远端列表取得到。本文件 **不做** 远端探测，那应该是
 *     caller（上层 confirm card）做的事；service 层只接受 `repoUrl` 形如
 *     `https?://...(.git)?` 或空（缺它时只检查非 git@host 形态）。
 *
 * 实现：同 projectId → upsert `repo_credential`；异 project 才走新建。
 *
 * ### `connect_app`
 *
 * **语义未确认** —— 不做写。
 *
 * 依据与缺口：
 *   - recon/docs/mcp-servers.md 第 14-30 行专门讲 "Connections"，
 *     但 **整段都描述 catalog (Linear/Notion/Jira/…) OAuth 一次性授权流**，
 *     没有「写一条 connection 行」的明文 API —— 这个流程在原站是浏览器跳页签、
 *     厂商回调、把 OAuth refresh token 落 `connection.enc_config` 列。
 *   - recon/docs/mcp-servers.md 第 36 行 "Connecting an app from the catalog … sign
 *     in on the app's own page, and approve access. You land back on the Connections
 *     page" —— 复刻实现不了这个流程（无浏览器交互、无第三方 OAuth client）。
 *   - recon/03-app-api.md 行 224 / 228 / 251 / 252 / 370 五处出现 `connect_app`，
 *     但 **无任何字段 / 行为 / 入参说明**。
 *   - 本工程 `services/connections.ts` 已经覆盖了 `kind: 'custom'` 的写法：
 *     `addConnection` 接受 `transport: 'http' | 'stdio'` + `endpoint` + 加密
 *     `config: Record<string, string>` —— 这就是 Chief 想做 `connect_app` 时
 *     应该复用的服务层。
 *
 * **判定：connect_app = 语义未确认**。
 *   - 本文件只导出只读壳 `listConnectedApps`（直接走 `connections` 表，无写路径）。
 *   - 写路径让 caller（registry 内的 handler）改用 `addConnection`/`updateConnection`
 *     作『显式自定义连接』—— 这条路径在 recon 里已经是 document-confirmed 的语义。
 *   - 真正的 catalog OAuth 流程未复刻，所以 `kind: 'catalog'` 行本文件不创建。
 *
 * 不暴露 `connectApp`、`removeAppConnection` 等写函数 —— 那会引入未经文档支撑的
 * 假实现，破坏「不做假绿」的合约。
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Db } from '@tds/db';
import { auditEvents, connections, machines, projects, repoCredentials } from '@tds/db';
import { HttpError } from '../http.js';
import { newId, now } from '../ids.js';
import { seal } from '../crypto.js';

/* --------------------------------------------------------------------- *
 * 跨团队 403（与 conversations.ts / chief-interaction.ts 同款措辞）
 * --------------------------------------------------------------------- */

const ACCESS_DENIED = (teamId: string): string =>
  `team "${teamId}" is not accessible to this key's owner`;

async function assertMachineInTeam(
  db: Db,
  teamId: string,
  machineId: string,
): Promise<{ id: string; runner: string | null }> {
  const rows = await db
    .select({ id: machines.id, runner: machines.runner })
    .from(machines)
    .where(and(eq(machines.id, machineId), eq(machines.teamId, teamId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new HttpError(403, ACCESS_DENIED(teamId));
  return row;
}

async function assertProjectInTeam(
  db: Db,
  teamId: string,
  projectId: string,
): Promise<{ id: string }> {
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.teamId, teamId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new HttpError(403, ACCESS_DENIED(teamId));
  return row;
}

/** 写一条 audit_event；与 chief-interaction.ts / chief-memory.ts 约定同款。 */
async function audit(
  db: Db,
  teamId: string,
  actorId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.insert(auditEvents).values({
    teamId,
    actorType: 'chief',
    actorId,
    todoId: null,
    buildId: null,
    type,
    payload,
    createdAt: now(),
  });
}

/* --------------------------------------------------------------------- *
 * set_remote_shell
 * --------------------------------------------------------------------- */

export interface SetRemoteShellInput {
  teamId: string;
  actorId: string;
  machineId: string;
  enabled: boolean;
  /**
   * 可选。当前开启时一并登记 tailnet 地址（schema 已有 `tailnet_addr`）。
   * 未确认：是否与 `enabled` 联动 —— 此处按最保守：仅当 caller 显式传时才写。
   */
  tailnetAddr?: string | null;
}

export interface MachineRemoteShellSummary {
  id: string;
  teamId: string;
  name: string;
  shellEnabled: boolean;
  tailnetAddr: string | null;
  runner: string | null;
  updatedAt: number;
}

/**
 * 切换机器的 Remote shell 开关。
 *
 * 闸门（前置 + 后置）：
 *   - machine 必须属于 teamId（403 / ACCESS_DENIED）
 *   - platform 机器拒绝 —— `runner='platform'` 时无 tunnel（recon/remote-shell.md:52）
 *   - 写 audit_event `remote_shell_toggled`
 *
 * 副作用：
 *   - `machines.shell_enabled` ← enabled
 *   - `machines.updated_at`    ← now
 *   - 可选 `machines.tailnet_addr` ← tailnetAddr（仅当 caller 显式传）
 *   - 不动 `machines.tunnel_error`
 */
export async function setRemoteShell(
  db: Db,
  input: SetRemoteShellInput,
): Promise<MachineRemoteShellSummary> {
  const machine = await assertMachineInTeam(db, input.teamId, input.machineId);
  if (machine.runner === 'platform') {
    throw new HttpError(
      422,
      'platform machines cannot enable remote shell (no tunnel — recon/docs/remote-shell.md)',
    );
  }

  const ts = now();
  const patch: Partial<typeof machines.$inferInsert> = {
    shellEnabled: input.enabled,
    updatedAt: ts,
  };
  if (input.tailnetAddr !== undefined) patch.tailnetAddr = input.tailnetAddr;

  await db.update(machines).set(patch).where(eq(machines.id, input.machineId));

  const after = (
    await db
      .select({
        id: machines.id,
        teamId: machines.teamId,
        name: machines.name,
        shellEnabled: machines.shellEnabled,
        tailnetAddr: machines.tailnetAddr,
        runner: machines.runner,
        updatedAt: machines.updatedAt,
      })
      .from(machines)
      .where(eq(machines.id, input.machineId))
      .limit(1)
  )[0];
  if (!after) throw new HttpError(500, 'machine update did not persist');

  await audit(db, input.teamId, input.actorId, 'remote_shell_toggled', {
    machineId: input.machineId,
    enabled: input.enabled,
    ...(input.tailnetAddr !== undefined ? { tailnetAddr: input.tailnetAddr } : {}),
  });

  return {
    id: after.id,
    teamId: after.teamId,
    name: after.name,
    shellEnabled: after.shellEnabled,
    tailnetAddr: after.tailnetAddr,
    runner: after.runner,
    updatedAt: after.updatedAt,
  };
}

/* --------------------------------------------------------------------- *
 * connect_repo
 * --------------------------------------------------------------------- */

const HTTPS_RE = /^https?:\/\/[^\s]+/;
const USERINFO_RE = /^[a-z]+:\/\/[^/@]+@/i;

function assertValidRepoUrl(repoUrl: string): void {
  const trimmed = repoUrl.trim();
  if (trimmed.length === 0) {
    throw new HttpError(422, 'repoUrl must not be empty');
  }
  if (!HTTPS_RE.test(trimmed)) {
    throw new HttpError(
      422,
      `invalid repoUrl "${repoUrl}": external Git repos require http(s) URL (recon/docs/external-git.md)`,
    );
  }
  // 文档铁律：「The URL must not carry a username or password」。
  // 语法上 `scheme://user:pw@host/...` 这种带 userinfo 区的写法一律拒绝。
  if (USERINFO_RE.test(trimmed)) {
    throw new HttpError(
      422,
      `invalid repoUrl "${repoUrl}": URL must not carry credentials in userinfo (recon/docs/external-git.md)`,
    );
  }
}

export interface ConnectRepoInput {
  teamId: string;
  actorId: string;
  projectId: string;
  repoUrl: string;
  /**
   * 可选 —— `owner/repo` 形态的标识符。本服务层不写 `project` 行
   * （仓库一旦连接，文档铁律「cannot be changed」），仅做入参接收。
   * 未确认：catalog connection 是否传这一字段；此处只把值带回 summary。
   */
  repoFullName?: string | null;
  /** Token 必填；空串 → 422。原文：「An empty token has no permission to read」 */
  token: string;
  /** Username 可空；为空时实际发 'oauth2'（schema 注释踩坑标注） */
  username?: string | null;
}

export interface RepoCredentialSummary {
  id: string;
  projectId: string;
  username: string | null;
  createdBy: string;
  createdAt: number;
  revokedAt: number | null;
}

/**
 * 把 project 与一个外部 Git 仓库绑到一起（落 `repo_credential`）。
 *
 * 闸门：
 *   - projectId 必须属于 teamId（403 / ACCESS_DENIED）
 *   - repoUrl 形态校验（http/https URL，且 userinfo 区不夹账号）
 *   - token 非空
 *
 * 副作用：
 *   - 写入（或覆盖）`repo_credential` 一行：username + GCM 密文 token + nonce
 *   - 同 `(projectId)` 第二次连接 → **幂等覆盖**（caller 等价于重新输入凭据）。
 *     这是 recon/docs/external-git.md 第 76 行 "Update credential replaces the
 *     stored username and token" 的最小实现。
 *   - 落 audit_event `repo_connected`
 *
 * **回包绝不回显 token / encToken / encNonce**。
 */
export async function connectRepo(
  db: Db,
  input: ConnectRepoInput,
): Promise<RepoCredentialSummary> {
  assertValidRepoUrl(input.repoUrl);
  if (input.token.length === 0) {
    throw new HttpError(422, 'token must not be empty');
  }
  await assertProjectInTeam(db, input.teamId, input.projectId);

  const sealed = seal(input.token);
  // 与 `services/secrets.ts:204-205` 同款形状：`<cipher>.<tag>` 拼在 enc 列。
  const storedValue = `${sealed.cipher}.${sealed.tag}`;
  const nonce = sealed.nonce;
  const ts = now();
  // 「留空 username 时实际发 oauth2」是 schema 注释（packages/db/src/schema.ts:267）
  // // 直接复刻原文踩坑标记：把空串正规化为 'oauth2'。
  const normalizedUsername = input.username && input.username.length > 0
    ? input.username
    : 'oauth2';

  const existing = (
    await db
      .select()
      .from(repoCredentials)
      .where(eq(repoCredentials.projectId, input.projectId))
      .limit(1)
  )[0];

  if (existing) {
    await db
      .update(repoCredentials)
      .set({
        username: normalizedUsername,
        encToken: storedValue,
        encNonce: nonce,
        // 未传 repoFullName 时**不**改项目行 —— 跳过；只能另写一个项目表接口
      })
      .where(eq(repoCredentials.id, existing.id));
    const row = (
      await db
        .select()
        .from(repoCredentials)
        .where(eq(repoCredentials.id, existing.id))
        .limit(1)
    )[0];
    if (!row) throw new HttpError(500, 'repo_credential update did not persist');
    await audit(db, input.teamId, input.actorId, 'repo_connected', {
      projectId: input.projectId,
      repoUrl: input.repoUrl,
      ...(input.repoFullName ? { repoFullName: input.repoFullName } : {}),
      replaced: true,
    });
    return {
      id: row.id,
      projectId: row.projectId,
      username: row.username,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      revokedAt: row.revokedAt,
    };
  }

  const id = newId();
  await db.insert(repoCredentials).values({
    id,
    projectId: input.projectId,
    username: normalizedUsername,
    encToken: storedValue,
    encNonce: nonce,
    createdBy: input.actorId,
    createdAt: ts,
    revokedAt: null,
  });
  const row = (
    await db
      .select()
      .from(repoCredentials)
      .where(eq(repoCredentials.id, id))
      .limit(1)
  )[0];
  if (!row) throw new HttpError(500, 'repo_credential insert did not persist');

  await audit(db, input.teamId, input.actorId, 'repo_connected', {
    projectId: input.projectId,
    repoUrl: input.repoUrl,
    ...(input.repoFullName ? { repoFullName: input.repoFullName } : {}),
    replaced: false,
  });

  return {
    id: row.id,
    projectId: row.projectId,
    username: row.username,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
  };
}

/* --------------------------------------------------------------------- *
 * connect_app  ── 「语义未确认」分支
 * --------------------------------------------------------------------- */

export interface ConnectedAppSummary {
  /** connection.id —— 这个字段对应的连接归属该 team */
  id: string;
  teamId: string;
  kind: string;
  identifier: string;
  transport: string;
  label: string;
  endpoint: string | null;
  /** 已存凭据的键名（不含值）；与 connections.addConnection 同款回显语义 */
  configKeys: string[];
  expiresAt: number | null;
  createdBy: string;
  createdAt: number;
}

/**
 * 列出某团队已注册的连接 —— 仅 `connection` 表 reader。
 *
 * 与 `services/connections.ts` 的 `listConnections` 是同一份数据，但本文件
 * 因为 **connect_app 的写语义在 recon 中未确认**，所以单独出口：registry
 * 里的 `connect_app` handler 走这里读 + 引导 caller 用 `addConnection`
 * （custom connection 路径，有文档支撑）做真正写入。
 *
 * 不暴露 `connectApp` 之类的写函数 —— 那会引入未经文档支撑的假实现。
 */
export async function listConnectedApps(
  db: Db,
  teamId: string,
): Promise<ConnectedAppSummary[]> {
  const rows = await db
    .select()
    .from(connections)
    .where(
      and(eq(connections.teamId, teamId), isNull(connections.deletedAt)),
    )
    .orderBy(asc(connections.createdAt));
  return rows.map((row) => ({
    id: row.id,
    teamId: row.teamId,
    kind: row.kind,
    identifier: row.identifier,
    transport: row.transport,
    label: row.label,
    endpoint: row.endpoint,
    // 简化 — 详见注释：未确认 connect_app 语义，键名回显属于 connections.addConnection
    // 的回包字段，本「只读壳」不重复实现。
    configKeys: [],
    expiresAt: row.expiresAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  }));
}
