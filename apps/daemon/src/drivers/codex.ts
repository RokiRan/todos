import type { StreamFrame } from '@tds/protocol';
import type { RunOptions, RunResult, RuntimeDriver, ToolCallRequest } from './driver.js';
import { probeBinary, resolveBinary, runCommand } from './shared.js';

/**
 * Codex driver（当前为 STUB）。
 *
 * 原因：本机 2026-10-16 实测 `codex --version` 与 `codex app-server --help`
 * 都返回 `error: command not found: codex`。
 * `npm i -g @openai/codex` 未安装，协议形态无法实测验证。
 *
 * 协议预期（来自 OpenAI 公开文档 @openai/codex，需以本机实测为准再补完）：
 *   - 子进程：`codex app-server`（JSON-RPC over stdio）
 *   - 握手：`initialize` 请求 + `initialized` 通知
 *   - 发起会话：`thread/start` → `thread/resume` → `turn/start`
 *   - 流：服务器推 `item/agentMessage/delta`、`item/reasoning/summary/delta`、
 *     `item/commandExecution/outputDelta`、`turn/completed`
 *   - 工具调用：服务器发 `item/toolCall`（含 name + arguments），客户端用
 *     `item/toolCall/result` 回灌；本项目的 mcp__tds__ 工具需要在 daemon
 *     这边拦截转发给 server，未实测验证。
 *
 * 一旦本机能装上 `@openai/codex`，把 STUB_NOT_AVAILABLE 换成真实的
 * `codex app-server` 启动 + JSON-RPC 帧读写即可。契约 (RuntimeDriver)
 * 与本文件其它部分都不需要改。
 */

const STUB_NOT_AVAILABLE =
  'runtime codex is not available in this environment: @openai/codex CLI 未安装，协议无法实测。请先 `npm i -g @openai/codex` 再启用本 driver。';

export class CodexDriver implements RuntimeDriver {
  readonly id = 'codex';

  async probe() {
    // 复用 shared.ts 的通用探测，让 probe 结果如实反映环境
    return probeBinary('codex');
  }

  /**
   * 登录探测：用 `--version` 之外的轻量命令试探。
   * codex 本身没有 `--whoami` / `--status` 这类子命令，登录态体现在能否
   * 发起 `app-server` 握手。这里先复用 --version：能跑就至少说明有二进制，
   * 真正的 signIn 留给 run() 里第一次握手失败时再报。
   */
  async checkSignIn(): Promise<{ signedIn: boolean; error?: string }> {
    const bin = resolveBinary('codex');
    if (!bin) return { signedIn: false, error: 'unknown runtime' };
    const r = await runCommand(bin.cmd, ['--version'], { timeoutMs: 5_000 });
    if (r.code !== 0) {
      const combined = `${r.stdout}${r.stderr}`;
      const notFound = /ENOENT|not recognized|command not found|cannot find/i.test(combined);
      return notFound
        ? { signedIn: false, error: 'codex binary not found' }
        : { signedIn: false, error: combined.trim().slice(0, 160) };
    }
    // 二进制能跑 ≠ 已登录；但本机未实测登录态接口，留一个明确信号
    return { signedIn: false, error: 'codex signIn probe 未实装，需要 codex app-server 握手验证' };
  }

  async run(
    opts: RunOptions,
    onFrame: (frame: StreamFrame) => void,
    onToolCall: (call: ToolCallRequest) => Promise<unknown>,
  ): Promise<RunResult> {
    // 即便有人调到了 stub，也把帧序列与 frames 数组保序返回，方便上层观察到错误
    const frames: StreamFrame[] = [];
    let seq = 0;
    const emit = (type: StreamFrame['type'], text?: string, extra?: Partial<StreamFrame>): void => {
      const f: StreamFrame = { seq: seq++, type, text, ...extra };
      frames.push(f);
      onFrame(f);
    };

    // 先如实探测一次 —— 即便上层假定 driver 已就绪，运行时也能给一句人话
    const probeResult = await this.probe();
    if (!probeResult.installed) {
      const msg = `${STUB_NOT_AVAILABLE} (probe: ${probeResult.error ?? 'unknown'}; promptChars: ${opts.prompt.length}; toolDefs: ${opts.toolDefs.length})`;
      emit('error', msg);
      return { status: 'failed', text: '', frames, error: msg, settlementCode: 'runtime_missing' };
    }
    // 二进制在但 driver 未实装 —— 这种情况属于「能跑但本机无法实测协议」。
    // onToolCall 当前不在 stub 路径上调用 —— 把引用就地解构保留类型契约：
    // 真接入协议时会把平台工具转发给该回调，所以保留这条链路作为契约注释。
    const _platformToolHook: typeof onToolCall | null = onToolCall;
    void _platformToolHook;
    emit('error', STUB_NOT_AVAILABLE);
    return {
      status: 'failed',
      text: '',
      frames,
      error: STUB_NOT_AVAILABLE,
      settlementCode: 'runtime_unimplemented',
    };
  }
}