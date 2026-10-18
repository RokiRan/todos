/**
 * Provider 管理员写操作的**唯一真源**。
 *
 * 这是 Chief 工具面 `providers` / `add_provider` / `update_provider` /
 * `delete_providers` 的服务层 —— `apps/server/src/chief/executor.ts` 与未来的
 * REST 路由都从这里取。
 *
 * 与 `services/agents-admin.ts` / `services/connections.ts` 同构：纯服务层、
 * 不认 HTTP / 不认 JSON-RPC，抛 `HttpError`。授权（团队归属 + admin）由调用方
 * 先做 —— Chief 侧是 `requireTeamAccess` + `requireTeamAdminForTool`，REST 侧
 * 是 `actorForTeam`。这里只管 provider 本身的业务规则。
 *
 * ── 铁规 ──────────────────────────────────────────────────────
 *   1. **密文永不回显**。`ProviderSummary` 接口里**没有** `encApiKey` /
 *      `encNonce` 字段，类型层就把这两列藏掉。这是与 `routes/providers.ts`
 *      `publicProvider` 同款的硬约束 —— 区别是这里把约束下到了类型层，不靠
 *      runtime 过滤。
 *   2. **真实校验不算死**。key 用 `verifyProviderKey` 探活：401/403 拒绝保存，
 *      429 与网络不可达**仍保存**（原站语义：限流说明 key 本身是对的）。
 *      既有约定详见 `routes/providers.ts:113` 的注释。
 *   3. **`kind` 建立后不可改**。它是 catalog 行（订阅 / OAuth）与 custom
 *      端点的根本区别 —— 改了等于「Custom → OAuth」的反向转换，文档没有这条路。
 *      `updateProvider` **不接受** `kind` 字段。这是**推断**：`providers.md`
 *      没明确写「kind 不可改」，但 (a) 原站 REST 的 PATCH body 没有 `kind` 字段
 *      （`routes/providers.ts:58` 的 `UpdateProviderBody`），(b) 「ChatGPT/Codex
 *      订阅登录」与「API key」是两种完全独立的接入路径——推断结论是「建立后冻结」。
 *   4. **被 agent 引用的 provider 不能直接删**。删除前必须确保没有任何非软删
 *      agent 的 `provider` 字段等于这个 `providerId` —— 否则建出来的 agent
 *      会悬空、模型列表再也匹配不上。这是 `providers.md` 「Agents still
 *      pointing at them are flagged as unconfigured」的间接语义：硬删会立刻
 *      把 agent 推到 unconfigured 状态，违背「先告诉用户哪些算 delete」的
 *      Chief UX 承诺。
 *   5. **providerId 团队内唯一**。与 `routes/providers.ts` 的 catalog 主键
 *      语义一致；用户给的 providerId 直接进 `agents.provider` 字段做前缀匹配，
 *      重复会让模型列表解不出唯一归属。
 *
 * ── 与 `routes/providers.ts` 的复用关系 ──────────────────────
 *   - `verifyProviderKey` —— 从 `routes/providers.ts` **直接 import**，
 *     探活语义一行不变。
 *   - `seal()` from `crypto.ts` —— 仍走这条统一路径。
 *   - `<cipher>.<tag>` 拼接 —— 与 routes/providers.ts 的 `sealForColumn` 同款
 *     约定；这里复制了 1 行（`${s.cipher}.${s.tag}`），因为 routes 没有把
 *     `sealForColumn` 导出。这是**唯一**对 routes 的 1 行复读（不是抄第二份
 *     校验）。
 *   - 其它规则（API key 可打印 ASCII、provider 20 上限、kind 冻结）—— 这里是
 *     **新增**的服务层封装，routes 之前的逻辑散在 handler 里。
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { MODEL_APIS, type ModelApi } from '@tds/protocol';
import type { Db } from '@tds/db';
import { agents, auditEvents, providers } from '@tds/db';
import { seal } from '../crypto.js';
import { HttpError } from '../http.js';
import { newId, now } from '../ids.js';
import { requireTeamAdmin } from '../auth.js';
import { verifyProviderKey } from '../routes/providers.js';

// ── 上限常量 ────────────────────────────────────────────────

/**
 * 每团队 provider 上限 20 —— `providers.md` 「up to 20 providers per team」。
 * 与 `routes/providers.ts:194` 的 20 上限同源。
 */
const MAX_PROVIDERS_PER_TEAM = 20;

/** 可打印 ASCII 0x20–0x7E —— 与 Chief 凭据卡校验同款。 */
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

/** providerId / label 字符长度上限（实测原站风格 1..120） */
const SLUG_MAX_CHARS = 120;
/** baseUrl 上限（与 `routes/providers.ts` 的 `z.string().url().max(500)` 对齐） */
const BASE_URL_MAX_CHARS = 500;
/** API key 明文上限（与 `routes/providers.ts` 的 `z.string().max(4000)` 对齐） */
const API_KEY_MAX_CHARS = 4000;

// ── 公共类型 ────────────────────────────────────────────────

/**
 * 读接口 / 写接口的返回形状。**类型层就**没有 `encApiKey` / `encNonce` 字段 —
 * — 见铁规 #1。`hasApiKey` 布尔告诉 UI「这一行配过 key」，但不泄露密文。
 */
export interface ProviderSummary {
  id: string;
  teamId: string;
  kind: string;
  providerId: string;
  label: string;
  baseUrl: string | null;
  api: string | null;
  compat: Record<string, unknown>;
  models: unknown[];
  hasApiKey: boolean;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** 单个 provider 模型描述 —— 与 `routes/providers.ts:31` 的 `ModelEntry` 同构。 */
export interface ProviderModelEntry {
  id: string;
  label?: string;
  contextWindow: number;
  maxTokens: number;
  reasoning?: boolean;
  input?: Array<'text' | 'image'>;
  thinkingLevelMap?: Record<string, string | null> | undefined;
}

export interface AddProviderInput {
  teamId: string;
  /** 调用方 userId —— 仅做审计 actorId，不参与鉴权（鉴权由调用方走 admin 闸门）。 */
  actorId: string;
  /** 'vendor' = catalog 行（订阅 / API key）；'custom' = 自建 OpenAI 兼容端点 */
  kind: 'vendor' | 'custom';
  /** 团队内唯一的 slug —— 进 `agents.provider` 字段 */
  providerId: string;
  label: string;
  baseUrl?: string | null;
  /** 必须落在 `MODEL_APIS`（`packages/protocol/src/enums.ts`） */
  api: ModelApi;
  models?: ProviderModelEntry[];
  /** 明文 apiKey —— 仅在 seal 前短暂存在；不写日志、不落盘。 */
  apiKey?: string | null;
  /**
   * 本地网关（Ollama / LM Studio）等没有外网可达端点时跳过探活。
   * 与 `routes/providers.ts:55` 的 `skipVerify` 同款。
   */
  skipVerify?: boolean;
}

export interface UpdateProviderPatch {
  label?: string;
  /** 显式传 `null` = 清空（custom 端点切回纯 catalog 不需要 baseUrl 的场景） */
  baseUrl?: string | null;
  api?: ModelApi;
  models?: ProviderModelEntry[];
  /**
   * 显式传 `null` = 清空 key（罕用；常见是给 vendor 行换密钥，留空 = 保留）。
   * 不传 = 不动。**与 routes/providers.ts PATCH 略有差异**：routes 的契约是
   * 「传空字符串 = 保留」，但 Chief 工具面更自然的是「undefined vs 传值」；
   * 这里明确：undefined 不动，null 清空，其它字符串覆盖。
   */
  apiKey?: string | null;
}

export interface UpdateProviderInput {
  teamId: string;
  /** provider 表主键 —— 不是 providerId slug */
  providerId: string;
  actorId: string;
  patch: UpdateProviderPatch;
}

export interface DeleteProvidersInput {
  teamId: string;
  /** provider 表主键列表（不是 providerId slug） */
  providerIds: readonly string[];
  actorId: string;
}

export interface DeleteProviderResult {
  providerId: string;
  ok: boolean;
  /** ok=false 时才有 —— 同 Chief 批量工具的 `reason` 字段语义（`mcp.ts:913`） */
  reason?: string;
}

export interface DeleteProvidersOutput {
  results: DeleteProviderResult[];
  succeeded: number;
  failed: number;
}

// ── 内部工具函数 ────────────────────────────────────────────

/**
 * 把 `<cipher>.<tag>` 拼成单列存进去 —— 与 `routes/providers.ts:90` 的
 * `sealForColumn` 同款存储约定。这里复制 1 行是因为 routes 没把
 * `sealForColumn` 导出（封装边界）；任何反解都按同样规则切开即可。
 */
function sealForColumn(key: string): { cipher: string; nonce: string } {
  const s = seal(key);
  return { cipher: `${s.cipher}.${s.tag}`, nonce: s.nonce };
}

function toSummary(row: typeof providers.$inferSelect): ProviderSummary {
  return {
    id: row.id,
    teamId: row.teamId,
    kind: row.kind,
    providerId: row.providerId,
    label: row.label,
    baseUrl: row.baseUrl,
    api: row.api,
    compat: row.compat,
    models: row.models,
    hasApiKey: row.encApiKey !== null,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function assertValidProviderId(providerId: string): void {
  if (typeof providerId !== 'string' || providerId.trim().length === 0) {
    throw new HttpError(422, 'providerId must be a non-empty string');
  }
  if (providerId.length > SLUG_MAX_CHARS) {
    throw new HttpError(
      422,
      `providerId exceeds ${SLUG_MAX_CHARS} characters (got ${providerId.length})`,
    );
  }
}

function assertValidLabel(label: string): void {
  if (typeof label !== 'string' || label.trim().length === 0) {
    throw new HttpError(422, 'label must be a non-empty string');
  }
  if (label.length > SLUG_MAX_CHARS) {
    throw new HttpError(
      422,
      `label exceeds ${SLUG_MAX_CHARS} characters (got ${label.length})`,
    );
  }
}

/**
 * 静态查表 —— `MODEL_APIS` 的成员表。`Record<ModelApi, true>` 在编译时锁住
 * 键必须属于 ModelApi 联合；运行时按 string 查未知名走 `undefined !== true`
 * 即可，避免构造 Set。
 */
const MODEL_API_BY_KEY: Readonly<Record<string, true>> = Object.freeze(
  Object.fromEntries(MODEL_APIS.map((k) => [k, true])) as Record<ModelApi, true>,
);

function assertValidApi(api: string): asserts api is ModelApi {
  if (MODEL_API_BY_KEY[api] !== true) {
    throw new HttpError(
      422,
      `api must be one of ${MODEL_APIS.join(', ')} (got "${api}")`,
    );
  }
}

/**
 * 校验 baseUrl 形态 —— `https://` 协议；自建网关（Ollama / LM Studio）允许
 * `http://localhost` / `http://127.0.0.1`。这是 `providers.md` 「base URL:
 * OpenAI 兼容端点通常以 /v1 结尾」的间接语义：custom 端点可以是自建内网，
 * 不一定走 TLS。
 */
function assertValidBaseUrl(baseUrl: string | null | undefined): string | null {
  if (baseUrl === null || baseUrl === undefined) return null;
  if (typeof baseUrl !== 'string') {
    throw new HttpError(422, 'baseUrl must be a string or null');
  }
  if (baseUrl.length === 0) return null;
  if (baseUrl.length > BASE_URL_MAX_CHARS) {
    throw new HttpError(
      422,
      `baseUrl exceeds ${BASE_URL_MAX_CHARS} characters (got ${baseUrl.length})`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new HttpError(422, `baseUrl is not a valid URL: "${baseUrl}"`);
  }
  const host = parsed.hostname.toLowerCase();
  const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalhost)) {
    throw new HttpError(
      422,
      `baseUrl must be https:// (or http://localhost for local gateways), got "${parsed.protocol}//"`,
    );
  }
  return baseUrl;
}

function assertValidApiKey(apiKey: string | null | undefined): string | null {
  if (apiKey === null || apiKey === undefined) return null;
  if (typeof apiKey !== 'string') {
    throw new HttpError(422, 'apiKey must be a string or null');
  }
  if (apiKey.length === 0) return null;
  if (apiKey.length > API_KEY_MAX_CHARS) {
    throw new HttpError(
      422,
      `apiKey exceeds ${API_KEY_MAX_CHARS} characters (got ${apiKey.length})`,
    );
  }
  if (!PRINTABLE_ASCII.test(apiKey)) {
    throw new HttpError(422, 'api key must be printable ASCII (0x20-0x7E)');
  }
  return apiKey;
}

/** 写 audit_event —— `actorType: 'chief'` 因为 Chief 工具面发起的写。 */
async function writeAuditRow(
  db: Db,
  args: { teamId: string; actorId: string; type: string; payload: Record<string, unknown> },
): Promise<void> {
  await db.insert(auditEvents).values({
    teamId: args.teamId,
    actorType: 'chief',
    actorId: args.actorId,
    todoId: null,
    buildId: null,
    type: args.type,
    payload: args.payload,
    createdAt: now(),
  });
}

// ── 对外函数 ────────────────────────────────────────────────

/**
 * 列出该团队的 provider。返回类型**没有**密文字段 —— 见铁规 #1。
 * admin / member 都可读；调用方先判成员资格。
 */
export async function listProviders(db: Db, teamId: string): Promise<ProviderSummary[]> {
  const rows = await db
    .select()
    .from(providers)
    .where(eq(providers.teamId, teamId))
    .orderBy(providers.createdAt);
  return rows.map(toSummary);
}

/**
 * 加一个 provider。admin 闸门由调用方先走（REST 侧 `actorForTeam`、Chief 侧
 * `requireTeamAdminForTool`）—— 这里再调一次 `requireTeamAdmin` 兜底。
 */
export async function addProvider(db: Db, input: AddProviderInput): Promise<ProviderSummary> {
  await requireTeamAdmin(db, input.actorId, input.teamId, 'changing providers');

  assertValidProviderId(input.providerId);
  assertValidLabel(input.label);
  assertValidApi(input.api);
  const baseUrl = assertValidBaseUrl(input.baseUrl);
  const apiKey = assertValidApiKey(input.apiKey);

  // 团队内 providerId 唯一 —— 走主键列而不是 row.id，因为同名 providerId
  // 会让 `agents.provider` 失去唯一归属。
  const dup = (await db
    .select({ id: providers.id })
    .from(providers)
    .where(and(eq(providers.teamId, input.teamId), eq(providers.providerId, input.providerId)))
    .limit(1))[0];
  if (dup) {
    throw new HttpError(
      409,
      `providerId "${input.providerId}" is already used in this team`,
    );
  }

  // 20 个上限（providers.md "up to 20 providers per team"）
  const countRow = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(providers)
    .where(eq(providers.teamId, input.teamId));
  if ((countRow[0]?.c ?? 0) >= MAX_PROVIDERS_PER_TEAM) {
    throw new HttpError(422, `provider limit reached (${MAX_PROVIDERS_PER_TEAM} per team)`);
  }

  // 探活：复用 `routes/providers.ts` 的 `verifyProviderKey`。
  // 401/403 → 拒绝保存；429 与网络不可达 → 放行（既不阻塞「限流的真 key」
  // 也不阻塞「本地网关」。原站语义：providers.md "A rate-limited account
  // (429) still saves; only an explicitly rejected key (401/403) is refused"）
  if (apiKey && !input.skipVerify) {
    const probeModel = input.models?.[0]?.id ?? 'gpt-4o-mini';
    const reason = await verifyProviderKey(
      { baseUrl, api: input.api, apiKey },
      probeModel,
    );
    if (reason) throw new HttpError(422, reason);
  }

  const ts = now();
  const sealed = apiKey ? sealForColumn(apiKey) : null;
  const id = newId();

  await db.insert(providers).values({
    id,
    teamId: input.teamId,
    kind: input.kind,
    providerId: input.providerId,
    label: input.label,
    baseUrl,
    api: input.api,
    // 原站实测：自定义 provider 永不发送 developer role（与 routes 同源）
    compat: { supportsDeveloperRole: false },
    models: input.models ?? [],
    encApiKey: sealed?.cipher ?? null,
    encNonce: sealed?.nonce ?? null,
    createdBy: input.actorId,
    createdAt: ts,
    updatedAt: ts,
  });

  await writeAuditRow(db, {
    teamId: input.teamId,
    actorId: input.actorId,
    type: 'provider_added',
    payload: { providerId: input.providerId, kind: input.kind, label: input.label },
  });

  const row = (await db.select().from(providers).where(eq(providers.id, id)).limit(1))[0];
  if (!row) throw new HttpError(500, 'provider vanished after insert');
  return toSummary(row);
}

/**
 * 部分更新 provider。`kind` **不接受** —— 见铁规 #3。
 * 跨团队 / 不存在 → 404（与 `services/agents-admin.ts` 同款「不存在与无权给
 * 同一个答案」语义）。
 */
export async function updateProvider(
  db: Db,
  input: UpdateProviderInput,
): Promise<ProviderSummary> {
  await requireTeamAdmin(db, input.actorId, input.teamId, 'changing providers');

  const current = (await db
    .select()
    .from(providers)
    .where(and(eq(providers.id, input.providerId), eq(providers.teamId, input.teamId)))
    .limit(1))[0];
  if (!current) throw new HttpError(404, `provider "${input.providerId}" not found`);

  const set: Partial<typeof providers.$inferInsert> = { updatedAt: now() };

  if (input.patch.label !== undefined) {
    assertValidLabel(input.patch.label);
    set.label = input.patch.label;
  }
  if (input.patch.baseUrl !== undefined) {
    set.baseUrl = assertValidBaseUrl(input.patch.baseUrl);
  }
  if (input.patch.api !== undefined) {
    assertValidApi(input.patch.api);
    set.api = input.patch.api;
  }
  if (input.patch.models !== undefined) {
    set.models = input.patch.models;
  }

  // apiKey：null = 清空；非空字符串 = 覆盖；undefined = 不动（与 routes
  // PATCH 的「传空字符串 = 保留」略有差异 —— 见 UpdateProviderPatch 注释）。
  if (input.patch.apiKey !== undefined) {
    if (input.patch.apiKey === null) {
      set.encApiKey = null;
      set.encNonce = null;
    } else {
      const key = assertValidApiKey(input.patch.apiKey);
      if (key === null) {
        // 「传了空字符串」按「不动」处理 —— 与文档编辑器留空等效
      } else {
        const sealed = sealForColumn(key);
        set.encApiKey = sealed.cipher;
        set.encNonce = sealed.nonce;
      }
    }
  }

  // no-op：patch 里一个字段都没传（除 updatedAt）→ 不写库也不审计
  const meaningfulKeys = Object.keys(input.patch);
  if (meaningfulKeys.length === 0) {
    return toSummary(current);
  }

  await db.update(providers).set(set).where(eq(providers.id, input.providerId));

  await writeAuditRow(db, {
    teamId: input.teamId,
    actorId: input.actorId,
    type: 'provider_updated',
    payload: { providerId: input.providerId, changedKeys: meaningfulKeys },
  });

  const row = (await db
    .select()
    .from(providers)
    .where(eq(providers.id, input.providerId))
    .limit(1))[0];
  if (!row) throw new HttpError(404, `provider "${input.providerId}" not found`);
  return toSummary(row);
}

/**
 * 批量删除 provider —— 逐个尽力，与 `services/agents-admin.ts:deleteAgents`
 * 同款 `{results, succeeded, failed}` 形状。
 *
 * 拒绝规则（铁规 #4）：如果有任何非软删 agent 的 `provider` 字段等于这个
 * providerId 的 slug，该项返回 ok:false 带 reason，行**不被**删除（库里仍
 * 在）。这是 Chief UX 的「先告诉用户哪些算 delete」语义 —— 硬删会把 agent
 * 立刻推到 unconfigured 状态。
 *
 * 跨团队 / 不存在 → 该项 ok:false，不阻断同批其它项。
 *
 * 注：这里是 **hard-delete**（不是 soft-delete）—— 与 agents / connections
 * 不同。原因：
 *   - 硬删意味着「这个 provider 的所有 key 从团队里消失」，对用户是清晰动作
 *   - chief / build / step 等表没有引用 `providers.id`（只有 `agents.provider`
 *     文本引用 providerId slug —— 而我们正用这条引用做拒删闸门）
 *   - 没有审计回放需要保留 provider 行
 */
export async function deleteProviders(
  db: Db,
  input: DeleteProvidersInput,
): Promise<DeleteProvidersOutput> {
  await requireTeamAdmin(db, input.actorId, input.teamId, 'changing providers');

  const results: DeleteProviderResult[] = [];

  // 把要删的 id 一次性查出来，再去批量查 agent 引用。
  // 选 inArray 而不是 N 次单查：批量查的请求数固定，与输入规模无关。
  const wanted = [...new Set(input.providerIds)];
  if (wanted.length === 0) {
    return { results: [], succeeded: 0, failed: 0 };
  }

  const targets = await db
    .select({ id: providers.id, providerId: providers.providerId })
    .from(providers)
    .where(and(eq(providers.teamId, input.teamId), inArray(providers.id, wanted)));

  // 团队内查到的行：按 providerId slug 拿 agent 引用一次，避免 N 次单查
  const slugs = targets.map((t) => t.providerId);
  const referenced = new Set<string>();
  if (slugs.length > 0) {
    const refs = await db
      .select({ provider: agents.provider })
      .from(agents)
      .where(and(inArray(agents.provider, slugs), isNull(agents.deletedAt)));
    for (const r of refs) {
      if (r.provider !== null) referenced.add(r.provider);
    }
  }

  // 已知 id → row 索引：O(1) 判「跨团队 / 不存在」
  const byId = new Map(targets.map((t) => [t.id, t]));

  for (const id of input.providerIds) {
    const target = byId.get(id);
    if (!target) {
      // 跨团队 / 不存在 → 同一答案（铁规：「不存在与无权给同一个答案」）
      results.push({ providerId: id, ok: false, reason: '404: provider not found' });
      continue;
    }
    if (referenced.has(target.providerId)) {
      results.push({
        providerId: id,
        ok: false,
        reason: `provider "${target.providerId}" is still referenced by an agent; remove the agent first`,
      });
      continue;
    }

    await db.delete(providers).where(eq(providers.id, id));
    await writeAuditRow(db, {
      teamId: input.teamId,
      actorId: input.actorId,
      type: 'provider_deleted',
      payload: { providerId: target.providerId },
    });
    results.push({ providerId: id, ok: true });
  }

  const succeeded = results.filter((r) => r.ok).length;
  return { results, succeeded, failed: results.length - succeeded };
}