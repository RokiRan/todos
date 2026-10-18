import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  buildChiefPrompt,
  compactHistory,
  hasGrant,
  parseStandingGrants,
  CHIEF_LIMITS,
  type BoardDigest,
  type ChiefFixedSegment,
  type TopicTurn,
} from '../src/chief/prompt.js';

const FIXED: ChiefFixedSegment = {
  roleInstructions: '你是 Chief。你不能自己写代码，只能派工。',
  toolSummary: 'create_todo, run_builds, ask_user, confirm_builds, merge_builds',
  charter: '## 我的团队\n做 OPC 工业自动化软件。',
  memory: '### 偏好\n先出调研报告再写 PRD。',
};

const BOARD: BoardDigest = {
  byPhase: { todo: 2, implement: 1, review: 3, done: 12 },
  needsYou: [{ id: 't1', seqNum: 4, title: '市场调研报告', phase: 'review' }],
  changes: [{ id: 't2', what: 'moved to review' }],
};

const CONTEXT = 200_000;

function turns(n: number): TopicTurn[] {
  return Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `消息 ${i}：${'内容'.repeat(20)}`,
    at: 1_800_000_000_000 + i * 1000,
  }));
}

describe('prompt 三段构造', () => {
  test('固定段在最前，且包含 charter 与 memory', () => {
    const p = buildChiefPrompt({
      fixed: FIXED, topicId: 'c1', history: [], board: BOARD,
      userMessage: '继续', contextWindow: CONTEXT,
    });
    const fixedEnd = p.text.indexOf('---');
    assert.ok(fixedEnd > 0, '固定段应在分隔符之前');
    assert.ok(p.text.includes(FIXED.charter), '必须含 charter');
    assert.ok(p.text.includes(FIXED.memory), '必须含 memory');
    assert.ok(p.text.includes(FIXED.roleInstructions), '必须含角色指令');
  });

  test('固定段字节级稳定（prefix cache 的前提）', () => {
    const base = {
    fixed: FIXED, topicId: 'c1', board: BOARD, contextWindow: CONTEXT,
  };
    const a = buildChiefPrompt({ ...base, history: [], userMessage: '第一句' });
    const b = buildChiefPrompt({ ...base, history: turns(5), userMessage: '第二句' });
    // 固定段长度不受 history / userMessage 影响
    assert.equal(a.segments.fixed, b.segments.fixed);
  });

  test('看板 digest 只列非零相位', () => {
    const p = buildChiefPrompt({
      fixed: FIXED, topicId: 'c1', history: [], board: BOARD,
      userMessage: 'x', contextWindow: CONTEXT,
    });
    assert.ok(p.text.includes('review: 3'));
    assert.ok(!p.text.includes('failed: 0'), '零计数不该出现');
  });

  test('等你处理的 todo 单列出来', () => {
    const p = buildChiefPrompt({
      fixed: FIXED, topicId: 'c1', history: [], board: BOARD,
      userMessage: 'x', contextWindow: CONTEXT,
    });
    assert.ok(p.text.includes('等你处理'));
    assert.ok(p.text.includes('#4 [review] 市场调研报告'));
  });

  test('三段长度都被记录', () => {
    const p = buildChiefPrompt({
      fixed: FIXED, topicId: 'c1', history: turns(4), board: BOARD,
      userMessage: '继续推进', contextWindow: CONTEXT,
    });
    assert.ok(p.segments.fixed > 0);
    assert.ok(p.segments.history > 0);
    assert.ok(p.segments.current > 0);
  });
});

describe('上下文阈值', () => {
  test('低占用时三档全关', () => {
    const p = buildChiefPrompt({
      fixed: FIXED, topicId: 'c1', history: [], board: BOARD,
      userMessage: 'hi', contextWindow: 10_000_000,
    });
    assert.equal(p.shouldCompact, false);
    assert.equal(p.canCompactManually, false);
    assert.equal(p.showRingMeter, false);
  });

  test('≥50% 允许手动压缩', () => {
    // 造一个占用率落在 50–80% 的 prompt
    const long = 'x'.repeat(200_000);
    const p = buildChiefPrompt({
      fixed: FIXED, topicId: 'c1', history: [{ role: 'user', content: long, at: 0 }],
      board: BOARD, userMessage: 'y', contextWindow: 120_000,
    });
    assert.ok(p.occupancy >= CHIEF_LIMITS.CONTEXT_MANUAL_COMPACT, `占用率 ${p.occupancy}`);
    assert.equal(p.canCompactManually, true);
    assert.equal(p.shouldCompact, false, '未到 80% 不该自动压缩');
  });

  test('≥80% 触发自动压缩', () => {
    const long = 'x'.repeat(400_000);
    const p = buildChiefPrompt({
      fixed: FIXED, topicId: 'c1', history: [{ role: 'user', content: long, at: 0 }],
      board: BOARD, userMessage: 'y', contextWindow: 150_000,
    });
    assert.ok(p.occupancy >= CHIEF_LIMITS.CONTEXT_AUTO_COMPACT);
    assert.equal(p.shouldCompact, true);
  });

  test('≥85% 显示顶部环形表', () => {
    const long = 'x'.repeat(600_000);
    const p = buildChiefPrompt({
      fixed: FIXED, topicId: 'c1', history: [{ role: 'user', content: long, at: 0 }],
      board: BOARD, userMessage: 'y', contextWindow: 200_000,
    });
    assert.ok(p.occupancy >= CHIEF_LIMITS.CONTEXT_RING_METER);
    assert.equal(p.showRingMeter, true);
  });

  test('阈值就是文档实测的 50/80/85', () => {
    assert.equal(CHIEF_LIMITS.CONTEXT_MANUAL_COMPACT, 0.5);
    assert.equal(CHIEF_LIMITS.CONTEXT_AUTO_COMPACT, 0.8);
    assert.equal(CHIEF_LIMITS.CONTEXT_RING_METER, 0.85);
  });
});

describe('历史压缩', () => {
  test('不超过保留数时原样返回', () => {
    const h = turns(5);
    const r = compactHistory(h, 10);
    assert.equal(r.compactedCount, 0);
    assert.equal(r.kept.length, 5);
    assert.equal(r.summary, '');
  });

  test('超出时保留最近 N 条原文', () => {
    const h = turns(20);
    const r = compactHistory(h, 6);
    assert.equal(r.kept.length, 6);
    assert.equal(r.compactedCount, 14);
    assert.equal(r.kept[5]?.content, h[19]?.content, '保留的应是最后 6 条');
  });

  test('摘要含角色计数与要点', () => {
    const r = compactHistory(turns(20), 6);
    assert.ok(r.summary.includes('user'));
    assert.ok(r.summary.includes('assistant'));
    assert.ok(r.summary.includes('消息 0'), '每条留一行痕迹');
  });

  test('压缩确实减小体积，且不丢条数', () => {
    const h = turns(40).map((t) => ({ ...t, content: t.content.repeat(5) }));
    const r = compactHistory(h, 5);
    const before = h.reduce((s, t) => s + t.content.length, 0);
    const after = r.summary.length + r.kept.reduce((s, t) => s + t.content.length, 0);

    assert.ok(after < before, `应变小：${after} vs ${before}`);
    // 摘要每条留一行痕迹，所以压缩比不会到 90% —— 这是有意的可追溯性权衡
    assert.ok(after > before * 0.3, `压缩比过激会丢失可追溯性：${after} vs ${before}`);
    // 关键：一条都不能丢
    assert.equal(r.kept.length + r.compactedCount, h.length);
  });

  test('长历史压缩比显著（保留少数几轮时）', () => {
    const h = turns(200).map((t) => ({ ...t, content: t.content.repeat(10) }));
    const r = compactHistory(h, 4);
    const before = h.reduce((s, t) => s + t.content.length, 0);
    const after = r.summary.length + r.kept.reduce((s, t) => s + t.content.length, 0);
    assert.ok(after < before * 0.2, `200 轮应压到 20% 内：${after} vs ${before}`);
  });
});

describe('standing 授权识别（文档原句）', () => {
  const at = 1_800_000_000_000;
  const scope = { type: 'team' as const };

  test('识别 confirm the plan once it lands', () => {
    const g = parseStandingGrants('confirm the plan once it lands', scope, at);
    assert.equal(g.length, 1);
    assert.equal(g[0]?.action, 'approve_plan');
  });

  test('识别 merge when review passes', () => {
    const g = parseStandingGrants('merge when review passes', scope, at);
    assert.equal(g[0]?.action, 'merge_changes');
  });

  test('识别 don\'t ask me, just proceed', () => {
    const g = parseStandingGrants("don't ask me, just proceed", scope, at);
    assert.equal(g[0]?.action, 'all_gates');
  });

  test('识别中文授权', () => {
    assert.equal(parseStandingGrants('别问我了', scope, at)[0]?.action, 'all_gates');
    assert.equal(parseStandingGrants('就这么办', scope, at)[0]?.action, 'all_gates');
  });

  test('截断句也识别（don\'t ask me 不必带 just proceed）', () => {
    assert.equal(parseStandingGrants("don't ask me", scope, at)[0]?.action, 'all_gates');
    assert.equal(parseStandingGrants('别问我', scope, at)[0]?.action, 'all_gates');
  });

  test('含有「问」但不是授权的句子不误判', () => {
    for (const s of [
      '我觉得这里不需要问用户',
      'ask me anything',
      '要不要我问一下？',
      '随便问吧',
    ]) {
      assert.equal(parseStandingGrants(s, scope, at).length, 0, `误判: ${s}`);
    }
  });

  test('普通句子不误判为授权', () => {
    for (const s of [
      '帮我看看这个 bug',
      '合并冲突怎么解决',
      'plan 这个词在这里是什么意思',
      'review 一下最近的改动',
    ]) {
      assert.equal(parseStandingGrants(s, scope, at).length, 0, `误判: ${s}`);
    }
  });

  test('同一句只记一条', () => {
    const g = parseStandingGrants('merge when review passes. merge when review passes.', scope, at);
    assert.equal(g.length, 1);
  });
});

describe('授权作用域优先级', () => {
  const at = 1_800_000_000_000;

  test('无授权时 denied', () => {
    assert.equal(hasGrant([], 'merge_changes', { todoId: 't1' }).granted, false);
  });

  test('team 级授权生效', () => {
    const grants = parseStandingGrants('merge when review passes', { type: 'team' }, at);
    assert.equal(hasGrant(grants, 'merge_changes', { todoId: 't1' }).granted, true);
  });

  test('todo 级授权比 team 级更具体', () => {
    const grants = [
      ...parseStandingGrants('merge when review passes', { type: 'team' }, at),
      ...parseStandingGrants('merge when review passes', { type: 'todo', id: 't1' }, at),
    ];
    const hit = hasGrant(grants, 'merge_changes', { todoId: 't1' });
    assert.equal(hit.granted, true);
    assert.equal(hit.grant?.scope.type, 'todo', '应命中更具体的 todo 作用域');
  });

  test('todo 级授权不外溢到别的 todo', () => {
    const grants = parseStandingGrants('merge when review passes', { type: 'todo', id: 't1' }, at);
    assert.equal(hasGrant(grants, 'merge_changes', { todoId: 't2' }).granted, false);
  });

  test('agent 级授权按 agent 命中', () => {
    const grants = parseStandingGrants('merge when review passes', { type: 'agent', id: 'a1' }, at);
    assert.equal(hasGrant(grants, 'merge_changes', { agentId: 'a1' }).granted, true);
    assert.equal(hasGrant(grants, 'merge_changes', { agentId: 'a2' }).granted, false);
  });

  test('all_gates 覆盖两种动作', () => {
    const grants = parseStandingGrants("don't ask me, just proceed", { type: 'team' }, at);
    assert.equal(hasGrant(grants, 'approve_plan', {}).granted, true);
    assert.equal(hasGrant(grants, 'merge_changes', {}).granted, true);
  });

  test('approve_plan 授权不放行 merge_changes', () => {
    const grants = parseStandingGrants('confirm the plan once it lands', { type: 'team' }, at);
    assert.equal(hasGrant(grants, 'approve_plan', {}).granted, true);
    assert.equal(hasGrant(grants, 'merge_changes', {}).granted, false, '授权必须按动作区分');
  });
});

describe('实测上限', () => {
  test('topic 上限 50、check-in 7 天', () => {
    assert.equal(CHIEF_LIMITS.MAX_TOPICS, 50);
    assert.equal(CHIEF_LIMITS.MAX_CHECKIN_DAYS, 7);
  });

  test('固定段典型 20k–30k tokens', () => {
    assert.equal(CHIEF_LIMITS.FIXED_SEGMENT_TYPICAL_TOKENS.min, 20_000);
    assert.equal(CHIEF_LIMITS.FIXED_SEGMENT_TYPICAL_TOKENS.max, 30_000);
  });
});
