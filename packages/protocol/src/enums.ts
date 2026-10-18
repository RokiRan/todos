/**
 * 核心枚举 —— 全部来自 2026-10-16 对 todos.dev 的实测（recon/03-app-api.md），
 * 不用官方文档的对外措辞，因为服务端内部用的是这套。
 *
 * 文档写 `Building` / `To Do`，实测服务端实际用 `implement` / `todo`。
 * 我们对齐服务端，UI 层再映射成人类可读文案。
 */

/** Todo 阶段机。settled = done | failed | closed，三者都可复活。 */
export const TODO_PHASES = [
  'todo',
  'queued',
  'planning',
  'confirm',
  'implement',
  'review',
  'reviewing',
  'done',
  'failed',
  'closed',
] as const;
export type TodoPhase = (typeof TODO_PHASES)[number];

/** 字符串 → TodoPhase 的窄化守卫。给**外部输入**用（MCP 参数、CLI 文本）：
 *  `packages/db` 自己另写了一份同名 phase 枚举（`schema.ts:13`），两份是结构上
 *  相同的 union，所以过守卫之后可以直接喂给 drizzle 的 phase 列，不需要 cast。 */
export const isPhase = (p: string): p is TodoPhase =>
  (TODO_PHASES as readonly string[]).includes(p);

/** 终态：可 Reopen / Rerun */
export const SETTLED_PHASES = ['done', 'failed', 'closed'] as const;
export type SettledPhase = (typeof SETTLED_PHASES)[number];
export const isSettled = (p: TodoPhase): p is SettledPhase =>
  (SETTLED_PHASES as readonly string[]).includes(p);

/**
 * 两道人工闸门。只有主按钮能推进；在输入框打字一律视为修订反馈。
 * 这是原站刻意的防误触设计 —— 见 recon/SPEC.md §3.1
 */
export const GATE_PHASES = ['confirm', 'review'] as const;
export type GatePhase = (typeof GATE_PHASES)[number];
export const isGate = (p: TodoPhase): p is GatePhase =>
  (GATE_PHASES as readonly string[]).includes(p);

/** 占用机器并发槽的阶段 */
export const SLOT_HOLDING_PHASES = ['planning', 'implement', 'reviewing'] as const;
export const holdsSlot = (p: TodoPhase): boolean =>
  (SLOT_HOLDING_PHASES as readonly string[]).includes(p);

/** step 生命周期（CLI bundle 实证） */
export const STEP_STATUSES = [
  'queued',
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/** 结算码 */
export const SETTLEMENT_CODES = [
  'machine_offline',   // 机器 >10 分钟无响应
  'agent_removed',
  'machine_removed',
  'machine_stopped',
  'push_rejected',
  'merge_conflict',
  'quota',
] as const;
export type SettlementCode = (typeof SETTLEMENT_CODES)[number];

/** 谁触发的这次 build（实测 build.triggerSource） */
export const TRIGGER_SOURCES = ['user', 'chief', 'agent', 'schedule'] as const;
export type TriggerSource = (typeof TRIGGER_SOURCES)[number];

/** 机器在线状态 */
export const MACHINE_STATES = ['online', 'offline', 'asleep'] as const;
export type MachineState = (typeof MACHINE_STATES)[number];

/** runtime 订阅额度探测结果（实测多一个 no_limits） */
export const RUNTIME_USAGE_STATUSES = ['ok', 'signed_out', 'error', 'no_limits'] as const;
export type RuntimeUsageStatus = (typeof RUNTIME_USAGE_STATUSES)[number];

/**
 * 流式事件类型。CLI bundle 的 15 类 + 服务端合成事件。
 * 复刻时直接照抄这个名字集合，可与原站客户端行为完全一致。
 */
export const STREAM_EVENT_TYPES = [
  // 来自 CLI 的 turn 流
  'text_delta',
  'thinking_delta',
  'thinking_text_delta',
  'thinking_level_change',
  'tool_call',
  'tool_call_update',
  'tool_result',
  // 用量与状态
  'usage',
  'usage_update',
  'usage_refresh',
  'step_update',
  'turn_completed',
  'error',
  // 服务端合成
  'done',
  'phase_changed',
  'message_appended',
  'document_updated',
  'todo_updated',
  'machine_changed',
  'notify',
  'ping',
] as const;
export type StreamEventType = (typeof STREAM_EVENT_TYPES)[number];

/** 右栏结构化文档类型 */
export const DOC_KINDS = ['plan', 'changes', 'question', 'confirm', 'input', 'review'] as const;
export type DocKind = (typeof DOC_KINDS)[number];

/** system 消息 content 里 JSON 信封的 kind（实测已见两种） */
export const SYSTEM_MESSAGE_KINDS = [
  'machine_selected',
  'turn_retried',
  'turn_started',
  'turn_interrupted',
  'machine_offline',
  'build_cancelled',
  'review_scheduled',
  'review_completed',
  'merge_started',
  'merge_completed',
  'merge_conflict',
] as const;
export type SystemMessageKind = (typeof SYSTEM_MESSAGE_KINDS)[number];

/** 通知事件 —— 收件人恒为 todo owner */
export const NOTIFICATION_EVENTS = [
  'plan_ready',
  'build_finished',
  'agent_question',
  'build_failed',
  'merge_blocked',
  'agent_note',
  'chief_reply',
  'assigned_to_you',
  'scheduled_run_failed',
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

/** 模型协议 */
export const MODEL_APIS = [
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
  'google-generative-ai',
] as const;
export type ModelApi = (typeof MODEL_APIS)[number];

/** schedule 规则形态 */
export const SCHEDULE_KINDS = ['hourly', 'daily', 'weekly', 'once'] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];
