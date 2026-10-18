/**
 * Chief 的 watch / wake 机制。
 *
 * 文档实测（recon/docs/chief.md verbatim）：
 *
 * 「Automatic watches and gate wakes. Every turn Chief starts — dispatching a
 *  build, messaging a todo, requesting an AI review, confirming a plan, or
 *  starting a merge — automatically watches that todo in the current topic:
 *    when the todo parks at a Confirm or Review gate,
 *    asks a question (Chief relays the build's question card directly into the
 *      Chief thread so you can answer from either place),
 *    hits a review failure,
 *    or settles (Done, Failed, Closed),
 *  Chief is woken in that topic to report back and suggest the next step.
 *  A turn you start yourself by typing directly in the todo's own conversation
 *  is the exception: its result reaches you as a regular notification, not
 *  through Chief. You only need to ask Chief to watch todos it did not start.」
 *
 * 「Timed check-ins for off-platform work. … no gate wake fires on its own;
 *  Chief can set a one-shot timed check-in (up to 7 days out) at the expected
 *  completion time.」
 *
 * 「A Chief holds up to 50 topics」 —— topic 上限
 *
 * 本模块提供：
 *   - shouldWatch —— Chief 是否该自动 watch 这次 turn 涉及的 todo
 *   - wakeEvents —— 给定一个 phase 变更集合，算出该唤醒哪些 topic 的 Chief
 *   - nextCheckIn —— 定时 check-in 时间计算，最远 7 天
 *   - canCreateTopic —— 50 topic 上限判定（避免创建溢出）
 *
 * 同一 topic 的并发 wake **必须合并**为一条（dedup by topicId）。
 * dedup 是用 Map 收、按 topicId 累加 triggers 数组实现的（确定性顺序，无 set 污染）。
 */

import type { WakeEvent, WakeTrigger } from './types.js';
import { CHIEF_LIMITS } from './prompt.js';

/** 7 天毫秒数 —— 与 prompt.ts.CHIEF_LIMITS.MAX_CHECKIN_DAYS 锁步 */
const MAX_CHECKIN_MS = CHIEF_LIMITS.MAX_CHECKIN_DAYS * 24 * 60 * 60 * 1000;

/**
 * 给定一次 Chief turn 的来源，判断要不要自动 watch 涉及的 todo。
 *
 * 文档铁律：
 *   - Chief 自己起的 turn（dispatch / message / review / confirm / merge）→ watch=true
 *   - 用户直接给 todo 发消息（typed-in）→ watch=false（结果走普通通知，不通过 Chief）
 *
 * `triggerBy` 只能是这两种之一（discriminated union），其它情况视为 caller bug → 返回 false。
 */
export function shouldWatch(
  triggerBy: 'chief_dispatch' | 'chief_message' | 'chief_review' | 'chief_confirm' | 'chief_merge' | 'user_typed',
): boolean {
  return triggerBy !== 'user_typed';
}

/**
 * 把若干 phase 变更折叠成 wake 事件集合（dedup by topicId）。
 *
 * 同一个 topic 的多次 wake **合并**为一条 —— 多个 trigger 累加在一条 wake 里，
 * 避免 Chief 在同一个 topic 刷屏。
 *
 * 触发对应（chief.md 实测）：
 *   - 到达 planning gate 或 review gate → gate wake
 *   - agent 提了 question → agent_question
 *   - review failed → review_failed
 *   - 进入 settled（done/failed/closed）→ settled
 */
export function wakeEvents(
  builds: ReadonlyArray<{
    topicId: string;
    /** 当前相位 */
    phase: string;
    /** 是否 review 失败（仅在 phase='reviewing'/'review' 才有意义） */
    reviewFailed?: boolean;
    /** agent 是否问了 question */
    agentAsked?: boolean;
  }>,
  at: number,
): WakeEvent[] {
  const byTopic = new Map<string, WakeTrigger[]>();

  for (const b of builds) {
    const triggers = wakeTriggersFor(b);
    if (triggers.length === 0) continue;
    const existing = byTopic.get(b.topicId);
    if (existing) {
      existing.push(...triggers);
    } else {
      byTopic.set(b.topicId, [...triggers]);
    }
  }

  return [...byTopic.entries()].map(([topicId, triggers]) => ({
    topicId,
    triggers,
    at,
  }));
}

/**
 * 把单个 build 的当前状态映射成应触发的 wake trigger 集合。
 *
 * 这是一个**纯函数** —— 不查数据库，单凭 phase 字符串判断。
 * 故意为「wake 不到」的情况返回空数组（譬如 build 还在 implement 中段，没有 gate 也没有 failure）。
 */
export function wakeTriggersFor(build: {
  phase: string;
  reviewFailed?: boolean;
  agentAsked?: boolean;
}): WakeTrigger[] {
  const out: WakeTrigger[] = [];

  if (build.phase === 'planning') {
    out.push({ kind: 'gate', todoId: '', phase: 'planning' });
  } else if (build.phase === 'review') {
    out.push({ kind: 'gate', todoId: '', phase: 'review' });
  }

  if (build.reviewFailed === true) {
    out.push({ kind: 'review_failed', todoId: '' });
  }

  if (build.agentAsked === true) {
    out.push({ kind: 'agent_question', todoId: '' });
  }

  if (build.phase === 'done' || build.phase === 'failed' || build.phase === 'closed') {
    out.push({ kind: 'settled', todoId: '', phase: build.phase });
  }

  return out;
}

/**
 * 给定时点，计算下一次 check-in 触发时间。
 *
 * 规则：
 *   - 早于 now → 钳到 now（check-in 不会追溯）
 *   - 超过 now + 7 天 → 钳到 now + 7 天（文档实测上限）
 *   - 已在过去 → 返回 now
 *
 * 一次性触发：到点 caller 负责从 active set 移除（CheckIn.oneShot=true）。
 */
export function nextCheckIn(at: number, now: number): number {
  if (at <= now) return now;
  if (at - now > MAX_CHECKIN_MS) return now + MAX_CHECKIN_MS;
  return at;
}

/**
 * 是否可以再创建一个 topic。
 *
 * 文档实测：每 team 最多 50 个 topic。
 *
 * 上层 caller 在写库前调一下；返回 false 时 caller 应建议用户合并 / 关闭现有 topic。
 */
export function canCreateTopic(currentCount: number): boolean {
  return currentCount < CHIEF_LIMITS.MAX_TOPICS;
}

export const WATCH_LIMITS = {
  MAX_TOPICS: CHIEF_LIMITS.MAX_TOPICS,
  MAX_CHECKIN_DAYS: CHIEF_LIMITS.MAX_CHECKIN_DAYS,
  MAX_CHECKIN_MS,
} as const;
