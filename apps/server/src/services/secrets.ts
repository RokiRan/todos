/**
 * Secret（凭据）的**唯一真源**。
 *
 * 与 `services/todos.ts` / `services/schedules.ts` 同构：纯服务层，不认 HTTP、
 * 不认 JSON-RPC，抛 `HttpError`。授权判定（是不是这个团队、是不是 admin）由调用方
 * 先做 —— REST 侧是 `actorForTeam`，MCP 侧是 `requireTeamAccess` +
 * `requireTeamAdmin`。这里只管凭据本身的业务规则。
 *
 * ── 三条不可动摇的规则（都有测试钉住）──
 *   1. **值永不返回**。`listSecrets` 的返回类型里根本没有 `encValue` 字段 ——
 *      不是运行时过滤，是类型上就拿不到。文档：「Secrets are write-only. After
 *      saving, nobody can view the plaintext value again, including admins.」
 *   2. **值只以密文落库**（`crypto.ts` 的 `seal` → AES-256-GCM）。日志、审计、
 *      MCP 回包里都不该出现明文。
 *   3. **覆盖必须显式**。`overwrite` 不给时，同名 secret 存在 → 409 拒绝。
 *      文档：「It replaces an existing secret only when told to overwrite it.」
 *      静默覆盖等于让调用方以为设了个新名字，实际改掉了别人的凭据。
 *
 * ── scope 语义（recon/docs/secrets.md）──
 *   - `scope` 是 `'team'` 或 `'project'`；给 project 时 `projectId` 必填。
 *   - 同名 secret 可以在 team 与 project 各有一份；project 优先。
 *   - **scope 建立后不可改**：要换就删了重建。所以本服务层没有「改 scope」的函数。
 *   - 唯一约束是 `(team_id, project_id, name)`（`secret_scope_name_uq`）——
 *     注意 Postgres 里 NULL 不参与唯一比较，所以 team 级（project_id IS NULL）
 *     在**数据库层面其实没被这条约束兜住**，同名 team secret 必须在这里显式查。
 */
import { and, count, eq, isNull } from 'drizzle-orm';
import { quota } from '@tds/protocol';
import type { Db } from '@tds/db';
import { projects, secrets } from '@tds/db';
import { open, seal } from '../crypto.js';
import { HttpError } from '../http.js';
import { newId, now } from '../ids.js';

/** 读接口能看到的全部字段 —— 注意没有 `encValue` / `encNonce`。 */
export interface SecretSummary {
  id: string;
  teamId: string;
  projectId: string | null;
  scope: string;
  name: string;
  description: string | null;
  createdBy: string;
  createdAt: number;
}

export interface SetSecretInput {
  teamId: string;
  /** `'team'` 或 `'project'` */
  scope: string;
  /** project scope 时必填 */
  projectId?: string | null;
  name: string;
  description?: string | null;
  /** 明文。只进 `seal`，绝不进返回值、日志或审计。 */
  value: string;
  /** 同名已存在时是否覆盖。不传 = 不覆盖（409）。 */
  overwrite?: boolean;
  createdBy: string;
}

/** 名字即环境变量名：文档示例 `STRIPE_API_KEY`（大写字母、数字、下划线）。 */
const NAME_RE = /^[A-Z][A-Z0-9_]*$/;

function assertValidName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new HttpError(
      422,
      `invalid secret name "${name}": use uppercase letters, digits and underscores (e.g. STRIPE_API_KEY)`,
    );
  }
}

/** 校验 scope / projectId 的一致性，并确认 project 属于该 team。 */
async function assertScope(
  db: Db,
  teamId: string,
  scope: string,
  projectId: string | null | undefined,
): Promise<string | null> {
  if (scope === 'team') {
    // team 级不允许带 projectId：给了就是「我以为是 project 级」，静默忽略会
    // 把它写到错误的可见范围（团队里每个项目都拿到它）。
    if (projectId) {
      throw new HttpError(422, 'team-scoped secret must not carry a projectId');
    }
    return null;
  }
  if (scope === 'project') {
    if (!projectId) {
      throw new HttpError(422, 'project-scoped secret requires a projectId');
    }
    const row = (await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.teamId, teamId)))
      .limit(1))[0];
    if (!row) throw new HttpError(422, `project "${projectId}" is not in team "${teamId}"`);
    return projectId;
  }
  throw new HttpError(422, `invalid secret scope "${scope}": use "team" or "project"`);
}

/** 该 scope 下已有的条数（team 级数 project_id IS NULL 的那些）。 */
async function countInScope(db: Db, teamId: string, projectId: string | null): Promise<number> {
  const row = (await db
    .select({ c: count() })
    .from(secrets)
    .where(
      projectId === null
        ? and(eq(secrets.teamId, teamId), isNull(secrets.projectId))
        : and(eq(secrets.teamId, teamId), eq(secrets.projectId, projectId)),
    ))[0];
  return row?.c ?? 0;
}

function toSummary(row: typeof secrets.$inferSelect): SecretSummary {
  // 刻意不取 encValue / encNonce：读路径没有值可泄露。
  return {
    id: row.id,
    teamId: row.teamId,
    projectId: row.projectId,
    scope: row.projectId === null ? 'team' : 'project',
    name: row.name,
    description: row.description,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

/**
 * 列出该团队的 secret（team 级 + 各 project 级）。
 *
 * `projectId` 给了就只看那个项目；不给就全列。调用方先判过团队归属。
 */
export async function listSecrets(
  db: Db,
  teamId: string,
  projectId?: string | null,
): Promise<SecretSummary[]> {
  // `undefined` = 不筛 scope；`null` = 只要 team 级；给 id = 只要那个 project。
  // 这三态必须分开：'team 级'和'全部'在过滤结果上是不同的集合。
  const where =
    projectId === undefined
      ? eq(secrets.teamId, teamId)
      : projectId === null
        ? and(eq(secrets.teamId, teamId), isNull(secrets.projectId))
        : and(eq(secrets.teamId, teamId), eq(secrets.projectId, projectId));
  const rows = await db.select().from(secrets).where(where).orderBy(secrets.createdAt);
  return rows.map(toSummary);
}

/** 某 scope 下是否已有同名 secret（覆盖判定 + 冲突报错共用）。 */
async function findByName(
  db: Db,
  teamId: string,
  projectId: string | null,
  name: string,
): Promise<typeof secrets.$inferSelect | undefined> {
  return (await db
    .select()
    .from(secrets)
    .where(
      projectId === null
        ? and(eq(secrets.teamId, teamId), isNull(secrets.projectId), eq(secrets.name, name))
        : and(eq(secrets.teamId, teamId), eq(secrets.projectId, projectId), eq(secrets.name, name)),
    )
    .limit(1))[0];
}

/**
 * 设一个 secret（新建或显式覆盖）。
 *
 * 返回的是**摘要**，不是值 —— 调用方回给模型的东西里永远不含明文。
 */
export async function setSecret(db: Db, input: SetSecretInput): Promise<SecretSummary> {
  assertValidName(input.name);
  if (input.value.length === 0) {
    throw new HttpError(422, 'secret value must not be empty');
  }
  const scopedProjectId = await assertScope(db, input.teamId, input.scope, input.projectId);

  const existing = await findByName(db, input.teamId, scopedProjectId, input.name);
  if (existing && input.overwrite !== true) {
    throw new HttpError(
      409,
      `secret "${input.name}" already exists in this scope; pass overwrite: true to replace its value`,
    );
  }

  if (!existing) {
    // 限额只在新建时检查：覆盖不增加条数。
    const current = await countInScope(db, input.teamId, scopedProjectId);
    const limitCheck = quota.secrets(current);
    if (!limitCheck.ok) {
      throw new HttpError(422, limitCheck.message);
    }
  }

  // 值只在这里出现一次，且立刻密文化。
  // seal() 给 cipher / nonce / tag 三段，表里只有 enc_value / enc_nonce 两列：
  // tag 拼在 cipher 后面（`<cipher>.<tag>`），与 routes/providers.ts 的
  // sealForColumn 同一套形状，反解在 resolveSecretEnv。
  const sealed = seal(input.value);
  const stored = { value: `${sealed.cipher}.${sealed.tag}`, nonce: sealed.nonce };
  const ts = now();

  if (existing) {
    await db
      .update(secrets)
      .set({
        encValue: stored.value,
        encNonce: stored.nonce,
        description: input.description ?? existing.description,
      })
      .where(eq(secrets.id, existing.id));
    const row = (await db.select().from(secrets).where(eq(secrets.id, existing.id)).limit(1))[0];
    if (!row) throw new HttpError(500, 'secret overwrite did not persist');
    return toSummary(row);
  }

  const id = newId();
  await db.insert(secrets).values({
    id,
    teamId: input.teamId,
    projectId: scopedProjectId,
    scope: input.scope,
    name: input.name,
    description: input.description ?? null,
    encValue: stored.value,
    encNonce: stored.nonce,
    createdBy: input.createdBy,
    createdAt: ts,
  });
  const row = (await db.select().from(secrets).where(eq(secrets.id, id)).limit(1))[0];
  if (!row) throw new HttpError(500, 'secret insert did not persist');
  return toSummary(row);
}

/**
 * 删 secret。
 *
 * `scope` + `name` 都必填（文档：「Each scope holds up to 50 secrets」，
 * 删除也是按 scope+name 定位）。返回删掉的 id 列表：不存在就报 404 ——
 * 「删一个不存在的 secret」必须显式失败，否则调用方永远不知道自己没删掉。
 */
export async function deleteSecrets(
  db: Db,
  teamId: string,
  scope: string,
  projectId: string | null | undefined,
  names: readonly string[],
): Promise<string[]> {
  if (names.length === 0) {
    throw new HttpError(422, 'delete_secrets requires at least one name');
  }
  const targetProject = await assertScope(db, teamId, scope, projectId);

  // 先全查、再全删（all-or-nothing）：文档说「at once, with no confirmation step」，
  // 逐个删一半再报 404 会让调用方面对「哪些被删了」的糊涂账，重试还会二次删。
  const targets: Array<typeof secrets.$inferSelect> = [];
  const missing: string[] = [];
  for (const name of names) {
    const row = await findByName(db, teamId, targetProject, name);
    if (!row) {
      missing.push(name);
      continue;
    }
    targets.push(row);
  }
  if (missing.length > 0) {
    throw new HttpError(404, `secret not found in this scope: ${missing.join(', ')}`);
  }
  for (const row of targets) {
    await db.delete(secrets).where(eq(secrets.id, row.id));
  }
  return targets.map((r) => r.id);
}

/**
 * 注入用：取该 agent 在某项目下**真的该拿到的**明文值。
 *
 * 规则来自 recon/docs/secrets.md：
 *   - team 级对该团队的每个项目可见
 *   - project 级只在该项目内可见
 *   - **同名时 project 级覆盖 team 级**（这就是「一个项目指向自己的 DATABASE_URL，
 *     其余项目共用默认值」的实现方式）
 *
 * 密文的存储形状沿用 `routes/providers.ts` 的 `sealForColumn`：表里只有
 * `enc_value` / `enc_nonce` 两列，所以 GCM 的 tag 以 `<cipher>.<tag>` 拼在
 * cipher 后面，反解时按 `lastIndexOf('.')` 切开 —— 不为了多一段认证标签改表结构。
 *
 * 这个函数**只给机器协议与 daemon 用**，永远不进 REST / MCP 的回包。
 */
export async function resolveSecretEnv(
  db: Db,
  teamId: string,
  projectId: string | null,
): Promise<Array<{ name: string; value: string }>> {
  const rows = await db
    .select({
      name: secrets.name,
      projectId: secrets.projectId,
      encValue: secrets.encValue,
      encNonce: secrets.encNonce,
    })
    .from(secrets)
    .where(eq(secrets.teamId, teamId));

  // project 级优先：先铺 team 级，再用该项目的行覆盖同名项。
  const winner = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (row.projectId === null) winner.set(row.name, row);
  }
  for (const row of rows) {
    if (row.projectId !== null && row.projectId === projectId) winner.set(row.name, row);
  }

  return [...winner.values()].map((row) => {
    const dot = row.encValue.lastIndexOf('.');
    const value = open({
      cipher: row.encValue.slice(0, dot),
      tag: row.encValue.slice(dot + 1),
      nonce: row.encNonce,
    });
    return { name: row.name, value };
  });
}
