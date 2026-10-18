import { fitMemories, quota } from '@tds/protocol';

/**
 * Memory 注入编排。
 *
 * 文档实测规则（recon/docs/memory.md & context.md，verbatim 行为）：
 *   - 每 agent ≤100 条；每轮注入预算 ≤10,000 字符
 *   - 超出预算时**旧条目降为 title-only index**，agent 可用 memories 工具按需取全文
 *   - scope：Team-wide 或单 Project；build turn 注入「项目内 + Team-wide」
 *   - 同名时 project 内优先于 team
 *   - 私有：agent 互不可读；跨 agent 共享走 Skill
 *   - expiresAt 到期停止注入，并在下次 save 时清理
 *   - 禁止存 secret / credential
 */

export interface MemoryRecord {
  id: string;
  agentId: string;
  scope: 'team' | 'project';
  projectId: string | null;
  title: string;
  content: string;
  createdAt: number;
  expiresAt: number | null;
}

/** 明显像凭据的内容不该被存（文档禁止） */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9]{16,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /tds_[A-Za-z0-9_-]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(password|passwd|api[_-]?key|secret[_-]?key|access[_-]?token)\s*[:=]\s*\S{8,}/i,
];

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

/** 写入前校验：长度上限 + 凭据检测 */
export function validateMemory(input: {
  title: string;
  content: string;
  existingCount: number;
}): ValidationResult {
  if (input.title.length > 80) {
    return { ok: false, reason: `标题超限 ${input.title.length}/80 字符` };
  }
  if (input.content.length > 1200) {
    return { ok: false, reason: `内容超限 ${input.content.length}/1200 字符` };
  }
  const countCheck = quota.agentMemories(input.existingCount);
  if (!countCheck.ok) {
    return { ok: false, reason: countCheck.message };
  }
  const combined = `${input.title}\n${input.content}`;
  for (const p of SECRET_PATTERNS) {
    if (p.test(combined)) {
      return { ok: false, reason: '内容疑似包含凭据，禁止存入记忆' };
    }
  }
  return { ok: true };
}

/** 选出生效的条目：排除过期 + 按 scope 优先级 */
export function selectMemories(
  all: MemoryRecord[],
  opts: { agentId: string; projectId: string | null; now: number },
): MemoryRecord[] {
  const mine = all.filter((m) => m.agentId === opts.agentId);

  // 过期条目停止注入
  const alive = mine.filter((m) => m.expiresAt === null || m.expiresAt > opts.now);

  // 项目内的 + team-wide 的
  const relevant = alive.filter(
    (m) => m.scope === 'team' || (m.scope === 'project' && m.projectId === opts.projectId),
  );

  // 同名（按 title）时 project 优先
  const byTitle = new Map<string, MemoryRecord>();
  for (const m of relevant) {
    const existing = byTitle.get(m.title);
    if (!existing) {
      byTitle.set(m.title, m);
      continue;
    }
    const existingIsProject = existing.scope === 'project';
    const incomingIsProject = m.scope === 'project';
    if (incomingIsProject && !existingIsProject) byTitle.set(m.title, m);
  }

  // 新近的优先注入 —— 越相关越靠前
  return [...byTitle.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export interface InjectedMemory {
  id: string;
  title: string;
  content: string;
}

/** 渲染成注入到系统提示里的文本块 */
export function renderInjected(
  records: MemoryRecord[],
): { text: string; injectedCount: number; downgradedCount: number } {
  const { injected, downgraded } = fitMemories(
    records.map((r) => ({ id: r.id, title: r.title, content: r.content })),
  );

  if (injected.length === 0) {
    return { text: '', injectedCount: 0, downgradedCount: downgraded.length };
  }

  const lines = ['## Memory', ''];
  for (const m of injected) {
    lines.push(`### ${m.title}`);
    lines.push(m.content);
    lines.push('');
  }
  if (downgraded.length > 0) {
    lines.push(
      `（另有 ${downgraded.length} 条记忆因上下文预算未注入，` +
        '需要时用 memories 工具按 id 取全文：' +
        downgraded.map((d) => d.title).join('、') +
        '）',
    );
  }

  return { text: lines.join('\n'), injectedCount: injected.length, downgradedCount: downgraded.length };
}

/** 清理到期条目 —— 文档：下次 save 时清理 */
export function purgeExpired(all: MemoryRecord[], now: number): {
  kept: MemoryRecord[];
  purged: MemoryRecord[];
} {
  const kept: MemoryRecord[] = [];
  const purged: MemoryRecord[] = [];
  for (const m of all) {
    if (m.expiresAt !== null && m.expiresAt <= now) purged.push(m);
    else kept.push(m);
  }
  return { kept, purged };
}
