import { API, stepApi, type ClaimResponse, type RecoverResponse, type RuntimeReport } from '@tds/protocol';
import type { SyncBranchResult } from './sync-branch.js';

/**
 * server 客户端。
 *
 * 认证走 `Authorization: Bearer tds_...`，与原站入站 MCP 一致
 * （实测匿名 GET /api/mcp 返回 401）。
 *
 * 每个方法都对应 bundle 里一个确切的端点，见 recon/02-cli-protocol.md §2–§3。
 */

export interface ClientOptions {
  server: string;
  apiKey: string;
  timeoutMs?: number;
}

export class ServerClient {
  private readonly server: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(opts: ClientOptions) {
    this.server = opts.server.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.server + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'tds-daemon/0.1.0',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── 注册 ────────────────────────────────────────────────────

  /** 入队。服务端会签发机器专属凭据 —— 返回里带 apiKey，daemon 立即换用它。 */
  enroll(device: Record<string, unknown>, teamId?: string): Promise<{ machineId: string; apiKey: string; reused: boolean }> {
    return this.request('POST', API.enroll, { apiKey: this.apiKey, teamId, device });
  }

  me(): Promise<{ machineId: string; teamId: string; server: string }> {
    return this.request('GET', API.me);
  }

  // ── 领取与执行 ──────────────────────────────────────────────

  /**
   * 领取一个 step。无任务时服务端返回 stepId=null。
   * 这是 daemon 的主循环入口 —— 对齐 bundle 的 /api/machine/tasks/claim。
   */
  claim(runtimes: string[], concurrency: number): Promise<ClaimResponse> {
    return this.request('POST', API.claim, { runtimes, concurrency });
  }

  heartbeat(stepId: string, runtimes: RuntimeReport[]): Promise<{ ok: boolean }> {
    return this.request('POST', stepApi.heartbeat(stepId), { stepId, runtimes });
  }

  changes(
    stepId: string,
    frames: unknown[],
    opts: { finalText?: string; isError?: boolean } = {},
  ): Promise<{ ok: boolean }> {
    return this.request('POST', stepApi.changes(stepId), {
      stepId,
      frames,
      finalText: opts.finalText,
      isError: opts.isError ?? false,
    });
  }

  done(
    stepId: string,
    payload: {
      status: 'succeeded' | 'failed' | 'cancelled';
      settlementCode?: string;
      error?: string;
      commitSha?: string;
      branchPushed?: boolean;
      pushError?: string;
      /** 改动摘要，服务端存成 Changes 文档供 Review 闸门展示 */
      diff?: {
        filesChanged: number;
        insertions: number;
        deletions: number;
        truncated: boolean;
        body: string;
        note?: string;
      };
    },
  ): Promise<{ ok: boolean }> {
    return this.request('POST', stepApi.done(stepId), { stepId, ...payload });
  }

  /** 取 refreshable 的 push token —— 只在需要 push 时取，不落盘 */
  token(stepId: string): Promise<{ token: string; expiresAt: number; scope: 'read' | 'write' }> {
    return this.request('POST', stepApi.token(stepId), { stepId });
  }

  /** 平台工具回调：agent 调 mcp__tds__<name> 时走这里 */
  tool(
    stepId: string,
    call: { callId: string; name: string; input?: unknown },
  ): Promise<{ callId: string; result?: unknown; isError?: boolean; error?: string }> {
    return this.request('POST', stepApi.tool(stepId), { stepId, ...call });
  }

  presence(payload: { runtimes: RuntimeReport[]; perf?: unknown }): Promise<{ ok: boolean }> {
    return this.request('POST', API.presence, payload);
  }

  // ── 补件通道（recover）与动作回执 ────────────────────────────

  /**
   * 问服务端「这台机器有什么要补的」，并自报能力位。
   *
   * `capabilities.syncBranch` **必须带**：服务端据此区分「daemon 版本过低」与
   * 「这台机器没有待办指令」。不带（或 false）时服务端一条指令都不下发，
   * 「同步到机器」会永远积压。响应形状向后兼容 —— 没有待办时是
   * `{ok:true, recovered:0, actions:[]}`，与本协议引入前的返回值完全一致。
   */
  recover(capabilities: { syncBranch: boolean }): Promise<RecoverResponse> {
    return this.request('POST', API.recover, { capabilities });
  }

  /**
   * 回报一条 recover 指令的执行结果。
   *
   * **git 失败也必须回报**：服务端下发时已把 `machine_pending_action` 那行置成
   * `running`，没有回执它就永远卡在那里 —— 既不重试也不显示失败，用户看到的是
   * 「点了没反应」。`status:'failed'` + `result.error` 才是终态。
   */
  actionResult(
    payload: {
      actionId: string;
      status: 'done' | 'failed';
      result: SyncBranchResult;
      /** 与 result.error 同义，便于服务端按路径取而不必下钻 */
      error?: string;
    },
  ): Promise<{ ok: boolean }> {
    return this.request('POST', API.actionResult, payload);
  }

  /** SSE 端点地址 —— 由 stream.ts 的 EventSource 消费 */
  streamUrl(): string {
    return this.server + API.stream;
  }
}
