/**
 * API key 的**唯一真源**。
 *
 * 语义来自 recon/docs/api-keys.md，逐条对应：
 *   1. **key 属于人，不属于团队** —— 所以这里的鉴权维度是 `user_id`，**不是**
 *      `team_id`。这是它与 `services/schedules.ts` / `services/secrets.ts`
 *      最大的差别：那三个按团队判，这个按人判。搞混的后果是 A 能列出 B 的 key。
 *   2. **明文只显示一次** —— `createApiKey` 的返回值里带 `key`，之后**任何**
 *      读接口都不再返回明文（库里只有 HMAC-SHA256 的 `key_hash`）。
 *   3. **scope 默认全关** —— 文档「MCP access … and Git access … both off by
 *      default」。所以不传 `scopes` 就是空数组，而空数组的 MCP key 打 `/api/mcp`
 *      会得到 HTTP 403（见 `routes/mcp.ts` 的 no-MCP-access 分支）。这条是刻意的：
 *      新建的 key 不该自动获得任何能力。
 *   4. **revoke 立即失效，但已入网机器继续跑** —— 文档「Machines already
 *      enrolled with that key keep running: enrollment exchanges the key for the
 *      machine's own credential」。所以 revoke 只写 `revoked_at`，**不动 machine
 *      行**；要下线机器得走 Resources → Machines。
 *
 * 机器凭据也在同一张表（`name` 以 `machine:` 开头，见 `routes/machine.ts`），
 * 所以列表**必须**把那些过滤掉 —— 否则 Settings 会显示一串用户看不见的机器 key，
 * 而 revoke 它们会误以为「下线了机器」。
 */
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '@tds/db';
import { apiKeys } from '@tds/db';
import { generateApiKey } from '../crypto.js';
import { HttpError } from '../http.js';
import { newId, now } from '../ids.js';

/** 与 `routes/machine.ts` 的 `MACHINE_KEY_PREFIX` 同款约定 —— 两边必须一致。 */
const MACHINE_KEY_PREFIX = 'machine:';

/** 读接口能看到的字段 —— 注意没有 `keyHash`，更没有明文。 */
export interface ApiKeySummary {
  id: string;
  name: string;
  /** 前缀（如 `tds_abc123`），用来在 UI 里辨认是哪一把 */
  keyPrefix: string;
  scopes: string[];
  revokedAt: number | null;
  lastUsedAt: number | null;
  createdAt: number;
}

/** 建 key 的入参。`scopes` 不传 = 空数组 = 一项能力都没有（文档：默认全关）。 */
export interface CreateApiKeyInput {
  name: string;
  scopes?: string[];
}

/** 创建结果 —— **唯一**一次带明文的地方。调用方必须原样交给用户，不能存。 */
export interface CreatedApiKey {
  summary: ApiKeySummary;
  /** `tds_…` 明文。存的是 HMAC-SHA256，这里过了就再也取不回来。 */
  key: string;
}

/**
 * 列出该用户的 key（不含机器凭据）。
 *
 * 已 revoke 的**仍然列出** —— Settings 要让用户看到「这把已经撤销了」，
 * 否则撤销后行会凭空消失，用户以为删掉了。`revokedAt !== null` 就是那个状态。
 */
export async function listApiKeys(db: Db, userId: string): Promise<ApiKeySummary[]> {
  const rows = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId))
    .orderBy(desc(apiKeys.createdAt));
  return rows
    // 机器凭据不是用户的 key：既不该出现在列表里，也不该被 Settings 撤销
    .filter((r) => !r.name.startsWith(MACHINE_KEY_PREFIX))
    .map(toSummary);
}

function toSummary(row: typeof apiKeys.$inferSelect): ApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    scopes: [...row.scopes],
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  };
}

/**
 * 建一把 key。返回明文 —— **仅此一次**。
 *
 * 名字去重：同一用户下同名会让人分不清哪把是哪把，直接 409。
 */
export async function createApiKey(db: Db, userId: string, input: CreateApiKeyInput): Promise<CreatedApiKey> {
  if (!input.name.trim()) {
    throw new HttpError(422, 'key name must not be empty');
  }
  const existing = (await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), eq(apiKeys.name, input.name)))
    .limit(1))[0];
  if (existing) {
    throw new HttpError(409, `you already have a key named "${input.name}"`);
  }

  // scopes 不去重成 Set —— 顺序即用户在 UI 里的勾选顺序，回显要一致
  const scopes = input.scopes ?? [];
  const generated = generateApiKey();
  const id = newId();
  const ts = now();

  await db.insert(apiKeys).values({
    id,
    userId,
    name: input.name,
    keyPrefix: generated.prefix,
    keyHash: generated.hash,
    scopes,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: ts,
  });

  return {
    key: generated.key,
    summary: {
      id,
      name: input.name,
      keyPrefix: generated.prefix,
      scopes,
      revokedAt: null,
      lastUsedAt: null,
      createdAt: ts,
    },
  };
}

/**
 * 就地改 scopes（文档：「you can also expand any existing key row later to
 * toggle its scopes in place」）。
 *
 * 已 revoke 的 key 不许改 —— 否则调用方会以为「复活了」，而文档的语义是
 * revoke 不可逆（要恢复就新建一把）。
 */
export async function updateApiKeyScopes(
  db: Db,
  userId: string,
  keyId: string,
  scopes: readonly string[],
): Promise<ApiKeySummary> {
  const row = (await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId)))
    .limit(1))[0];
  // 归属按 user_id 判：别人的 key 一律 404（不泄露它是否存在）
  if (!row) throw new HttpError(404, `key "${keyId}" not found`);
  if (row.name.startsWith(MACHINE_KEY_PREFIX)) {
    throw new HttpError(404, `key "${keyId}" not found`);
  }
  if (row.revokedAt !== null) {
    throw new HttpError(409, `key "${row.name}" is revoked; create a new one instead`);
  }

  await db.update(apiKeys).set({ scopes: [...scopes] }).where(eq(apiKeys.id, keyId));
  return { ...toSummary(row), scopes: [...scopes] };
}

/**
 * 撤销一把 key（soft-delete：`revoked_at` 打时间戳，行还在）。
 *
 * **不动 machine 行** —— 文档：已入网机器继续跑，要下线得走 Machines 页。
 * 机器凭据也不许从这里撤销（否则等于用 Settings 页面下线了机器）。
 * 重复撤销是幂等的：返回同一个 key 而不是报错，UI 连点两次不该红。
 */
export async function revokeApiKey(db: Db, userId: string, keyId: string): Promise<ApiKeySummary> {
  const row = (await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId)))
    .limit(1))[0];
  if (!row || row.name.startsWith(MACHINE_KEY_PREFIX)) {
    throw new HttpError(404, `key "${keyId}" not found`);
  }
  if (row.revokedAt === null) {
    await db.update(apiKeys).set({ revokedAt: now() }).where(eq(apiKeys.id, keyId));
  }
  // 回**库里那个**时间戳，不是新的 now() —— 重复撤销时数据库没变，回包也必须不变。
  // 否则回包与库不一致：调用方拿到的 revokedAt 会和下次读到的对不上。
  const stored = (await db
    .select({ revokedAt: apiKeys.revokedAt })
    .from(apiKeys)
    .where(eq(apiKeys.id, keyId))
    .limit(1))[0]?.revokedAt;
  return { ...toSummary(row), revokedAt: stored ?? row.revokedAt ?? now() };
}

/** 鉴权成功时打一下 `last_used_at`（best-effort，失败不能影响请求）。 */
export async function touchApiKey(db: Db, keyId: string): Promise<void> {
  try {
    await db.update(apiKeys).set({ lastUsedAt: now() }).where(eq(apiKeys.id, keyId));
  } catch {
    // 只写一个统计字段，失败就失败 —— 绝不能因为它把正常请求变成 500
  }
}
