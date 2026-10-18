import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setMaxListeners } from 'node:events';
import type { StreamFrame } from '@tds/protocol';
import type { RuntimeDriver, RunOptions, RunResult, ToolCallRequest } from './driver.js';

/** buildPiModel 返回的结构 —— 字段与 pi-ai 的 Model 对齐。 */
type PiModel = ReturnType<typeof buildPiModel>;

/**
 * pi 内置工具的 allowlist。
 *
 * `tools` 一旦提供就是**白名单**，所以要让 pi 的 read/bash/edit/write 可用，
 * 必须显式列出它们（不传该字段时 pi 才用自己的默认集）。
 */
const TOOL_ALLOWLIST = ['read', 'write', 'edit', 'bash', 'ls', 'find', 'grep'] as const;

/** pi SDK 的 AgentSession —— 我们实际用到的四个方法。 */
interface PiSession {
  subscribe: (listener: (event: unknown) => void) => () => void;
  prompt: (text: string, options?: Record<string, unknown>) => Promise<void>;
  abort: () => Promise<void>;
  dispose: () => void;
}

/** pi SDK 的 ModelRuntime —— 鉴权实际从这里解析。 */
interface PiModelRuntime {
  getAuth: (model: unknown, overrides?: object) => Promise<unknown>;
  registerProvider: (providerId: string, config: Record<string, unknown>) => void;
}

/**
 * 内存版 CredentialStore。
 *
 * pi 的鉴权经 `ModelRuntime.getAuth()` → `CredentialStore.read()` 解析。
 * 我们把团队 provider 的 key 放在这里，只活在本次 run 的内存里：
 *   - 永不写盘（原站是「加载前删 auth.json」，我们是「根本没有磁盘路径」）
 *   - list() 只回元数据，不暴露 key（pi 自身对该接口的约束）
 *
 * 本地网关（Ollama / LM Studio）本来就没有 key，原站文档明确允许
 * （"An API key is optional for local gateways that require none"），
 * 但 pi 的 `_getRequiredRequestAuth` 要求 getAuth 返回非空，
 * 所以给一个占位值让它通过判定 —— 占位值不会离开本进程。
 */
function memoryCredentialStore(apiKey: string | null): unknown {
  const hasKey = typeof apiKey === 'string' && apiKey.length > 0;
  return {
    read: async () =>
      hasKey ? { type: 'api_key', key: apiKey } : undefined,
    list: async () =>
      hasKey ? [{ providerId: 'tds', type: 'api_key' }] : [],
    write: async (_providerId: string, fn: (current: unknown) => unknown) => {
      // 只读 store：拒绝任何写入，防止 key 被持久化
      void fn;
      throw new Error('pi credential store is read-only (tds supplies credentials per step)');
    },
  };
}

/**
 * pi —— 原站**默认且内置**的 runtime。
 *
 * 为什么它和其他 runtime 根本不同（这是复刻里最容易搞错的一点）：
 *
 *   外部 runtime（omp / Claude Code / Codex…）
 *     daemon spawn 用户机器上装好的 CLI，用用户自己的登录态。
 *     probe 失败 = 用户没装/没登录，给安装命令即可。
 *
 *   pi（内置）
 *     daemon **直接 import** `@earendil-works/pi-coding-agent`，不 spawn 任何东西。
 *     模型来自团队自己的 provider（API key 由用户在平台配置），
 *     账单开给 vendor，不消耗平台 credits —— 所以 Free 档完全可用。
 *
 * 证据（recon/cli/package/dist/index.js，`src/lib/piRuntime.ts`）：
 *     var AGENT_RUNTIMES = ["pi", ...EXTERNAL_AGENT_RUNTIMES]
 *     async function getPiRuntime() {
 *       const agentDir = tdsPath("agent-runtime");
 *       mkdirSync(agentDir, {recursive: true});
 *       for (const legacy of ["auth.json", "models.json"]) rmSync(...)  // 加载即删
 *       const sdk = await import("@earendil-works/pi-coding-agent");
 *     }
 *
 * 那两个 rmSync 是安全设计的核心：**pi 的凭据只在内存里，绝不落盘**。
 * 我们照做 —— agentDir 每次启动前清掉 auth.json / models.json。
 *
 * 另外 pi 是唯一由**平台**管 context 压缩的 runtime（外部 runtime 由 CLI 自己管，
 * 官方文档明确写外部 runtime 上 "Compact now is not available"）。
 */

/** agentDir：`~/.tds/agent-runtime/`，与原站 tdsPath("agent-runtime") 对齐。 */
export function piAgentDir(tdsHome: string): string {
  return path.join(tdsHome, 'agent-runtime');
}

/**
 * 清理 pi 可能写下的凭据缓存。
 *
 * 原站在 getPiRuntime() 里对 auth.json / models.json 做 rmSync(force:true)。
 * 我们的凭据来自平台下发的 modelConfigs（一次性、内存内），
 * 若磁盘上残留了上一次的个人凭据，会让 agent 拿到不属于本团队 key 的模型。
 */
export function purgePiCredentials(agentDir: string): void {
  fs.mkdirSync(agentDir, { recursive: true });
  for (const legacy of ['auth.json', 'models.json']) {
    fs.rmSync(path.join(agentDir, legacy), { force: true });
  }
}

/**
 * 从 RunOptions.model + credential 组装 pi-ai 的 Model 对象。
 *
 * pi-ai 的 Model 是普通结构体（见 @earendil-works/pi-ai dist/types.d.ts
 * 的 BaseModel / Model），platform 不参与鉴权，鉴权走 apiKey 字段，
 * 所以我们不必依赖 pi 的 models.json 目录 —— 正好符合「凭据不落盘」。
 */
export function buildPiModel(model: NonNullable<RunOptions['model']>, credential: string | null | undefined) {
  return {
    id: model.modelId,
    name: model.modelId,
    api: model.api,
    provider: 'tds',
    baseUrl: model.baseUrl ?? '',
    input: ['text'] as ('text')[],
    reasoning: model.thinkingLevel !== undefined && model.thinkingLevel !== 'off',
    contextWindow: 200_000,
    maxTokens: model.maxTokens ?? 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    apiKey: credential ?? '',
  };
}

export class PiDriver implements RuntimeDriver {
  readonly id = 'pi';

  /**
   * pi 随包内置，不需要用户安装 —— 与外部 runtime 的 probe 语义相反：
   * 永远返回 installed:true，version 来自 SDK。
   */
  async probe(): Promise<{ installed: boolean; version?: string; path?: string; error?: string }> {
    try {
      const mod = (await import('@earendil-works/pi-coding-agent')) as { VERSION?: string };
      return { installed: true, version: mod.VERSION ?? 'unknown', path: '(bundled)' };
    } catch (err) {
      // 内置 runtime 却 import 失败 = 安装损坏，必须如实报错而不是假装可用
      return {
        installed: false,
        error: `pi SDK 不可用: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * pi 的「登录态」= 有没有可用的 provider 凭据。
   * 凭据由平台在 claim step 时下发（内存内），因此无法在此探测 ——
   * 这里如实返回需要凭据，由 worker 在 run 时用真凭据验证。
   */
  async checkSignIn(): Promise<{ signedIn: boolean; error?: string }> {
    return { signedIn: false, error: 'pi 使用团队 provider 凭据，在 claim step 时下发' };
  }

  async run(
    opts: RunOptions,
    onFrame: (frame: StreamFrame) => void,
    onToolCall: (call: ToolCallRequest) => Promise<unknown>,
  ): Promise<RunResult> {
    // pi 必须有模型：没有 provider 就没有模型，agent 建不起来。
    if (!opts.model) {
      return {
        status: 'failed',
        text: '',
        frames: [],
        error: 'pi runtime 需要团队 provider：先在 Providers 页添加一个，再给 agent 选模型',
      };
    }

    // 动态 import 是原站的做法（SDK 很大，只有真正要跑 pi 才加载）。
    // 这里不能静态 import —— 否则不跑 pi 的会话也要背这个依赖。
    // SDK 的真实导出类型比我们用到的多得多，走 unknown 中转是刻意的：
    // 我们只依赖 createAgentSession 一个入口，其余 API 变化不应编译失败。
    const sdk = (await import('@earendil-works/pi-coding-agent')) as unknown as {
      // 返回的是 { session, extensionsResult, modelFallbackMessage }，不是 session 本身
      createAgentSession: (options: Record<string, unknown>) => Promise<{ session: PiSession }>;
      ModelRuntime: {
        create: (options?: Record<string, unknown>) => Promise<PiModelRuntime>;
      };
    };

    const agentDir = piAgentDir(process.env.TDS_HOME ?? path.join(os.homedir(), '.tds'));
    purgePiCredentials(agentDir);

    const model = buildPiModel(opts.model, opts.credential);

    // 平台下发的凭据原样交给内存 store。本地网关没有 key 时传 null，
    // 由 memoryCredentialStore 决定是否给 pi 一个占位值。
    const apiKeyForAuth = opts.credential && opts.credential.length > 0 ? opts.credential : null;

    // SDK 内部会给每个工具调用挂 abort listener，一轮里超过 10 次就告警。
    // 这是 pi 的正常形态（多工具轮次），如实放宽而不是逐个摘 listener。
    // 注意要放在 session 建好**之后**放宽 —— 告警是在 run 期间触发的。
    setMaxListeners(64, opts.signal);

    // 鉴权走 ModelRuntime.getAuth()，不是直接读 model.apiKey
    // （见 agent-session.js `_getRequiredRequestAuth`）。
    // 我们平台的凭据只在内存里：authPath 指向不存在的文件 → 读不到任何本地凭据，
    // 真正的 key 通过内存 CredentialStore 注入本次会话。
    // 这也正是「凭据不落盘」的落点。
    const modelRuntime = await sdk.ModelRuntime.create({
      // credentials 走内存实现 —— 这是「凭据不落盘」的正式落点。
      // 原站的做法是加载前删掉 agent-runtime/auth.json；我们更进一步：
      // 根本不提供磁盘 auth 存储路径。
      credentials: memoryCredentialStore(apiKeyForAuth),
      modelsPath: null,
      refreshOnCreate: false,
    });

    // **必须显式注册 provider**。
    // 实测：`ModelRuntime.getAuth()` 内部先 `providers.get(providerId)`，
    // 拿不到就直接返回 undefined → AgentSession 报 "No API key found for tds"。
    // 而 providerIds() 只由 builtins / config / extensionProviders 组成 ——
    // **modelsStore 不参与**，所以只往 modelsStore 塞模型是没用的（踩过）。
    modelRuntime.registerProvider('tds', {
      name: opts.model.baseUrl ?? 'tds',
      baseUrl: opts.model.baseUrl ?? undefined,
      api: opts.model.api,
      apiKey: apiKeyForAuth ?? 'local-gateway-no-auth',
      models: [model],
    });

    const { session } = await sdk.createAgentSession({
      cwd: opts.cwd,
      agentDir,
      model,
      modelRuntime,
      thinkingLevel: opts.model.thinkingLevel ?? 'medium',
      // **tools 是 allowlist，不是增量列表**。
      // 传空数组 = 什么都不启用（pi 文档："only matching tools are enabled"），
      // 那样模型连 read/write 都调不到 —— 实测踩过：status succeeded 但没写文件。
      // 所以：没有平台工具时必须**省略该字段**，让 pi 用内置 read/bash/edit/write。
      ...(opts.toolDefs.length > 0 ? { tools: [...TOOL_ALLOWLIST, ...opts.toolDefs] } : {}),
      extensionRunner: {
        // pi 的工具回调走这里：agent 调平台工具时回到 server
        onToolCall: (call: ToolCallRequest) => onToolCall(call),
      },
    });

    let seq = 0;
    const emit = (type: string, extra: Partial<StreamFrame> = {}): void => {
      onFrame({ seq: seq++, type, ...extra });
    };

    const unsubscribe = session.subscribe((event: unknown) => {
      const e = event as { type?: string; text?: string; toolName?: string; input?: unknown; callId?: string; usage?: StreamFrame['usage'] };
      switch (e?.type) {
        case 'text_delta':
          emit('text_delta', { text: e.text ?? '' });
          break;
        case 'thinking_delta':
          emit('thinking_delta', { text: e.text ?? '' });
          break;
        case 'tool_call':
          emit('tool_call', {
            tool: { callId: e.callId ?? `c${seq}`, name: e.toolName ?? 'unknown', input: e.input },
          });
          break;
        case 'usage':
          emit('usage', { usage: e.usage });
          break;
        default:
          break;
      }
    });

    emit('start', { text: `pi: ${opts.model.modelId}` });

    // 中断信号接到 session.abort()
    const onAbort = (): void => {
      void session.abort();
    };
    opts.signal.addEventListener('abort', onAbort, { once: true });

    try {
      // team secrets：pi 是**进程内**跑的（不 spawn），所以它的 bash 工具直接
      // 继承 process.env。这里在 run 期间临时注入、finally 还原 —— 与外部
      // runtime「只进子进程 env」达到同一效果，且同样不落盘、不进 prompt。
      const secretEnv = opts.secretEnv ?? {};
      const injectedKeys = Object.keys(secretEnv);
      for (const [k, v] of Object.entries(secretEnv)) process.env[k] = v;
      try {
        await session.prompt(opts.prompt);
        emit('end');
        return { status: 'succeeded', text: '', frames: [] };
      } catch (err) {
        if (opts.signal.aborted) {
          emit('end');
          return { status: 'cancelled', text: '', frames: [] };
        }
        const message = err instanceof Error ? err.message : String(err);
        emit('error', { text: message });
        return { status: 'failed', text: '', frames: [], error: message };
      } finally {
        // 还原：同一 daemon 进程会连续跑多个 step，残留的 secret 会泄漏给下一个
        for (const k of injectedKeys) delete process.env[k];
      }
    } finally {
      opts.signal.removeEventListener('abort', onAbort);
      unsubscribe();
      session.dispose();
    }
  }
}
