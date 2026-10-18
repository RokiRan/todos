import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  evaluate,
  nextRunAt,
  shouldSelfDelete,
  type FireContext,
  type ScheduleRule,
} from '../src/schedule.js';

/**
 * Schedule 求值。行为全部对齐 recon/docs/schedules.md。
 * 重点是「错过不补跑」与「钉机器不跳」这两条反直觉规则。
 */

const TZ = 'Asia/Shanghai';
const WEEKDAY_RULE_BASE = {
  id: 'r1', teamId: 't1', todoId: 'todo1', timezone: TZ,
  automatic: true, lastFiredAt: null,
} as const;

const OK_CTX: FireContext = {
  todoClosed: false, hasAgent: true, hasQuota: true, hasOnlineMachine: true,
};

function hourly(minute: number): ScheduleRule {
  return { ...WEEKDAY_RULE_BASE, kind: 'hourly', expr: String(minute) };
}

function daily(hhmm: string): ScheduleRule {
  return { ...WEEKDAY_RULE_BASE, kind: 'daily', expr: hhmm };
}

function weekly(weekday: number, hhmm: string): ScheduleRule {
  return { ...WEEKDAY_RULE_BASE, kind: 'weekly', weekday, expr: hhmm };
}

function once(iso: string): ScheduleRule {
  return { ...WEEKDAY_RULE_BASE, kind: 'once', expr: iso };
}

/** 用某时区的挂钟时间构造 UTC 毫秒 */
function at(y: number, mo: number, d: number, h: number, mi: number): number {
  // 通过 nextRunAt 的逆运算：先算 UTC 再按该时区校正
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = (ts: number) => {
    const parts = fmt.formatToParts(new Date(ts));
    const g = (t: string) => Number(parts.find((x) => x.type === t)?.value ?? 0);
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second'));
  };
  let ts = guess;
  for (let i = 0; i < 2; i++) {
    const drift = guess - p(ts);
    if (drift === 0) break;
    ts += drift;
  }
  return ts;
}

describe('nextRunAt —— 严格返回未来时刻', () => {
  test('hourly 下一分钟未到则在本小时，已过则跳下一小时', () => {
    const r = hourly(30);
    const now = at(2026, 3, 10, 10, 10);
    const next = nextRunAt(r, now);
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
    });
    assert.equal(fmt.format(new Date(next)), '10:30');
  });

  test('hourly 已过则进入下一小时（不返回过去）', () => {
    const r = hourly(15);
    const now = at(2026, 3, 10, 10, 40);
    const next = nextRunAt(r, now);
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
    });
    assert.equal(fmt.format(new Date(next)), '11:15');
  });

  test('nextRunAt 永远严格大于入参', () => {
    const r = daily('09:00');
    for (const hour of [0, 8, 9, 23]) {
      const now = at(2026, 3, 10, hour, 0);
      assert.ok(nextRunAt(r, now) > now, `${hour} 点时 next 必须在未来`);
    }
  });

  test('daily 跨天正确', () => {
    const r = daily('09:00');
    const next = nextRunAt(r, at(2026, 3, 10, 23, 0));
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    assert.equal(fmt.format(new Date(next)), '11/03/2026, 09:00');
  });

  test('weekly 找到目标星期', () => {
    // 2026-03-10 是周二(weekday=2)
    const r = weekly(4, '08:30'); // 目标周四
    const next = nextRunAt(r, at(2026, 3, 10, 12, 0));
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
    });
    const out = fmt.format(new Date(next));
    assert.ok(out.includes('Thu'), `应落在周四，实际 ${out}`);
    assert.ok(out.includes('08:30'));
  });

  test('weekly 目标为今天但时间已过则跳到下周', () => {
    const r = weekly(2, '08:30'); // 周二 08:30，今天周二但已 12:00
    const next = nextRunAt(r, at(2026, 3, 10, 12, 0));
    const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short' });
    assert.equal(fmt.format(new Date(next)), 'Tue');
    assert.ok(next > at(2026, 3, 10, 12, 0));
  });

  test('once 返回自身时刻', () => {
    const target = Date.parse('2026-06-01T08:00:00Z');
    const r = once('2026-06-01T08:00:00Z');
    assert.equal(nextRunAt(r, target - 1000), target);
  });
});

describe('evaluate —— 跳过条件', () => {
  test('一切正常时触发', () => {
    const r = daily('09:00');
    const d = evaluate(r, at(2026, 3, 10, 9, 0), OK_CTX);
    assert.equal(d.shouldFire, true);
    assert.equal(d.reason, null);
  });

  test('Closed todo 永不复活', () => {
    const r = daily('09:00');
    const d = evaluate(r, at(2026, 3, 10, 9, 0), { ...OK_CTX, todoClosed: true });
    assert.equal(d.shouldFire, false);
    assert.equal(d.reason, 'closed_todo');
  });

  test('无 agent 跳过', () => {
    const r = daily('09:00');
    const d = evaluate(r, at(2026, 3, 10, 9, 0), { ...OK_CTX, hasAgent: false });
    assert.equal(d.reason, 'no_agent');
  });

  test('配额不足跳过', () => {
    const r = daily('09:00');
    const d = evaluate(r, at(2026, 3, 10, 9, 0), { ...OK_CTX, hasQuota: false });
    assert.equal(d.reason, 'quota');
  });

  test('Automatic 规则在无在线机器时跳过', () => {
    const r = daily('09:00');
    const d = evaluate(r, at(2026, 3, 10, 9, 0), { ...OK_CTX, hasOnlineMachine: false });
    assert.equal(d.shouldFire, false);
    assert.equal(d.reason, 'no_machine_online');
  });

  test('钉死机器的规则不因机器离线而跳过（fire-and-fail）', () => {
    const pinned: ScheduleRule = { ...daily('09:00'), automatic: false };
    const d = evaluate(pinned, at(2026, 3, 10, 9, 0), { ...OK_CTX, hasOnlineMachine: false });
    assert.equal(d.shouldFire, true, '钉机器的规则必须触发，失败由构建期处理');
    assert.equal(d.reason, null);
  });

  test('跳过优先级：closed 优先于其他', () => {
    const r = daily('09:00');
    const d = evaluate(r, at(2026, 3, 10, 9, 0), {
      todoClosed: true, hasAgent: false, hasQuota: false, hasOnlineMachine: false,
    });
    assert.equal(d.reason, 'closed_todo');
  });
});

describe('错过不补跑', () => {
  test('落后 5 小时的 hourly 规则只返回下一个预定点', () => {
    const r = hourly(0);
    const now = at(2026, 3, 10, 15, 30);
    const d = evaluate(r, now, OK_CTX);
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
    });
    // 应是 16:00，而不是补跑 10:00..15:00
    assert.equal(fmt.format(new Date(d.nextRunAt)), '16:00');
  });

  test('落后数天的 daily 规则不补跑', () => {
    const r = daily('09:00');
    const now = at(2026, 3, 20, 12, 0);
    const d = evaluate(r, now, OK_CTX);
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', hour12: false,
    });
    // 应是 3/21 09:00，不是补跑 3/11..3/20
    assert.equal(fmt.format(new Date(d.nextRunAt)), '21/03, 09');
  });
});

describe('once 规则自删除', () => {
  test('到点后应自删除', () => {
    const r = once('2026-06-01T08:00:00Z');
    assert.equal(shouldSelfDelete(r, Date.parse('2026-06-01T08:00:00Z')), true);
  });

  test('未到点不自删除', () => {
    const r = once('2026-06-01T08:00:00Z');
    assert.equal(shouldSelfDelete(r, Date.parse('2026-05-31T08:00:00Z')), false);
  });

  test('非 once 规则永不自删除', () => {
    assert.equal(shouldSelfDelete(daily('09:00'), Date.now() + 1e12), false);
    assert.equal(shouldSelfDelete(hourly(0), Date.now() + 1e12), false);
    assert.equal(shouldSelfDelete(weekly(1, '09:00'), Date.now() + 1e12), false);
  });
});
