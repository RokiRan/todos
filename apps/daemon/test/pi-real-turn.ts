import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PiDriver } from '../src/drivers/pi.js';
import type { StreamFrame } from '@tds/protocol';

/**
 * pi 真跑一轮 turn —— 不是 mock，是真的调用本地 Ollama。
 *
 * 用的是原站文档里的「本地网关」场景（docs/providers.md）：
 * 「An API key is optional for local gateways (such as Ollama or LM Studio)
 *   that require none.」→ 所以 apiKey 为空字符串也是合法配置。
 *
 * 与单测的分工：单测验接线（凭据不落盘、无模型报错等），
 * 这里验「pi 真的能驱动一个模型完成一轮对话并读写文件」。
 */

const OLLAMA = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/v1';
const MODEL = process.env.PI_TEST_MODEL ?? 'qwen3:14b';

async function main(): Promise<void> {
  // 先确认端点活着，否则报错要清楚
  let models: string[] = [];
  try {
    const res = await fetch(`${OLLAMA}/models`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ id: string }> };
    models = (body.data ?? []).map((m) => m.id);
  } catch (err) {
    console.log(`SKIP: Ollama 不可达 (${OLLAMA}): ${err instanceof Error ? err.message : String(err)}`);
    process.exit(0);
  }
  if (models.length === 0) {
    console.log('SKIP: Ollama 在线但没有模型');
    process.exit(0);
  }
  const modelId = models.includes(MODEL) ? MODEL : (models[0] as string);
  console.log(`端点: ${OLLAMA}`);
  console.log(`模型: ${modelId}  (共 ${models.length} 个可选)`);

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tds-pi-real-'));
  // 给 pi 一个明确、可验证的任务
  fs.writeFileSync(path.join(cwd, 'input.txt'), '3\n', 'utf8');

  const driver = new PiDriver();
  const frames: StreamFrame[] = [];
  const controller = new AbortController();
  // 本地小模型可能慢，给足 8 分钟
  const timer = setTimeout(() => controller.abort(), 480_000);

  console.log(`工作目录: ${cwd}`);
  console.log('--- 开始 ---');

  const result = await driver.run(
    {
      cwd,
      prompt:
        'Read the file input.txt in the current directory. ' +
        'Then create a file named answer.txt whose only content is the square of that number. ' +
        'Do not add any other text.',
      // 本地网关无需 key —— 传空串，与原站「local gateways」语义一致
      credential: 'ollama-local',
      model: {
        api: 'openai-completions',
        modelId,
        baseUrl: OLLAMA,
        thinkingLevel: 'off',
        maxTokens: 2048,
      },
      toolDefs: [],
      signal: controller.signal,
    },
    (f) => {
      frames.push(f);
      if (f.type === 'text_delta' && f.text) process.stdout.write(f.text.slice(0, 120));
    },
    async () => ({}),
  );

  clearTimeout(timer);

  console.log('\n--- 结束 ---');
  console.log(`status: ${result.status}`);
  if (result.error) console.log(`error: ${result.error}`);

  const kinds = new Set(frames.map((f) => f.type));
  console.log(`帧类型: ${[...kinds].join(', ') || '(无)'}`);
  console.log(`文本增量帧: ${frames.filter((f) => f.type === 'text_delta').length}`);
  console.log(`工具调用帧: ${frames.filter((f) => f.type === 'tool_call').length}`);

  // 核心断言：pi 真的驱动模型写出了文件
  const answerPath = path.join(cwd, 'answer.txt');
  const wrote = fs.existsSync(answerPath);
  console.log(`answer.txt 存在: ${wrote}`);
  const content = wrote ? fs.readFileSync(answerPath, 'utf8') : '';
  console.log(`answer.txt 内容: ${JSON.stringify(content)}`);

  fs.rmSync(cwd, { recursive: true, force: true });

  if (result.status !== 'succeeded') {
    console.log(`\nFAIL: pi turn 未成功 (${result.status})`);
    process.exit(1);
  }
  if (!wrote) {
    console.log('\nFAIL: 模型跑完了但没有写出文件 —— pi 的工具链没通');
    process.exit(1);
  }
  if (!content.includes('9')) {
    console.log('\nFAIL: 文件内容不是 3²=9，模型没有真正用工具完成计算');
    process.exit(1);
  }
  console.log('\nPASS: pi 通过本地 Ollama 真跑一轮 turn，读文件 → 写文件 → 结果正确');
  process.exit(0);
}

void assert;
void os;
void main();
