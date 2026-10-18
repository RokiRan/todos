'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { C, F, R, S, T, shared } from '@/lib/design-tokens';
import { useTeamContext } from '@/lib/team-context';
import { SettingsPlaceholder, teamNeedsPlaceholder } from '@/app/settings/settings-placeholder';
import type { ChiefThread, ConversationMessage } from '@/app/chief/chief-types';

/**
 * 首页右栏的 Chief 对话页面（路由：`/chief/[threadId]`）。
 *
 * **与 `apps/web/src/app/settings/chief/[threadId]/page.tsx` 的差异**：
 * settings 下的同名页是「设置页里的 topic 详情」，含 Watching 区块；
 * 本页是「Workspace 里的对话」—— **只**对话部分（消息流 + composer）。
 * 共享的 `ChiefThread` / `ConversationMessage` 类型抽到了同目录的
 * `chief-types.ts`，避免两处都手写一遍（结构字段来自后端
 * `routes/chief.ts:478-490` + `services/conversations.ts`）。
 *
 * **关于是否抽组件复用**：settings/chief/[threadId] 是另一切片的占有区，
 * 不允许本切片触碰；本切片**不**抽 `ChiefConversation` 公共组件，两处各自
 * 维护一份独立的对话 UI，代码不重叠，迁移/收口留给后续统一工作 —— 在
 * 顶部注释与汇报里都已写明。
 *
 * **数据流**（照搬 settings 那页，保证口径一致）：
 *   1. `GET /api/chief/threads/{threadId}` → `thread`；
 *      `thread.session.id` 就是 conversationId（Chief 对话复用 build_message，
 *      用 thread.session.id 当 buildId，见 routes/chief.ts:560-563）。
 *   2. `GET /api/conversations/{convId}/messages` → 历史（支持 ?sinceSeq 增量）。
 *   3. 用户输入 → `POST /api/chief/threads/{threadId}/messages`（**真调模型**，
 *      几十秒起）→ 重拉 messages。
 *
 * **后端适配失败**：502 = 模型不可达（上游 `ModelCallError` 在
 * `routes/chief.ts:795` 被映射），显式提示「依赖挂了」而不是「服务端 bug」。
 */

export default function ChiefConversationPage(): React.JSX.Element {
  const { ctx, status, activeTeam } = useTeamContext();

  if (teamNeedsPlaceholder(status, activeTeam)) {
    return (
      <div style={placeholderBox}>
        <SettingsPlaceholder status={status} activeTeam={activeTeam} />
      </div>
    );
  }

  // teamId 在对话页面其实**不**用于拉数据（thread/watches/messages 都不需要
  // teamId，归属在服务端走 thread → chief → team 内查）；但 `useTeamContext`
  // 必须就绪才能进入，否则上游 settings 拉不到一切。
  if (!ctx) return <div style={placeholderBox}>读取团队上下文…</div>;

  return <ChiefConversationBody userId={ctx.userId} />;
}

function ChiefConversationBody({ userId }: { userId: string }): React.JSX.Element {
  const [thread, setThread] = useState<ChiefThread | null>(null);
  const [threadLoading, setThreadLoading] = useState(true);
  const [threadErr, setThreadErr] = useState<string | null>(null);

  // 对话消息
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [msgLoading, setMsgLoading] = useState(false);
  const [msgErr, setMsgErr] = useState<string | null>(null);
  const [sinceSeq, setSinceSeq] = useState<number>(0);

  // 输入
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  // ── threadId 来自 URL ─────────────────────────────────────────
  const threadId = useThreadIdFromWindow();
  const [threadsList, setThreadsList] = useState<ChiefThread[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [threadsErr, setThreadsErr] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  // ── 拉 thread ─────────────────────────────────────────────────
  const reloadThread = useCallback(async () => {
    if (!threadId) {
      setThreadErr('缺少 threadId');
      setThreadLoading(false);
      return;
    }
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

  // ── 拉消息 ────────────────────────────────────────────────────
  const reloadMessages = useCallback(async () => {
    if (!thread?.session.id) return;
    setMsgLoading(true);
    setMsgErr(null);
    try {
      const qs = sinceSeq > 0 ? `?sinceSeq=${sinceSeq}` : '';
      const res = await fetch(
        `/api/conversations/${encodeURIComponent(thread.session.id)}/messages${qs}`,
        { cache: 'no-store' },
      );
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

  // ── 拉 topics 列表（用于标题切换） ────────────────────────────
  const reloadTopics = useCallback(async () => {
    if (!userId) return;
    setThreadsLoading(true);
    setThreadsErr(null);
    try {
      const res = await fetch('/api/user/context', { cache: 'no-store' });
      const ctxBody = (await res.json().catch(() => null)) as
        | { ready?: boolean; data?: { teams?: Array<{ teamId: string }> }; reason?: string }
        | null;
      const firstTeam = ctxBody?.data?.teams?.[0];
      if (!firstTeam) {
        setThreadsErr('没有可用的团队');
        setThreadsList([]);
        return;
      }
      const list = await fetch(
        `/api/teams/${encodeURIComponent(firstTeam.teamId)}/chief/threads`,
        { cache: 'no-store' },
      );
      const listBody = (await list.json().catch(() => null)) as
        | { ready?: boolean; data?: ChiefThread[]; reason?: string }
        | null;
      if (!listBody?.ready) {
        setThreadsErr(`数据未就绪：${listBody?.reason ?? 'unknown'}`);
        setThreadsList([]);
        return;
      }
      setThreadsList(listBody.data ?? []);
    } catch (err) {
      setThreadsErr(err instanceof Error ? err.name : 'unknown');
    } finally {
      setThreadsLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void reloadThread();
  }, [reloadThread]);

  useEffect(() => {
    if (thread?.session.id) void reloadMessages();
  }, [reloadMessages, thread?.session.id]);

  useEffect(() => {
    void reloadTopics();
  }, [reloadTopics]);

  // 消息更新后滚到底
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  // ── 发消息 ────────────────────────────────────────────────────
  const send = async () => {
    const text = input.trim();
    if (!text || sending || !threadId) return;
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
        setSendErr('模型不可达：依赖的服务/上游挂了，请稍后重试。');
        return;
      }
      if (!res.ok) {
        setSendErr(body?.error ?? `http-${res.status}`);
        return;
      }
      setInput('');
      if (body?.lastSeq && body.lastSeq > 0) {
        setSinceSeq((s) => Math.max(s, body.lastSeq ?? s));
      }
      await reloadMessages();
    } catch (err) {
      setSendErr(err instanceof Error ? err.name : 'unknown');
    } finally {
      setSending(false);
    }
  };

  if (!threadId) {
    return <div style={placeholderBox}>缺少 threadId。</div>;
  }

  // 标题区：thread 加载完前显示「读取中」，加载完后可点击切换 topic
  const titleBar = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginBottom: S.sm,
      }}
    >
      {threadLoading ? (
        <span style={{ ...h2Style, color: C.textGhost }}>读取中…</span>
      ) : threadErr ? (
        <span style={{ ...h2Style, color: C.danger }}>{threadErr}</span>
      ) : thread ? (
        <button
          type="button"
          onClick={() => setPickerOpen((o) => !o)}
          aria-expanded={pickerOpen}
          aria-haspopup="listbox"
          style={{
            ...h2Style,
            background: 'transparent',
            border: `1px solid ${C.line}`,
            borderRadius: R.md,
            padding: '4px 10px',
            cursor: 'pointer',
            color: C.text,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          {thread.title} <span aria-hidden>▾</span>
        </button>
      ) : (
        <span style={{ ...h2Style, color: C.textGhost }}>Topic 不存在。</span>
      )}
      {/* topic 列表（点击切换） */}
      {pickerOpen && (
        <div
          role="listbox"
          style={{
            position: 'absolute',
            zIndex: 20,
            marginTop: 40,
            background: C.surface,
            border: `1px solid ${C.line}`,
            borderRadius: R.lg,
            minWidth: 240,
            maxHeight: 320,
            overflowY: 'auto',
            padding: 6,
            boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
          }}
        >
          {threadsLoading && <div style={{ ...mutedStyle, padding: S.md }}>读取中…</div>}
          {threadsErr && <div style={{ ...mutedStyle, padding: S.md }}>{threadsErr}</div>}
          {!threadsLoading && !threadsErr && threadsList.length === 0 && (
            <div style={{ ...mutedStyle, padding: S.md }}>还没有 topic。</div>
          )}
          {threadsList.map((t) => {
            const isCurrent = t.id === threadId;
            return (
              <button
                key={t.id}
                type="button"
                role="option"
                aria-selected={isCurrent}
                onClick={() => {
                  setPickerOpen(false);
                  if (!isCurrent) window.location.href = `/chief/${encodeURIComponent(t.id)}`;
                }}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '6px 10px',
                  background: isCurrent ? C.surfaceHi : 'transparent',
                  border: 'none',
                  borderRadius: R.sm,
                  color: C.text,
                  cursor: 'pointer',
                  fontSize: T.meta,
                }}
              >
                {t.title}
                <span style={{ color: C.textGhost, marginLeft: 6, fontSize: T.sm }}>
                  {t.lastTurnAt ? formatTime(t.lastTurnAt) : '尚未发言'}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      {titleBar}

      <section style={sectionStyle}>
        <div ref={scrollRef} style={chatScrollStyle}>
          {msgLoading && messages.length === 0 && (
            <div style={mutedStyle}>读取中…</div>
          )}
          {msgErr && messages.length === 0 && <div style={mutedStyle}>{msgErr}</div>}
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

        {/* composer */}
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
    </div>
  );
}

// ── 工具 ──────────────────────────────────────────────────────────

/**
 * 从 window.location.pathname 拿 [threadId] 段。
 *
 * **为什么不直接用 next/navigation 的 useParams**：本页面是给 Workspace 内部
 * iframe 风格使用，但 React 路由仍然认得这个路径；useParams 在 app router
 * 下必须挂在 client component 顶层。这里避免在 `useThreadIdFromWindow` 内
 * 抛 suspense（侧栏会闪烁），改读 pathname —— 行为是同步的，且只有当用户
 * 通过 <Link> 切换时整个组件树重新挂载，pathname 总是同步新的。
 */
function useThreadIdFromWindow(): string | null {
  const [id, setId] = useState<string | null>(() => readPathThreadId());
  useEffect(() => {
    const update = (): void => setId(readPathThreadId());
    window.addEventListener('popstate', update);
    // 也要监听 pushState —— React/Next 的 client navigation 不触发 popstate
    const orig = window.history.pushState;
    window.history.pushState = function (...args: Parameters<typeof orig>) {
      const ret = orig.apply(this, args);
      update();
      return ret;
    };
    return () => {
      window.removeEventListener('popstate', update);
      window.history.pushState = orig;
    };
  }, []);
  return id;
}

function readPathThreadId(): string | null {
  if (typeof window === 'undefined') return null;
  const m = /^\/chief\/([^/?#]+)/.exec(window.location.pathname);
  if (!m) return null;
  const raw = m[1];
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
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

const h2Style: CSSProperties = { fontSize: T.h2, margin: 0, fontWeight: 600 };
const sectionStyle: CSSProperties = { ...shared.card, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 };
const placeholderBox: CSSProperties = shared.placeholderBox;
const mutedStyle: CSSProperties = { color: C.textFaint, fontSize: T.meta, padding: `${S.md}px 0` };
const chatScrollStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
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