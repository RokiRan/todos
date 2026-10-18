/**
 * 权限模型。
 *
 * 文档实测规则（recon/docs/permissions.md，verbatim 行为）：
 *   - 4 个授权点：agent 工具 / machine 开关 / 人员角色 / API key
 *   - 默认**核心工具**无须授权：读改 workspace、运行 build 内命令、读团队 todo、
 *     问问题、通知、保存记忆
 *   - 默认**关闭**（opt-in，逐 agent 开启）：
 *     `push_branch` `merge_branch` `create_tag` `create_skill` `update_skill`
 *     `remote_shell` `Team secrets` `Connections`（每个 connection 一个开关）
 *   - 授权者是 team admin；Chief 可代用户授予但**仅在用户明确请求且用户本身是 admin**，
 *     **从不主动**授予
 *   - machine 开关：Builds / Remote shell / Runtimes（每个 runtime 一个）
 *   - 生效时机：agent 的**下个 turn 起**
 */

export const CORE_TOOLS = [
  'read_workspace',
  'write_workspace',
  'run_in_build',
  'read_team_todos',
  'ask_user',
  'notify',
  'save_memory',
] as const;
export type CoreTool = (typeof CORE_TOOLS)[number];

export const ELEVATED_TOOLS = [
  'push_branch',
  'merge_branch',
  'create_tag',
  'create_skill',
  'update_skill',
  'remote_shell',
  'team_secrets',
] as const;
export type ElevatedTool = (typeof ELEVATED_TOOLS)[number];

export type GrantMap = Partial<Record<ElevatedTool, boolean>> & {
  /** connectionId → 是否授权 */
  connections?: Record<string, boolean>;
};

export type Role = 'admin' | 'member';

export interface Actor {
  role: Role;
  /** 是否由 Chief 代表用户发起 */
  viaChief: boolean;
  /** 用户此前是否明确要求过这次授权 */
  userExplicitlyRequested: boolean;
}

export interface Decision {
  allowed: boolean;
  reason: string;
  /** 是否需要向用户展示确认卡 */
  requiresConfirmation: boolean;
}

/** 核心工具永远可用 */
export function canUseCoreTool(tool: CoreTool): Decision {
  return { allowed: true, reason: 'core tool is always available', requiresConfirmation: false };
}

/** 高影响工具必须显式授权 */
export function canUseElevatedTool(
  tool: ElevatedTool,
  grants: GrantMap,
  actor: Actor,
): Decision {
  if (actor.role !== 'admin') {
    return {
      allowed: false,
      reason: `只有 team admin 能授权 ${tool}`,
      requiresConfirmation: false,
    };
  }
  if (actor.viaChief && !actor.userExplicitlyRequested) {
    return {
      allowed: false,
      reason: 'Chief 绝不自行授予权限 —— 需用户明确请求',
      requiresConfirmation: true,
    };
  }
  if (grants[tool] !== true) {
    return {
      allowed: false,
      reason: `${tool} 未授权（默认关闭，需 admin 在 agent 的 Access 页开启）`,
      requiresConfirmation: true,
    };
  }
  return { allowed: true, reason: `${tool} 已授权`, requiresConfirmation: false };
}

/** connection 授权：每个 connection 一个开关，每 agent ≤10 */
export function canUseConnection(
  connectionId: string,
  grants: GrantMap,
  actor: Actor,
  grantedCount: number,
): Decision {
  if (actor.role !== 'admin') {
    return { allowed: false, reason: '只有 team admin 能授权连接', requiresConfirmation: false };
  }
  if (actor.viaChief && !actor.userExplicitlyRequested) {
    return { allowed: false, reason: 'Chief 绝不自行授予连接权限', requiresConfirmation: true };
  }
  if (grants.connections?.[connectionId] !== true) {
    return {
      allowed: false,
      reason: `连接 ${connectionId} 未授权给该 agent`,
      requiresConfirmation: true,
    };
  }
  if (grantedCount >= 10) {
    return {
      allowed: false,
      reason: '每个 agent 最多授权 10 个连接（Free 档上限）',
      requiresConfirmation: false,
    };
  }
  return { allowed: true, reason: `连接 ${connectionId} 已授权`, requiresConfirmation: false };
}

/** machine 开关 */
export interface MachineSwitches {
  builds: boolean;
  remoteShell: boolean;
  runtimes: Record<string, boolean>;
}

export function canRunOn(
  runtimeId: string,
  switches: MachineSwitches,
  actor: Actor,
): Decision {
  if (!switches.builds) {
    return { allowed: false, reason: '该机器已关闭接新 build', requiresConfirmation: false };
  }
  if (switches.runtimes[runtimeId] === false) {
    return {
      allowed: false,
      reason: `该机器已关闭 ${runtimeId} runtime`,
      requiresConfirmation: false,
    };
  }
  // machine 开关是配置动作：只有 admin 能改。Chief 代表用户发起时，
  // 必须有用户的明确请求才放行 —— 它绝不自行改机器配置。
  if (actor.viaChief && !actor.userExplicitlyRequested) {
    return {
      allowed: false,
      reason: 'Chief 不能自行改 machine 开关 —— 需用户明确请求',
      requiresConfirmation: true,
    };
  }
  return { allowed: true, reason: 'machine accepts builds and this runtime', requiresConfirmation: false };
}

/** 人员角色能力矩阵（文档：member 只读或受限） */
export type Capability =
  | 'view_board'
  | 'manage_board'
  | 'configure_providers'
  | 'configure_connections'
  | 'configure_skills'
  | 'configure_secrets'
  | 'configure_agents'
  | 'configure_machines'
  | 'project_git_credentials'
  | 'remove_agent';

const CAPABILITIES: Record<Capability, Role[]> = {
  view_board: ['admin', 'member'],
  manage_board: ['admin', 'member'],
  configure_providers: ['admin'],
  configure_connections: ['admin'],
  configure_skills: ['admin'],
  configure_secrets: ['admin'],
  configure_agents: ['admin'],
  configure_machines: ['admin'],
  project_git_credentials: ['admin'],
  remove_agent: ['admin'],
};

export function hasCapability(role: Role, cap: Capability): boolean {
  return CAPABILITIES[cap].includes(role);
}

/**
 * schedule 与 rewind 跟 todo owner 而非 team role（文档明确）。
 * 只有 todo 当前 owner 能改它的 schedule 或 rewind。
 */
export function canManageTodoSchedule(
  actorMemberId: string,
  todoOwnerMemberId: string,
): Decision {
  if (actorMemberId === todoOwnerMemberId) {
    return { allowed: true, reason: 'todo owner can manage its schedule', requiresConfirmation: false };
  }
  return {
    allowed: false,
    reason: '只有 todo 当前 owner 能改它的 schedule（即使是 team admin）',
    requiresConfirmation: false,
  };
}
