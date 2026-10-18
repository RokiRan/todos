'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTeamContext } from '@/lib/team-context';
import { SettingsPlaceholder, teamNeedsPlaceholder } from '@/app/settings/settings-placeholder';
import { C, F, R, S, T, shared } from '@/lib/design-tokens';

/**
 * Settings → Chief 主页（charter + topic + 工具面）。
 *
 * 三个独立区块，每个都有自己的取数与失败提示：
 *   1. charter —— 用户编辑、Chief 只读；<textarea> + 字数计数 + 保存按钮。
 *      上限 8000 字符来自 `apps/server/src/routes/chief.ts` 的 CharterBody。
 *   2. topic 列表 —— `GET .../chief/threads`；新建走 POST。50 上限由
 *      上游 POST 校验（`MAX_TOPICS_PER_CHIEF`），422 原样透出。
 *   3. 工具面 —— `GET /api/chief/tools`（无 teamId，teamId 在路径上不存在）；
 *      58 个工具中 `wired=false` 的标灰 —— 这一列就是「真缺口」标记，**不能
 *      隐藏**（不显示会让运维看不出哪些工具没装）。
 *
 * `chief: null` 是合法的「无 agent」状态，必须有专门文案：上游明确返回 null
 * 是为了告诉前端「先建 agent」。本次没有 agents 设置页 —— 不假装能建。
 */

interface ChiefInfo {
  id: string;
  userId: string;
  teamId: string;
  agentId: string;
  /**
   * ⚠️ 可以是 `null`：从未写过 charter 的团队，API 原样返回 `null`
   * （实测 `{"data":{"charter":null}}`）。原先声明成 `string` 导致
   * `CharterPanel` 里 `text.length` 在首次渲染就抛异常，整页白屏。
   * 类型与真实响应不符是这类 bug 的根因 —— 声明要跟实测走。
   */
  charter: string | null;
  createdAt: number;
  updatedAt: number;
  agentName: string | null;
}

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

interface ChiefTool {
  name: string;
  group: string;
  summary: string;
  irreversible: boolean;
  needsAdminGrant: boolean;
  handlesSecret: boolean;
  wired: boolean;
}

const CHARTER_MAX = 8000;
const TOOL_GROUPS: Record<string, string> = {
  read: '只读',
  write: '写入',
  manage: '管理',
  dispatch: '派工',
};

export default function ChiefPage(): React.JSX.Element {
  const { ctx, status, activeTeam } = useTeamContext();
  const router = useRouter();

  if (teamNeedsPlaceholder(status, activeTeam)) {
    return (
      <main>
        <SettingsPlaceholder status={status} activeTeam={activeTeam} />
      </main>
    );
  }

  if (!ctx || !activeTeam) return <main />;

  return <ChiefBody teamId={activeTeam.teamId} userId={ctx.userId} onOpenThread={(id) => router.push(`/settings/chief/${id}`)} />;
}

function ChiefBody({
  teamId,
  userId,
  onOpenThread,
}: {
  teamId: string;
  userId: string;
  onOpenThread: (id: string) => void;
}): React.JSX.Element {
  // ── 拉 Chief（chief 自身为 null 时是无 agent 状态） ─────────────
  const [chief, setChief] = useState<ChiefInfo | null | undefined>(undefined);
  const [chiefErr, setChiefErr] = useState<string | null>(null);

  const reloadChief = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/teams/${encodeURIComponent(teamId)}/chief`,
        { cache: 'no-store' },
      );
      const body = (await res.json().catch(() => null)) as
        | { ready?: boolean; data?: ChiefInfo | null; reason?: string }
        | null;
      if (!body?.ready) {
        // 端点没就绪（404 / 后端挂了）—— 当作「未就绪」而不是当 null
        setChief(undefined);
        setChiefErr(`数据未就绪：${body?.reason ?? 'unknown'}`);
        return;
      }
      // body.data 可能是 null（无 agent），合法状态
      setChief(body.data ?? null);
      setChiefErr(null);
    } catch (err) {
      setChief(undefined);
      setChiefErr(err instanceof Error ? err.name : 'unknown');
    }
  }, [teamId]);

  useEffect(() => {
    void reloadChief();
  }, [reloadChief]);

  // chief === null 是合法「无 agent」分支：渲染专门提示
  if (chief === null) {
    return (
      <main>
        <h2 style={h2Style}>Chief</h2>
        <div style={noticeStyle}>
          <strong>该团队还没有 agent</strong>
          <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.6 }}>
            Chief 依赖一支 agent 才能工作：没有 agent 就没有 charter 与 topic。
            当前设置区没有 agents 管理页，请到 <code>packages/db/seed</code>{' '}
            或后端 CLI 创建一支 agent 后再回来。
          </div>
        </div>
      </main>
    );
  }

  if (chief === undefined) {
    return (
      <main>
        <h2 style={h2Style}>Chief</h2>
        <div style={placeholderStyle}>
          {chiefErr ?? '读取中…'}
        </div>
      </main>
    );
  }

  return (
    <main>
      <h2 style={h2Style}>Chief</h2>
      <p style={hintStyle}>
        用户编辑 charter，Chief 只读。Charter 是给 Chief 的「长期工作指引」——
        团队里所有 topic 的默认上下文都来自这里。
      </p>

      <CharterPanel
        teamId={teamId}
        userId={userId}
        chief={chief}
        onSaved={reloadChief}
      />

      <ThreadsPanel
        teamId={teamId}
        userId={userId}
        onOpenThread={onOpenThread}
      />

      <ToolsPanel />
    </main>
  );
}

// ── Charter 区块 ──────────────────────────────────────────────────

function CharterPanel({
  teamId,
  userId,
  chief,
  onSaved,
}: {
  teamId: string;
  userId: string;
  chief: ChiefInfo;
  onSaved: () => Promise<void> | void;
}): React.JSX.Element {
  const [text, setText] = useState(chief.charter ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  // 拉取后端新 charter 时同步到 textarea —— 但用户正在编辑时不要覆盖
  useEffect(() => {
    // ⚠️ `charter` 可能是 `null`：从未写过 charter 的团队，API 原样返回
    // `null`（实测 `GET /api/teams/:t/chief` → `{"data":{"charter":null}}`），
    // 而下面的 `ChiefInfo` 类型把它声明成了 `string`。不 `?? ''` 的话
    // `text.length` 直接抛 `Cannot read properties of null (reading 'length')`，
    // 整个 `/settings/chief` 页白屏。类型与真实响应不一致是这个 bug 的根因，
    // 类型已在 ChiefInfo 处改正为 `string | null`，这里做运行时兜底。
    setText(chief.charter ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chief.updatedAt]);

  const over = text.length > CHARTER_MAX;
  // `chief.charter` 可能是 null（见上方注释），比较时统一按 '' 处理，
  // 否则 null !== '' 会让「没改过」也显示成已修改。
  const dirty = text !== (chief.charter ?? '');

  const save = async () => {
    setSaving(true);
    setError(null);
    setOk(false);
    try {
      const res = await fetch(
        `/api/teams/${encodeURIComponent(teamId)}/chief/charter`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ userId, charter: text }),
        },
      );
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null;
      if (!res.ok || !body?.ok) {
        setError(body?.error ?? `http-${res.status}`);
      } else {
        setOk(true);
        await onSaved();
      }
    } catch (err) {
      setError(err instanceof Error ? err.name : 'unknown');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section style={sectionStyle}>
      <h3 style={h3Style}>Charter</h3>
      <div style={metaStyle}>
        Agent：<strong>{chief.agentName ?? chief.agentId}</strong>
        {' · '}
        最后更新：{formatTime(chief.updatedAt)}
      </div>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOk(false);
        }}
        rows={10}
        style={{
          ...textareaStyle,
          borderColor: over ? C.danger : C.line,
        }}
      />
      <div style={counterRowStyle}>
        <span style={{ color: over ? C.danger : C.textDim, fontSize: T.sm }}>
          {text.length} / {CHARTER_MAX}
        </span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {error && <span style={{ color: C.danger, fontSize: T.sm }}>{error}</span>}
          {ok && !error && <span style={{ color: C.ok, fontSize: T.sm }}>已保存</span>}
          <button
            type="button"
            disabled={saving || !dirty || over}
            onClick={save}
            style={{
              ...primaryBtn,
              opacity: saving || !dirty || over ? 0.5 : 1,
              cursor: saving || !dirty || over ? 'not-allowed' : 'pointer',
            }}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </section>
  );
}

// ── Topic 区块 ─────────────────────────────────────────────────────

function ThreadsPanel({
  teamId,
  userId,
  onOpenThread,
}: {
  teamId: string;
  userId: string;
  onOpenThread: (id: string) => void;
}): React.JSX.Element {
  const [threads, setThreads] = useState<ChiefThread[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 创建表单
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newMsg, setNewMsg] = useState('');
  const [createErr, setCreateErr] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/teams/${encodeURIComponent(teamId)}/chief/threads`,
        { cache: 'no-store' },
      );
      const body = (await res.json().catch(() => null)) as
        | { ready?: boolean; data?: ChiefThread[]; reason?: string }
        | null;
      if (!body?.ready) {
        setThreads(null);
        setError(`数据未就绪：${body?.reason ?? 'unknown'}`);
      } else {
        setThreads(body.data ?? []);
      }
    } catch (err) {
      setThreads(null);
      setError(err instanceof Error ? err.name : 'unknown');
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = async () => {
    setCreating(true);
    setCreateErr(null);
    try {
      const res = await fetch(
        `/api/teams/${encodeURIComponent(teamId)}/chief/threads`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            userId,
            title: newTitle.trim(),
            initialMessage: newMsg.trim() ? newMsg.trim() : null,
          }),
        },
      );
      const body = (await res.json().catch(() => null)) as
        | { id?: string; error?: string }
        | null;
      if (!res.ok || !body?.id) {
        setCreateErr(body?.error ?? `http-${res.status}`);
      } else {
        const newThreadId = body.id;
        setNewTitle('');
        setNewMsg('');
        await reload();
        // 直接跳进新 topic，避免再点一次
        onOpenThread(newThreadId);
      }
    } catch (err) {
      setCreateErr(err instanceof Error ? err.name : 'unknown');
    } finally {
      setCreating(false);
    }
  };

  return (
    <section style={sectionStyle}>
      <h3 style={h3Style}>Topics</h3>
      <p style={hintStyle}>每个 topic 是与 Chief 的一次对话。最多 50 条 / 团队。</p>

      <div style={createBoxStyle}>
        <input
          type="text"
          placeholder="Topic 标题"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          maxLength={280}
          style={inputStyle}
        />
        <textarea
          placeholder="首条消息（可选，留空不进对话）"
          value={newMsg}
          onChange={(e) => setNewMsg(e.target.value)}
          maxLength={8000}
          rows={2}
          style={{ ...textareaStyle, minHeight: 60 }}
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
          {createErr && <span style={{ color: C.danger, fontSize: T.sm }}>{createErr}</span>}
          <button
            type="button"
            disabled={creating || !newTitle.trim()}
            onClick={create}
            style={{
              ...primaryBtn,
              marginLeft: 'auto',
              opacity: creating || !newTitle.trim() ? 0.5 : 1,
              cursor: creating || !newTitle.trim() ? 'not-allowed' : 'pointer',
            }}
          >
            {creating ? '创建中…' : '新建 topic'}
          </button>
        </div>
      </div>

      {loading && <div style={mutedStyle}>读取中…</div>}
      {!loading && error && <div style={mutedStyle}>{error}</div>}
      {!loading && !error && threads && threads.length === 0 && (
        <div style={mutedStyle}>还没有 topic。新建一条开始与 Chief 对话。</div>
      )}
      {!loading && !error && threads && threads.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {threads.map((t) => (
            <Link
              key={t.id}
              href={`/settings/chief/${t.id}`}
              style={threadRowStyle}
            >
              <div style={{ fontWeight: 600, fontSize: T.body }}>{t.title}</div>
              <div style={metaStyle}>
                关注 {t.watchedTodos.length} 个 todo ·{' '}
                {t.lastTurnAt ? `最后发言 ${formatTime(t.lastTurnAt)}` : '尚未发言'}
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

// ── 工具面区块 ────────────────────────────────────────────────────

function ToolsPanel(): React.JSX.Element {
  const [tools, setTools] = useState<ChiefTool[] | null>(null);
  const [count, setCount] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch('/api/chief/tools', { cache: 'no-store' });
        const body = (await res.json().catch(() => null)) as
          | { ready?: boolean; data?: { tools?: ChiefTool[]; count?: number }; reason?: string }
          | null;
        if (!alive) return;
        if (!body?.ready) {
          setError(`数据未就绪：${body?.reason ?? 'unknown'}`);
          return;
        }
        setTools(body.data?.tools ?? []);
        setCount(body.data?.count ?? 0);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.name : 'unknown');
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <section style={sectionStyle}>
      <h3 style={h3Style}>工具面</h3>
      <p style={hintStyle}>
        Chief 声明的 {count} 个工具。
        <strong style={{ color: C.textDim }}>wired = true</strong> 表示已接线；
        <strong style={{ color: C.textFaint }}> wired = false</strong>（标灰行）
        是「真缺口」—— 设计里要装但当前没装。
      </p>
      {error && <div style={mutedStyle}>{error}</div>}
      {tools && (
        <div style={{ overflowX: 'auto' }}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>名称</th>
                <th style={thStyle}>分组</th>
                <th style={thStyle}>说明</th>
                <th style={thStyle}>不可逆</th>
                <th style={thStyle}>需 admin</th>
                <th style={thStyle}>持密</th>
                <th style={thStyle}>接线</th>
              </tr>
            </thead>
            <tbody>
              {tools.map((t) => (
                <tr key={t.name} style={t.wired ? rowNormal : rowDim}>
                  <td style={tdStyle}>
                    <code>{t.name}</code>
                  </td>
                  <td style={tdStyle}>{TOOL_GROUPS[t.group] ?? t.group}</td>
                  <td style={tdStyle}>{t.summary}</td>
                  <td style={tdStyle}>{t.irreversible ? '是' : ''}</td>
                  <td style={tdStyle}>{t.needsAdminGrant ? '是' : ''}</td>
                  <td style={tdStyle}>{t.handlesSecret ? '是' : ''}</td>
                  <td style={tdStyle}>
                    {t.wired ? (
                      <span style={{ color: C.ok }}>已接线</span>
                    ) : (
                      <span style={{ color: C.textFaint }}>未接线</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ── 工具 ──────────────────────────────────────────────────────────

function formatTime(ms: number | null): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

// ── 样式 ──────────────────────────────────────────────────────────

const h2Style: CSSProperties = { fontSize: T.h2, margin: '0 0 4px', fontWeight: 600, color: C.text };
const h3Style: CSSProperties = { fontSize: T.h3, margin: '0 0 8px', fontWeight: 600, color: C.text };
const hintStyle: CSSProperties = { color: C.textDim, fontSize: T.meta, margin: '0 0 12px', lineHeight: 1.5 };
const sectionStyle: CSSProperties = { ...shared.card, marginBottom: S.lg };
const metaStyle: CSSProperties = { color: C.textDim, fontSize: T.sm, marginTop: 4 };
const textareaStyle: CSSProperties = {
  ...shared.input,
  width: '100%',
  padding: S.md,
  marginTop: 8,
  resize: 'vertical',
  minHeight: 140,
  boxSizing: 'border-box',
  fontFamily: F.sans,
};
const counterRowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginTop: 6,
};
const primaryBtn: CSSProperties = shared.primaryBtn;
const inputStyle: CSSProperties = shared.input;
const createBoxStyle: CSSProperties = { ...shared.placeholderBox, marginBottom: S.md };
const threadRowStyle: CSSProperties = {
  display: 'block',
  ...shared.card,
  marginBottom: 6,
  textDecoration: 'none',
  color: C.text,
};
const tableStyle: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: T.meta,
};
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
const rowNormal: CSSProperties = {};
const rowDim: CSSProperties = { opacity: 0.55 };
const placeholderStyle: CSSProperties = shared.placeholderBox;
const noticeStyle: CSSProperties = { ...shared.noticeBox, padding: S.lg, fontSize: T.body };
const mutedStyle: CSSProperties = { color: C.textFaint, fontSize: T.meta, padding: `${S.md}px 0` };
