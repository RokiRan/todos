'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { CSSProperties } from 'react';
import { C, F, R, S, T, shared } from '@/lib/design-tokens';
import { useTeamContext } from '@/lib/team-context';
import {
  SettingsPlaceholder,
  teamNeedsPlaceholder,
  type TeamStatus,
} from '@/app/settings/settings-placeholder';

/**
 * 「Needs you」专视图 —— 把看板的 Needs you 列单独拉出来看。
 *
 * **为什么这一页存在**（`recon-live/docs-chief.md:16`）：
 * > "The board's four columns. From left to right: Backlog, In progress,
 * >  Needs you, Done. Needs you gathers everything waiting on your decision:
 * >  plans to confirm, changes to accept, failed runs, and research or
 * >  question tasks that have replied or asked a question."
 *
 * 原站没把 Needs you 单独做成一个独立页面 —— 它是 Workspace 看板的第三列。
 * 复刻此处提供一个专视图（与侧栏 Workspace 角标配套）：点角标能直接跳进来。
 *
 * **三类来源**（按 docs-chief.md 措辞拆，第五类不在 UI 中渲染）：
 *   1. 闸门 · 计划确认（`phase = 'confirm'`）
 *   2. 闸门 · 变更确认（`phase = 'review'`）
 *   3. 运行失败 · 待决定重跑（`phase = 'failed'`）
 *   4. 等待回复（任意运行中 phase + `documents.kind='question'`）
 *      —— 当前服务层不写入 question 文档，结果集恒空；UI 仍保留分组
 *      入口，将来服务层接上即自动生效。
 *
 * **owner 判定**：原站「Task notifications go to the todo's owner, which is
 *   always a human team member」—— 服务端已用 INNER JOIN 把 owner ≠ current
 *   user 的 todo 过滤掉，本页只负责按 kind 分组渲染。
 */

type ItemKind = 'confirm' | 'review' | 'failed' | 'awaiting-reply';

interface NeedsYouItem {
  todoId: string;
  seqNum: number;
  title: string;
  phase: string;
  gate: 'confirm' | 'review' | null;
  kind: ItemKind;
  reason: string;
  updatedAt: number;
}

interface NeedsYouOk {
  ready: true;
  data: { items: NeedsYouItem[]; count: number };
}
interface NeedsYouErr {
  ready: false;
  reason: string;
}
type NeedsYouPayload = NeedsYouOk | NeedsYouErr;

const KIND_META: Record<ItemKind, { title: string; hint: string; badge: string }> = {
  confirm: { title: '闸门 · 计划确认', hint: '计划已就绪，等你批准 → 进入实现', badge: '闸门' },
  review: { title: '闸门 · 变更确认', hint: '改动已就绪，等你验收 → 收尾或继续迭代', badge: '闸门' },
  failed: { title: '运行失败 · 待决定重跑', hint: 'agent 这一轮跑了，但中途失败 —— 等你决定继续还是重新打开', badge: '失败' },
  'awaiting-reply': { title: '等待回复', hint: 'agent 提出了结构化问题，正在等你的回答', badge: '提问' },
};
const KIND_ORDER: ItemKind[] = ['confirm', 'review', 'failed', 'awaiting-reply'];

export default function NeedsYouPage(): React.JSX.Element {
  const { status, activeTeam } = useTeamContext();
  const [payload, setPayload] = useState<NeedsYouPayload | null>(null);

  useEffect(() => {
    if (teamNeedsPlaceholder(status, activeTeam)) return;
    let alive = true;
    void (async () => {
      try {
        const res = await fetch('/api/needs-you', { cache: 'no-store' });
        const body = (await res.json().catch(() => null)) as NeedsYouPayload | null;
        if (alive) setPayload(body);
      } catch (err) {
        if (alive) {
          setPayload({
            ready: false,
            reason: err instanceof Error ? err.name : 'unknown',
          });
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [status, activeTeam]);

  if (teamNeedsPlaceholder(status, activeTeam)) {
    return (
      <main>
        <SettingsPlaceholder status={status as TeamStatus} activeTeam={activeTeam} />
      </main>
    );
  }

  return (
    <main>
      <h1 style={titleStyle}>待你处理</h1>
      <p style={subtitleStyle}>
        所有等你决策的事 —— 对应原站 Workspace 看板的「Needs you」列（侧栏 Workspace
        的角标就是这张列表的实时计数）。
      </p>
      <NeedsYouBody payload={payload} />
      <UnsupportedNote />
    </main>
  );
}

function NeedsYouBody({ payload }: { payload: NeedsYouPayload | null }): React.JSX.Element {
  if (payload === null) {
    return <div style={shared.placeholderBox}>读取中…</div>;
  }
  if (!payload.ready) {
    return (
      <div style={shared.errorBox}>
        <strong>读不到 Needs you 列表</strong>
        <div style={{ marginTop: 4, fontSize: 13 }}>
          原因：{payload.reason}。检查 server 在跑、cookie 有效。
        </div>
      </div>
    );
  }
  const { items, count } = payload.data;
  if (count === 0) {
    return <EmptyState />;
  }

  // 按 KIND_ORDER 分组；保留空组不渲染 —— 原站语义里只有「出现」才进列表，
  // 「没出现」就是干净的（不应该画一个空分组抢版面）。
  const grouped: Record<ItemKind, NeedsYouItem[]> = useMemo(() => {
    const m: Record<ItemKind, NeedsYouItem[]> = {
      confirm: [],
      review: [],
      failed: [],
      'awaiting-reply': [],
    };
    for (const item of items) m[item.kind].push(item);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  return (
    <>
      <div style={countLine}>
        <span style={{ color: C.textFaint }}>当前共</span>
        <span style={{ color: C.text, fontWeight: 600, margin: '0 6px' }}>{count}</span>
        <span style={{ color: C.textFaint }}>项等你处理</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: S.xl }}>
        {KIND_ORDER.map((k) => {
          const list = grouped[k];
          if (list.length === 0) return null;
          const meta = KIND_META[k];
          return (
            <section key={k}>
              <h2 style={sectionTitleStyle}>{meta.title}</h2>
              <p style={sectionHintStyle}>{meta.hint}</p>
              <div style={cardWrapStyle}>
                {list.map((it) => (
                  <NeedsYouCard key={it.todoId} item={it} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}

function NeedsYouCard({ item }: { item: NeedsYouItem }): React.JSX.Element {
  return (
    <Link
      href={`/todo/${encodeURIComponent(item.todoId)}`}
      style={cardLinkStyle}
    >
      <div style={cardRowStyle}>
        <span style={seqStyle}>#{item.seqNum}</span>
        <span style={titleTextStyle}>{item.title}</span>
        <PhaseBadge kind={item.kind} />
      </div>
      <div style={cardMetaStyle}>
        <span style={{ color: C.textGhost }}>{item.reason}</span>
        <span style={{ color: C.textGhost }}>·</span>
        <span style={{ color: C.textGhost }}>{relativeTime(item.updatedAt)}</span>
        <span style={{ color: C.textGhost }}>·</span>
        <span style={{ color: C.textGhost, fontFamily: F.mono }}>{item.phase}</span>
      </div>
    </Link>
  );
}

function PhaseBadge({ kind }: { kind: ItemKind }): React.JSX.Element {
  // 闸门 = 警告色；failed = 错误色；awaiting-reply = 强调色
  const color =
    kind === 'confirm' || kind === 'review'
      ? C.warn
      : kind === 'failed'
        ? '#f87171'
        : C.accent;
  return (
    <span
      style={{
        ...badgeStyle,
        color,
        borderColor: color,
      }}
    >
      {KIND_META[kind].badge}
    </span>
  );
}

function EmptyState(): React.JSX.Element {
  return (
    <div style={emptyBoxStyle}>
      <strong style={{ color: C.text }}>没有需要你处理的事</strong>
      <p style={{ marginTop: S.sm, fontSize: T.body, color: C.textDim, lineHeight: 1.6 }}>
        当 todo 停在 confirm / review 闸门、运行失败、或者 agent 提出结构化问题时，会出现在这里。
      </p>
    </div>
  );
}

function UnsupportedNote(): React.JSX.Element {
  // docs-chief.md 的「research or question tasks that have replied」分支
  // 在 schema 里没有对应标记 —— 没有 `doc_kind='answer' / 'research'`,
  // todo 表上也没有 `is_research` 之类。服务层路由里注释过这点。
  // UI 端把这一限制**显式**写出来，免得用户看不到「等回复」组时疑惑。
  return (
    <div style={noteStyle}>
      <strong style={{ color: C.textFaint }}>关于「research/question 任务的回复」</strong>
      <p style={{ marginTop: S.sm, fontSize: T.meta, color: C.textFaint, lineHeight: 1.6 }}>
        原站 Needs you 还包含「research 任务的回复」一类。当前 schema 不支持识别
        这类任务（`doc_kind` 枚举里只有 `question` —— 用于「agent 提问」，没有
        `answer` / `research` 这类回复标记）。服务端没有为这一类返回数据。
        如果将来服务层写入 question 文档，「等待回复」分组会自动出现内容。
      </p>
    </div>
  );
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 0) return '刚刚';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `${mon} 个月前`;
  return `${Math.floor(mon / 12)} 年前`;
}

// ── 样式 ────────────────────────────────────────────────────────────

const titleStyle: CSSProperties = {
  fontSize: T.h1,
  fontWeight: 600,
  color: C.text,
  letterSpacing: '-0.3px',
  margin: 0,
};

const subtitleStyle: CSSProperties = {
  marginTop: S.sm,
  fontSize: T.body,
  color: C.textFaint,
  lineHeight: 1.6,
  maxWidth: 720,
};

const countLine: CSSProperties = {
  marginTop: S.lg,
  marginBottom: S.md,
  fontSize: T.body,
};

const sectionTitleStyle: CSSProperties = {
  fontSize: T.h3,
  fontWeight: 600,
  color: C.text,
  letterSpacing: '-0.2px',
  margin: 0,
};

const sectionHintStyle: CSSProperties = {
  marginTop: 4,
  fontSize: T.meta,
  color: C.textFaint,
};

const cardWrapStyle: CSSProperties = {
  marginTop: S.md,
  display: 'flex',
  flexDirection: 'column',
  gap: S.sm,
};

const cardLinkStyle: CSSProperties = {
  display: 'block',
  textDecoration: 'none',
  background: C.surface,
  border: `1px solid ${C.line}`,
  borderRadius: R.md,
  padding: `${S.md}px ${S.lg}px`,
};

const cardRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: S.md,
};

const seqStyle: CSSProperties = {
  fontFamily: F.mono,
  fontSize: T.sm,
  color: C.textGhost,
  minWidth: 36,
};

const titleTextStyle: CSSProperties = {
  flex: 1,
  fontSize: T.body,
  color: C.text,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const cardMetaStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginTop: 4,
  fontSize: T.meta,
};

const badgeStyle: CSSProperties = {
  fontFamily: F.mono,
  fontSize: '10px',
  fontWeight: 700,
  letterSpacing: '0.4px',
  border: '1px solid',
  borderRadius: R.sm,
  padding: '1px 6px',
  textTransform: 'uppercase',
};

const emptyBoxStyle: CSSProperties = {
  marginTop: S.lg,
  padding: `${S.lg}px`,
  background: C.surface,
  border: `1px dashed ${C.line}`,
  borderRadius: R.md,
};

const noteStyle: CSSProperties = {
  marginTop: S.xl,
  padding: S.md,
  borderLeft: `2px solid ${C.line}`,
  color: C.textFaint,
};