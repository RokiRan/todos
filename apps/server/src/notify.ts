import type { NotificationEvent } from '@tds/protocol';

/**
 * 通知策略。
 *
 * 文档铁律（recon/docs/inbox.md，verbatim）：
 *   「收件人总是 todo 的 owner（人类成员）。谁建的（你/Chief/build agent）都无关；
 *     owner 收通知。Chief 发起的 build turn，Chief 在自己 topic thread 跟并回报，
 *     不重复推 task banner。」
 *
 * 所以：
 *   - 收件人**恒为 todo.ownerMemberId**，与 trigger 无关
 *   - Chief 触发的 run **不推**给 owner（Chief 自己跟）
 *   - 通知写入是双轨审计的一部分（audit_event）
 */

export type NotifyChannel = 'push' | 'email' | 'inbox';

export interface NotificationTarget {
  /** todo 的 owner 成员 id —— 唯一收件人 */
  ownerMemberId: string;
  /** 是否为团队管理员（用于判断能否改配置） */
  isTeamAdmin: boolean;
}

export interface NotifyEvent {
  event: NotificationEvent;
  todoId: string;
  buildId?: string;
  /** 触发来源：用户点按钮 / Chief 派工 / 定时任务 */
  triggerBy: 'user' | 'chief' | 'agent' | 'schedule';
  payload?: Record<string, unknown>;
}

export interface NotifyDecision {
  /** 是否应向 owner 推送 */
  shouldNotify: boolean;
  reason: string;
  /** 仍然要写审计（即使不推送） */
  shouldAudit: true;
}

export function decideNotify(target: NotificationTarget, e: NotifyEvent): NotifyDecision {
  // 定时任务失败：只推给**自己拥有的** todo（文档：Scheduled run failed 只发给 owner）
  if (e.event === 'scheduled_run_failed' && e.triggerBy === 'schedule') {
    return { shouldNotify: true, reason: 'schedule failure always reaches owner', shouldAudit: true };
  }

  // Chief 触发的 turn：Chief 在自己 topic 跟，不重复推 banner
  if (e.triggerBy === 'chief') {
    return { shouldNotify: false, reason: 'chief tracks its own dispatch in its topic', shouldAudit: true };
  }

  // 常规情况：推给 owner
  return { shouldNotify: true, reason: `owner receives ${e.event}`, shouldAudit: true };
}

/** 通知的中文标题（UI 用） */
const TITLES: Record<NotificationEvent, string> = {
  plan_ready: '计划已就绪',
  build_finished: '构建完成，等待验收',
  agent_question: 'Agent 有问题要问你',
  build_failed: '构建失败',
  merge_blocked: '合并被阻塞',
  agent_note: 'Agent 留言',
  chief_reply: 'Chief 回复',
  assigned_to_you: '任务已指派给你',
  scheduled_run_failed: '定时任务失败',
};

export function notificationTitle(event: NotificationEvent): string {
  return TITLES[event];
}

/** 用户设置的四类全局开关（文档：Settings → Notifications） */
export interface NotificationPrefs {
  push: boolean;
  dailyDigestEmail: boolean;
  weeklyReportEmail: boolean;
  taskFailureEmail: boolean;
}

export function channelFor(
  event: NotificationEvent,
  prefs: NotificationPrefs,
): NotifyChannel[] {
  const channels: NotifyChannel[] = [];
  if (prefs.push) channels.push('push');
  // 邮件只对失败类事件单独开关
  if (prefs.taskFailureEmail && (event === 'build_failed' || event === 'merge_blocked' || event === 'scheduled_run_failed')) {
    channels.push('email');
  }
  // 收件箱无条件收（这是产品的基础视图）
  channels.push('inbox');
  return channels;
}

/** iOS：只有加到主屏幕的 Web App 才会收到 push（文档明确） */
export function canReceiveIosPush(userAgent: string, addedToHomeScreen: boolean): boolean {
  const isIos = /iPhone|iPad|iPod/i.test(userAgent);
  if (!isIos) return true;
  return addedToHomeScreen;
}
