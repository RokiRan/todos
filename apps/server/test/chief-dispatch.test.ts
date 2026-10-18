import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  canAutoDispatch,
  decideDispatch,
  pickAgent,
  pickThinkingLevel,
  sharpen,
  onDispatched,
  liftGrant,
  parseStandingGrantsLite,
  type StandingGrantScope,
} from '../src/chief/dispatch.js';
import {
  shouldWatch,
  wakeEvents,
  wakeTriggersFor,
  nextCheckIn,
  canCreateTopic,
  WATCH_LIMITS,
} from '../src/chief/watch.js';
import type { DispatchRequest } from '../src/chief/types.js';

/**
 * Chief 派工 + watch 决策层回归测试。
 *
 * 覆盖：
 *   - standing 授权三层优先级（todo > agent > team）
 *   - 用户原话请求 → 自动派
 *   - 用户消息含 standing 授权 → 自动派
 *   - Chief 自行拍板 → needsApproval + question card
 *   - 资源缺口 → refuse
 *   - spec 缺关键信息 → needsClarification
 *   - shouldWatch: Chief 触发 vs user_typed
 *   - wakeEvents: gate / agent_question / review_failed / settled 全覆盖；同 topic 去重合并
 *   - nextCheckIn: 7 天上限 + now 钳位
 *   - canCreateTopic: 50 topic 上限
 *   - onDispatched hook（routes/chief.ts 集成契约）
 */

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function baseReq(overrides: Partial<DispatchRequest> = {}): DispatchRequest {
  return {
    requestedByUser: false,
    todo: {
      id: 'todo1',
      title: '修复登录页 500 错误',
      phase: 'todo',
      spec: '## Goal\n让登录页不再 500\n\n## Boundary\n只改前端\n\n## Done\nCI 通过',
    },
    standingGrants: [],
    resources: { idleAgentIds: ['a1', 'a2'], onlineMachineCount: 1 },
    chiefId: 'chief-u1-t1',
    now: NOW,
    ...overrides,
  };
}

describe('sharpen 把 spec 解析成 goal / boundary / done', () => {
  test('完整 spec 三段都解析成功', () => {
    const r = sharpen(
      '## Goal\n修登录\n\n## Boundary\n改前端\n\n## Done\n测试通过',
      '默认标题',
    );
    assert.equal(r.goal, '修登录');
    assert.equal(r.boundary, '改前端');
    assert.equal(r.done, '测试通过');
    assert.deepEqual(r.missing, []);
  });

  test('缺 boundary 时 missing 标记 boundary', () => {
    const r = sharpen('## Goal\n修登录\n\n## Done\n测试通过', '默认');
    assert.deepEqual(r.missing, ['boundary']);
  });

  test('三段全缺时 missing 三个', () => {
    const r = sharpen('', '默认');
    assert.equal(r.goal, '默认');
    assert.deepEqual(r.missing, ['boundary', 'done']);
  });

  test('支持中文标题（目标/边界/完成）', () => {
    const r = sharpen('## 目标\n修登录\n\n## 边界\n改前端\n\n## 完成\nCI 通过', 't');
    assert.equal(r.goal, '修登录');
    assert.equal(r.boundary, '改前端');
    assert.equal(r.done, 'CI 通过');
  });
});

describe('pickAgent 选 agent', () => {
  test('空列表返回 null', () => {
    assert.equal(pickAgent([]), null);
  });

  test('无偏好时取第一个空闲 agent', () => {
    assert.equal(pickAgent(['a2', 'a3']), 'a2');
  });

  test('有偏好且空闲列表里有 → 返回偏好', () => {
    assert.equal(pickAgent(['a1', 'a2'], 'a2'), 'a2');
  });

  test('偏好不在列表里 → 回退到第一个', () => {
    assert.equal(pickAgent(['a1', 'a2'], 'a9'), 'a1');
  });
});

describe('pickThinkingLevel 决定 thinking 等级', () => {
  test('含 design/research 关键词 → high', () => {
    assert.equal(pickThinkingLevel('design the new arch', 't'), 'high');
  });

  test('含 fix/rename 关键词 → low', () => {
    assert.equal(pickThinkingLevel('fix the typo', 't'), 'low');
  });

  test('普通 spec → medium', () => {
    assert.equal(pickThinkingLevel(undefined, '普通事'), 'medium');
  });
});

describe('standing 授权三层优先级', () => {
  test('per-todo 授权命中 → granted', () => {
    const grants = parseStandingGrantsLite('confirm the plan once', NOW, {
      type: 'todo',
      id: 'todo1',
    });
    const r = canAutoDispatch(grants, 'approve_plan', { todoId: 'todo1', agentId: 'a1' });
    assert.equal(r.granted, true);
  });

  test('per-agent 授权命中（per-todo 不存在）→ granted', () => {
    const grants = parseStandingGrantsLite('merge when review passes', NOW, {
      type: 'agent',
      id: 'a1',
    });
    const r = canAutoDispatch(grants, 'merge_changes', { todoId: 'todo9', agentId: 'a1' });
    assert.equal(r.granted, true);
  });

  test('per-team 万能授权（all_gates）命中任意 target', () => {
    const grants = parseStandingGrantsLite('别问我了，就这么办', NOW, {
      type: 'team',
    });
    const r = canAutoDispatch(grants, 'merge_changes', { todoId: 'todo1', agentId: 'a1' });
    assert.equal(r.granted, true);
  });

  test('per-todo 与 per-team 冲突时，per-todo 胜出（更具体）', () => {
    const todoGrant = parseStandingGrantsLite('confirm the plan once', NOW, {
      type: 'todo',
      id: 'todo1',
    });
    const teamGrant = parseStandingGrantsLite('别问我了，就这么办', NOW, {
      type: 'team',
    });
    const merged = [...teamGrant, ...todoGrant];
    const r = canAutoDispatch(merged, 'approve_plan', { todoId: 'todo1', agentId: 'a1' });
    assert.equal(r.granted, true);
    assert.equal(r.grant?.scope.type, 'todo', '具体作用域优先');
  });

  test('授权语句不匹配 → not granted', () => {
    const grants = parseStandingGrantsLite('随便聊聊', NOW, {
      type: 'team',
    });
    const r = canAutoDispatch(grants, 'approve_plan', { todoId: 'todo1', agentId: 'a1' });
    assert.equal(r.granted, false);
  });
});

describe('decideDispatch 决策树', () => {
  test('无在线机器 → refuse', () => {
    const r = decideDispatch(baseReq({ resources: { idleAgentIds: ['a1'], onlineMachineCount: 0 } }));
    assert.equal(r.kind, 'refuse');
  });

  test('无空闲 agent → refuse', () => {
    const r = decideDispatch(baseReq({ resources: { idleAgentIds: [], onlineMachineCount: 1 } }));
    assert.equal(r.kind, 'refuse');
  });

  test('用户原话请求 → dispatch（无视 standing 授权缺失）', () => {
    const r = decideDispatch(baseReq({ requestedByUser: true }));
    assert.equal(r.kind, 'dispatch');
    assert.equal(r.agentId, 'a1');
    assert.equal(r.reason, '用户原话请求');
  });

  test('用户消息含 standing 授权 → dispatch', () => {
    const r = decideDispatch(
      baseReq({ userMessage: 'merge when review passes, 别问我了' }),
    );
    assert.equal(r.kind, 'dispatch');
    assert.equal(r.reason, 'standing 授权覆盖');
  });

  test('Chief 自行拍板（无授权无原话）→ needsApproval + question card', () => {
    const r = decideDispatch(baseReq());
    assert.equal(r.kind, 'needsApproval');
    assert.equal(r.card.kind, 'question');
    assert.equal(r.card.todoId, 'todo1');
    assert.ok(r.card.reason.includes('Chief 自行拍板'));
  });

  test('spec 缺关键信息 → needsClarification + missing 列表', () => {
    const r = decideDispatch(
      baseReq({
        todo: {
          id: 'todo2',
          title: 't',
          phase: 'todo',
          spec: '## Goal\ng',
        },
      }),
    );
    assert.equal(r.kind, 'needsClarification');
    assert.ok(r.missing.includes('boundary'));
    assert.ok(r.missing.includes('done'));
  });

  test('用户原话 + 缺信息 → 仍走 needsClarification（信息优先）', () => {
    const r = decideDispatch(
      baseReq({
        requestedByUser: true,
        todo: { id: 't', title: 't', phase: 'todo', spec: '## Goal\ng' },
      }),
    );
    assert.equal(r.kind, 'needsClarification');
  });
});

describe('shouldWatch 触发源判定', () => {
  test('Chief 派工 → watch', () => {
    assert.equal(shouldWatch('chief_dispatch'), true);
  });

  test('Chief 合并 → watch', () => {
    assert.equal(shouldWatch('chief_merge'), true);
  });

  test('Chief 确认 → watch', () => {
    assert.equal(shouldWatch('chief_confirm'), true);
  });

  test('Chief review → watch', () => {
    assert.equal(shouldWatch('chief_review'), true);
  });

  test('Chief message → watch', () => {
    assert.equal(shouldWatch('chief_message'), true);
  });

  test('user_typed → 不 watch（走普通通知）', () => {
    assert.equal(shouldWatch('user_typed'), false);
  });
});

describe('wakeEvents + wakeTriggersFor', () => {
  test('planning gate → gate wake', () => {
    const t = wakeTriggersFor({ phase: 'planning' });
    assert.equal(t.length, 1);
    assert.equal(t[0]!.kind, 'gate');
    assert.equal(t[0]!.phase, 'planning');
  });

  test('review gate + review_failed → 两条 trigger', () => {
    const t = wakeTriggersFor({ phase: 'review', reviewFailed: true });
    assert.equal(t.length, 2);
    assert.ok(t.some((x) => x.kind === 'gate'));
    assert.ok(t.some((x) => x.kind === 'review_failed'));
  });

  test('agent 提了 question → agent_question wake', () => {
    const t = wakeTriggersFor({ phase: 'implement', agentAsked: true });
    assert.equal(t.length, 1);
    assert.equal(t[0]!.kind, 'agent_question');
  });

  test('settled 三态都触发 wake', () => {
    for (const p of ['done', 'failed', 'closed'] as const) {
      const t = wakeTriggersFor({ phase: p });
      assert.equal(t.length, 1);
      assert.equal(t[0]!.kind, 'settled');
      assert.equal(t[0]!.phase, p);
    }
  });

  test('implement 中段无 trigger → 空数组', () => {
    assert.deepEqual(wakeTriggersFor({ phase: 'implement' }), []);
  });

  test('wakeEvents 同 topic 多次合并为一条', () => {
    const events = wakeEvents(
      [
        { topicId: 't1', phase: 'planning' },
        { topicId: 't1', phase: 'implement', agentAsked: true },
        { topicId: 't2', phase: 'implement', agentAsked: true },
      ],
      NOW,
    );
    assert.equal(events.length, 2);
    const t1 = events.find((e) => e.topicId === 't1')!;
    assert.equal(t1.triggers.length, 2, 't1 两次 wake 合并');
    const t2 = events.find((e) => e.topicId === 't2')!;
    assert.equal(t2.triggers.length, 1);
  });

  test('wakeEvents 单 topic 多 trigger 顺序确定', () => {
    const events = wakeEvents(
      [{ topicId: 't1', phase: 'review', agentAsked: true }],
      NOW,
    );
    assert.equal(events[0]!.triggers[0]!.kind, 'gate');
    assert.equal(events[0]!.triggers[1]!.kind, 'agent_question');
  });
});

describe('nextCheckIn 7 天上限', () => {
  test('at 在 now 之前 → 钳到 now', () => {
    assert.equal(nextCheckIn(NOW - 1000, NOW), NOW);
  });

  test('at = now → now', () => {
    assert.equal(nextCheckIn(NOW, NOW), NOW);
  });

  test('at 在 7 天以内 → 透传', () => {
    const at = NOW + 3 * DAY;
    assert.equal(nextCheckIn(at, NOW), at);
  });

  test('at 超 7 天 → 钳到 now + 7 天', () => {
    const at = NOW + 10 * DAY;
    assert.equal(nextCheckIn(at, NOW), NOW + WATCH_LIMITS.MAX_CHECKIN_MS);
  });

  test('at 刚好 7 天 → 透传（边界）', () => {
    const at = NOW + WATCH_LIMITS.MAX_CHECKIN_MS;
    assert.equal(nextCheckIn(at, NOW), at);
  });

  test('MAX_CHECKIN_DAYS 锁为 7（文档实测）', () => {
    assert.equal(WATCH_LIMITS.MAX_CHECKIN_DAYS, 7);
  });
});

describe('canCreateTopic 50 topic 上限', () => {
  test('当前 0 → 可创建', () => {
    assert.equal(canCreateTopic(0), true);
  });

  test('当前 49 → 可创建（边界）', () => {
    assert.equal(canCreateTopic(49), true);
  });

  test('当前 50 → 不可创建', () => {
    assert.equal(canCreateTopic(50), false);
  });

  test('MAX_TOPICS 锁为 50（文档实测）', () => {
    assert.equal(WATCH_LIMITS.MAX_TOPICS, 50);
  });
});

describe('onDispatched hook（路由集成契约）', () => {
  test('chief_dispatch 路径 watched=true', async () => {
    const r = await onDispatched(null, {
      threadId: 'th1', todoId: 'todo1', buildId: 'b1', phase: 'implement', teamId: 't1',
    });
    assert.equal(r.watched, true);
  });

  test('planning/review/confirm gate → advice=hold', async () => {
    for (const phase of ['planning', 'review', 'confirm']) {
      const r = await onDispatched(null, {
        threadId: 'th1', todoId: 'todo1', buildId: 'b1', phase, teamId: 't1',
      });
      assert.equal(r.advice, 'hold', `${phase} 应 hold`);
    }
  });

  test('implement 等非 gate → advice=dispatch', async () => {
    const r = await onDispatched(null, {
      threadId: 'th1', todoId: 'todo1', buildId: 'b1', phase: 'implement', teamId: 't1',
    });
    assert.equal(r.advice, 'dispatch');
  });
});

describe('dispatch 与 prompt.ts 的契约边界', () => {
  test('liftGrant 把 lite 表示转成 StandingGrant', () => {
    const g = liftGrant({ action: 'all_gates', scope: { type: 'team' }, grantedAt: NOW });
    assert.equal(g.action, 'all_gates');
    assert.equal(g.grantedAt, NOW);
  });

  test('parseStandingGrantsLite 绑定 prompt.ts 解析器', () => {
    const r = parseStandingGrantsLite('merge when review passes', NOW);
    assert.ok(r.some((g) => g.action === 'merge_changes'));
  });

  test('scope 参数类型与 prompt.ts 一致', () => {
    const scope: StandingGrantScope = { type: 'agent', id: 'a1' };
    const r = parseStandingGrantsLite('merge when review passes', NOW, scope);
    assert.ok(r.length > 0);
  });
});
