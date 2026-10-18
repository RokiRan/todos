/**
 * Bearer API key 鉴权 —— MCP 入站端点与 user 级 REST **共用这一份**。
 *
 * 为什么单独一个文件：`routes/mcp.ts` 里那份 `authenticateBearer` 是全站唯一真正的
 * 鉴权实现，`GET /api/user/mcp-tools`（Settings → API keys 的勾选目录）要用同一个，
 * 复制一份迟早漂移（一边改了 revoke 判断、另一边没改）。T9 的落地方案也是把 REST
 * 路由逐步接到这一层，而不是各路由自己信 `body.teamId`。
 *
 * 拒绝分两层，与 recon/docs/mcp.md 的 Errors 表逐条对得上：
 *   - transport 层（headers 缺失 / 无 `tds_` 前缀 / hash 不命中 / key 已 revoke）
 *     → HTTP 401，对应「Header is not Authorization: Bearer tds_...」「the key was revoked」
 *   - MCP access 层（key 有效但没勾任何工具）→ HTTP 403，对应
 *     「403, no MCP access — The key has no MCP tools selected」
 *     （recon 里没有空 scope key 打 `/api/mcp` 的抓包，所以按官方文档实现）
 * 「这个 key 没被授某个工具」不属于这两层 —— 那是应用层结果，回 200 + JSON-RPC
 * error -32002，不能让客户端把整条连接判坏。
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '@tds/db';
import { apiKeys, members, users } from '@tds/db';
import { getKek, hashApiKey } from './crypto.js';
import { HttpError } from './http.js';

/** 登录后查到的 api_key 行（仅必要字段） */
export interface ApiKeyContext {
  readonly userId: string;
  readonly email: string;
  readonly scopes: readonly string[];
}

/** REST 侧的请求上下文：两种凭据都归一成「这是哪个用户」。 */
export interface RequestContext {
  readonly userId: string;
  readonly email: string;
  readonly scopes: readonly string[];
  /** `key` = Bearer API key；`web-token` = `TDS_WEB_TOKEN`（cookie / `?token=`） */
  readonly via: 'key' | 'web-token';
}

export async function authenticateBearer(
  db: Db,
  req: { headers: { authorization?: string } },
): Promise<ApiKeyContext> {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    throw new HttpError(401, 'missing or malformed Authorization header');
  }
  const raw = auth.slice('Bearer '.length).trim();
  if (!raw.startsWith('tds_')) {
    throw new HttpError(401, 'API key must start with tds_');
  }
  const hash = hashApiKey(raw, getKek());
  const rows = await db
    .select({
      userId: apiKeys.userId,
      scopes: apiKeys.scopes,
      revokedAt: apiKeys.revokedAt,
      email: users.email,
    })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.userId))
    .where(and(eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt)))
    .limit(1);
  const k = rows[0];
  if (!k) {
    throw new HttpError(401, 'API key not found or revoked');
  }
  return { userId: k.userId, email: k.email, scopes: k.scopes ?? [] };
}

declare module 'fastify' {
  interface FastifyRequest {
    /** 由 `main.ts` 的全局 preHandler 挂上；`/api/machine/*`、`/api/mcp` 不走它 */
    ctx?: RequestContext;
  }
}

/** 取 web token：`?token=` 或 httpOnly cookie `tds_token`（浏览器 EventSource 不能
 *  带 header，所以 SSE 那侧必须支持 query；这里两边共用同一条读法）。 */
function readWebToken(req: { headers: { cookie?: string }; query?: unknown }): string | null {
  const fromQuery = (req.query as { token?: string } | undefined)?.token;
  if (fromQuery) return fromQuery;
  const cookie = req.headers.cookie ?? '';
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'tds_token') return decodeURIComponent(rest.join('='));
  }
  return null;
}

/** web token 对应的用户：`TDS_WEB_USER`（email）精确匹配。
 *  复刻的 Web 端是单人模型（recon §1 的 `auth/session` 我们只做了单人 token），
 *  所以「token → 用户」这一步必须有个确定的映射，不能像以前那样只比字符串相等
 *  就当身份不存在 —— 那会让每个路由自己信 `body.userId`。
 *
 *  历史上这里有「没配 `TDS_WEB_USER` → 取库里最早创建的用户」回退；本机跑过测试
 *  后那个最早用户往往是测试 fixture（实测 4844 条 todo 散落其中），web 端登录后
 *  会静默落到一个测试用户上，行为完全不可预测。改成：
 *
 *  - `NODE_ENV === 'test'` 时保留原回退（959 个既有测试靠这条跑通，不能动）。
 *  - 其它环境未配 `TDS_WEB_USER` → 直接 500 抛错，错误信息提示填的是 email
 *    （不是 user id —— 实测踩过这个坑）并列出库里最多 3 个候选 email。
 *  - 已配但 email 命中不到任何用户 → 401，同样提示填的是 email 并附候选。
 */
async function resolveWebUser(db: Db): Promise<{ id: string; email: string }> {
  const want = process.env.TDS_WEB_USER?.trim();

  // 取最多 3 个 email 作为错误信息里的候选 —— 用户库可能有几百个，全列无意义。
  // 同一份 db 连接（drizzle handle），不新建连接。
  const candidateRows = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .orderBy(users.createdAt)
    .limit(3);
  const candidates = candidateRows.map((r) => r.email);
  const candidateList = candidates.length ? candidates.join(', ') : '(empty database)';

  if (!want) {
    // 测试环境豁免：保留原「取库里最早的用户」回退。959 个既有测试（覆盖率 959/959
    // 实测通过）依赖这条；改动会让它们全挂。注释里写清豁免边界 —— 单人局域网部署
    // **不会**走这条分支，会在 main.ts 启动前置检查时被 process.exit(1) 挡掉。
    if (process.env.NODE_ENV === 'test') {
      // 解构成局部变量：`candidateRows[0]` 在本仓库开了
      // `noUncheckedIndexedAccess`，数组下标取值的类型是 `T | undefined`。
      // 上面 `if (!candidateRows.length)` 已经保证了它存在，但 TS 不做
      // 跨语句的控制流推断，所以这里显式取值再判一次 —— 比 `!` 非空断言
      // 更诚实（断言会把「万一判断写错了」变成静默的 undefined.id）。
      const oldest = candidateRows[0];
      if (!oldest) {
        throw new HttpError(401, 'web token is set but the database has no user to map it to');
      }
      return { id: oldest.id, email: oldest.email };
    }
    throw new HttpError(500,
      `TDS_WEB_USER is not set: web token cannot be mapped to a user. ` +
      `Set TDS_WEB_USER to a user EMAIL (not user id). ` +
      `First ${candidates.length} candidate email(s) in the database: ${candidateList}.`,
    );
  }

  const rows = await db.select({ id: users.id, email: users.email }).from(users)
    .where(eq(users.email, want)).limit(1);
  const u = rows[0];
  if (!u) {
    throw new HttpError(401,
      `TDS_WEB_USER "${want}" does not match any user. ` +
      `TDS_WEB_USER must be a user EMAIL (not user id). ` +
      `First ${candidates.length} candidate email(s) in the database: ${candidateList}.`,
    );
  }
  return u;
}

/**
 * REST 层的统一鉴权入口。`Authorization: Bearer tds_...` 与 web token 两种都收：
 * 外部 MCP/CLI 客户端用 key，复刻的 Web 端用 httpOnly cookie（BFF 转发）。身份判定
 * 只有一份，路由不再自己信 `body.userId` / `body.teamId`。
 *
 * 拒绝语义与 `recon/docs/mcp.md` 一致：凭据不对 → **401**；凭据对但那个 team 不是
 * 他的 → **403**（由 `requireTeamMembership` 抛）。
 */
export async function authenticateRequest(
  db: Db,
  req: { headers: { authorization?: string; cookie?: string }; query?: unknown },
): Promise<RequestContext> {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    return { ...(await authenticateBearer(db, req)), via: 'key' };
  }
  const expected = process.env.TDS_WEB_TOKEN?.trim();
  if (!expected) {
    throw new HttpError(401,
      'missing credentials: send `Authorization: Bearer tds_...` or the web token cookie');
  }
  const token = readWebToken(req);
  if (token !== expected) {
    throw new HttpError(401, 'invalid or missing web token');
  }
  const user = await resolveWebUser(db);
  return { userId: user.id, email: user.email, scopes: [], via: 'web-token' };
}

/** 该用户是否属于这个 team。不属于 → 403（措辞与 MCP 的 `assertTeamIn` 一致）。 */
export async function requireTeamMembership(
  db: Db,
  userId: string,
  teamId: string,
): Promise<void> {
  const rows = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.actorId, userId), eq(members.memberType, 'user'), eq(members.teamId, teamId)))
    .limit(1);
  if (!rows[0]) {
    throw new HttpError(403, `team "${teamId}" is not accessible to this key's owner`);
  }
}

/** 该用户的全部 team（`GET /api/todos` 不给 teamId 时用来收窄成「他的团队」）。 */
export async function teamIdsForUser(db: Db, userId: string): Promise<string[]> {
  const rows = await db
    .select({ teamId: members.teamId })
    .from(members)
    .where(and(eq(members.actorId, userId), eq(members.memberType, 'user')));
  return rows.map((r) => r.teamId);
}

/**
 * 路由侧取身份的统一入口：`main.ts` 的全局 preHandler 已经验过一次时直接用
 * `req.ctx`（一次请求只查一次 key）；测试里的 `buildTestApp` 不走 `main.ts`，
 * 所以这里回退去现验 —— 这样**鉴权判定跟谁注册路由无关**，每个路由文件都能独立
 * 测「无凭据 → 401」「A 团队的 key 打 B 团队的资源 → 403 且库里没写」。
 */
export async function resolveContext(
  db: Db,
  req: { ctx?: RequestContext; headers: { authorization?: string; cookie?: string }; query?: unknown },
): Promise<RequestContext> {
  return req.ctx ?? (await authenticateRequest(db, req));
}

/**
 * 团队 admin 闸门（2026-10-17 收敛）。
 *
 * 原来 `providers.ts:100` / `skills.ts:153` / `schedules.ts:242` 各写了一份逐字
 * 相同的副本（`schedules.ts` 的注释还明说「不引入跨模块依赖，自己写一份」）。
 * 鉴权落地时三处都得改 —— 正是漂移的温床，所以并成这一份。`action` 决定措辞
 * （'changing providers' / 'changing skills' / 'managing schedule rules'），
 * 既有 403 文案逐字保留，测试断言不用改。
 */
export async function requireTeamAdmin(
  db: Db,
  userId: string,
  teamId: string,
  action: string,
): Promise<void> {
  const rows = await db
    .select({ id: members.id })
    .from(members)
    .where(
      and(
        eq(members.teamId, teamId),
        eq(members.actorId, userId),
        eq(members.memberType, 'user'),
        eq(members.role, 'admin'),
      ),
    )
    .limit(1);
  if (rows.length === 0) {
    throw new HttpError(403, `${action} requires team admin`);
  }
}

/**
 * 路由侧的 actor 判定（REST 鉴权落地的统一入口）：
 *   1. `resolveContext` —— 凭据 → 用户（401）
 *   2. 客户端显式传的 `userId`（query 或 body）必须等于 key 所有者，否则 403。
 *      以前这些端点判的是「这个 userId 在不在团队里 / 是不是 admin」，而 userId 是
 *      客户端随便填的 —— A 团队的 key 传 `userId=B` 就能以 B 的身份、甚至借用 B 的
 *      admin 角色去写。这里把它钉死成 key 所有者。
 *   3. 归属判定：给了 `action` 判 admin（写路径），否则判成员（读路径）。
 * 不传 `userId` 时用 `ctx.userId`。
 */
export async function actorForTeam(
  db: Db,
  req: {
    ctx?: RequestContext;
    headers: { authorization?: string; cookie?: string };
    query?: unknown;
    body?: unknown;
  },
  teamId: string,
  opts?: { action?: string },
): Promise<string> {
  const ctx = await resolveContext(db, req);
  const claimed =
    (req.query as { userId?: string } | undefined)?.userId ??
    (req.body as { userId?: string } | undefined)?.userId;
  if (claimed !== undefined && claimed !== ctx.userId) {
    throw new HttpError(403, `userId "${claimed}" is not this key's owner`);
  }
  if (opts?.action) {
    await requireTeamAdmin(db, ctx.userId, teamId, opts.action);
  } else {
    await requireTeamMembership(db, ctx.userId, teamId);
  }
  return claimed ?? ctx.userId;
}
