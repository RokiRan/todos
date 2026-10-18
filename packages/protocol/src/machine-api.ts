import { z } from 'zod';

/**
 * machine ↔ server 协议。
 *
 * 端点路径与字段来自 todos.dev CLI bundle 反解（recon/02-cli-protocol.md §2–§4，
 * 1331 行 / 63 段代码证据）。这是 daemon 与服务端之间唯一的契约面。
 */

export const API = {
  // 注册
  enroll: '/api/machine/enroll',
  enrollStart: '/api/machine/enroll/start',
  enrollPoll: '/api/machine/enroll/poll',
  me: '/api/machine/me',

  // 领取与执行 —— 路径模板（服务端注册路由用）
  claim: '/api/machine/tasks/claim',
  heartbeat: '/api/machine/heartbeat/:stepId',
  changes: '/api/machine/changes/:stepId',
  done: '/api/machine/done/:stepId',
  tool: '/api/machine/tool/:stepId',
  token: '/api/machine/token/:stepId',
  uploadUrls: '/api/machine/upload-urls/:stepId',

  // 实时
  stream: '/api/machine/stream',
  presence: '/api/machine/presence',
  recover: '/api/machine/recover',

  /**
   * 动作回执（2026-10-18 新增，「同步到机器」链路）。
   *
   * daemon 执行完 `recover` 下发的指令后回报结果。**不带 :stepId** —— 动作
   * 与 build step 不是一回事：同步一条分支不需要占用机器 slot，也不是
   * claim 出来的。用独立的 actionId 寻址。
   */
  actionResult: '/api/machine/action-result',
} as const;

/** 把 :stepId 模板填成实际路径（客户端侧用） */
export const stepApi = {
  heartbeat: (stepId: string) => `/api/machine/heartbeat/${stepId}`,
  changes: (stepId: string) => `/api/machine/changes/${stepId}`,
  done: (stepId: string) => `/api/machine/done/${stepId}`,
  tool: (stepId: string) => `/api/machine/tool/${stepId}`,
  token: (stepId: string) => `/api/machine/token/${stepId}`,
  uploadUrls: (stepId: string) => `/api/machine/upload-urls/${stepId}`,
} as const;

// ── 身份 ────────────────────────────────────────────────────────
export const IdSchema = z.string().min(1);
/** 全站主键风格：短 base64url（实测约 24 字符） */
export const ShortIdSchema = z.string().regex(/^[A-Za-z0-9_-]{6,32}$/, 'expected nanoid-style id');

/** buildId 同时就是分支名：branch === `tds/conv-${buildId}`（实测确认） */
export const branchForBuild = (buildId: string) => `tds/conv-${buildId}`;

// ── 设备指纹 ───────────────────────────────────────────────────
export const DeviceInfoSchema = z.object({
  deviceId: z.string(),          // 硬件指纹，logout 时保留以便重入队
  name: z.string(),
  arch: z.string(),              // os.arch()
  platform: z.string(),          // 'win32' | 'linux' | 'darwin'
  workspacesDir: z.string(),
  cliVersion: z.string(),
  cpus: z.number().int().optional(),
  totalMemBytes: z.number().int().optional(),
  nodeVersion: z.string().optional(),
});
export type DeviceInfo = z.infer<typeof DeviceInfoSchema>;

// ── 枚举：注册 ────────────────────────────────────────────────
export const EnrollByKeySchema = z.object({
  apiKey: z.string().startsWith('tds_'),
  teamId: z.string(),
  device: DeviceInfoSchema,
});

export const EnrollStartSchema = z.object({
  teamId: z.string().optional(),
  device: DeviceInfoSchema,
});
export const EnrollStartResponseSchema = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verifyUrl: z.string().url(),
  expiresIn: z.number().int(),
});
export const EnrollPollResponseSchema = z.object({
  status: z.enum(['pending', 'authorized', 'denied', 'expired']),
  apiKey: z.string().optional(),
  teamId: z.string().optional(),
  teamName: z.string().optional(),
});

// ── 枚举：能力上报 ────────────────────────────────────────────
/** 机器支持的 runtime 及其检测结果。17 个 runtime 的规范名见 runtime-ids.ts */
export const RuntimeReportSchema = z.object({
  id: z.string(),
  installed: z.boolean(),
  signedIn: z.boolean(),
  version: z.string().nullable().optional(),
  binaryPath: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
});
export type RuntimeReport = z.infer<typeof RuntimeReportSchema>;

// ── 领取任务 ──────────────────────────────────────────────────
export const ClaimRequestSchema = z.object({
  /** 本机启用的 runtime 列表，服务端据此匹配 agent 的 runtime */
  runtimes: z.array(z.string()),
  concurrency: z.number().int().min(1).max(10),
});
export const ClaimResponseSchema = z.object({
  stepId: IdSchema.nullable(),
  buildId: IdSchema.nullable(),
  todoId: IdSchema.nullable(),
  branch: z.string().nullable(),
  kind: z.enum(['plan', 'implement', 'review', 'merge']).nullable(),
  runtime: z.string().nullable(),
  /**
   * 工作区来源。MVP 只做 external git：daemon 用 url 自行 clone，
   * token 由机器本地持有（不经服务端下发，符合凭据不落机器盘的原则）。
   */
  repo: z
    .object({
      url: z.string(),
      baseBranch: z.string(),
      /** 凭据引用名 —— daemon 从自己的 credential store 取，不从响应取明文 */
      credentialRef: z.string().nullable(),
    })
    .nullable(),
  model: z
    .object({
      api: z.string(),
      modelId: z.string(),
      baseUrl: z.string().optional(),
      thinkingLevel: z.string().optional(),
      maxTokens: z.number().int().optional(),
      contextWindow: z.number().int().optional(),
    })
    .nullable(),
  /** 一次性凭据：只在 claim 响应里带，绝不落机器磁盘 */
  credential: z.string().nullable(),
  /**
   * 该 agent 的 team secrets 明文值（name → value）。
   *
   * 与 `credential` 同一套纪律：**只在这一次 claim 响应里出现**，daemon 注入
   * 子进程 env 后即丢，绝不写盘（recon/docs/secrets.md：「Values are injected
   * directly into the process environment. They are not in the prompt, not in
   * the conversation, and not in the stored transcript.」）。
   *
   * 只在 agent 的 `team_secrets` 开关打开时非空 —— 默认关闭。
   * project 级同名 secret 覆盖 team 级。
   */
  secretEnv: z.record(z.string()).default({}),
  prompt: z.string().nullable(),
  toolDefs: z.array(z.record(z.unknown())).default([]),
  expiresAt: z.number().int().optional(),
});
export type ClaimResponse = z.infer<typeof ClaimResponseSchema>;

// ── 心跳 ──────────────────────────────────────────────────────
export const HeartbeatSchema = z.object({
  stepId: IdSchema,
  runtimes: z.array(RuntimeReportSchema).default([]),
  /** 机器本轮探测到的订阅额度 */
  runtimeUsage: z.record(z.unknown()).default({}),
});

// ── 进度回报（一次 turn 的产出） ──────────────────────────────
export const StreamFrameSchema = z.object({
  seq: z.number().int(),
  type: z.string(),
  /** text_delta 的文本 / thinking_delta 的思考内容 */
  text: z.string().optional(),
  /** tool_call 的工具名与入参 */
  tool: z
    .object({
      callId: z.string(),
      name: z.string(),
      input: z.unknown().optional(),
    })
    .optional(),
  usage: z
    .object({
      inputTokens: z.number().int().optional(),
      outputTokens: z.number().int().optional(),
      cacheReadTokens: z.number().int().optional(),
      cacheWriteTokens: z.number().int().optional(),
      costUsd: z.number().optional(),
      provider: z.string().optional(),
      modelId: z.string().optional(),
    })
    .optional(),
});
export type StreamFrame = z.infer<typeof StreamFrameSchema>;

export const ChangesSchema = z.object({
  stepId: IdSchema,
  frames: z.array(StreamFrameSchema),
  /** 本轮结束的完整文本，落进 build_message */
  finalText: z.string().optional(),
  isError: z.boolean().default(false),
});

// ── 工具回调：机器上的 agent 调用平台工具 ────────────────────
export const ToolCallRequestSchema = z.object({
  stepId: IdSchema,
  callId: z.string(),
  name: z.string(),               // mcp__tds__<name>
  input: z.unknown().optional(),
});
export const ToolCallResponseSchema = z.object({
  callId: z.string(),
  result: z.unknown().optional(),
  isError: z.boolean().default(false),
  error: z.string().optional(),
});

// ── 完成 ──────────────────────────────────────────────────────
export const DoneSchema = z.object({
  stepId: IdSchema,
  status: z.enum(['succeeded', 'failed', 'cancelled']),
  settlementCode: z.string().optional(),   // 'machine_offline' 等
  error: z.string().optional(),
  commitSha: z.string().optional(),
  branchPushed: z.boolean().default(false),
  pushError: z.string().optional(),
  prUrl: z.string().optional(),
  /**
   * 改动摘要。服务端存成 Changes 文档，供 Review 闸门展示。
   * 超过阈值时 truncated=true 且 diff 为空，只给统计与说明 ——
   * 文档要求「明示不静默截断」。
   */
  diff: z
    .object({
      filesChanged: z.number().int(),
      insertions: z.number().int(),
      deletions: z.number().int(),
      truncated: z.boolean(),
      body: z.string(),
      note: z.string().optional(),
    })
    .optional(),
});

// ── 凭据领取：refreshable push token ────────────────────────
export const TokenResponseSchema = z.object({
  token: z.string(),
  expiresAt: z.number().int(),
  scope: z.enum(['read', 'write']),
});

// ── 实时流 ────────────────────────────────────────────────────
export const ServerEventSchema = z.object({
  type: z.string(),
  seq: z.number().int(),
  payload: z.unknown().optional(),
});
export type ServerEvent = z.infer<typeof ServerEventSchema>;

// ── 在线状态 ──────────────────────────────────────────────────
export const PresenceSchema = z.object({
  runtimes: z.array(RuntimeReportSchema).default([]),
  perf: z
    .object({
      loadAvg: z.array(z.number()).optional(),
      memFreeBytes: z.number().int().optional(),
      diskFreeBytes: z.number().int().optional(),
    })
    .optional(),
});

// ── 动作指令（「同步到机器」链路，2026-10-18 新增）────────────────
//
// 为什么走 `recover` 而不是新增端点：
//   `recover` 本来就是「daemon 定期问服务器有什么要补的」这个语义，且已在
//   API 表里。老 daemon 不认识新端点就永远收不到指令；走 recover 则
//   **响应形状向后兼容**（见 RecoverRequestSchema 的 capabilities 说明）。

/**
 * daemon 上报的能力位。
 *
 * **存在的原因**：服务端要能区分「daemon 还没升级，不支持同步」与「这台机器
 * 没有待办指令」。少了它，服务端会给老 daemon 下发它根本不认识的指令，
 * daemon 只能报未知错误，用户看到的是「同步失败」而不是「daemon 版本过低」。
 *
 * `syncBranch` 缺失（老 daemon）或 `false` 时，服务端**不下发任何动作**，
 * 返回的 `actions` 恒为空数组 —— 与本协议引入前的响应语义完全一致。
 */
export const RecoverRequestSchema = z.object({
  capabilities: z
    .object({
      /** daemon 实现了 sync-branch 能力位 */
      syncBranch: z.boolean().default(false),
    })
    .optional(),
});
export type RecoverRequest = z.infer<typeof RecoverRequestSchema>;

/** 一条待执行的机器动作。当前只有「同步分支」一种 kind。 */
export const MachineActionSchema = z.object({
  actionId: IdSchema,
  kind: z.literal('sync_branch'),
  /** 分支名，build 场景下是 `tds/conv-<buildId>` */
  branch: z.string().min(1),
  /**
   * 目标目录（绝对路径）。**daemon 必须直接用它**，不要拼到自己的 home 下面 ——
   * 用户要的就是「这台机器上已有的那个目录」，daemon 自造路径等于同步到了
   * 一个用户永远不会去看的角落。
   */
  dir: z.string().min(1),
  /** 溯源用；没有 build 的分支同步（如用户手输分支名）时为 null */
  buildId: z.string().nullable(),
  todoId: z.string().nullable(),
});
export type MachineAction = z.infer<typeof MachineActionSchema>;

/**
 * `recover` 的响应。
 *
 * `recovered` 字段保留既有语义（本轮下发了几条指令），新增 `actions` 携带
 * 指令本体。没有待办时是 `{ ok:true, recovered:0, actions:[] }`。
 */
export const RecoverResponseSchema = z.object({
  ok: z.boolean(),
  recovered: z.number().int(),
  actions: z.array(MachineActionSchema).default([]),
});
export type RecoverResponse = z.infer<typeof RecoverResponseSchema>;

/**
 * daemon 回报动作执行结果。
 *
 * `result` 是「执行成功时能说清楚的事实」而不是「一句话成功」：
 * commitSha 让用户能自己去核对同步到的是哪个提交，discardedChanges 让用户
 * 知道本地改动有没有被 `git reset --hard` 丢掉 —— 后者是不可逆操作，
 * 不如实上报就是隐瞒。
 */
export const ActionResultSchema = z.object({
  actionId: IdSchema,
  status: z.enum(['done', 'failed']),
  result: z
    .object({
      ok: z.boolean(),
      /** 同步到的 commit；首次同步到空树时可能为 null */
      commitSha: z.string().nullable().optional(),
      /** 同步涉及的变更文件数；0 表示目标目录本来就是干净的 */
      filesChanged: z.number().int().optional(),
      dir: z.string().optional(),
      /**
       * 目标目录里原有的本地改动是否被丢弃（`git reset --hard` +
       * `git clean -fdx` 的后果）。**不可逆**，所以 daemon 必须如实上报。
       */
      discardedChanges: z.boolean().optional(),
      error: z.string().optional(),
    })
    .default({ ok: false }),
  /** 顶层 error —— 与 result.error 同义，便于按路径取而不必下钻 */
  error: z.string().optional(),
});
export type ActionResult = z.infer<typeof ActionResultSchema>;
