'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { CSSProperties } from 'react';
import {
  SettingsPlaceholder,
  teamNeedsPlaceholder,
} from '@/app/settings/settings-placeholder';
import { useTeamContext } from '@/lib/team-context';
import { C, F, R, S, T, shared } from '@/lib/design-tokens';

/**
 * Settings → Connections 应用目录页（对标原站左侧栏「设置 → Connections」）。
 *
 * **这是 A8 缺口的可见层**。原站文档（`recon-live/docs-mcp-servers.md`）：
 * > "The catalog includes both cloud apps backed by each vendor's official
 * >  remote MCP server and local presets (Playwright and Cua Driver)."
 *
 * **本切片只交付目录浏览 + 诚实标注**：
 *   - 21 个远程 + 2 个本地预设 = 23 条目录
 *   - 分类筛选（横排）+ 「Custom」筛选项
 *   - 「连接」按钮点击后**显示占位说明**，不发起任何 OAuth 流程 —— 一键登录
 *     是另一个数量级的工程，未接通即明示，不假装已实现。
 *   - endpoint 是否经过厂商官方文档核实，**显式标注** —— 不替用户做信任决定。
 *
 * **不写连接的实质写路径**：用户已有的自定义连接仍走 `/settings/mcp-servers`
 * 页面管理（不在本切片范围）；自定义连接是 catalog 之外的入口。
 */

// 后端上游形状（`apps/server/src/routes/connection-catalog.ts`）
interface McpCatalogEntry {
  identifier: string;
  label: string;
  category: string;
  transport: 'http' | 'stdio';
  endpoint: string | null;
  command: string | null;
  args: string[] | null;
  requiresOAuth: boolean;
  endpointVerified: boolean;
  docsUrl: string | null;
}

interface CatalogResponse {
  catalog: McpCatalogEntry[];
  categories: string[];
  teamConnectionCount: number;
  limit: number;
}

/** 「Custom」筛选项是本切片新造的目录筛（不在后端类别里） */
const CUSTOM_FILTER = '__custom__';
type FilterKey = string; // 分类名 or 'all' or '__custom__'

export default function ConnectionsPage(): React.JSX.Element {
  const { status, activeTeam } = useTeamContext();

  const [data, setData] = useState<CatalogResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>('all');
  /** 当前用户点过「连接」的 entry —— 用来显示「未接通」占位卡片。 */
  const [pendingConnect, setPendingConnect] = useState<string | null>(null);

  const teamId = activeTeam?.teamId ?? null;

  // ── 加载目录 ───────────────────────────────────────────────────────

  const load = useCallback(async () => {
    if (!teamId) {
      setData(null);
      return;
    }
    const res = await fetch(
      `/api/teams/${encodeURIComponent(teamId)}/connection-catalog`,
      { cache: 'no-store' },
    );
    const body = (await res.json().catch(() => null)) as
      | { ready?: boolean; data?: CatalogResponse; reason?: string }
      | null;
    if (!body) {
      setData(null);
      setError('BFF 没有返回可解析的响应');
      return;
    }
    if (body.ready === false) {
      setData(null);
      setError(`数据未就绪：connection-catalog (${body.reason ?? 'unknown'})`);
      return;
    }
    if (
      !body.data ||
      !Array.isArray(body.data.catalog) ||
      !Array.isArray(body.data.categories) ||
      typeof body.data.teamConnectionCount !== 'number' ||
      typeof body.data.limit !== 'number'
    ) {
      setData(null);
      setError(`响应形状不对：${JSON.stringify(body).slice(0, 120)}`);
      return;
    }
    setData(body.data);
    setError(null);
  }, [teamId]);

  useEffect(() => {
    if (teamNeedsPlaceholder(status, activeTeam)) return;
    void load();
  }, [status, activeTeam, load]);

  // ── 筛选后的条目 ─────────────────────────────────────────────────

  const filtered = useMemo(() => {
    if (!data) return [];
    if (filter === 'all') return data.catalog;
    if (filter === CUSTOM_FILTER) return []; // Custom 区目前是「Add custom」引导，不列条目
    return data.catalog.filter((e) => e.category === filter);
  }, [data, filter]);

  const pendingEntry = useMemo(() => {
    if (!pendingConnect || !data) return null;
    return data.catalog.find((e) => e.identifier === pendingConnect) ?? null;
  }, [pendingConnect, data]);

  // ── 未就绪占位 ─────────────────────────────────────────────────────

  if (teamNeedsPlaceholder(status, activeTeam)) {
    return (
      <main style={settingsPage}>
        <SettingsPlaceholder status={status} activeTeam={activeTeam} />
      </main>
    );
  }

  return (
    <main style={settingsPage}>
      <h1 style={h1Style}>应用目录（Connections）</h1>
      <p style={hintStyle}>
        把团队常用的 SaaS 接进来，agent 就能在跑任务时直接用它们的工具。
        每个连接走的是对应的 <strong>厂商官方 MCP server</strong>，
        工具列表就是该厂商自己发布的那份。本地预设（Browser / Computer use）
        不需要 OAuth，直接在执行任务的机器上跑。
      </p>

      {/* ── 顶部计数 + Add custom ────────────────────────────────────── */}
      <div style={topRowStyle}>
        <div style={countStyle}>
          {data
            ? `${data.teamConnectionCount} / ${data.limit} 已用连接`
            : '加载中…'}
        </div>
        <Link
          href="/settings/mcp-servers"
          style={addCustomBtnStyle}
          title="自定义连接走单独的设置页（与 catalog 并列）"
        >
          Add custom
        </Link>
      </div>

      {/* ── 「连接」按钮点了之后的诚实占位（不假装能连） ──────────── */}
      {pendingEntry && (
        <div style={noticeStyle}>
          <strong>{pendingEntry.label}</strong> 的 OAuth 一键登录尚未接通。
          <div style={{ marginTop: 6, fontSize: 13 }}>
            目录数据已就绪（{pendingEntry.transport === 'http'
              ? `endpoint: ${pendingEntry.endpoint ?? '未核实'}`
              : `命令: ${pendingEntry.command} ${(pendingEntry.args ?? []).join(' ')}`}），
            一键接入流程待补。
            目录外的自定义连接请到 <Link href="/settings/mcp-servers" style={linkStyle}>连接 / MCP servers</Link> 页管理。
          </div>
          <button
            type="button"
            onClick={() => setPendingConnect(null)}
            style={closeNoticeBtnStyle}
          >
            关闭
          </button>
        </div>
      )}

      {error && <div style={errorStyle}>{error}</div>}

      {/* ── 分类筛选条 ────────────────────────────────────────────── */}
      {data && (
        <nav style={filterBarStyle}>
          <FilterButton current={filter} value="all" label="全部" onClick={setFilter} />
          {data.categories.map((c) => (
            <FilterButton
              key={c}
              current={filter}
              value={c}
              label={CATEGORY_LABELS[c] ?? c}
              onClick={setFilter}
            />
          ))}
          <FilterButton current={filter} value={CUSTOM_FILTER} label="Custom" onClick={setFilter} />
        </nav>
      )}

      {/* ── Custom 区域：只放「去自定义页」指引 ──────────────────── */}
      {data && filter === CUSTOM_FILTER && (
        <div style={customAreaStyle}>
          <strong>Custom</strong> —— 添加原站目录之外的连接。
          <div style={{ marginTop: 6, fontSize: 13 }}>
            点击右上角 <em>Add custom</em> 或 <Link href="/settings/mcp-servers" style={linkStyle}>连接 / MCP servers</Link> 页：
            类型（Remote HTTP / Local stdio）+ identifier + endpoint / command + 凭据。
          </div>
        </div>
      )}

      {/* ── 卡片网格 ────────────────────────────────────────────── */}
      {data && filter !== CUSTOM_FILTER && (
        <div style={gridStyle}>
          {filtered.map((e) => (
            <CatalogCard
              key={e.identifier}
              entry={e}
              onConnect={() => setPendingConnect(e.identifier)}
            />
          ))}
          {filtered.length === 0 && (
            <div style={mutedStyle}>这个分类下没有条目。</div>
          )}
        </div>
      )}
    </main>
  );
}

// ── 分类按钮 ────────────────────────────────────────────────────────

function FilterButton({
  current,
  value,
  label,
  onClick,
}: {
  current: FilterKey;
  value: FilterKey;
  label: string;
  onClick: (v: FilterKey) => void;
}): React.JSX.Element {
  const active = current === value;
  return (
    <button
      type="button"
      onClick={() => onClick(value)}
      style={{
        ...filterBtnStyle,
        color: active ? C.text : C.textFaint,
        background: active ? C.surfaceHi : 'transparent',
        borderColor: active ? C.lineStrong : C.line,
      }}
    >
      {label}
    </button>
  );
}

// ── 卡片 ────────────────────────────────────────────────────────────

function CatalogCard({
  entry,
  onConnect,
}: {
  entry: McpCatalogEntry;
  onConnect: () => void;
}): React.JSX.Element {
  const isRemote = entry.transport === 'http';
  return (
    <div style={cardStyle}>
      <div style={cardHeadStyle}>
        <strong style={{ fontSize: T.bodyLg, color: C.text }}>{entry.label}</strong>
        <span style={badgeStyle}>{CATEGORY_LABELS[entry.category] ?? entry.category}</span>
      </div>

      <div style={metaStyle}>
        {isRemote ? (
          <>
            远程（{entry.requiresOAuth ? 'OAuth 一键登录' : '无需登录'}）
            <br />
            <code style={codeStyle}>{entry.endpoint ?? '—'}</code>
          </>
        ) : (
          <>
            本地运行在执行任务的机器上
            <br />
            <code style={codeStyle}>
              {entry.command} {(entry.args ?? []).join(' ')}
            </code>
          </>
        )}
      </div>

      {isRemote && entry.endpointVerified === false && (
        <div style={unverifiedStyle}>
          endpoint 未核实，接入前请对照厂商官方文档（{entry.docsUrl ? (
            <a
              href={entry.docsUrl}
              target="_blank"
              rel="noreferrer"
              style={linkStyle}
            >
              链接
            </a>
          ) : (
            <em>无文档页</em>
          )}
          ）。
        </div>
      )}

      <div style={cardFootStyle}>
        <button type="button" onClick={onConnect} style={primaryBtn}>
          连接
        </button>
        {entry.docsUrl && (
          <a
            href={entry.docsUrl}
            target="_blank"
            rel="noreferrer"
            style={ghostLinkStyle}
          >
            厂商文档
          </a>
        )}
      </div>
    </div>
  );
}

// ── 分类名 → 人类可读 ──────────────────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  productivity: '生产力',
  engineering: '工程 / DevOps',
  analytics: '数据分析',
  browser: 'Browser',
  desktop: 'Desktop',
};

// ── 样式 ────────────────────────────────────────────────────────────
//
// 沿用现有 settings 页的 inline 风格：底部集中、引用 design-tokens。
// 根容器只设 `settingsPage` 的 padding，不再加 marginLeft（全局侧栏已给）。

const settingsPage: CSSProperties = {
  padding: `${S.xl}px ${S.lg}px ${S.xxl}px`,
  maxWidth: 1200,
  margin: '0 auto',
  color: C.text,
  fontSize: T.lead,
};

const h1Style: CSSProperties = {
  fontSize: T.h1,
  fontWeight: 600,
  color: C.text,
  margin: `0 0 ${S.sm}px`,
};

const hintStyle: CSSProperties = {
  fontSize: T.body,
  color: C.textDim,
  lineHeight: 1.55,
  margin: `0 0 ${S.lg}px`,
  maxWidth: 720,
};

const topRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: S.lg,
};

const countStyle: CSSProperties = {
  fontSize: T.body,
  color: C.textDim,
};

const addCustomBtnStyle: CSSProperties = {
  ...shared.ghostBtn,
  textDecoration: 'none',
  display: 'inline-flex',
  alignItems: 'center',
};

const linkStyle: CSSProperties = {
  color: C.accent,
  textDecoration: 'underline',
};

const closeNoticeBtnStyle: CSSProperties = {
  marginTop: S.sm,
  ...shared.ghostBtn,
  fontSize: T.meta,
};

const noticeStyle: CSSProperties = {
  ...shared.noticeBox,
  marginBottom: S.lg,
  position: 'relative',
};

const errorStyle: CSSProperties = {
  ...shared.errorBox,
  marginBottom: S.lg,
};

const filterBarStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: S.xs,
  marginBottom: S.lg,
};

const filterBtnStyle: CSSProperties = {
  padding: `${S.xs}px ${S.md}px`,
  fontSize: T.meta,
  border: `1px solid ${C.line}`,
  borderRadius: R.pill,
  cursor: 'pointer',
  fontFamily: F.sans,
};

const customAreaStyle: CSSProperties = {
  ...shared.card,
  marginBottom: S.lg,
  fontSize: T.body,
  color: C.textDim,
};

const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
  gap: S.md,
};

const cardStyle: CSSProperties = {
  ...shared.card,
  display: 'flex',
  flexDirection: 'column',
  gap: S.sm,
};

const cardHeadStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: S.sm,
};

const badgeStyle: CSSProperties = {
  ...shared.badge,
  color: C.accent,
};

const metaStyle: CSSProperties = {
  fontSize: T.meta,
  color: C.textDim,
  lineHeight: 1.5,
};

const codeStyle: CSSProperties = {
  fontFamily: F.mono,
  fontSize: T.sm,
  color: C.textDim,
  wordBreak: 'break-all',
};

const unverifiedStyle: CSSProperties = {
  fontSize: T.meta,
  color: C.warn,
  background: 'rgba(234, 179, 8, 0.08)',
  border: `1px solid ${C.warn}`,
  borderRadius: R.md,
  padding: S.sm,
};

const cardFootStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: S.sm,
  marginTop: 'auto',
};

const primaryBtn: CSSProperties = shared.primaryBtn;

const ghostLinkStyle: CSSProperties = {
  ...shared.ghostBtn,
  textDecoration: 'none',
  fontSize: T.meta,
};

const mutedStyle: CSSProperties = {
  color: C.textGhost,
  fontSize: T.meta,
  padding: `${S.md}px 0`,
};
