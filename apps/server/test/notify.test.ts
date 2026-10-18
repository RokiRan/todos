import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  canReceiveIosPush,
  channelFor,
  decideNotify,
  notificationTitle,
  type NotifyEvent,
  type NotificationPrefs,
} from '../src/notify.js';

const OWNER = { ownerMemberId: 'm-owner', isTeamAdmin: true };
const ALL_ON: NotificationPrefs = {
  push: true, dailyDigestEmail: true, weeklyReportEmail: true, taskFailureEmail: true,
};
const ALL_OFF: NotificationPrefs = {
  push: false, dailyDigestEmail: false, weeklyReportEmail: false, taskFailureEmail: false,
};

function ev(over: Partial<NotifyEvent> = {}): NotifyEvent {
  return { event: 'plan_ready', todoId: 't1', triggerBy: 'user', ...over };
}

describe('收件人恒为 todo owner', () => {
  test('用户触发 → 推给 owner', () => {
    const d = decideNotify(OWNER, ev({ triggerBy: 'user' }));
    assert.equal(d.shouldNotify, true);
  });

  test('Agent 触发 → 仍推给 owner（谁建的无关）', () => {
    const d = decideNotify(OWNER, ev({ event: 'agent_note', triggerBy: 'agent' }));
    assert.equal(d.shouldNotify, true);
  });

  test('Chief 触发 → 不推（Chief 在自己 topic 跟）', () => {
    const d = decideNotify(OWNER, ev({ event: 'build_finished', triggerBy: 'chief' }));
    assert.equal(d.shouldNotify, false);
    assert.ok(d.reason.includes('chief'));
  });

  test('定时任务失败 → 推给 owner', () => {
    const d = decideNotify(OWNER, ev({ event: 'scheduled_run_failed', triggerBy: 'schedule' }));
    assert.equal(d.shouldNotify, true);
  });

  test('所有决策都要写审计（双轨可追溯）', () => {
    for (const trigger of ['user', 'chief', 'agent', 'schedule'] as const) {
      assert.equal(decideNotify(OWNER, ev({ triggerBy: trigger })).shouldAudit, true);
    }
  });
});

describe('通知渠道', () => {
  test('push 开启时含 push', () => {
    assert.ok(channelFor('plan_ready', ALL_ON).includes('push'));
  });

  test('push 关闭时不含 push，但收件箱仍在', () => {
    const ch = channelFor('plan_ready', ALL_OFF);
    assert.equal(ch.includes('push'), false);
    assert.ok(ch.includes('inbox'), '收件箱是基础视图，不受开关影响');
  });

  test('失败类事件受 taskFailureEmail 开关控制', () => {
    const withEmail = channelFor('build_failed', ALL_ON);
    assert.ok(withEmail.includes('email'), '开启时失败邮件应发出');

    const noEmail = channelFor('build_failed', {
      ...ALL_ON, taskFailureEmail: false,
    });
    assert.equal(noEmail.includes('email'), false);
  });

  test('非失败事件不受 taskFailureEmail 影响', () => {
    const ch = channelFor('plan_ready', { ...ALL_ON, taskFailureEmail: false });
    assert.equal(ch.includes('email'), false, '计划就绪不该触发失败邮件');
  });

  test('三类失败事件都走失败邮件', () => {
    for (const e of ['build_failed', 'merge_blocked', 'scheduled_run_failed'] as const) {
      assert.ok(channelFor(e, ALL_ON).includes('email'), `${e} 应发失败邮件`);
    }
  });
});

describe('iOS push 前置条件', () => {
  test('iOS 未加到主屏幕 → 收不到 push（文档硬要求）', () => {
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)';
    assert.equal(canReceiveIosPush(ua, false), false);
  });

  test('iOS 加到主屏幕 → 可收', () => {
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)';
    assert.equal(canReceiveIosPush(ua, true), true);
  });

  test('非 iOS 不受此限制', () => {
    assert.equal(canReceiveIosPush('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', false), true);
    assert.equal(canReceiveIosPush('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', false), true);
  });
});

describe('通知标题', () => {
  test('全部 7 类事件都有中文标题', () => {
    const events = [
      'plan_ready', 'build_finished', 'agent_question', 'build_failed',
      'agent_note', 'chief_reply', 'assigned_to_you', 'scheduled_run_failed',
    ] as const;
    for (const e of events) {
      const t = notificationTitle(e);
      assert.ok(t.length > 0, `${e} 缺标题`);
      assert.ok(!/^[a-z_]+$/.test(t), `${e} 标题应中文化，得到 ${t}`);
    }
  });

  test('merge_blocked 也有标题', () => {
    assert.ok(notificationTitle('merge_blocked').length > 0);
  });
});
