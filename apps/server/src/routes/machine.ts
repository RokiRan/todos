import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { API, ActionResultSchema, ClaimRequestSchema, DoneSchema, HeartbeatSchema, ChangesSchema, PresenceSchema, RecoverRequestSchema, ToolCallRequestSchema } from '@tds/protocol';
import type { MachineAction, RecoverResponse } from '@tds/protocol';
import type { Db } from '@tds/db';
import {
  agents,
  apiKeys,
  auditEvents,
  buildMessages,
  builds,
  documents,
  machines,
  machinePendingActions,
  projects,
  providers,
  steps,
  todos,
} from '@tds/db';
import { newId, now } from '../ids.js';
import { HttpError } from '../http.js';
import { getKek, generateApiKey, hashApiKey, open } from '../crypto.js';
import { publish } from '../sse.js';
import { resolveSecretEnv } from '../services/secrets.js';
import { settleBuildPhase } from '../services/builds.js';

/** claim 响应里下发给机器的模型定义（内置 runtime 用）。形状对齐机器协议。 */
interface ClaimModel {
  api: string;
  modelId: string;
  baseUrl?: string;
  thinkingLevel?: string;
  maxTokens?: number;
}

/**
 * machine 协议路由 —— 服务端这一端。
 *
 * 端点与语义全部来自 @todos-dev/cli@0.1.66 bundle 反解
 * （recon/02-cli-protocol.md §2–§4，1331 行 / 63 段代码证据）。
 *
 * 认证：Authorization: Bearer tds_...
 * 与原站入站 MCP 同款（实测匿名 GET /api/mcp 返回 401）。
 */

/** 机器离线判定：>10 分钟无心跳结算为 machine_offline（文档硬阈值） */
const OFFLINE_THRESHOLD_MS = 10 * 60 * 1000;

/**
 * `recover` 一轮最多下发几条指令。
 *
 * 有上限是因为认领动作是**批量翻状态**（pending→running）：一次给太多，
 * daemon 中途崩掉就会留下一堆 `running` 永远没有回执（本切片没有 reaper
 * 把它们退回 pending，见下面的已知边界）。20 条对「一个人连点几个 todo」
 * 够用，又不至于让一次 poll 变成长事务。
 */
const RECOVER_BATCH = 20;

interface MachineAuth {
  machineId: string;
  teamId: string;
  apiKeyUserId: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    machineAuth?: MachineAuth;
  }
}

/**
 * 机器认证。
 *
 * 设计要点（对齐原站的 claim-time credential 模型）：
 *   - 机器凭据与人的 API key 是**两套东西**，不能混在一张表靠字段猜
 *   - 机器凭据的 name 约定为 `machine:<machineId>`，便于反查
 *   - 凭据吊销不等于机器移除（文档：Revoke key 不下线 machine）
 */
const MACHINE_KEY_PREFIX = 'machine:';

async function authenticate(
  db: Db,
  req: FastifyRequest,
): Promise<MachineAuth | null> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  const raw = auth.slice('Bearer '.length).trim();
  if (!raw.startsWith('tds_')) return null;

  const hash = hashApiKey(raw, getKek());

  const keys = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt)))
    .limit(1);
  const key = keys[0];
  if (!key) return null;

  if (!key.name.startsWith(MACHINE_KEY_PREFIX)) return null;

  const machineId = key.name.slice(MACHINE_KEY_PREFIX.length);
  const mchs = await db.select().from(machines).where(eq(machines.id, machineId)).limit(1);
  const machine = mchs[0];
  if (!machine) return null;

  return { machineId: machine.id, teamId: machine.teamId, apiKeyUserId: null };
}

/**
 * 数据库行 → 协议里的 `MachineAction`。
 *
 * `kind` 写死 `'sync_branch'` 而不是透传：DB 的 CHECK 目前只允许这一个值
 * （见 `db/drizzle/0005_machine_pending_action.sql`），而协议侧是
 * `z.literal('sync_branch')`。将来加新 kind 时这两处都要改，写死让编译器
 * 和 CHECK 一起把「漏改协议」暴露出来，而不是让 daemon 收到一条它不认识的
 * kind 之后报未知错误。
 */
function toMachineAction(r: {
  id: string;
  kind: string;
  branch: string;
  dir: string;
  buildId: string | null;
  todoId: string | null;
}): MachineAction {
  return {
    actionId: r.id,
    kind: 'sync_branch',
    branch: r.branch,
    dir: r.dir,
    buildId: r.buildId,
    todoId: r.todoId,
  };
}

export function registerMachineRoutes(app: FastifyInstance, db: Db): void {
  const guard = async (req: FastifyRequest): Promise<MachineAuth> => {
    const auth = await authenticate(db, req);
    if (!auth) {
      const err = new Error('unauthorized') as Error & { statusCode?: number };
      err.statusCode = 401;
      throw err;
    }
    req.machineAuth = auth;
    return auth;
  };

  // ── 注册 ──────────────────────────────────────────────────

  app.post(API.enroll, async (req) => {
    const Body = z.object({
      apiKey: z.string().startsWith('tds_'),
      teamId: z.string(),
      device: z.object({
        deviceId: z.string(),
        name: z.string(),
        arch: z.string(),
        platform: z.string(),
        workspacesDir: z.string(),
        cliVersion: z.string(),
        nodeVersion: z.string().optional(),
      }),
    });
    const body = Body.parse(req.body);

    // 入队 key 必须是该 team 名下的「人的 API key」，不能是机器凭据
    const enrollHash = hashApiKey(body.apiKey, getKek());
    const enrollKeys = await db
      .select()
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.keyHash, enrollHash),
          eq(apiKeys.name, body.teamId),
          isNull(apiKeys.revokedAt),
        ),
      )
      .limit(1);
    if (!enrollKeys[0]) {
      const err = new Error('invalid enrollment key for team') as Error & { statusCode?: number };
      err.statusCode = 401;
      throw err;
    }

    const machineId = newId();
    const ts = now();

    // 同一 deviceId 重复入队 → 复用机器，只换发新凭据
    const existing = await db
      .select()
      .from(machines)
      .where(and(eq(machines.teamId, body.teamId), eq(machines.deviceId, body.device.deviceId)))
      .limit(1);

    const targetId = existing[0]?.id ?? machineId;

    if (existing[0]) {
      await db
        .update(machines)
        .set({
          name: body.device.name,
          cliVersion: body.device.cliVersion,
          workspacesDir: body.device.workspacesDir,
          isOnline: true,
          lastHeartbeatAt: ts,
          updatedAt: ts,
        })
        .where(eq(machines.id, targetId));
    } else {
      await db.insert(machines).values({
        id: machineId,
        teamId: body.teamId,
        name: body.device.name,
        deviceId: body.device.deviceId,
        enrolledBy: enrollKeys[0].userId,
        workspacesDir: body.device.workspacesDir,
        cliVersion: body.device.cliVersion,
        arch: body.device.arch,
        platform: body.device.platform,
        isOnline: true,
        lastHeartbeatAt: ts,
        createdAt: ts,
        updatedAt: ts,
      });
    }

    // 为这台机器签发专属凭据，name 约定为 machine:<machineId>
    const issued = generateApiKey();
    await db.insert(apiKeys).values({
      id: newId(),
      userId: enrollKeys[0].userId,
      name: `${MACHINE_KEY_PREFIX}${targetId}`,
      keyPrefix: issued.prefix,
      keyHash: issued.hash,
      scopes: ['machine:run'],
      createdAt: ts,
    });

    return { machineId: targetId, apiKey: issued.key, reused: Boolean(existing[0]) };
  });

  app.get(API.me, async (req) => {
    const auth = await guard(req);
    return { machineId: auth.machineId, teamId: auth.teamId, server: app.machineUrl };
  });

  // ── 领取 ──────────────────────────────────────────────────

  app.post(API.claim, async (req) => {
    const auth = await guard(req);
    const body = ClaimRequestSchema.parse(req.body ?? {});
    const ts = now();

    // 找出当前持有 step 的机器，减去它们的占用。
    // machineId 可为空（step 尚未被 claim），那种不计入任何机器。
    const running = await db
      .select({ machineId: steps.machineId })
      .from(steps)
      .where(inArray(steps.status, ['running', 'pending']));
    const busyCount = new Map<string, number>();
    for (const r of running) {
      if (r.machineId === null) continue;
      busyCount.set(r.machineId, (busyCount.get(r.machineId) ?? 0) + 1);
    }

    const free = body.concurrency - (busyCount.get(auth.machineId) ?? 0);
    if (free <= 0) {
      return { stepId: null, buildId: null, todoId: null, branch: null, kind: null, runtime: null, model: null, credential: null, secretEnv: {}, prompt: null, toolDefs: [] };
    }

    // 只匹配本机支持的 runtime
    if (body.runtimes.length === 0) {
      return { stepId: null, buildId: null, todoId: null, branch: null, kind: null, runtime: null, model: null, credential: null, secretEnv: {}, prompt: null, toolDefs: [] };
    }

    // 取本队最老的 queued step。
    //
    // **必须按 `auth.teamId` 收窄**（2026-10-17 修的真实越权）：原来的查询只按
    // `status='queued'` 全局取最老的一条，于是**任何入网机器都能领到别的团队的
    // step** —— 机器凭据只在 enroll 时绑定了 team，之后 claim 不再校验。
    // 之前这条只导致「跑错团队的活」，接上 team secrets 之后它会变成
    // **跨租户凭据泄露**：A 团队的机器会拿到 B 团队的 step，连带领到 B 的
    // secret 明文。所以归属判定放在 join build→todo→project→team 上。
    const queued = await db
      .select({ step: steps, todoId: todos.id, projectId: projects.id, projectTeamId: projects.teamId })
      .from(steps)
      .innerJoin(builds, eq(builds.id, steps.buildId))
      .innerJoin(todos, eq(todos.id, builds.todoId))
      .innerJoin(projects, eq(projects.id, todos.projectId))
      .where(and(eq(steps.status, 'queued'), eq(projects.teamId, auth.teamId)))
      .orderBy(steps.claimedAt)
      .limit(1);

    const row = queued[0];
    if (!row) {
      return { stepId: null, buildId: null, todoId: null, branch: null, kind: null, runtime: null, model: null, credential: null, secretEnv: {}, prompt: null, toolDefs: [] };
    }
    const step = row.step;

    // build 的完整行仍要单独取（上面 join 只带了归属判定需要的字段）
    const buildRows = await db.select().from(builds).where(eq(builds.id, step.buildId)).limit(1);
    const build = buildRows[0];
    if (!build) {
      await db.update(steps).set({ status: 'failed', error: 'build missing' }).where(eq(steps.id, step.id));
      return { stepId: null, buildId: null, todoId: null, branch: null, kind: null, runtime: null, model: null, credential: null, secretEnv: {}, prompt: null, toolDefs: [] };
    }

    // ── runtime 选择（按 build agent 的 provider api 兼容表过滤） ─────────────
    //
    // 兼容表依据（每个 runtime 怎么用 opts.model / opts.credential）实测于
    // apps/daemon/src/drivers/，**不看 driver 名字猜**：
    //
    //   pi           ALL  （apps/daemon/src/drivers/pi.ts:117-129）
    //                • api: model.api（pi-ai Model 直接吃任意 api）
    //                • credential → apiKey；baseUrl/modelId 直传
    //                • pi 是内嵌 SDK driver，唯一真正消费 claim.model 的
    //                  baseUrl / api / modelId
    //
    //   claude-code  anthropic-messages  （apps/daemon/src/drivers/claude-code.ts:122-148）
    //                • '--model' 把 modelId 直接传给 `claude` CLI
    //                • '--effort' 把 thinkingLevel 当 effort 传
    //                • credential → env:ANTHROPIC_API_KEY（必须有 ANTHROPIC_BASE_URL
    //                  才能指向非官方端点；strata/qwen 之类没有这变量，claim
    //                  时下发 claude-code 必失败）
    //
    //   omp          openai-completions / openai-responses  （apps/daemon/src/drivers/omp.ts:175-185）
    //                • '--model' / '--thinking' 直传
    //                • credential → env:OPENAI_API_KEY
    //
    //   codex        （apps/daemon/src/drivers/codex.ts:90-99）
    //                • STUB_NOT_AVAILABLE：当前 driver 路径不对 opts.model / opts.credential
    //                  做任何处理，永远返回 stub 失败。所以即便 api 兼容，
    //                  codex 也不能跑 —— 表里直接不放，匹配永不为真。
    //
    // 旧实现（`body.runtimes[0]`）按 daemon 上报的列表首位选 runtime，
    // 忽略了列表顺序与 provider api 的关系，于是同台机器在不同进程上报
    // 顺序变化、或别台机器先 claim 过本 step 时，claude-code 会被领到
    // openai 兼容的活，env 错配 → 静默卡死（step.status=running 19 分钟
    // 无输出，因为 driver 拿到 `--model qwen3.8-flash-next-iq2_xs` +
    // `ANTHROPIC_API_KEY=<sk-team>` 却没设 ANTHROPIC_BASE_URL，根本
    // 连不上端点）。
    //
    // provider 根本没配（agent.provider / modelId 空 / provider 行查不到 /
    // 模型不在 provider.models 列表里）时，**保留旧行为**：runtime =
    // body.runtimes[0]，claimModel/credential 为空。这条路径下 pi driver
    // 本身会回一句人话错误（`pi runtime 需要团队 provider：先在 Providers 页
    // 添加一个，再给 agent 选模型`），是用户可以照做的提示，不要替它翻译。
    const EMPTY = { stepId: null, buildId: null, todoId: null, branch: null, kind: null, runtime: null, model: null, credential: null, secretEnv: {}, prompt: null, toolDefs: [] } as const;

    // 先探一下 agent → provider → api（早一步，避免回到 step 这层再去查）
    let providerApi: string | null = null;
    if (build.agentId) {
      const agentProbe = await db.select().from(agents).where(eq(agents.id, build.agentId)).limit(1);
      const ag = agentProbe[0];
      if (ag?.provider && ag.modelId) {
        const provProbe = await db
          .select()
          .from(providers)
          .where(and(eq(providers.teamId, auth.teamId), eq(providers.providerId, ag.provider)))
          .limit(1);
        const prov = provProbe[0];
        if (prov?.api) {
          const entries = (prov.models ?? []) as Array<{ id: string }>;
          if (entries.some((m) => m.id === ag.modelId)) providerApi = prov.api;
        }
      }
    }

    let runtime: string | null;
    if (providerApi === null) {
      // provider 没配：保留旧行为，让 pi 自己报人话错误
      runtime = body.runtimes[0] ?? null;
      if (!runtime) return EMPTY;
    } else {
      const COMPAT: Record<string, ReadonlyArray<string>> = {
        pi: ['anthropic-messages', 'openai-completions', 'openai-responses', 'google-generative-ai'],
        'claude-code': ['anthropic-messages'],
        omp: ['openai-completions', 'openai-responses'],
        // codex 当前是 STUB（不读 opts.model/credential），不放进表 —— 即便
        // api 兼容 codex 也会立刻 STUB_NOT_AVAILABLE。测试断言此行为。
      };
      const matched = body.runtimes.find((r) => (COMPAT[r] ?? []).includes(providerApi));
      if (!matched) {
        // 「无可用 runtime」—— 不标 step.failed（让用户以为 agent 跑挂），
        // 不静默 claim 成功（旧 bug 的根因），不擅自选错的 driver。
        // 原因落进 audit_event，方便复盘 + daemon 下次 claim 时再试。
        await db.insert(auditEvents).values({
          teamId: auth.teamId,
          actorType: 'system',
          todoId: build.todoId,
          buildId: build.id,
          type: 'step_claim_rejected',
          payload: {
            stepId: step.id,
            machineId: auth.machineId,
            reason: `no runtime on machine ${auth.machineId} is compatible with provider api ${providerApi}`,
            providerApi,
            runtimes: body.runtimes,
          },
          createdAt: ts,
        });
        return EMPTY;
      }
      runtime = matched;
    }

    await db
      .update(steps)
      .set({ status: 'running', machineId: auth.machineId, claimedAt: ts, heartbeatAt: ts })
      .where(eq(steps.id, step.id));

    await db
      .update(builds)
      .set({ pinnedMachineId: auth.machineId })
      .where(eq(builds.id, build.id));

    await db.insert(auditEvents).values({
      teamId: auth.teamId,
      actorType: 'system',
      todoId: build.todoId,
      buildId: build.id,
      type: 'step_claimed',
      payload: { stepId: step.id, machineId: auth.machineId, runtime },
      createdAt: ts,
    });

    // 组装 prompt 与工作区信息
    const todoRows = await db.select().from(todos).where(eq(todos.id, build.todoId)).limit(1);
    const todo = todoRows[0];
    const projectRows = todo ? await db.select().from(projects).where(eq(projects.id, todo.projectId)).limit(1) : [];
    const project = projectRows[0];

    const prompt = [
      `# Task ${todo ? `#${todo.seqNum}` : ''} — ${todo?.title ?? 'untitled'}`,
      '',
      project ? `Repository: ${project.repoFullName ?? project.name}` : '',
      `Branch: ${build.branch} (base: ${project?.defaultBranch ?? 'main'})`,
      '',
      '## Specification',
      todo?.spec ?? '(none)',
      '',
      '## What to do',
      'Implement the specification on the current branch. When done:',
      '- commit your work (the platform commits it for you if you do not)',
      '- summarise what changed and what you verified',
      '- if you need a decision you cannot make, call the ask_user tool rather than guessing',
    ]
      .filter(Boolean)
      .join('\n');

    // ── 模型与一次性凭据 ─────────────────────────────────────
    //
    // 内置 runtime（pi）的模型**不在机器上**，来自团队 provider：
    // agent.provider 存 providerId，agent.model_id 存 modelId
    // （与 /api/teams/:id/models 返回的 id 形状 `providerId/modelId` 对齐）。
    //
    // 凭据规则（recon/docs/providers.md）：claim step 时下发**单份**明文，
    // 只在响应里出现一次，机器侧只在内存里用，永不落盘。
    let claimModel: ClaimModel | null = null;
    let claimCredential: string | null = null;

    const agentRows = build.agentId
      ? await db.select().from(agents).where(eq(agents.id, build.agentId)).limit(1)
      : [];
    const agent = agentRows[0];
    if (agent?.provider && agent.modelId) {
      const provRows = await db
        .select()
        .from(providers)
        .where(and(eq(providers.teamId, auth.teamId), eq(providers.providerId, agent.provider)))
        .limit(1);
      const prov = provRows[0];
      if (prov?.api) {
        const entries = (prov.models ?? []) as Array<{ id: string; maxTokens?: number }>;
        const entry = entries.find((m) => m.id === agent.modelId);
        claimModel = {
          api: prov.api,
          modelId: agent.modelId,
          ...(prov.baseUrl ? { baseUrl: prov.baseUrl } : {}),
          ...(agent.thinkingLevel ? { thinkingLevel: agent.thinkingLevel } : {}),
          ...(entry?.maxTokens ? { maxTokens: entry.maxTokens } : {}),
        };
        // 单次下发：解封后立刻丢弃 sealed
        if (prov.encApiKey && prov.encNonce) {
          const dot = prov.encApiKey.lastIndexOf('.');
          claimCredential = open({
            cipher: prov.encApiKey.slice(0, dot),
            tag: prov.encApiKey.slice(dot + 1),
            nonce: prov.encNonce,
          });
        }
      }
    }

    // ── team secrets ─────────────────────────────────────────
    //
    // 文档：secret 不会自动流向每个 agent —— 要在 agent 的 Access 页打开
    // `Team secrets` 开关（`agents.grants.team_secrets`），从该 agent 的下一个
    // turn 起注入。默认关闭，所以这里读不到开关就**静默不下发**。
    //
    // scope 规则由服务层定：team 级对该团队每个项目可见，project 级只在该项目内
    // 可见，同名时 project 级覆盖 team 级。
    const secretEnv: Record<string, string> = {};
    const teamSecretsOn = (agent?.grants ?? {})['team_secrets'] === true;
    if (teamSecretsOn) {
      for (const { name, value } of await resolveSecretEnv(db, auth.teamId, project?.id ?? null)) {
        secretEnv[name] = value;
      }
    }

    return {
      stepId: step.id,
      buildId: build.id,
      todoId: build.todoId,
      branch: build.branch,
      kind: 'implement',
      runtime,
      // MVP 只做 external git。凭据由机器本地持有（credentialRef），
      // 服务端不在响应里下发 token 明文。
      repo: project?.repoUrl
        ? {
            url: project.repoUrl,
            baseBranch: project.defaultBranch,
            credentialRef: null,
          }
        : null,
      model: claimModel,
      credential: claimCredential,
      secretEnv,
      prompt,
      toolDefs: [],
    };
  });

  // ── 执行中 ────────────────────────────────────────────────

  app.post(API.heartbeat, async (req) => {
    const auth = await guard(req);
    const { stepId } = req.params as { stepId: string };
    const body = HeartbeatSchema.parse(req.body ?? {});
    await db.update(steps).set({ heartbeatAt: now() }).where(eq(steps.id, stepId));
    await db.update(machines).set({ lastHeartbeatAt: now(), isOnline: true }).where(eq(machines.id, auth.machineId));
    return { ok: true };
  });

  app.post(API.changes, async (req) => {
    await guard(req);
    const { stepId } = req.params as { stepId: string };
    const body = ChangesSchema.parse(req.body ?? {});

    const stepRows = await db.select().from(steps).where(eq(steps.id, stepId)).limit(1);
    const step = stepRows[0];
    if (!step) return { ok: false, error: 'step not found' };

    // 实时推送：把帧投到该 build 的 SSE 通道
    for (const frame of body.frames) {
      await publish(db, step.buildId, frame.type, frame);
    }

    // 终帧落库为一条 assistant 消息
    if (body.finalText !== undefined && body.finalText !== '') {
      const buildRows = await db.select().from(builds).where(eq(builds.id, step.buildId)).limit(1);
      const build = buildRows[0];
      if (build) {
        const last = await db
          .select({ seq: buildMessages.seq })
          .from(buildMessages)
          .where(eq(buildMessages.buildId, step.buildId))
          .orderBy(sql`${buildMessages.seq} desc`)
          .limit(1);
        const nextSeq = (last[0]?.seq ?? -1) + 1;

        await db.insert(buildMessages).values({
          id: newId(),
          buildId: step.buildId,
          role: 'assistant',
          phase: 'implement',
          content: body.finalText,
          isError: body.isError,
          seq: nextSeq,
          createdAt: now(),
        });
      }
    }

    return { ok: true };
  });

  app.post(API.done, async (req) => {
    const auth = await guard(req);
    const { stepId } = req.params as { stepId: string };
    const body = DoneSchema.parse(req.body ?? {});
    const ts = now();

    const stepRows = await db.select().from(steps).where(eq(steps.id, stepId)).limit(1);
    const step = stepRows[0];
    if (!step) return { ok: false, error: 'step not found' };

    await db
      .update(steps)
      .set({
        status: body.status,
        finishedAt: ts,
        error: body.error ?? null,
      })
      .where(eq(steps.id, step.id));

    const buildRows = await db.select().from(builds).where(eq(builds.id, step.buildId)).limit(1);
    const build = buildRows[0];
    if (!build) return { ok: true };

    // 相位落点交给服务层 —— 原来这里按 status 硬编码（succeeded→review），
    // 于是 `reviewing` 跑完被写成 `review`，**跳过了 Confirm 闸门**。
    // 规则与历史见 services/builds.ts 的 settleBuildPhase。
    const settlement = await settleBuildPhase(db, {
      buildId: build.id,
      todoId: build.todoId,
      status: body.status,
    });
    const newPhase = settlement.phase;

    // 有 diff 就存成 Changes 文档 —— Review 闸门展示的就是它。
    // 文档要求可版本化，所以先查有没有同 kind 的旧版本，version 递增。
    let changesDocId: string | null = build.changesDocId;
    if (body.diff && body.status === 'succeeded') {
      const prior = await db
        .select({ id: documents.id, version: documents.version })
        .from(documents)
        .where(and(eq(documents.buildId, build.id), eq(documents.kind, 'changes')))
        .orderBy(sql`${documents.version} desc`)
        .limit(1);

      const docId = newId();
      const version = (prior[0]?.version ?? 0) + 1;
      await db.insert(documents).values({
        id: docId,
        buildId: build.id,
        kind: 'changes',
        version,
        payload: {
          summary: `${body.diff.filesChanged} files, +${body.diff.insertions}/-${body.diff.deletions}`,
          filesChanged: body.diff.filesChanged,
          insertions: body.diff.insertions,
          deletions: body.diff.deletions,
          truncated: body.diff.truncated,
          body: body.diff.body,
          note: body.diff.note ?? null,
          commitSha: body.commitSha ?? null,
          branch: build.branch,
        },
        createdAt: ts,
        updatedAt: ts,
      });
      changesDocId = docId;
    }

    await db
      .update(builds)
      .set({
        errorMessage: body.error ?? null,
        settlementCode: body.settlementCode ?? null,
        branchPushedAt: body.branchPushed ? ts : null,
        pushError: body.pushError ?? null,
        changesDocId,
        finishedAt: body.status === 'succeeded' ? ts : null,
        v: sql`${builds.v} + 1`,
      })
      .where(eq(builds.id, build.id));

    await db
      .update(todos)
      .set({ phase: newPhase, updatedAt: ts })
      .where(eq(todos.id, build.todoId));

    await db.insert(auditEvents).values({
      teamId: auth.teamId,
      actorType: 'system',
      todoId: build.todoId,
      buildId: build.id,
      type: `step_${body.status}`,
      payload: {
        stepId: step.id,
        error: body.error,
        settlementCode: body.settlementCode,
        // 状态机拒绝推进时把 reason 记进来 —— 否则「step 跑完了但 todo 没动」
        // 在审计里完全看不出来，只能靠盯看板猜。
        phaseSettled: settlement.ok,
        ...(settlement.reason ? { settlementReason: settlement.reason } : {}),
      },
      createdAt: ts,
    });

    // 同样双发到 team scope —— 看板靠它实时更新 todo 的 phase，
    // 否则 build 跑完了看板还停在旧相位。todoId 一并带上让前端定位。
    await publish(db, build.id, 'step_update', { status: body.status, todoId: build.todoId }, auth.teamId);
    await publish(db, build.id, 'phase_changed', { todoId: build.todoId, phase: newPhase }, auth.teamId);
    await publish(db, `todo:${build.todoId}`, 'phase_changed', { todoId: build.todoId, phase: newPhase }, auth.teamId);
    await publish(db, `team:${auth.teamId}`, 'phase_changed', { todoId: build.todoId, phase: newPhase }, auth.teamId);

    return { ok: true };
  });

  app.post(API.tool, async (req) => {
    await guard(req);
    const params = req.params as { stepId: string };
    const body = ToolCallRequestSchema.parse(req.body ?? {});
    // MVP：平台工具尚未实现，返回明确的未支持而非静默失败
    return {
      callId: body.callId,
      isError: true,
      error: `tool ${body.name} is not implemented in this build`,
    };
  });

  app.post(API.token, async (req) => {
    await guard(req);
    return { error: 'git token not issued in this build (external git only)' };
  });

  app.post(API.presence, async (req) => {
    const auth = await guard(req);
    const body = PresenceSchema.parse(req.body ?? {});
    const ts = now();

    await db.update(machines).set({
      lastHeartbeatAt: ts,
      isOnline: true,
      runtimes: body.runtimes.filter((r) => r.installed).map((r) => r.id),
      updatedAt: ts,
    }).where(eq(machines.id, auth.machineId));

    return { ok: true };
  });

  // ── 补件通道（recover）─────────────────────────────────────
  //
  // 2026-10-18 从空壳升级成真正的指令下发通道（契约 §3.4）。原来这里是
  // `return { ok: true, recovered: 0 }` —— 什么都不做，于是「同步到机器」
  // 写下的指令永远没人领。
  //
  // **为什么走 recover 而不是新端点**：recover 已经在协议表里，语义本来就是
  // 「daemon 定期问服务器有什么要补的」。新端点要求 daemon 先升级才能收到
  // 指令；走 recover + 能力位，老 daemon 的响应形状与升级前完全一致。
  app.post(API.recover, async (req) => {
    const auth = await guard(req);
    // body 可能是 undefined（老 daemon 一个字段都不带）—— `?? {}` 之后
    // capabilities 是 undefined，落到下面的兼容路径。
    const body = RecoverRequestSchema.parse(req.body ?? {});

    // ── 老 daemon 兼容路径（必须在查表之前）──────────────────
    // 能力位缺失（老 daemon 的 body 里根本没有 capabilities）或显式 false
    // 时**立刻**返回，连表都不查。响应与本协议引入前的语义完全一致：
    // `{ok:true, recovered:0}` + 空 actions。少了这一步，老 daemon 会收到
    // 一条它根本不认识的 sync_branch 指令，只能报未知 kind，用户看到的是
    // 「同步失败」而不是「daemon 版本过低」。
    if (body.capabilities?.syncBranch !== true) {
      const legacy: RecoverResponse = { ok: true, recovered: 0, actions: [] };
      return legacy;
    }

    const ts = now();

    // 1) 候选集：本机 pending 的最老 RECOVER_BATCH 条。
    //    这一步**只是筛候选，不是认领** —— 原子性在第 2 步。
    const candidates = await db
      .select({ id: machinePendingActions.id })
      .from(machinePendingActions)
      .where(
        and(
          eq(machinePendingActions.machineId, auth.machineId),
          eq(machinePendingActions.status, 'pending'),
        ),
      )
      .orderBy(machinePendingActions.requestedAt)
      .limit(RECOVER_BATCH);

    if (candidates.length === 0) {
      const empty: RecoverResponse = { ok: true, recovered: 0, actions: [] };
      return empty;
    }

    // 2) 条件更新 + returning —— **不能「先查后写」**。
    //    同一条指令可能被两个 daemon 实例同时 poll 到（同一台机器跑两个
    //    daemon，或者入队时把凭据复制了一份）。先查后写的话两边都读到
    //    status='pending'、都以为是自己领到的，于是同一条 `git fetch` +
    //    `git reset --hard` 在那台机器上跑两遍 —— 第二遍会把第一遍刚同步
    //    好的目录再 reset 一次，用户看到的是「本地改动被丢了两回」。
    //    把认领写成一条带 `status='pending'` 谓词的 UPDATE + `returning()`：
    //    Postgres 保证只有一边能把行从 pending 翻到 running，输的那边
    //    returning 为空 → 它拿到 recovered:0，不会重复执行。
    const claimed = await db
      .update(machinePendingActions)
      .set({
        status: 'running',
        startedAt: ts,
        attempts: sql`${machinePendingActions.attempts} + 1`,
      })
      .where(
        and(
          inArray(machinePendingActions.id, candidates.map((c) => c.id)),
          eq(machinePendingActions.status, 'pending'),
        ),
      )
      .returning({
        id: machinePendingActions.id,
        kind: machinePendingActions.kind,
        branch: machinePendingActions.branch,
        dir: machinePendingActions.dir,
        buildId: machinePendingActions.buildId,
        todoId: machinePendingActions.todoId,
      });

    // 只把**真正更新成功**的行返回 —— `claimed` 就是 returning 的结果，
    // 抢输的那边在这里天然拿到空数组。
    const actions: MachineAction[] = claimed.map(toMachineAction);
    const resp: RecoverResponse = { ok: true, recovered: actions.length, actions };
    return resp;
  });

  // ── 动作回执（action-result）───────────────────────────────
  //
  // daemon 执行完一条 recover 下发的指令后回报。**不带 :stepId** —— 同步一条
  // 分支不占机器 slot，也不是 claim 出来的，用独立的 actionId 寻址。
  //
  // 状态码用 `../http.js` 的 `HttpError`（全仓现行口径，`isHttpError` 按
  // statusCode 鸭子类型识别，与 `guard` 里那个手写 statusCode 的 401 在错误
  // 处理上完全等价）—— 这里不复制 guard 的局部写法。
  app.post(API.actionResult, async (req) => {
    const auth = await guard(req);
    const body = ActionResultSchema.parse(req.body ?? {});
    const ts = now();

    const rows = await db
      .select()
      .from(machinePendingActions)
      .where(eq(machinePendingActions.id, body.actionId))
      .limit(1);
    const action = rows[0];
    if (!action) throw new HttpError(404, `action "${body.actionId}" not found`);

    // 跨机器冒领：A 机器不能替 B 机器回执。放它过的话 B 的指令会被 A 标成
    // done、B 永远不执行 —— 用户看到的是「同步成功，但那台机器的目录没变」。
    if (action.machineId !== auth.machineId) {
      throw new HttpError(
        403,
        `action "${body.actionId}" belongs to machine "${action.machineId}", not "${auth.machineId}"`,
      );
    }

    // 幂等：已经终态就直接 `{ok:true}`，**不能 404**。
    // daemon 的网络重试会把同一条回执发第二次；第二次报 404 会被它理解成
    // 「服务端没收到第一次」，于是无限重试下去（每轮都要重跑一次 git）。
    // 判定顺序：先判存在（404 = 这个 actionId 从来没有过，是真错误）、
    // 再判归属（403）、最后判终态（幂等成功）。
    if (action.status === 'done' || action.status === 'failed') {
      return { ok: true };
    }

    await db
      .update(machinePendingActions)
      .set({
        status: body.status,
        result: body.result,
        finishedAt: ts,
        // 顶层 `error` 与 `result.error` 同义（协议里两个都有，前者便于
        // 不按路径下钻）。优先顶层、再退到 result，否则失败回执的 error
        // 列会是 NULL —— 审计里「失败了但不知道为什么」。
        error: body.error ?? body.result.error ?? null,
      })
      .where(eq(machinePendingActions.id, action.id));

    // audit_event —— 照抄本文件 `API.done` 的写法：`actorType:'system'`、
    // type 用 `xxx_${status}` 模板、payload 带结论性事实。
    // 为什么是 'system' 不是 'machine'：本文件两处既有审计（step_claimed /
    // step_${status}）都是 'system'，全仓没有 'machine' 这个 actorType；
    // 「机器把活跑完了」同样是服务端视角的系统事件。发起人留在 requestedBy
    // 里，审计读得出「谁要的这次同步」。
    await db.insert(auditEvents).values({
      teamId: action.teamId,
      actorType: 'system',
      todoId: action.todoId,
      buildId: action.buildId,
      type: `action_${body.status}`,
      payload: {
        actionId: action.id,
        machineId: auth.machineId,
        kind: action.kind,
        branch: action.branch,
        dir: action.dir,
        requestedBy: action.requestedBy,
        attempts: action.attempts,
        result: body.result,
        ...(body.error ? { error: body.error } : {}),
      },
      createdAt: ts,
    });

    // SSE —— 三个 scope，理由各不相同（payload 三处一致，与 `API.done` 里
    // phase_changed 的多发同款写法）：
    //   `machine:<machineId>` 契约 §3.5 指定的 scope。`sse.ts` 的
    //     authorizeScope 已有 'machine' 分支（按 machine→team 归属放行），
    //     所以浏览器能订，不需要改 sse.ts。
    //   `todo:<todoId>`       装 BranchMenu 的页面（`apps/web/src/app/todo/
    //     [id]/page.tsx`）**已经**在订 todo scope；只发 machine scope 的话
    //     回执到不了正在等它的那块 UI。
    //   `team:<teamId>`       本仓 machine 事件的既有口径 ——
    //     `routes/machines.ts` 的 machine_updated / machine_deleted 就发在
    //     team scope，看板页订的是它。
    const frame = {
      actionId: action.id,
      status: body.status,
      todoId: action.todoId,
      result: body.result,
    };
    await publish(db, `machine:${auth.machineId}`, 'action_completed', frame, action.teamId);
    if (action.todoId) {
      await publish(db, `todo:${action.todoId}`, 'action_completed', frame, action.teamId);
    }
    await publish(db, `team:${action.teamId}`, 'action_completed', frame, action.teamId);

    return { ok: true };
  });
}
