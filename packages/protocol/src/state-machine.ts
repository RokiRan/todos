import {
  type TodoPhase,
  type GatePhase,
  isGate,
  holdsSlot,
} from './enums.js';

/**
 * Todo 状态机。
 *
 * 规则来源：35 篇官方文档 + 2026-10-16 登录态实测（recon/03-app-api.md §4）。
 * 与文档描述不同之处已在行内标注 —— 那些是实测纠偏。
 */

export type Trigger =
  | { kind: 'submit' }                        // 用户创建 todo
  | { kind: 'claim'; machineId: string }
  | { kind: 'plan_ready' }
  | { kind: 'approve'; by: 'user' | 'chief' } // 闸门主按钮
  | { kind: 'revision_feedback' }             // 闸门里打字
  | { kind: 'changes_ready' }
  | { kind: 'complete'; merge: boolean }
  | { kind: 'merge_clean' }
  | { kind: 'merge_conflict' }
  | { kind: 'fail'; code?: string }
  | { kind: 'reopen' }
  | { kind: 'review_start' }
  | { kind: 'review_end' }
  | { kind: 'cancel' };

export interface TransitionResult {
  ok: boolean;
  next: TodoPhase;
  /** 该转换是否需要调度一个 step */
  dispatch?: boolean;
  reason?: string;
}

const GATE_PRIMARY_ACTION: Record<GatePhase, string> = {
  // 文档铁律：Confirm 门主按钮是「批准计划」，之后才允许改代码
  confirm: 'approve',
  // Review 门主按钮是「验收并完成」
  review: 'complete',
};

/**
 * 闸门判定 —— 产品里最容易做错的一处。
 *
 * 文档原文：
 *   「两 gate 都只服从各自主按钮：a plan is approved with Confirm (或由 Chief 代确认)，
 *     changes are accepted with Done (或让 Chief 代合并)。
 *     Anything typed into the message box — including the word "confirm" —
 *     is treated as revision feedback: the agent runs a revision turn
 *     against your message and stops at the same gate again;
 *     it neither starts building nor merges.」
 *
 * 所以：
 *   - approve / complete   → 推进
 *   - revision_feedback    → 停在同一闸门，跑一轮 revision
 *   - review_start         → 从 Confirm 闸门**岔进** reviewing（发 AI 交叉评审）
 *   - 任何其它 trigger     → 在闸门上不推进
 *
 * `branch` 是 2026-10-17 加的第三种判定，专门给 `review_start`。它和 `advance`
 * 必须分开：`advance` 落点由 `transition` 按 gate 类型写死（confirm → implement），
 * 而评审要落到瞬态的 `reviewing`，落点不是「闸门主按钮的下一步」。合成一个返回值
 * 会让 `transition` 里出现「advance 但落点取决于 trigger」的分叉。
 */
export type GateDecision = 'advance' | 'revise' | 'branch' | 'reject';

export function gateDecision(
  phase: TodoPhase,
  trigger: Trigger,
): GateDecision {
  if (!isGate(phase)) return 'reject';
  if (trigger.kind === 'revision_feedback') return 'revise';
  if (trigger.kind === GATE_PRIMARY_ACTION[phase as GatePhase]) return 'advance';
  // 交叉评审只从 Confirm 闸门发起 —— `review_end` 恒回 confirm，从别的闸门
  // 发起就回不到原处（协议没有记住来源闸门的字段）。
  if (trigger.kind === 'review_start' && phase === 'confirm') return 'branch';
  return 'reject';
}

/**
 * 状态机上下文 —— 决定「plan first」还是「run now」的落点。
 * 文档：Plan first 停在 Confirm 闸门；Run now 跳过规划直接 Building。
 */
export interface TransitionCtx {
  /** todo.planFirst，默认 true */
  planFirst?: boolean;
}

export function transition(
  current: TodoPhase,
  trigger: Trigger,
  ctx: TransitionCtx = {},
): TransitionResult {
  const t = trigger.kind;
  const planFirst = ctx.planFirst ?? true;

  // ── 闸门特判：任何 trigger 先过闸门逻辑 ──────────────────────
  if (isGate(current)) {
    const decision = gateDecision(current, trigger);
    if (decision === 'revise') {
      // 关键：留在同一闸门，但需要跑一轮 revision
      return { ok: true, next: current, dispatch: true, reason: 'revision turn' };
    }
    if (decision === 'advance') {
      if (current === 'confirm') {
        // 批准计划 → 开始实施
        return { ok: true, next: 'implement', dispatch: true };
      }
      // 完成验收 → 走合并分支
      return {
        ok: true,
        next: trigger.kind === 'complete' && (trigger as { merge?: boolean }).merge
          ? 'implement'   // 勾选了合并 → 跑 merge turn
          : 'done',
        dispatch: trigger.kind === 'complete' && (trigger as { merge?: boolean }).merge,
      };
    }
    if (decision === 'branch') {
      // Confirm 闸门发 AI 交叉评审 → 落瞬态 reviewing，跑一轮 review turn。
      // dispatch=true：这个 build 必须真的跑起来，否则 todo 卡在 reviewing。
      return { ok: true, next: 'reviewing', dispatch: true, reason: 'cross review turn' };
    }
    if (t === 'cancel') return { ok: true, next: 'closed', reason: 'cancelled at gate' };
    // `fail` 在闸门上同样放行（2026-10-17 补）。原因与 `cancel` 同源：
    // 闸门上会跑的只有两类 turn —— 主按钮与 `revision_feedback`，两者都会
    // `dispatch` 一个 step。那个 step 失败时 `POST done(status:'failed')` 收成
    // `fail`；闸门若不接受 `fail`，todo 就永远停在 confirm，`build.finishedAt`
    // 已落终态却再没人推进 —— 看板看着「已完成」实际卡死。
    // 这不是「闸门可以被绕过」：只认主按钮那条铁律说的是**推进**（approve /
    // complete），失败与取消是**收敛**，方向相反，不构成绕过。
    if (t === 'fail') return { ok: true, next: 'failed', reason: 'failed at gate' };
    // 闸门只认主按钮、修订反馈、交叉评审与失败/取消；其它 trigger 一律不推进
    return { ok: false, next: current, reason: `gate ${current} rejects ${t}` };
  }

  switch (current) {
    case 'todo':
      if (t === 'submit') return { ok: true, next: 'todo' };
      // claim 后先进 planning —— 是否真的写计划由 todo.planFirst 决定。
      // 「Run now」跳过规划直接 implement，由 claim_planReady 的结果决定：
      //   planFirst=true  → planning → plan_ready → confirm（闸门①）
      //   planFirst=false → planning → plan_ready → implement（闸门②才是第一个）
      if (t === 'claim') return { ok: true, next: 'planning', dispatch: true };
      if (t === 'plan_ready') return { ok: true, next: 'implement', dispatch: true };
      return { ok: false, next: current, reason: `todo rejects ${t}` };

    case 'queued':
      if (t === 'claim') return { ok: true, next: 'planning', dispatch: true };
      if (t === 'plan_ready') return { ok: true, next: 'implement', dispatch: true };
      if (t === 'fail') return { ok: true, next: 'failed' };
      if (t === 'cancel') return { ok: true, next: 'closed' };
      return { ok: false, next: current, reason: `queued rejects ${t}` };

    case 'planning':
      // plan_ready 的落点取决于是否 plan-first：
      //   plan-first  → 停在 Confirm 闸门等批准
      //   run-now     → 直接进入实施
      if (t === 'plan_ready') return { ok: true, next: planFirst ? 'confirm' : 'implement' };
      if (t === 'fail') return { ok: true, next: 'failed' };
      if (t === 'cancel') return { ok: true, next: 'closed' };
      return { ok: false, next: current, reason: `planning rejects ${t}` };

    case 'implement':
      if (t === 'changes_ready') return { ok: true, next: 'review' };
      if (t === 'fail') return { ok: true, next: 'failed' };
      if (t === 'cancel') return { ok: true, next: 'closed' };
      return { ok: false, next: current, reason: `implement rejects ${t}` };

    case 'reviewing':
      // AI 交叉评审：`review_start` 由闸门发起评审，`review_end` 收敛回 confirm。
      //
      // **2026-10-17**：本分支此前只有 `review_end` 一个分支，`review_start`
      // 在 union 里声明却**没有任何 case 处理** —— 于是 `run_review` 工具永远拿到
      // `gate confirm rejects review_start`。这里补上缺失的那一半。
      //
      // 为什么只从 `confirm` 闸门发起：`review_end` 恒回 `confirm`，协议里没有
      // 记住来源闸门的字段，能这么实现的前提就是「评审只从 confirm 出发」。
      // 产品语义也一致：批准计划之前先让另一个 agent 挑毛病。
      if (t === 'review_end') return { ok: true, next: 'confirm', dispatch: true };
      if (t === 'fail') return { ok: true, next: 'failed' };
      if (t === 'cancel') return { ok: true, next: 'closed' };
      return { ok: false, next: current, reason: `reviewing rejects ${t}` };

    case 'done':
    case 'failed':
    case 'closed':
      if (t === 'reopen') {
        // 回到上一个静止闸门
        return { ok: true, next: 'review' };
      }
      if (t === 'submit') return { ok: true, next: 'todo' };  // Rerun = 新 build
      return { ok: false, next: current, reason: `${current} is settled, rejects ${t}` };

    default:
      return { ok: false, next: current, reason: `unknown phase ${current}` };
  }
}

/**
 * 插槽占用 —— 决定并发调度。
 * 文档：Planning / Building(含 Reviewing) 占槽；Queued 等槽；
 * 停在 Confirm / Review 或到达终态立即释放。
 */
export { holdsSlot as slotHeld };
