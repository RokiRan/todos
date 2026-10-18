import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { StreamFrame } from '@tds/protocol';
import type { RunOptions, RunResult, RuntimeDriver, ToolCallRequest } from './driver.js';
import { spawnArgs } from './driver.js';
import { needsShell, probeBinary, resolveBinary, runCommand, whichCommand } from './shared.js';

/**
 * omp driver —— 实测协议版（2026-10-16 / omp v18.2.11）。
 *
 * 驱动方式：`omp --mode=json --print -p "<prompt>"`
 *   - `--mode=json`：每行一个 JSON 事件（NDJSON），即「逐行 JSON」
 *   - `--print` (`-p`)：非交互模式，单轮结束即退出
 *   - 真正的 RPC (`--mode=rpc`) 是双向请求/响应协议，要先握 `ready`
 *     再发 `prompt` 请求；MCP 风格的 extension_ui_request 也是它的子集。
 *     我们这里只需要单向流，不需要扩展 UI 拦截，所以走 `--mode=json`
 *     更轻、更确定，与 Claude Code 的 stream-json 体验一致。
 *
 * 实测事件谱系（`omp --mode=json --print -p "hi"` 的 stdout）：
 *   session                    → {version, id, timestamp, cwd}
 *   agent_start / agent_end    → 整次会话边界（isTerminal 标志在 end 上）
 *   turn_start / turn_end      → 一轮对话边界，turn_end 带 usage
 *   advisor_cost_changed       → 顾问 runtime 的计费累计（可忽略）
 *   message_start              → 用户或助手消息起，携带完整 content
 *   message_update              → 流式增量：
 *     assistantMessageEvent.type ∈
 *       text_start | text_delta | text_end
 *       thinking_start | thinking_delta | thinking_end
 *       tool_call_start | tool_call_delta | tool_call_end
 *   message_end                → 整条消息收尾，带 usage / stopReason
 *
 * 工具调用（tool call）：实测 "hi" 这种短 prompt 不会触发，但根据官方 docs，
 * `message_update.assistantMessageEvent.type` 还会出现 tool_call_* 三件套，
 * 工具结果会作为单独的 `tool_result` 消息回灌。本实现对工具调用做了
 * 透传：发到 onToolCall 回调（仅当 name 以 mcp__tds__ 开头时），其它走
 * omp 内置工具（read/edit/bash 等）由它自己处理。
 */

interface OmpMessageContentBlock {
  type: 'text' | 'thinking' | 'tool_call' | 'tool_result' | string;
  text?: string;
  thinking?: string;
  // tool_call: { id, name, input, ... }
  id?: string;
  name?: string;
  input?: unknown;
}

interface OmpAssistantEvent {
  type: 'text_start' | 'text_delta' | 'text_end' | 'thinking_start' | 'thinking_delta' | 'thinking_end' | 'tool_call_start' | 'tool_call_delta' | 'tool_call_end' | string;
  contentIndex?: number;
  content?: string;
  delta?: string;
  // tool_call_* 三件套的载荷
  id?: string;
  name?: string;
  input?: unknown;
}

interface OmpMessage {
  role: 'user' | 'assistant' | 'toolResult' | string;
  content?: OmpMessageContentBlock[];
  attribution?: string;
  timestamp?: number;
  api?: string;
  provider?: string;
  model?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
  stopReason?: string;
}

interface OmpTurnEnd {
  message?: OmpMessage;
  toolResults?: unknown[];
}

interface OmpLine {
  type: 'session' | 'agent_start' | 'agent_end' | 'turn_start' | 'turn_end' | 'message_start' | 'message_update' | 'message_end' | 'advisor_cost_changed' | string;
  id?: string;
  version?: number;
  timestamp?: string;
  cwd?: string;
  assistantMessageEvent?: OmpAssistantEvent;
  message?: OmpMessage;
  messages?: unknown[];
  toolResults?: unknown[];
  isTerminal?: boolean;
}

const SYSTEM_PROMPT = `You are a build agent working inside an isolated git worktree on behalf of a Todos workspace.

Rules you must follow:
- Work only inside the current directory. Never touch the parent repository.
- The platform's tools are exposed as MCP tools prefixed with mcp__tds__ . Use them when a task needs workspace state (todos, projects, agents, memory, secrets).
- Commit your work on the current branch when the task is done. Do not push unless a push_branch tool is available and granted.
- When you need a decision you cannot make yourself, call the ask tool rather than guessing.
- Keep your final message concise and factual: what you changed, what you verified, what remains.`;

export class OmpDriver implements RuntimeDriver {
  readonly id = 'omp';

  async probe() {
    return probeBinary('omp');
  }

  /**
   * 登录探测：omp 不会跑真实推理就足以确认 —— 用 `--print -p "hi"`
   * 触发完整一帧 JSON，能拿到 end-of-turn usage 即视为已登录（401 /
   * missing key 会更早报错）。`--smol` 选 fast model 节省成本。
   *
   * 这里硬编码 `--model` 到一个便宜模型来压低探测开销；调用方仍可在
   * run() 里通过 opts.model 覆盖真实模型。
   */
  async checkSignIn(): Promise<{ signedIn: boolean; error?: string }> {
    const bin = resolveBinary('omp');
    if (!bin) return { signedIn: false, error: 'unknown runtime' };
    // 用最小的空 prompt 触发完整 NDJSON；stdio 模式无 TTY 不会挂住。
    // 真实 oauth 失败的特征：stderr 里出现 "not logged in" / "401" / "missing api key"。
    const r = await runCommand(
      bin.cmd,
      ['--mode=json', '--print', '--no-session', '--model', 'haiku', '-p', 'ping'],
      { timeoutMs: 45_000 },
    );
    const out = `${r.stdout}${r.stderr}`;
    const authErr = /not logged in|please.*login|invalid.*api.*key|unauthorized|missing.*api.*key|401|authentication_required/i.test(
      out,
    );
    return authErr ? { signedIn: false, error: out.slice(0, 160) } : { signedIn: true };
  }

  async run(
    opts: RunOptions,
    onFrame: (frame: StreamFrame) => void,
    onToolCall: (call: ToolCallRequest) => Promise<unknown>,
  ): Promise<RunResult> {
    const bin = resolveBinary('omp');
    if (!bin) return { status: 'failed', text: '', frames: [], error: 'unknown runtime' };

    const { promise, resolve } = Promise.withResolvers<RunResult>();

    // omp 没有「argv 直传 prompt」标志 —— 走 MESSAGES 位置参数（ompi 的官方用法）
    const args: string[] = [
      '--mode=json',
      '--print',
      '--no-session', // 单轮不存盘，避免 worktree 内残留会话
      '--system-prompt', SYSTEM_PROMPT,
      '--cwd', opts.cwd,
      '--auto-approve', // 跳过权限审批（机器无人）
      ...(opts.model?.modelId ? ['--model', opts.model.modelId] : []),
      ...(opts.model?.thinkingLevel ? ['--thinking', opts.model.thinkingLevel] : []),
      // prompt 作为最后一个位置参数
      opts.prompt,
    ];

    // 真二进制绝对路径优先 —— shell 会二次解析 prompt 引号/换行毁任务
    const resolvedPath = whichCommand(bin.cmd);
    const useShell = needsShell(resolvedPath ?? bin.cmd);
    const spawnCmd = resolvedPath ?? bin.cmd;
    const finalArgs = useShell ? spawnArgs(args, true) : args;

    let child: ChildProcess;
    try {
      child = spawn(spawnCmd, finalArgs, {
        cwd: opts.cwd,
        windowsHide: true,
        shell: useShell,
        env: {
          ...process.env,
          // 一次性凭据：只在子进程 env 里，不落盘
          ...(opts.credential ? { OPENAI_API_KEY: opts.credential } : {}),
          // team secrets 同理：只进子进程 env，不进 prompt / transcript / 磁盘
          ...(opts.secretEnv ?? {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      return {
        status: 'failed',
        text: '',
        frames: [],
        error: `failed to spawn ${bin.cmd}: ${String(err)}`,
        settlementCode: 'runtime_missing',
      };
    }

    const frames: StreamFrame[] = [];
    let seq = 0;
    let finalText = '';
    let finalThinking = '';
    let usage: Record<string, number> = {};
    let costUsd: number | undefined;
    let modelId: string | undefined;
    let provider: string | undefined;
    let toolCalls = 0;

    child.on('error', (err) => {
      resolve({
        status: 'failed',
        text: '',
        frames,
        error: `failed to spawn ${bin.cmd}: ${err.message}`,
        settlementCode: 'runtime_missing',
      });
    });

    const emit = (type: StreamFrame['type'], text?: string, extra?: Partial<StreamFrame>): void => {
      const f: StreamFrame = { seq: seq++, type, text, ...extra };
      frames.push(f);
      onFrame(f);
    };

    // ── 读 stdout 的 NDJSON ──────────────────────────────────
    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });

    void (async () => {
      for await (const line of rl) {
        if (opts.signal.aborted) break;
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;

        let msg: OmpLine;
        try {
          msg = JSON.parse(trimmed) as OmpLine;
        } catch {
          continue; // 非 JSON 行（进度条等）忽略
        }

        switch (msg.type) {
          case 'session': {
            // 协议握手；可记下 cwd 与 version
            break;
          }

          case 'message_update': {
            const ev = msg.assistantMessageEvent;
            if (!ev) break;
            switch (ev.type) {
              case 'text_delta': {
                if (ev.delta) {
                  finalText += ev.delta;
                  emit('text_delta', ev.delta);
                }
                break;
              }
              case 'thinking_delta': {
                if (ev.delta) {
                  finalThinking += ev.delta;
                  emit('thinking_delta', ev.delta);
                }
                break;
              }
              case 'tool_call_start': {
                if (ev.id && ev.name) {
                  toolCalls++;
                  const call: ToolCallRequest = { callId: ev.id, name: ev.name, input: ev.input };
                  emit('tool_call', undefined, { tool: call });
                  // 只有平台工具才转发给服务端；本地工具 (read/edit/bash) 由 omp 自己跑
                  if (ev.name.startsWith('mcp__tds__')) {
                    void onToolCall(call).then((result) => {
                      child.stdin?.write(
                        JSON.stringify({
                          type: 'user',
                          message: {
                            role: 'toolResult',
                            tool_use_id: call.callId,
                            content: JSON.stringify(result ?? null),
                          },
                        }) + '\n',
                      );
                    });
                  }
                }
                break;
              }
              default:
                break;
            }
            break;
          }

          case 'message_end': {
            const m = msg.message;
            if (m?.usage) {
              usage = {
                inputTokens: m.usage.input ?? 0,
                outputTokens: m.usage.output ?? 0,
                cacheReadTokens: m.usage.cacheRead ?? 0,
                cacheWriteTokens: m.usage.cacheWrite ?? 0,
              };
              modelId = m.model ?? modelId;
              provider = m.provider ?? provider;
              if (m.usage.cost) costUsd = m.usage.cost.total;
              emit('usage_update', undefined, {
                usage: { ...usage, costUsd, provider, modelId },
              });
            }
            break;
          }

          case 'turn_end': {
            const m = msg as unknown as OmpTurnEnd;
            const u = m.message?.usage;
            if (u) {
              usage = {
                inputTokens: u.input ?? 0,
                outputTokens: u.output ?? 0,
                cacheReadTokens: u.cacheRead ?? 0,
                cacheWriteTokens: u.cacheWrite ?? 0,
              };
              if (u.cost) costUsd = u.cost.total;
              emit('usage_update', undefined, {
                usage: { ...usage, costUsd, provider, modelId },
              });
            }
            emit('turn_completed');
            resolve({
              status: 'succeeded',
              text: m.message?.content?.[0]?.text ?? finalText,
              frames,
            });
            // 杀掉子进程；omp --print 在 turn_end 时不会自己退出
            try {
              child.kill('SIGTERM');
            } catch {
              /* 进程已结束 */
            }
            return;
          }

          case 'agent_end': {
            // agent_end 是整次会话结束；turn_end 已经 resolve 的话这里只是保险
            if (msg.isTerminal && !frames.some((f) => f.type === 'turn_completed')) {
              emit('turn_completed');
            }
            break;
          }

          default:
            break;
        }
      }

      // stdout EOF —— turn_end 没收到，说明 omp 中途断了
      const stderr = await new Promise<string>((r) => {
        let buf = '';
        child.stderr?.on('data', (d) => (buf += d.toString()));
        child.stderr?.on('end', () => r(buf));
        child.stderr?.on('close', () => r(buf));
        // 兜底：100ms 后拿已有数据返回
        setTimeout(() => r(buf), 100).unref?.();
      });

      if (opts.signal.aborted) {
        resolve({ status: 'cancelled', text: finalText, frames });
        return;
      }
      const tail = stderr.trim().slice(-400);
      if (tail) emit('error', tail);
      const succeeded = frames.some((f) => f.type === 'turn_completed');
      if (!succeeded) emit('turn_completed');
      resolve({
        status: succeeded ? 'succeeded' : 'failed',
        text: finalText,
        frames,
        error: succeeded ? undefined : tail || 'omp exited without turn_end',
        settlementCode: succeeded ? undefined : 'runtime_error',
      });
    })();

    // ── 中断处理 ────────────────────────────────────────────
    opts.signal.addEventListener('abort', () => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref?.();
    });

    child.stdin?.on('error', () => undefined);
    // --print 不读 stdin，关掉避免某些版本挂着
    child.stdin?.end();

    return promise;
  }
}