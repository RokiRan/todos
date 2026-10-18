import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { createDb, type Db } from '@tds/db';
import { registerMachineRoutes } from './routes/machine.js';
import { registerTodoRoutes } from './routes/todos.js';
import { registerChiefRoutes } from './routes/chief.js';
import { registerProviderRoutes } from './routes/providers.js';
import { registerSkillRoutes } from './routes/skills.js';
import { registerScheduleRoutes } from './routes/schedules.js';
import { registerMcpRoutes } from './routes/mcp.js';
import { registerUserRoutes } from './routes/user.js';
import { registerUserContextRoutes } from './routes/user-context.js';
import { registerApiKeyRoutes } from './routes/api-keys.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerAgentAdminRoutes } from './routes/agents.js';
import { registerAgentMemoryRoutes } from './routes/agent-memory.js';
import { registerResourceRoutes } from './routes/resources.js';
import { registerChecklistRoutes } from './routes/checklist.js';
import { registerMachineAdminRoutes } from './routes/machines.js';
import { registerNeedsYouRoutes } from './routes/needs-you.js';
import { registerBuildMessageRoutes } from './routes/build-messages.js';
import { registerConnectionCatalogRoutes } from './routes/connection-catalog.js';
import { registerSseRoutes } from './sse.js';
import { installErrorHandlers } from './http.js';
import { authenticateRequest } from './auth.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** 对外可达的自身地址，注册响应回给机器用 */
    machineUrl: string;
  }
}

const PORT = Number(process.env.PORT ?? 4000);

/** `HOST` 是否只指向本机。`0.0.0.0` / `::` / 局域网 IP 都算「暴露出去」。 */
function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}
const HOST = process.env.HOST ?? '127.0.0.1';

export interface BuiltServer {
  app: ReturnType<typeof Fastify>;
  db: Db;
}

export function buildServer(): BuiltServer {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport: process.env.NODE_ENV === 'production' ? undefined : undefined,
    },
    // SSE 长连接不能被默认超时掐断
    requestTimeout: 0,
    keepAliveTimeout: 75_000,
  });

  const db = createDb();

  app.decorate('machineUrl', `http://${HOST}:${PORT}`);

  // ─── CORS 白名单 ────────────────────────────────────────────────────────
  // 之前 `origin: true` 是反射任意 Origin + credentials，等于让任意网页以
  // 当前用户身份读写（curl -H "Origin: https://evil.example.com" 验证：
  // server 回 `access-control-allow-origin: https://evil.example.com` +
  // `access-control-allow-credentials: true`）。这是局域网单人部署也必须关掉
  // 的：用户从手机/另一台电脑访问的同时也可能随手打开任意网页。
  //
  // 三档语义（最终由下面的 `corsOrigin` 闭包决定）：
  //   1) HOST 是回环地址且未配 TDS_CORS_ORIGIN → 保持宽松（origin: true）。
  //      `next dev` 跑在 3000、server 跑在 4000，浏览器视作不同源 —— 开发态
  //      必须能通，否则用户一开 dev server 就页面空白。
  //   2) HOST 是非回环地址且未配 TDS_CORS_ORIGIN → **失败关闭**（拒绝所有跨源
  //      请求，origin: false），并在首次命中时往 stderr 打一条提示。这是默认
  //      行为 —— 单人局域网部署不显式允许就拒绝，比"反射任意 Origin"安全得多。
  //   3) 配了 TDS_CORS_ORIGIN → 用精确字符串匹配回显命中的 origin。
  //
  // 白名单格式：`TDS_CORS_ORIGIN=http://10.0.0.226:3000,http://127.0.0.1:3000`
  //   - 逗号分隔；每条是 `scheme://host[:port]`（**精确 origin**，不要带尾部斜杠）
  //   - **不做** includes / 正则 / 通配；逐项严格相等
  //   - 空条目忽略；每条会 trim
  //   - 本机实际可用地址（2026-10-18 实测）：
  //       以太网     10.0.0.226
  //       ZeroTier  172.30.48.214 / 10.147.18.61 / 192.168.196.61
  //     例：`TDS_CORS_ORIGIN=http://10.0.0.226:3000,http://127.0.0.1:3000`
  //
  // 无 Origin 头的请求**不**走白名单：CORS 不适用（curl、同源 fetch、EventSource
  // 都不会带 Origin），由 `@fastify/cors` 走默认路径放行。如果把它们误以为是
  // origin 去比对白名单，行为没坏，但代码读起来像 bug，专门在这里说明。
  const allowedOrigins = process.env.TDS_CORS_ORIGIN?.trim() ?? '';
  const whitelist = allowedOrigins.length > 0
    ? allowedOrigins.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    : [];
  const hasWhitelist = whitelist.length > 0;
  const loopback = isLoopbackHost(HOST);

  // 用 stderr 而不是 app.log：cors 的 origin 函数可能在 listen 之前就被
  // 第一次请求触到，那时 app.log 也许工作、也许没初始化；写 stderr 最稳。
  let corsWarned = false;
  // `@fastify/cors` v10 的 `origin` 回调签名藏在内部的 `fastifyCors`
  // 命名空间里（`OriginFunction = (origin: string | undefined, callback: OriginCallback) => void`），
  // 没有顶层 export。
  //
  // 早先试过 `Parameters<typeof cors>[0]` 反推 —— 但 `cors` 在 ESM 下是
  // **重载函数**，`Parameters` 只取最后一个重载（FastifyInstance 装饰器形态），
  // 拿到的是 `FastifyInstance` 而不是 options，typecheck 直接报
  // `Property 'origin' does not exist on type 'FastifyInstance'`。
  // 手写这两个小类型更直白，也与插件真实运行时签名一致。
  type CorsCallback = (err: Error | null, allow: string | true | false) => void;
  type CorsOriginFn = (origin: string | undefined, cb: CorsCallback) => void;
  const corsOrigin: CorsOriginFn = (origin, reply) => {
    // 无 Origin 头 → CORS 不适用，放行（与 cors 文档对 origin=undefined 的
    // 默认语义一致）。这是 curl、同源 fetch、SSE 都会走到的路径。
    if (origin === undefined) {
      reply(null, true);
      return;
    }
    if (hasWhitelist) {
      reply(null, whitelist.includes(origin) ? origin : false);
      return;
    }
    if (loopback) {
      // 开发态：next dev @ :3000 ↔ server @ :4000 是不同源，必须宽松。
      reply(null, true);
      return;
    }
    reply(null, false);
    if (!corsWarned) {
      corsWarned = true;
      process.stderr.write(
        `[tds] CORS is rejecting cross-origin requests on http://${HOST}:${PORT} ` +
        `(refused first one from ${origin}). Set TDS_CORS_ORIGIN to a ` +
        `comma-separated allowlist (e.g. ` +
        `"http://10.0.0.226:3000,http://127.0.0.1:3000") to grant access.\n`,
      );
    }
  };

  app.register(cors, {
    origin: corsOrigin,
    credentials: true,
  });

  // ─── 限流（单人局域网部署加固 · 第 2 项）──────────────────────────────────
  // 目标不是防 DDoS —— 局域网没有公网；目的是：
  //   1) 挡住脚本扫端点 / 暴力猜 token；
  //   2) 挡住 model 额度被 agent 死循环打爆（`/api/mcp` 里 31 个工具、18 个
  //      写操作，被高频调用是常态但不是死锁）。
  //
  // 三档策略：
  //
  //   端点                       限制             理由
  //   ──────────────────────────────────────────────────────────────────
  //   默认全局（兜底）           600 req/min/IP   正常浏览（看板 + SSE +
  //                                                编辑 + 健康检查）远超
  //                                                不到，但足以挡住脚本
  //                                                扫端点。
  //   /api/mcp                   120 req/min/IP   31 个工具里 18 个写操
  //                                                作；agent 高频调用是
  //                                                正常的，但给足余量同
  //                                                时挡住死循环 / 误调
  //                                                模型额度打爆。
  //   /api/health                不限            探活，监控/负载均衡
  //                                                可能会高频打。
  //   /api/machine/*             不限            daemon 心跳（每几秒一
  //                                                次）、recover（每 30
  //                                                秒）正常就有很高频率，
  //                                                限流会打断 daemon。
  //
  // 关闭开关（任一为真即完全跳过注册）：
  //   - `TDS_RATE_LIMIT_DISABLED=1`（手动开关）
  //   - `NODE_ENV === 'test'`      （自动化测试）
  //
  // 选 `NODE_ENV=test` 的依据：本仓库测试 99% 走 `buildTestApp()`（自己
  // `new Fastify()`，不注册限流），只有 `error-handling.test.ts` 走
  // `buildServer()`。`package.json` 的 test 脚本已改为 `NODE_ENV=test tsx
  // --test`，所以那个唯一走 `buildServer()` 的套件也会被跳过。
  //
  // 关于登录端点（`POST /api/auth/login`）：那是 **Next.js BFF**（位于
  // `apps/web/src/app/api/auth/login/route.ts`），不在本 Fastify 服务里。
  // 该端点的限流应在 Next.js 侧单独处理 —— 不在本任务范围。
  //
  // `allowList`：插件数组形态只接受精确 IP，不接 URL 前缀。所以必须用函
  // 数形态按 `request.url` 自定义豁免。
  const rateLimitDisabled =
    process.env.TDS_RATE_LIMIT_DISABLED === '1' || process.env.NODE_ENV === 'test';
  if (!rateLimitDisabled) {
    app.register(rateLimit, {
      global: true,
      // 默认全局 600 req/min/IP；正常浏览不会超，但足以挡脚本。
      // 429 是限流不是服务故障，客户端应退避（默认响应会带
      // `retry-after` / `x-ratelimit-reset` 等头 —— 默认行为保留即可）。
      max: 600,
      timeWindow: '1 minute',
      // 豁免：探活 + 机器协议端点。**不是** IP 白名单，是路径白名单。
      allowList: (request /*, key */) => {
        const url = request.url ?? '';
        // `/api/machine/...`：daemon 心跳/轮询，正常就有很高频率。
        if (url.startsWith('/api/machine/')) return true;
        // `/api/health`：探活端点。
        if (url === '/api/health') return true;
        return false;
      },
      keyGenerator: (request) => request.ip,
    });

    // `/api/mcp` 单独打更严的限制 —— 在 `global: true` 注册的 onRequest
    // hook **之后** 再挂一个 onRequest hook：global 先按 600/min 放行（通
    // 常能过），再被这里的 120/min 卡住；两次限制走不同的 store 计数器
    // （`createRateLimit` 内部走 `store.child(...)` 派生独立 LRU），
    // 有效阈值 = min(600, 120) = 120。
    //
    // 为什么用 `createRateLimit` 而不是 `app.rateLimit(...)`：
    // `app.rateLimit(...)` 返回的是路由 hook handler，**检查 `req[rateLimitRan]`**
    // 防止同一请求被多个 rate-limit 处理器重复计数；而 global handler 已
    // 经标了 `rateLimitRan=true`，再加一个 `app.rateLimit(...)` hook 会
    // 直接被它跳过。`createRateLimit` 返回的函数不经过那层包装，直接调
    // `applyRateLimit`，可以独立计数。
    //
    // 不去改 `./routes/mcp.js` 走 `config.rateLimit` 覆写 —— 任务限定只
    // 改 `main.ts` 与 `package.json`，而且那条路由的覆写是覆盖语义不是
    // 叠加语义，与"既走全局又走更严"的诉求不符。挂一个额外 hook 是唯一
    // 不改路由文件就能实现的写法。
    //
    // ⚠️ **必须放在 `app.after()` 里**：`createRateLimit` 是 rate-limit 插件
    // **注册时才挂上去的装饰器**。`app.register()` 是异步的，在同步代码块里
    // 紧跟其后调用会拿到 `TypeError: app.createRateLimit is not a function`
    // —— 这个错误**启动时才会暴露**，typecheck 完全看不见（`buildServer`
    // 返回的是已注册的 app 类型，装饰器声明在插件的模块增强里）。
    app.after(() => {
      const mcpCheck = app.createRateLimit({
        max: 120,
        timeWindow: '1 minute',
        // ⚠️ keyGenerator **必须带前缀**。
        //
        // `createRateLimit` 在 v10 里通过 `store.child()` 派生独立存储，但
        // **默认不隔离 key 命名空间** —— 它与全局限制器读到的是同一个计数
        // key。若这里直接返回 `request.ip`，两条限制器共享同一把计数器，
        // 而 `max` 取了更小的 120，于是**第一发就判超限**（实测：重启
        // server 后 `/api/mcp` 立刻 429，而普通 REST 端点正常返 401）。
        // 加前缀让两把计数器彻底分开：全局量 `ip`，mcp 量 `mcp:<ip>`。
        // 有效阈值 = min(600, 120) = 120，但只有在全局那把也通过后才生效。
        keyGenerator: (request) => `mcp:${request.ip}`,
      });
    app.addHook('onRequest', async (req, reply) => {
      if (!req.url.startsWith('/api/mcp')) return;
      // ⚠️ **判据是 `isExceeded`，不是 `isAllowed`**。
      //
      // 读 `@fastify/rate-limit` v10.3.0 的 `applyRateLimit`：它只在
      // **命中 allowList** 时返回 `isAllowed: true`；正常计数但未超限时返回的
      // 仍是 `{ isAllowed: false, ..., isExceeded: false }`。
      // 所以拿 `isAllowed === false` 当「超限」会把**每一次请求**都判成 429
      // （实测：重启 server 后 `/api/mcp` 第一发就 429，而普通 REST 端点
      // 正常返 401 —— 因为它们走的是全局 handler，不是这条 hook）。
      //
      // 类型上，插件把返回值声明成判别联合，`isAllowed: true` 那一支
      // （allowList 命中）没有 `isExceeded` / `ttlInSeconds` / `max`。
      // 本 hook 前面已经 `return` 掉了非 `/api/mcp` 请求，而全局 allowList
      // 只放行 `/api/health` 与 `/api/machine/*` —— **`/api/mcp` 永远不会命中
      // allowList**，所以运行时字段必然齐全。用局部窄化把这个不变量告诉编译器。
      const status = await mcpCheck(req);
      if (!status.isAllowed && status.isExceeded) {
        // `createRateLimit` 不写响应 / 不抛错（与 `app.rateLimit` 行为
        // 不同），需要手动返 429。把标准错误体放进 reply 即可，框架会
        // 当作正常 reply 处理。
        reply
          .code(429)
          .header('retry-after', status.ttlInSeconds)
          .header('x-ratelimit-limit', status.max)
          .header('x-ratelimit-remaining', 0)
          .header('x-ratelimit-reset', status.ttlInSeconds)
          .send({
            statusCode: 429,
            error: 'Too Many Requests',
            message: `Rate limit exceeded, retry in ${status.ttlInSeconds}s`,
          });
      }
      });
    });
  }

  // REST 鉴权（T9 落地）：除 `/api/health`、`/api/mcp`（自己按 key 鉴权）与
  // `/api/machine/*`（机器凭据，另一套体系）之外，所有 `/api/*` 都必须带凭据。
  // 身份挂在 `req.ctx`，各路由再按团队归属判 403 —— 不再信 body 里的 teamId / userId。
  app.addHook('preHandler', async (req) => {
    if (req.url === '/api/health') return;
    if (req.url.startsWith('/api/machine/')) return;
    if (req.url.startsWith('/api/mcp')) return;
    if (!req.url.startsWith('/api/')) return;
    req.ctx = await authenticateRequest(db, req);
  });

  app.get('/api/health', async () => ({
    ok: true,
    ts: Date.now(),
    protocol: 'machine-v1',
  }));

  registerMachineRoutes(app, db);
  registerTodoRoutes(app, db);
  registerChiefRoutes(app, db);
  registerProviderRoutes(app, db);
  registerSkillRoutes(app, db);
  registerScheduleRoutes(app, db);
  registerUserRoutes(app, db);
  registerUserContextRoutes(app, db);
  registerApiKeyRoutes(app, db);
  registerProjectRoutes(app, db);
  registerAgentAdminRoutes(app, db);
  registerAgentMemoryRoutes(app, db);
  registerResourceRoutes(app, db);
  registerChecklistRoutes(app, db);
  registerMcpRoutes(app, db);
  registerMachineAdminRoutes(app, db);
  registerNeedsYouRoutes(app, db);
  registerBuildMessageRoutes(app, db);
  registerConnectionCatalogRoutes(app, db);
  registerSseRoutes(app, db);

  // 必须在所有路由注册之后设置：Fastify 的 setErrorHandler 会作用在
  // 调用时刻已存在的路由上，写在 registerXxxRoutes 之前不会生效。
  installErrorHandlers(app);

  return { app, db };
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('main.ts');
if (isMain) {
  const { app } = buildServer();
  if (!isLoopbackHost(HOST) && !process.env.TDS_WEB_TOKEN?.trim()) {
    // 鉴权已经强制（上面的全局 preHandler）。这里只剩一条配置提醒：web token
    // 没配时只有 Bearer API key 能过 —— 复刻的 Web 端（httpOnly `tds_token` cookie
    // 经 BFF 转发）会全部 401，绑非回环地址时该提醒尤其重要。
    app.log.warn(
      `REST auth is enforced on ${HOST}:${PORT}, but TDS_WEB_TOKEN is not set: only ` +
      `'Authorization: Bearer tds_...' credentials pass. The web client (httpOnly ` +
      `tds_token cookie via the BFF) will get 401 until you set TDS_WEB_TOKEN ` +
      `(and optionally TDS_WEB_USER to pin which user it maps to).`,
    );
  }
  if (!isLoopbackHost(HOST) && !process.env.TDS_WEB_USER?.trim()) {
    // 单人局域网部署加固：非回环地址意味着服务会从局域网被访问到，「取库里
    // 最早的用户」是危险默认 —— 跑过测试或临时建过用户之后，web 端会突然变成
    // 别人的身份，排查极难看，错误信息与下方 auth.ts resolveWebUser 一致。
    // 宁可起不来，也不要静默用错身份（"我以为在用我的数据，其实在用测试用户
    // 的数据"）。回环地址（127.0.0.1 / localhost / ::1）依然放过，不打断开发
    // 流程。
    app.log.error(
      `TDS_WEB_USER is not set while binding to non-loopback ${HOST}:${PORT}: ` +
      `auth.ts resolveWebUser would fall back to the OLDEST user in the database ` +
      `and silently pick up test fixtures after pnpm test. Set TDS_WEB_USER to ` +
      `your user EMAIL (not user id) before starting the server.`,
    );
    process.exit(1);
  }
  app
    .listen({ port: PORT, host: HOST })
    .then(() => app.log.info(`tds server listening on http://${HOST}:${PORT}`))
    .catch((err: unknown) => {
      app.log.error(err);
      process.exit(1);
    });

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      void app.close().then(() => process.exit(0));
    });
  }
}
