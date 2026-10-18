import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, describe, before, after } from 'node:test';
import { runtimeSpec, RUNTIMES } from '@tds/protocol';
import { PiDriver, buildPiModel, piAgentDir, purgePiCredentials } from '../src/drivers/pi.js';
import { driverFor, availableRuntimeIds } from '../src/drivers/index.js';
import { resolveBinary } from '../src/drivers/shared.js';

/** ModelRuntime 的最小探测形状。 */
interface PiRuntimeProbe {
  getAuth: (model: unknown, overrides?: object) => Promise<unknown>;
  registerProvider: (providerId: string, config: Record<string, unknown>) => void;
}

/**
 * pi 内置 runtime 验证。
 *
 * pi 与外部 runtime 的语义完全不同，所以要验的也不同：
 *   1. 注册表里 pi 存在且排第一（它是原站默认 runtime）
 *   2. probe 如实反映「内置、不需要安装」
 *   3. **凭据不落盘** —— 这是原站 rmSync(auth.json) 的核心安全性质
 *   4. 没有模型时必须明确报错，而不是静默跑一个空会话
 *   5. driver 注册表能拿到 pi
 */

describe('pi 内置 runtime', () => {
  let agentDir: string;

  before(() => {
    const home = path.join(os.tmpdir(), `tds-pi-test-${Date.now()}`);
    agentDir = piAgentDir(home);
  });

  after(() => {
    const home = path.dirname(agentDir);
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('注册表里有 pi，且它是第一个（对齐原站 AGENT_RUNTIMES 顺序）', () => {
    assert.equal(RUNTIMES[0]?.id, 'pi', 'pi 应排在 RUNTIMES 首位');
    const spec = runtimeSpec('pi');
    assert.ok(spec, 'runtimeSpec("pi") 必须有值');
    assert.equal(spec?.driver, 'pi');
  });

  test('pi 没有二进制 —— 内置 runtime 不 spawn', () => {
    const spec = runtimeSpec('pi');
    assert.equal(spec?.binEnv, null);
    assert.equal(spec?.defaultBin, null);
    assert.equal(spec?.installHint, null);
    // resolveBinary 返回 null 表示「不需要二进制」，不是「找不到」
    assert.equal(resolveBinary('pi'), null);
  });

  test('driver 注册表能拿到 pi', () => {
    assert.ok(availableRuntimeIds().includes('pi'));
    assert.equal(driverFor('pi')?.id, 'pi');
  });

  test('probe 报告已安装（随包内置），版本来自 SDK', async () => {
    const driver = new PiDriver();
    const p = await driver.probe();
    assert.equal(p.installed, true, `pi 应视为内置可用，实际: ${p.error ?? ''}`);
    assert.ok(p.version, '应能读到 SDK 版本');
    assert.equal(p.path, '(bundled)');
  });

  test('checkSignIn 说明凭据由平台下发，而非本机登录态', async () => {
    const r = await new PiDriver().checkSignIn();
    assert.equal(r.signedIn, false);
    assert.match(r.error ?? '', /provider/);
  });

  test('凭据绝不落盘 —— 加载前清掉 auth.json / models.json', () => {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'auth.json'), '{"leak":"secret"}');
    fs.writeFileSync(path.join(agentDir, 'models.json'), '{"leak":true}');

    purgePiCredentials(agentDir);

    assert.equal(fs.existsSync(path.join(agentDir, 'auth.json')), false, 'auth.json 必须被删除');
    assert.equal(fs.existsSync(path.join(agentDir, 'models.json')), false, 'models.json 必须被删除');
    // 目录本身保留（agentDir 要作为 agentDir 传给 SDK）
    assert.equal(fs.existsSync(agentDir), true);
  });

  test('purgePiCredentials 幂等且容忍缺失文件', () => {
    const fresh = path.join(agentDir, 'never-existed');
    assert.doesNotThrow(() => purgePiCredentials(fresh));
    assert.doesNotThrow(() => purgePiCredentials(fresh));
    assert.equal(fs.existsSync(fresh), true, '应创建目录');
  });

  test('buildPiModel 把平台下发的 model + 凭据组装成 pi-ai 的 Model', () => {
    const m = buildPiModel(
      { api: 'anthropic-messages', modelId: 'claude-sonnet-4', maxTokens: 4096 },
      'sk-team-key',
    );
    assert.equal(m.id, 'claude-sonnet-4');
    assert.equal(m.api, 'anthropic-messages');
    assert.equal(m.maxTokens, 4096);
    assert.equal(m.apiKey, 'sk-team-key');
    assert.ok(m.contextWindow > 0, '必须有 contextWindow');
  });

  test('thinkingLevel 关闭时 reasoning 为 false', () => {
    const off = buildPiModel({ api: 'openai-completions', modelId: 'm', thinkingLevel: 'off' }, 'k');
    const on = buildPiModel({ api: 'openai-completions', modelId: 'm', thinkingLevel: 'high' }, 'k');
    assert.equal(off.reasoning, false);
    assert.equal(on.reasoning, true);
  });

  test('没有模型时明确报错 —— 不静默跑空会话', async () => {
    const frames: unknown[] = [];
    const r = await new PiDriver().run(
      {
        cwd: agentDir,
        prompt: 'hi',
        credential: null,
        model: null,
        toolDefs: [],
        signal: new AbortController().signal,
      },
      (f) => { frames.push(f); },
      async () => ({}),
    );
    assert.equal(r.status, 'failed');
    assert.match(r.error ?? '', /provider/);
  });

  // ── 两个踩过的坑，锁死 ──────────────────────────────────────

  test('provider 未注册会报 No API key —— registerProvider 是必需的', async () => {
    // 实测：ModelRuntime.getAuth() 先 `providers.get(providerId)`，
    // 拿不到直接返回 undefined → AgentSession 报
    // "No API key found for tds"。只往 modelsStore 塞模型**没用**，
    // providerIds() 不包含 modelsStore 里的内容。唯一正解是 registerProvider。
    const sdk = (await import('@earendil-works/pi-coding-agent')) as unknown as {
      ModelRuntime: { create: (o?: unknown) => Promise<PiRuntimeProbe> };
    };

    const model = {
      id: 'm', name: 'm', api: 'openai-completions', provider: 'tds',
      baseUrl: 'http://127.0.0.1:1/v1', input: ['text'], reasoning: false,
      contextWindow: 1000, maxTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const store = {
      read: async (id: string) => (id === 'tds' ? { models: [model] } : undefined),
      write: async () => {}, remove: async () => {},
    };
    const creds = {
      read: async () => ({ type: 'api_key', key: 'k' }),
      list: async () => [{ providerId: 'tds', type: 'api_key' }],
      write: async () => { throw new Error('read-only'); },
    };

    const withoutRegister = await sdk.ModelRuntime.create({
      modelsStore: store, credentials: creds, modelsPath: null, refreshOnCreate: false,
    });
    assert.equal(await withoutRegister.getAuth(model), undefined,
      '未 registerProvider 时 getAuth 必须返回 undefined（这正是该 bug 的根因）');

    withoutRegister.registerProvider('tds', {
      name: 'tds', baseUrl: 'http://127.0.0.1:1/v1',
      api: 'openai-completions' as never, apiKey: 'k', models: [model as never],
    });
    const auth = await withoutRegister.getAuth(model);
    assert.ok(auth, 'registerProvider 之后 getAuth 必须能解析出鉴权');
  });

  test('外部 runtime 保持原有二进制语义（未被 pi 改动波及）', () => {
    assert.deepEqual(resolveBinary('omp'), { cmd: process.env.TDS_OMP_BIN?.trim() || 'omp' });
    assert.deepEqual(resolveBinary('claude-code'), {
      cmd: process.env.TDS_CLAUDE_CODE_BIN?.trim() || 'claude',
    });
    assert.equal(resolveBinary('nonexistent-runtime'), null);
  });
});
