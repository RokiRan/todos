/**
 * Chief 的领域类型。
 *
 * 文档实测行为（recon/docs/chief.md verbatim）：
 *   - 一个用户在一个 team 只有一个 Chief
 *   - Chief 按 Topic 组织对话：每个 topic 独立 history / context / watched todos / 定时 check-in
 *   - Chief 自己起的 turn 自动 watch 该 todo；用户直接给 todo 发消息则不 watch
 *   - 每 team 最多 50 个 topic；check-in 最远 7 天
 *   - 派工的授权判定：用户说过 → 自动；Chief 自己拍板 → question card
 *   - 不可逆动作（删 agent/skill/secret/connection/provider/todo）必须 confirmation card
 */

import type { TodoPhase } from '@tds/protocol';

/** Chief 的运行时 ID 命名：`chief-<userId>-<teamId>` */
export type ChiefId = string;

/**
 * 单个对话主题。
 *
 * 共享（跨 topic）：charter / memory / 看板 / build 对话
 * topic 独占：本对话消息 / watched todos / 定时 check-ins
 */
export interface Topic {
  id: string;
  chiefId: ChiefId;
  /** 首条消息被默认用作 title，可后续改名 */
  title: string;
  createdAt: number;
  /** 最后一次用户消息的时间 —— 用于排序活跃 topic */
  lastUserAt: number;
}

/**
 * Chief 对某个 todo 的关注。
 *
 * 来源：Chief 自己起的 turn 自动 watch；用户给 todo 直接发消息则不会让 Chief watch。
 */
export interface WatchedTodo {
  topicId: string;
  todoId: string;
  /** 谁触发的关注 */
  triggeredBy: 'chief' | 'user';
  createdAt: number;
}

/**
 * 定时 check-in —— 用于「不在平台 build turn 内」的工作（长训练、远端 SSH 脚本等）。
 * 一次性，到点唤醒 Chief 验证真实状态。
 */
export interface CheckIn {
  topicId: string;
  todoId: string;
  /** 唤醒时间（毫秒） */
  fireAt: number;
  /** 一次性触发：触发后从 active set 移除 */
  oneShot: true;
}

/**
 * 派工请求：Chief 拿到这些输入做一次决策。
 *
 * 这是**纯逻辑**层 —— 不查数据库，不发 HTTP。
 * 上层 caller 负责把 DB / API 状态组装成这个对象喂进来。
 */
export interface DispatchRequest {
  /** 是否来自用户原话（true）或 Chief 自己拍板（false） */
  requestedByUser: boolean;
  /** 待派工的 todo 概要 */
  todo: { id: string; title: string; phase: TodoPhase; spec?: string };
  /** 用户此前下过的 standing 授权（来自 prompt.ts 的 StandingGrant） */
  standingGrants: ReadonlyArray<StandingGrantLite>;
  /** 当前可用的 agent 与机器空闲情况 */
  resources: {
    idleAgentIds: ReadonlyArray<string>;
    onlineMachineCount: number;
  };
  /** 当前 chiefId（用于构造 question/confirmation card） */
  chiefId: ChiefId;
  /** 用户的最新原话，用于解析其中的 standing 授权 */
  userMessage?: string;
  /** 当前时间（毫秒），便于测试注入 */
  now: number;
}

/** standing 授权的最小表示（避免 dispatch 层依赖 prompt.ts 的内部细节） */
export interface StandingGrantLite {
  action: 'approve_plan' | 'merge_changes' | 'all_gates';
  scope: { type: 'team' | 'todo' | 'agent'; id?: string };
  grantedAt: number;
}

/**
 * 派工决策结果 —— 三种出口之一。
 *
 * 用 discriminated union 让上层 caller 写穷尽性 switch。
 */
export type DispatchDecision =
  | { kind: 'dispatch'; reason: string; agentId: string; thinkingLevel: ThinkingLevel }
  | { kind: 'needsApproval'; card: QuestionCard }
  | { kind: 'needsClarification'; card: QuestionCard; missing: ReadonlyArray<string> }
  | { kind: 'refuse'; reason: string };

/** 锐化程度 —— 影响 build agent 的推理预算 */
export type ThinkingLevel = 'low' | 'medium' | 'high';

/**
 * Question card：Chief 拍板时必须先弹给用户批准。
 *
 * 文档：「列出具体 todo / agent / thinking level / reason」
 */
export interface QuestionCard {
  kind: 'question';
  chiefId: ChiefId;
  todoId: string;
  agentId: string;
  thinkingLevel: ThinkingLevel;
  reason: string;
}

/**
 * Confirmation card：任何不可逆动作（删 agent/skill/secret/connection/provider/todo）
 * 都必须先弹给用户点确认 —— Chief 不替用户点。
 */
export interface ConfirmationCard {
  kind: 'confirmation';
  chiefId: ChiefId;
  /** 不可逆动作的具体对象 */
  target:
    | { type: 'agent'; id: string }
    | { type: 'skill'; id: string }
    | { type: 'secret'; id: string }
    | { type: 'connection'; id: string }
    | { type: 'provider'; id: string }
    | { type: 'todo'; id: string };
  reason: string;
}

/**
 * Wake 触发源：Chief 在什么时机该被唤醒回到对应 topic 回报。
 */
export type WakeTrigger =
  | { kind: 'gate'; todoId: string; phase: 'planning' | 'review' }
  | { kind: 'agent_question'; todoId: string }
  | { kind: 'review_failed'; todoId: string }
  | { kind: 'settled'; todoId: string; phase: 'done' | 'failed' | 'closed' };

/**
 * 单条 wake 事件。
 *
 * 同一 topic 的并发 wake 必须**合并**为一条（dedup by topicId），不能刷屏。
 */
export interface WakeEvent {
  topicId: string;
  triggers: ReadonlyArray<WakeTrigger>;
  at: number;
}
