'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CSSProperties } from 'react';
import { C, F, R, S, T } from '@/lib/design-tokens';
import { useTeamContext } from '@/lib/team-context';
import { PHASE_COLUMNS, type Todo } from '@/lib/api';

/**
 * 全局搜索面板（⌘K）。
 *
 * **实测依据**：`recon-live/DESIGN-TOKENS.md` 的侧栏结构里，原站在侧栏顶部有
 * `Search  ⌘K`，且 `features.txt` 写明「⌘K searches todos, topics, projects,
 * agents, and skills；⌘P jumps to a todo and ⌘J to a topic」。
 *
 * **范围与取舍**：这一版搜 todos + topics（两者的数据源都已就绪：看板列表与
 * `/chief/threads`），**没有**把 projects/agents/skills 一起塞进来 ——
 * 那需要再发 4 个请求并做归并，而那两个快捷键（⌘P/⌘J）原站是分开的行为。
 * 先把主路径做对（能搜到东西、键盘能操作、Esc 能退），比做半套聚合有价值。
 * 范围写在界面上，不假装是全量。
 */

interface Hit {
  kind: 'todo' | 'topic';
  label: string;
  hint: string;
  href: string;
}

export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): React.JSX.Element | null {
  const router = useRouter();
  const { activeTeam } = useTeamContext();
  const [q, setQ] = useState('');
  const [todos, setTodos] = useState<Todo[]>([]);
  const [topics, setTopics] = useState<Array<{ id: string; title: string }>>([]);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 打开时才拉数据 —— 关闭时不必保持同步，省一次请求
  useEffect(() => {
    if (!open || !activeTeam) return;
    let alive = true;
    void (async () => {
      const [t, th] = await Promise.all([
        fetch('/api/todos', { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
        fetch(`/api/teams/${encodeURIComponent(activeTeam.teamId)}/chief/threads`, { cache: 'no-store' })
          .then((r) => r.json()).catch(() => null),
      ]);
      if (!alive) return;
      setTodos(Array.isArray(t?.data) ? t.data : []);
      setTopics(Array.isArray(th?.data) ? th.data : []);
    })();
    return () => {
      alive = false;
    };
  }, [open, activeTeam]);

  useEffect(() => {
    if (open) {
      setQ('');
      setCursor(0);
      // 等渲染出来再聚焦，否则还没挂上
      const id = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [open]);

  const hits = useMemo<Hit[]>(() => {
    const needle = q.trim().toLowerCase();
    const out: Hit[] = [];
    for (const t of todos) {
      if (!needle || t.title.toLowerCase().includes(needle)) {
        const col = PHASE_COLUMNS.find((c) => c.phase === t.phase);
        out.push({
          kind: 'todo',
          label: t.title,
          hint: `#${t.seqNum} · ${col?.label ?? t.phase}`,
          href: `/todo/${t.id}`,
        });
      }
    }
    for (const th of topics) {
      if (!needle || th.title.toLowerCase().includes(needle)) {
        out.push({ kind: 'topic', label: th.title, hint: 'topic', href: `/settings/chief/${th.id}` });
      }
    }
    return out.slice(0, 30);
  }, [q, todos, topics]);

  if (!open) return null;

  const go = (h: Hit) => {
    onClose();
    router.push(h.href);
  };

  return (
    <div style={overlayStyle} onClick={onClose} role="presentation">
      <div
        style={panelStyle}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="搜索"
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, hits.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const h = hits[cursor];
              if (h) go(h);
            }
          }}
          placeholder="搜索 todos 与 topics…"
          style={inputStyle}
        />
        <div style={listStyle}>
          {hits.length === 0 ? (
            <div style={emptyStyle}>
              {q ? `没有匹配「${q}」的结果` : '输入关键词开始搜索'}
            </div>
          ) : (
            hits.map((h, i) => (
              <button
                key={h.href}
                type="button"
                onClick={() => go(h)}
                onMouseEnter={() => setCursor(i)}
                style={{
                  ...rowStyle,
                  background: i === cursor ? C.surfaceHi : 'transparent',
                }}
              >
                <span style={kindStyle}>{h.kind === 'todo' ? 'TASK' : 'TOPIC'}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {h.label}
                </span>
                <span style={hintStyle}>{h.hint}</span>
              </button>
            ))
          )}
        </div>
        <div style={footerStyle}>
          <span>↑↓ 选择</span>
          <span>↵ 打开</span>
          <span>Esc 关闭</span>
          <span style={{ flex: 1 }} />
          <span>当前只搜 todos 与 topics</span>
        </div>
      </div>
    </div>
  );
}

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 100,
  background: 'rgba(0,0,0,0.6)',
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  paddingTop: '12vh',
};

const panelStyle: CSSProperties = {
  width: 'min(640px, 92vw)',
  background: C.surface,
  border: `1px solid ${C.lineStrong}`,
  borderRadius: '12px',
  overflow: 'hidden',
  boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
};

const inputStyle: CSSProperties = {
  width: '100%',
  background: 'transparent',
  border: 'none',
  borderBottom: `1px solid ${C.line}`,
  color: C.text,
  fontSize: '16px',
  fontFamily: F.sans,
  padding: '14px 16px',
  outline: 'none',
};

const listStyle: CSSProperties = { maxHeight: '50vh', overflowY: 'auto', padding: `${S.xs}px 0` };

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: S.md,
  width: '100%',
  padding: `${S.sm}px ${S.lg}px`,
  border: 'none',
  color: C.text,
  fontSize: T.body,
  fontFamily: F.sans,
  textAlign: 'left',
  cursor: 'pointer',
};

const kindStyle: CSSProperties = {
  fontFamily: F.mono,
  fontSize: '10px',
  color: C.textGhost,
  border: `1px solid ${C.lineStrong}`,
  borderRadius: R.sm,
  padding: '1px 4px',
  flex: '0 0 auto',
};

const hintStyle: CSSProperties = { color: C.textGhost, fontSize: T.base, flex: '0 0 auto' };

const emptyStyle: CSSProperties = { padding: S.lg, color: C.textFaint, fontSize: T.meta, textAlign: 'center' };

const footerStyle: CSSProperties = {
  display: 'flex',
  gap: S.lg,
  padding: `${S.sm}px ${S.lg}px`,
  borderTop: `1px solid ${C.line}`,
  color: C.textGhost,
  fontSize: T.sm,
};
