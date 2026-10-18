import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  purgeExpired,
  renderInjected,
  selectMemories,
  validateMemory,
  type MemoryRecord,
} from '../src/memory.js';

const NOW = 1_800_000_000_000;

function mem(over: Partial<MemoryRecord> & { id: string }): MemoryRecord {
  return {
    agentId: 'agent-1',
    scope: 'team',
    projectId: null,
    title: 'title',
    content: 'content',
    createdAt: NOW,
    expiresAt: null,
    ...over,
  };
}

describe('写入校验', () => {
  test('正常条目通过', () => {
    assert.equal(validateMemory({ title: 'preference', content: 'use pnpm', existingCount: 0 }).ok, true);
  });

  test('标题超 80 字符拒绝', () => {
    const r = validateMemory({ title: 'a'.repeat(81), content: 'x', existingCount: 0 });
    assert.equal(r.ok, false);
    assert.ok(r.reason?.includes('80'));
  });

  test('内容超 1200 字符拒绝', () => {
    const r = validateMemory({ title: 't', content: 'a'.repeat(1201), existingCount: 0 });
    assert.equal(r.ok, false);
    assert.ok(r.reason?.includes('1200'));
  });

  test('100 条已满时拒绝', () => {
    const r = validateMemory({ title: 't', content: 'c', existingCount: 100 });
    assert.equal(r.ok, false);
  });

  test('检测到 API key 形态拒绝', () => {
    for (const secret of [
      'my key is sk-abcdefghijklmnopqrstuvwxyz1234',
      'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
      'apikey tds_aaaaaaaaaaaaaaaaaaaaaaaaaa',
      'AWS AKIAIOSFODNN7EXAMPLE key',
      'password: hunter2secret',
      'api_key = abcdefghij12345',
    ]) {
      const r = validateMemory({ title: 'note', content: secret, existingCount: 0 });
      assert.equal(r.ok, false, `应拒绝: ${secret}`);
      assert.ok(r.reason?.includes('凭据'), r.reason);
    }
  });

  test('普通内容不误判为凭据', () => {
    const r = validateMemory({
      title: 'convention',
      content: 'Prefer named exports. The password reset flow lives in src/auth.',
      existingCount: 0,
    });
    assert.equal(r.ok, true);
  });
});

describe('scope 选择', () => {
  test('只注入本 agent 的（私有性）', () => {
    const all = [
      mem({ id: 'a', agentId: 'agent-1' }),
      mem({ id: 'b', agentId: 'agent-2' }),
    ];
    const sel = selectMemories(all, { agentId: 'agent-1', projectId: null, now: NOW });
    assert.equal(sel.length, 1);
    assert.equal(sel[0].id, 'a');
  });

  test('team-wide 在任何项目都注入', () => {
    const all = [mem({ id: 'team', scope: 'team', projectId: null })];
    const sel = selectMemories(all, { agentId: 'agent-1', projectId: 'proj-x', now: NOW });
    assert.equal(sel.length, 1);
  });

  test('project scope 只在对应项目注入', () => {
    const all = [mem({ id: 'p1', scope: 'project', projectId: 'proj-x' })];
    assert.equal(selectMemories(all, { agentId: 'agent-1', projectId: 'proj-x', now: NOW }).length, 1);
    assert.equal(selectMemories(all, { agentId: 'agent-1', projectId: 'proj-y', now: NOW }).length, 0);
  });

  test('同名时 project 优先于 team', () => {
    const all = [
      mem({ id: 'team-rule', title: 'style', content: 'team version', scope: 'team' }),
      mem({ id: 'proj-rule', title: 'style', content: 'project version', scope: 'project', projectId: 'p' }),
    ];
    const sel = selectMemories(all, { agentId: 'agent-1', projectId: 'p', now: NOW });
    assert.equal(sel.length, 1, '同名应去重');
    assert.equal(sel[0]?.id, 'proj-rule');
  });

  test('过期条目不注入', () => {
    const all = [
      mem({ id: 'alive' }),
      mem({ id: 'expired', expiresAt: NOW - 1000 }),
    ];
    const sel = selectMemories(all, { agentId: 'agent-1', projectId: null, now: NOW });
    assert.equal(sel.length, 1);
    assert.equal(sel[0]?.id, 'alive');
  });

  test('新近的排前面（同名去重不会误伤不同标题）', () => {
    const all = [
      mem({ id: 'old', title: 'old-rule', createdAt: NOW - 10_000 }),
      mem({ id: 'new', title: 'new-rule', createdAt: NOW }),
    ];
    const sel = selectMemories(all, { agentId: 'agent-1', projectId: null, now: NOW });
    assert.equal(sel.length, 2, '不同标题不应被去重');
    assert.equal(sel[0]?.id, 'new');
  });

  test('同名去重后只保留一条（team 被 project 覆盖）', () => {
    const all = [
      mem({ id: 'team-one', title: 'shared', scope: 'team', createdAt: NOW }),
      mem({ id: 'proj-one', title: 'shared', scope: 'project', projectId: 'p', createdAt: NOW - 5000 }),
    ];
    const sel = selectMemories(all, { agentId: 'agent-1', projectId: 'p', now: NOW });
    assert.equal(sel.length, 1);
    assert.equal(sel[0]?.id, 'proj-one', '同标题时项目版覆盖 team 版');
  });
});

describe('注入预算裁剪', () => {
  test('小集合全部注入', () => {
    const all = Array.from({ length: 5 }, (_, i) =>
      mem({ id: `m${i}`, title: `t${i}`, content: 'c'.repeat(100) }),
    );
    const out = renderInjected(selectMemories(all, { agentId: 'agent-1', projectId: null, now: NOW }));
    assert.equal(out.injectedCount, 5);
    assert.equal(out.downgradedCount, 0);
    assert.ok(out.text.includes('## Memory'));
  });

  test('超预算的降级为 title-only 且列出标题', () => {
    const all = Array.from({ length: 200 }, (_, i) =>
      mem({ id: `m${i}`, title: `rule-${i}`, content: 'x'.repeat(500) }),
    );
    const out = renderInjected(selectMemories(all, { agentId: 'agent-1', projectId: null, now: NOW }));

    assert.ok(out.injectedCount < 200);
    assert.ok(out.downgradedCount > 0);
    assert.ok(out.text.includes('memories 工具'), '应提示 agent 用工具取全文');
  });

  test('空集合不产生噪音', () => {
    const out = renderInjected([]);
    assert.equal(out.text, '');
    assert.equal(out.injectedCount, 0);
  });

  test('注入内容不得包含凭据（写入时已拦，这里再确认渲染）', () => {
    const all = [mem({ id: 'x', title: 'normal', content: 'safe content' })];
    const out = renderInjected(selectMemories(all, { agentId: 'agent-1', projectId: null, now: NOW }));
    assert.ok(!out.text.includes('sk-'));
  });
});

describe('过期清理', () => {
  test('到期条目被清理，其余保留', () => {
    const all = [
      mem({ id: 'keep' }),
      mem({ id: 'gone', expiresAt: NOW - 1 }),
    ];
    const { kept, purged } = purgeExpired(all, NOW);
    assert.equal(kept.length, 1);
    assert.equal(purged.length, 1);
    assert.equal(purged[0]?.id, 'gone');
  });

  test('expiresAt 为 null 表示永不过期', () => {
    const { kept, purged } = purgeExpired([mem({ id: 'forever' })], NOW);
    assert.equal(kept.length, 1);
    assert.equal(purged.length, 0);
  });
});
