import type { ClaimResponse, MachineAction, RecoverResponse, RuntimeReport, StreamFrame } from '@tds/protocol';
import fs from 'node:fs';
import path from 'node:path';
import type { ServerClient } from './server-client.js';
import { collectDiff, commitAll, prepareWorkspace, pushBranch } from './git.js';
import { syncBranch, type SyncBranchResult } from './sync-branch.js';
import { driverFor } from './drivers/index.js';
import type { ToolCallRequest } from './drivers/driver.js';
import { probeBinary, runCommand, resolveBinary } from './drivers/shared.js';
import { PATHS, worktreeFor } from './paths.js';
import { log } from './log.js';

/**
 * daemon 主循环。
 *
 * 节奏（对齐原站 bundle 的实测值）：
 *   - claim：无事可做时退避，避免空转打爆服务端
 *   - heartbeat：执行中定期上报，长任务不掉线
 *   - recover：独立补件轮询，领「同步到机器」这类指令并执行
 *   - presence：独立心跳，上报 runtime 安装/登录状态
 *
 * 核心不变量（文档铁律）：
 *   凭据只在内存里，绝不写盘；turn 结束即失效。
 */

const HEARTBEAT_INTERVAL_MS = 30_000;
const PRESENCE_INTERVAL_MS = 60_000;
const RECOVER_INTERVAL_MS = 30_000;
const IDLE_BACKOFF_MIN_MS = 2_000;
const IDLE_BACKOFF_MAX_MS = 30_000;

/**
 * 能力位：这台 daemon 实现了 sync-branch。
 *
 * **为什么写死成常量、而不是「失败一次就关掉」**：服务端只在能力位为 true 时
 * 才下发指令。把一次 recover 调用的网络失败当成「不支持」，会让已经下发的指令
 * 永远积压 —— 用户点了「同步到机器」，服务端写了行，却再也没有人来领。
 * 将来要做成配置项（`TDS_SYNC_BRANCH=0`）时改这一处就够。
 */
const SUPPORTS_SYNC_BRANCH = true;

export interface WorkerOptions {
  client: ServerClient;
  concurrency: number;
  runtimeIds: string[];
  signal: AbortSignal;
}

/** 已确认拿到活的 claim —— stepId / buildId / runtime 都非空 */
type ClaimedTask = ClaimResponse & {
  stepId: string;
  buildId: string;
  runtime: string;
};

/** done 上报的 diff 摘要形状，与 DoneSchema 对齐 */
interface DoneDiff {
  filesChanged: number;
  insertions: number;
  deletions: number;
  truncated: boolean;
  body: string;
  note?: string;
}

/** commit message：优先用 agent 的总结首行，截断到 git 友好的长度 */
function commitMessage(agentText: string, todoTitle: string | undefined): string {
  const firstLine = agentText.trim().split('\n')[0]?.slice(0, 120) ?? '';
  const head = todoTitle ? `${todoTitle}` : 'agent changes';
  return firstLine ? `${head}\n\n${firstLine}` : head;
}

export class Worker {
  private readonly client: ServerClient;
  private readonly concurrency: number;
  private readonly runtimeIds: string[];
  private readonly signal: AbortSignal;

  private running = 0;
  private idleBackoff = IDLE_BACKOFF_MIN_MS;
  private lastPresenceAt = 0;
  private lastRecoverAt = 0;
  private cachedReports: RuntimeReport[] = [];

  constructor(opts: WorkerOptions) {
    this.client = opts.client;
    this.concurrency = opts.concurrency;
    this.runtimeIds = opts.runtimeIds;
    this.signal = opts.signal;
  }

  async run(): Promise<void> {
    log.info(`worker started — concurrency=${this.concurrency} runtimes=${this.runtimeIds.join(',') || 'none'}`);

    while (!this.signal.aborted) {
      try {
        if (this.running >= this.concurrency) {
          await sleep(500, this.signal);
          continue;
        }

        if (Date.now() - this.lastPresenceAt > PRESENCE_INTERVAL_MS) {
          await this.reportPresence();
        }

        if (Date.now() - this.lastRecoverAt > RECOVER_INTERVAL_MS) {
          await this.recoverPendingActions();
        }

        const claim = await this.client.claim(this.runtimeIds, this.concurrency - this.running);

        if (!claim.stepId || !claim.buildId || !claim.runtime) {
          // 无任务：退避
          await sleep(this.idleBackoff, this.signal);
          this.idleBackoff = Math.min(this.idleBackoff * 2, IDLE_BACKOFF_MAX_MS);
          continue;
        }

        // 拿到活：退避复位
        this.idleBackoff = IDLE_BACKOFF_MIN_MS;
        this.running++;
        // 不 await —— 多个 step 并行跑，受 concurrency 限制
        void this.execute({ ...claim, stepId: claim.stepId, buildId: claim.buildId, runtime: claim.runtime }).finally(() => {
          this.running--;
        });
      } catch (err) {
        if (this.signal.aborted) break;
        log.warn(`claim failed: ${errText(err)}`);
        await sleep(this.idleBackoff, this.signal);
        this.idleBackoff = Math.min(this.idleBackoff * 2, IDLE_BACKOFF_MAX_MS);
      }
    }

    log.info('worker stopped');
  }

  /** 上报本机 runtime 安装与登录状态 */
  private async reportPresence(): Promise<void> {
    this.lastPresenceAt = Date.now();
    this.cachedReports = await this.probeRuntimes();
    try {
      await this.client.presence({ runtimes: this.cachedReports });
    } catch (err) {
      log.warn(`presence failed: ${errText(err)}`);
    }
  }

  /**
   * 补件轮询（契约 §3.2/§3.4）：问服务端这台机器有什么要补的，把指令派发出去。
   *
   * 结构与 reportPresence 完全一致 —— 定时 + try/catch + 失败只 warn 不崩。
   * 这里崩了等于整个 daemon 死掉，而「同步到机器」失败不该影响领任务。
   *
   * **为什么照单全收、不看剩余并发槽**：服务端下发时已把行从 pending 翻成
   * `running`。这里不执行就等于那行永远卡 running（本切片没有 reaper）。
   * git 拉取是秒级操作、不占 agent slot，短暂超过 concurrency 是可接受的代价。
   */
  private async recoverPendingActions(): Promise<void> {
    this.lastRecoverAt = Date.now();
    try {
      const resp: RecoverResponse = await this.client.recover({ syncBranch: SUPPORTS_SYNC_BRANCH });
      if (resp.actions.length === 0) return;
      log.info(`recover dispatched ${resp.actions.length} action(s)`);
      for (const action of resp.actions) {
        this.running++;
        // 不 await —— 与 claim 循环同一并发模型：动作并行跑，跑完减同一个 running 计数。
        // 单条动作失败只影响它自己（executeAction 内部逐条回执），不影响同批其它动作。
        void this.executeAction(action).finally(() => {
          this.running--;
        });
      }
    } catch (err) {
      log.warn(`recover failed: ${errText(err)}`);
    }
  }

  /**
   * 执行一条 recover 指令，**无论成败都回执**。
   *
   * **失败不自动重试**（服务端把 status 置 `failed` 就是终态）：git 失败多半是
   * 目录状态问题（不是 git 仓库 / 目录不存在 / 分支不存在 / 拿不到基线），
   * 自动重试只会刷日志。要重试，用户重新点一次「同步到机器」—— 那会写一条
   * 新指令（服务端只对 pending/running 幂等复用，failed 不复用）。
   */
  private async executeAction(action: MachineAction): Promise<void> {
    log.info(`action ${action.actionId} ${action.kind} branch=${action.branch} dir=${action.dir}`);
    let result: SyncBranchResult;
    try {
      result = await syncBranch({
        actionId: action.actionId,
        branch: action.branch,
        dir: action.dir,
        buildId: action.buildId,
        todoId: action.todoId,
      });
    } catch (err) {
      // syncBranch 设计上不抛异常。这层兜底是防将来改动引入抛路径时，回执
      // 永远发不出去（那行会卡在 running）。宁可回报一条粗错误也不能不回。
      result = {
        ok: false,
        commitSha: null,
        filesChanged: 0,
        dir: action.dir,
        error: `执行器抛异常：${errText(err)}`,
      };
    }
    await this.reportActionResult(action.actionId, result);
  }

  /** 回执。发不出去只记日志 —— 没有别的可补救动作，服务端那行停在 running 由后续切片处理 */
  private async reportActionResult(actionId: string, result: SyncBranchResult): Promise<void> {
    const status = result.ok ? 'done' : 'failed';
    try {
      await this.client.actionResult({ actionId, status, result, error: result.error });
      log.info(`action ${actionId} → ${status}${result.error ? ` (${result.error.slice(0, 120)})` : ''}`);
    } catch (err) {
      log.error(`actionResult(${actionId}) failed: ${errText(err)}`);
    }
  }

  private async probeRuntimes(): Promise<RuntimeReport[]> {
    const reports: RuntimeReport[] = [];
    for (const id of this.runtimeIds) {
      const probe = await probeBinary(id);
      let signedIn = false;
      const driver = driverFor(id);
      if (probe.installed && driver) {
        try {
          signedIn = (await driver.checkSignIn()).signedIn;
        } catch {
          signedIn = false;
        }
      }
      reports.push({
        id,
        installed: probe.installed,
        signedIn,
        version: probe.version ?? null,
        binaryPath: probe.path ?? null,
        error: probe.error ?? null,
      });
    }
    return reports;
  }

  /** 执行一个 step 的完整生命周期 */
  private async execute(claim: ClaimedTask): Promise<void> {
    const { stepId, buildId, runtime, branch } = claim;
    log.info(`claimed step=${stepId} build=${buildId} runtime=${runtime} kind=${claim.kind}`);

    const driver = driverFor(runtime);
    if (!driver) {
      await this.finish(stepId, {
        status: 'failed',
        error: `runtime ${runtime} has no driver in this build`,
      });
      return;
    }

    const ac = new AbortController();
    const onAbort = () => ac.abort();
    this.signal.addEventListener('abort', onAbort, { once: true });

    // 心跳：长任务不掉线
    const hb = setInterval(() => {
      void this.client
        .heartbeat(stepId, this.cachedReports)
        .catch((err) => log.warn(`heartbeat failed: ${errText(err)}`));
    }, HEARTBEAT_INTERVAL_MS);

    // 帧缓冲：批量上报，避免每个 delta 一次 HTTP
    const pending: StreamFrame[] = [];
    let flushTimer: NodeJS.Timeout | null = null;
    const flush = () => {
      if (pending.length === 0) return;
      const batch = pending.splice(0, pending.length);
      void this.client.changes(stepId, batch).catch((err) => log.warn(`changes failed: ${errText(err)}`));
    };

    let finalText = '';
    let lastSeq = -1;
    // 从 prompt 首行提取任务标题，用于 commit message
    const todoTitle = claim.prompt?.match(/^# Task #\d+ — (.+)$/m)?.[1];

    try {
      // 准备隔离工作区。有 repo 信息就真的 clone + 建 build 分支；
      // 没有则退回空目录（单机冒烟用）。
      let cwd: string;
      if (claim.repo?.url && claim.branch) {
        try {
          const prepared = await prepareWorkspace(
            { url: claim.repo.url, baseBranch: claim.repo.baseBranch, branch: claim.branch },
            buildId,
          );
          cwd = prepared.cwd;
          log.info(`workspace ready: ${cwd} (branch ${claim.branch})`);
        } catch (err) {
          // clone 失败不该让整个 step 死掉 —— 降级到空目录，
          // 并把原因记下来供排查
          log.warn(`git prepare failed, falling back to empty dir: ${errText(err)}`);
          cwd = path.join(PATHS.workspaces, buildId);
          fs.mkdirSync(cwd, { recursive: true });
        }
      } else {
        cwd = path.join(PATHS.workspaces, buildId);
        fs.mkdirSync(cwd, { recursive: true });
      }

      const result = await driver.run(
        {
          cwd,
          prompt: claim.prompt ?? '',
          credential: claim.credential ?? null,
          // team secrets：只在子进程 env 里，与 credential 同样不落盘
          secretEnv: claim.secretEnv ?? {},
          model: claim.model,
          toolDefs: claim.toolDefs ?? [],
          signal: ac.signal,
        },
        (frame) => {
          lastSeq = frame.seq;
          pending.push(frame);
          // 高频流：最多 200ms 攒一批
          if (!flushTimer) {
            flushTimer = setTimeout(() => {
              flushTimer = null;
              flush();
            }, 200);
            flushTimer.unref?.();
          }
        },
        async (call: ToolCallRequest) => {
          // 平台工具：转发给服务端执行
          try {
            const res = await this.client.tool(stepId, call);
            return res.isError ? { error: res.error } : res.result;
          } catch (err) {
            return { error: errText(err) };
          }
        },
      );

      if (flushTimer) clearTimeout(flushTimer);
      flush();
      finalText = result.text;

      // 执行成功 → 提交改动并抓 diff，交给 Review 闸门
      let commitSha = result.commitSha;
      let diff: DoneDiff | undefined;
      let branchPushed = false;
      let pushError: string | undefined;
      if (result.status === 'succeeded' && claim.branch) {
        try {
          const isGit = fs.existsSync(path.join(cwd, '.git'));
          if (isGit) {
            const committed = await commitAll(cwd, commitMessage(result.text, todoTitle));
            commitSha = committed.commitSha ?? commitSha;

            // diff 不能以「commitAll 有没有新建 commit」为条件。
            // 内嵌 agent runtime（pi / claude-code / codex）会在自己的回合里
            // `git commit`，于是 `commitAll` 看到干净工作区、回
            // `committed:false`（`git.ts:134`），旧代码据此**跳过 diff**。后果不是
            // e2e 断言失败这么简单：build 有 commit、有分支，却没有 changes 文档
            // （服务端只在 `body.diff` 非空时落文档，`routes/machine.ts:534`），
            // Review 闸门打开时一片空白。实测：派上跑真模型这一轮，工作区有
            // commit `10cb122 Add hello.js printing 'hello from e2e'`，
            // `git diff --numstat origin/main...HEAD` 回 `1 0 hello.js`，
            // 但 `document` 表 0 条。
            // 正确的判据是「分支相对 base 前进了没有」，与 commit 是谁打的无关。
            if (claim.repo?.baseBranch) {
              const summary = await collectDiff(cwd, `origin/${claim.repo.baseBranch}`);
              // 零改动时**不发** diff：服务端 `body.diff && status === 'succeeded'`
              // 会落一份 `filesChanged=0` 的文档，Review 闸门反而显示「改了 0 个文件」。
              if (summary.filesChanged > 0) {
                diff = {
                  filesChanged: summary.filesChanged,
                  insertions: summary.insertions,
                  deletions: summary.deletions,
                  truncated: summary.truncated,
                  body: summary.diff,
                  note: summary.note,
                };
                log.info(
                  `committed ${commitSha?.slice(0, 8)} — ${summary.filesChanged} files, +${summary.insertions}/-${summary.deletions}`,
                );
              } else {
                log.info(`no diff vs origin/${claim.repo.baseBranch} — nothing to review`);
              }
            }
          }
        } catch (err) {
          log.warn(`commit/diff failed: ${errText(err)}`);
        }
      }

      // commit 之后必须把分支推到**真远端**。不推的话 commit 只活在 daemon 自己的
      // 工作区 + 镜像缓存里：`merge_builds`、「同步到机器」、另一台机器、以及用户
      // 在自己仓库里全都看不见它（实测：Windows 执行机跑完，源仓库
      // `git branch -a` 只有 `main`，commit `58f5b2de` 只在
      // `C:\Users\<你的用户名>\.tds\workspaces\<buildId>` 里）。判据与两跳的理由见
      // `git.ts` 的 `pushBranch`（`ls-remote` 对账，退出码不算数）。
      if (result.status === 'succeeded' && claim.branch && claim.repo?.url) {
        try {
          const pushed = await pushBranch(cwd, {
            url: claim.repo.url,
            baseBranch: claim.repo.baseBranch,
            branch: claim.branch,
          });
          branchPushed = pushed.pushed;
          pushError = pushed.error;
          // headSha 是 push 前从工作区解析的 HEAD，拿它统一 commitSha：
          // `commitAll` 在 agent 自己 commit 时回的就是 HEAD，这里保证两者同源。
          if (pushed.headSha) commitSha = pushed.headSha;
          log.info(
            pushed.pushed
              ? `pushed ${claim.branch} → origin (${pushed.headSha.slice(0, 8)})`
              : `push refused: ${pushed.error ?? 'unknown'}`,
          );
        } catch (err) {
          pushError = errText(err);
          log.warn(`push threw: ${pushError}`);
        }
      }

      await this.client
        .changes(stepId, [], { finalText, isError: result.status === 'failed' })
        .catch(() => undefined);

      await this.finish(stepId, {
        status: result.status,
        error: result.error,
        settlementCode: result.settlementCode,
        commitSha,
        diff,
        branchPushed,
        pushError,
      });
    } catch (err) {
      if (flushTimer) clearTimeout(flushTimer);
      log.error(`step ${stepId} threw: ${errText(err)}`);
      await this.finish(stepId, { status: 'failed', error: errText(err) });
    } finally {
      clearInterval(hb);
      this.signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * done 上报。改成**对象入参**：加 `branchPushed` / `pushError` 后这条已经是
   * 8 个位置参数，再靠位置传 `undefined` 占位迟早传错。字段名与
   * `DoneSchema`（`packages/protocol/src/machine-api.ts:229`）一一对齐，
   * 服务端拿它写 `build.branch_pushed_at` / `push_error`（`routes/machine.ts:571`）。
   */
  private async finish(
    stepId: string,
    payload: {
      status: 'succeeded' | 'failed' | 'cancelled';
      error?: string;
      settlementCode?: string;
      commitSha?: string;
      diff?: DoneDiff;
      branchPushed?: boolean;
      pushError?: string;
    },
  ): Promise<void> {
    try {
      await this.client.done(stepId, payload);
      log.info(`step ${stepId} → ${payload.status}${payload.error ? ` (${payload.error.slice(0, 120)})` : ''}`);
    } catch (err) {
      log.error(`done(${stepId}) failed: ${errText(err)}`);
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  function onAbort() {
    clearTimeout(timer);
    resolve();
  }
  signal.addEventListener('abort', onAbort, { once: true });
  return promise;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
