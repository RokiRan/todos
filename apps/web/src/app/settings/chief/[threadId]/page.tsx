'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTeamContext } from '@/lib/team-context';
import { SettingsPlaceholder, teamNeedsPlaceholder } from '@/app/settings/settings-placeholder';
import { PHASE_COLUMNS, type TodoPhase } from '@/lib/api';
import { C, F, R, S, T, shared } from '@/lib/design-tokens';

/**
 * Settings → Chief topic 详情页。
 *
 * 数据流：
 *   1. `GET /api/chief/threads/{threadId}` → `thread`；
 *      `thread.session.id` 就是 conversationId（Chief 对话复用 build_message，
 *      用 thread.session.id 当 buildId，见 routes/chief.ts:560-563）。
 *   2. `GET /api/conversations/{convId}/messages` → 历史。
 *   3. 用户输入 → `POST /api/chief/threads/{threadId}/messages`（**真调模型**，
 *      几十秒起）→ 重拉 messages。
 *
 * 消息字段以 `apps/server/src/services/conversations.ts` 的
 * `ConversationMessage` 为准：id / buildId / role / phase / triggerBy /
 * content / agent / isError / durationMs / seq / createdAt。
 * `agent` 是 unknown（jsonb），UI 不展开。
 *
 * 502 = 模型不可达（上游 `ModelCallError` 在 routes/chief.ts:795 被映射），
 * 显式提示「依赖挂了」而不是「服务端 bug」；其它 4xx 透出后端原文。
 *
 * 关注列表（watches）单独一节，`phase` 复用 `lib/api.ts` 的 PHASE_COLUMNS 转中文。
 *
 * 关于「在 [threadId] 下怎么拿 teamId」：本页面在 `settings/layout.tsx` 之下，
 * `TeamProvider` 已经在父层包好，`useTeamContext()` 直接拿到 `ctx.userId`。
 * 后端 thread/watches/messages 端点都不需要 teamId（归属在服务端内查），所以
 * 这里**不需要** activeTeam —— 即使无团队也能看自己历史 thread 的内容。
 */

interface ChiefThread {
  id: string;
  chiefId: string;
  title: string;
  session: { runtime: string; id: string; openedAt: number };
  watchedTodos: string[];
  toolDefHashes: Record<string, unknown>;
  pendingSessionResumeAt: number | null;
  lastTurnAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface ConversationMessage {
  id: string;
  buildId: string;
  role: string;
  phase: string | null;
  triggerBy: string | null;
  content: string;
  agent: unknown;
  isError: boolean;
  durationMs: number | null;
  seq: number;
  createdAt: number;
}

interface WatchEntry {
  id: string;
  phase: string;
  title: string;
  seqNum: number;
  projectId: string;
  updatedAt: number;
}

export default function ThreadDetailPage(): React.JSX.Element {
  const { ctx, status, activeTeam } = useTeamContext();
  const params = useParams<{ threadId: string }>();

  if (teamNeedsPlaceholder(status, activeTeam)) {
    return (
      <main>
        <SettingsPlaceholder status={status} activeTeam={activeTeam} />
      </main>
    );
  }

  if (!params?.threadId) return <main />;
  if (!ctx) return <main />;

  return (
    <main>
      <Link href="/settings/chief" style={backLinkStyle}>
        ← Chief
      </Link>
      <ThreadBody threadId={params.threadId} userId={ctx.userId} />
    </main>
  );
}

function ThreadBody({
  threadId,
  userId,
}: {
  threadId: string;
  userId: string;
}): React.JSX.Element {
  // ── thread 自身 ────────────────────────────────────────────────
  const [thread, setThread] = useState<ChiefThread | null>(null);
  const [threadLoading, setThreadLoading] = useState(true);
  const [threadErr, setThreadErr] = useState<string | null>(null);

  // ── 消息流 ─────────────────────────────────────────────────────
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [msgLoading, setMsgLoading] = useState(false);
  const [msgErr, setMsgErr] = useState<string | null>(null);
  const [sinceSeq, setSinceSeq] = useState<number>(0);

  // ── 关注列表 ───────────────────────────────────────────────────
  const [watches, setWatches] = useState<WatchEntry[]>([]);
  const [watchesErr, setWatchesErr] = useState<string | null>(null);

  // ── 输入 ───────────────────────────────────────────────────────
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  // ── 拉 thread ──────────────────────────────────────────────────
  const reloadThread = useCallback(async () => {
    setThreadLoading(true);
    setThreadErr(null);
    try {
      const res = await fetch(
        `/api/chief/threads/${encodeURIComponent(threadId)}`,
        { cache: 'no-store' },
      );
      const body = (await res.json().catch(() => null)) as
        | { ready?: boolean; data?: ChiefThread; reason?: string }
        | null;
      if (!body?.ready) {
        setThreadErr(`数据未就绪：${body?.reason ?? 'unknown'}`);
        setThread(null);
        return;
      }
      setThread(body.data ?? null);
    } catch (err) {
      setThreadErr(err instanceof Error ? err.name : 'unknown');
    } finally {
      setThreadLoading(false);
    }
  }, [threadId]);

  // ── 拉消息（首次全量，之后用 sinceSeq 增量） ───────────────────
  const reloadMessages = useCallback(async () => {
    setMsgLoading(true);
    setMsgErr(null);
    try {
      const qs = sinceSeq > 0 ? `?sinceSeq=${sinceSeq}` : '';
      const res = await fetch(
        `/api/conversations/${encodeURIComponent(thread?.session.id ?? '')}/messages${qs}`,
        { cache: 'no-store' },
      );
      // 没有 convId 就跳过（thread 未就绪时也允许页面渲染骨架）
      if (!thread?.session.id) {
        setMessages([]);
        return;
      }
      const body = (await res.json().catch(() => null)) as
        | { ready?: boolean; data?: ConversationMessage[]; reason?: string }
        | null;
      if (!body?.ready) {
        setMsgErr(`数据未就绪：${body?.reason ?? 'unknown'}`);
        return;
      }
      const incoming = body.data ?? [];
      setMessages((prev) => {
        if (sinceSeq === 0) return incoming;
        // 增量：合并去重
        const known = new Set(prev.map((m) => m.id));
        const merged = [...prev];
        for (const m of incoming) if (!known.has(m.id)) merged.push(m);
        return merged;
      });
      if (incoming.length > 0) {
        const maxSeq = Math.max(...incoming.map((m) => m.seq));
        setSinceSeq((s) => Math.max(s, maxSeq));
      }
    } catch (err) {
      setMsgErr(err instanceof Error ? err.name : 'unknown');
    } finally {
      setMsgLoading(false);
    }
  }, [thread?.session.id, sinceSeq]);

  // ── 拉 watches ─────────────────────────────────────────────────
  const reloadWatches = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/chief/threads/${encodeURIComponent(threadId)}/watches`,
        { cache: 'no-store' },
      );
      const body = (await res.json().catch(() => null)) as
        | { ready?: boolean; data?: WatchEntry[]; reason?: string }
        | null;
      if (!body?.ready) {
        setWatchesErr(`数据未就绪：${body?.reason ?? 'unknown'}`);
        setWatches([]);
        return;
      }
      setWatches(body.data ?? []);
      setWatchesErr(null);
    } catch (err) {
      setWatchesErr(err instanceof Error ? err.name : 'unknown');
    }
  }, [threadId]);

  useEffect(() => {
    void reloadThread();
  }, [reloadThread]);

  useEffect(() => {
    if (thread?.session.id) void reloadMessages();
  }, [reloadMessages, thread?.session.id]);

  useEffect(() => {
    void reloadWatches();
  }, [reloadWatches]);

  // 消息更新后滚到底
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  // ── 发消息 ─────────────────────────────────────────────────────
  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setSendErr(null);
    try {
      const res = await fetch(
        `/api/chief/threads/${encodeURIComponent(threadId)}/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: text }),
        },
      );
      const body = (await res.json().catch(() => null)) as
        | { text?: string; toolCalls?: unknown[]; lastSeq?: number; stoppedBy?: string; error?: string }
        | null;

      if (res.status === 502) {
        // 上游 ModelCallError → 502，**显示成「模型不可达」，不归咎服务端**
        setSendErr('模型不可达：依赖的服务/上游挂了，请稍后重试。');
        return;
      }
      if (!res.ok) {
        // 其它 4xx 透出后端原文
        setSendErr(body?.error ?? `http-${res.status}`);
        return;
      }

      setInput('');
      // 成功后重拉 messages（lastSeq 是回包里模型最新 seq，sinceSeq 从这里开始）
      if (body?.lastSeq && body.lastSeq > 0) {
        setSinceSeq((s) => Math.max(s, body.lastSeq ?? s));
      }
      // 强制全量刷新（增量要靠 sinceSeq，下一次 effect 才会触发；这里显式调用）
      await reloadMessages();
    } catch (err) {
      setSendErr(err instanceof Error ? err.name : 'unknown');
    } finally {
      setSending(false);
    }
  };

  if (threadLoading) {
    return <div style={placeholderStyle}>读取中…</div>;
  }
  if (threadErr) {
    return <div style={placeholderStyle}>{threadErr}</div>;
  }
  if (!thread) {
    return <div style={placeholderStyle}>Topic 不存在。</div>;
  }

  return (
    <>
      <h2 style={h2Style}>{thread.title}</h2>
      <div style={metaStyle}>
        session: <code style={{ fontSize: 11, fontFamily: F.mono, background: C.code, padding: '1px 6px', borderRadius: R.sm }}>{thread.session.id}</code>
        {' · '}
        最后发言：{thread.lastTurnAt ? formatTime(thread.lastTurnAt) : '尚未发言'}
      </div>

      {/* ── 消息流 ────────────────────────────────────────────── */}
      <section style={sectionStyle}>
        <h3 style={h3Style}>对话</h3>
        <div ref={scrollRef} style={chatScrollStyle}>
          {msgLoading && messages.length === 0 && (
            <div style={mutedStyle}>读取中…</div>
          )}
          {msgErr && messages.length === 0 && (
            <div style={mutedStyle}>{msgErr}</div>
          )}
          {messages.length === 0 && !msgLoading && !msgErr && (
            <div style={mutedStyle}>还没有消息。说点什么。</div>
          )}
          {messages.map((m) => (
            <div key={m.id} style={m.role === 'user' ? msgRowUser : msgRowChief}>
              <div style={msgHeadStyle}>
                <span style={msgRoleStyle}>{m.role}</span>
                {m.isError && (
                  <span style={{ color: C.danger, fontSize: T.sm }}>（错误）</span>
                )}
                <span style={{ color: C.textFaint, fontSize: T.sm, marginLeft: 8 }}>
                  seq {m.seq} · {formatTime(m.createdAt)}
                  {m.durationMs !== null && ` · ${m.durationMs}ms`}
                </span>
              </div>
              <div style={msgBodyStyle}>{m.content}</div>
            </div>
          ))}
        </div>

        {/* 输入区 */}
        <div style={composerStyle}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // Cmd/Ctrl + Enter 发送
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="对 Chief 说话…（Cmd/Ctrl+Enter 发送）"
            rows={3}
            disabled={sending}
            style={{
              ...textareaStyle,
              opacity: sending ? 0.7 : 1,
            }}
          />
          <div style={composerRowStyle}>
            {sendErr ? (
              <span style={{ color: C.danger, fontSize: T.sm }}>{sendErr}</span>
            ) : sending ? (
              <span style={{ color: C.textDim, fontSize: T.sm }}>模型调用中（几十秒起）…</span>
            ) : (
              <span style={{ color: C.textDim, fontSize: T.sm }}>
                userId: <code style={{ fontSize: 11, fontFamily: F.mono, background: C.code, padding: '1px 6px', borderRadius: R.sm }}>{userId}</code>
              </span>
            )}
            <button
              type="button"
              disabled={sending || !input.trim()}
              onClick={() => void send()}
              style={{
                ...primaryBtn,
                opacity: sending || !input.trim() ? 0.5 : 1,
                cursor: sending || !input.trim() ? 'not-allowed' : 'pointer',
              }}
            >
              {sending ? '发送中…' : '发送'}
            </button>
          </div>
        </div>
      </section>

      {/* ── 关注列表 ────────────────────────────────────────── */}
      <section style={sectionStyle}>
        <h3 style={h3Style}>关注 ({watches.length})</h3>
        {watchesErr && <div style={mutedStyle}>{watchesErr}</div>}
        {!watchesErr && watches.length === 0 && (
          <div style={mutedStyle}>没有 watch 的 todo。</div>
        )}
        {watches.length > 0 && (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>seq</th>
                <th style={thStyle}>标题</th>
                <th style={thStyle}>phase</th>
              </tr>
            </thead>
            <tbody>
              {watches.map((w) => (
                <tr key={w.id}>
                  <td style={tdStyle}>#{w.seqNum}</td>
                  <td style={tdStyle}>{w.title}</td>
                  <td style={tdStyle}>{phaseLabel(w.phase)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

// ── 工具 ──────────────────────────────────────────────────────────

/** 复用 `lib/api.ts` 的 PHASE_COLUMNS 把 phase 转中文；未知值原样。 */
function phaseLabel(phase: string): string {
  const col = PHASE_COLUMNS.find((c) => c.phase === (phase as TodoPhase));
  return col?.label ?? phase;
}

function formatTime(ms: number | null): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

// ── 样式 ──────────────────────────────────────────────────────────

const backLinkStyle: CSSProperties = { fontSize: T.meta, color: C.accent, textDecoration: 'none' };
const h2Style: CSSProperties = { fontSize: T.h2, margin: '12px 0 4px', fontWeight: 600, color: C.text };
const h3Style: CSSProperties = { fontSize: T.h3, margin: '0 0 8px', fontWeight: 600, color: C.text };
const metaStyle: CSSProperties = { color: C.textDim, fontSize: T.sm, marginBottom: S.md };
const sectionStyle: CSSProperties = { ...shared.card, marginBottom: S.lg };
const placeholderStyle: CSSProperties = shared.placeholderBox;
const mutedStyle: CSSProperties = { color: C.textFaint, fontSize: T.meta, padding: `${S.md}px 0` };
const chatScrollStyle: CSSProperties = {
  maxHeight: 480,
  overflowY: 'auto',
  background: C.bg,
  border: `1px solid ${C.line}`,
  borderRadius: R.md,
  padding: S.md,
  marginBottom: 8,
};
const msgRowUser: CSSProperties = {
  background: 'rgba(129,140,248,0.14)',
  borderLeft: `3px solid ${C.accent}`,
  border: `1px solid rgba(129,140,248,0.30)`,
  borderRadius: R.lg,
  padding: S.md,
  marginBottom: 8,
};
const msgRowChief: CSSProperties = {
  background: C.surface,
  border: `1px solid ${C.line}`,
  borderRadius: R.lg,
  padding: S.md,
  marginBottom: 8,
};
const msgHeadStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginBottom: 4,
};
const msgRoleStyle: CSSProperties = {
  fontSize: T.sm,
  fontWeight: 600,
  color: C.accent,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
};
const msgBodyStyle: CSSProperties = {
  fontSize: T.meta,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  lineHeight: 1.5,
  color: C.text,
};
const composerStyle: CSSProperties = { ...shared.card, paddingTop: S.md, marginTop: 4 };
const composerRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginTop: 6,
  gap: 8,
};
const textareaStyle: CSSProperties = {
  ...shared.input,
  width: '100%',
  padding: S.md,
  resize: 'vertical',
  minHeight: 70,
  boxSizing: 'border-box',
  fontFamily: F.sans,
};
const primaryBtn: CSSProperties = shared.primaryBtn;
const tableStyle: CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: T.meta };
const thStyle: CSSProperties = {
  textAlign: 'left',
  padding: '8px 10px',
  background: C.surfaceHi,
  borderBottom: `1px solid ${C.line}`,
  fontWeight: 600,
  fontSize: T.sm,
  color: C.textDim,
};
const tdStyle: CSSProperties = {
  padding: '8px 10px',
  borderBottom: '1px solid rgba(255,255,255,0.06)',
  verticalAlign: 'top',
  color: C.text,
};
