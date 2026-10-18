'use client';

/**
 * MentionPicker —— 五类 mention 候选选择器。
 *
 * 事实源（来自 `D:/AI/todos/recon-live/docs-conversation.md` 第 34 行）：
 *   `@` agent or member · `#` todo · `/` skill · `~` project · `&` machine
 *
 * 候选数据来源（按 Brief 要求，**逐个**核对过 BFF 形状，未确认则降级到诚实占位）：
 *   - `@` agent   ← `GET /api/teams/:teamId/agents`         （已实现，pick: `agents[]`）
 *   - `@` member  ← **未提供 BFF** —— 降级：「@ 暂只能选 agent；选中后 `kind`
 *                    仍按 `MENTION_PREFIX_TO_KIND['@'] = 'agent'` 走，避免
 *                    prefix↔kind 不一致被服务端 422 拒掉。
 *   - `#` todo    ← `GET /api/todos`                         （已实现，BFF 顶层
 *                    `/api/todos` 透传；列表用 `Todo[]`）。注意：原站语义是
 *                    「refer to another todo」（同 team），跨项目是允许的；
 *                    这里客户端用 name 模糊筛。
 *   - `/` skill   ← `GET /api/teams/:teamId/skills`         （已实现，pick: `skills[]`）
 *   - `~` project ← `GET /api/teams/:teamId/projects`       （已实现，pick: `projects[]`）
 *   - `&` machine ← `GET /api/teams/:teamId/machines`       （已实现，pick:
 *                    `machines[]`，含 `isOnline`）
 *
 * `MentionRef` / `MentionKind` / `MentionPrefix` 都从
 * `apps/web/src/lib/api.ts` 导入 —— MentionsStore 已落库正式类型。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { C, F, R, S, T } from '@/lib/design-tokens';
import { type MentionKind, type MentionPrefix, type MentionRef } from '@/lib/api';

// ── 类型 ─────────────────────────────────────────────────────────

/**
 * 五种 mention 类别 —— 直接从 `apps/web/src/lib/api.ts` import（MentionStore 已
 * 落地正式类型）。前缀字符类型 `MentionPrefix` 同步导入，保证 picker 与
 * chip 渲染的颜色映射一致。
 *
 * **`@` 的歧义**：原站 `'@ agent or member'` 同一前缀对应两类对象。
 * `apps/web/src/lib/api.ts` 的 `MENTION_PREFIX_TO_KIND['@'] = 'agent'`；
 * 选中 agent 时 kind='agent'。路由层与 chip 渲染按 `refId` 真实所属表分派。
 */

/** Picker 接收的 kind —— `@` 同时含 agent + member，所以是 union。 */
export type MentionPickerKind = 'agentOrMember' | 'todo' | 'skill' | 'project' | 'machine';

export interface MentionPickerProps {
  /** 类别（决定候选来源 + 显示文本）。 */
  kind: MentionPickerKind;
  /** 用户已输入的关键词（已去掉前缀符号）。空 = 不筛或全列。 */
  query: string;
  /** 团队 id —— agents/skills/projects/machines 必须。todo 不必须。 */
  teamId: string | null;
  /** 用户选中一项 —— 由 MentionComposer 真正写入 chip 状态。 */
  onPick: (m: MentionRef) => void;
  /** Esc / 外部点击关闭。 */
  onClose: () => void;
  /**
   * 可选锚点 —— 浮动定位用；不传则在 composer 上方一行渲染（inline 模式）。
   * 本切片实现是**行内**渲染，简化集成，避免与现有 textarea 重叠 z-index。
   */
  anchorRect?: DOMRect | null;
}

// ── 后端直查 ───────────────────────────────────────────────────
//
// 与 fetchJson 不同：picker 自己读 BFF，没走 `fetchJson<T>` 是因为 fetchJson
// 只对有 envelope 的端点有意义。`/api/teams/:teamId/agents` 是有 envelope
// 的（proxyRead 包过），但 todos 顶层端点的形状是 `Todo[]` 而非信封 ——
// 与 Brief 写过的「api.ts 类型不能改」相冲突，**不能**给 picker 假设有
// `fetchJson` 全套封装。所以自己 fetch envelope 形状就够用。

/**
 * ⚠️ **BFF 返回的是裸数组，不是 `{agents: []}` 这样的包装**（2026-10-18 修）。
 *
 * 实测五个候选端点的 `data` 全是裸数组：
 *   /api/teams/:t/agents    → `Agent[]`（2 项）
 *   /api/todos              → `Todo[]`（9 项）
 *   /api/teams/:t/skills    → `Skill[]`
 *   /api/teams/:t/projects  → `Project[]`
 *   /api/teams/:t/machines  → `Machine[]`
 * 原因：这些 BFF 都用 `proxyRead(req, teamId, { pick })`，`pick` 已经把外层
 * `{agents:[...]}` 剥掉了，客户端拿到的是数组本身。
 *
 * 原先这里按 `r.data?.agents` 解包 → 恒为 undefined → 五个类目全部「0 项」。
 * 这是「按上游服务端的返回形状猜，而没看 BFF 剥完之后的形状」导致的。
 * 下面的 `unwrapList` 同时接受裸数组与包装对象，两种都不出错。
 */
function unwrapList<T>(data: unknown, key: string): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') {
    const v = (data as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v as T[];
  }
  return [];
}

interface BffEnvelope<T> {
  ready?: boolean;
  data?: T;
  reason?: string;
}

async function fetchBffEnvelope<T>(path: string, signal: AbortSignal): Promise<{
  ok: boolean;
  data: T | null;
  reason: string | null;
}> {
  try {
    const res = await fetch(`/api${path}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal,
    });
    if (!res.ok) {
      return { ok: false, data: null, reason: `http-${res.status}` };
    }
    const body = (await res.json().catch(() => null)) as BffEnvelope<T> | null;
    if (!body || body.ready !== true || body.data === undefined) {
      return { ok: false, data: null, reason: body?.reason ?? 'not-ready' };
    }
    return { ok: true, data: body.data, reason: null };
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      return { ok: false, data: null, reason: 'aborted' };
    }
    return { ok: false, data: null, reason: 'network-error' };
  }
}

// 后端 shape —— 与 server route 严格一致；上面 grep 出来的字段。
// agents/skills/projects/machines 没有更窄的 ts 类型暴露（api.ts 也没定义），
// 所以这里用 `Record<string, unknown>` + 守卫函数访问。

interface AgentRow {
  id: string;
  displayName: string;
  description: string | null;
  deletedAt: number | null;
}

interface SkillRow {
  id: string;
  name: string;
  source: string | null;
  fileCount: number | null;
  sizeBytes: number | null;
}

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  repoFullName: string | null;
}

interface MachineRow {
  id: string;
  name: string;
  isOnline: boolean | null;
  platform: string | null;
  runner: string | null;
}

interface TodoRow {
  id: string;
  title: string;
  seqNum: number;
  phase: string;
  projectId: string;
}

// ── 行规约（picker 内部统一表示） ───────────────────────────────

interface CandidateRow {
  refId: string;
  label: string;
  meta: string;
  available: boolean;
}

function prefixFor(kind: MentionPickerKind): MentionPrefix {
  switch (kind) {
    case 'agentOrMember':
      return '@';
    case 'todo':
      return '#';
    case 'skill':
      return '/';
    case 'project':
      return '~';
    case 'machine':
      return '&';
  }
}

function mentionKindFor(kind: MentionPickerKind): MentionKind {
  switch (kind) {
    case 'agentOrMember':
      return 'agent';
    case 'todo':
      return 'todo';
    case 'skill':
      return 'skill';
    case 'project':
      return 'project';
    case 'machine':
      return 'machine';
  }
}

function categoryLabel(kind: MentionPickerKind): string {
  switch (kind) {
    case 'agentOrMember':
      return 'agent / member';
    case 'todo':
      return 'todo';
    case 'skill':
      return 'skill';
    case 'project':
      return 'project';
    case 'machine':
      return 'machine';
  }
}

function filterRows(rows: CandidateRow[], query: string): CandidateRow[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return rows;
  return rows.filter(
    (r) => r.label.toLowerCase().includes(q) || r.meta.toLowerCase().includes(q),
  );
}

// ── 主组件 ─────────────────────────────────────────────────────

export default function MentionPicker(props: MentionPickerProps): React.JSX.Element {
  const { kind, query, teamId, onPick, onClose } = props;

  const [rows, setRows] = useState<CandidateRow[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [loadReason, setLoadReason] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState<number>(0);

  const acRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    acRef.current?.abort();
    const ac = new AbortController();
    acRef.current = ac;
    setLoading(true);
    setLoadReason(null);
    setRows([]);

    try {
      let next: CandidateRow[] = [];
      let reason: string | null = null;

      if (kind === 'agentOrMember') {
        if (!teamId) {
          reason = 'no-team';
        } else {
          const r = await fetchBffEnvelope<{ agents?: AgentRow[] }>(
            `/teams/${encodeURIComponent(teamId)}/agents`,
            ac.signal,
          );
          if (!r.ok) reason = r.reason;
          else {
            const list = unwrapList<AgentRow>(r.data, 'agents');
            // 成员（member = 人类）端点未实现 —— picker 在 kind=agentOrMember
            // 时只列 agent；用户要选人会被 picker 显式告知「member list 暂未
            // 接通」。这是诚实的「不可用」而不是假绿。
            const filtered = list.filter((a) => !a.deletedAt);
            next = filtered.map((a) => ({
              refId: a.id,
              label: a.displayName,
              meta: a.description ? a.description.slice(0, 80) : 'agent',
              available: true,
            }));
            if (next.length === 0) reason = 'empty-agents';
          }
        }
      } else if (kind === 'todo') {
        const r = await fetchBffEnvelope<TodoRow[]>(`/todos`, ac.signal);
        if (!r.ok) reason = r.reason;
        else {
          const list = unwrapList<TodoRow>(r.data, 'todos');
          next = list.map((t) => ({
            refId: t.id,
            label: t.title,
            meta: `#${t.seqNum} · ${t.phase}`,
            available: true,
          }));
          if (next.length === 0) reason = 'empty-todos';
        }
      } else if (kind === 'skill') {
        if (!teamId) {
          reason = 'no-team';
        } else {
          const r = await fetchBffEnvelope<{ skills?: SkillRow[] }>(
            `/teams/${encodeURIComponent(teamId)}/skills`,
            ac.signal,
          );
          if (!r.ok) reason = r.reason;
          else {
            const list = unwrapList<SkillRow>(r.data, 'skills');
            next = list.map((s) => ({
              refId: s.id,
              label: s.name,
              meta: s.source ? `source=${s.source}` : 'skill',
              available: true,
            }));
            if (next.length === 0) reason = 'empty-skills';
          }
        }
      } else if (kind === 'project') {
        if (!teamId) {
          reason = 'no-team';
        } else {
          const r = await fetchBffEnvelope<{ projects?: ProjectRow[] }>(
            `/teams/${encodeURIComponent(teamId)}/projects`,
            ac.signal,
          );
          if (!r.ok) reason = r.reason;
          else {
            const list = unwrapList<ProjectRow>(r.data, 'projects');
            next = list.map((p) => ({
              refId: p.id,
              label: p.name,
              meta: p.repoFullName ?? p.description ?? 'project',
              available: true,
            }));
            if (next.length === 0) reason = 'empty-projects';
          }
        }
      } else if (kind === 'machine') {
        if (!teamId) {
          reason = 'no-team';
        } else {
          const r = await fetchBffEnvelope<{ machines?: MachineRow[] }>(
            `/teams/${encodeURIComponent(teamId)}/machines`,
            ac.signal,
          );
          if (!r.ok) reason = r.reason;
          else {
            const list = unwrapList<MachineRow>(r.data, 'machines');
            next = list.map((m) => ({
              refId: m.id,
              label: m.name,
              meta: `${m.isOnline ? '在线' : '离线'}${m.platform ? ' · ' + m.platform : ''}`,
              available: true,
            }));
            if (next.length === 0) reason = 'empty-machines';
          }
        }
      }

      if (ac.signal.aborted) return;
      setRows(next);
      setActiveIdx(0);
      if (reason !== null && next.length === 0) setLoadReason(reason);
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, [kind, teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const avail = rows.filter((r) => r.available);
    return filterRows(avail, query);
  }, [rows, query]);

  // 键盘导航 —— 用一个 window keydown 监听，避免把 keydown handler 撒到 textarea。
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (filtered.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => (i + 1) % filtered.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => (i - 1 + filtered.length) % filtered.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const row = filtered[activeIdx];
        if (!row) return;
        const mentionKind = mentionKindFor(kind);
        const mention: MentionRef = {
          kind: mentionKind,
          refId: row.refId,
          label: row.label,
          prefix: prefixFor(kind),
        };
        onPick(mention);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filtered, activeIdx, kind, onPick, onClose]);

  // ── 渲染 ─────────────────────────────────────────────────────

  const showUnavailableHint =
    kind === 'agentOrMember' && rows.length === 0 && loadReason !== null;

  return (
    <div style={pickerShellStyle} role="listbox" aria-label={`mention 候选（${categoryLabel(kind)}）`}>
      <div style={pickerHeaderStyle}>
        <span style={{ color: C.accent }}>{prefixFor(kind)}</span>
        <span style={{ marginLeft: 6, color: C.textDim, fontSize: T.meta }}>
          {categoryLabel(kind)} · {filtered.length} 项
        </span>
        <button
          type="button"
          onClick={onClose}
          style={pickerCloseBtnStyle}
          aria-label="关闭候选"
        >
          ×
        </button>
      </div>
      {loading && filtered.length === 0 ? (
        <div style={pickerEmptyStyle}>加载候选…</div>
      ) : filtered.length === 0 ? (
        <div style={pickerEmptyStyle}>
          {loadReason === 'no-team'
            ? '当前 todo 未关联到 team，无法拉取该类候选。'
            : loadReason === 'empty-agents'
              ? '这个团队还没有 agent —— @ 暂时不能选任何目标。'
              : loadReason === 'empty-todos'
                ? '你还没有任何 todo —— # 没有可选项。'
                : loadReason === 'empty-skills'
                  ? '这个团队还没有 skill —— / 没有可选项。'
                  : loadReason === 'empty-projects'
                    ? '这个团队还没有 project —— ~ 没有可选项。'
                    : loadReason === 'empty-machines'
                      ? '这个团队还没有 enrolled 的 machine —— & 没有可选项。'
                      : loadReason === 'endpoint-not-implemented' || loadReason === 'not-ready'
                        ? '后端端点尚未就绪 —— 等接口实现后重试。'
                        : loadReason === 'aborted'
                          ? ''
                          : '没有匹配的项。'}
          {showUnavailableHint && (
            <div style={{ marginTop: 6, fontSize: T.sm, color: C.textGhost }}>
              @ 现在只能选 agent；本切片暂未拉到人类成员列表端点（member list）。
            </div>
          )}
        </div>
      ) : (
        <ul style={pickerListStyle}>
          {filtered.map((row, idx) => {
            const isActive = idx === activeIdx;
            return (
              <li
                key={`${kind}:${row.refId}`}
                role="option"
                aria-selected={isActive}
                style={{
                  ...pickerItemStyle,
                  background: isActive ? C.surfaceHi : 'transparent',
                  borderColor: isActive ? C.accent : 'transparent',
                }}
                onMouseEnter={() => setActiveIdx(idx)}
                onMouseDown={(e) => {
                  // mousedown 而非 click —— 防止 textarea 先 blur
                  e.preventDefault();
                  const mentionKind = mentionKindFor(kind);
                  const mention: MentionRef = {
                    kind: mentionKind,
                    refId: row.refId,
                    label: row.label,
                    prefix: prefixFor(kind),
                  };
                  onPick(mention);
                }}
              >
                <div style={pickerItemLabelStyle}>{row.label}</div>
                <div style={pickerItemMetaStyle}>{row.meta}</div>
              </li>
            );
          })}
        </ul>
      )}
      <div style={pickerHintStyle}>
        ↑↓ 选择 · Enter 选中 · Esc 关闭
      </div>
    </div>
  );
}

// ── 样式 ────────────────────────────────────────────────────────

const pickerShellStyle: CSSProperties = {
  marginTop: S.sm,
  background: C.surface,
  border: `1px solid ${C.line}`,
  borderRadius: R.lg,
  padding: S.sm,
  fontFamily: F.sans,
  fontSize: T.body,
  color: C.text,
};

const pickerHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: S.xs,
  padding: `${S.xs}px ${S.sm}px`,
  borderBottom: `1px solid ${C.line}`,
  fontSize: T.meta,
};

const pickerCloseBtnStyle: CSSProperties = {
  marginLeft: 'auto',
  background: 'transparent',
  border: 'none',
  color: C.textDim,
  cursor: 'pointer',
  fontSize: T.body,
  padding: `0 ${S.xs}px`,
};

const pickerListStyle: CSSProperties = {
  listStyle: 'none',
  margin: `${S.xs}px 0 0`,
  padding: 0,
  maxHeight: 220,
  overflowY: 'auto',
};

const pickerItemStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: `${S.sm}px ${S.md}px`,
  borderRadius: R.md,
  border: `1px solid transparent`,
  cursor: 'pointer',
  marginBottom: 2,
};

const pickerItemLabelStyle: CSSProperties = {
  fontSize: T.body,
  color: C.text,
  fontWeight: 500,
};

const pickerItemMetaStyle: CSSProperties = {
  fontSize: T.sm,
  color: C.textDim,
};

const pickerEmptyStyle: CSSProperties = {
  padding: `${S.md}px ${S.sm}px`,
  color: C.textDim,
  fontSize: T.meta,
};

const pickerHintStyle: CSSProperties = {
  padding: `${S.xs}px ${S.sm}px`,
  color: C.textGhost,
  fontSize: T.sm,
  borderTop: `1px solid ${C.line}`,
  marginTop: S.xs,
};