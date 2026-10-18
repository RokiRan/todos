/**
 * Chief 的**模型调用外壳** —— 把三种 api（`anthropic-messages` /
 * `google-generative-ai` / 走 OpenAI 兼容 `/v1/chat/completions`）
 * 的请求体形状、响应解析、错误归一化封到一处。
 *
 * 这层只负责「发起一次 HTTP + 把响应/错误折成 `ModelCallResult`」，
 * 不负责 Chief 的对话循环（那是 `services/chief-loop.ts` 的事）。
 *
 * 实现要点（与 `routes/providers.ts` 的 `verifyProviderKey` 同源）：
 *   1. 三种 api 的 URL/header/body 拼装**照搬** `verifyProviderKey`（约 108-165 行），
 *      因为它已经把每家网关的鉴权约定验过了。这里不重复发明。
 *   2. 错误归一化沿用「**只有 401/403 才算 key 错**，429/5xx/网络不可达都不是」——
 *      与 `verifyProviderKey` 的策略一致。但 Chief 这一层**没有 14/15s 硬上限**，
 *      因为对话轮比探测需要更长时间，调用方用 `timeoutMs` 自己夹。
 *   3. **apiKey 绝不能进错误消息**（生产里 OpenAI 的 token 是 `sk-...`，
 *      Anthropic 的 `sk-ant-...` 一旦泄露就要挨个 rotate）。错误只暴露
 *      `{status, provider, code, message}`。这是单元测试「token 不泄漏」
 *      要钉死的合同。
 *
 * `fetchImpl` 注入机制沿用 `services/github.ts` 的 `setGitHubFetchImpl` 风格：
 * 测试要打的是「参数怎么拼、响应怎么归一化」这些纯逻辑，
 * 不该发真实网络；CI 没理由拉模型网关。
 */

import { MODEL_APIS, type ModelApi } from '@tds/protocol';

// ─── 公开类型 ────────────────────────────────────────────────────────

/** 单条发给模型的消息。`toolCallId` 只在 `role === 'tool'` 时出现。 */
export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** `role === 'tool'` 时必填 —— 指向它回应的那个 assistant.tool_calls 条目。 */
  toolCallId?: string;
  /**
   * `role === 'assistant'` 时：这一回合模型请求了哪些工具。
   *
   * **必须有这个字段**，否则对话历史无法表达「模型调了工具」这件事 ——
   * 而 OpenAI 兼容端点是硬契约：`tool` 消息必须能对应到某条 assistant 的
   * `tool_calls`，对不上下一轮直接 400。持久化历史时同样要带上它。
   */
  toolCalls?: ToolCall[];
}

/** 工具 schema（JSON Schema 子集，由调用方自由发挥）。 */
export interface ModelToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * 一次调用的结果。
 *
 * `toolCall` 与 `text` **不互斥**：reasoning 模型实测（Strata / qwen3.8-flash-next-iq2_xs）
 * 给 `content: null` 同时带 `tool_calls`，并把推理文本放在 `reasoning_content`。
 * 本层**两条都取**：
 *   - `text` 在没有 tool_call 时优先用 `content`，为空才回落到 `reasoning_content`
 *     （用户反馈：「纯文本场景下内容全在 reasoning_content，否则 Chief 以为模型哑了」）。
 *   - 有 tool_call 时 `text` 也带上 reasoning 内容，给 Chief 看模型想干嘛。
 *
 * `finishReason` 必须**单独映射**出来，不能融进 `text`：实测在本机 8080 上给
 *   `max_tokens:200` 时 `finish_reason` 会变成 `'length'`（推理先把预算吃完，
 *   tool_calls 截没），这与 `'stop'`（正常完成）和 `'tool_calls'`（等待工具）
 *   三种语义完全不同，回给 Chief-loop 时要能区分「被截断」与「自然停」两个**关键**状态。
 */
export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'other' | null;

/**
 * 一次调用的结果。
 */
/** 一条工具调用请求。模型一轮里可以发多个（`toolCalls` 是数组，不是单值）。 */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ModelCallResult {
  /**
   * 模型要调的工具请求；纯文本回复或 reasoning 模式下为空数组。
   *
   * **是数组不是单值**：OpenAI / Anthropic 的 `tool_calls` 天然是数组，模型一轮里
   * 可以并行发多个（实测本地 qwen3.8-flash-next 出现过）。只取第一个等于静默丢掉
   * 其余调用 —— `chief-loop` 按数组处理，多余的会走它的 overflow 回灌。
   */
  toolCalls: ToolCall[];
  /** 模型的文本回复（可能是空串 —— 见下「reasoning 模型」坑） */
  text: string;
  /** 原始响应用的 token 计数，观测用 */
  usage: { inputTokens: number; outputTokens: number } | null;
  /**
   * 上游 `finish_reason` 归一化结果。
   *   - `'stop'`       自然停（OpenAI / Anthropic 共用）
   *   - `'tool_calls'` 模型在等工具回执（OpenAI）
   *   - `'length'`     撞 `max_tokens` 被截断 —— Chief-loop 要把这条**单挑出来**提示
   *                     用户「这一轮因为预算不够被腰斩」，不能再静默续轮
   *   - `'other'`      未识别值（如 Gemini 的 `'MAX_TOKENS'` `'SAFETY'` 已映射外）
   *   - `null`         上游没给（默认） —— 当作 `'stop'` 不严谨，按原文转发
   */
  finishReason: FinishReason;
}

/**
 * 调用方参数。
 *
 * `thinkingLevel` 是**本地标记**，不向网关转发（各家 thinking 参数名不一样，
 * 强行加易 400 —— 见 `apps/daemon/src/drivers/pi.ts` 的 `buildPiModel`，它也只
 * 把 `reasoning = thinkingLevel !== 'off'` 记到本地 PiModel 里，不发给 pi）。
 */
export interface ModelCallerOpts {
  api: string;
  baseUrl: string | null;
  apiKey: string;
  modelId: string;
  thinkingLevel?: string | null;
  /**
   * 上限 token 数。Anthropic 的 `max_tokens` / OpenAI 的 `max_tokens` 都认这个字段。
   * 不传则用服务端默认 8192。本机 Strata / qwen3.8-flash-next 实测：
   *   `max_tokens:200` 会让 `finish_reason='length'` 把 tool_calls 截掉，
   *   所以默认抬到 8192 留足 reasoning 余量。
   */
  maxTokens?: number;
  fetchImpl?: typeof fetch;
  /**
   * 单次调用的网络超时（ms）。**不是**全 turn 的预算 —— Chief-loop 自己有迭代上限。
   * 默认 60_000 = 1 分钟。本机 8080 Strata 跑长思维链时曾经踩到 30s 出 abort。
   */
  timeoutMs?: number;
}

// ─── fetch 注入（照 `services/github.ts` 同款） ────────────────────────

/**
 * 全局 fetch 覆盖点 —— **只给测试用**。
 *
 * `createModelCaller` 是纯函数，没法从 `routes/mcp.ts` 把 `fetchImpl`
 * 一路传下去；测试要把 fetch 钩掉，只能走模块级 setter。生产代码永远不调它。
 *
 * 用模块级 setter 而不是 `vi.mock`：`test/*` 走的是裸 `node:test` + `tsx`，
 * 不引 mock 库（与 `services/github.ts` 同约定）。
 */
let fetchOverride: typeof fetch | undefined;

/** 测试专用：注入假 fetch。传 `undefined` 恢复真实实现。 */
export function setModelFetchImpl(impl: typeof fetch | undefined): void {
  fetchOverride = impl;
}

function pickFetch(opts: ModelCallerOpts): typeof fetch {
  return opts.fetchImpl ?? fetchOverride ?? globalThis.fetch.bind(globalThis);
}

// ─── 错误类型 ────────────────────────────────────────────────────────

/**
 * 模型调用错误。`status` 字段保留 HTTP 码；`code` 是机器可读分类。
 *
 *   - `'auth'`         401/403 —— key 被拒绝（这是 key 真错）
 *   - `'rate_limit'`   429 —— 网关限流（key 是对的，无需警示用户）
 *   - `'server'`       5xx —— 上游崩了
 *   - `'unreachable'`  网络失败 / abort / DNS 不可解
 *   - `'bad_request'`  422 或我们解析失败（参数拼错、网关响应是 HTML…）
 *
 * `message` **不**含 `apiKey`、Authorization 头或 URL query 里的 `?key=`。
 */
export class ModelCallError extends Error {
  constructor(
    public readonly status: number | null,
    public readonly code:
      | 'auth'
      | 'rate_limit'
      | 'server'
      | 'unreachable'
      | 'bad_request'
      | 'invalid_response',
    public readonly provider: ModelApi | 'unknown',
    message: string,
  ) {
    super(message);
    this.name = 'ModelCallError';
  }
}

// ─── 主入口 ──────────────────────────────────────────────────────────

/**
 * 把（API + baseURL + key + model）打包成一次调用。
 *
 * 返回的 `call(messages, tools?)` 每次都是一次独立的 HTTP 请求，无连接复用。
 * 三个协议分支的请求体形状**和** `routes/providers.ts` 里的 `verifyProviderKey`
 * 完全一致（除了我们带完整 messages/tools 它带 `messages:[{role:'user',content:'ping'}]`）。
 */
export function createModelCaller(opts: ModelCallerOpts): {
  call(messages: ModelMessage[], tools?: ModelToolSpec[]): Promise<ModelCallResult>;
} {
  const fetchImpl = pickFetch(opts);
  const api = opts.api as ModelApi;

  if (!opts.baseUrl) {
    throw new ModelCallError(null, 'bad_request', 'unknown', 'baseUrl is required');
  }
  if (!opts.apiKey && api !== 'google-generative-ai') {
    // google-generative-ai 把 key 放进 query，本地网关（Ollama / LM Studio）可以无 key。
    // 但 Anthropic / OpenAI 没 key 一定要鉴权，没 key 直接拒。
    throw new ModelCallError(null, 'bad_request', api, 'apiKey is required');
  }
  if (!opts.modelId) {
    throw new ModelCallError(null, 'bad_request', api, 'modelId is required');
  }

  return {
    async call(messages, tools) {
      return callOne(fetchImpl, api, opts, messages, tools);
    },
  };
}

// ─── 协议分支 ────────────────────────────────────────────────────────

/**
 * 一次完整调用：拼 URL + headers + body → 走 fetch → 解析响应 → 归一化错误。
 *
 * `reasoning_content` 回落这条**必须在 content 为空时**做：
 *   - 某些模型（实测 Strata / qwen3.8-flash-next 等本地网关）在推理模式下
 *     `content: null`，文本全在 `reasoning_content` 字段。这条 OpenAI 兼容协议
 *     里属于「厂商扩展」，是有上游实测过的（见 recon 那批）。如果直接丢掉，
 *     Chief 会拿到 `text: ''` 还以为是模型不说话，回执是空的。
 *   - 反过来**不能**总是用 `reasoning_content`：因为 plain 模型不会发这个字段，
 *     会导致它前面被覆盖丢失。判定条件是 `content` 为空/null 才回落到
 *     `reasoning_content`。
 */
async function callOne(
  fetchImpl: typeof fetch,
  api: ModelApi,
  opts: ModelCallerOpts,
  messages: ModelMessage[],
  tools: ModelToolSpec[] | undefined,
): Promise<ModelCallResult> {
  const base = opts.baseUrl!.replace(/\/+$/, '');

  let url: string;
  let init: RequestInit;
  let parse: (text: string) => ModelCallResult;

  if (api === 'anthropic-messages') {
    ({ url, init } = buildAnthropic(base, opts, messages, tools));
    parse = parseAnthropic;
  } else if (api === 'google-generative-ai') {
    ({ url, init } = buildGoogle(base, opts, messages, tools));
    parse = parseGoogle;
  } else if (api === 'openai-completions' || api === 'openai-responses') {
    // 两条 OpenAI 协议在「chat/completions 形状」上对齐，只在 thinkingLevel
    // 表达上有差 —— 我们不用 thinkingLevel 转发，所以本层走同一分支即可。
    ({ url, init } = buildOpenAI(base, opts, messages, tools));
    parse = parseOpenAI;
  } else {
    throw new ModelCallError(null, 'bad_request', 'unknown', `unsupported api: ${String(api)}`);
  }

  // 上游错误体有时会回显我们发过去的凭据，所以把**裸 key**与 **`Bearer <key>` 整段**
  // 两种形态都交给 `doFetch` 脱敏 —— 只脱敏其中一个拦不住另一种回显方式。
  const secrets = [opts.apiKey, `Bearer ${opts.apiKey}`].filter(
    (s): s is string => typeof s === 'string' && s.length >= 4,
  );
  return doFetch(fetchImpl, url, init, api, parse, opts.timeoutMs ?? 60_000, secrets);
}

// ─── Anthropic ───────────────────────────────────────────────────────

function buildAnthropic(
  base: string,
  opts: ModelCallerOpts,
  messages: ModelMessage[],
  tools: ModelToolSpec[] | undefined,
): { url: string; init: RequestInit } {
  // system 拆出来作为顶层字段（Anthropic 协议要求）：
  //   这是协议级差异，不是我个人喜好 —— 见 anthropic docs /v1/messages。
  const systemParts: string[] = [];
  const chatMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of messages) {
    if (m.role === 'system') systemParts.push(m.content);
    else if (m.role === 'user') chatMessages.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') chatMessages.push({ role: 'assistant', content: m.content });
    // role==='tool' Anthropic 协议需要在对应 assistant 块里附 tool_use_id，这里
    //   简化：Chief-loop 层负责把 tool 回执折成 assistant 块，本层只接 user/assistant。
  }

  const body: Record<string, unknown> = {
    model: opts.modelId,
    // 默认 8192：本机 Strata 实测 `max_tokens:200` 时 `finish_reason` 会被截成
    //   `'length'`，tool_calls 拿不全（推理预算先吃完）。4096 也还在够用边界上，
    //   但留双倍余量更稳。调用方可用 `opts.maxTokens` 覆盖。
    max_tokens: opts.maxTokens ?? 8192,
    system: systemParts.join('\n\n') || undefined,
    messages: chatMessages,
  };
  if (tools && tools.length > 0) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  return {
    url: `${base}/v1/messages`,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': opts.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    },
  };
}

function parseAnthropic(text: string): ModelCallResult {
  type Wire = {
    stop_reason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | string | null;
    content?: Array<
      | { type: 'text'; text: string }   // wire 字段名，与下面的局部变量 text 同名但不同作用域
      | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    >;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const wire = JSON.parse(text) as Wire;
  const blocks = wire.content ?? [];

  let replyText = '';
  const toolCalls: ToolCall[] = [];
  for (const b of blocks) {
    if (b.type === 'text') {
      replyText += (replyText ? '\n' : '') + b.text;
    } else if (b.type === 'tool_use') {
      // Anthropic 的 `content` 也是数组，一轮里可以带多个 tool_use —— 全部收。
      toolCalls.push({ id: b.id, name: b.name, args: b.input ?? {} });
    }
  }

  // Anthropic `stop_reason` 与 OpenAI `finish_reason` 命名不同，但语义可对齐：
  //   - 'end_turn' / 'stop_sequence' → 'stop'
  //   - 'tool_use'                  → 'tool_calls'
  //   - 'max_tokens'                → 'length'（撞上限被截）
  //   - 其余 / 缺                   → 'other'
  let finishReason: FinishReason;
  switch (wire.stop_reason) {
    case 'end_turn':
    case 'stop_sequence':
      finishReason = 'stop';
      break;
    case 'tool_use':
      finishReason = 'tool_calls';
      break;
    case 'max_tokens':
      finishReason = 'length';
      break;
    case null:
    case undefined:
      finishReason = null;
      break;
    default:
      finishReason = 'other';
      break;
  }

  return {
    text: replyText,
    toolCalls,
    usage: wire.usage
      ? {
          inputTokens: wire.usage.input_tokens ?? 0,
          outputTokens: wire.usage.output_tokens ?? 0,
        }
      : null,
    finishReason,
  };
}

// ─── Google Gemini ────────────────────────────────────────────────────

function buildGoogle(
  base: string,
  opts: ModelCallerOpts,
  messages: ModelMessage[],
  tools: ModelToolSpec[] | undefined,
): { url: string; init: RequestInit } {
  // Gemini contents 把 system 包成第一条 user 消息（实测官方 SDK 同款处理）。
  // tool 用 functionDeclarations 数组嵌套。
  const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: m.content }] });
    } else if (m.role === 'assistant') {
      contents.push({ role: 'model', parts: [{ text: m.content }] });
    }
  }

  const body: Record<string, unknown> = { contents };
  if (tools && tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ];
  }

  return {
    url: `${base}/v1beta/models/${encodeURIComponent(opts.modelId)}:generateContent?key=${encodeURIComponent(opts.apiKey)}`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  };
}

function parseGoogle(text: string): ModelCallResult {
  type Wire = {
    candidates?: Array<{
      finishReason?:
        | 'STOP'
        | 'MAX_TOKENS'
        | 'SAFETY'
        | 'RECITATION'
        | 'OTHER'
        | 'BLOCKLIST'
        | 'PROHIBITED_CONTENT'
        | 'SPII'
        | 'MALFORMED_FUNCTION_CALL'
        | string
        | null;
      content?: {
        parts?: Array<
          | { text: string }
          | { functionCall: { name: string; args?: Record<string, unknown> } }
        >;
      };
    }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  const wire = JSON.parse(text) as Wire;
  const cand = wire.candidates?.[0];
  const parts = cand?.content?.parts ?? [];
  let outText = '';
  const toolCalls: ToolCall[] = [];
  let fnCounter = 0;
  for (const p of parts) {
    if ('text' in p) {
      outText += (outText ? '\n' : '') + p.text;
    } else if ('functionCall' in p) {
      // Gemini 不为 functionCall 分配 id —— 我们生成本地 id，
      //   Chief-loop 层回执时按 `name + localId` 匹配即可。
      toolCalls.push({
        id: `google-${fnCounter++}`,
        name: p.functionCall.name,
        args: p.functionCall.args ?? {},
      });
    }
  }
  // Gemini `finishReason`（注意是大写）映射：
  //   'STOP'         → 'stop'        自然结束
  //   'MAX_TOKENS'   → 'length'      撞 budget，被截
  //   其它           → 'other'（含 SAFETY / RECITATION / MALFORMED_FUNCTION_CALL 等）
  let finishReason: FinishReason;
  switch (cand?.finishReason) {
    case 'STOP':
      finishReason = 'stop';
      break;
    case 'MAX_TOKENS':
      finishReason = 'length';
      break;
    case null:
    case undefined:
      finishReason = null;
      break;
    default:
      finishReason = 'other';
      break;
  }

  return {
    text: outText,
    toolCalls,
    usage: wire.usageMetadata
      ? {
          inputTokens: wire.usageMetadata.promptTokenCount ?? 0,
          outputTokens: wire.usageMetadata.candidatesTokenCount ?? 0,
        }
      : null,
    finishReason,
  };
}

// ─── OpenAI 兼容（openai-completions / openai-responses）──────────────

function buildOpenAI(
  base: string,
  opts: ModelCallerOpts,
  messages: ModelMessage[],
  tools: ModelToolSpec[] | undefined,
): { url: string; init: RequestInit } {
  const body: Record<string, unknown> = {
    model: opts.modelId,
    // 同 `buildAnthropic` 的 8192 说明 —— 本机 Strata / qwen3.8-flash-next 实测
    //   `max_tokens:200` 直接被吃成 `finish_reason:'length'`。`opts.maxTokens` 可覆盖。
    max_tokens: opts.maxTokens ?? 8192,
    // **必须带上 `toolCalls` 与 `tool_call_id`** —— 只发 role/content 的话，
    // 回灌的历史里那些「模型调了工具」的 assistant 回合会退化成纯文本，
    // 后面跟着的 `tool` 消息就找不到对应 assistant.tool_calls，
    // OpenAI 兼容端点下一轮直接 400。回灌历史时这两个字段是硬契约。
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.toolCallId !== undefined ? { tool_call_id: m.toolCallId } : {}),
      ...(m.toolCalls !== undefined && m.toolCalls.length > 0
        ? {
            tool_calls: m.toolCalls.map((t) => ({
              id: t.id,
              type: 'function' as const,
              function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) },
            })),
          }
        : {}),
    })),
  };
  if (tools && tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  return {
    url: `${base}/v1/chat/completions`,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(body),
    },
  };
}

function parseOpenAI(raw: string): ModelCallResult {
  type WireChoice = {
    finish_reason?: string | null;
    message?: {
      // 注意：`content` 在 reasoning 模型上可以是 **null**；文本在
      //   `reasoning_content` 里。这条必须按实测兜底。
      content?: string | null;
      reasoning_content?: string;
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
    };
  };
  type Wire = {
    choices?: WireChoice[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const wire = JSON.parse(raw) as Wire;
  const choice = wire.choices?.[0];
  const msg = choice?.message;

  // ── 文本回落：实测过的两条 ──
  //   1. 纯文本场景：plain 模型的 `content` 是字符串；reasoning 模型的 `content:null`
  //      但 `reasoning_content` 有内容。`content` 非空就用 content，否则看 reasoning。
  //   2. tool_call 场景：reasoning 模型同时给 `content:null` + `reasoning_content:46 字符`
  //      + `tool_calls`。这条**两个都要取**：tool_call 是给执行层的，「要干嘛」给 Chief 看。
  //      所以这里**统一**不丢 reasoning_content —— 有就用，没就算了。
  const contentStr = typeof msg?.content === 'string' ? msg.content : '';
  const reasoningStr = typeof msg?.reasoning_content === 'string' ? msg.reasoning_content : '';
  let text = '';
  if (contentStr.length > 0) {
    text = contentStr;
  } else if (reasoningStr.length > 0) {
    text = reasoningStr;
  }

  // ── tool_calls ──
  // `arguments` 是 **JSON 字符串**（实测 OpenAI / Strata 都这么发），不是对象。
  // 必须 `JSON.parse`，并且**容错**（模型吐非法 JSON 时退回空对象，不让主调用炸）。
  //
  // **必须收全部 tool_calls，不能只取 `[0]`** —— 模型完全可能一轮里发多个
  // （实测本地 qwen3.8-flash-next 就出现过「并行调两次」），只取第一个等于
  // 静默丢掉其余调用。`chief-loop` 按数组处理。
  const toolCalls: ToolCall[] = [];
  for (const tc of msg?.tool_calls ?? []) {
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(tc.function.arguments) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      // 非法 JSON —— 视为空对象，让上层决定怎么处理坏 schema。
    }
    toolCalls.push({ id: tc.id, name: tc.function.name, args });
  }

  // ── finish_reason 归一化 ──
  // 实测：'tool_calls' / 'stop' / 'length' 三种语义不同。'length' 必须向上层冒泡
  //   —— Chief-loop 不能把它当「自然停」续轮。'other' 是兜底（OpenAI 偶尔给空串或
  //   个别其它值如 `'content_filter'`）。
  const rawFinish = choice?.finish_reason;
  let finishReason: FinishReason;
  if (rawFinish === 'stop' || rawFinish === 'tool_calls' || rawFinish === 'length') {
    finishReason = rawFinish;
  } else if (rawFinish === null || rawFinish === undefined || rawFinish === '') {
    finishReason = null;
  } else {
    finishReason = 'other';
  }

  return {
    text,
    toolCalls,
    usage: wire.usage
      ? {
          inputTokens: wire.usage.prompt_tokens ?? 0,
          outputTokens: wire.usage.completion_tokens ?? 0,
        }
      : null,
    finishReason,
  };
}

// ─── fetch 包装 + 错误归一化 ──────────────────────────────────────────

async function doFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  api: ModelApi,
  parse: (text: string) => ModelCallResult,
  timeoutMs: number,
  /** 要从上游错误体里抹掉的凭据原文（见 `redact`） */
  secrets: readonly string[],
): Promise<ModelCallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (err) {
      // 网络不可达 / DNS / abort —— 这是 `unreachable`，**不**算 key 错。
      // 与 `verifyProviderKey` 的 catch 块同语义：放行让上层决定怎么提示。
      if (controller.signal.aborted) {
        throw new ModelCallError(null, 'unreachable', api, 'request aborted (timeout or caller cancel)');
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new ModelCallError(null, 'unreachable', api, `network error: ${msg}`);
    }

    if (!res.ok) {
      const body = await safeText(res);
      // 把凭据的**两种形态**都交给 redact：裸 key、以及 `Bearer <key>` 整段。
      // 上游回显的往往是后者，只脱敏裸 key 拦不住。
      throw classifyHttp(api, res.status, body, secrets);
    }

    const text = await safeText(res);
    try {
      return parse(text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ModelCallError(200, 'invalid_response', api, `bad JSON in response: ${msg}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把已知的凭据原文从任意文本里抹掉。
 *
 * 除 `apiKey` 本身外，也抹 `Bearer <key>` / `x-api-key: <key>` 这类带前缀的形态 ——
 * 上游回显的往往是整个 header 值而不只是裸 key。
 *
 * 空串与超短串不参与替换：`split` 会按空串切出原串，等于没脱敏。
 */
function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 4) continue;
    out = out.split(secret).join('[redacted]');
  }
  return out;
}

/**
 * 错误归一化 —— 与 `routes/providers.ts` 的 `verifyProviderKey` 同语义：
 *   - 401/403 → `'auth'`（key 真错）
 *   - 429     → `'rate_limit'`（限流，**不算** key 错）
 *   - 5xx     → `'server'`（上游炸）
 *   - 4xx 其它 → `'bad_request'`（参数拼错或网关 schema 不认）
 *
 * `message` 只用 status + **脱敏后**的 body。**绝不**把 body 原样塞回去：网关错误体
 * 有时会把我们发的 key 原文回显（实测少量自建网关），那是泄露。
 */
function classifyHttp(api: ModelApi, status: number, body: string, secrets: readonly string[]): ModelCallError {
  // **必须真的脱敏，不能只截断。** 函数上方的注释写着「网关有时会把我们发的 key
  // 原文回显」—— 那时只 `slice(0, 500)` 等于把泄露原样带进错误消息。实测：
  // 注入一个会 echo 请求头的假上游，`apiKey` 原文就出现在 message 里。
  //
  // 所以这里把已知的凭据**逐个替换掉**，再做长度截断。
  const safeBody = redact(body, secrets).slice(0, 500);
  if (status === 401 || status === 403) {
    return new ModelCallError(status, 'auth', api, `upstream rejected credentials (${status})`);
  }
  if (status === 429) {
    return new ModelCallError(status, 'rate_limit', api, `upstream rate-limited (429)`);
  }
  if (status >= 500) {
    return new ModelCallError(status, 'server', api, `upstream error (${status}): ${safeBody}`);
  }
  return new ModelCallError(status, 'bad_request', api, `upstream rejected request (${status}): ${safeBody}`);
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

// ─── MODEL_APIS 重导出（让高层「TS exhaustiveness check」能引用） ─────

export { MODEL_APIS };
export type { ModelApi };
