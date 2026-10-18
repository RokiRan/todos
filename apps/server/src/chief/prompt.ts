/**
 * Chief 的 prompt 构造与上下文预算。
 *
 * 文档实测行为（recon/docs/chief.md，verbatim）：
 *   「Chief 每轮向模型发送三段：固定段（角色指令 + 工具定义 + charter + memory，
 *     通常 20k–30k tokens）、topic 历史、本轮（board 变更 digest + 用户消息）」
 *
 * 也就是说每轮都要重发固定段 —— 20k~30k tokens 起步。
 * 这决定了两个工程约束：
 *   1. 固定段必须**可缓存**（前缀完全稳定，让 provider 的 prefix cache 命中）
 *   2. topic 历史必须**能压缩**，否则会撑爆上下文
 *
 * 压缩阈值（实测）：约 80% 占用时自动压缩；≥50% 可手动；≥85% 顶部显示环形表。
 */

/** 固定段的组成 —— 顺序即缓存前缀的层次，**不要随意调整** */
export interface ChiefFixedSegment {
  /** 角色指令：你是 Chief，不能自己写代码，只能派工 */
  roleInstructions: string;
  /** 工具定义摘要（不展开完整 schema，前缀保持稳定） */
  toolSummary: string;
  /** 团队章程：用户编辑，Chief 只读 */
  charter: string;
  /** Chief 记忆：≤100 条，注入预算 10,000 字符 */
  memory: string;
}

export interface TopicTurn {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  at: number;
}

export interface BoardDigest {
  /** 看板各相位的计数，Cheif 每轮都要看到全局 */
  byPhase: Record<string, number>;
  /** 处于闸门、正在等用户的 todo */
  needsYou: Array<{ id: string; seqNum: number; title: string; phase: string }>;
  /** 上次 digest 之后的变更 */
  changes: Array<{ id: string; what: string }>;
}

export interface ChiefPromptInput {
  fixed: ChiefFixedSegment;
  topicId: string;
  history: TopicTurn[];
  board: BoardDigest;
  userMessage: string;
  /** 当前上下文窗口大小 */
  contextWindow: number;
}

export interface ChiefPrompt {
  /** 三段拼装后的完整提示 */
  text: string;
  /** 各段字符数，用于观测与预算控制 */
  segments: { fixed: number; history: number; current: number };
  /** 估算 token（粗略：4 字符 ≈ 1 token） */
  estimatedTokens: number;
  /** 占用率 0..1 */
  occupancy: number;
  /** 是否应该触发自动压缩 */
  shouldCompact: boolean;
  /** 是否允许手动压缩（≥50%） */
  canCompactManually: boolean;
  /** 是否该显示顶部环形表（≥85%） */
  showRingMeter: boolean;
}

/** 经验系数：英文代码库约 4 字符/token，中文约 1.5 —— 取折中 3 */
const CHARS_PER_TOKEN = 3;

const COMPACT_AUTO_THRESHOLD = 0.8;
const COMPACT_MANUAL_THRESHOLD = 0.5;
const COMPACT_RING_THRESHOLD = 0.85;

/**
 * 构造 Chief 的完整 prompt。
 *
 * 固定段放在最前面且**逐字节稳定** —— 这是 prefix cache 能命中的前提。
 * 任何随时间变化的量（时间戳、随机 id）都不能进固定段。
 */
export function buildChiefPrompt(input: ChiefPromptInput): ChiefPrompt {
  const fixed = [
    '# 你是 Chief',
    '',
    input.fixed.roleInstructions,
    '',
    '## 可用工具',
    input.fixed.toolSummary,
    '',
    '## 团队章程',
    input.fixed.charter || '(未设置)',
    '',
    '## 记忆',
    input.fixed.memory || '(暂无)',
  ].join('\n');

  const history = input.history
    .map((t) => `### ${t.role}\n${t.content}`)
    .join('\n\n');

  const boardLines = [
    '## 看板',
    ...Object.entries(input.board.byPhase)
      .filter(([, n]) => n > 0)
      .map(([phase, n]) => `- ${phase}: ${n}`),
  ];
  if (input.board.needsYou.length > 0) {
    boardLines.push('', '### 等你处理');
    for (const t of input.board.needsYou) {
      boardLines.push(`- #${t.seqNum} [${t.phase}] ${t.title}`);
    }
  }
  if (input.board.changes.length > 0) {
    boardLines.push('', '### 自上轮的变化');
    for (const c of input.board.changes) {
      boardLines.push(`- ${c.id}: ${c.what}`);
    }
  }

  const current = [...boardLines, '', '## 本轮', input.userMessage].join('\n');

  const text = [fixed, history, current].filter(Boolean).join('\n\n---\n\n');
  const estimatedTokens = Math.ceil(text.length / CHARS_PER_TOKEN);
  const occupancy = input.contextWindow > 0 ? estimatedTokens / input.contextWindow : 0;

  return {
    text,
    segments: { fixed: fixed.length, history: history.length, current: current.length },
    estimatedTokens,
    occupancy,
    shouldCompact: occupancy >= COMPACT_AUTO_THRESHOLD,
    canCompactManually: occupancy >= COMPACT_MANUAL_THRESHOLD,
    showRingMeter: occupancy >= COMPACT_RING_THRESHOLD,
  };
}

/**
 * 压缩 topic 历史。
 *
 * 文档行为：旧消息 summary，最近消息保留原文。
 * 策略：保留最近 N 轮原文，更早的按角色聚合成摘要段。
 * 摘要用确定性的结构化拼接（不是 LLM 生成）—— 保证可缓存且不额外消耗。
 */
export function compactHistory(
  history: TopicTurn[],
  keepRecent: number,
): { summary: string; kept: TopicTurn[]; compactedCount: number } {
  if (history.length <= keepRecent) {
    return { summary: '', kept: history, compactedCount: 0 };
  }

  const older = history.slice(0, history.length - keepRecent);
  const kept = history.slice(history.length - keepRecent);

  const counts: Record<string, number> = {};
  for (const t of older) counts[t.role] = (counts[t.role] ?? 0) + 1;

  // 摘要要**有界** —— 否则长 topic 的压缩结果比原文还长，失去意义。
  // 策略：按时间分桶，每桶只留首个 user 与首个 assistant 的一句话，
  // 其余只计数。这样摘要是 O(桶数) 而非 O(消息数)。
  const BUCKET_COUNT = 8;
  const bucketSize = Math.max(1, Math.ceil(older.length / BUCKET_COUNT));
  const digestLines: string[] = [];
  for (let i = 0; i < older.length; i += bucketSize) {
    const bucket = older.slice(i, i + bucketSize);
    const firstUser = bucket.find((t) => t.role === 'user');
    const firstAssistant = bucket.find((t) => t.role === 'assistant');
    const rest = bucket.length - (firstUser ? 1 : 0) - (firstAssistant ? 1 : 0);
    const parts: string[] = [];
    if (firstUser) parts.push(`问:${firstLine(firstUser.content)}`);
    if (firstAssistant) parts.push(`答:${firstLine(firstAssistant.content)}`);
    const head = parts.join(' / ');
    digestLines.push(rest > 0 ? `- [${i + 1}-${i + bucket.length}] ${head} （另 ${rest} 条）` : `- [${i + 1}-${i + bucket.length}] ${head}`);
  }

  const summary = [
    `（以下是 ${older.length} 条较早消息的压缩摘要，${digestLines.length} 个时间片）`,
    ...Object.entries(counts).map(([role, n]) => `- ${role}: ${n} 条`),
    '',
    '### 各时间片要点',
    ...digestLines,
  ].join('\n');

  return { summary, kept, compactedCount: older.length };
}

function firstLine(content: string): string {
  return content.trim().split('\n')[0]?.slice(0, 100) ?? '';
}

/** standing 授权语句的识别 —— 文档给了三个真实例子 */
export interface StandingGrant {
  /** 授权动作：approve_plan | merge_changes | all_gates */
  action: 'approve_plan' | 'merge_changes' | 'all_gates';
  /** 作用域 */
  scope: { type: 'team' | 'todo' | 'agent'; id?: string };
  grantedAt: number;
}

/** 文档实测的三个原句（verbatim 识别） */
const GRANT_PATTERNS: Array<{ re: RegExp; action: StandingGrant['action'] }> = [
  { re: /confirm (?:the )?plan (?:once|when)/i, action: 'approve_plan' },
  { re: /(?:approve|confirm)[^.!?]{0,30}plan[^.!?]{0,30}(?:without|don'?t|do not)[^.!?]{0,10}ask/i, action: 'approve_plan' },
  { re: /merge when (?:the )?review passes/i, action: 'merge_changes' },
  { re: /merge[^.!?]{0,30}(?:without|don'?t|do not)[^.!?]{0,10}ask/i, action: 'merge_changes' },
  { re: /(?:don'?t|do not) ask me,? just proceed/i, action: 'all_gates' },
  // 单独的「别问我」也是明确的放行信号 —— 不能因为少了后半句就丢掉授权
  { re: /(?:don'?t|do not) ask me\b/i, action: 'all_gates' },
  { re: /别问我/i, action: 'all_gates' },
  { re: /就这么办/i, action: 'all_gates' },
];

/** 从用户消息里识别 standing 授权 */
export function parseStandingGrants(
  message: string,
  scope: StandingGrant['scope'],
  at: number,
): StandingGrant[] {
  const found: StandingGrant[] = [];
  for (const { re, action } of GRANT_PATTERNS) {
    if (re.test(message)) {
      found.push({ action, scope, grantedAt: at });
    }
  }
  // 去重：同一 action + 同一 scope 只留最早一条
  const byKey = new Map<string, StandingGrant>();
  for (const g of found) {
    const key = `${g.action}|${g.scope.type}|${g.scope.id ?? ''}`;
    const prev = byKey.get(key);
    if (!prev || g.grantedAt < prev.grantedAt) byKey.set(key, g);
  }
  return [...byKey.values()];
}

/** 某动作当前是否被授权（考虑三层作用域，具体优先） */
export function hasGrant(
  grants: StandingGrant[],
  action: 'approve_plan' | 'merge_changes',
  target: { todoId?: string; agentId?: string },
): { granted: boolean; grant?: StandingGrant } {
  const candidates = grants.filter(
    (g) => g.action === action || g.action === 'all_gates',
  );
  if (candidates.length === 0) return { granted: false };

  // 具体 > 泛化：todo > agent > team
  const rank: Record<string, number> = { todo: 3, agent: 2, team: 1 };
  let best: StandingGrant | undefined;
  for (const g of candidates) {
    if (g.scope.type === 'todo' && g.scope.id === target.todoId) {
      if (!best || rank.todo! > rank[best.scope.type]!) best = g;
    } else if (g.scope.type === 'agent' && g.scope.id === target.agentId) {
      if (!best || rank[g.scope.type]! > rank[best.scope.type]!) best = g;
    } else if (g.scope.type === 'team' && !best) {
      best = g;
    }
  }
  return { granted: Boolean(best), grant: best };
}

export const CHIEF_LIMITS = {
  MAX_TOPICS: 50,
  MAX_CHECKIN_DAYS: 7,
  CONTEXT_AUTO_COMPACT: COMPACT_AUTO_THRESHOLD,
  CONTEXT_MANUAL_COMPACT: COMPACT_MANUAL_THRESHOLD,
  CONTEXT_RING_METER: COMPACT_RING_THRESHOLD,
  FIXED_SEGMENT_TYPICAL_TOKENS: { min: 20_000, max: 30_000 },
} as const;
