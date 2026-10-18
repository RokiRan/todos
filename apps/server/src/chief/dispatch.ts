/**
 * Chief 的派工决策层（纯逻辑，不碰数据库 / HTTP）。
 *
 * 文档铁律（recon/docs/chief.md verbatim）：
 *   「Handing out work — Chief dispatches work in two ways:
 *     - You asked, so it runs. … (standing 授权语句) → 立即派
 *     - Chief suggested, so it asks first. … → question card 等用户批」
 *
 *   「Before dispatching a todo, Chief sharpens its title and specification:
 *     the goal, the boundaries, and what 'done' looks like.
 *     If information that would change the work is missing, Chief asks you
 *     rather than guessing.」
 *
 *   「It acts as you, so you need to be a team admin, and it never grants any
 *     permission on its own initiative.」 → 复用 permissions.ts 的 canUseElevatedTool
 *
 *   「removing a provider, agent, skill, secret, connection, or todo always
 *     requires your click on a confirmation card」 → ConfirmationCard 单独出口
 *
 * standing 授权三层（prompt.ts 的 StandingGrant + hasGrant 已实现）：
 *   per-todo > per-agent > per-team —— 具体优先
 *
 * 本模块做的事：
 *   1. 从用户最新消息里识别 standing 授权（委托 prompt.ts）
 *   2. canAutoDispatch —— 把 prompt.ts 的 hasGrant 暴露给上层（permissions 派生层）
 *   3. sharpen —— 把 title/spec 锐化出 goal/boundary/done；缺关键信息 → needsClarification
 *   4. decideDispatch —— 组合以上，输出 DispatchDecision
 */

import type {
  DispatchDecision,
  DispatchRequest,
  QuestionCard,
  StandingGrantLite,
  ThinkingLevel,
} from './types.js';
import { hasGrant, parseStandingGrants, type StandingGrant } from './prompt.js';
import { shouldWatch } from './watch.js';

/** standing 授权作用域 —— 与 prompt.ts.StandingGrant['scope'] 同形 */
export type StandingGrantScope = StandingGrant['scope'];

/**
 * 给定一组 standing 授权与派工目标，判断「是否可自动派」。
 *
 * 复用 prompt.ts.hasGrant 的三层优先级（per-todo > per-agent > per-team）。
 *
 * 上层 caller（譬如 permissions.ts 派生）也能直接调这个：
 * canAutoDispatch 内部不引入任何 team-level 业务规则，纯粹是把 prompt 层已有的
 * 授权匹配逻辑暴露出来。真正涉及 admin role / connection / machine 开关的判定
 * 仍然走 canUseElevatedTool / canUseConnection / canRunOn —— 这里不动。
 */
export function canAutoDispatch(
  standingGrants: ReadonlyArray<StandingGrant>,
  action: 'approve_plan' | 'merge_changes',
  target: { todoId?: string; agentId?: string },
): { granted: boolean; via: 'standing' | 'explicit'; grant?: StandingGrant } {
  const r = hasGrant([...standingGrants], action, target);
  return { granted: r.granted, via: r.granted ? 'standing' : 'explicit', grant: r.grant };
}

/**
 * 锐化结果：把 todo.title + spec 解析成结构化的「目标 / 边界 / done 定义」。
 *
 * 缺关键信息时返回 needsClarification 的最小必要项（goal / boundary / done 三选一缺失即触发）。
 *
 * 这是**确定性的**字符串解析，不调 LLM —— 与 prompt.ts 的 compactHistory 同一设计哲学：
 * 派工层不该消耗额外 token。
 */
export interface SharpenedSpec {
  goal: string;
  boundary: string;
  done: string;
  /** 缺失的字段（用于构造 question card 的 missing 列表） */
  missing: ReadonlyArray<'goal' | 'boundary' | 'done'>;
}

/**
 * 从原始 spec 文本里抽取 goal / boundary / done。
 *
 * 约定格式（与 chief.md 一致）：
 *   ## Goal
 *   <文本>
 *   ## Boundary
 *   <文本>
 *   ## Done
 *   <文本>
 *
 * 缺任何一段时 missing 标记对应字段；上层据此构造 needsClarification。
 *
 * 导出为 public API —— 测试用 seam，外部 chief 集成层也可能复用。
 */
export function sharpen(spec: string | undefined, title: string): SharpenedSpec {
  const text = (spec ?? '').trim();
  const goal = extractSection(text, 'Goal') ?? extractSection(text, '目标') ?? title;
  const boundary = extractSection(text, 'Boundary') ?? extractSection(text, '边界') ?? '';
  const done = extractSection(text, 'Done') ?? extractSection(text, '完成') ?? extractSection(text, '验收') ?? '';

  const missing: Array<'goal' | 'boundary' | 'done'> = [];
  if (!goal) missing.push('goal');
  if (!boundary) missing.push('boundary');
  if (!done) missing.push('done');

  return { goal, boundary, done, missing };
}

/**
 * 把 dispatch 层的轻量表示（StandingGrantLite）转成 prompt.ts 内部 StandingGrant。
 *
 * 公开导出 —— 因为这是跨模块边界的**契约**（dispatch/types 与 prompt.ts 的类型并不一样）。
 */
export function liftGrant(g: StandingGrantLite): StandingGrant {
  return { action: g.action, scope: g.scope, grantedAt: g.grantedAt };
}

/**
 * 从用户原话解析 standing 授权并转成本层 lite 表示。
 *
 * 公开导出 —— 因为它绑定了 prompt.ts.parseStandingGrants + liftGrant 两个行为，
 * 上层 caller 直接调它比重复绑更安全。
 */
export function parseStandingGrantsLite(
  message: string,
  at: number,
  scope: StandingGrantScope = { type: 'team' },
): StandingGrantLite[] {
  return parseStandingGrants(message, scope, at).map(liftGrant);
}

function extractSection(text: string, header: string): string | null {
  // 形如 "## Goal" / "## 目标" 后跟一个或多个非空行，直到下一个 "## " 开头或文本结束
  const re = new RegExp(`(?:^|\\n)\\s*#{1,3}\\s*${header}\\s*\\n([\\s\\S]*?)(?=\\n\\s*#{1,3}\\s|\\n\\s*$|$)`, 'i');
  const m = re.exec(text);
  if (!m || !m[1]) return null;
  const trimmed = m[1].trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 从空闲 agent 列表里挑一个。
 *
 * 偏好：最近在该 todo/team 上跑过 build 的 agent（更熟悉上下文），否则取第一个。
 * agent 列表为空时返回 null —— caller 走 refuse。
 *
 * 公开导出 —— 多处锁步调用（上层 caller 也需要它做替代路由）。
 */
export function pickAgent(
  idleAgentIds: ReadonlyArray<string>,
  preferredAgentId?: string,
): string | null {
  if (idleAgentIds.length === 0) return null;
  if (preferredAgentId && idleAgentIds.includes(preferredAgentId)) return preferredAgentId;
  return idleAgentIds[0]!;
}

/**
 * 决定 thinking 等级。
 *
 * 规则：spec 含关键词（设计 / 调研 / 推理）→ high；纯执行（改 / 跑 / 测）→ low；其余 → medium
 * 与「doc 中 thinking level」字段对齐。
 *
 * 公开导出 —— 这是 chief 决策的稳定契约，多处锁步。
 */
export function pickThinkingLevel(spec: string | undefined, title: string): ThinkingLevel {
  const text = `${title}\n${spec ?? ''}`.toLowerCase();
  const HIGH = ['设计', '调研', 'research', 'design', 'architect', 'refactor', '推理', 'analyze'];
  const LOW = ['fix', 'typo', 'rename', '改', '跑', 'run', 'execute', 'test', '测'];
  if (HIGH.some((k) => text.includes(k))) return 'high';
  if (LOW.some((k) => text.includes(k))) return 'low';
  return 'medium';
}

/**
 * 派工决策主入口。
 *
 * 决策树（按优先级从上到下匹配）：
 *   1. 无空闲 agent 或无在线机器 → refuse
 *   2. spec 缺关键信息 → needsClarification（**不**瞎猜；chief.md 明确要求）
 *   3. 用户原话请求（requestedByUser=true） → dispatch
 *   4. 用户消息里有 standing 授权 → dispatch（覆盖该 action）
 *   5. 否则（Chief 自己拍板）→ needsApproval + question card
 */
export function decideDispatch(req: DispatchRequest): DispatchDecision {
  const { todo, standingGrants, resources, requestedByUser, chiefId, userMessage, now } = req;

  if (resources.onlineMachineCount === 0) {
    return { kind: 'refuse', reason: '没有在线机器可派工' };
  }
  const agentId = pickAgent(resources.idleAgentIds);
  if (!agentId) {
    return { kind: 'refuse', reason: '没有空闲 agent 可派工' };
  }

  const sharpened = sharpen(todo.spec, todo.title);
  if (sharpened.missing.length > 0) {
    const card: QuestionCard = {
      kind: 'question',
      chiefId,
      todoId: todo.id,
      agentId,
      thinkingLevel: pickThinkingLevel(todo.spec, todo.title),
      reason: `spec 缺关键信息：${sharpened.missing.join(', ')}`,
    };
    return { kind: 'needsClarification', card, missing: sharpened.missing };
  }

  const liveGrants: StandingGrant[] = [
    ...standingGrants.map(liftGrant),
    ...(userMessage ? parseStandingGrants(userMessage, { type: 'team' }, now) : []),
  ];
  const granted = requestedByUser || matchesStandingGrant(liveGrants, todo, agentId);
  if (granted) {
    return {
      kind: 'dispatch',
      reason: requestedByUser ? '用户原话请求' : 'standing 授权覆盖',
      agentId,
      thinkingLevel: pickThinkingLevel(todo.spec, todo.title),
    };
  }

  return {
    kind: 'needsApproval',
    card: {
      kind: 'question',
      chiefId,
      todoId: todo.id,
      agentId,
      thinkingLevel: pickThinkingLevel(todo.spec, todo.title),
      reason: `Chief 自行拍板：${sharpened.goal.slice(0, 80)}`,
    },
  };
}

/**
 * 三层授权匹配：复用 hasGrant 的优先级（per-todo > per-agent > per-team）。
 *
 * 任意 action 命中即视为已授权（包括 all_gates 这种万能钥匙）。
 */
function matchesStandingGrant(
  grants: ReadonlyArray<StandingGrant>,
  todo: { id: string },
  agentId: string,
): boolean {
  for (const action of ['approve_plan', 'merge_changes'] as const) {
    if (canAutoDispatch(grants, action, { todoId: todo.id, agentId }).granted) {
      return true;
    }
  }
  return false;
}

/**
 * routes/chief.ts 的可选 hook：派工被确认后由路由层回调，本层做纯逻辑归一化。
 *
 * 这里**不**直连 DB —— 上层 caller（路由或外部 orchestrator）负责读 DB；
 * 本函数只负责把派工事件归一成结构化日志，让 caller 写库前先看一遍决策结果。
 *
 * 这是适配层 —— 主路径仍然是 decideDispatch；本 hook 仅给路由层一个稳定的 import 边界。
 */
export interface OnDispatchedEvent {
  threadId: string;
  todoId: string;
  buildId: string;
  phase: string;
  teamId: string;
}

export interface OnDispatchedOutcome {
  watched: boolean;
  /** 路由层下一步建议：dispatch（直接派）/ hold（暂不派，等用户批） */
  advice: 'dispatch' | 'hold';
  reason: string;
}

export async function onDispatched(
  _db: unknown,
  evt: OnDispatchedEvent,
): Promise<OnDispatchedOutcome> {
  // 文档「Chief 自己起的 turn 自动 watch」—— 因此 onDispatched 路径 watched=true。
  const watched = shouldWatch('chief_dispatch');
  // phase 在 planning/review gate → 闸门需要等用户批；其余相位可直派。
  const gate = evt.phase === 'planning' || evt.phase === 'review' || evt.phase === 'confirm';
  return {
    watched,
    advice: gate ? 'hold' : 'dispatch',
    reason: gate ? 'gate reached, await user approval' : 'phase allows direct dispatch',
  };
}
