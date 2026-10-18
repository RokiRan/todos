/**
 * MCP Connection（对外连接的 MCP server）的**唯一真源**。
 *
 * 与 `services/secrets.ts` 同构：纯服务层，抛 `HttpError`；授权（团队归属 + admin）
 * 由调用方先判。
 *
 * ── 三条不可动摇的规则 ──
 *   1. **凭据写阅**。`enc_config`（headers / env）只以密文落库，`ConnectionSummary`
 *      里没有值字段；编辑时按文档语义回「键名 + 空值」，让调用方只覆盖填了的键。
 *      来源：recon/docs/mcp-servers.md「Headers and env vars are write-only, like
 *      secrets. They are encrypted at rest and never returned by any read route.」
 *   2. **identifier 建立后不可改**。它是 agent 侧工具名的前缀
 *      `mcp__<identifier>__<tool>`，改了等于所有工具改名。文档：为了改 type /
 *      identifier 必须删了重建。所以本服务层**没有**改 identifier 的入口。
 *   3. **删除是 soft-delete 且立即生效**。文档：「Delete MCP Servers … a delete
 *      takes effect at once, with no confirmation step」（MCP 侧无确认卡；
 *      Chief 侧有确认卡，那是 chief/tools.ts 的 `irreversible` 标记管的）。
 *
 * ── 与原站的差异（如实记录）──
 *   原站 catalog 连接（Linear / Notion / …）走浏览器 OAuth 一次性登录，本复刻**没有**
 *   那个流程；`kind: 'catalog'` 的行只能由客户端通过 MCP 自己带上加密 config 建出来。
 *   也就是说 `add_mcp_server` 在这里只真正覆盖了 `kind: 'custom'` 那条路。
 */
import { and, count, eq, isNull } from 'drizzle-orm';
import { quota } from '@tds/protocol';
import type { Db } from '@tds/db';
import { connections } from '@tds/db';
import { open, seal } from '../crypto.js';
import { HttpError } from '../http.js';
import { newId, now } from '../ids.js';

/** 读接口能看到的全部字段 —— 没有 `encConfig` / `encNonce`。 */
export interface ConnectionSummary {
  id: string;
  teamId: string;
  kind: string;
  identifier: string;
  transport: string;
  label: string;
  endpoint: string | null;
  /** 已存凭据的**键名**（不含值）。编辑时按这个回显。 */
  configKeys: string[];
  expiresAt: number | null;
  createdBy: string;
  createdAt: number;
}

export interface AddConnectionInput {
  teamId: string;
  kind?: string;
  /** 小写 slug，团队内唯一；工具名前缀就是它 */
  identifier: string;
  transport: string;
  label: string;
  endpoint?: string | null;
  /**
   * 凭据（headers / env）。键值对；值只进密文，永不回显。
   * 文档：「Values are decrypted only when a machine claims the step」。
   */
  config?: Record<string, string> | null;
  expiresAt?: number | null;
  createdBy: string;
}

export interface UpdateConnectionInput {
  teamId: string;
  connectionId: string;
  label?: string;
  /** 只覆盖这里出现的键；没出现的保持原值（文档：「Untouched keys survive a save」） */
  config?: Record<string, string> | null;
  expiresAt?: number | null;
}

const IDENTIFIER_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** 与 `secrets.ts` 同款的密文列形状：`<cipher>.<tag>` + nonce 两列。 */
function sealConfig(config: Record<string, string>): { value: string; nonce: string } {
  const s = seal(JSON.stringify(config));
  return { value: `${s.cipher}.${s.tag}`, nonce: s.nonce };
}

/**
 * 解出整组凭据。只在服务层内部用（合并旧键、列键名）。
 * 解不开（KEK 换了 / 数据损坏）时回 `{}` 而不是抛 —— 密文修不回来是运维问题，
 * 不该让「看看有哪些连接」或「改个标签名」也整条失败。
 */
function readConfig(stored: string | null, nonce: string | null): Record<string, string> {
  if (!stored || !nonce) return {};
  const dot = stored.lastIndexOf('.');
  try {
    return JSON.parse(open({ cipher: stored.slice(0, dot), tag: stored.slice(dot + 1), nonce })) as Record<string, string>;
  } catch {
    return {};
  }
}

/** 编辑回显用的**键名**（不含值）。 */
function configKeyNames(stored: string | null, nonce: string | null): string[] {
  return Object.keys(readConfig(stored, nonce)).sort();
}

function assertValidIdentifier(identifier: string): void {
  if (!IDENTIFIER_RE.test(identifier)) {
    throw new HttpError(
      422,
      `invalid identifier "${identifier}": use lowercase letters, digits, '-' and '_'`,
    );
  }
}

function assertValidTransport(transport: string): void {
  if (transport !== 'http' && transport !== 'stdio') {
    throw new HttpError(422, `invalid transport "${transport}": use "http" or "stdio"`);
  }
}

async function findByIdentifier(
  db: Db,
  teamId: string,
  identifier: string,
): Promise<typeof connections.$inferSelect | undefined> {
  return (await db
    .select()
    .from(connections)
    .where(and(eq(connections.teamId, teamId), eq(connections.identifier, identifier)))
    .limit(1))[0];
}

function toSummary(row: typeof connections.$inferSelect): ConnectionSummary {
  return {
    id: row.id,
    teamId: row.teamId,
    kind: row.kind,
    identifier: row.identifier,
    transport: row.transport,
    label: row.label,
    endpoint: row.endpoint,
    configKeys: configKeyNames(row.encConfig, row.encNonce),
    expiresAt: row.expiresAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

/** 列出该团队仍有效的连接（过滤 soft-delete）。 */
export async function listConnections(db: Db, teamId: string): Promise<ConnectionSummary[]> {
  const rows = await db
    .select()
    .from(connections)
    .where(and(eq(connections.teamId, teamId), isNull(connections.deletedAt)))
    .orderBy(connections.createdAt);
  return rows.map(toSummary);
}

async function countActive(db: Db, teamId: string): Promise<number> {
  const row = (await db
    .select({ c: count() })
    .from(connections)
    .where(and(eq(connections.teamId, teamId), isNull(connections.deletedAt))))[0];
  return row?.c ?? 0;
}

/** 加一个连接。identifier 重复 → 409（团队内唯一，工具名前缀不能撞）。 */
export async function addConnection(db: Db, input: AddConnectionInput): Promise<ConnectionSummary> {
  assertValidIdentifier(input.identifier);
  assertValidTransport(input.transport);
  if (!input.label) {
    throw new HttpError(422, 'label must not be empty');
  }
  if (input.transport === 'http' && !input.endpoint) {
    throw new HttpError(422, 'http transport requires an endpoint URL');
  }

  const existing = await findByIdentifier(db, input.teamId, input.identifier);
  if (existing) {
    throw new HttpError(
      409,
      `identifier "${input.identifier}" is already used by connection "${existing.label}"`,
    );
  }

  const current = await countActive(db, input.teamId);
  const limitCheck = quota.connections(current);
  if (!limitCheck.ok) {
    throw new HttpError(422, limitCheck.message);
  }

  const id = newId();
  const config = input.config ?? {};
  const sealed = Object.keys(config).length > 0 ? sealConfig(config) : null;

  await db.insert(connections).values({
    id,
    teamId: input.teamId,
    kind: input.kind ?? 'custom',
    identifier: input.identifier,
    transport: input.transport,
    label: input.label,
    endpoint: input.endpoint ?? null,
    encConfig: sealed?.value ?? null,
    encNonce: sealed?.nonce ?? null,
    expiresAt: input.expiresAt ?? null,
    createdBy: input.createdBy,
    createdAt: now(),
    deletedAt: null,
  });

  const row = (await db.select().from(connections).where(eq(connections.id, id)).limit(1))[0];
  if (!row) throw new HttpError(500, 'connection insert did not persist');
  return toSummary(row);
}

/**
 * 改一个连接。**identifier / kind / transport / endpoint 都不可改**：
 * 它们是工具名与连法的一部分（文档：「The type and identifier are fixed once
 * saved」），要改就删了重建。没传的字段保持原值。
 */
export async function updateConnection(
  db: Db,
  input: UpdateConnectionInput,
): Promise<ConnectionSummary> {
  const current = (await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.id, input.connectionId),
        eq(connections.teamId, input.teamId),
        isNull(connections.deletedAt),
      ),
    )
    .limit(1))[0];
  if (!current) throw new HttpError(404, `connection "${input.connectionId}" not found`);

  const patch: Partial<typeof connections.$inferInsert> = {};
  if (input.label !== undefined) {
    if (!input.label) throw new HttpError(422, 'label must not be empty');
    patch.label = input.label;
  }
  if (input.expiresAt !== undefined) patch.expiresAt = input.expiresAt;
  if (input.config !== undefined && input.config !== null && Object.keys(input.config).length > 0) {
    // 文档：编辑时「Type a new value to overwrite that key, leave it blank to keep
    // what is stored. Untouched keys survive a save」—— 所以这里是**按键合并**，
    // 不是整组替换。
    const merged = { ...readConfig(current.encConfig, current.encNonce), ...input.config };
    const sealed = sealConfig(merged);
    patch.encConfig = sealed.value;
    patch.encNonce = sealed.nonce;
  }

  await db.update(connections).set(patch).where(eq(connections.id, input.connectionId));
  const row = (await db.select().from(connections).where(eq(connections.id, input.connectionId)).limit(1))[0];
  if (!row) throw new HttpError(404, `connection "${input.connectionId}" not found`);
  return toSummary(row);
}

/** 删连接（soft-delete，立即生效）。不存在或已删 → 404。 */
export async function deleteConnections(
  db: Db,
  teamId: string,
  identifiers: readonly string[],
): Promise<string[]> {
  if (identifiers.length === 0) {
    throw new HttpError(422, 'delete_mcp_servers requires at least one identifier');
  }
  const deleted: string[] = [];
  const missing: string[] = [];
  for (const identifier of identifiers) {
    const row = (await db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.teamId, teamId),
          eq(connections.identifier, identifier),
          isNull(connections.deletedAt),
        ),
      )
      .limit(1))[0];
    if (!row) {
      missing.push(identifier);
      continue;
    }
    await db.update(connections).set({ deletedAt: now() }).where(eq(connections.id, row.id));
    deleted.push(row.identifier);
  }
  if (missing.length > 0) {
    throw new HttpError(404, `connection not found: ${missing.join(', ')}`);
  }
  return deleted;
}
