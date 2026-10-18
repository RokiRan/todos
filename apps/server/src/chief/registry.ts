import { z } from 'zod';
import { NOTIFICATION_EVENTS } from '@tds/protocol';
import type { ChiefToolHandler, ChiefToolRegistry } from './executor.js';
import { CHIEF_TOOLS } from './tools.js';
import { MCP_TOOLS } from '../mcp-tools.js';
import {
  clearWake,
  deleteMemory,
  listMemories,
  listWakes,
  saveMemory,
  setWake,
  unwatchTodo,
  watchTodo,
} from '../services/chief-memory.js';
import { askUser, getTeamUsage, listDocs, notifyUser } from '../services/chief-interaction.js';
import { createAgent, deleteAgents, updateAgent } from '../services/agents-admin.js';
import { createProject, updateProject } from '../services/projects-admin.js';
import { deleteSkills } from '../services/skill-deletion.js';
import {
  addProvider,
  deleteProviders,
  listProviders,
  updateProvider,
} from '../services/provider-admin.js';
import {
  connectRepo,
  listConnectedApps,
  setRemoteShell,
} from '../services/connection-registry.js';
import { deleteTodos, relayQuestion } from '../services/todo-lifecycle.js';
import { MODEL_APIS } from '@tds/protocol';

/**
 * Chief 专属工具的 registry —— 把 `services/*` 里的实现接到 `executor.ts` 的调度层。
 *
 * **MCP 面上的 31 个不在这里**：它们由 `routes/mcp.ts` 的 `executeTool` 执行，两边
 * 共用同一批服务函数，所以规则不会漂移。`GET /api/chief/tools` 用 `CHIEF_TOOLS`
 * （58 个）与本 registry 求差集，UI 据此显示接线状态。
 *
 * ## 参数从哪来
 *
 * handler 的 `args` 是**执行器传进来的原始具名参数**（`Record<string, unknown>`），
 * 所以每个 handler 第一件事是 zod 解析 —— 校验放在 handler 而不是散在路由里，
 * 这样任何调用方（HTTP / 将来 Chief 自己的 tool loop）都拿到同一套校验。
 *
 * ## 两种「身份」参数，来源不同
 *
 * `ctx` 只给 `actorId`（发起这次调用的用户）与 `teamId`。但记忆与唤醒这 8 个工具
 * 是**按 Chief 身份**组织的（表里要 `chiefId` + `agentId`），所以 handler 需要
 * 额外从 args 里收 `chiefId` / `agentId`。这两个值**必须由调用方给**：
 * 执行器不替它猜 —— 一个 Chief 挂了 agent 之后，凭空造一个 agentId 会把记忆挂到
 * 错的 agent 上。
 *
 * ## 未接线的工具
 *
 * `providers` `add_provider` `update_provider` `delete_providers` `connect_app`
 * `connect_repo` `set_remote_shell` `delete_todos` `relay_question` 这 9 个还没接
 * 实现（`chiefToolWiringStatus()` 会把这 9 个与「走 MCP 的 31 个」分开报）。执行器对它们回「declared but has no executor wired yet」，与「工具不存在」
 * 区分开 —— Chief 据此知道是「别调这个」还是「还没做」。
 */

// ── 参数 schema（逐工具的公开契约）────────────────────────────────────
const AgentCreateArgs = z.object({
  displayName: z.string().min(1),
  description: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  modelId: z.string().nullable().optional(),
  thinkingLevel: z.string().nullable().optional(),
  defaultSkillIds: z.array(z.string()).optional(),
  grants: z.record(z.string(), z.boolean()).optional(),
});

const AgentUpdateArgs = z.object({
  agentId: z.string().min(1),
  displayName: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  modelId: z.string().nullable().optional(),
  thinkingLevel: z.string().nullable().optional(),
  defaultSkillIds: z.array(z.string()).optional(),
  grants: z.record(z.string(), z.boolean()).optional(),
});

const AgentDeleteArgs = z.object({ agentIds: z.array(z.string().min(1)) });

const PROJECT_REPO_KINDS = ['github', 'gitlab', 'gitea', 'forgejo', 'bitbucket', 'other'] as const;

const ProjectCreateArgs = z.object({
  name: z.string().min(1),
  provider: z.enum(['external', 'platform']).optional(),
  repoKind: z.enum(PROJECT_REPO_KINDS).optional(),
  repoUrl: z.string().nullable().optional(),
  repoFullName: z.string().nullable().optional(),
  defaultBranch: z.string().optional(),
});

const ProjectUpdateArgs = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1).optional(),
  defaultBranch: z.string().optional(),
  description: z.string().nullable().optional(),
});

const SkillDeleteArgs = z.object({ skillIds: z.array(z.string().min(1)) });

const AddProviderArgs = z.object({
  kind: z.enum(['vendor', 'custom']),
  providerId: z.string().min(1),
  label: z.string().min(1),
  baseUrl: z.string().nullable().optional(),
  api: z.enum(MODEL_APIS),
  models: z.array(z.object({ id: z.string() }).passthrough()).optional(),
  // **明文 token 走 ctx.credentials（secure input card），不走 args** ——
  // 这类工具标了 handlesSecret，值不进 chat / transcript / args。
  username: z.string().optional(),
  skipVerify: z.boolean().optional(),
});

const UpdateProviderArgs = z.object({
  // 注意：这是 provider 表**主键**（row.id），不是 providerId slug
  providerId: z.string().min(1),
  label: z.string().min(1).optional(),
  baseUrl: z.string().nullable().optional(),
  api: z.enum(MODEL_APIS).optional(),
  models: z.array(z.object({ id: z.string() }).passthrough()).optional(),
});

const DeleteProvidersArgs = z.object({ providerIds: z.array(z.string().min(1)) });

const SetRemoteShellArgs = z.object({
  machineId: z.string().min(1),
  enabled: z.boolean(),
  tailnetAddr: z.string().nullable().optional(),
});

const ConnectRepoArgs = z.object({
  projectId: z.string().min(1),
  repoUrl: z.string().min(1),
  repoFullName: z.string().nullable().optional(),
  username: z.string().nullable().optional(),
  // token 同样走 ctx.credentials（handlesSecret）
});

const ConnectAppArgs = z.object({ identifier: z.string().optional() });

const DeleteTodosArgs = z.object({ todoIds: z.array(z.string().min(1)) });

const RelayQuestionArgs = z.object({
  todoId: z.string().min(1),
  question: z.string().min(1),
  options: z.array(z.object({ id: z.string().min(1), label: z.string().min(1), description: z.string().optional() })).optional(),
  allowFreeText: z.boolean().optional(),
  agentId: z.string().min(1),
  agentName: z.string().min(1),
});

// 记忆与唤醒按 Chief 组织 —— chiefId / agentId 必须由调用方给。
const ChiefScopedArgs = z.object({
  chiefId: z.string().min(1),
  agentId: z.string().min(1),
});

const MemorySaveArgs = ChiefScopedArgs.extend({
  title: z.string().min(1),
  content: z.string(),
  scope: z.enum(['team', 'project']),
  projectId: z.string().nullable().optional(),
  memoryId: z.string().optional(),
});
const MemoryDeleteArgs = ChiefScopedArgs.extend({ memoryId: z.string().min(1) });
const WakeArgs = ChiefScopedArgs.extend({
  threadId: z.string().min(1),
  todoId: z.string().min(1),
  fireAt: z.number().int(),
  source: z.string().optional(),
});
const WatchArgs = ChiefScopedArgs.extend({
  threadId: z.string().min(1),
  todoId: z.string().min(1),
});

const AskUserArgs = z.object({
  todoId: z.string().min(1),
  question: z.string().min(1),
  options: z.array(z.object({ id: z.string().min(1), label: z.string().min(1), description: z.string().optional() })).optional(),
  allowFreeText: z.boolean().optional(),
});
const NotifyUserArgs = z.object({
  todoId: z.string().min(1),
  event: z.enum(NOTIFICATION_EVENTS),
  payload: z.record(z.string(), z.unknown()).optional(),
});

/** 构造 Chief 工具 registry。handler 无状态，每次新建 —— 不需要单例。 */
export function chiefToolRegistry(): ChiefToolRegistry {
  const handlers: Record<string, ChiefToolHandler> = {
    // ── team 3 ──────────────────────────────────────────────────────
    create_agent: (ctx, args) => {
      const p = AgentCreateArgs.parse(args);
      return createAgent(ctx.db, { teamId: ctx.teamId, actorId: ctx.actorId, ...p });
    },
    update_agent: (ctx, args) => {
      const p = AgentUpdateArgs.parse(args);
      return updateAgent(ctx.db, {
        teamId: ctx.teamId,
        actorId: ctx.actorId,
        agentId: p.agentId,
        patch: {
          ...(p.displayName !== undefined ? { displayName: p.displayName } : {}),
          ...(p.description !== undefined ? { description: p.description } : {}),
          ...(p.provider !== undefined ? { provider: p.provider } : {}),
          ...(p.modelId !== undefined ? { modelId: p.modelId } : {}),
          ...(p.thinkingLevel !== undefined ? { thinkingLevel: p.thinkingLevel } : {}),
          ...(p.defaultSkillIds !== undefined ? { defaultSkillIds: p.defaultSkillIds } : {}),
          ...(p.grants !== undefined ? { grants: p.grants } : {}),
        },
      });
    },
    delete_agents: (ctx, args) => {
      const p = AgentDeleteArgs.parse(args);
      return deleteAgents(ctx.db, { teamId: ctx.teamId, agentIds: p.agentIds, actorId: ctx.actorId });
    },

    // ── board 2 ─────────────────────────────────────────────────────
    create_project: (ctx, args) => {
      const p = ProjectCreateArgs.parse(args);
      return createProject(ctx.db, { teamId: ctx.teamId, actorId: ctx.actorId, ...p });
    },
    update_project: (ctx, args) => {
      const p = ProjectUpdateArgs.parse(args);
      return updateProject(ctx.db, {
        teamId: ctx.teamId,
        actorId: ctx.actorId,
        projectId: p.projectId,
        patch: {
          ...(p.name !== undefined ? { name: p.name } : {}),
          ...(p.defaultBranch !== undefined ? { defaultBranch: p.defaultBranch } : {}),
          ...(p.description !== undefined ? { description: p.description } : {}),
        },
      });
    },

    // ── skill 1 ─────────────────────────────────────────────────────
    delete_skills: (ctx, args) => {
      const p = SkillDeleteArgs.parse(args);
      return deleteSkills(ctx.db, { teamId: ctx.teamId, skillIds: p.skillIds, actorId: ctx.actorId });
    },

    // ── memory 8 ────────────────────────────────────────────────────
    memories: (ctx, args) => {
      const p = ChiefScopedArgs.parse(args);
      return listMemories(ctx.db, { teamId: ctx.teamId, agentId: p.agentId });
    },
    save_memory: (ctx, args) => {
      const p = MemorySaveArgs.parse(args);
      return saveMemory(ctx.db, {
        teamId: ctx.teamId,
        chiefId: p.chiefId,
        agentId: p.agentId,
        title: p.title,
        content: p.content,
        scope: p.scope,
        ...(p.projectId !== undefined ? { projectId: p.projectId } : {}),
        ...(p.memoryId !== undefined ? { memoryId: p.memoryId } : {}),
      });
    },
    delete_memory: (ctx, args) => {
      const p = MemoryDeleteArgs.parse(args);
      return deleteMemory(ctx.db, {
        teamId: ctx.teamId,
        chiefId: p.chiefId,
        agentId: p.agentId,
        memoryId: p.memoryId,
      });
    },
    watch_todos: (ctx, args) => {
      const p = WatchArgs.parse(args);
      return watchTodo(ctx.db, {
        teamId: ctx.teamId,
        chiefId: p.chiefId,
        threadId: p.threadId,
        todoId: p.todoId,
      });
    },
    unwatch_todos: (ctx, args) => {
      const p = WatchArgs.parse(args);
      return unwatchTodo(ctx.db, {
        teamId: ctx.teamId,
        chiefId: p.chiefId,
        threadId: p.threadId,
        todoId: p.todoId,
      });
    },
    wakes: (ctx, args) => {
      const threadId = z.object({ threadId: z.string().min(1) }).partial().parse(args).threadId;
      return listWakes(ctx.db, {
        teamId: ctx.teamId,
        ...(threadId !== undefined ? { threadId } : {}),
      });
    },
    set_wake: (ctx, args) => {
      const p = WakeArgs.parse(args);
      return setWake(ctx.db, {
        teamId: ctx.teamId,
        chiefId: p.chiefId,
        threadId: p.threadId,
        todoId: p.todoId,
        fireAt: p.fireAt,
        ...(p.source !== undefined ? { source: p.source } : {}),
      });
    },
    clear_wake: (ctx, args) => {
      const p = WakeArgs.pick({ chiefId: true, threadId: true, todoId: true }).parse(args);
      return clearWake(ctx.db, {
        teamId: ctx.teamId,
        chiefId: p.chiefId,
        threadId: p.threadId,
        todoId: p.todoId,
      });
    },

    // ── infra 7（provider / 连接 / 远程 shell）────────────────────────
    providers: (ctx) => listProviders(ctx.db, ctx.teamId),
    add_provider: (ctx, args) => {
      const p = AddProviderArgs.parse(args);
      return addProvider(ctx.db, {
        teamId: ctx.teamId,
        actorId: ctx.actorId,
        kind: p.kind,
        providerId: p.providerId,
        label: p.label,
        api: p.api,
        ...(p.baseUrl !== undefined ? { baseUrl: p.baseUrl } : {}),
        ...(p.models !== undefined ? { models: p.models as never } : {}),
        ...(p.username !== undefined ? { username: p.username } : {}),
        ...(p.skipVerify !== undefined ? { skipVerify: p.skipVerify } : {}),
        // 明文 apiKey 只从 secure input card 来的 ctx.credentials 取，不从 args
        ...(ctx.credentials?.apiKey !== undefined ? { apiKey: ctx.credentials.apiKey } : {}),
      });
    },
    update_provider: (ctx, args) => {
      const p = UpdateProviderArgs.parse(args);
      return updateProvider(ctx.db, {
        teamId: ctx.teamId,
        actorId: ctx.actorId,
        providerId: p.providerId,
        patch: {
          ...(p.label !== undefined ? { label: p.label } : {}),
          ...(p.baseUrl !== undefined ? { baseUrl: p.baseUrl } : {}),
          ...(p.api !== undefined ? { api: p.api } : {}),
          ...(p.models !== undefined ? { models: p.models as never } : {}),
        },
        ...(ctx.credentials?.apiKey !== undefined ? { apiKey: ctx.credentials.apiKey } : {}),
      });
    },
    delete_providers: (ctx, args) => {
      const p = DeleteProvidersArgs.parse(args);
      return deleteProviders(ctx.db, {
        teamId: ctx.teamId,
        actorId: ctx.actorId,
        providerIds: p.providerIds,
      });
    },
    connect_app: (ctx, args) => {
      ConnectAppArgs.parse(args);   // 只读工具，参数仅用于校验形状
      // **只读**：recon 里 connect_app 的写入语义未确认（只有 OAuth 目录流程的描述，
      // 没有可执行的 API 契约），所以只暴露「已连接应用」列表。写路径走
      // add_mcp_server（有完整语义与测试）。见 services/connection-registry.ts 头注。
      return listConnectedApps(ctx.db, ctx.teamId);
    },
    connect_repo: (ctx, args) => {
      const p = ConnectRepoArgs.parse(args);
      const token = ctx.credentials?.token;
      if (!token) {
        // 凭据类工具缺 token 是调用方的问题，回报可归因的错误而不是让上游 401
        return Promise.reject(new Error('connect_repo requires a token credential from the secure input card'));
      }
      return connectRepo(ctx.db, {
        teamId: ctx.teamId,
        actorId: ctx.actorId,
        projectId: p.projectId,
        repoUrl: p.repoUrl,
        token,
        ...(p.repoFullName !== undefined ? { repoFullName: p.repoFullName } : {}),
        ...(p.username !== undefined ? { username: p.username } : {}),
      });
    },
    set_remote_shell: (ctx, args) => {
      const p = SetRemoteShellArgs.parse(args);
      return setRemoteShell(ctx.db, {
        teamId: ctx.teamId,
        actorId: ctx.actorId,
        machineId: p.machineId,
        enabled: p.enabled,
        ...(p.tailnetAddr !== undefined ? { tailnetAddr: p.tailnetAddr } : {}),
      });
    },

    // ── todo 2（不可逆删除 / agent 提问转发）─────────────────────────
    delete_todos: (ctx, args) => {
      const p = DeleteTodosArgs.parse(args);
      return deleteTodos(ctx.db, { teamId: ctx.teamId, actorId: ctx.actorId, todoIds: p.todoIds });
    },
    relay_question: (ctx, args) => {
      const p = RelayQuestionArgs.parse(args);
      return relayQuestion(ctx.db, {
        teamId: ctx.teamId,
        actorId: ctx.actorId,
        todoId: p.todoId,
        // 与 ask_user 的差别就在这个 type：转发的是 agent 的提问，不是 Chief 自己的
        agent: { id: p.agentId, name: p.agentName },
        question: p.question,
        options: p.options ?? [],
        ...(p.allowFreeText !== undefined ? { allowFreeText: p.allowFreeText } : {}),
      });
    },

    // ── interaction 4 ───────────────────────────────────────────────
    ask_user: (ctx, args) => {
      const p = AskUserArgs.parse(args);
      return askUser(ctx.db, {
        teamId: ctx.teamId,
        actorId: ctx.actorId,
        todoId: p.todoId,
        // `askedBy` 表达「是谁在问」：Chief 自己发起，所以 type 固定 chief。
        askedBy: { type: 'chief', id: ctx.actorId, name: 'Chief' },
        question: p.question,
        options: p.options ?? [],
        ...(p.allowFreeText !== undefined ? { allowFreeText: p.allowFreeText } : {}),
      });
    },
    notify_user: (ctx, args) => {
      const p = NotifyUserArgs.parse(args);
      return notifyUser(ctx.db, {
        teamId: ctx.teamId,
        actorId: ctx.actorId,
        todoId: p.todoId,
        event: p.event,
        triggerBy: 'chief',
        ...(p.payload !== undefined ? { payload: p.payload } : {}),
      });
    },
    usage: (ctx) => getTeamUsage(ctx.db, ctx.teamId),
    docs: (ctx) => listDocs(ctx.db, ctx.teamId),
  };

  return new Map(Object.entries(handlers));
}

/**
 * 接线状态 —— 给 `GET /api/chief/tools` 用。
 *
 * `unwired` 分两类，**必须分开报**：
 *   - **MCP 面的 31 个**：由 `routes/mcp.ts` 执行，Chief 通过 MCP 通道调得到。
 *     它们「不在本 registry」是**设计如此**，不是缺口。
 *   - **真缺口**：既不在 MCP 面、本 registry 也没接的（当前 9 个：`providers`
 *     `add_provider` `update_provider` `delete_providers` `connect_app`
 *     `connect_repo` `set_remote_shell` `delete_todos` `relay_question`）。
 *     执行器对它们回「declared but has no executor wired yet」。
 *
 * 混在一起报会让 UI 把「设计如此」显示成「没做」，进而催着去补已经有的东西。
 */
export function chiefToolWiringStatus(): {
  /** 已在本 registry 接线（MCP 面之外） */
  wired: string[];
  /** 不在 MCP 面、也没接线 —— 真缺口 */
  unwired: string[];
  /** 在 MCP 面上，由 `routes/mcp.ts` 执行 —— 不是缺口 */
  viaMcp: string[];
} {
  const registry = chiefToolRegistry();
  const wired: string[] = [];
  const unwired: string[] = [];
  const viaMcp: string[] = [];
  for (const t of CHIEF_TOOLS) {
    if (registry.has(t.name)) wired.push(t.name);
    else if (MCP_TOOL_NAMES.has(t.name)) viaMcp.push(t.name);
    else unwired.push(t.name);
  }
  return { wired, unwired, viaMcp };
}

/** MCP 面上 31 个工具名 —— 判断「走 MCP 通道」的依据。 */
const MCP_TOOL_NAMES: ReadonlySet<string> = new Set(MCP_TOOLS.map((t) => t.name));
