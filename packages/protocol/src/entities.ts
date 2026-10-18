import { z } from 'zod';
import { TODO_PHASES, DOC_KINDS } from './enums.js';

/**
 * 领域实体 —— 字段名与形状全部来自 2026-10-16 登录态实测
 * （recon/03-app-api.md §2），不是文档推测。
 *
 * 实测纠偏点：
 *  - user 的主键字段是 `id`，displayName 大写 N
 *  - agent 用 `provider` 而非 `runtime`；actor 上还有 `activeTaskCount`
 *  - todo 的描述字段叫 `spec`，人类编号叫 `seqNum`
 *  - member 带 `v` 乐观锁版本号
 */

export const UserSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  status: z.enum(['active', 'suspended']).default('active'),
  locale: z.string().default('en'),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type User = z.infer<typeof UserSchema>;

export const TeamSchema = z.object({
  id: z.string(),
  name: z.string(),
  plan: z.enum(['free']).default('free'),
  storageQuota: z.number().int().default(1073741824), // Free 1GB
  createdAt: z.number().int(),
});
export type Team = z.infer<typeof TeamSchema>;

/** Free 档容量上限 —— 决定 API 层的校验 */
export const FREE_LIMITS = {
  agents: 5,
  ownMachines: 1,
  projects: 6,
  storageBytes: 1024 * 1024 * 1024,
  secretsPerScope: 50,
  connectionsPerTeam: 20,
  connectionsPerAgent: 10,
  defaultSkillsPerAgent: 10,
  openTodosPerProject: 400,
  memoriesPerAgent: 100,
  memoryInjectChars: 10_000,
  scheduleRulesPerTeam: 10,
  maxConcurrentPerMachine: 10,
  defaultConcurrency: 6,
} as const;

/** agent 的高影响工具授权（默认全关，需 team admin 逐项开启） */
export const AGENT_GRANTS = [
  'push_branch',
  'merge_branch',
  'create_tag',
  'create_skill',
  'update_skill',
  'remote_shell',
  'team_secrets',
] as const;
export type AgentGrant = (typeof AGENT_GRANTS)[number];

export const AgentSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  displayName: z.string(),
  description: z.string().max(800).nullable(),   // 文档硬上限
  provider: z.string().nullable(),              // 实测字段名
  modelId: z.string().nullable(),
  thinkingLevel: z.string().nullable(),
  defaultSkillIds: z.array(z.string()).max(FREE_LIMITS.defaultSkillsPerAgent).default([]),
  grants: z.record(z.boolean()).default({}),
  activeTaskCount: z.number().int().default(0),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  deletedAt: z.number().int().nullable(),
});
export type Agent = z.infer<typeof AgentSchema>;

export const MachineSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  name: z.string(),
  deviceId: z.string(),
  buildEnabled: z.boolean().default(true),
  shellEnabled: z.boolean().default(false),
  maxConcurrentTasks: z.number().int().min(1).max(10).default(6),
  cliVersion: z.string().nullable(),
  workspacesDir: z.string().nullable(),
  runtimes: z.array(z.string()).default([]),
  disabledRuntimes: z.array(z.string()).default([]),
  isOnline: z.boolean().default(false),
  lastHeartbeatAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Machine = z.infer<typeof MachineSchema>;

/** runtime 订阅额度探测快照（实测形状） */
export const RuntimeUsageSchema = z.object({
  models: z
    .array(z.object({ id: z.string(), label: z.string(), effortLevels: z.array(z.string()).default([]) }))
    .default([]),
  fetchedAt: z.number().int(),
  windows: z.array(z.unknown()).default([]),
  error: z.string().nullable(),
  account: z.object({ id: z.string().nullable(), plan: z.string().nullable(), email: z.string().nullable() }),
  status: z.enum(['ok', 'signed_out', 'error', 'no_limits']),
});
export type RuntimeUsage = z.infer<typeof RuntimeUsageSchema>;

export const ProjectSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  name: z.string(),
  /**
   * MVP 只做 external（recon/04-stack.md §3）。
   * 保留 'platform' 枚举位以便将来自建 git 服务。
   */
  provider: z.enum(['external', 'platform']).default('external'),
  repoKind: z.enum(['github', 'gitlab', 'gitea', 'forgejo', 'bitbucket', 'other']).default('other'),
  repoFullName: z.string().nullable(),
  repoUrl: z.string().nullable(),
  defaultBranch: z.string().default('main'),
  description: z.string().nullable(),
  iconUrl: z.string().nullable(),
  nextSeqNum: z.number().int().default(1),
  createdAt: z.number().int(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const TodoSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  seqNum: z.number().int(),
  ownerMemberId: z.string(),
  agentId: z.string().nullable(),
  title: z.string(),
  spec: z.string().nullable(),          // 实测：描述字段就叫 spec
  tagIds: z.array(z.string()).default([]),
  phase: z.enum(TODO_PHASES).default('todo'),
  planFirst: z.boolean().default(true),
  separatePlanBuild: z.boolean().default(false),
  withChecklist: z.boolean().default(false),
  // 创建者身份（2026-10-18 新增）：看板筛选「总管或 Agent 创建」需要此字段。
  //   - 'user'   REST 写路径（dashboard / new-todo / 看板 + 按钮）
  //   - 'chief'  Chief 在 chief_thread 对话里被派工时
  //   - 'agent'  MCP 工具面 create_todo 由模型代发
  // 与 `db/schema.ts#todos.createdByType` 字面对齐 —— DB 层 CHECK 约束
  // 也是这三个值。迁移 `db/drizzle/0004_todo_created_by_type.sql` 把
  // 既有行回填成 `'user'`，所以**前端拿到老 todo 时此字段不会是 null**。
  createdByType: z.enum(['user', 'chief', 'agent']).default('user'),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Todo = z.infer<typeof TodoSchema>;

/** build = 一次运行。id 同时就是分支名 `tds/conv-<id>` */
export const BuildSchema = z.object({
  id: z.string(),
  todoId: z.string(),
  n: z.number().int(),
  branch: z.string(),
  prevPhase: z.enum(TODO_PHASES).nullable(),
  triggerSource: z.enum(['user', 'chief', 'agent', 'schedule']).default('user'),
  pinnedMachineId: z.string().nullable(),
  agentId: z.string(),
  planDocId: z.string().nullable(),
  changesDocId: z.string().nullable(),
  prUrl: z.string().nullable(),
  prNumber: z.number().int().nullable(),
  diffHash: z.string().nullable(),
  errorMessage: z.string().nullable(),
  withPlan: z.boolean().default(false),
  withChecklist: z.boolean().default(false),
  branchPushedAt: z.number().int().nullable(),
  pushError: z.string().nullable(),
  pendingRestore: z
    .object({
      sessionLeafEntryId: z.string(),
      commitSha: z.string(),
      sessionId: z.string(),
    })
    .nullable(),
  session: z
    .object({ runtime: z.string(), id: z.string(), openedAt: z.number().int() })
    .default({ runtime: '', id: '', openedAt: 0 }),
  usageByModel: z.array(z.record(z.unknown())).default([]),
  createdAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
});
export type Build = z.infer<typeof BuildSchema>;

/**
 * 消息。实测：content 永远是 string，system 消息里装 JSON 信封
 * `{"kind":"machine_selected"|"turn_retried"|...}`
 */
export const MessageSchema = z.object({
  id: z.string(),
  buildId: z.string(),
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  phase: z.string().nullable(),
  triggerBy: z.enum(['user', 'chief', 'agent']).nullable(),
  content: z.string(),
  agent: z.record(z.unknown()).nullable(),
  isError: z.boolean().default(false),
  durationMs: z.number().int().nullable(),
  seq: z.number().int(),
  createdAt: z.number().int(),
});
export type Message = z.infer<typeof MessageSchema>;

export const DocumentSchema = z.object({
  id: z.string(),
  buildId: z.string(),
  kind: z.enum(DOC_KINDS),
  version: z.number().int().default(1),
  payload: z.record(z.unknown()).default({}),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Document = z.infer<typeof DocumentSchema>;

/** 模型 provider。凭据永不回传 —— 这里没有 apiKey 字段，是刻意的。 */
export const ProviderSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  kind: z.enum(['builtin_api_key', 'subscription', 'custom']),
  providerId: z.string(),
  label: z.string(),
  baseUrl: z.string().nullable(),
  api: z.string().nullable(),
  compat: z.record(z.unknown()).default({}),
  /** 对象数组，不是字符串数组（字符串数组会 422 —— 文档实测坑） */
  models: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        input: z.array(z.string()).default(['text']),
        contextWindow: z.number().int().optional(),
        maxTokens: z.number().int().optional(),
        reasoning: z.boolean().optional(),
        thinkingLevelMap: z.record(z.string()).optional(),
      }),
    )
    .default([]),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Provider = z.infer<typeof ProviderSchema>;

/**
 * Mentions 结构化引用 —— 2026-10-18 新增。
 *
 * 原站语义：composer 里 `Mention` 按钮 + prefix (`@ agent or member, # todo,
 * / skill, ~ project, & machine`) 写入的是「structured reference chip rather
 * than plain text」，让 agent **resolves the exact ID instead of guessing**。
 * 见 `D:/AI/todos/recon-live/docs-conversation.md:34`。
 *
 * 这里只定**形状**，不写数据库映射 —— 映射在 `packages/db/src/schema.ts` 的
 * `build_message_mention` 表里（关联表，与 `chief_message` 同源）。
 */
export const MENTION_KINDS = [
  'agent',
  'member',
  'todo',
  'skill',
  'project',
  'machine',
] as const;
export type MentionKind = (typeof MENTION_KINDS)[number];

/** 与原站 prefix 表一一对应：{@, #, /, ~, &} ↔ {agent/member, todo, skill, project, machine}。 */
export const MENTION_PREFIXES = ['@', '#', '/', '~', '&'] as const;
export type MentionPrefix = (typeof MENTION_PREFIXES)[number];

export const MentionRefSchema = z.object({
  kind: z.enum(MENTION_KINDS),
  /** 前端 chip 字符：`@ | # | / | ~ | &`，与 `kind` 必须一致（服务路由层校验） */
  prefix: z.enum(MENTION_PREFIXES),
  /** 被引用对象的主键（agent.id / member.id / todo.id / skill.id / project.id / machine.id） */
  refId: z.string().min(1),
  /** 写时展示名快照 —— 与原对象解耦，避免改名/删除后 chip 显示错乱 */
  label: z.string().min(1).max(200),
});
export type MentionRef = z.infer<typeof MentionRefSchema>;

/** 关联表行（从 `build_message_mention` 读出的形状；id 必带，createdAt 必带）。 */
export const TodoMentionSchema = MentionRefSchema.extend({
  id: z.string(),
  messageId: z.string(),
  buildId: z.string(),
  createdAt: z.number().int(),
});
export type TodoMention = z.infer<typeof TodoMentionSchema>;
