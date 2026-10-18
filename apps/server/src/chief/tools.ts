/**
 * Chief 工具面。
 *
 * 实测数据（recon/03-app-api.md §3）：原站 Chief 有 **58 个工具**，
 * 从 `GET /api/teams/{id}/chief/threads` 的 `toolDefHashes` 字段抽出，
 * 键名即工具名。分成 7 组。
 *
 * 这里只声明**分类与元数据**（标签、是否不可逆、是否需要授权），
 * 真正的执行在 chief/executor.ts 与各业务模块。
 *
 * 为什么把「不可逆」显式标出来：文档铁律是
 *   「Chief 修改 agent 任何 irreversible 操作（删除 agent/skill/secret/
 *     connection/model provider/todo）必须以 confirmation card 让用户点确认；
 *     nothing is deleted until you confirm」
 * 这是防误删的最后一道闸门，不能靠调用方自觉。
 */

export type ChiefToolGroup =
  | 'todo'          // 待办编排
  | 'board'         // 看板与仓库
  | 'team'          // 团队成员
  | 'skill'
  | 'infra'         // 机器 / provider / 连接 / secret
  | 'memory'        // 记忆与唤醒
  | 'schedule'
  | 'interaction';  // 交互与杂项

export interface ChiefToolSpec {
  name: string;
  group: ChiefToolGroup;
  /** 不可逆操作：调用前必须弹 confirmation card */
  irreversible?: boolean;
  /** 需要 admin 授权（多数是 false，少数高影响为 true） */
  needsAdminGrant?: boolean;
  /** 凭据类：值绝不进 chat，走 secure input card */
  handlesSecret?: boolean;
  /** 一句话说明 */
  summary: string;
}

/**
 * 58 个工具的完整清单（键名与原站逐字一致，来自 recon/03-app-api.md §3）。
 * 顺序按能力分组，不影响功能，仅便于阅读。
 */
export const CHIEF_TOOLS: ChiefToolSpec[] = [
  // ── 待办编排 ────────────────────────────────────────────
  { name: 'create_todo', group: 'todo', summary: '创建 todo' },
  { name: 'update_todo', group: 'todo', summary: '更新 todo 的标题/规格/标签' },
  { name: 'delete_todos', group: 'todo', irreversible: true, summary: '删除 todo（不可逆）' },
  { name: 'todos', group: 'todo', summary: '读看板' },
  { name: 'complete_todos', group: 'todo', summary: '完成 todo（Review 闸门主按钮）' },
  { name: 'close_todos', group: 'todo', summary: '搁置 todo' },
  { name: 'reopen_todos', group: 'todo', summary: '重开 todo' },
  { name: 'merge_builds', group: 'todo', summary: '执行合并' },
  { name: 'cancel_builds', group: 'todo', summary: '取消 build' },
  { name: 'confirm_builds', group: 'todo', summary: '批准计划（Confirm 闸门主按钮）' },
  { name: 'run_builds', group: 'todo', summary: '启动 build' },
  { name: 'run_review', group: 'todo', summary: '发起 AI 交叉评审' },
  { name: 'relay_question', group: 'todo', summary: '转发 agent 的问题到人类' },
  { name: 'message_todo', group: 'todo', summary: '给 todo 发消息' },

  // ── 看板与仓库 ──────────────────────────────────────────
  { name: 'projects', group: 'board', summary: '读项目' },
  { name: 'create_project', group: 'board', summary: '创建项目' },
  { name: 'update_project', group: 'board', summary: '更新项目设置' },
  { name: 'issues', group: 'board', summary: '读 GitHub issues' },
  { name: 'pull_requests', group: 'board', summary: '读 PR 及其 merge state' },
  { name: 'workflow_runs', group: 'board', summary: '读 CI workflow runs' },

  // ── 团队成员 ────────────────────────────────────────────
  { name: 'agents', group: 'team', summary: '读 agent 名册' },
  { name: 'create_agent', group: 'team', summary: '创建 agent' },
  { name: 'update_agent', group: 'team', summary: '更新 agent 配置' },
  { name: 'delete_agents', group: 'team', irreversible: true, summary: '删除 agent（不可逆）' },

  // ── 技能 ────────────────────────────────────────────────
  { name: 'skills', group: 'skill', summary: '读技能库' },
  { name: 'delete_skills', group: 'skill', irreversible: true, needsAdminGrant: true, summary: '删除技能（不可逆）' },

  // ── 基础设施 ────────────────────────────────────────────
  { name: 'machines', group: 'infra', summary: '读机器名册与在线状态' },
  { name: 'providers', group: 'infra', summary: '读模型 provider' },
  { name: 'add_provider', group: 'infra', handlesSecret: true, needsAdminGrant: true, summary: '添加 provider（key 走输入卡）' },
  { name: 'update_provider', group: 'infra', handlesSecret: true, needsAdminGrant: true, summary: '更新 provider' },
  { name: 'delete_providers', group: 'infra', irreversible: true, needsAdminGrant: true, summary: '删除 provider（不可逆）' },
  { name: 'mcp_servers', group: 'infra', summary: '读 MCP 连接' },
  { name: 'add_mcp_server', group: 'infra', handlesSecret: true, needsAdminGrant: true, summary: '添加 MCP 连接' },
  { name: 'update_mcp_server', group: 'infra', handlesSecret: true, needsAdminGrant: true, summary: '更新 MCP 连接' },
  { name: 'delete_mcp_servers', group: 'infra', irreversible: true, needsAdminGrant: true, summary: '删除 MCP 连接（不可逆）' },
  { name: 'secrets', group: 'infra', handlesSecret: true, summary: '读 secret 名称（不含值，member 也可读）' },
  { name: 'set_secret', group: 'infra', handlesSecret: true, needsAdminGrant: true, summary: '设置 secret（值走输入卡）' },
  { name: 'delete_secrets', group: 'infra', irreversible: true, needsAdminGrant: true, summary: '删除 secret（不可逆）' },
  { name: 'connect_app', group: 'infra', handlesSecret: true, needsAdminGrant: true, summary: 'OAuth 连接应用' },
  { name: 'connect_repo', group: 'infra', handlesSecret: true, needsAdminGrant: true, summary: '连接 Git 仓库' },
  { name: 'set_remote_shell', group: 'infra', needsAdminGrant: true, summary: '开关机器的 remote shell' },

  // ── 记忆与唤醒 ──────────────────────────────────────────
  { name: 'save_memory', group: 'memory', summary: '保存记忆' },
  { name: 'delete_memory', group: 'memory', summary: '删除记忆' },
  { name: 'memories', group: 'memory', summary: '按 id 读记忆全文' },
  { name: 'watch_todos', group: 'memory', summary: 'watch todo' },
  { name: 'unwatch_todos', group: 'memory', summary: '取消 watch' },
  { name: 'set_wake', group: 'memory', summary: '设置一次性定时唤醒' },
  { name: 'clear_wake', group: 'memory', summary: '清除定时唤醒' },
  { name: 'wakes', group: 'memory', summary: '读定时唤醒列表' },

  // ── 调度 ────────────────────────────────────────────────
  { name: 'schedule_todo', group: 'schedule', summary: '建定时规则' },
  { name: 'unschedule_todo', group: 'schedule', summary: '删定时规则' },
  { name: 'schedules', group: 'schedule', summary: '读定时规则' },

  // ── 交互与杂项 ──────────────────────────────────────────
  { name: 'ask_user', group: 'interaction', summary: '向人类提问' },
  { name: 'conversation', group: 'interaction', summary: '读某个 build 的对话' },
  { name: 'notify_user', group: 'interaction', summary: '给人类发通知' },
  { name: 'usage', group: 'interaction', summary: '读 token 用量' },
  { name: 'docs', group: 'interaction', summary: '查产品文档' },
  { name: 'attachment', group: 'interaction', summary: '读附件' },
];

/** 静态查表：工具名 → 规格 */
const BY_NAME: Record<string, ChiefToolSpec> = Object.fromEntries(
  CHIEF_TOOLS.map((t) => [t.name, t]),
);

export function chiefToolSpec(name: string): ChiefToolSpec | undefined {
  return BY_NAME[name];
}

/** 某次调用是否需要 confirmation card */
export function requiresConfirmation(name: string): boolean {
  return BY_NAME[name]?.irreversible === true;
}

/** 凭据类工具：值绝不能进 chat */
export function handlesSecret(name: string): boolean {
  return BY_NAME[name]?.handlesSecret === true;
}

/** 注入到 prompt 里的工具摘要（稳定字符串，利于 prefix cache） */
export function toolSummaryText(): string {
  const byGroup = new Map<ChiefToolGroup, string[]>();
  for (const t of CHIEF_TOOLS) {
    const list = byGroup.get(t.group) ?? [];
    list.push(t.name);
    byGroup.set(t.group, list);
  }
  return [...byGroup.entries()]
    .map(([group, names]) => `- ${group}: ${names.join(', ')}`)
    .join('\n');
}

export const CHIEF_TOOL_COUNT = CHIEF_TOOLS.length;
