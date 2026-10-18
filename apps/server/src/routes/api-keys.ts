/**
 * Settings → API keys 的 REST 端点。
 *
 * 对标 recon/docs/api-keys.md 的四条语义（业务规则全在 `services/api-keys.ts`，
 * 这里只做参数解析与身份判定）：
 *   - key 属于人，不属于团队 → **鉴权维度是 `userId`，不是 `teamId`**
 *   - 明文只在创建响应里出现一次
 *   - scope 默认全关
 *   - revoke 立即失效，但已入网机器继续跑
 *
 * 身份来源：`resolveContext`（`src/auth.ts`）—— Bearer `tds_…` key 或
 * `TDS_WEB_TOKEN` 都归一成「这是哪个用户」。**不复用** `actorForTeam`：
 * 那一整套是按团队判的，key 不属于任何团队。
 *
 * 自我提权要挡住：用 Bearer key 调这些端点时，那把 key 的所有者就是要操作的人，
 * 所以「改 scopes」只能改自己名下的 key（`services` 里按 `user_id` 查），
 * 不接受任何 `userId` 入参。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '@tds/db';
import { HttpError } from '../http.js';
import { resolveContext } from '../auth.js';
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  updateApiKeyScopes,
} from '../services/api-keys.js';

const CreateBody = z.object({
  name: z.string().min(1).max(120),
  /** 不传 = 空数组 = 什么能力都没有（文档：both off by default） */
  scopes: z.array(z.string().min(1)).optional(),
});

const ScopesBody = z.object({
  scopes: z.array(z.string().min(1)),
});

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new HttpError(422, parsed.error.issues.map((i) => i.message).join('; '));
  }
  return parsed.data;
}

export function registerApiKeyRoutes(app: FastifyInstance, db: Db): void {
  /** 列出我的 key（不含机器凭据，已撤销的也列出）。 */
  app.get('/api/user/api-keys', async (req) => {
    const ctx = await resolveContext(db, req);
    return { apiKeys: await listApiKeys(db, ctx.userId) };
  });

  /** 建一把 key —— **响应里带明文，仅此一次**。 */
  app.post('/api/user/api-keys', async (req, reply) => {
    const ctx = await resolveContext(db, req);
    const body = parseBody(CreateBody, req.body);
    const created = await createApiKey(db, ctx.userId, { name: body.name, scopes: body.scopes });
    // 201：确实新建了资源。`Cache-Control: no-store` 是必需的 —— 响应里有明文，
    // 任何中间缓存都不该留存它。
    return reply
      .code(201)
      .header('cache-control', 'no-store')
      .send({ apiKey: created.summary, key: created.key });
  });

  /** 就地改 scopes（文档：可以展开任意一行就地勾选）。 */
  app.patch('/api/user/api-keys/:keyId', async (req) => {
    const ctx = await resolveContext(db, req);
    const { keyId } = req.params as { keyId: string };
    const body = parseBody(ScopesBody, req.body);
    return { apiKey: await updateApiKeyScopes(db, ctx.userId, keyId, body.scopes) };
  });

  /**
   * 撤销一把 key。soft-delete，幂等。
   *
   * 路由名用 POST 而不是 DELETE：文档里这是一个「点删除图标 + 确认」的**动作**，
   * 且原站没有「硬删除」这个概念（撤销不可逆，行还在库里）。POST /revoke
   * 把这两层含义分开，将来真要加硬删除不会撞语义。
   */
  app.post('/api/user/api-keys/:keyId/revoke', async (req) => {
    const ctx = await resolveContext(db, req);
    const { keyId } = req.params as { keyId: string };
    return { apiKey: await revokeApiKey(db, ctx.userId, keyId) };
  });
}
