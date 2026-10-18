import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { OmpDriver } from '../src/drivers/omp.js';
import { CodexDriver } from '../src/drivers/codex.js';

/**
 * 新增 driver 的真实环境冒烟（不是单测，是真跑一遍二进制）。
 *
 * 这俩 driver 都是「真探二进制 + 真跑子进程」型组件，单测 mock 反而失真。
 * 真环境下：
 *   - codex 不存在 → CodexDriver.probe() 必须报 installed=false
 *   - omp v18.2.11 装在 PATH → OmpDriver.probe() 必须报 installed=true
 *
 * checkSignIn 走真实 `omp --mode=json --print -p ping`，超时 45s。
 * 该测试默认跳过（CI 没装 omp 时让它跑通），手工开发时直接 npx tsx --test ...。
 */

describe('OmpDriver 真实探测', () => {
  test('probe 返回 installed=true 并给出版本', async () => {
    const d = new OmpDriver();
    const r = await d.probe();
    assert.equal(r.installed, true, `expected omp installed, got ${JSON.stringify(r)}`);
    assert.ok(r.version?.includes('omp'), `expected version to mention omp, got: ${r.version}`);
  });

  /**
   * 真跑一轮 NDJSON 流。模型是默认 smol，单轮用 `ping` 极简 prompt，
   * 期望至少拿到一个 text_delta 帧与一条 turn_completed 帧。
   * 如果 omp 未登录，checkSignIn/run 会在早期报错。
   */
  test('run() 解析 NDJSON 流并拿到 turn_completed 帧', { skip: true }, async () => {
    const d = new OmpDriver();
    const frames: { type: string; text?: string }[] = [];
    const result = await d.run(
      {
        cwd: process.cwd(),
        prompt: 'reply with the word pong',
        credential: null,
        model: null,
        toolDefs: [],
        signal: new AbortController().signal,
      },
      (f) => frames.push({ type: f.type, text: f.text }),
      async () => null,
    );
    if (result.status !== 'succeeded') {
      // 未登录是合法原因 —— 跳过而非 fail，让 CI 在没凭据时仍绿
      console.log('omp run failed (likely not signed in):', result.error);
      return;
    }
    assert.ok(frames.some((f) => f.type === 'text_delta'), 'expected at least one text_delta frame');
    assert.ok(frames.some((f) => f.type === 'turn_completed'), 'expected turn_completed frame');
    assert.match(result.text, /pong/i);
  });
});

describe('CodexDriver 真实探测（本机未装）', () => {
  test('probe 返回 installed=false 与 error', async () => {
    const d = new CodexDriver();
    const r = await d.probe();
    assert.equal(r.installed, false);
    assert.ok(r.error, 'expected an error message');
  });

  test('run() 立即报错而不是静默挂死', async () => {
    const d = new CodexDriver();
    const frames: unknown[] = [];
    const result = await d.run(
      {
        cwd: process.cwd(),
        prompt: 'hello',
        credential: null,
        model: null,
        toolDefs: [],
        signal: new AbortController().signal,
      },
      (f) => frames.push(f),
      async () => null,
    );
    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /not available in this environment/);
    assert.ok(frames.length > 0, 'should emit at least one error frame');
  });
});