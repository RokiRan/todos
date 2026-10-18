'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import Link from 'next/link';
import { SettingsPlaceholder, teamNeedsPlaceholder } from '@/app/settings/settings-placeholder';
import { useTeamContext } from '@/lib/team-context';
import { C, F, R, S, T, shared } from '@/lib/design-tokens';

/**
 * `/agents` —— 团队成员列表（agent 名册）。
 *
 * **为什么是顶层路由而不是 `/settings/agents`**：原站把 agent 页放在「团队区」
 * 而不是设置区 —— agent 是团队成员，每支有名字/模型/职责/权限/记忆，
 * 与 Settings 里那些「关掉 keyboard shortcut」「加个 API key」的开关不是同一类。
 * `team-shell.tsx` 因此把 `Agents` 作为侧栏第一项，与其他设置项并列但**不在
 * settings 路径下** —— 这里的 `/agents` 拿到自己的 TeamShell 外壳，但不继承
 * settings 的 URL。
 *
 * 数据契约（与 `apps/server/src/routes/agents.ts` 对齐）：
 *   GET /api/teams/:teamId/agents → `{ agents: AgentSummary[] }`
 *   其中 AgentSummary = { id, teamId, displayName, description, provider, modelId,
 *     thinkingLevel, defaultSkillIds, grants, activeTaskCount, createdAt, ... }
 *
 * 每张卡显示：displayName / description（≤ 800 字符）/ provider+model / thinkingLevel /
 * activeTaskCount / defaultSkills 数 / 创建日期。**点击**进入 `/agents/[id]` 详情。
 *
 * 新建走 inline 表单（卡片风格），包含名字 + 角色描述（≤800）+ 角色描述提示，
 * 上限依据 docs/agents.md「Role … up to 800 characters」 —— 后端 zod 也是 .max(800)。
 *
 * 删除：每张卡底部有一个「删除」按钮（admin 可见），`confirm` 二次确认写明不可逆。
 * 403（需要 admin）有专门文案。
 */

const MAX_ROLE_DESCRIPTION = 800;
/** Free 档 agent 上限 —— 与 `packages/protocol/src/quota.ts` 的 `FREE_LIMITS.agents` 同源。 */
const MAX_AGENTS_PER_TEAM = 5;

/** 文档枚举（agents.md 与 recon/docs/runtimes.md 都用这套）。 */
const THINKING_LEVELS = [
  { value: 'off', label: '关闭' },
  { value: 'minimal', label: '极少' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '极高' },
  { value: 'max', label: '最大' },
] as const;
type ThinkingLevelValue = (typeof THINKING_LEVELS)[number]['value'];

const THINKING_LABEL: Record<string, string> = Object.fromEntries(
  THINKING_LEVELS.map((t) => [t.value, t.label]),
);

interface AgentRow {
  id: string;
  teamId: string;
  displayName: string;
  description: string | null;
  provider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
  defaultSkillIds: string[];
  grants: Record<string, boolean>;
  activeTaskCount: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export default function AgentsPage(): React.JSX.Element {
  const { status, activeTeam } = useTeamContext();

  // 布尔判定：JSX 元素恒真，if (<X/>) 永远为真，会让页面停在占位上
  // （见 settings-placeholder.tsx 的注释 —— 是这个项目已经踩过的坑）。
  if (teamNeedsPlaceholder(status, activeTeam)) {
    return <SettingsPlaceholder status={status} activeTeam={activeTeam} />;
  }

  // 兜底 narrow：teamNeedsPlaceholder 已断言 activeTeam 非空，但 TS 看不出来
  if (!activeTeam) return <main />;

  return <AgentsList teamId={activeTeam.teamId} />;
}

function AgentsList({ teamId }: { teamId: string }): React.JSX.Element {
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [creatingDraft, setCreatingDraft] = useState({ displayName: '', description: '' });
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoadError(null);
    try {
      const res = await fetch(
        `/api/teams/${encodeURIComponent(teamId)}/agents`,
        { cache: 'no-store' },
      );
      const body = (await res.json().catch(() => null)) as
        | { ready?: boolean; data?: AgentRow[]; reason?: string }
        | null;
      if (body?.ready === true && Array.isArray(body.data)) {
        setAgents(body.data);
      } else {
        setAgents([]);
        const reason = body && 'reason' in body ? body.reason : 'unknown';
        setLoadError(`agent 列表加载失败：${String(reason)}`);
      }
    } catch (err) {
      setAgents([]);
      setLoadError(err instanceof Error ? err.name : 'unknown');
    }
  }, [teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createAgent(): Promise<void> {
    if (busy) return;
    const name = creatingDraft.displayName.trim();
    if (!name) {
      setWriteError('名字必填');
      return;
    }
    const desc = creatingDraft.description.trim();
    if (desc.length > MAX_ROLE_DESCRIPTION) {
      setWriteError(`角色描述超过 ${MAX_ROLE_DESCRIPTION} 字符上限`);
      return;
    }
    setBusy(true);
    setWriteError(null);
    try {
      const res = await fetch(
        `/api/teams/${encodeURIComponent(teamId)}/agents`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // 不发 userId —— BFF 的 proxyWrite 从 cookie 解析出的身份注入它
          // （上游 zod 把 userId 声明成必填 .min(1)，但身份只能由服务端填，
          //  让前端发反而是注入风险）。
          body: JSON.stringify({
            displayName: name,
            description: desc.length > 0 ? desc : null,
          }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        agent?: AgentRow;
        error?: string;
      };
      if (res.ok && body.agent) {
        setNotice(`已创建「${body.agent.displayName}」`);
        setCreating(false);
        setCreatingDraft({ displayName: '', description: '' });
        await load();
      } else if (res.status === 403) {
        setWriteError('需要团队管理员权限才能创建 agent');
      } else {
        setWriteError(body.error ?? `创建失败 (${res.status})`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function deleteAgent(row: AgentRow): Promise<void> {
    if (busy) return;
    // 二次确认 —— agents.md "Removing an agent ... any active task for it is stopped.
    // Its memory remains stored in the team repository but is no longer used"，
    // 加上「不可逆」明示。memory 仍保留是事实，但**对运行而言 agent 已经不再被使用**。
    const ok = window.confirm(
      `删除 agent「${row.displayName}」？\n\n` +
        `该操作会立刻让 agent 停止接新 todo，并把当前活跃的 todo 一并终止。\n` +
        `agent 的 memory 仍保留在仓库里、但因不再运行 todo 而不再被调用 —— 此操作不可撤销。`,
    );
    if (!ok) return;
    setBusy(true);
    setDeletingId(row.id);
    setWriteError(null);
    try {
      const res = await fetch(
        `/api/teams/${encodeURIComponent(teamId)}/agents/${encodeURIComponent(row.id)}`,
        { method: 'DELETE' },
      );
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (res.ok && body.ok) {
        setNotice(`已删除「${row.displayName}」`);
        await load();
      } else if (res.status === 403) {
        setWriteError('需要团队管理员权限才能删除 agent');
      } else if (res.status === 409) {
        setWriteError(body.error ?? '删除被拒（409）。该 agent 上可能有进行中的任务');
      } else {
        setWriteError(body.error ?? `删除失败 (${res.status})`);
      }
    } finally {
      setBusy(false);
      setDeletingId(null);
    }
  }

  const list = agents ?? [];
  const atLimit = list.length >= MAX_AGENTS_PER_TEAM;

  return (
    <main>
      <h1 style={{ fontSize: 20, margin: '0 0 4px' }}>Agents</h1>
      <p style={hintStyle}>
        agent 是团队的 AI 成员，配上名字 / 角色 / 模型 / 技能 / 权限后即可承担 todo。
        创建与修改需团队管理员（agents.md: Changes require a team admin）。
      </p>

      {loadError !== null && (
        <div style={errorStyle}>
          <strong>列表加载失败</strong>
          <div style={{ marginTop: 4 }}>{loadError}</div>
          <button type="button" style={ghostBtn} onClick={() => void load()} disabled={busy}>
            重试
          </button>
        </div>
      )}
      {writeError !== null && (
        <div style={errorStyle}>
          <strong>出了点问题</strong>
          <div style={{ marginTop: 4 }}>{writeError}</div>
        </div>
      )}
      {notice !== null && (
        <div style={noticeStyle} onClick={() => setNotice(null)}>
          {notice}
        </div>
      )}

      <section style={sectionStyle}>
        <header style={sectionHeadStyle}>
          <h2 style={sectionTitleStyle}>团队 agent（{list.length}/{MAX_AGENTS_PER_TEAM}）</h2>
          {!creating && (
            <button
              type="button"
              style={atLimit ? disabledBtn : primaryBtn}
              onClick={() => {
                setCreating(true);
                setWriteError(null);
                setCreatingDraft({ displayName: '', description: '' });
              }}
              disabled={atLimit}
              title={atLimit ? `已达 Free 档 ${MAX_AGENTS_PER_TEAM} 个上限` : undefined}
            >
              + 新建 agent
            </button>
          )}
        </header>
        {atLimit && !creating && (
          <div style={warnStyle}>
            已达 Free 档 {MAX_AGENTS_PER_TEAM} 个上限。先删一个再加。
          </div>
        )}

        {agents === null && <div style={mutedStyle}>读取中…</div>}
        {agents !== null && list.length === 0 && !creating && (
          <div style={mutedStyle}>当前团队还没有 agent。点右上「新建 agent」开始。</div>
        )}

        {creating && (
          <div style={formPanelStyle}>
            <h3 style={{ fontSize: 14, margin: '0 0 8px' }}>新建 agent</h3>
            <label style={labelStyle} htmlFor="tds-agent-create-name">名字</label>
            <input
              id="tds-agent-create-name"
              style={inputStyle}
              value={creatingDraft.displayName}
              onChange={(e) =>
                setCreatingDraft((prev) => ({ ...prev, displayName: e.target.value }))
              }
              placeholder="如 backend-owner / frontend-builder"
              disabled={busy}
              maxLength={200}
            />
            <label style={labelStyle} htmlFor="tds-agent-create-desc">
              角色描述（≤ {MAX_ROLE_DESCRIPTION} 字符）
            </label>
            <textarea
              id="tds-agent-create-desc"
              style={textareaStyle}
              value={creatingDraft.description}
              onChange={(e) =>
                setCreatingDraft((prev) => ({ ...prev, description: e.target.value }))
              }
              placeholder="一两句说明 agent 负责什么；每个 todo 启动时会被注入"
              rows={4}
              disabled={busy}
            />
            <div style={metaStyle}>
              {creatingDraft.description.length} / {MAX_ROLE_DESCRIPTION}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button
                type="button"
                style={primaryBtn}
                onClick={() => void createAgent()}
                disabled={busy || !creatingDraft.displayName.trim()}
              >
                创建
              </button>
              <button
                type="button"
                style={ghostBtn}
                onClick={() => {
                  setCreating(false);
                  setCreatingDraft({ displayName: '', description: '' });
                }}
                disabled={busy}
              >
                取消
              </button>
            </div>
          </div>
        )}

        {list.length > 0 && (
          <ul style={cardListStyle}>
            {list.map((row) => (
              <li key={row.id} style={cardStyle}>
                <div style={cardHeadStyle}>
                  <Link href={`/agents/${encodeURIComponent(row.id)}`} style={cardTitleLinkStyle}>
                    {row.displayName}
                  </Link>
                  <span style={badgeStyle}>
                    {row.activeTaskCount} 个活跃 todo
                  </span>
                  <span style={{ marginLeft: 'auto' }}>
                    <button
                      type="button"
                      style={ghostBtn}
                      onClick={() => void deleteAgent(row)}
                      disabled={busy || deletingId === row.id}
                    >
                      {deletingId === row.id ? '删除中…' : '删除'}
                    </button>
                  </span>
                </div>
                <div style={cardDescStyle}>
                  {row.description ?? <em style={{ color: C.textFaint }}>未设置角色描述</em>}
                </div>
                <div style={cardMetaRowStyle}>
                  <span style={metaStyle}>
                    模型：{row.provider ?? '—'}{row.modelId ? ` / ${row.modelId}` : ''}
                  </span>
                  <span style={metaStyle}>
                    思考：{row.thinkingLevel ? THINKING_LABEL[row.thinkingLevel] ?? row.thinkingLevel : '默认'}
                  </span>
                  <span style={metaStyle}>默认 skills：{row.defaultSkillIds.length}</span>
                  <span style={metaStyle}>
                    创建于 {new Date(row.createdAt).toLocaleDateString()}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

// ── 样式 ─────────────────────────────────────────────────────────
//
// 与设置区其他卡片列表页一致：CSS-in-JS + 文件底部 const。颜色 / 圆角沿用 providers 页
// 风格，确保侧栏切换不刺眼。

const hintStyle: CSSProperties = { color: C.textDim, fontSize: T.meta, marginBottom: 16, lineHeight: 1.5 };
const mutedStyle: CSSProperties = { color: C.textFaint, fontSize: T.meta, padding: '12px 0' };
const errorStyle: CSSProperties = {
  ...shared.errorBox,
  marginBottom: S.md,
  fontSize: T.meta,
};
const noticeStyle: CSSProperties = {
  ...shared.noticeBox,
  marginBottom: S.md,
  fontSize: T.meta,
  cursor: 'pointer',
};
const warnStyle: CSSProperties = {
  background: 'rgba(251,191,36,0.12)',
  border: `1px solid ${C.warn}`,
  borderRadius: R.md,
  padding: '8px 10px',
  fontSize: T.base,
  marginBottom: S.md,
  color: C.text,
};
const sectionStyle: CSSProperties = {
  ...shared.card,
  marginBottom: 16,
};
const sectionHeadStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 12,
};
const sectionTitleStyle: CSSProperties = { fontSize: T.bodyLg, margin: 0, color: C.text };
const formPanelStyle: CSSProperties = {
  ...shared.card,
  background: C.surface,
  marginBottom: S.md,
};
const labelStyle: CSSProperties = {
  display: 'block',
  fontSize: T.sm,
  color: C.textDim,
  margin: '8px 0 4px',
  textTransform: 'uppercase',
  letterSpacing: 0.4,
};
const inputStyle: CSSProperties = {
  ...shared.input,
  fontSize: T.meta,
};
const textareaStyle: CSSProperties = {
  ...shared.input,
  fontSize: T.meta,
  fontFamily: F.mono,
  minHeight: 80,
  resize: 'vertical',
};
const primaryBtn: CSSProperties = {
  ...shared.primaryBtn,
  padding: '7px 14px',
  fontSize: T.meta,
};
/** 禁用按钮 —— 走 surfaceHi 底 + textGhost 字色，避免在暗色背景里看起来「仍可点」。 */
const disabledBtn: CSSProperties = {
  padding: '7px 14px',
  borderRadius: R.md,
  border: `1px solid ${C.line}`,
  background: C.surfaceHi,
  color: C.textGhost,
  fontSize: T.meta,
  cursor: 'not-allowed',
};
const ghostBtn: CSSProperties = {
  ...shared.ghostBtn,
  padding: '5px 10px',
  fontSize: T.base,
  marginRight: 6,
};
const cardListStyle: CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: 0,
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
  gap: 12,
};
/** agent 卡：与 section 共享同一深色面板，但内边距略小。 */
const cardStyle: CSSProperties = {
  ...shared.card,
  background: C.surface,
  padding: S.md,
};
const cardHeadStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginBottom: 6,
  flexWrap: 'wrap',
};
const cardTitleLinkStyle: CSSProperties = {
  fontWeight: 600,
  fontSize: T.body,
  color: C.accent,
  textDecoration: 'none',
};
const badgeStyle: CSSProperties = {
  ...shared.badge,
  background: 'rgba(129,140,248,0.14)',
  color: C.accent,
  border: `1px solid ${C.accent}`,
};
const cardDescStyle: CSSProperties = {
  fontSize: T.meta,
  color: C.text,
  lineHeight: 1.5,
  marginBottom: 8,
  wordBreak: 'break-word',
};
const cardMetaRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 12,
  borderTop: '1px solid rgba(255,255,255,0.06)',
  paddingTop: 8,
};
/** agent 卡内的元信息（活跃 todo / 默认 skills / 创建于）—— 走 textGhost 以减弱视觉权重。 */
const metaStyle: CSSProperties = { color: C.textGhost, fontSize: T.base };