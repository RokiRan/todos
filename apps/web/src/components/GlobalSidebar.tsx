'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { CSSProperties } from 'react';
import { C, F, L, R, S, T, shared } from '@/lib/design-tokens';
import { useTeamContext } from '@/lib/team-context';

/**
 * 全局侧栏 —— 对齐原站实测结构（`recon-live/DESIGN-TOKENS.md`）。
 *
 * **实测的原站侧栏**（240px / `#18181b`）：
 * ```
 * [todos]                     ← logo，jetbrainsMono 14/500
 * Avery's team  PRO           ← 团队切换
 * Search              ⌘K      ← 全局搜索
 * New task             N
 * ───────────────────────────
 * Workspace            1      ← 折叠组 + 计数
 * New topic
 *   News briefing              ← 我的 topics（Chief 对话主题）
 *   Daily report
 * ───────────────────────────
 * Schedules / Connections / Skills / Usage / Projects
 * ───────────────────────────
 * Resources
 * ```
 *
 * **为什么这次是全局的而不是设置区专用**：原站侧栏**常驻整个应用**（看板/对话/设置都在它右边）。
 * 此前复刻只有 settings 下有一个 220px 白底面板，看板页完全裸奔 —— 于是从看板点不到任何设置，
 * 页面之间也没有统一的「我在哪」。这一层是全局导航的骨架。
 *
 * **为什么 topics 从 `/api/teams/{t}/chief/threads` 来**：原站的 sidebar 里那些
 * 「News briefing / Daily report」就是 Chief 的对话主题（features.txt：
 * 「separate goals move forward in parallel topics」）。复刻的 Chief topics 已在服务端，
 * 直接复用，不再另造概念。
 */

interface NavEntry {
  href: string;
  label: string;
  /** 原站侧栏有 ⌘K / N 这样的快捷键提示（实测） */
  shortcut?: string;
  /**
   * 副标题（小字）—— 用于区分同 label 不同语义的两个入口，例如
   * 「Connections」= 自定义连接 vs 「应用目录」= Catalog 提供的官方应用。
   * 不填就不渲染；不是「快捷键提示」那种常态字段，所以放在末尾。
   */
  hint?: string;
}

const PRIMARY: NavEntry[] = [
  { href: '/', label: '看板' },
  { href: '/agents', label: 'Agents' },
];

const TEAM: NavEntry[] = [
  { href: '/settings/projects', label: 'Projects' },
  { href: '/settings/schedules', label: 'Schedules' },
  // 「Connections」= 自定义连接 CRUD（settings/mcp-servers），保留原样。
  { href: '/settings/mcp-servers', label: 'Connections' },
  // 「应用目录」= Catalog 提供的官方应用（settings/connections）。
  // 与上面那条同名不同义，加 hint 区分；不改 label 文案以保持用户习惯。
  { href: '/settings/connections', label: '应用目录', hint: '官方应用' },
  { href: '/settings/skills', label: 'Skills' },
  { href: '/settings/providers', label: 'Providers' },
  { href: '/settings/secrets', label: 'Secrets' },
];

const RESOURCE: NavEntry[] = [
  // 「Machines」= 团队级机器管理页（第一批交付，docs-machines.md）。
  // 凭据与机器在原站 docs-overview.md 里都归 Resources 组，所以放这里。
  { href: '/settings/machines', label: 'Machines' },
  { href: '/settings/chief', label: 'Chief' },
  { href: '/settings/api-keys', label: 'API keys' },
];

export function GlobalSidebar({
  onSearch,
  collapsed: collapsedProp,
  onCollapsedChange,
}: {
  onSearch?: () => void;
  /**
   * 侧栏外壳折叠态（受控）。`undefined` 时组件走内部 state；
   * 有值时**优先**用 prop，所有折叠交互都通过 `onCollapsedChange` 通知父级。
   * 父级不传 callback 时退化为内部 state —— 两条路径行为等价。
   *
   * 与「Workspace」组内的 `topicsCollapsed`（topics 子列表折叠）是两个独立开关，
   * 不要混用 —— 后者只影响 Chief topics 子列表是否渲染。
   */
  collapsed?: boolean;
  onCollapsedChange?: (next: boolean) => void;
}): React.JSX.Element | null {
  const { ctx, activeTeam } = useTeamContext();
  const pathname = usePathname();
  const [topics, setTopics] = useState<Array<{ id: string; title: string }>>([]);
  // 内部 state —— 受控 prop 缺席时承担折叠态；存在时仅作 fallback，
  // 真正读到的折叠态见下 `collapsedEffective`。
  const [collapsedInternal, setCollapsedInternal] = useState(false);
  const isControlled = collapsedProp !== undefined;
  const collapsedEffective = isControlled ? collapsedProp : collapsedInternal;
  const toggleCollapsed = useCallback(
    (next: boolean) => {
      // 受控：通知父级；父级不关心（无 callback）→ 同步内部 state 避免
      // UI 看似不响应。非受控：动内部 state。
      if (onCollapsedChange) onCollapsedChange(next);
      if (!isControlled || !onCollapsedChange) setCollapsedInternal(next);
    },
    [isControlled, onCollapsedChange],
  );
  // 「Workspace」组内 topics 列表的折叠态 —— 与侧栏折叠（上面那个）是
  // 独立的两个开关。前者缩进只影响 Chief topics 子列表的可见性。
  const [topicsCollapsed, setTopicsCollapsed] = useState(false);
  // 角标：当前用户的 Needs-you 待决数。失败/null → 不显示角标
  // （不能因为接口失败就在侧栏画个错的数字）。
  const [needsCount, setNeedsCount] = useState<number | null>(null);

  // Chief topics（= 原站侧栏里那串 topic 名）。失败就空着 —— 侧栏不该因为
  // 一个列表接口挂了就整条消失。
  useEffect(() => {
    if (!activeTeam) return;
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(`/api/teams/${encodeURIComponent(activeTeam.teamId)}/chief/threads`, {
          cache: 'no-store',
        });
        const body = (await res.json().catch(() => null)) as { ready?: boolean; data?: Array<{ id: string; title: string }> } | null;
        if (alive && body?.ready && Array.isArray(body.data)) setTopics(body.data);
      } catch {
        /* 侧栏降级：保持空列表 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [activeTeam]);

  // Needs-you 角标：失败/未就绪 → 不显示角标。0 时也隐藏（`shows how many
  // tasks currently sit there`，没任务就没角标）。
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch('/api/needs-you', { cache: 'no-store' });
        const body = (await res.json().catch(() => null)) as { ready?: boolean; data?: { count?: number } } | null;
        if (!alive) return;
        if (body?.ready && typeof body.data?.count === 'number' && body.data.count > 0) {
          setNeedsCount(body.data.count);
        } else {
          setNeedsCount(null);
        }
      } catch {
        if (alive) setNeedsCount(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [activeTeam]);

  // ⌘K 搜索 / N 新建 / Ctrl+B 收起 —— 原站实测有这三个快捷键。
  //
  // **⌘B / Ctrl+B 的监听已移交给 `AppShell`**（2026-10-17）。原因：侧栏折叠
  // 状态提升为受控 prop 后，AppShell 也注册了一个 ⌘B 监听去改同一份状态 ——
  // 两个监听各翻一次，净效果是「按了没反应」。这类重复监听最难查（按键明明
  // 派发了、preventDefault 也调了、setState 也调了，就是 UI 不动），
  // 根因是两个 listener 互相抵消。
  //
  // 折叠按钮（侧栏底部「收起侧栏」与折叠态下的展开按钮）仍然调
  // `toggleCollapsed`，走的是 prop 回调，与 AppShell 的快捷键同一个状态源，
  // 不冲突。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onSearch?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSearch]);

  if (collapsedEffective) {
    return (
      <button
        type="button"
        onClick={() => toggleCollapsed(false)}
        style={{
          position: 'fixed', left: 0, top: L.headerH, zIndex: 40,
          width: 36, height: 40,
          background: C.bg, color: C.textFaint,
          border: `1px solid ${C.line}`, borderLeft: 'none',
          borderRadius: `0 ${R.md} ${R.md} 0`,
          cursor: 'pointer', fontSize: T.body,
        }}
        title="展开侧栏 (Ctrl+B)"
      >
        ☰
      </button>
    );
  }

  return (
    <aside style={sideStyle}>
      {/* logo —— 原站实测是 jetbrainsMono 14/500 的 [todos] */}
      <Link
        href="/"
        style={{ ...logoStyle, color: C.text, textDecoration: 'none' }}
        title="Todos"
      >
        [todos]
      </Link>

      {/* 团队切换 */}
      <div style={{ marginTop: S.md }}>
        <div style={teamBadgeStyle}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {activeTeam?.name ?? ctx?.email ?? '未选择团队'}
          </span>
          {activeTeam?.role === 'admin' && <span style={proStyle}>PRO</span>}
        </div>
      </div>

      {/* 搜索 / 新建 —— 实测原站在侧栏顶部 */}
      <div style={{ marginTop: S.md, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <button type="button" style={shared.navItem} onClick={() => onSearch?.()}>
          <span style={iconStyle}>⌕</span>
          <span style={{ flex: 1 }}>Search</span>
          <kbd style={kbdStyle}>⌘K</kbd>
        </button>
        <Link href="/new-todo" style={{ ...shared.navItem, textDecoration: 'none' }}>
          <span style={iconStyle}>＋</span>
          <span style={{ flex: 1 }}>New task</span>
          <kbd style={kbdStyle}>N</kbd>
        </Link>
      </div>

      <Divider />

      {/* 主导航 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {PRIMARY.map((e) => (
          <SideLink key={e.href} entry={e} active={pathname === e.href} />
        ))}
      </div>

      <Divider />

      {/* Workspace（Chief topics）—— 实测原站是可折叠组 + Needs-you 角标。
         原先折叠按钮是 `setCollapsed((c) => c)` 的 no-op（影响侧栏外壳的
         collapsed），修复后**真正切换** `topicsCollapsed` —— 折叠时只缩起
         topics 子列表，侧栏外壳仍是展开的。角标数据走 `/api/needs-you`
         （count > 0 才显示），点击跳 `/needs-you` 专视图。 */}
      <div style={{ ...shared.navItem, padding: 0, cursor: 'default' }}>
        <button
          type="button"
          onClick={() => setTopicsCollapsed((c) => !c)}
          aria-expanded={!topicsCollapsed}
          style={{
            ...shared.navItem,
            background: 'transparent',
            color: C.text,
            border: 'none',
            flex: 1,
            padding: 0,
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          <span style={chevronStyle}>{topicsCollapsed ? '▸' : '▾'}</span>
          <span style={{ flex: 1 }}>Workspace</span>
        </button>
        {needsCount !== null && (
          <Link
            href="/needs-you"
            aria-label={`${needsCount} 项待你处理`}
            style={badgeStyle}
            title={`${needsCount} 项待你处理 · 进入 Needs you 视图`}
          >
            {needsCount}
          </Link>
        )}
      </div>
      {/* topics 缩进一级 —— 折叠时不渲染。New topic 也只在展开时显示。
         （原站语义里折叠组只隐藏子项，不影响组本身的「新建」入口 —— 但
         我们的 Chief 设置页里有 New topic，与之重复；折叠时一并隐藏
         更接近原站「可折叠列表」的语义。） */}
      {!topicsCollapsed && (
        <>
          <Link href="/settings/chief" style={{ ...shared.navItem, textDecoration: 'none' }}>
            <span style={iconStyle}>＋</span>
            <span style={{ flex: 1 }}>New topic</span>
          </Link>
          {/* topics 缩进一级 —— 实测原站 topic 在 Workspace 组下有层级缩进 */}
          <div style={{ paddingLeft: S.lg }}>
            {topics.length === 0 ? (
              <div style={{ ...shared.navItem, color: C.textGhost, cursor: 'default' }}>
                还没有 topic
              </div>
            ) : (
              topics.map((t) => (
                <Link
                  key={t.id}
                  href={`/settings/chief/${t.id}`}
                  style={{
                    ...shared.navItem,
                    textDecoration: 'none',
                    color: pathname === `/settings/chief/${t.id}` ? C.text : C.textFaint,
                    fontSize: T.meta,
                  }}
                >
                  {t.title}
                </Link>
              ))
            )}
          </div>
        </>
      )}

      <Divider />

      {/* 团队功能 */}
      {TEAM.map((e) => (
        <SideLink key={e.href} entry={e} active={pathname === e.href} />
      ))}

      <Divider />

      {/* 资源 */}
      <div style={shared.navGroupLabel}>Resources</div>
      {RESOURCE.map((e) => (
        <SideLink key={e.href} entry={e} active={pathname === e.href} />
      ))}

      <div style={{ flex: 1 }} />
      <button type="button" style={{ ...shared.navItem, color: C.textGhost }} onClick={() => toggleCollapsed(true)}>
        <span style={{ flex: 1, textAlign: 'left' }}>收起侧栏</span>
        <kbd style={kbdStyle}>⌃B</kbd>
      </button>
    </aside>
  );
}

function SideLink({ entry, active }: { entry: NavEntry; active: boolean }): React.JSX.Element {
  return (
    <Link
      href={entry.href}
      style={{
        ...shared.navItem,
        textDecoration: 'none',
        background: active ? 'rgba(129,140,248,0.14)' : 'transparent',
        color: active ? C.accent : C.textDim,
        fontWeight: active ? 500 : 400,
      }}
      aria-current={active ? 'page' : undefined}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        {entry.label}
        {entry.hint && (
          <span style={hintStyle} title={entry.hint}>
            {entry.hint}
          </span>
        )}
      </span>
      {entry.shortcut ? <kbd style={kbdStyle}>{entry.shortcut}</kbd> : null}
    </Link>
  );
}

function Divider(): React.JSX.Element {
  return <div style={dividerStyle} />;
}

// ── 样式（值全部来自实测令牌）────────────────────────────────────

const sideStyle: CSSProperties = {
  position: 'fixed',
  left: 0,
  top: 0,
  bottom: 0,
  // boxSizing 必须 border-box：不加的话 `width:240 + border-right:1` 会让
  // 实际占位变成 241px，右侧内容从 240 开始 → 标题被侧栏边框压住 1px。
  boxSizing: 'border-box',
  width: L.sidebarW,          // 实测 240px
  zIndex: 40,
  background: C.bg,            // 实测 rgb(24,24,27)
  borderRight: `1px solid ${C.line}`,
  display: 'flex',
  flexDirection: 'column',
  padding: `${S.lg}px ${S.md}px`,
  gap: 2,
  overflowY: 'auto',
  // 隐藏滚动条：侧栏内容通常一屏放得下，出滚动条会让内容区看起来被推窄
  scrollbarWidth: 'none',
};

const logoStyle: CSSProperties = {
  fontFamily: F.mono,          // 实测 jetbrainsMono
  fontSize: T.body,
  fontWeight: 500,
  letterSpacing: '-0.2px',
};

const teamBadgeStyle: CSSProperties = {
  ...shared.navItem,
  background: C.surfaceHi,
  color: C.text,
  fontWeight: 500,
};

const proStyle: CSSProperties = {
  fontSize: '9px',
  fontWeight: 700,
  letterSpacing: '0.5px',
  color: C.warn,
  border: `1px solid ${C.warn}`,
  borderRadius: R.sm,
  padding: '0 4px',
};

const iconStyle: CSSProperties = {
  width: 16,
  textAlign: 'center',
  color: C.textFaint,
  fontSize: T.body,
};

const kbdStyle: CSSProperties = {
  fontFamily: F.mono,
  fontSize: T.sm,
  color: C.textGhost,
  background: C.surfaceHi,
  borderRadius: R.sm,
  padding: '1px 4px',
};

/**
 * 侧栏条目的副标题（小字）。与既有 `kbdStyle` / `countStyle` 同字号档，
 * 但用更弱的灰（`C.textGhost`）以让主 label 仍是视觉重心；左间距 4px
 * 让 label 与 hint 之间有呼吸。`overflow:hidden` 与父 `flex:1, minWidth:0`
 * 配合 —— 文字超长时截断而不是溢出侧栏。
 */
const hintStyle: CSSProperties = {
  marginLeft: 4,
  fontSize: T.sm,
  color: C.textGhost,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const countStyle: CSSProperties = {
  fontFamily: F.mono,
  fontSize: T.sm,
  color: C.textGhost,
};

/**
 * Workspace 折叠按钮前面的三角箭头。▸/▾ 与原站侧栏的展开/折叠指示一致；
 * `chevronStyle` 字体宽度等比 `iconStyle`，不抢 label 的位置。
 */
const chevronStyle: CSSProperties = {
  width: 12,
  textAlign: 'center',
  color: C.textFaint,
  fontSize: T.sm,
};

/**
 * Needs-you 角标 —— 与既有 `countStyle` 视觉同源（mono 字体 + 小字号），
 * 但带强调色描边与背景，用来提示「有可点的待决项」。0 时**不渲染**（在父
 * 组件里判 `needsCount !== null`），不显示空角标。
 */
const badgeStyle: CSSProperties = {
  fontFamily: F.mono,
  fontSize: T.sm,
  fontWeight: 600,
  color: C.accent,
  background: 'rgba(129,140,248,0.18)',
  border: `1px solid ${C.accent}`,
  borderRadius: R.sm,
  padding: '0 6px',
  minWidth: 20,
  textAlign: 'center',
  textDecoration: 'none',
  cursor: 'pointer',
};

const dividerStyle: CSSProperties = {
  height: 1,
  background: C.line,          // 实测 rgba(255,255,255,0.1)
  margin: `${S.sm}px 0`,
};
