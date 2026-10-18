import { FREE_LIMITS } from './entities.js';

/**
 * Free 档容量校验。
 *
 * 文档实测上限（recon/docs/teams.md & mcp-servers.md & schedules.md，verbatim）：
 *   - agents ≤ 5
 *   - own machines ≤ 1
 *   - projects ≤ 6
 *   - 每 project open todo ≤ 400
 *   - 每 team secret ≤ 50（每个 scope 各算）
 *   - 每 team connection ≤ 20（catalog + custom 合计）
 *   - 每 agent connection ≤ 10
 *   - 每 agent 默认 skill ≤ 10
 *   - 每 agent memory ≤ 100
 *   - 每 team schedule 规则 ≤ 10
 *   - 单 skill ≤ 10MB、≤ 256 文件
 *   - 每条消息附件 ≤ 5（图 ≤5MB，文档 ≤20MB）
 *   - storage ≤ 1GB
 *
 * 降级时超额项被标 locked 而非删除（先锁离线机器，再锁最近加的）。
 * MVP 不实现降级 —— 超过即拒绝。
 */

export interface QuotaCheck {
  ok: boolean;
  limit: number;
  current: number;
  message: string;
}

function check(name: string, current: number, limit: number, unit = ''): QuotaCheck {
  const ok = current < limit;
  return {
    ok,
    limit,
    current,
    message: ok
      ? `${name}: ${current}/${limit}${unit}`
      : `${name} 已达 Free 上限 ${limit}${unit}，请先删除或升级`,
  };
}

export const quota = {
  agents: (current: number) => check('Agent 数量', current, FREE_LIMITS.agents, ' 个'),
  ownMachines: (current: number) => check('自有机器', current, FREE_LIMITS.ownMachines, ' 台'),
  projects: (current: number) => check('项目数', current, FREE_LIMITS.projects, ' 个'),
  openTodos: (current: number) => check('未完成 todo', current, FREE_LIMITS.openTodosPerProject, ' 个'),
  secrets: (current: number) => check('Secret', current, FREE_LIMITS.secretsPerScope, ' 条'),
  connections: (current: number) => check('连接', current, FREE_LIMITS.connectionsPerTeam, ' 个'),
  agentConnections: (current: number) => check('Agent 授权连接', current, FREE_LIMITS.connectionsPerAgent, ' 个'),
  agentDefaultSkills: (current: number) => check('Agent 默认 skill', current, FREE_LIMITS.defaultSkillsPerAgent, ' 个'),
  agentMemories: (current: number) => check('Agent 记忆', current, FREE_LIMITS.memoriesPerAgent, ' 条'),
  schedules: (current: number) => check('定时规则', current, FREE_LIMITS.scheduleRulesPerTeam, ' 条'),
  roleDescription: (text: string) => {
    const len = text.length;
    return {
      ok: len <= 800,
      limit: 800,
      current: len,
      message: len <= 800 ? `角色描述 ${len}/800 字符` : `角色描述超限 ${len}/800 字符`,
    };
  },
  skillSize: (bytes: number, files: number) => {
    const sizeOk = bytes <= 10 * 1024 * 1024;
    const filesOk = files <= 256;
    const ok = sizeOk && filesOk;
    const detail: string[] = [];
    if (!sizeOk) detail.push(`${(bytes / 1048576).toFixed(1)}MB 超过 10MB`);
    if (!filesOk) detail.push(`${files} 个文件超过 256 个`);
    return {
      ok,
      limit: 10 * 1024 * 1024,
      current: bytes,
      message: ok
        ? `Skill ${(bytes / 1024).toFixed(0)}KB / ${files} 文件`
        : `Skill 超限：${detail.join('，')}`,
    };
  },
  attachments: (count: number) => check('消息附件', count, 5, ' 个'),
  storage: (bytes: number) => {
    const ok = bytes <= FREE_LIMITS.storageBytes;
    return {
      ok,
      limit: FREE_LIMITS.storageBytes,
      current: bytes,
      message: ok
        ? `存储 ${(bytes / 1048576).toFixed(1)}MB / 1GB`
        : `存储已满 ${(bytes / 1073741824).toFixed(2)}GB / 1GB`,
    };
  },
  machineConcurrency: (value: number) => {
    const ok = value >= 1 && value <= FREE_LIMITS.maxConcurrentPerMachine;
    return {
      ok,
      limit: FREE_LIMITS.maxConcurrentPerMachine,
      current: value,
      message: ok ? `并发 ${value}` : `并发必须是 1–${FREE_LIMITS.maxConcurrentPerMachine} 的整数`,
    };
  },
} as const;

/** 取第一个不满足的配额检查，全满足则返回 null */
export function firstViolation(checks: QuotaCheck[]): QuotaCheck | null {
  return checks.find((c) => !c.ok) ?? null;
}

/** memory 每轮注入预算：超了旧条目降为 title-only index（文档行为） */
export const MEMORY_INJECT_BUDGET = FREE_LIMITS.memoryInjectChars;

/** 按注入预算裁剪记忆条目，返回应注入的条目与被降级的条目 */
export function fitMemories<T extends { title: string; content: string }>(
  entries: T[],
): { injected: T[]; downgraded: T[] } {
  const injected: T[] = [];
  let used = 0;
  for (const e of entries) {
    const cost = e.title.length + e.content.length;
    if (used + cost > MEMORY_INJECT_BUDGET) break;
    injected.push(e);
    used += cost;
  }
  return { injected, downgraded: entries.slice(injected.length) };
}
