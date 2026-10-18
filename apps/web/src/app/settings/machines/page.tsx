'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTeamContext } from '@/lib/team-context';
import { subscribe, type SseFrame } from '@/lib/api';
import { C, F, R, S, T, shared } from '@/lib/design-tokens';
import {
  teamNeedsPlaceholder,
  SettingsPlaceholder,
} from '../settings-placeholder';
import { settingsPage } from '../team-shell';

/**
 * Settings → Machines（对标左栏「设置 → Machines」）。
 *
 * 入口状态：机器是 *入队* 来的（`apps/server/src/routes/machine.ts` 的
 * `POST /api/machine/enroll`），用户在 Web 上只能**改 / 删**，不能新增。
 * 入网命令原文见 `D:/AI/todos/recon-live/docs-machines.md:5-9`：
 *
 *   npm install -g @todos-dev/cli@latest
 *   tds start
 *   # 无头机器：
 *   tds start --api-key <key> --team <team-id>
 *
 * 这两条命令抄到空状态里，不编。
 *
 * Web 端这里管的是机器的「闸门」（`buildEnabled` / `shellEnabled`）和并发
 * 上限（`maxConcurrentTasks`，原站限制 1..10）。`shellEnabled` 是高权限闸门，
 * 默认关；开关旁必须配警告文案，避免一键开启后踩坑。
 *
 * 删除 = 级联硬删，会带走 `machine_runtime_usage` 中所有行。响应里有
 * `note` 字段透给前端，提示语把它如实写出来。
 */

interface Machine {
  id: string;
  teamId: string;
  name: string;
  deviceId: string;
  enrolledBy: string;
  buildEnabled: boolean;
  shellEnabled: boolean;
  maxConcurrentTasks: number;
  cliVersion: string | null;
  workspacesDir: string | null;
  runtimes: string[];
  disabledRuntimes: string[];
  arch: string | null;
  runner: string | null;
  platform: string | null;
  tailnetAddr: string | null;
  tunnelError: string | null;
  isOnline: boolean;
  lastHeartbeatAt: number | null;
  createdAt: number;
  updatedAt: number;
}

const RUNTIME_LABEL: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  omp: 'OMP',
};

function formatLabel(runtime: string): string {
  return RUNTIME_LABEL[runtime] ?? runtime;
}

/** 把 lastHeartbeatAt 折成相对时间。**输入毫秒**（schema 写 bigint mode:number）。 */
function formatRelative(ts: number | null, now: number): string {
  if (ts == null) return '从未心跳';
  const diff = now - ts;
  if (diff < 5_000) return '刚刚';
  if (diff < 60_000) return `${Math.round(diff / 1000)} 秒前`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
  return `${Math.round(diff / 86_400_000)} 天前`;
}

export default function MachinesPage(): React.JSX.Element {
  const { status, activeTeam } = useTeamContext();
  // 单独提出来：下面渲染分支里 TS 无法从 `activeTeam` 的早退收窄出非空，
  // 而空状态要显示 team id（enroll 凭据必须以它命名）。
  const teamId = activeTeam?.teamId ?? '';

  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());

  const load = useCallback(async (): Promise<void> => {
    if (!activeTeam) return;
    setLoadError(null);
    const res = await fetch(
      `/api/teams/${encodeURIComponent(activeTeam.teamId)}/machines`,
      { cache: 'no-store' },
    );
    const body = (await res.json().catch(() => null)) as
      | { ready?: boolean; data?: Machine[]; reason?: string }
      | null;
    if (body && body.ready && Array.isArray(body.data)) {
      setMachines(body.data);
    } else {
      setMachines([]);
      setLoadError(
        body && typeof body.reason === 'string'
          ? `数据未就绪：${body.reason}`
          : '数据未就绪：/api/teams/:teamId/machines',
      );
    }
  }, [activeTeam]);

  useEffect(() => {
    if (status === 'ready' && activeTeam) void load();
  }, [status, activeTeam, load]);

  // 订阅团队事件流：`machine_updated` / `machine_deleted` 触发重拉。
  useEffect(() => {
    if (!activeTeam) return;
    const onFrame = (frame: SseFrame): void => {
      if (frame.type === 'machine_updated' || frame.type === 'machine_deleted') {
        void load();
      } else if (frame.type === 'ping') {
        return;
      }
    };
    const unsub = subscribe(`team:${activeTeam.teamId}`, onFrame);
    return unsub;
  }, [activeTeam, load]);

  // 1 分钟刷新一次相对时间显示。心跳存在的话让用户看到「3 分钟前」实时跳变。
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);

  const list = useMemo(() => machines ?? [], [machines]);

  async function patchMachine(id: string, patch: Partial<Pick<Machine, 'name' | 'buildEnabled' | 'shellEnabled' | 'maxConcurrentTasks'>>): Promise<void> {
    if (!activeTeam) return;
    setWriteError(null);
    setBusy(id);
    try {
      const res = await fetch(
        `/api/teams/${encodeURIComponent(activeTeam.teamId)}/machines/${encodeURIComponent(id)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        },
      );
      const body = (await res.json().catch(() => ({}))) as { machine?: Machine; error?: string };
      if (!res.ok) {
        setWriteError(body.error ?? `更新失败 (${res.status})`);
        return;
      }
      setNotice(`已更新机器「${body.machine?.name ?? id}」。`);
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function deleteMachine(m: Machine): Promise<void> {
    if (!activeTeam) return;
    // 二次确认：必须说清 cascade 后果。
    // 真实 service note 由响应带回（上游 deleteMachine 已经写在 note 字段），
    // 这里给出客户端可见的固定文案。
    const ok = window.confirm(
      `删除机器「${m.name}」？\n\n` +
        `会一并删掉该机器的所有 runtime 用量记录（${m.runtimes.length} 个 runtime、` +
        `${m.disabledRuntimes.length} 个禁用），且**不可逆**。\n\n` +
        `运行中的 todo 如果挂在该机器上会被结算为失败 (` +
        `machineOffline, 超过 10 分钟无心跳的判定).`,
    );
    if (!ok) return;

    setWriteError(null);
    setBusy(m.id);
    try {
      const res = await fetch(
        `/api/teams/${encodeURIComponent(activeTeam.teamId)}/machines/${encodeURIComponent(m.id)}`,
        { method: 'DELETE' },
      );
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; note?: string; error?: string };
      if (!res.ok) {
        setWriteError(body.error ?? `删除失败 (${res.status})`);
        return;
      }
      setNotice(`已删除机器「${m.name}」。${body.note ?? ''}`.trim());
      await load();
    } finally {
      setBusy(null);
    }
  }

  // 团队上下文未就绪：拿到的是空白页面会让用户填空了发现提交不了。
  // 用 teamNeedsPlaceholder 布尔判定，避免「JSX 元素恒真」的判定 bug。
  if (teamNeedsPlaceholder(status, activeTeam)) {
    return (
      <main style={settingsPage}>
        <SettingsPlaceholder status={status} activeTeam={activeTeam as { teamId: string } | null} />
      </main>
    );
  }

  return (
    <main style={settingsPage}>
      <h1 style={{ fontSize: T.h2, margin: '0 0 4px', color: C.text }}>Machines</h1>
      <p style={hintStyle}>
        机器是 todo 实际运行的地方。Web 上你能改机器的接活开关和并发上限；机器本身需要在一台电脑上跑
        <code style={codeInlineStyle}> tds start </code>
        来入队（详见下方空状态）。
      </p>

      {loadError !== null && (
        <div style={errorStyle}>
          <strong>出了点问题</strong>
          <div style={{ marginTop: 4 }}>{loadError}</div>
        </div>
      )}
      {writeError !== null && (
        <div style={errorStyle} onClick={() => setWriteError(null)}>
          <strong>写入被拒</strong>
          <div style={{ marginTop: 4 }}>{writeError}</div>
        </div>
      )}
      {notice !== null && (
        <div style={noticeStyle} onClick={() => setNotice(null)}>{notice}</div>
      )}

      <h2 style={{ ...sectionTitleStyle, marginTop: 24 }}>机器列表</h2>

      {machines === null ? (
        <div style={mutedStyle}>读取中…</div>
      ) : list.length === 0 ? (
        <EmptyState teamId={teamId} />
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0' }}>
          {list.map((m) => (
            <li key={m.id} style={rowStyle} data-machine-id={m.id}>
              <MachineRow
                machine={m}
                now={now}
                busy={busy === m.id}
                onToggleBuild={(v) => void patchMachine(m.id, { buildEnabled: v })}
                onToggleShell={(v) => void patchMachine(m.id, { shellEnabled: v })}
                onSetConcurrency={(n) => void patchMachine(m.id, { maxConcurrentTasks: n })}
                onDelete={() => void deleteMachine(m)}
              />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

// ── 空状态 ──────────────────────────────────────────────────────
//
// 命令原文来自 `D:/AI/todos/recon-live/docs-machines.md:5-9`：
//   1. npm install -g @todos-dev/cli@latest
//   2. tds start
//   3. (headless) tds start --api-key <key> --team <team-id>
// 入队完成后 `cliVersion` / `deviceId` 字段会自动出现在 machine 行（见
// `apps/server/src/routes/machine.ts:154` 的 enroll 分支）。
function EmptyState({ teamId }: { teamId: string }): React.JSX.Element {
  return (
    <section style={emptyStyle}>
      <strong style={{ color: C.text, fontSize: T.body }}>还没有机器入网。</strong>
      <div style={{ marginTop: 6, color: C.textDim, fontSize: T.meta, lineHeight: 1.6 }}>
        机器通过 enroll 协议注册（<code style={codeInlineStyle}>POST /api/machine/enroll</code>，
        见 <code style={codeInlineStyle}>apps/server/src/routes/machine.ts:112</code>），入队后机器
        就会自动出现在这个列表里。在这台机器的电脑上跑：
      </div>
      <pre style={codeBlockStyle}>
{`npm install -g @todos-dev/cli@latest
tds start`}
      </pre>
      <div style={{ color: C.textDim, fontSize: T.meta }}>
        无头机器（云服务器、无桌面 app）：先在「API keys」里造一把凭据，然后：
      </div>
      <pre style={codeBlockStyle}>
{`tds start --api-key <key> --team <team-id>`}
      </pre>
      {/* 这条不是可选的补充说明，是实测踩过的坑：服务端 enroll 的查询条件
          是 `api_keys.key_hash = ? AND api_keys.name = <teamId>`
          （apps/server/src/routes/machine.ts:130-140）。也就是说**凭据的名字
          必须字面等于 team id**。用「我的入网凭据」这种正常命名去 enroll 会拿到
          401 `invalid enrollment key for team`，而错误信息完全不提「名字」，
          照着上面的命令走会卡在 401 且不知道原因。实测证据：普通命名 key → 401，
          name=teamId 的 key → 200 {machineId, apiKey}。 */}
      <div
        style={{
          marginTop: 8,
          padding: '8px 10px',
          border: `1px solid ${C.warn}`,
          background: 'rgba(251,191,36,0.10)',
          borderRadius: R.md,
          color: C.text,
          fontSize: T.meta,
          lineHeight: 1.6,
        }}
      >
        <strong>造凭据时注意：</strong>
        凭据的<strong>名称必须字面等于你的 team id</strong>
        （<code style={codeInlineStyle}>{teamId}</code>），否则 enroll 会返回
        401 <code style={codeInlineStyle}>invalid enrollment key for team</code>。
        在「API keys」页新建凭据时把名称改成这个 id。
      </div>
      <div style={{ color: C.textGhost, fontSize: T.meta, marginTop: 8 }}>
        需要 Node.js 22.19+；CLI 文档见 <code style={codeInlineStyle}>docs-machines.md</code>。
      </div>
    </section>
  );
}

interface MachineRowProps {
  machine: Machine;
  now: number;
  busy: boolean;
  onToggleBuild: (v: boolean) => void;
  onToggleShell: (v: boolean) => void;
  onSetConcurrency: (n: number) => void;
  onDelete: () => void;
}

function MachineRow({
  machine,
  now,
  busy,
  onToggleBuild,
  onToggleShell,
  onSetConcurrency,
  onDelete,
}: MachineRowProps): React.JSX.Element {
  const onlineDot = machine.isOnline ? onlineStyle : offlineStyle;
  const onlineLabel = machine.isOnline ? '在线' : '离线';
  const onlineColor = machine.isOnline ? C.ok : C.textGhost;

  const enabledRuntimes = machine.runtimes.length;
  const disabledRuntimes = machine.disabledRuntimes.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={rowHeadStyle}>
        <span style={onlineDot} aria-hidden />
        <strong style={{ fontSize: T.bodyLg, color: C.text }}>{machine.name}</strong>
        <span style={{ color: onlineColor, fontSize: T.meta }}>{onlineLabel}</span>
        <code style={idChipStyle}>{machine.id}</code>
        <span style={{ marginLeft: 'auto' }}>
          <button
            type="button"
            style={dangerBtn}
            onClick={onDelete}
            disabled={busy}
          >
            删除
          </button>
        </span>
      </div>

      <div style={metaRowStyle}>
        <span style={metaStyle}>
          心跳：<strong style={{ color: C.text }}>{formatRelative(machine.lastHeartbeatAt, now)}</strong>
        </span>
        <span style={metaStyle}>CLI：<code style={codeInlineStyle}>{machine.cliVersion ?? '—'}</code></span>
        <span style={metaStyle}>
          平台：<strong style={{ color: C.text }}>{machine.platform ?? '?'}</strong>
          {machine.arch ? ` / ${machine.arch}` : ''}
        </span>
        <span style={metaStyle}>workspaces：<code style={codeInlineStyle}>{machine.workspacesDir ?? '—'}</code></span>
      </div>

      <div style={metaRowStyle}>
        <span style={metaStyle}>
          runtimes：{' '}
          {enabledRuntimes > 0
            ? machine.runtimes.map((r) => (
                <span key={r} style={badgeStyle}>{formatLabel(r)}</span>
              ))
            : <span style={badgeMutedStyle}>未配置</span>}
        </span>
        {disabledRuntimes > 0 && (
          <span style={metaStyle}>
            已禁用：{' '}
            {machine.disabledRuntimes.map((r) => (
              <span key={r} style={{ ...badgeStyle, color: C.warn }}>{formatLabel(r)}</span>
            ))}
          </span>
        )}
      </div>

      <div style={toggleRowStyle}>
        <label style={toggleLabelStyle}>
          <input
            type="checkbox"
            checked={machine.buildEnabled}
            onChange={(e) => onToggleBuild(e.target.checked)}
            disabled={busy}
          />
          <span>接 Builds</span>
        </label>
        <label style={toggleLabelStyle}>
          <input
            type="checkbox"
            checked={machine.shellEnabled}
            onChange={(e) => onToggleShell(e.target.checked)}
            disabled={busy}
          />
          <span>远端 Shell</span>
        </label>
        <label style={concurrencyLabelStyle}>
          并发上限：
          <input
            type="number"
            min={1}
            max={64}
            value={machine.maxConcurrentTasks}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              if (!Number.isFinite(n)) return;
              // 本地先 1..64 拦下，422 不让传到上游
              if (n < 1 || n > 64) return;
              onSetConcurrency(n);
            }}
            disabled={busy}
            style={concurrencyInputStyle}
          />
        </label>
      </div>

      {machine.shellEnabled && (
        <div style={warnStyle}>
          远端 Shell 是高权限闸门 —— 任何执行该机器的人能跑任意命令、读任意文件，包括
          secrets 和 model credentials。仅在你信任这台机器的物理环境时打开。
        </div>
      )}
      {machine.tunnelError && (
        <div style={errorInlineStyle}>
          Tailnet / tunnel 错误：<code style={codeInlineStyle}>{machine.tunnelError}</code>
          （远端 Shell 自动失效）
        </div>
      )}
    </div>
  );
}

// ── 样式 ────────────────────────────────────────────────────────

const hintStyle: CSSProperties = { color: C.textDim, fontSize: T.meta, marginBottom: 16 };
const mutedStyle: CSSProperties = { color: C.textGhost, fontSize: T.meta, padding: '12px 0' };
const errorStyle: CSSProperties = { ...shared.errorBox, marginTop: 12, cursor: 'pointer' };
const errorInlineStyle: CSSProperties = {
  background: 'rgba(248,113,113,0.08)',
  border: `1px solid ${C.danger}`,
  borderRadius: R.lg,
  padding: S.sm,
  fontSize: T.meta,
  color: C.text,
};
const noticeStyle: CSSProperties = { ...shared.noticeBox, cursor: 'pointer' };
const sectionTitleStyle: CSSProperties = { fontSize: T.h3, margin: '0 0 12px', color: C.text };
const rowStyle: CSSProperties = { ...shared.card, padding: S.md, marginBottom: 12 };
const rowHeadStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: S.sm,
  fontSize: T.body,
  flexWrap: 'wrap',
};
const idChipStyle: CSSProperties = {
  fontFamily: F.sans,
  fontSize: T.base,
  color: C.textGhost,
  background: C.code,
  padding: `${S.xs}px ${S.sm}px`,
  borderRadius: R.pill,
  letterSpacing: '0.5px',
};
const metaRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: S.lg,
  color: C.textDim,
  fontSize: T.base,
};
const metaStyle: CSSProperties = { display: 'inline-flex', gap: 4, alignItems: 'center' };
const badgeStyle: CSSProperties = {
  ...shared.badge,
  color: C.accent,
  marginRight: S.xs,
};
const badgeMutedStyle: CSSProperties = {
  ...shared.badge,
  color: C.textGhost,
};
const toggleRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: S.lg,
  alignItems: 'center',
};
const toggleLabelStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: S.sm,
  color: C.text,
  fontSize: T.body,
  cursor: 'pointer',
};
const concurrencyLabelStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: S.sm,
  color: C.text,
  fontSize: T.body,
};
const concurrencyInputStyle: CSSProperties = {
  ...shared.input,
  width: 60,
  textAlign: 'center',
};
const onlineStyle: CSSProperties = {
  display: 'inline-block',
  width: 10,
  height: 10,
  borderRadius: R.pill,
  background: C.ok,
  boxShadow: `0 0 6px ${C.ok}`,
};
const onlineDot: CSSProperties = onlineStyle;
const offlineStyle: CSSProperties = {
  ...onlineStyle,
  background: C.textGhost,
  boxShadow: 'none',
};
const codeBlockStyle: CSSProperties = {
  background: C.code,
  color: C.text,
  fontFamily: F.mono,
  fontSize: T.meta,
  padding: S.md,
  borderRadius: R.lg,
  border: `1px solid ${C.line}`,
  margin: `${S.sm}px 0`,
  overflowX: 'auto',
  whiteSpace: 'pre',
};
const codeInlineStyle: CSSProperties = {
  fontFamily: F.mono,
  fontSize: T.base,
  background: C.code,
  padding: `0 ${S.xs}px`,
  borderRadius: R.sm,
  color: C.text,
};
const warnStyle: CSSProperties = {
  background: 'rgba(251,191,36,0.08)',
  border: `1px solid ${C.warn}`,
  borderRadius: R.lg,
  padding: S.sm,
  fontSize: T.meta,
  color: C.text,
};
const emptyStyle: CSSProperties = {
  background: C.surface,
  border: `1px dashed ${C.line}`,
  borderRadius: R.xl,
  padding: S.lg,
  marginTop: S.md,
};
const dangerBtn: CSSProperties = { ...shared.dangerBtn };
