import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { StreamFrame } from '@tds/protocol';
import type { RunOptions, RunResult, RuntimeDriver, ToolCallRequest } from './driver.js';
import { spawnArgs } from './driver.js';
import { needsShell, probeBinary, resolveBinary, runCommand, whichCommand } from './shared.js';

/**
 * Claude Code driver。
 *
 * 驱动方式：`claude -p --output-format stream-json --verbose`
 * （原站走 @anthropic-ai/claude-agent-sdk，但 CLI 的 stream-json 是同一份协议，
 *  直接用 CLI 少一个依赖，且能复用用户已有的 claude 登录态 —— 这正是
 *   BYOC 路线的核心价值：用户自己的订阅，不消耗平台额度。）
 *
 * NDJSON 消息谱系由 2026-10-16 在本机 v2.1.226 实测确认：
 *   system/init               → 含 cwd / session_id / tools 清单
 *   system/hook_started       → hook 生命周期
 *   system/hook_response      → 可能带 additionalContext
 *   system/thinking_tokens    → 流式 token 估算（高频，仅计数用）
 *   assistant / content[]     → thinking | text | tool_use 混排
 *   user      / content[]     → tool_result 回灌
 *   result                    → 终帧，带 usage 与 total_cost_usd
 */

interface ClaudeContentBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result';
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface ClaudeLine {
  type: 'system' | 'assistant' | 'user' | 'result';
  subtype?: string;
  session_id?: string;
  cwd?: string;
  tools?: string[];
  message?: {
    role?: string;
    content?: ClaudeContentBlock[];
    model?: string;
    usage?: Record<string, number>;
  };
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  duration_ms?: number;
}

const SYSTEM_PROMPT = `You are a build agent working inside an isolated git worktree on behalf of a Todos workspace.

Rules you must follow:
- Work only inside the current directory. Never touch the parent repository.
- The platform's tools are exposed as MCP tools prefixed with mcp__tds__ . Use them when a task needs workspace state (todos, projects, agents, memory, secrets).
- Commit your work on the current branch when the task is done. Do not push unless a push_branch tool is available and granted.
- When you need a decision you cannot make yourself, call the ask_user tool rather than guessing.
- Keep your final message concise and factual: what you changed, what you verified, what remains.`;

export class ClaudeCodeDriver implements RuntimeDriver {
  readonly id = 'claude-code';

  async probe() {
    return probeBinary('claude-code');
  }

  /**
   * 登录探测：CLI 里有已配置账号时 `claude -p` 不会报 auth 错误。
   * 用一个最小 prompt 试跑，比解析配置文件可靠。
   */
  async checkSignIn(): Promise<{ signedIn: boolean; error?: string }> {
    const bin = resolveBinary('claude-code');
    if (!bin) return { signedIn: false, error: 'unknown runtime' };
    const r = await runCommand(bin.cmd, ['-p', '--model', 'claude-haiku-4-5-20251001', 'hi'], {
      timeoutMs: 45_000,
      // 空 HOME 会强制走 API key 路径；这里要的是用户自己的登录态
    });
    const out = `${r.stdout}${r.stderr}`;
    const authError = /not logged in|please run .*login|authentication_error|invalid api key|oauth/i.test(out);
    return authError ? { signedIn: false, error: out.slice(0, 160) } : { signedIn: true };
  }

  async run(
    opts: RunOptions,
    onFrame: (frame: StreamFrame) => void,
    onToolCall: (call: ToolCallRequest) => Promise<unknown>,
  ): Promise<RunResult> {
    const bin = resolveBinary('claude-code');
    if (!bin) {
      return { status: 'failed', text: '', frames: [], error: 'unknown runtime' };
    }

    const { promise, resolve } = Promise.withResolvers<RunResult>();

    const args: string[] = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'acceptEdits',
      // 隔离用户全局自定义（CLAUDE.md / skills / plugins / hooks）。
      // 原站也把 agent 配置隔离到 ~/.tds/<runtime>-home/（recon/01-runtimes.md），
      // 这里用 CLI 原生的 --safe-mode 达到同等效果：agent 只看任务本身，
      // 不会被用户自己的 skill/hook 改变行为（如强制先调用 skill 导致反问）。
      '--safe-mode',
      // prompt 走 argv：`-p` 模式下 CLI 从参数读取，
      // 比 stdin 可靠（stdin 在 CLI 提前退出会 EPIPE）
      opts.prompt,
    ];

    if (opts.model?.modelId) args.push('--model', opts.model.modelId);
    if (opts.model?.thinkingLevel) args.push('--effort', opts.model.thinkingLevel);

    // 平台工具以 MCP server 形式注入 —— 原站用 tds mcp-bridge 跑一个名为 tds 的
    // MCP server，让 Claude 看到 mcp__tds__<tool>。这里同样用 --mcp-config。
    if (opts.toolDefs.length > 0) {
      args.push('--mcp-config', JSON.stringify({ mcpServers: {} }));
    }

    // 优先拿到绝对路径的 .exe 并直接 spawn —— shell 会二次解析命令行，
    // 把 prompt 里的引号/换行/& | > 全部吃掉（实测 Claude Code 会收到
    // 残缺任务却报 succeeded）。只有 .cmd/.bat shim 才必须走 shell。
    const resolvedPath = whichCommand(bin.cmd);
    const useShell = needsShell(resolvedPath ?? bin.cmd);
    const spawnCmd = resolvedPath ?? bin.cmd;
    const spawnArgsFinal = useShell ? spawnArgs(args, true) : args;

    const child = spawn(spawnCmd, spawnArgsFinal, {
      cwd: opts.cwd,
      windowsHide: true,
      shell: useShell,
      env: {
        ...process.env,
        // 一次性凭据：只在子进程 env 里，不落盘
        ...(opts.credential ? { ANTHROPIC_API_KEY: opts.credential } : {}),
        // team secrets 同理：只进子进程 env，不进 prompt / transcript / 磁盘
        ...(opts.secretEnv ?? {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const frames: StreamFrame[] = [];
    let seq = 0;
    let finalText = '';
    let finalThinking = '';
    let sessionId = '';
    let usage: Record<string, number> = {};
    let costUsd: number | undefined;
    let toolCalls = 0;

    // spawn 失败（如 ENOENT）必须被接住，否则整个进程直接崩
    child.on('error', (err) => {
      resolve({
        status: 'failed',
        text: '',
        frames,
        error: `failed to spawn ${bin.cmd}: ${err.message}`,
        settlementCode: 'runtime_missing',
      });
    });

    const emit = (type: StreamFrame['type'], text?: string, extra?: Partial<StreamFrame>) => {
      const f: StreamFrame = { seq: seq++, type, text, ...extra };
      frames.push(f);
      onFrame(f);
    };

    // ── 读 stdout 的 NDJSON ──────────────────────────────────
    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });

    for await (const line of rl) {
      if (opts.signal.aborted) break;
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;

      let msg: ClaudeLine;
      try {
        msg = JSON.parse(trimmed) as ClaudeLine;
      } catch {
        continue; // 非 JSON 行（进度条等）忽略
      }

      if (msg.session_id && !sessionId) sessionId = msg.session_id;

      switch (msg.type) {
        case 'system': {
          if (msg.subtype === 'init') {
            emit('step_update', undefined, {
              usage: undefined,
            });
          }
          // thinking_tokens 只是估算，跳过（噪声太大）
          break;
        }

        case 'assistant': {
          for (const block of msg.message?.content ?? []) {
            if (block.type === 'text' && block.text) {
              finalText += block.text;
              emit('text_delta', block.text);
            } else if (block.type === 'thinking' && block.thinking) {
              finalThinking += block.thinking;
              emit('thinking_delta', block.thinking);
            } else if (block.type === 'tool_use' && block.id && block.name) {
              toolCalls++;
              const call: ToolCallRequest = {
                callId: block.id,
                name: block.name,
                input: block.input,
              };
              emit('tool_call', undefined, { tool: call });

              // 只有平台工具才转发给服务端；本地工具（Read/Edit/Bash）由 CLI 自己跑
              if (block.name.startsWith('mcp__tds__')) {
                void onToolCall(call).then((result) => {
                  child.stdin?.write(
                    JSON.stringify({
                      type: 'user',
                      message: {
                        role: 'user',
                        content: [
                          {
                            type: 'tool_result',
                            tool_use_id: call.callId,
                            content: JSON.stringify(result ?? null),
                          },
                        ],
                      },
                    }) + '\n',
                  );
                });
              }
            }
          }
          if (msg.message?.usage) usage = { ...usage, ...msg.message.usage };
          break;
        }

        case 'result': {
          costUsd = msg.total_cost_usd;
          if (msg.usage) {
            usage = {
              inputTokens: msg.usage.input_tokens ?? 0,
              outputTokens: msg.usage.output_tokens ?? 0,
              cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
              cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
            };
            emit('usage_update', undefined, {
              usage: { ...usage, costUsd, modelId: 'claude-code' },
            });
          }
          resolve({
            status: msg.is_error ? 'failed' : 'succeeded',
            text: msg.result ?? finalText,
            frames,
            error: msg.is_error ? (msg.result ?? 'runtime reported error') : undefined,
          });
          break;
        }
      }
    }

    // ── 收尾：退出码与 stderr 兜底 ─────────────────────────
    let stderr = '';
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    // stdin 可能因 CLI 提前退出而断；不接住会让整个 daemon 进程崩
    child.stdin?.on('error', () => undefined);

    child.on('close', (code, signal) => {
      if (opts.signal.aborted) {
        resolve({ status: 'cancelled', text: finalText, frames });
        return;
      }
      if (code === 0) {
        emit('turn_completed');
        resolve({ status: 'succeeded', text: finalText, frames });
        return;
      }
      const tail = stderr.trim().slice(-400) || `exit ${code}`;
      emit('error', tail);
      resolve({
        status: signal ? 'cancelled' : 'failed',
        text: finalText,
        frames,
        error: tail,
        settlementCode: signal ? undefined : 'runtime_error',
      });
    });

    // ── 中断处理 ────────────────────────────────────────────
    opts.signal.addEventListener('abort', () => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref?.();
    });

    // prompt 已作为 argv 传入（见 spawn 处），这里只需确保 stdin 关闭。
    // 用 -p 时 CLI 不会读 stdin，但留着管道会让部分版本挂起。
    child.stdin?.end();

    return promise;
  }
}
