import type { StreamFrame } from '@tds/protocol';

/**
 * Runtime driver 契约。
 *
 * 选型依据（recon/04-stack.md §4）：**不要**在 driver 之上再套一层 ACP。
 * 原站 17 个 runtime 跨 5 种驱动协议，其中真正走 ACP 的不到一半，且 ACP
 * 截至 2026-10 仍是 0.x 草案。强行抽象会：
 *   1. 引入一个几个月内必变的协议版本
 *   2. 抹平 runtime 特有能力（Codex 的 thread resume、Claude 的 session restore）
 *   3. 中途换 driver 必须改接口
 *
 * 所以：一个基类 + 每个 runtime 一份薄 adapter。
 */

/**
 * Windows 下 spawn 带 `shell: true` 时，参数会被拼成一条 cmd 命令行。
 * 未转义的引号/元字符会被 cmd 重新解释，导致 prompt 被截断或串味。
 * 这里对每个参数做 cmd 兼容的转义。
 *
 * 规则（cmd.exe 引号处理）：
 *   - 整体加引号
 *   - 内部的 `"` 用 `\"` 转义
 *   - 结尾的 `\` 需要翻倍，否则会吃掉闭合引号
 *   - `%` 需转义，否则被当环境变量展开
 */
export function quoteForCmd(arg: string): string {
  const escaped = arg
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\*)$/, '$1$1')
    .replace(/%/g, '%%');
  return `"${escaped}"`;
}

/**
 * 构造 spawn 参数。Windows 且 shell 模式时逐个加引号；
 * 其它平台原样传（Node 自己会做正确的 argv 编码）。
 */
export function spawnArgs(args: string[], shell: boolean): string[] {
  return shell ? args.map(quoteForCmd) : args;
}

export interface ToolCallRequest {
  callId: string;
  name: string;
  input: unknown;
}

export interface RunOptions {
  /** 已解析的 worktree 工作目录 */
  cwd: string;
  /** 本轮的完整提示词 */
  prompt: string;
  /** 一次性凭据。用完即弃，不落盘 */
  credential?: string | null;
  /**
   * 该 agent 的 team secrets（name → value），由 claim 响应下发。
   *
   * 与 `credential` 同一纪律：注入子进程 env 即可，**绝不写盘**、不进 prompt、
   * 不进 transcript（recon/docs/secrets.md）。只在该 agent 的 `team_secrets`
   * 开关打开时非空。
   */
  secretEnv?: Record<string, string>;
  model: {
    api: string;
    modelId: string;
    baseUrl?: string;
    thinkingLevel?: string;
    maxTokens?: number;
  } | null;
  /** 平台工具定义，供 runtime 以 MCP 方式调用 */
  toolDefs: unknown[];
  /** 中断信号 */
  signal: AbortSignal;
}

export interface RunResult {
  status: 'succeeded' | 'failed' | 'cancelled';
  text: string;
  frames: StreamFrame[];
  commitSha?: string;
  error?: string;
  settlementCode?: string;
}

export interface RuntimeDriver {
  readonly id: string;

  /** 二进制是否可执行 */
  probe(): Promise<{ installed: boolean; version?: string; path?: string; error?: string }>;

  /** 是否已登录（多数 CLI 用一个轻量子命令探测） */
  checkSignIn(): Promise<{ signedIn: boolean; error?: string }>;

  /**
   * 跑一轮对话。必须：
   *  - 把流式增量转成 StreamFrame 并逐个回调
   *  - 遵守 signal 中断
   *  - 绝不把 credential 写盘
   */
  run(
    opts: RunOptions,
    onFrame: (frame: StreamFrame) => void,
    onToolCall: (call: ToolCallRequest) => Promise<unknown>,
  ): Promise<RunResult>;
}
