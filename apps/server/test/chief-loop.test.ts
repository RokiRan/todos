import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  runChiefTurn,
  type ChiefLoopDeps,
  type ModelMessage,
  type ModelCallResult,
  type ModelToolSpec,
  type ToolExecutor,
  type ModelCaller,
} from '../src/services/chief-loop.js';
import type { ChiefToolOutcome } from '../src/chief/executor.js';

// ── 假工具模型 —— 完全控制序列，不打真 HTTP。───────────────────────

interface ScriptStep {
  /** 这次模型说「要调什么工具」；空数组 = 出文本。 */
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  /** 这次模型输出的文本（可空）。 */
  text?: string;
  /** finish_reason，默认按 toolCalls 是否空选 'tool_calls' / 'stop'。 */
  finishReason?: string;
}

/**
 * 构造一个按剧本响应的假 callModel。每一轮消耗一条脚本；脚本耗尽时如果
 * 还在循环里就抛错（防止脚本写少造成死循环被静默吃掉）。
 *
 * 每条助手回应会**展开时**就生成固定的 tool_call id —— 不让测试依赖 id
 * 拼接，让失败信息可读。
 */
function scriptedCaller(
  script: ReadonlyArray<ScriptStep>,
  recorder?: { messages: ModelMessage[] },
): ModelCaller {
  let i = 0;
  return async (messages, _tools) => {
    if (recorder) recorder.messages.push(...messages);
    const step = script[i++];
    if (!step) {
      throw new Error(
        `scriptedCaller: 剧本耗尽（已用 ${i - 1}/${script.length} 步），模型被继续调用 -- 写少了。`,
      );
    }
    const fr = step.finishReason ?? (step.toolCalls.length > 0 ? 'tool_calls' : 'stop');
    const out: ModelCallResult = {
      toolCalls: step.toolCalls,
      text: step.text ?? '',
      usage: { inputTokens: 10, outputTokens: 5 },
      finishReason: fr,
    };
    return out;
  };
}

/** 假执行器：按 tool 名从表里查 handler；没有就说工具不存在。 */
function scriptedExecutor(handlers: Record<string, (args: Record<string, unknown>) => ChiefToolOutcome | Promise<ChiefToolOutcome>>): ToolExecutor {
  return async (name, args) => {
    const h = handlers[name];
    if (!h) {
      return { tool: name, ok: false, reason: `unknown tool "${name}"` };
    }
    return await h(args);
  };
}

const TOOLS: ModelToolSpec[] = [
  { name: 'noop', description: 'no-op tool', parameters: { type: 'object', properties: {} } },
  { name: 'fail', description: 'always fails', parameters: { type: 'object', properties: {} } },
  { name: 'throw', description: 'throws', parameters: { type: 'object', properties: {} } },
];

const EMPTY_HISTORY: ModelMessage[] = [];

describe('runChiefTurn — 纯文本出口', () => {
  test('模型一开始就出文本：iterations=1, toolCalls 空', async () => {
    const caller = scriptedCaller([
      { toolCalls: [], text: 'done', finishReason: 'stop' },
    ]);
    const res = await runChiefTurn(
      { callModel: caller, executeTool: scriptedExecutor({}) },
      { systemPrompt: 'sys', history: EMPTY_HISTORY, userMessage: 'hi', tools: TOOLS },
    );
    assert.equal(res.stoppedBy, 'text');
    assert.equal(res.text, 'done');
    assert.equal(res.iterations, 1);
    assert.equal(res.toolCalls.length, 0);
    assert.equal(res.finishReason, 'stop');
  });
});

describe('runChiefTurn — 多轮工具调用', () => {
  test('调一次工具 → 出文本', async () => {
    const seen: { messages: ModelMessage[] } = { messages: [] };
    const caller = scriptedCaller(
      [
        {
          toolCalls: [{ id: 'c1', name: 'noop', args: {} }],
          finishReason: 'tool_calls',
        },
        { toolCalls: [], text: 'ok 调过了', finishReason: 'stop' },
      ],
      seen,
    );
    const executor = scriptedExecutor({ noop: () => ({ tool: 'noop', ok: true }) });
    const res = await runChiefTurn(
      { callModel: caller, executeTool: executor },
      { systemPrompt: 'sys', history: EMPTY_HISTORY, userMessage: 'hi', tools: TOOLS },
    );
    assert.equal(res.stoppedBy, 'text');
    assert.equal(res.text, 'ok 调过了');
    assert.equal(res.iterations, 2);
    assert.equal(res.toolCalls.length, 1);
    assert.deepEqual(res.toolCalls[0], { name: 'noop', ok: true });

    // 关键判据：回灌的 messages 里 assistant 那条**带** toolCalls，
    // tool 那条**带** toolCallId。这是 OpenAI 兼容硬契约，丢了下游 400。
    const lastMsgs = seen.messages.slice(-2);
    assert.equal(lastMsgs[0]?.role, 'assistant');
    assert.ok(Array.isArray(lastMsgs[0]?.toolCalls), 'assistant 必须带 tool_calls');
    assert.equal(lastMsgs[0]?.toolCalls?.[0]?.id, 'c1');
    assert.equal(lastMsgs[1]?.role, 'tool');
    assert.equal(lastMsgs[1]?.toolCallId, 'c1');
  });

  test('调工具 → 失败 → 模型换策略 → 出文本（tool 消息含 reason）', async () => {
    const seen: { messages: ModelMessage[] } = { messages: [] };
    const caller = scriptedCaller(
      [
        {
          toolCalls: [{ id: 'f1', name: 'fail', args: {} }],
          finishReason: 'tool_calls',
        },
        { toolCalls: [], text: '那换条路', finishReason: 'stop' },
      ],
      seen,
    );
    const executor = scriptedExecutor({
      fail: () => ({ tool: 'fail', ok: false, reason: '闸门未通过' }),
    });
    const res = await runChiefTurn(
      { callModel: caller, executeTool: executor },
      { systemPrompt: 'sys', history: EMPTY_HISTORY, userMessage: 'try', tools: TOOLS },
    );
    assert.equal(res.stoppedBy, 'text');
    assert.equal(res.toolCalls.length, 1);
    assert.equal(res.toolCalls[0]?.ok, false);
    assert.equal(res.toolCalls[0]?.reason, '闸门未通过');

    // 模型看到的 tool 消息里有 reason —— 让它能据此换策略
    const lastTool = seen.messages.filter((m) => m.role === 'tool').pop();
    assert.ok(lastTool);
    const parsed = JSON.parse(lastTool!.content) as { ok: boolean; reason?: string };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, '闸门未通过');
  });

  test('executeTool 抛异常 → 当作工具失败，整轮继续', async () => {
    const caller = scriptedCaller([
      {
        toolCalls: [{ id: 't1', name: 'throw', args: {} }],
        finishReason: 'tool_calls',
      },
      { toolCalls: [], text: '好吧', finishReason: 'stop' },
    ]);
    const executor = scriptedExecutor({
      throw: () => {
        throw new Error('handler 崩了');
      },
    });
    const res = await runChiefTurn(
      { callModel: caller, executeTool: executor },
      { systemPrompt: 'sys', history: EMPTY_HISTORY, userMessage: 'x', tools: TOOLS },
    );
    assert.equal(res.stoppedBy, 'text');
    assert.equal(res.text, '好吧');
    assert.equal(res.toolCalls.length, 1);
    assert.equal(res.toolCalls[0]?.ok, false);
    assert.match(res.toolCalls[0]?.reason ?? '', /handler 崩了/);
  });
});

describe('runChiefTurn — 停止条件', () => {
  test('达 maxIterations 返回 stoppedBy:"max_iterations" 且 toolCalls 有 N 条', async () => {
    // 每一轮都说「继续调工具」 —— 三轮后触顶
    const caller = scriptedCaller(
      Array.from({ length: 3 }, (_, i) => ({
        toolCalls: [{ id: `c${i}`, name: 'noop', args: {} }],
        finishReason: 'tool_calls',
      })),
    );
    const executor = scriptedExecutor({ noop: () => ({ tool: 'noop', ok: true }) });
    const res = await runChiefTurn(
      { callModel: caller, executeTool: executor },
      {
        systemPrompt: 'sys',
        history: EMPTY_HISTORY,
        userMessage: 'loop',
        tools: TOOLS,
        maxIterations: 3,
      },
    );
    assert.equal(res.stoppedBy, 'max_iterations');
    assert.equal(res.text, '');
    assert.equal(res.iterations, 3);
    assert.equal(res.toolCalls.length, 3);
    assert.deepEqual(res.toolCalls.map((t) => t.name), ['noop', 'noop', 'noop']);
  });

  test('finish_reason:length → stoppedBy:"truncated"，立即收口', async () => {
    // 第一轮就被截断
    const caller = scriptedCaller([
      { toolCalls: [], text: '刚才正要...', finishReason: 'length' },
    ]);
    const res = await runChiefTurn(
      {
        callModel: caller,
        executeTool: scriptedExecutor({}),
      },
      { systemPrompt: 'sys', history: EMPTY_HISTORY, userMessage: 'long', tools: TOOLS },
    );
    assert.equal(res.stoppedBy, 'truncated');
    assert.equal(res.finishReason, 'length');
    assert.equal(res.iterations, 1);
    assert.equal(res.toolCalls.length, 0);
    // text 是被截断的那半截，传给 caller 让它能诊断/重发。
    assert.equal(res.text, '刚才正要...');
  });
});

describe('runChiefTurn — 多次调同一个工具（不去重）', () => {
  test('模型连续两次调同一个工具都执行 —— 全部入档', async () => {
    const caller = scriptedCaller([
      {
        toolCalls: [{ id: 'a', name: 'noop', args: { n: 1 } }],
        finishReason: 'tool_calls',
      },
      {
        toolCalls: [{ id: 'b', name: 'noop', args: { n: 2 } }],
        finishReason: 'tool_calls',
      },
      { toolCalls: [], text: 'done', finishReason: 'stop' },
    ]);
    const seen: Array<Record<string, unknown>> = [];
    const executor = scriptedExecutor({
      noop: (args) => {
        seen.push(args);
        return { tool: 'noop', ok: true, result: args };
      },
    });
    const res = await runChiefTurn(
      { callModel: caller, executeTool: executor },
      { systemPrompt: 'sys', history: EMPTY_HISTORY, userMessage: 'twice', tools: TOOLS },
    );
    assert.equal(res.stoppedBy, 'text');
    assert.equal(res.iterations, 3);
    assert.equal(res.toolCalls.length, 2);
    assert.deepEqual(seen, [{ n: 1 }, { n: 2 }]);
  });
});

describe('runChiefTurn — 历史与 messages 拼装', () => {
  test('messages 开头是 system → ...history → user', async () => {
    const seen: { messages: ModelMessage[] } = { messages: [] };
    const caller = scriptedCaller(
      [{ toolCalls: [], text: 'ok', finishReason: 'stop' }],
      seen,
    );
    await runChiefTurn(
      { callModel: caller, executeTool: scriptedExecutor({}) },
      {
        systemPrompt: 'SYS',
        history: [{ role: 'user', content: '上次问' }, { role: 'assistant', content: '上次答' }],
        userMessage: '这次问',
        tools: TOOLS,
      },
    );
    const first = seen.messages.slice(0, 4);
    assert.equal(first[0]?.role, 'system');
    assert.equal(first[0]?.content, 'SYS');
    assert.equal(first[1]?.role, 'user');
    assert.equal(first[1]?.content, '上次问');
    assert.equal(first[2]?.role, 'assistant');
    assert.equal(first[2]?.content, '上次答');
    assert.equal(first[3]?.role, 'user');
    assert.equal(first[3]?.content, '这次问');
  });
});

describe('runChiefTurn — MUTATION? 变异验证', () => {
  /** 全部断言都带 `MUTATION?` 前缀，便于 `grep -n MUTATION?` 复查。 */

  /**
   * 变异 1：把 maxIterations 触顶后的 `stoppedBy:'max_iterations'` 改成
   * `stoppedBy:'text'`，下面断言应当失败 —— 验证「达上限报『没收敛』」
   * 不只是装饰。
   */
  test('MUTATION? maxIterations 触顶时 stoppedBy 必须是 max_iterations（不是 text）', async () => {
    const caller = scriptedCaller(
      Array.from({ length: 2 }, (_, i) => ({
        toolCalls: [{ id: `c${i}`, name: 'noop', args: {} }],
        finishReason: 'tool_calls',
      })),
    );
    const res = await runChiefTurn(
      { callModel: caller, executeTool: scriptedExecutor({ noop: () => ({ tool: 'noop', ok: true }) }) },
      {
        systemPrompt: 'sys',
        history: EMPTY_HISTORY,
        userMessage: 'loop',
        tools: TOOLS,
        maxIterations: 2,
      },
    );
    assert.notEqual(res.stoppedBy, 'text', 'MUTATION? 触顶不该被当成收口文本');
    assert.equal(res.stoppedBy, 'max_iterations');
  });

  /**
   * 变异 2：把工具失败 `ok:false` 强行改成 `ok:true` 回灌，下面断言
   * 应当失败 —— 验证「工具失败进 tool 消息、不伪装成功」是真的。
   */
  test('MUTATION? 工具失败必须 ok:false 回灌，不能伪装成功', async () => {
    const seen: { messages: ModelMessage[] } = { messages: [] };
    const caller = scriptedCaller(
      [
        {
          toolCalls: [{ id: 'f1', name: 'fail', args: {} }],
          finishReason: 'tool_calls',
        },
        { toolCalls: [], text: 'done', finishReason: 'stop' },
      ],
      seen,
    );
    await runChiefTurn(
      {
        callModel: caller,
        executeTool: scriptedExecutor({ fail: () => ({ tool: 'fail', ok: false, reason: '拒' }) }),
      },
      { systemPrompt: 'sys', history: EMPTY_HISTORY, userMessage: 'x', tools: TOOLS },
    );
    const toolMsg = seen.messages.find((m) => m.role === 'tool' && m.toolCallId === 'f1');
    assert.ok(toolMsg, '必须回灌 tool 消息');
    const parsed = JSON.parse(toolMsg!.content) as { ok: boolean };
    assert.equal(parsed.ok, false, 'MUTATION? 失败不能被洗成 ok:true');
  });

  /**
   * 变异 3：finish_reason:length 被当成 stop，下面断言应当失败 ——
   * 验证「被截断 ≠ 模型沉默」是真的。
   */
  test('MUTATION? finish_reason=length 必须被识别成 truncated，不能当成 text', async () => {
    const caller = scriptedCaller([
      { toolCalls: [], text: '半分句', finishReason: 'length' },
    ]);
    const res = await runChiefTurn(
      { callModel: caller, executeTool: scriptedExecutor({}) },
      { systemPrompt: 'sys', history: EMPTY_HISTORY, userMessage: 'long', tools: TOOLS },
    );
    assert.notEqual(res.stoppedBy, 'text', 'MUTATION? length 绝不能被当作拍板文本');
    assert.equal(res.stoppedBy, 'truncated');
  });

  /**
   * 变异 4：assistant 消息不带 tool_calls 直接回灌 tool 结果，下面
   * 验证回灌形状 —— 验证本文件要求 assistant 必须带 tool_calls。
   */
  test('MUTATION? 工具调用的 assistant 回灌必须带 tool_calls 数组', async () => {
    const seen: { messages: ModelMessage[] } = { messages: [] };
    const caller = scriptedCaller(
      [
        {
          toolCalls: [{ id: 'c1', name: 'noop', args: {} }],
          finishReason: 'tool_calls',
        },
        { toolCalls: [], text: '收', finishReason: 'stop' },
      ],
      seen,
    );
    await runChiefTurn(
      { callModel: caller, executeTool: scriptedExecutor({ noop: () => ({ tool: 'noop', ok: true }) }) },
      { systemPrompt: 'sys', history: EMPTY_HISTORY, userMessage: 'x', tools: TOOLS },
    );
    // 取「调工具那一轮」的 assistant 消息
    const lastAssistant = [...seen.messages].reverse().find((m) => m.role === 'assistant');
    assert.ok(lastAssistant, '必须有 assistant 消息');
    assert.ok(Array.isArray(lastAssistant!.toolCalls), 'MUTATION? assistant 必须带 tool_calls');
    assert.ok((lastAssistant!.toolCalls?.length ?? 0) > 0, 'MUTATION? tool_calls 不能是空数组');
  });
});
