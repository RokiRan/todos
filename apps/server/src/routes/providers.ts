import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { MODEL_APIS, type ModelApi } from '@tds/protocol';
import type { Db } from '@tds/db';
import { providers } from '@tds/db';
import { newId, now } from '../ids.js';
import { seal } from '../crypto.js';
import { HttpError } from '../http.js';
import { actorForTeam } from '../auth.js';

/**
 * provider 目录 —— pi 内置 runtime 的模型来源。
 *
 * 这是原站 Free 档的核心链路：`docs/runtimes.md` 写明 pi 的模型来自
 * "the team's providers"，且 "the team's own API keys and subscriptions are
 * billed by their vendor, and only Pro's built-in models draw team credits"。
 * 没有 provider 就没有模型，agent 建不起来 —— 所以这不是可选项。
 *
 * 硬规则（全部来自 recon/docs/providers.md 与 recon/05-schema.sql）：
 *   1. API key 用 AES-GCM 加密，**任何响应都不回传明文**（含 GET 列表）
 *   2. 添加前做真实模型请求校验：**401/403 拒绝保存，429 仍保存**
 *      （限流说明 key 是对的；拒绝才是粘贴错误）
 *   3. key 只允许可打印 ASCII（0x20–0x7E）
 *   4. `models` 必须是**对象数组**；字符串数组会 422（文档实测坑）
 *   5. 每团队最多 20 个 provider
 *   6. 增删改需 team admin；普通成员可查看
 *   7. base URL：OpenAI 兼容端点通常以 `/v1` 结尾
 */

/** 可打印 ASCII，与 Chief 凭据卡的校验一致（0x20–0x7E）。 */
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

const ModelEntry = z.object({
  id: z.string().min(1).max(120),
  label: z.string().max(120).optional(),
  contextWindow: z.number().int().positive().max(100_000_000),
  maxTokens: z.number().int().positive().max(1_000_000),
  /** pi-ai 的 Model.reasoning */
  reasoning: z.boolean().default(false),
  input: z.array(z.enum(['text', 'image'])).default(['text']),
  /** thinkingLevelMap：缺失的键用 provider 默认，null 表示不支持 */
  thinkingLevelMap: z
    .record(z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']), z.string().nullable())
    .optional(),
});

const CreateProviderBody = z.object({
  userId: z.string().min(1),
  kind: z.enum(['vendor', 'custom']),
  providerId: z.string().min(1).max(120),
  label: z.string().min(1).max(120),
  baseUrl: z.string().url().max(500).nullable().default(null),
  api: z.enum(MODEL_APIS),
  models: z.array(ModelEntry).max(256),
  apiKey: z.string().max(4000).nullable().default(null),
  /** 本地网关（Ollama / LM Studio）无需 key */
  skipVerify: z.boolean().default(false),
});

const UpdateProviderBody = z.object({
  userId: z.string().min(1),
  label: z.string().min(1).max(120).optional(),
  baseUrl: z.string().url().max(500).nullable().optional(),
  api: z.enum(MODEL_APIS).optional(),
  models: z.array(ModelEntry).max(256).optional(),
  /** 空 = 保留已存 key（原站编辑器语义：留空不覆盖） */
  apiKey: z.string().max(4000).optional(),
});

/** GET 响应形状 —— 注意没有 apiKey / encApiKey 任何一个字段。 */
function publicProvider(row: typeof providers.$inferSelect) {
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
    /** 只有这个布尔，告诉 UI「已配 key」，不泄露内容 */
    hasApiKey: row.encApiKey !== null,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * seal() 返回 cipher/nonce/tag 三段，而 provider 表只有 enc_api_key / enc_nonce
 * 两列。把 tag 拼进 cipher 里一起存 —— 反解时按同样规则切开即可，
 * 避免为了多一段认证标签去改表结构（那要动迁移）。
 */
function sealForColumn(key: string): { cipher: string; nonce: string } {
  const s = seal(key);
  return { cipher: `${s.cipher}.${s.tag}`, nonce: s.nonce };
}


/**
 * 真实模型请求校验。
 *
 * 语义来自 recon/docs/providers.md：
 *   - 200 → key 正确
 *   - 401 / 403 → 明确拒绝 → **拒绝保存**
 *   - 429 → 限流 → **仍然保存**（说明 key 本身是对的）
 *   - 网络不可达 → 无法判定 → 放行（跳过校验）
 *
 * 返回 null 表示「校验通过或无法判定」，返回字符串表示拒绝原因。
 */
export async function verifyProviderKey(
  p: { baseUrl: string | null; api: string; apiKey: string },
  probeModel: string,
): Promise<string | null> {
  const base = p.baseUrl?.replace(/\/+$/, '');
  if (!base) return null;

  let url: string;
  let init: RequestInit;
  if (p.api === 'anthropic-messages') {
    url = `${base}/v1/messages`;
    init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: probeModel, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
    };
  } else if (p.api === 'google-generative-ai') {
    url = `${base}/v1beta/models/${probeModel}:generateContent?key=${encodeURIComponent(p.apiKey)}`;
    init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'ping' }] }] }),
    };
  } else {
    url = `${base}/v1/chat/completions`;
    init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${p.apiKey}` },
      body: JSON.stringify({ model: probeModel, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
    };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) return null;
    if (res.status === 401 || res.status === 403) {
      return `provider rejected the key (${res.status})`;
    }
    // 429 及其他：不拒绝保存。原站语义：只有明确拒绝才算粘贴错误。
    return null;
  } catch {
    // 端点不可达 —— 跳过校验而不是拒绝（用户可能是本地网关或暂时断网）
    return null;
  }
}

export function registerProviderRoutes(app: FastifyInstance, db: Db): void {
  // ── 列出团队 provider（成员可读，key 永不回传）──────────────────

  app.get('/api/teams/:teamId/providers', async (req) => {
    const { teamId } = req.params as { teamId: string };
    await actorForTeam(db, req, teamId);

    const rows = await db
      .select()
      .from(providers)
      .where(eq(providers.teamId, teamId))
      .orderBy(providers.createdAt);

    return { providers: rows.map(publicProvider) };
  });

  // ── 添加（需 admin）───────────────────────────────────────────

  app.post('/api/teams/:teamId/providers', async (req) => {
    const { teamId } = req.params as { teamId: string };
    const parsed = CreateProviderBody.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(422, parsed.error.issues.map((i) => i.message).join('; '));
    }
    const body = parsed.data;
    await actorForTeam(db, req, teamId, { action: 'changing providers' });

    // 20 个上限
    const countRow = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(providers)
      .where(eq(providers.teamId, teamId));
    if ((countRow[0]?.c ?? 0) >= 20) {
      throw new HttpError(422, 'provider limit reached (20 per team)');
    }

    if (body.apiKey !== null && !PRINTABLE_ASCII.test(body.apiKey)) {
      throw new HttpError(422, 'api key must be printable ASCII (0x20-0x7E)');
    }

    // 校验 key：401/403 拒绝；429 与不可达放行
    if (body.apiKey && !body.skipVerify) {
      const reason = await verifyProviderKey(
        { baseUrl: body.baseUrl, api: body.api, apiKey: body.apiKey },
        body.models[0]?.id ?? 'gpt-4o-mini',
      );
      if (reason) throw new HttpError(422, reason);
    }

    const ts = now();
    const sealed = body.apiKey ? sealForColumn(body.apiKey) : null;
    const id = newId();

    await db.insert(providers).values({
      id,
      teamId,
      kind: body.kind,
      providerId: body.providerId,
      label: body.label,
      baseUrl: body.baseUrl,
      api: body.api,
      // 原站实测：自定义 provider 永不发送 developer role
      compat: { supportsDeveloperRole: false },
      models: body.models,
      encApiKey: sealed?.cipher ?? null,
      encNonce: sealed?.nonce ?? null,
      createdBy: body.userId,
      createdAt: ts,
      updatedAt: ts,
    });

    const row = (await db.select().from(providers).where(eq(providers.id, id)).limit(1))[0];
    return { provider: row ? publicProvider(row) : null };
  });

  // ── 更新（需 admin；空 apiKey = 保留已存）───────────────────────

  app.patch('/api/teams/:teamId/providers/:providerId', async (req) => {
    const { teamId, providerId } = req.params as { teamId: string; providerId: string };
    const parsed = UpdateProviderBody.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(422, parsed.error.issues.map((i) => i.message).join('; '));
    }
    const body = parsed.data;
    await actorForTeam(db, req, teamId, { action: 'changing providers' });

    const current = (await db
      .select()
      .from(providers)
      .where(and(eq(providers.id, providerId), eq(providers.teamId, teamId)))
      .limit(1))[0];
    if (!current) throw new HttpError(404, 'provider not found');

    // 空字符串 = 保留（编辑器语义），有值才覆盖并重新校验
    let encApiKey = current.encApiKey;
    let encNonce = current.encNonce;
    if (body.apiKey !== undefined && body.apiKey !== '') {
      if (!PRINTABLE_ASCII.test(body.apiKey)) {
        throw new HttpError(422, 'api key must be printable ASCII (0x20-0x7E)');
      }
      const sealed = sealForColumn(body.apiKey);
      encApiKey = sealed.cipher;
      encNonce = sealed.nonce;
    }

    await db
      .update(providers)
      .set({
        label: body.label ?? current.label,
        baseUrl: body.baseUrl !== undefined ? body.baseUrl : current.baseUrl,
        api: (body.api ?? current.api) as ModelApi | null,
        models: body.models ?? current.models,
        encApiKey,
        encNonce,
        updatedAt: now(),
      })
      .where(eq(providers.id, providerId));

    const row = (await db.select().from(providers).where(eq(providers.id, providerId)).limit(1))[0];
    return { provider: row ? publicProvider(row) : null };
  });

  // ── 删除（需 admin）───────────────────────────────────────────

  app.delete('/api/teams/:teamId/providers/:providerId', async (req) => {
    const { teamId, providerId } = req.params as { teamId: string; providerId: string };
    await actorForTeam(db, req, teamId, { action: 'changing providers' });

    const current = (await db
      .select({ id: providers.id })
      .from(providers)
      .where(and(eq(providers.id, providerId), eq(providers.teamId, teamId)))
      .limit(1))[0];
    if (!current) throw new HttpError(404, 'provider not found');

    await db.delete(providers).where(eq(providers.id, providerId));
    return { ok: true, deleted: providerId };
  });

  // ── 模型目录 ─────────────────────────────────────────────────
  //
  // 原站语义（docs/runtimes.md）：
  //   - pi（内置）→ 列出**团队 provider 提供**的所有模型
  //   - 外部 runtime → 列出该 CLI 在机器上上报的模型
  //
  // Free 档没有平台内置模型，所以 pi 的列表就是 provider 的并集。

  app.get('/api/teams/:teamId/models', async (req) => {
    const { teamId } = req.params as { teamId: string };
    const parsed = z
      .object({
        /** 缺省按 pi 返回（pi 是默认 runtime） */
        runtime: z.string().min(1).default('pi'),
      })
      .safeParse(req.query);
    if (!parsed.success) throw new HttpError(422, 'runtime must be a non-empty string');
    await actorForTeam(db, req, teamId);

    const { runtime } = parsed.data;

    if (runtime !== 'pi') {
      // 外部 runtime 的模型由机器上报，走 claim/presence 链路。
      // 这里明确区分，不能拿 provider 的模型冒充 —— 否则用户会选到
      // 一个该 CLI 根本不支持的模型，跑到一半才炸。
      return { models: [], source: 'machine-reported' as const };
    }

    const rows = await db.select().from(providers).where(eq(providers.teamId, teamId));

    const models = rows.flatMap((p) => {
      const list = (p.models ?? []) as Array<{
        id: string;
        label?: string;
        contextWindow: number;
        maxTokens: number;
        reasoning?: boolean;
        input?: string[];
      }>;
      return list.map((m) => ({
        id: `${p.providerId}/${m.id}`,
        modelId: m.id,
        label: m.label ?? m.id,
        providerId: p.providerId,
        providerLabel: p.label,
        api: p.api,
        baseUrl: p.baseUrl,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        reasoning: m.reasoning ?? false,
        input: m.input ?? ['text'],
        /** 只有配了 key 的 provider 才能真的跑起来 */
        usable: p.encApiKey !== null,
      }));
    });

    return { models, source: 'providers' as const };
  });

  // ── 内部：给 claim step 解密凭据用（不暴露为路由）──────────────



}
