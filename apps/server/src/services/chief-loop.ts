/**
 * Chief 的 tool-calling 主循环 —— 把模型 + 工具装成一轮对话。
 *
 * 设计要点：
 * - **判据是 `toolCalls.length > 0`**，不是「`content` 是 `null`」也不是
 *   「`text` 为空」。实测上游 (OpenAI 兼容 / Anthropic 兼容) 在要工具
 *   时：`finish_reason:"tool_calls"`、`content: null`、或者更要命的——
 *   有些 provider 在 tool_calls 与文本并存时也只回 `content: null`。
 *   唯一可靠信号是 `tool_calls` 数组。
 * - **`toolCalls` 上限**：本循环目前假设「模型一次最多调一个工具」
 *   （循环语义是「等结果 → 喂结果 → 再调一次」）。OpenAI / Anthropic 的
 *   tool_calls 数组允许多个并发调用，那种语义需要不同的循环（fan-out
 *   后 fan-in）。本次**不**支持，文档里钉死，让上层按数组处理时知道
 *   要重写循环。
 * - **停止原因暴露**：`stoppedBy` 不止 `'max_iterations'` 与
 *   `'text'` 两值；新增 `'truncated'`（`finish_reason === "length"`，
 *   预算耗尽被截断，不等于模型沉默）+ `'tool_call'`（要调工具）。
 *   Chief 拿到这四个之一就能据此决定要不要重发 / 换策略 / 切更小模型。
 * - **assistant 工具调用必须带 `tool_calls` 回灌**；否则下一轮上游 400。
 *   与 OpenAI Chat Completions 兼容格式一致。
 * - **默认 `maxIterations = 8`**：Chief 是派工型 agent，1–3 次工具调用就
 *   够拍板；超过 8 几乎一定是浪费上下文预算。
 * - **工具失败 (`ok === false`) 不抛异常、不伪装成功**：把
 *   `{ok:false, reason}` 序列化进 tool 消息，让模型自己看理由换策略。
 * - **工具 handler 抛异常时也当作工具失败继续**：与上文一致——一个
 *   handler 崩了不该把整轮带崩；上层日志拿原始异常。
 * - **JSON 解析失败**（上游给的 `arguments` 不是合法 JSON）规整进
 *   `args` 失败信号，本轮当工具失败继续；不假装成功。
 *
 * **本文件不依赖 `chief-model.ts`** —— 它由并行子代理同时写、本地联合
 * 验证前不一定落盘。这里声明它**应当**提供的最小契约；双方都按此对
 * 齐，真正的实现文件由另一个 slice 提供。`ModelMessage` 的 `tool_calls`
 * / `tool_call_id` 字段语义与 OpenAI Chat Completions 兼容，与
 * `chief-model.ts` 应保持一致。
 */
import type { ChiefToolOutcome } from '../chief/executor.js';

// ── 与 chief-model.ts 对齐的类型 ──────────────────────────────────────
//
// chief-model.ts 同时由另一个子代理写；本文件不导入它，直接声明应当对齐的
// 形状。等真文件落地后两边类型应该可以合并（shape 兼容）。

/** 与 `chief-model.ts::ModelMessage` 对齐 —— chat turn 一条。 */
// 消息 / 工具 / 调用结果的类型**归属 `chief-model.ts`**（真正发 HTTP 的那层）。
// 这里曾本地重复声明三份 —— 结果 `chief-model` 把 `toolCall` 改成数组 `toolCalls` 时，
// 本地副本没跟上，两边长得一样但语义不同，类型系统都拦不住。单一归属，别再复制。
export type {
  ModelMessage,
  ModelToolSpec,
  ModelCallResult,
  ToolCall,
  FinishReason,
} from './chief-model.js';
import type {
  ModelMessage,
  ModelToolSpec,
  ModelCallResult,
  FinishReason,
} from './chief-model.js';

export type ModelCaller = (
  messages: ModelMessage[],
  tools?: ModelToolSpec[],
) => Promise<ModelCallResult>;

/** 与 `executor.ts::ChiefToolOutcome` 同源，但执行层定义在 executor.ts。 */
export type { ChiefToolOutcome };

/** 工具执行入口 —— `runChiefTurn` 不关心 handler 怎么找、闸门怎么走。 */
export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>,
) => Promise<ChiefToolOutcome>;

/** runChiefTurn 的依赖注入。 */
export interface ChiefLoopDeps {
  callModel: ModelCaller;
  executeTool: ToolExecutor;
}

/** runChiefTurn 入参。 */
export interface ChiefTurnInput {
  systemPrompt: string;
  history: ModelMessage[];
  userMessage: string;
  tools: ModelToolSpec[];
  /** 默认 8。Chief 是派工型，通常 1–3 轮就够；超过 8 几乎一定是浪费预算。 */
  maxIterations?: number;
}

/**
 * runChiefTurn 出参。
 *
 * `stoppedBy` 四值各自的语义与 caller 应当做什么动作：
 *   - `'text'`        —— 模型拍板出文本，对话收口；caller 直接用 `text`。
 *   - `'tool_call'`   —— 模型要继续调工具但已达 maxIterations 还没拍板；
 *                       罕见；caller 通常会因为 maxIterations 已到而升级为
 *                       'max_iterations'，本值主要是诊断信号。
 *   - `'max_iterations'` —— 走够 maxIterations 都还没拍板文本；`text` 为空，
 *                       `toolCalls` 有 maxIterations 条记录。caller 应当
 *                       决定要不要重发 / 换更小预算 / 提示用户。
 *   - `'truncated'`   —— 上游 `finish_reason:"length"`：预算耗尽被截断。
 *                       **不等于**模型沉默也不等于模型要调工具。`text`
 *                       是被截掉的那半截；caller 应当重发或切更小模型，
 *                       提示「Chief 上一轮被截断了」。
 */
export interface ChiefTurnResult {
  /** 最终文本答复。`stoppedBy !== 'text'` 时为 `''`（不假装有话说）。 */
  text: string;
  /** 每一轮工具调用的归档。长度最多 `maxIterations`。 */
  toolCalls: Array<{ name: string; ok: boolean; reason?: string }>;
  /** 实际走了几轮（1..maxIterations）。 */
  iterations: number;
  /** 收口原因：`text` / `tool_call` / `max_iterations` / `truncated`。 */
  stoppedBy: 'text' | 'tool_call' | 'max_iterations' | 'truncated';
  /**
   * 收口时的上游 `finish_reason` 归一化结果。
   *
   * 用 `FinishReason`（而不是 `string`）：它**包含 `null`** —— 上游没给
   * `finish_reason` 时是缺省值，`null` 是合法取值之一。声明成 `string`
   * 会让「上游没给」这个真实情况在类型上无法表达。
   */
  finishReason: FinishReason;
}

const DEFAULT_MAX_ITERATIONS = 8;

/**
 * 工具调用的 OpenAI 兼容回灌 envelope：
 *   - assistant 那条带 `tool_calls`（必须是模型本轮真实生成的形状）
 *   - tool 那条带 `tool_call_id` + `content`
 *
 * 历史里如果本来就只存 tool 结果，上游下一轮请求会因为找不到对应
 * assistant.tool_calls 而 400 —— 这是 OpenAI / Anthropic 兼容 API 的硬契约。
 */
function buildAssistantToolTurn(
  calls: ReadonlyArray<{ id: string; name: string; args: Record<string, unknown> }>,
): ModelMessage {
  return {
    role: 'assistant',
    content: '',
    toolCalls: calls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
  };
}

/**
 * 把工具结果（无论成功失败、是否抛异常被捕）规整成 JSON 喂给模型。
 *
 * 失败时把 `{ok:false, reason}` 显式写进 content，让模型看到「这个工具
 * 拒绝了我、原因是 X」自行换策略；不抛出、不伪装成功。
 */
function serializeToolOutcome(outcome: ChiefToolOutcome): string {
  // 成功时也带上 `ok:true` 留个标记 —— 上游有的 API 用 content 是不是
  // 「{}」区分成功失败，给点显式信号更稳。
  const payload = {
    ok: outcome.ok,
    tool: outcome.tool,
    reason: outcome.reason,
    result: outcome.result,
  };
  return JSON.stringify(payload);
}

/**
 * 解析模型给的 `arguments` 字符串 —— 上游（OpenAI/Anthropic 兼容）发来
 * 的是 JSON 字符串，并不保证合法。解析失败的 `args` 一律走工具失败分支。
 */
/**
 * discriminated union: `ok === true` 时必含 `args`，`ok === false` 时必含 `reason`。
 * 用显式交集+`as const` 让 TS 把 `ok` 当字面量收窄。
 */
type ParsedToolArgs =
  | { readonly ok: true; readonly args: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string };

function parseToolArgs(raw: string, fallbackName: string): ParsedToolArgs {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, reason: `empty arguments for tool "${fallbackName}"` } as const;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        ok: false,
        reason: `arguments for tool "${fallbackName}" must be a JSON object (got ${Array.isArray(parsed) ? 'array' : typeof parsed})`,
      } as const;
    }
    return { ok: true, args: parsed as Record<string, unknown> } as const;
  } catch (err) {
    return {
      ok: false,
      reason: `arguments for tool "${fallbackName}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    } as const;
  }
}

/**
 * Chief 的主循环：标准 tool-calling 模式。
 *
 *   1. 拼 system + history + user 给模型
 *   2. 拿结果：
 *        - `finish_reason:"length"` → 立即 `stoppedBy:"truncated"` 收口，
 *          不进下一轮；这是**被截断**而非模型沉默，caller 必须区分。
 *        - `tool_calls` 非空 → 执行 + 回灌
 *        - `tool_calls` 空 → 文本收口，`stoppedBy:"text"`
 *   3. 走够 maxIterations 还没拍板文本 → `stoppedBy:"max_iterations"`
 */
export async function runChiefTurn(
  deps: ChiefLoopDeps,
  input: ChiefTurnInput,
): Promise<ChiefTurnResult> {
  const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    // 参数崩坏直接抛 —— 这是 caller 的 bug，不是运行时的合法值。
    throw new RangeError(
      `runChiefTurn: maxIterations must be a positive integer (got ${String(maxIterations)})`,
    );
  }

  const messages: ModelMessage[] = [
    { role: 'system', content: input.systemPrompt },
    ...input.history,
    { role: 'user', content: input.userMessage },
  ];

  const toolCalls: ChiefTurnResult['toolCalls'] = [];

  for (let i = 1; i <= maxIterations; i++) {
    const r = await deps.callModel(messages, input.tools);

    // 上游被截断 —— 预算耗尽。**绝不等同**于模型沉默，也不等于要调工具。
    // 立即返回带 `stoppedBy:"truncated"`，让 caller 自己决定怎么重发/换模型。
    if (r.finishReason === 'length') {
      return {
        text: r.text,
        toolCalls,
        iterations: i,
        stoppedBy: 'truncated',
        finishReason: r.finishReason,
      };
    }

    // 模型要调工具 —— 判据**只看 tool_calls 数组**，不看 text 是否空。
    const tc = r.toolCalls;
    if (tc.length > 0) {
      // assistant 那条带 tool_calls 回灌（OpenAI 兼容硬契约）。
      messages.push(buildAssistantToolTurn(tc));

      // 本循环假设「至多一个」：多于一个就只跑第一个，把剩余原样塞进
      // 一个失败回灌里告诉模型『我每次只处理一个』。要支持并发 fan-out
      // 是更大的语义改造，写在本文件之外。
      const first = tc[0]!;
      const rest = tc.slice(1);
      const overflowNote =
        rest.length > 0
          ? ` (loop handles at most one tool call per turn; ${rest.length} more ignored)`
          : '';

      const parsed = parseToolArgs(JSON.stringify(first.args ?? {}), first.name);
      let outcome: ChiefToolOutcome;
      if (!parsed.ok) {
        outcome = {
          tool: first.name,
          ok: false,
          reason: parsed.reason + overflowNote,
        };
      } else {
        try {
          outcome = await deps.executeTool(first.name, parsed.args);
        } catch (err) {
          // handler 抛异常：当作工具失败继续，不把整轮带崩。
          outcome = {
            tool: first.name,
            ok: false,
            reason:
              (err instanceof Error ? err.message : String(err)) + overflowNote,
          };
        }
        if (outcome.reason && overflowNote) {
          outcome = { ...outcome, reason: outcome.reason + overflowNote };
        }
      }

      messages.push({
        role: 'tool',
        toolCallId: first.id,
        content: serializeToolOutcome(outcome),
      });
      toolCalls.push({
        name: first.name,
        ok: outcome.ok,
        ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      });
      // 继续下一轮。
      continue;
    }

    // tool_calls 空、finish_reason 不是 length —— 模型拍板出文本，收口。
    return {
      text: r.text,
      toolCalls,
      iterations: i,
      stoppedBy: 'text',
      finishReason: r.finishReason,
    };
  }

  // 走够 maxIterations 都还没拍板文本 —— 这种情况**最后**一轮的
  // callModel 必然是「要调工具但已无预算」，归类为 `max_iterations`；
  // 上层拿到 `toolCall` 残留没什么用，留空。
  //
  // `finishReason` 这里给 `null`：`max_iterations` 是**我们自己的**收口原因，
  // 不是上游 `finish_reason` 的取值。往这个字段里塞 `'max_iterations'`
  // （之前就是这么写的）会让观测侧把「我们自己停了」误读成「上游这么说」——
  // 类型改成 `FinishReason` 之后它被直接挡住了。
  return {
    text: '',
    toolCalls,
    iterations: maxIterations,
    stoppedBy: 'max_iterations',
    finishReason: null,
  };
}
