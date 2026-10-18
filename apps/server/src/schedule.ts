/**
 * Schedule 规则求值。
 *
 * 文档要求（recon/docs/schedules.md，verbatim 行为）：
 *   - 4 种形态：Hourly(第N分) / Daily(HH:MM) / Weekly(周几 HH:MM) / Once(某时刻)
 *   - 按**本地时区挂钟**求值，跨夏令时保持钟点不变
 *   - 错过的周期**不补跑**，直接重锚到下一次预定时间
 *   - 跳过条件：Closed todo / No agent / Quota / No machine online（仅 Automatic 规则）
 *   - 钉死机器的规则**不跳** —— 机器下线即 fire-and-fail
 *   - `Once` 在目标时间后每分钟重试直到真启动，然后自我删除
 *   - 每 team ≤10 条
 */

export type ScheduleKind = 'hourly' | 'daily' | 'weekly' | 'once';

export interface ScheduleSpec {
  kind: ScheduleKind;
  /** hourly: 分钟 0-59；daily/weekly: "HH:MM"；once: 完整 ISO */
  expr: string;
  /** IANA 时区名，如 'Asia/Shanghai' */
  timezone: string;
}

export interface ScheduleRule {
  id: string;
  teamId: string;
  todoId: string;
  kind: ScheduleKind;
  /** weekly 时的星期几，0=周日 … 6=周六 */
  weekday?: number;
  timezone: string;
  /** false = 钉死机器，跳过条件不含 No machine online */
  automatic: boolean;
  lastFiredAt: number | null;
  /** cron 文本 / `HH:MM`。不在 DB 表里，由调用方（`routes/schedules.ts`）挂上；
   *  `ruleTimeExpr` 读它。写进接口是为了消掉 `as never` 的 duck-typing。 */
  expr?: string;
}

export type SkipReason =
  | 'closed_todo'
  | 'no_agent'
  | 'quota'
  | 'no_machine_online'
  | null;

export interface FireDecision {
  shouldFire: boolean;
  reason: SkipReason;
  /** 下次预定时间戳，便于 UI 展示「下次运行」 */
  nextRunAt: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 在给定时区取时间的分解 */
interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

const PARTS_CACHE = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timezone: string): Intl.DateTimeFormat {
  let f = PARTS_CACHE.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    PARTS_CACHE.set(timezone, f);
  }
  return f;
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

function zonedParts(ts: number, timezone: string): ZonedParts {
  const parts = getFormatter(timezone).formatToParts(new Date(ts));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '0';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    // Intl 在午夜会返回 24，规整为 0
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: WEEKDAY_MAP[get('weekday')] ?? 0,
  };
}

/** 把「某时区的挂钟时间」转成 UTC 毫秒 */
function zonedTimeToUtc(
  y: number, mo: number, d: number, h: number, mi: number,
  timezone: string,
): number {
  // 先按 UTC 猜一个，再用实际偏移校正（两轮足够覆盖 DST 边界）
  let guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(guess, timezone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const wantUtc = Date.UTC(y, mo - 1, d, h, mi, 0);
    const drift = wantUtc - asUtc;
    if (drift === 0) break;
    guess += drift;
  }
  return guess;
}

function parseHHMM(expr: string): { h: number; m: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(expr.trim());
  if (!m) throw new Error(`invalid time expression: ${expr}`);
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) throw new Error(`out of range: ${expr}`);
  return { h, m: mi };
}

/** 求下一次预定时间。始终严格大于 after。 */
export function nextRunAt(rule: ScheduleRule, after: number): number {
  const tz = rule.timezone;
  const p = zonedParts(after, tz);

  switch (rule.kind) {
    case 'hourly': {
      const minute = Number(ruleTimeExpr(rule));
      // 当前小时的 :minute 若已过，则取下一小时
      const base = zonedTimeToUtc(p.year, p.month, p.day, p.hour, minute, tz);
      return base > after ? base : base + HOUR;
    }

    case 'daily': {
      const { h, m } = parseHHMM(ruleTimeExpr(rule));
      let t = zonedTimeToUtc(p.year, p.month, p.day, h, m, tz);
      if (t <= after) {
        const tomorrow = zonedTimeToUtc(p.year, p.month, p.day + 1, h, m, tz);
        t = tomorrow;
      }
      return t;
    }

    case 'weekly': {
      const { h, m } = parseHHMM(ruleTimeExpr(rule));
      const target = rule.weekday ?? p.weekday;
      for (let offset = 0; offset <= 7; offset++) {
        const candidate = zonedTimeToUtc(p.year, p.month, p.day + offset, h, m, tz);
        const candParts = zonedParts(candidate, tz);
        if (candParts.weekday === target && candidate > after) return candidate;
      }
      // 理论上到不了这里
      return zonedTimeToUtc(p.year, p.month, p.day + 7, h, m, tz);
    }

    case 'once': {
      // Once 的时间就是触发时刻本身
      const t = Date.parse(ruleTimeExpr(rule));
      if (Number.isNaN(t)) throw new Error(`invalid once expression: ${ruleTimeExpr(rule)}`);
      return t;
    }
  }
}

// `expr` 是 cron 文本 / HH:MM（不在 DB 表里，由调用方挂上），所有 kind 都读它。
function ruleTimeExpr(rule: ScheduleRule): string {
  if (rule.expr === undefined) throw new Error(`schedule rule ${rule.id} has no expr`);
  return rule.expr;
}

/** 运行时上下文：判断跳过条件 */
export interface FireContext {
  /** todo 是否已被关闭（Closed 的 schedule 不复活） */
  todoClosed: boolean;
  /** todo / 规则上是否配了 agent */
  hasAgent: boolean;
  /** 团队配额是否充足 */
  hasQuota: boolean;
  /** 是否有可用机器（仅 Automatic 规则会检查） */
  hasOnlineMachine: boolean;
}

/**
 * 判断某条规则在 now 时刻是否该触发。
 *
 * 关键语义：
 *   - 钉死机器（automatic=false）不检查机器在线 —— 文档：fire-and-fail
 *   - Closed todo 永不复活
 *   - 错过不补跑：返回的 nextRunAt 已是下一个未来的预定点
 */
export function evaluate(
  rule: ScheduleRule,
  now: number,
  ctx: FireContext,
): FireDecision {
  const next = nextRunAt(rule, now - 1);

  if (ctx.todoClosed) {
    return { shouldFire: false, reason: 'closed_todo', nextRunAt: next };
  }
  if (!ctx.hasAgent) {
    return { shouldFire: false, reason: 'no_agent', nextRunAt: next };
  }
  if (!ctx.hasQuota) {
    return { shouldFire: false, reason: 'quota', nextRunAt: next };
  }
  if (rule.automatic && !ctx.hasOnlineMachine) {
    // 钉死机器的规则不跳 —— 机器下线时 fire-and-fail
    return { shouldFire: false, reason: 'no_machine_online', nextRunAt: next };
  }

  return { shouldFire: true, reason: null, nextRunAt: next };
}

/** Once 规则触发后应自我删除 */
export function shouldSelfDelete(rule: ScheduleRule, now: number): boolean {
  if (rule.kind !== 'once') return false;
  return now >= Date.parse(ruleTimeExpr(rule));
}

export const SCHEDULE_CONSTANTS = {
  MAX_RULES_PER_TEAM: 10,
  MAX_CHECKIN_DAYS: 7,
  MINUTE, HOUR, DAY,
} as const;
