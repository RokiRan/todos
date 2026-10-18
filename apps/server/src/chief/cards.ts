/**
 * 交互卡片。
 *
 * 文档实测（recon/docs/concepts.md，Documents 表，verbatim）：
 *
 *   | Kind | What it is |
 *   | Plan | What the agent intends to do, waiting at the Confirm gate |
 *   | Changes | The code diff the build produced, waiting at the Review gate |
 *   | Question | A structured question card from an agent or Chief for you to answer |
 *   | Confirm | The confirmation card Chief shows before deleting an agent, skill,
 *   |          |   secret, connection, provider, or todo; nothing is deleted until you confirm |
 *   | Input | A form card for entering sensitive credentials (secrets, provider API keys,
 *   |        |   connection headers/env vars) so the value never enters the chat transcript |
 *
 * 三种卡片的语义截然不同，实现时不能混：
 *   - Question : 问人类要信息，答完继续跑
 *   - Confirm  : 不可逆操作前的最后一道闸门，不点就什么都不发生
 *   - Input    : 收凭据，**值绝不进 transcript**
 */

export type CardKind = 'question' | 'confirm' | 'input';

export interface CardOption {
  id: string;
  label: string;
  /** 该选项的补充说明 */
  description?: string;
}

export interface QuestionCard {
  kind: 'question';
  id: string;
  /** 提问方：Chief 或某个 agent */
  askedBy: { type: 'chief' | 'agent'; id: string; name: string };
  question: string;
  options: CardOption[];
  /** 允许自由文本 —— 文档：具体选项 + `Other` 自由字段 */
  allowFreeText: boolean;
  context?: { todoId?: string; buildId?: string };
}

export interface ConfirmCard {
  kind: 'confirm';
  id: string;
  /** 将被删除的东西，用于人类看清后果 */
  target: { type: string; id: string; name: string };
  /** 人类可读的不可逆后果描述 */
  consequence: string;
  /** 「取消」按钮的说明 —— 必须是零风险的默认选项 */
  cancelHint: string;
  /** 受影响的连带项，例如「还有 3 个 todo 在用这个 agent」 */
  affected?: string[];
}

export interface InputCard {
  kind: 'input';
  id: string;
  /** 收的是什么凭据：secret / provider_key / connection_header / connection_env */
  credentialType: 'secret' | 'provider_key' | 'connection_header' | 'connection_env';
  label: string;
  description?: string;
  /** 目标：存到哪个 secret / provider / connection */
  target: { type: string; id?: string; name: string };
  /** write-only：已存的值永不回显 */
  writeOnly: true;
  /** 留空表示保留已存值 */
  emptyKeepsExisting: true;
}

export type ChiefCard = QuestionCard | ConfirmCard | InputCard;

/** 渲染成 system 消息信封 —— 实测消息 content 是 string，里面装 JSON */
export function encodeCard(card: ChiefCard): string {
  // kind 已在 card 上，显式提到最外层便于下游按 kind 分发而不必先解构
  return JSON.stringify({ ...card, kind: card.kind });
}

export function decodeCard(raw: string): ChiefCard | null {
  try {
    const parsed = JSON.parse(raw) as { kind?: string };
    if (parsed.kind === 'question' || parsed.kind === 'confirm' || parsed.kind === 'input') {
      return parsed as unknown as ChiefCard;
    }
    return null;
  } catch {
    return null;
  }
}

/** 未作答的问题卡：文档说「若 run 已继续或被回退，card 标 `No longer awaiting input`」 */
export type CardStatus = 'awaiting' | 'answered' | 'no_longer_awaiting' | 'cancelled';

export const CARD_STATUS_TEXT: Record<CardStatus, string> = {
  awaiting: '等待你的回答',
  answered: '已回答',
  no_longer_awaiting: '该问题已不再等待回答',
  cancelled: '已取消',
};

/**
 * 输入卡片的值处理。
 *
 * 铁律：**凭据值绝不进 chat transcript**。
 * 所以 validateCredentialInput 的返回值只回显「是否合法」与长度，
 * 绝不回传原值；调用方把原值直接写进加密存储。
 */
export interface CredentialValidation {
  ok: boolean;
  reason?: string;
  /** 只回显长度，不回显内容 */
  lengthEcho?: number;
}

export function validateCredentialInput(
  input: string,
  opts: { required?: boolean; emptyKeepsExisting?: boolean } = {},
): CredentialValidation {
  const required = opts.required ?? true;

  if (input.length === 0) {
    if (required) return { ok: false, reason: '凭据不能为空' };
    if (opts.emptyKeepsExisting) return { ok: true, lengthEcho: 0 };
    return { ok: false, reason: '凭据不能为空' };
  }

  // 文档实测约束：粘贴仅 ASCII 可打印字符
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code > 0x7e) {
      return { ok: false, reason: '凭据只接受 ASCII 可打印字符（粘贴时可能带入了不可见字符）' };
    }
  }

  if (input.length > 4096) {
    return { ok: false, reason: '凭据过长' };
  }

  return { ok: true, lengthEcho: input.length };
}

/** 确认卡的默认动作永远是取消 —— 防误触 */
export function defaultCardAction(card: ChiefCard): 'cancel' | 'submit' {
  if (card.kind === 'confirm') return 'cancel';
  return 'submit';
}
