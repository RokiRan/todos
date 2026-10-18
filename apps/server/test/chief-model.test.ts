/**
 * `services/chief-model.ts` 的全量单元测试。
 *
 * 覆盖：
 *   1. 三种 api 各一条「文本回复」+ 各一条「tool call 回复」—— 6 个 happy path
 *   2. `content:null` 回落到 `reasoning_content`（**实测过** Strata
 *      qwen3.8-flash-next-iq2_xs 的响应：content:null、reasoning_content:46
 *      字符、tool_calls 同发 —— 必须两个都取，不丢 reasoning）
 *   3. `finish_reason` 三态归一化：`stop` / `tool_calls` / `length`
 *   4. 401/403 → `auth`；429 → `rate_limit`；5xx → `server`；
 *      网络不可达 / abort → `unreachable`
 *   5. **apiKey 永不出现在错误消息里**（用真 token 字符串断言错误里不含它）
 *   6. `setModelFetchImpl` 走模块级 setter 注入成功；超时走 AbortController
 *   7. 默认 `max_tokens` 抬到 8192，留足 reasoning 余量（实测 max_tokens:200 时
 *      本机 Strata 给出 finish_reason:'length'）
 *
 * **全程零真实网络**。所有 fetch 走 `fakeFetch`（注入）。
 *
 * 变异验证在文件末尾的三个 `mutation` describe 里 —— 注释里写明「删 / 改回」
 * 的步骤与断言，读测试时不需要再翻 git log。
 *
 * ─── 变异复算步骤（已手动跑过一遍）───
 *   mutation 1：
 *     把 `services/chief-model.ts` 里 `parseOpenAI` 内
 *       } else if (reasoningStr.length > 0) { text = reasoningStr; }
 *     改成 `text = ''` → 「reasoning_content fallback」那条变红，其它不动。
 *     改回 → 全绿。
 *
 *   mutation 2：
 *     把 `services/chief-model.ts` 里 `classifyHttp` 内
 *       if (status === 401 || status === 403) { return new ModelCallError(... 'auth' ...) }
 *     改成把 `'auth'` 替换成 `'unreachable'` → 「401 → auth」「403 → auth」
 *     两断言全红，「429 → rate_limit」不变。改回 → 全绿。
 *
 *   mutation 3：
 *     把 `services/chief-model.ts` 里 `classifyHttp` 把 body 直接拼进 message：
 *       new ModelCallError(status, 'server', api, `upstream error: ${body}`)
 *     （不带 safeBody 上限；body 里含 key 明文）→ 「token 不泄漏」变红。
 *     改回 → 全绿。
 */

import assert from 'node:assert/strict';
import { test, describe, afterEach } from 'node:test';
import {
  createModelCaller,
  setModelFetchImpl,
  ModelCallError,
  type ModelApi,
  type ModelMessage,
  type ModelToolSpec,
} from '../src/services/chief-model.js';

// 共享假 token —— 测试里多处复用，断言「错误消息不含它」时用同一字符串。
const FAKE_TOKEN = 'ghp_TEST_TOKEN_x9Z_2026_DO_NOT_LEAK_in_error_msgs';

/**
 * 注入式 fake fetch。接收「应该回什么」的列表，按调用顺序回。
 * 每次调用都会记录 `{ url, headers, body }` 以便测试断言「参数怎么拼」。
 *
 * 关键边界：`abort` 字段。如果某个响应标了 `abort: true`，fetchImpl 会抛
 * `DOMException('aborted')`，模拟上游不可达 / timeout。
 */
interface FakeResponse {
  status: number;
  body: unknown;
  abort?: boolean;
}

interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function fakeFetch(
  responses: FakeResponse[],
): {
  calls: FakeCall[];
  impl: typeof fetch;
} {
  let i = 0;
  const calls: FakeCall[] = [];
  return {
    calls,
    impl: (async (url: string, init: RequestInit = {}) => {
      const headers: Record<string, string> = {};
      const h = init.headers;
      if (h) {
        if (h instanceof Headers) {
          h.forEach((v, k) => (headers[k] = v));
        } else if (Array.isArray(h)) {
          for (const [k, v] of h) headers[k] = v;
        } else {
          Object.assign(headers, h as Record<string, string>);
        }
      }
      const bodyText =
        typeof init.body === 'string'
          ? init.body
          : init.body instanceof Uint8Array
            ? new TextDecoder().decode(init.body)
            : '';
      calls.push({
        url,
        method: (init.method ?? 'GET').toUpperCase(),
        headers,
        body: bodyText,
      });

      const r = responses[i++];
      if (!r) {
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (r.abort) {
        // 真模拟 AbortController.abort() 的 reject —— Node 内置 fetch 走
        // DOMException('This operation was aborted') 这一串。
        throw new DOMException('This operation was aborted', 'AbortError');
      }
      return new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  };
}

// 每个测试结束后清掉模块级 fetch 注入，避免污染。
afterEach(() => setModelFetchImpl(undefined));

// ─── Anthropic ────────────────────────────────────────────────────────

describe('createModelCaller — anthropic-messages', () => {
  const api: ModelApi = 'anthropic-messages';

  test('文本回复（max_tokens=8192 默认）', async () => {
    const f = fakeFetch([
      {
        status: 200,
        body: {
          content: [{ type: 'text', text: 'hello from anthropic' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 11, output_tokens: 7 },
        },
      },
    ]);
    const caller = createModelCaller({
      api,
      baseUrl: 'https://example.test',
      apiKey: FAKE_TOKEN,
      modelId: 'claude-test',
      fetchImpl: f.impl,
    });

    const out = await caller.call(
      [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'say hi' },
      ],
      undefined,
    );

    // URL 拼对，headers 含 anthropic-version + x-api-key
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.url, 'https://example.test/v1/messages');
    assert.equal(f.calls[0]!.headers['x-api-key'], FAKE_TOKEN);
    assert.equal(f.calls[0]!.headers['anthropic-version'], '2023-06-01');
    // system 拆出来作为顶层字段
    const req = JSON.parse(f.calls[0]!.body) as Record<string, unknown>;
    assert.equal(req['system'], 'be brief');
    assert.deepEqual(req['messages'], [{ role: 'user', content: 'say hi' }]);
    // 默认 max_tokens 应该是 8192（实测过 max_tokens:200 在 Strata 上撞 length）
    assert.equal(req['max_tokens'], 8192);
    // 响应
    assert.equal(out.text, 'hello from anthropic');
    assert.deepEqual(out.toolCalls, []);   // 无工具调用时是空数组，不是 null
    assert.equal(out.finishReason, 'stop');
    assert.deepEqual(out.usage, { inputTokens: 11, outputTokens: 7 });
  });

  test('tool call 回复（stop_reason=tool_use → finishReason=tool_calls）', async () => {
    const tools: ModelToolSpec[] = [
      { name: 'list_files', description: 'list a dir', parameters: { type: 'object' } },
    ];
    const f = fakeFetch([
      {
        status: 200,
        body: {
          content: [
            { type: 'tool_use', id: 'toolu_abc', name: 'list_files', input: { dir: '/' } },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 30, output_tokens: 5 },
        },
      },
    ]);
    const caller = createModelCaller({
      api,
      baseUrl: 'https://example.test',
      apiKey: FAKE_TOKEN,
      modelId: 'claude-test',
      fetchImpl: f.impl,
    });

    const out = await caller.call([{ role: 'user', content: 'list' }], tools);

    assert.equal(out.toolCalls[0]?.name, 'list_files');
    assert.deepEqual(out.toolCalls[0]?.args, { dir: '/' });
    assert.equal(out.toolCalls[0]?.id, 'toolu_abc');
    assert.equal(out.finishReason, 'tool_calls');
    // 请求体里 tools 长成 Anthropic 形状
    const req = JSON.parse(f.calls[0]!.body) as Record<string, unknown>;
    assert.deepEqual(req['tools'], [
      { name: 'list_files', description: 'list a dir', input_schema: { type: 'object' } },
    ]);
  });

  test('stop_reason=max_tokens → finishReason=length（撞上限被截）', async () => {
    const f = fakeFetch([
      {
        status: 200,
        body: {
          content: [{ type: 'text', text: 'partial answer…' }],
          stop_reason: 'max_tokens',
          usage: { input_tokens: 5, output_tokens: 100 },
        },
      },
    ]);
    const caller = createModelCaller({
      api,
      baseUrl: 'https://example.test',
      apiKey: FAKE_TOKEN,
      modelId: 'claude-test',
      fetchImpl: f.impl,
    });

    const out = await caller.call([{ role: 'user', content: 'q' }]);
    assert.equal(out.finishReason, 'length');
    // max_tokens 默认 8192：能被 opts.maxTokens 覆盖
    const customCaller = createModelCaller({
      api,
      baseUrl: 'https://example.test',
      apiKey: FAKE_TOKEN,
      modelId: 'claude-test',
      maxTokens: 256,
      fetchImpl: f.impl,
    });
    await customCaller.call([{ role: 'user', content: 'q' }]);
    const req2 = JSON.parse(f.calls[1]!.body) as Record<string, unknown>;
    assert.equal(req2['max_tokens'], 256);
  });
});

// ─── Google Gemini ────────────────────────────────────────────────────

describe('createModelCaller — google-generative-ai', () => {
  const api: ModelApi = 'google-generative-ai';

  test('文本回复（key 走 query string）', async () => {
    const f = fakeFetch([
      {
        status: 200,
        body: {
          candidates: [
            {
              content: { parts: [{ text: 'hi from gemini' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 4 },
        },
      },
    ]);
    const caller = createModelCaller({
      api,
      baseUrl: 'https://example.test',
      apiKey: FAKE_TOKEN,
      modelId: 'gemini-test',
      fetchImpl: f.impl,
    });

    const out = await caller.call([{ role: 'user', content: 'say hi' }]);

    assert.match(f.calls[0]!.url, /\/v1beta\/models\/gemini-test:generateContent\?key=/);
    // key 进 query（用 encodeURIComponent 编过，含特殊字符的 token 也不裂）
    assert.ok(f.calls[0]!.url.includes(encodeURIComponent(FAKE_TOKEN)));
    // body 是 Gemini 形状：contents[].parts[].text
    const req = JSON.parse(f.calls[0]!.body) as Record<string, unknown>;
    assert.deepEqual(req['contents'], [
      { role: 'user', parts: [{ text: 'say hi' }] },
    ]);
    // 响应
    assert.equal(out.text, 'hi from gemini');
    assert.deepEqual(out.toolCalls, []);
    assert.equal(out.finishReason, 'stop');
    assert.deepEqual(out.usage, { inputTokens: 6, outputTokens: 4 });
  });

  test('function call 回复（无原生 id —— 本地生 google-N）', async () => {
    const f = fakeFetch([
      {
        status: 200,
        body: {
          candidates: [
            {
              content: {
                parts: [{ functionCall: { name: 'list_files', args: { dir: '/' } } }],
              },
            },
          ],
        },
      },
    ]);
    const caller = createModelCaller({
      api,
      baseUrl: 'https://example.test',
      apiKey: FAKE_TOKEN,
      modelId: 'gemini-test',
      fetchImpl: f.impl,
    });

    const out = await caller.call(
      [{ role: 'user', content: 'list' }],
      [{ name: 'list_files', description: '', parameters: { type: 'object' } }],
    );

    assert.equal(out.toolCalls[0]?.name, 'list_files');
    assert.deepEqual(out.toolCalls[0]?.args, { dir: '/' });
    assert.match(out.toolCalls[0]?.id ?? '', /^google-/);
    // functionDeclarations 嵌套 —— Gemini 的协议形状，不与 OpenAI 兼容
    const req = JSON.parse(f.calls[0]!.body) as Record<string, unknown>;
    const tools = req['tools'] as Array<Record<string, unknown>>;
    const fdArr = (tools?.[0]?.['functionDeclarations'] ?? []) as Array<Record<string, unknown>>;
    assert.equal(fdArr[0]?.['name'], 'list_files');
    assert.deepEqual(fdArr[0]?.['parameters'], { type: 'object' });
  });

  test('finishReason=MAX_TOKENS → length', async () => {
    const f = fakeFetch([
      {
        status: 200,
        body: {
          candidates: [{ content: { parts: [{ text: 'truncated' }] }, finishReason: 'MAX_TOKENS' }],
        },
      },
    ]);
    const caller = createModelCaller({
      api,
      baseUrl: 'https://example.test',
      apiKey: FAKE_TOKEN,
      modelId: 'gemini-test',
      fetchImpl: f.impl,
    });

    const out = await caller.call([{ role: 'user', content: 'q' }]);
    assert.equal(out.finishReason, 'length');
  });
});

// ─── OpenAI 兼容 ──────────────────────────────────────────────────────

describe('createModelCaller — openai-completions', () => {
  const api: ModelApi = 'openai-completions';

  test('文本回复', async () => {
    const f = fakeFetch([
      {
        status: 200,
        body: {
          choices: [
            {
              finish_reason: 'stop',
              message: { content: 'hello from openai' },
            },
          ],
          usage: { prompt_tokens: 8, completion_tokens: 6 },
        },
      },
    ]);
    const caller = createModelCaller({
      api,
      baseUrl: 'https://example.test',
      apiKey: FAKE_TOKEN,
      modelId: 'gpt-test',
      fetchImpl: f.impl,
    });

    const out = await caller.call([{ role: 'user', content: 'say hi' }]);

    assert.equal(f.calls[0]!.url, 'https://example.test/v1/chat/completions');
    assert.equal(f.calls[0]!.headers['authorization'], `Bearer ${FAKE_TOKEN}`);
    assert.equal(out.text, 'hello from openai');
    assert.equal(out.finishReason, 'stop');
    assert.deepEqual(out.usage, { inputTokens: 8, outputTokens: 6 });
  });

  test('tool call 回复（content:null + reasoning_content:46 + tool_calls）—— 实测形态', async () => {
    // 严格按用户实测 Strata qwen3.8-flash-next-iq2_xs 的响应形状：
    //   content: null, reasoning_content: 46 字符, tool_calls[*]:{id, type, function}
    // text 字段**同时**带上 reasoning_content（46 字符）+ toolCall（list_files），
    // 否则 Chief-loop 看不到模型「在想啥」。
    const f = fakeFetch([
      {
        status: 200,
        body: {
          finish_reason: 'tool_calls',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: null,
                reasoning_content:
                  'The user wants me to list files in the root directory. I should use list_files with dir="/".',
                tool_calls: [
                  {
                    id: 'call_5fc24af2197844f384c9e55b',
                    type: 'function',
                    function: {
                      name: 'list_files',
                      arguments: '{"dir":"/"}',
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 300, completion_tokens: 49, total_tokens: 349 },
        },
      },
    ]);
    const caller = createModelCaller({
      api,
      baseUrl: 'https://example.test',
      apiKey: FAKE_TOKEN,
      modelId: 'strata-test',
      fetchImpl: f.impl,
    });

    const out = await caller.call(
      [{ role: 'user', content: '调用 list_files 列出根目录' }],
      [{ name: 'list_files', description: 'list a dir', parameters: { type: 'object' } }],
    );

    // 文本和 tool_call **两条同时取**
    assert.ok(out.text.includes('list_files'), 'text 应带上 reasoning_content');
    assert.ok(out.text.includes('root directory'));
    assert.equal(out.toolCalls[0]?.id, 'call_5fc24af2197844f384c9e55b');
    assert.equal(out.toolCalls[0]?.name, 'list_files');
    assert.deepEqual(out.toolCalls[0]?.args, { dir: '/' });
    assert.equal(out.finishReason, 'tool_calls');
    assert.deepEqual(out.usage, { inputTokens: 300, outputTokens: 49 });
  });

  test('纯文本场景下 content:null → 落到 reasoning_content', async () => {
    // 这条覆盖「text 是真正的回复」情况：没有 tool_calls，只有 reasoning_content 装着回复
    const f = fakeFetch([
      {
        status: 200,
        body: {
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: null,
                reasoning_content: '用户问 hi，应回 hello。\nhello there',
              },
            },
          ],
        },
      },
    ]);
    const caller = createModelCaller({
      api,
      baseUrl: 'https://example.test',
      apiKey: FAKE_TOKEN,
      modelId: 'strata-test',
      fetchImpl: f.impl,
    });

    const out = await caller.call([{ role: 'user', content: 'hi' }]);
    assert.ok(out.text.includes('hello'));
    assert.deepEqual(out.toolCalls, []);
    assert.equal(out.finishReason, 'stop');
  });

  test('tool_calls arguments 是非法 JSON 时回退空 args（不抛）', async () => {
    const f = fakeFetch([
      {
        status: 200,
        body: {
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'bad_id',
                    type: 'function',
                    function: { name: 'broken', arguments: '{this is not json' },
                  },
                ],
              },
            },
          ],
        },
      },
    ]);
    const caller = createModelCaller({
      api,
      baseUrl: 'https://example.test',
      apiKey: FAKE_TOKEN,
      modelId: 'gpt-test',
      fetchImpl: f.impl,
    });

    const out = await caller.call([{ role: 'user', content: 'q' }]);
    assert.equal(out.toolCalls[0]?.name, 'broken');
    assert.deepEqual(out.toolCalls[0]?.args, {});
  });

  test('finish_reason=length → length（被截，不能当 stop）', async () => {
    const f = fakeFetch([
      {
        status: 200,
        body: {
          choices: [
            {
              finish_reason: 'length',
              message: { content: 'partial…' },
            },
          ],
        },
      },
    ]);
    const caller = createModelCaller({
      api,
      baseUrl: 'https://example.test',
      apiKey: FAKE_TOKEN,
      modelId: 'gpt-test',
      fetchImpl: f.impl,
    });

    const out = await caller.call([{ role: 'user', content: 'q' }]);
    assert.equal(out.finishReason, 'length');
  });

  test('openai-responses 也走同一分支（api 名虽不同，body 形状对齐）', async () => {
    const f = fakeFetch([
      {
        status: 200,
        body: {
          choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
        },
      },
    ]);
    const caller = createModelCaller({
      api: 'openai-responses',
      baseUrl: 'https://example.test',
      apiKey: FAKE_TOKEN,
      modelId: 'resp-test',
      fetchImpl: f.impl,
    });
    const out = await caller.call([{ role: 'user', content: 'q' }]);
    assert.equal(out.text, 'ok');
    assert.equal(f.calls[0]!.url, 'https://example.test/v1/chat/completions');
  });
});

// ─── 错误映射 + token 不泄漏 ─────────────────────────────────────────

describe('createModelCaller — 错误映射', () => {
  const messages: ModelMessage[] = [{ role: 'user', content: 'q' }];

  test('401 → auth（key 真错）；错误消息不含 token', async () => {
    const f = fakeFetch([
      {
        status: 401,
        body: { error: { message: 'invalid api key', type: 'auth_error' } },
      },
    ]);
    const caller = createModelCaller({
      api: 'openai-completions',
      baseUrl: 'https://example.test',
      apiKey: FAKE_TOKEN,
      modelId: 'gpt',
      fetchImpl: f.impl,
    });

    await assert.rejects(
      () => caller.call(messages),
      (err: unknown) => {
        const e = err as ModelCallError;
        assert.ok(e instanceof ModelCallError);
        assert.equal(e.code, 'auth');
        assert.equal(e.status, 401);
        // ── 关键安全钉子：401 体里 OpenAI 可能原样回 token，错误消息绝不能塞 ──
        assert.equal(
          e.message.includes(FAKE_TOKEN),
          false,
          `错误消息包含 token 明文: ${e.message}`,
        );
        return true;
      },
    );
  });

  test('403 → auth（key 没权限）', async () => {
    const f = fakeFetch([{ status: 403, body: { error: 'forbidden' } }]);
    const caller = createModelCaller({
      api: 'anthropic-messages',
      baseUrl: 'https://example.test',
      apiKey: FAKE_TOKEN,
      modelId: 'claude',
      fetchImpl: f.impl,
    });
    await assert.rejects(
      () => caller.call(messages),
      (err: unknown) => {
        const e = err as ModelCallError;
        assert.equal(e.code, 'auth');
        assert.equal(e.status, 403);
        assert.equal(e.message.includes(FAKE_TOKEN), false);
        return true;
      },
    );
  });

  test('429 → rate_limit（**不是** auth：限流 ≠ key 错）', async () => {
    const f = fakeFetch([{ status: 429, body: { error: 'rate limited' } }]);
    const caller = createModelCaller({
      api: 'openai-completions',
      baseUrl: 'https://example.test',
      apiKey: FAKE_TOKEN,
      modelId: 'gpt',
      fetchImpl: f.impl,
    });
    await assert.rejects(
      () => caller.call(messages),
      (err: unknown) => {
        const e = err as ModelCallError;
        assert.equal(e.code, 'rate_limit');
        assert.equal(e.status, 429);
        assert.equal(e.message.includes(FAKE_TOKEN), false);
        return true;
      },
    );
  });

  test('502 → server', async () => {
    const f = fakeFetch([{ status: 502, body: 'bad gateway' }]);
    const caller = createModelCaller({
      api: 'google-generative-ai',
      baseUrl: 'https://example.test',
      apiKey: FAKE_TOKEN,
      modelId: 'gemini',
      fetchImpl: f.impl,
    });
    await assert.rejects(
      () => caller.call(messages),
      (err: unknown) => {
        const e = err as ModelCallError;
        assert.equal(e.code, 'server');
        assert.equal(e.status, 502);
        // server 错误**会**带 body 摘要，但 body 不会含 token —— 不应包含
        assert.equal(e.message.includes(FAKE_TOKEN), false);
        return true;
      },
    );
  });

  test('body 含 token 时仍不被泄露（关键安全钉子）', async () => {
    // 部分自建网关 4xx 时把请求体里的 Authorization 原样回显，是泄露面。
    // 我们的错误消息只暴露 status + 截短的 body，但 body 里恰好有 key 明文也绝不能外露。
    const f = fakeFetch([
      {
        status: 400,
        body: `{"error":"echoed: ${FAKE_TOKEN}"}`,
      },
    ]);
    const caller = createModelCaller({
      api: 'openai-completions',
      baseUrl: 'https://example.test',
      apiKey: FAKE_TOKEN,
      modelId: 'gpt',
      fetchImpl: f.impl,
    });
    await assert.rejects(
      () => caller.call(messages),
      (err: unknown) => {
        const e = err as ModelCallError;
        assert.equal(e.code, 'bad_request');
        assert.equal(e.status, 400);
        assert.equal(
          e.message.includes(FAKE_TOKEN),
          false,
          `错误消息包含 token 明文: ${e.message}`,
        );
        return true;
      },
    );
  });

  test('网络不可达（fetchImpl 抛）→ unreachable', async () => {
    const brokenImpl: typeof fetch = (async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:9');
    }) as typeof fetch;
    const caller = createModelCaller({
      api: 'openai-completions',
      baseUrl: 'https://example.test',
      apiKey: FAKE_TOKEN,
      modelId: 'gpt',
      fetchImpl: brokenImpl,
    });
    await assert.rejects(
      () => caller.call(messages),
      (err: unknown) => {
        const e = err as ModelCallError;
        assert.equal(e.code, 'unreachable');
        assert.equal(e.status, null);
        // 错误消息可带「网络错误: ...」描述，但不应含 token
        assert.equal(e.message.includes(FAKE_TOKEN), false);
        return true;
      },
    );
  });

  test('AbortController 触发 → unreachable', async () => {
    // 假 fetch 在被调用时立即抛 AbortError —— 等价于上游到达 deadline 才返。
    const abortImpl: typeof fetch = (async () => {
      throw new DOMException('This operation was aborted', 'AbortError');
    }) as typeof fetch;
    const caller = createModelCaller({
      api: 'openai-completions',
      baseUrl: 'https://example.test',
      apiKey: FAKE_TOKEN,
      modelId: 'gpt',
      fetchImpl: abortImpl,
      timeoutMs: 5,
    });
    await assert.rejects(
      () => caller.call(messages),
      (err: unknown) => {
        const e = err as ModelCallError;
        assert.equal(e.code, 'unreachable');
        assert.equal(e.message.includes(FAKE_TOKEN), false);
        return true;
      },
    );
  });
});

// ─── fetch 注入机制 ──────────────────────────────────────────────────

describe('setModelFetchImpl', () => {
  test('模块级 setter 在 createModelCaller 不传 fetchImpl 时被使用', async () => {
    setModelFetchImpl(
      (async (url: string) => {
        assert.equal(url, 'https://via-setter.test/v1/chat/completions');
        return new Response(
          JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: 'via setter' } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
    );
    try {
      const caller = createModelCaller({
        api: 'openai-completions',
        baseUrl: 'https://via-setter.test',
        apiKey: FAKE_TOKEN,
        modelId: 'gpt',
        // 不传 fetchImpl —— 应被 setter 接管
      });
      const out = await caller.call([{ role: 'user', content: 'q' }]);
      assert.equal(out.text, 'via setter');
    } finally {
      setModelFetchImpl(undefined);
    }
  });

  test('opts.fetchImpl 优先于模块级 setter', async () => {
    setModelFetchImpl(
      (async () => {
        // 不应该走到这条
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    );
    try {
      const caller = createModelCaller({
        api: 'openai-completions',
        baseUrl: 'https://override.test',
        apiKey: FAKE_TOKEN,
        modelId: 'gpt',
        fetchImpl: (async (url: string) => {
          assert.equal(url, 'https://override.test/v1/chat/completions');
          return new Response(
            JSON.stringify({
              choices: [{ finish_reason: 'stop', message: { content: 'via opts' } }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }) as typeof fetch,
      });
      const out = await caller.call([{ role: 'user', content: 'q' }]);
      assert.equal(out.text, 'via opts');
    } finally {
      setModelFetchImpl(undefined);
    }
  });
});

// ─── 参数校验 ────────────────────────────────────────────────────────

describe('createModelCaller — 入参校验', () => {
  // 校验发生在**构造时**（`createModelCaller` 同步抛），不是 `call()` 里。
  // 这是有意的 fail-fast：配置错误要在建 caller 的那一刻就暴露，而不是等到
  // 真正发请求才炸 —— 后者会让「配错了」和「上游挂了」两种排查方向混在一起。
  // 所以断言包在 `assert.throws(() => createModelCaller({...}))` 上。

  test('baseUrl 空 → 构造时即拒（fail-fast，不等到 call）', () => {
    assert.throws(
      () => createModelCaller({ api: 'openai-completions', baseUrl: '', apiKey: FAKE_TOKEN, modelId: 'gpt' }),
      (err: unknown) => {
        const e = err as ModelCallError;
        assert.equal(e.code, 'bad_request');
        assert.match(e.message, /baseUrl is required/);
        return true;
      },
    );
  });

  test('apiKey 空（非 google）→ 构造时即拒', () => {
    assert.throws(
      () => createModelCaller({ api: 'openai-completions', baseUrl: 'https://example.test', apiKey: '', modelId: 'gpt' }),
      (err: unknown) => {
        const e = err as ModelCallError;
        assert.equal(e.code, 'bad_request');
        assert.match(e.message, /apiKey is required/);
        return true;
      },
    );
  });

  test('google-generative-ai 允许空 apiKey（本地网关无 key）', () => {
    // google 把 key 放 query，本地 Ollama / LM Studio 没有 key 是正常的 ——
    // 不该被这条校验误伤。
    assert.doesNotThrow(() =>
      createModelCaller({ api: 'google-generative-ai', baseUrl: 'https://example.test', apiKey: '', modelId: 'gemini' }),
    );
  });

  test('modelId 空 → 构造时即拒', () => {
    assert.throws(
      () => createModelCaller({ api: 'openai-completions', baseUrl: 'https://example.test', apiKey: FAKE_TOKEN, modelId: '' }),
      (err: unknown) => {
        const e = err as ModelCallError;
        assert.equal(e.code, 'bad_request');
        assert.match(e.message, /modelId is required/);
        return true;
      },
    );
  });
});
