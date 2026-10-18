import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { transition, gateDecision } from '../src/state-machine.js';
import { holdsSlot, isGate, isSettled } from '../src/enums.js';

/**
 * 闸门铁律是整个产品里最容易做错的地方，必须先用测试锁死。
 * 文档原文（recon/SPEC.md §3.1 引用）：
 *   「两 gate 都只服从各自主按钮… Anything typed into the message box —
 *     including the word "confirm" — is treated as revision feedback:
 *     the agent runs a revision turn against your message and stops at
 *     the same gate again; it neither starts building nor merges.」
 */

describe('闸门铁律 —— 文档最核心的设计', () => {
  test('Confirm 门：主按钮推进到实施', () => {
    const r = transition('confirm', { kind: 'approve', by: 'user' });
    assert.equal(r.ok, true);
    assert.equal(r.next, 'implement');
    assert.equal(r.dispatch, true);
  });

  test('Confirm 门：Chief 代确认也推进', () => {
    const r = transition('confirm', { kind: 'approve', by: 'chief' });
    assert.equal(r.next, 'implement');
  });

  test('Confirm 门：输入任何文字（含 confirm）都是修订反馈，停在原闸门', () => {
    const r = transition('confirm', { kind: 'revision_feedback' });
    assert.equal(r.ok, true, '必须被接受 —— 它是一次合法的 revision turn');
    assert.equal(r.next, 'confirm', '必须留在同一闸门');
    assert.equal(r.dispatch, true, '但要派一轮 revision');
  });

  test('Review 门：主按钮完成', () => {
    const r = transition('review', { kind: 'complete', merge: false });
    assert.equal(r.ok, true);
    assert.equal(r.next, 'done');
    assert.equal(!r.dispatch, true, '不勾合并时不应派 merge turn');
  });

  test('Review 门：勾选合并 → 跑 merge turn', () => {
    const r = transition('review', { kind: 'complete', merge: true });
    assert.equal(r.next, 'implement', '勾了合并就先跑 merge turn');
    assert.equal(r.dispatch, true);
  });

  test('Review 门：输入文字同样停在原闸门', () => {
    const r = transition('review', { kind: 'revision_feedback' });
    assert.equal(r.next, 'review');
    assert.equal(r.dispatch, true);
  });

  test('闸门不响应无关 trigger', () => {
    for (const gate of ['confirm', 'review'] as const) {
      const r = transition(gate, { kind: 'claim', machineId: 'm1' });
      assert.equal(r.ok, false, `${gate} 不该接受 claim`);
      assert.equal(r.next, gate);
    }
  });

  test('gateDecision 判定矩阵', () => {
    assert.equal(gateDecision('confirm', { kind: 'approve', by: 'user' }), 'advance');
    assert.equal(gateDecision('review', { kind: 'complete', merge: false }), 'advance');
    assert.equal(gateDecision('confirm', { kind: 'revision_feedback' }), 'revise');
    assert.equal(gateDecision('review', { kind: 'revision_feedback' }), 'revise');
    assert.equal(gateDecision('implement', { kind: 'approve', by: 'user' }), 'reject');
  });

  // ── AI 交叉评审（2026-10-17 接入）────────────────────────────────────
  // `review_start` 此前在 union 里声明却**没有任何 case 处理** —— `run_review`
  // 工具接进来后发现它恒被拒。补上 `branch` 判定与 reviewing 分支。
  test('Confirm 门上 review_start 判定为 branch（不是 advance）', () => {
    assert.equal(gateDecision('confirm', { kind: 'review_start' }), 'branch');
    // Review 门不发评审 —— review_end 恒回 confirm，从 review 发起就回不到原处
    assert.equal(gateDecision('review', { kind: 'review_start' }), 'reject');
    // 非闸门相位照旧 reject
    assert.equal(gateDecision('implement', { kind: 'review_start' }), 'reject');
  });

  test('Confirm 门发评审 → 落 reviewing 且要调度一轮', () => {
    const r = transition('confirm', { kind: 'review_start' });
    assert.equal(r.ok, true);
    assert.equal(r.next, 'reviewing', '交叉评审落瞬态 reviewing，不是闸门主按钮的落点');
    assert.equal(r.dispatch, true, '不发调度 todo 就永远卡在 reviewing');
  });

  test('评审结束回到 confirm（不是触发它的那个闸门）', () => {
    const r = transition('reviewing', { kind: 'review_end' });
    assert.equal(r.ok, true);
    assert.equal(r.next, 'confirm');
  });

  test('reviewing 相位也认 cancel 与 fail', () => {
    assert.equal(transition('reviewing', { kind: 'cancel' }).next, 'closed');
    assert.equal(transition('reviewing', { kind: 'fail' }).next, 'failed');
    // 别的 trigger 推不动
    assert.equal(transition('reviewing', { kind: 'approve', by: 'user' }).ok, false);
  });

  test('reviewing 占槽（评审期间机器不能被别的 build 占满）', () => {
    assert.equal(holdsSlot('reviewing'), true);
  });

  // ── 闸门上的失败与取消（2026-10-17 随机器 done 收敛补）──────────────
  test('闸门上 fail / cancel 放行（收敛方向，不是绕过闸门）', () => {
    // 闸门上会跑的只有主按钮与 revision_feedback，两者都 dispatch 一个 step。
    // 那个 step 失败时 done 路径收成 `fail` —— 闸门若不放行，todo 就永远停在
    // confirm，build 已 finished 却再没人推进（看板看着完成、实际卡死）。
    assert.equal(transition('confirm', { kind: 'fail' }).next, 'failed');
    assert.equal(transition('review', { kind: 'fail' }).next, 'failed');
    assert.equal(transition('confirm', { kind: 'cancel' }).next, 'closed');
    assert.equal(transition('review', { kind: 'cancel' }).next, 'closed');
  });

  test('闸门仍然拒绝「推进型」的错 trigger（铁律没被放松）', () => {
    // 只认主按钮那条铁律说的是**推进**：approve 只在 confirm、complete 只在 review。
    // 上面放行的是收敛方向的 fail/cancel，不影响这两条。
    assert.equal(transition('confirm', { kind: 'complete', merge: false }).ok, false);
    assert.equal(transition('review', { kind: 'approve', by: 'user' }).ok, false);
    assert.equal(transition('confirm', { kind: 'claim', machineId: 'm' }).ok, false);
    assert.equal(transition('confirm', { kind: 'submit' }).ok, false);
  });
});

describe('正常流转', () => {
  test('planning → confirm（计划写完停闸门）', () => {
    const r = transition('planning', { kind: 'plan_ready' });
    assert.equal(r.next, 'confirm');
  });

  test('implement → review（改动完成停闸门）', () => {
    const r = transition('implement', { kind: 'changes_ready' });
    assert.equal(r.next, 'review');
  });

  test('完整 happy path: todo → planning → implement → review → done', () => {
    let phase = transition('todo', { kind: 'submit' }).next;
    assert.equal(phase, 'todo');

    phase = transition(phase, { kind: 'claim', machineId: 'm1' }).next;
    assert.equal(phase, 'planning');

    // Run now：跳过规划直接实施
    phase = transition(phase, { kind: 'plan_ready' }, { planFirst: false }).next;
    assert.equal(phase, 'implement');

    phase = transition(phase, { kind: 'changes_ready' }).next;
    assert.equal(phase, 'review');

    phase = transition(phase, { kind: 'complete', merge: false }).next;
    assert.equal(phase, 'done');
  });

  test('plan first 路径: claim → planning → confirm → implement → review', () => {
    let phase = transition('todo', { kind: 'claim', machineId: 'm1' }).next;
    assert.equal(phase, 'planning');

    phase = transition(phase, { kind: 'plan_ready' }, { planFirst: true }).next;
    assert.equal(phase, 'confirm');

    phase = transition(phase, { kind: 'approve', by: 'user' }).next;
    assert.equal(phase, 'implement');

    phase = transition(phase, { kind: 'changes_ready' }).next;
    assert.equal(phase, 'review');
  });

  test('planFirst 默认值为 true（未传 ctx 时停在 confirm）', () => {
    const r = transition('planning', { kind: 'plan_ready' });
    assert.equal(r.next, 'confirm');
  });
});

describe('失败与复活', () => {
  test('implement 失败 → failed', () => {
    const r = transition('implement', { kind: 'fail', code: 'machine_offline' });
    assert.equal(r.next, 'failed');
  });

  test('终态可 reopen 回到 review', () => {
    for (const p of ['done', 'failed', 'closed'] as const) {
      const r = transition(p, { kind: 'reopen' });
      assert.equal(r.ok, true, `${p} 应当可 reopen`);
      assert.equal(r.next, 'review');
    }
  });

  test('终态的 Rerun = 新 build，回到 todo', () => {
    const r = transition('done', { kind: 'submit' });
    assert.equal(r.next, 'todo');
  });

  test('终态不响应中间态 trigger', () => {
    const r = transition('done', { kind: 'changes_ready' });
    assert.equal(r.ok, false);
  });
});

describe('并发槽位', () => {
  test('planning / implement / reviewing 占槽', () => {
    assert.equal(holdsSlot('planning'), true);
    assert.equal(holdsSlot('implement'), true);
    assert.equal(holdsSlot('reviewing'), true);
  });

  test('闸门与终态不占槽 —— 文档：立即释放', () => {
    for (const p of ['confirm', 'review', 'done', 'failed', 'closed', 'todo'] as const) {
      assert.equal(holdsSlot(p), false, `${p} 不应占槽`);
    }
  });

  test('queued 不占槽 —— 等的是槽位', () => {
    assert.equal(holdsSlot('queued'), false);
  });
});

describe('闸门与终态判定', () => {
  test('isGate 只认两道闸门', () => {
    assert.equal(isGate('confirm'), true);
    assert.equal(isGate('review'), true);
    assert.equal(isGate('implement'), false);
    assert.equal(isGate('reviewing'), false, 'reviewing 是瞬态，不是闸门');
  });

  test('isSettled 只含三终态', () => {
    for (const p of ['done', 'failed', 'closed'] as const) {
      assert.equal(isSettled(p), true);
    }
    for (const p of ['todo', 'implement', 'review', 'confirm'] as const) {
      assert.equal(isSettled(p), false);
    }
  });
});
