'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { SettingsPlaceholder, teamNeedsPlaceholder } from '@/app/settings/settings-placeholder';
import { useTeamContext } from '@/lib/team-context';
import { PHASE_COLUMNS, type TodoPhase } from '@/lib/api';
import { C, F, R, S, T, shared } from '@/lib/design-tokens';

/**
 * `/agents/[agentId]` —— agent 详情页。
 *
 * 三段 tab 严格照 agents.md：
 *   - **Overview**：profile 卡（名字 / 角色描述 / 创建时间 + stats）+ default skills
 *     （≤ 10，chip 形式点开看描述）+ runtime / model / thinking level（model 用
 *     `/api/teams/{teamId}/models?runtime=pi` 下拉，thinkingLevel 从
 *     `'off'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'` 下拉）+ 可复制的
 *     agent id + 「正在处理的 todo」列表。
 *   - **Access**：高影响工具开关（`grants`，键名按 permissions.md 的标准）：
 *     push_branch / merge_branch / create_tag / create_skill / update_skill /
 *     remote_shell / team_secrets / connections (MCP servers)。**授权的连接**本身
 *     需要 connectionsPerAgent 维度，本切片先留 TODO 提示。
 *   - **Memory**：restored on 2026-10-17 直连后台 `/api/teams/:teamId/agents/:agentId/memories`
 *     资源（见 `routes/agent-memory.ts` + 两个 BFF）。失败 `ready:false` 显示占位并
 *     写明 reason；编辑/删除走二次确认。
 *
 * 删除 agent 走底部独立按钮 + confirm 二次确认，**写明不可逆**（agents.md
 * "Removing an agent ... irreversible"）。
 */

const MAX_ROLE_DESCRIPTION = 800;
/** Free 档 default skill 上限 —— agents.md "up to 10"。 */
const MAX_DEFAULT_SKILLS_PER_AGENT = 10;
/** Free 档单 agent 授权连接上限 —— permissions.md "up to 10"。 */
const MAX_CONNECTIONS_PER_AGENT = 10;

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

/**
 * 7 个 grants 键名全部以 `permissions.md` 原文为准 —— 文档表里同时给了
 * 显示名（如 "Push branch"）与协议名（如 "push_branch"）。**键名不要自己编**，
 * 服务层会按这些键写 jsonb，以后改键名等于改 schema。
 */
const GRANT_DEFS: ReadonlyArray<{ key: string; label: string; hint: string }> = [
  { key: 'push_branch', label: 'Push 分支', hint: '允许把构建分支推到远端仓库' },
  { key: 'merge_branch', label: '合并分支', hint: '允许把分支合入目标分支' },
  { key: 'create_tag', label: '打 tag', hint: '允许创建发布用的 Git tag' },
  { key: 'create_skill', label: '新建 skill', hint: '允许向团队 skill 库写入新条目' },
  { key: 'update_skill', label: '修改 skill', hint: '允许改团队 skill 库里已有条目' },
  { key: 'remote_shell', label: '远程 shell', hint: '允许在已开启 shell 的机器上跑命令' },
  { key: 'team_secrets', label: '读取团队 secret', hint: '以环境变量形式注入 team / project secret' },
  // MCP server 授权是「按连接一份」开关，键名形如 `connection:<identifier>`，
  // 由后续 connections 设置页写入；这里只占位展示（≤ 10 顶到 MAX_CONNECTIONS_PER_AGENT）。
];

interface SkillLite {
  id: string;
  name: string;
}

interface ModelRow {
  id: string;
  modelId: string;
  label: string;
  providerId: string;
  providerLabel: string;
  usable: boolean;
}

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

interface AgentTodoRow {
  id: string;
  phase: TodoPhase;
  title: string;
  seqNum: number;
  projectId: string;
}

type Tab = 'overview' | 'access' | 'memory';

const PHASE_LABEL: Record<string, string> = Object.fromEntries(
  PHASE_COLUMNS.map((c) => [c.phase, c.label]),
);

export default function AgentDetailPage(): React.JSX.Element {
  const { status, activeTeam } = useTeamContext();
  const params = useParams<{ agentId: string }>();
  const router = useRouter();
  const agentId = typeof params.agentId === 'string' ? params.agentId : '';

  if (teamNeedsPlaceholder(status, activeTeam)) {
    return <SettingsPlaceholder status={status} activeTeam={activeTeam} />;
  }
  if (!activeTeam) return <main />;

  return (
    <AgentDetailContent
      teamId={activeTeam.teamId}
      agentId={agentId}
      onDeleted={() => router.push('/agents')}
    />
  );
}

function AgentDetailContent({
  teamId,
  agentId,
  onDeleted,
}: {
  teamId: string;
  agentId: string;
  onDeleted: () => void;
}): React.JSX.Element {
  const [agent, setAgent] = useState<AgentRow | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 当前 tab
  const [tab, setTab] = useState<Tab>('overview');

  // Overview 编辑态
  const [skills, setSkills] = useState<SkillLite[] | null>(null);
  const [models, setModels] = useState<ModelRow[] | null>(null);
  const [todos, setTodos] = useState<AgentTodoRow[] | null>(null);

  // Profile 草稿（仅 overview 内的可编辑字段）
  const [profileDraft, setProfileDraft] = useState<{ displayName: string; description: string }>({
    displayName: '',
    description: '',
  });
  const [profileDirty, setProfileDirty] = useState(false);

  // Overview：default skills 草稿（agent 视角的勾选）
  const [skillsDraft, setSkillsDraft] = useState<Set<string>>(new Set());
  const skillsDraftDirty = useMemo(() => {
    if (!agent) return false;
    const a = new Set(agent.defaultSkillIds);
    if (a.size !== skillsDraft.size) return true;
    for (const id of skillsDraft) if (!a.has(id)) return true;
    return false;
  }, [agent, skillsDraft]);

  // Overview：runtime + model + thinking level
  const [providerDraft, setProviderDraft] = useState<string>('');
  const [modelDraft, setModelDraft] = useState<string>('');
  const [thinkingDraft, setThinkingDraft] = useState<ThinkingLevelValue>('medium');
  const runtimeDirty = useMemo(() => {
    if (!agent) return false;
    return (
      (agent.provider ?? '') !== providerDraft ||
      (agent.modelId ?? '') !== modelDraft ||
      (agent.thinkingLevel ?? 'medium') !== thinkingDraft
    );
  }, [agent, providerDraft, modelDraft, thinkingDraft]);

  // Access 草稿：grants 的全量快照
  const [grantsDraft, setGrantsDraft] = useState<Record<string, boolean>>({});
  const grantsDirty = useMemo(() => {
    if (!agent) return false;
    const a = agent.grants ?? {};
    const keys = new Set([...Object.keys(a), ...Object.keys(grantsDraft)]);
    for (const k of keys) {
      const av = a[k] === true;
      const dv = grantsDraft[k] === true;
      if (av !== dv) return true;
    }
    return false;
  }, [agent, grantsDraft]);

  // ── 加载 ─────────────────────────────────────────────────────
  const loadAgent = useCallback(async (): Promise<void> => {
    setLoadError(null);
    try {
      const res = await fetch(
        `/api/teams/${encodeURIComponent(teamId)}/agents/${encodeURIComponent(agentId)}`,
        { cache: 'no-store' },
      );
      if (res.status === 404) {
        setAgent(null);
        setLoadError('agent 不存在或已删除');
        return;
      }
      const body = (await res.json().catch(() => null)) as
        | { ready?: boolean; data?: AgentRow; reason?: string }
        | null;
      if (body?.ready === true && body.data) {
        setAgent(body.data);
        setProfileDraft({
          displayName: body.data.displayName,
          description: body.data.description ?? '',
        });
        setProfileDirty(false);
        setSkillsDraft(new Set(body.data.defaultSkillIds));
        setProviderDraft(body.data.provider ?? '');
        setModelDraft(body.data.modelId ?? '');
        setThinkingDraft(
          (body.data.thinkingLevel as ThinkingLevelValue | null) ?? 'medium',
        );
        setGrantsDraft({ ...(body.data.grants ?? {}) });
      } else {
        setAgent(null);
        setLoadError(
          body && typeof body.reason === 'string'
            ? `agent 详情加载失败：${body.reason}`
            : 'agent 详情加载失败',
        );
      }
    } catch (err) {
      setAgent(null);
      setLoadError(err instanceof Error ? err.name : 'unknown');
    }
  }, [teamId, agentId]);

  // ── Skills 目录 + Models 目录 + 正在处理的 todo ────────────
  const loadSkills = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(
        `/api/teams/${encodeURIComponent(teamId)}/skills`,
        { cache: 'no-store' },
      );
      const body = (await res.json().catch(() => null)) as
        | { ready?: boolean; data?: SkillLite[]; reason?: string }
        | null;
      if (body?.ready === true && Array.isArray(body.data)) {
        setSkills(body.data);
      } else {
        setSkills([]);
      }
    } catch {
      setSkills([]);
    }
  }, [teamId]);

  const loadModels = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(
        `/api/teams/${encodeURIComponent(teamId)}/models?runtime=pi`,
        { cache: 'no-store' },
      );
      const body = (await res.json().catch(() => null)) as
        | { ready?: boolean; data?: ModelRow[]; reason?: string }
        | null;
      if (body?.ready === true && Array.isArray(body.data)) {
        setModels(body.data);
      } else {
        setModels([]);
      }
    } catch {
      setModels([]);
    }
  }, [teamId]);

  const loadTodos = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(
        `/api/teams/${encodeURIComponent(teamId)}/agents/${encodeURIComponent(agentId)}/todos`,
        { cache: 'no-store' },
      );
      const body = (await res.json().catch(() => null)) as
        | { ready?: boolean; data?: AgentTodoRow[]; reason?: string }
        | null;
      if (body?.ready === true && Array.isArray(body.data)) {
        setTodos(body.data);
      } else {
        setTodos([]);
      }
    } catch {
      setTodos([]);
    }
  }, [teamId, agentId]);

  useEffect(() => {
    void loadAgent();
    void loadSkills();
    void loadModels();
    void loadTodos();
  }, [loadAgent, loadSkills, loadModels, loadTodos]);

  // ── 派生：当前 provider 下的模型集合 ────────────────────────
  const modelsByProvider = useMemo(() => {
    const m = new Map<string, ModelRow[]>();
    for (const row of models ?? []) {
      const list = m.get(row.providerId) ?? [];
      list.push(row);
      m.set(row.providerId, list);
    }
    return m;
  }, [models]);

  // 已授权 connection 数（键名形如 `connection:<identifier>`）
  const grantedConnectionKeys = useMemo(
    () =>
      Object.keys(grantsDraft).filter(
        (k) => k.startsWith('connection:') && grantsDraft[k] === true,
      ),
    [grantsDraft],
  );

  // ── 写路径 ───────────────────────────────────────────────────
  /** 把 patch body 走 PATCH，再把返回的最新 agent 写到本地 state。 */
  async function patchAgent(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setWriteError(null);
    try {
      const res = await fetch(
        `/api/teams/${encodeURIComponent(teamId)}/agents/${encodeURIComponent(agentId)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          // 不发 userId —— 由 proxyWrite 从 cookie 注入
          body: JSON.stringify(body),
        },
      );
      const respBody = (await res.json().catch(() => ({}))) as {
        agent?: AgentRow;
        error?: string;
      };
      if (res.ok && respBody.agent) {
        setAgent(respBody.agent);
        return true;
      }
      if (res.status === 403) {
        setWriteError('需要团队管理员权限才能修改 agent');
      } else {
        setWriteError(respBody.error ?? `修改失败 (${res.status})`);
      }
      return false;
    } catch (err) {
      setWriteError(err instanceof Error ? err.message : 'network error');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveProfile(): Promise<void> {
    if (!profileDirty || busy) return;
    const displayName = profileDraft.displayName.trim();
    if (!displayName) {
      setWriteError('名字不能为空');
      return;
    }
    if (profileDraft.description.length > MAX_ROLE_DESCRIPTION) {
      setWriteError(`角色描述超过 ${MAX_ROLE_DESCRIPTION} 字符上限`);
      return;
    }
    const ok = await patchAgent({
      displayName,
      description: profileDraft.description,
    });
    if (ok) {
      setNotice('profile 已保存');
      setProfileDirty(false);
    }
  }

  async function saveSkills(): Promise<void> {
    if (!skillsDraftDirty || busy) return;
    // **整体替换** —— 把当前勾选集（agent 旧值 + 草稿调整）一次性提交。
    // 这是 routes/agents.ts 与 routes/skills.ts 共同采用的语义：「传空数组 = 清空」，
    // 所以这里**不**做"增/减"两次请求、也不会丢字段。
    const ids = Array.from(skillsDraft);
    const ok = await patchAgent({ defaultSkillIds: ids });
    if (ok) setNotice(`已保存 ${ids.length} 个 default skill`);
  }

  async function saveRuntime(): Promise<void> {
    if (!runtimeDirty || busy) return;
    // 模型/provider 一对：传了 modelId 必须传 provider；空 modelId 表示清空。
    const patch: Record<string, unknown> = {
      thinkingLevel: thinkingDraft,
    };
    if (modelDraft.length > 0) {
      patch['provider'] = providerDraft;
      patch['modelId'] = modelDraft;
    } else {
      patch['provider'] = null;
      patch['modelId'] = null;
    }
    const ok = await patchAgent(patch);
    if (ok) setNotice('runtime 已保存');
  }

  async function saveGrants(): Promise<void> {
    if (!grantsDirty || busy) return;
    const ok = await patchAgent({ grants: { ...grantsDraft } });
    if (ok) setNotice('权限已保存');
  }

  function toggleGrant(key: string, on: boolean): void {
    setGrantsDraft((prev) => {
      const next = { ...prev };
      if (on) next[key] = true;
      else delete next[key];
      return next;
    });
  }

  function toggleSkill(skillId: string, on: boolean): void {
    setSkillsDraft((prev) => {
      const next = new Set(prev);
      if (on) {
        if (next.size >= MAX_DEFAULT_SKILLS_PER_AGENT) return prev;
        next.add(skillId);
      } else {
        next.delete(skillId);
      }
      return next;
    });
  }

  async function deleteAgent(): Promise<void> {
    if (busy || !agent) return;
    // agents.md "Removing an agent ... irreversible"。memory 仍保留在仓库、
    // 但 agent 不再运行 todo，故对运行而言**不可逆**。文案分两段写清楚。
    const ok = window.confirm(
      `删除 agent「${agent.displayName}」？\n\n` +
        `该操作会立刻让它停止接新 todo，并把当前活跃的 todo 一并终止。\n` +
        `agent 的 memory 仍保留在团队仓库里、但因不再运行 todo 而不再被调用 —— ` +
        `此操作不可撤销。`,
    );
    if (!ok) return;
    setBusy(true);
    setWriteError(null);
    try {
      const res = await fetch(
        `/api/teams/${encodeURIComponent(teamId)}/agents/${encodeURIComponent(agentId)}`,
        { method: 'DELETE' },
      );
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (res.ok && body.ok) {
        setNotice(`已删除「${agent.displayName}」`);
        // 删除后回到列表 —— 用 SPA 跳转而不是 window.location，避免闪一下整页重载
        setTimeout(() => onDeleted(), 800);
      } else if (res.status === 403) {
        setWriteError('需要团队管理员权限才能删除 agent');
      } else if (res.status === 409) {
        setWriteError(body.error ?? '删除被拒（409）');
      } else {
        setWriteError(body.error ?? `删除失败 (${res.status})`);
      }
    } finally {
      setBusy(false);
    }
  }

  // ── 顶部 / 错误占位 ─────────────────────────────────────────
  if (loadError !== null && !agent) {
    return (
      <main>
        <Link href="/agents" style={backLinkStyle}>← 返回 Agents 列表</Link>
        <h1 style={{ fontSize: 20, margin: '12px 0 4px' }}>Agent</h1>
        <div style={errorStyle}>
          <strong>读不到 agent</strong>
          <div style={{ marginTop: 4 }}>{loadError}</div>
          <button type="button" style={ghostBtn} onClick={() => void loadAgent()} disabled={busy}>
            重试
          </button>
        </div>
      </main>
    );
  }
  if (!agent) {
    return (
      <main>
        <Link href="/agents" style={backLinkStyle}>← 返回 Agents 列表</Link>
        <h1 style={{ fontSize: 20, margin: '12px 0 4px' }}>Agent</h1>
        <div style={mutedStyle}>读取中…</div>
      </main>
    );
  }

  return (
    <main>
      <Link href="/agents" style={backLinkStyle}>← 返回 Agents 列表</Link>
      <h1 style={{ fontSize: 20, margin: '12px 0 4px' }}>{agent.displayName}</h1>

      {writeError !== null && (
        <div style={errorStyle}>
          <strong>出了点问题</strong>
          <div style={{ marginTop: 4 }}>{writeError}</div>
        </div>
      )}
      {notice !== null && (
        <div style={noticeStyle} onClick={() => setNotice(null)}>{notice}</div>
      )}

      {/* ── Profile 卡 ── */}
      <section style={profileStyle}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
          <div style={avatarStyle}>{agent.displayName.slice(0, 1).toUpperCase() || 'A'}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <label style={labelStyle} htmlFor="tds-agent-name">名字</label>
            <input
              id="tds-agent-name"
              style={inputStyle}
              value={profileDraft.displayName}
              onChange={(e) => {
                setProfileDraft((prev) => ({ ...prev, displayName: e.target.value }));
                setProfileDirty(true);
              }}
              disabled={busy}
              maxLength={200}
            />
            <label style={labelStyle} htmlFor="tds-agent-desc">
              角色描述（≤ {MAX_ROLE_DESCRIPTION} 字符）
            </label>
            <textarea
              id="tds-agent-desc"
              style={textareaStyle}
              value={profileDraft.description}
              onChange={(e) => {
                setProfileDraft((prev) => ({ ...prev, description: e.target.value }));
                setProfileDirty(true);
              }}
              disabled={busy}
              rows={4}
            />
            <div style={metaStyle}>
              {profileDraft.description.length} / {MAX_ROLE_DESCRIPTION}
            </div>
            <div style={{ marginTop: 8 }}>
              <button
                type="button"
                style={primaryBtn}
                onClick={() => void saveProfile()}
                disabled={busy || !profileDirty}
              >
                保存 profile
              </button>
            </div>
          </div>
        </div>

        <div style={statsStripStyle}>
          <Stat label="活跃 todo" value={String(agent.activeTaskCount)} />
          <Stat label="default skills" value={String(agent.defaultSkillIds.length)} />
          <Stat label="已授权连接" value={String(grantedConnectionKeys.length)} />
          <Stat label="创建于" value={new Date(agent.createdAt).toLocaleDateString()} />
        </div>

        <div style={{ marginTop: 12 }}>
          <span style={labelStyle}>agent id</span>
          <CopyChip text={agent.id} />
        </div>
      </section>

      {/* ── Tabs ── */}
      <nav style={tabNavStyle}>
        {(
          [
            { id: 'overview', label: 'Overview' },
            { id: 'access', label: 'Access' },
            { id: 'memory', label: 'Memory' },
          ] as ReadonlyArray<{ id: Tab; label: string }>
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            style={{
              ...tabBtnStyle,
              ...(tab === t.id ? activeTabBtnStyle : {}),
            }}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'overview' && (
        <>
          {/* default skills */}
          <section style={sectionStyle}>
            <h2 style={sectionTitleStyle}>
              Default skills（{skillsDraft.size} / {MAX_DEFAULT_SKILLS_PER_AGENT}）
            </h2>
            <p style={hintStyle}>
              标为默认的 skill 会在 agent 每次跑 todo 时自动加载。保存会**整体替换**
              `defaultSkillIds`（非增量） —— 没勾的将不再携带。
            </p>
            {skills === null ? (
              <div style={mutedStyle}>读取 skill 目录中…</div>
            ) : skills.length === 0 ? (
              <div style={mutedStyle}>团队还没有 skill，无法分配。</div>
            ) : (
              <>
                <div style={chipGridStyle}>
                  {skills.map((s) => {
                    const checked = skillsDraft.has(s.id);
                    const atLimit = skillsDraft.size >= MAX_DEFAULT_SKILLS_PER_AGENT;
                    return (
                      <label key={s.id} style={chipLabelStyle}>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={busy || (!checked && atLimit)}
                          onChange={(e) => toggleSkill(s.id, e.target.checked)}
                        />
                        <span>{s.name}</span>
                      </label>
                    );
                  })}
                </div>
                <div style={{ marginTop: 10 }}>
                  <button
                    type="button"
                    style={primaryBtn}
                    onClick={() => void saveSkills()}
                    disabled={busy || !skillsDraftDirty}
                  >
                    保存 default skills
                  </button>
                  <button
                    type="button"
                    style={ghostBtn}
                    onClick={() => setSkillsDraft(new Set(agent.defaultSkillIds))}
                    disabled={busy || !skillsDraftDirty}
                  >
                    放弃改动
                  </button>
                </div>
              </>
            )}
          </section>

          {/* runtime + model + thinking level */}
          <section style={sectionStyle}>
            <h2 style={sectionTitleStyle}>Runtime 与模型</h2>
            <p style={hintStyle}>
              模型选项来自团队 provider 目录（`/api/teams/{teamId}/models?runtime=pi`）。
              选空 = 清空当前配置（agent 将不带模型运行，调度会被拒）。
            </p>
            <div style={fieldRowStyle}>
              <label style={labelStyle} htmlFor="tds-agent-provider">Provider</label>
              <select
                id="tds-agent-provider"
                style={selectStyle}
                value={providerDraft}
                onChange={(e) => {
                  setProviderDraft(e.target.value);
                  setModelDraft('');
                }}
                disabled={busy}
              >
                <option value="">（无）</option>
                {(models ?? []).length === 0 && <option value="" disabled>未配置模型目录</option>}
                {Array.from(new Set((models ?? []).map((m) => m.providerId))).map((pid) => {
                  const row = (models ?? []).find((m) => m.providerId === pid);
                  return (
                    <option key={pid} value={pid}>
                      {row?.providerLabel ?? pid}
                    </option>
                  );
                })}
              </select>
            </div>
            <div style={fieldRowStyle}>
              <label style={labelStyle} htmlFor="tds-agent-model">Model</label>
              <select
                id="tds-agent-model"
                style={selectStyle}
                value={modelDraft}
                onChange={(e) => setModelDraft(e.target.value)}
                disabled={busy || providerDraft.length === 0}
              >
                <option value="">（无）</option>
                {(modelsByProvider.get(providerDraft) ?? []).map((m) => (
                  <option key={m.id} value={m.modelId} disabled={!m.usable}>
                    {m.label}（{m.modelId}）{!m.usable ? ' · 未配 key' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div style={fieldRowStyle}>
              <label style={labelStyle} htmlFor="tds-agent-thinking">Thinking level</label>
              <select
                id="tds-agent-thinking"
                style={selectStyle}
                value={thinkingDraft}
                onChange={(e) => setThinkingDraft(e.target.value as ThinkingLevelValue)}
                disabled={busy}
              >
                {THINKING_LEVELS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}（{t.value}）
                  </option>
                ))}
              </select>
            </div>
            <div style={{ marginTop: 10 }}>
              <button
                type="button"
                style={primaryBtn}
                onClick={() => void saveRuntime()}
                disabled={busy || !runtimeDirty}
              >
                保存 runtime
              </button>
              <button
                type="button"
                style={ghostBtn}
                onClick={() => {
                  setProviderDraft(agent.provider ?? '');
                  setModelDraft(agent.modelId ?? '');
                  setThinkingDraft((agent.thinkingLevel as ThinkingLevelValue | null) ?? 'medium');
                }}
                disabled={busy || !runtimeDirty}
              >
                放弃改动
              </button>
            </div>
          </section>

          {/* 正在处理的 todo */}
          <section style={sectionStyle}>
            <h2 style={sectionTitleStyle}>正在处理的 todo</h2>
            <p style={hintStyle}>
              phase 排除终态（done / closed / failed），其余按 seqNum 升序展示。
            </p>
            {todos === null ? (
              <div style={mutedStyle}>读取中…</div>
            ) : todos.length === 0 ? (
              <div style={mutedStyle}>当前没有活跃 todo。</div>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {todos.map((t) => (
                  <li key={t.id} style={todoRowStyle}>
                    <Link href={`/todo/${encodeURIComponent(t.id)}`} style={todoLinkStyle}>
                      #{t.seqNum} {t.title}
                    </Link>
                    <span style={metaStyle}>
                      {PHASE_LABEL[t.phase] ?? t.phase}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {tab === 'access' && (
        <section style={sectionStyle}>
          <h2 style={sectionTitleStyle}>高影响能力（grants）</h2>
          <p style={hintStyle}>
            键名与 docs/permissions.md 同源 —— 改键名等于改 schema。保存是**整体替换**：
            没勾的项被删（不再出现在 jsonb 里），已勾的写为 true。
          </p>
          <ul style={grantListStyle}>
            {GRANT_DEFS.map((g) => {
              const on = grantsDraft[g.key] === true;
              return (
                <li key={g.key} style={grantItemStyle}>
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) => toggleGrant(g.key, e.target.checked)}
                      disabled={busy}
                      style={{ marginTop: 4 }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>
                        {g.label} <code style={inlineCodeStyle}>{g.key}</code>
                      </div>
                      <div style={metaStyle}>{g.hint}</div>
                    </div>
                  </label>
                </li>
              );
            })}
          </ul>
          <div style={{ marginTop: 12 }}>
            <strong style={{ fontSize: 13 }}>授权的连接（MCP servers）</strong>
            <p style={hintStyle}>
              单 agent 最多 {MAX_CONNECTIONS_PER_AGENT} 个。**连接管理在另一页**
              （`/settings/mcp-servers`），本切片先在此占位，等连接模块接好后会列出
              已授权连接，并允许在此勾选 / 取消授权。
            </p>
            {grantedConnectionKeys.length === 0 ? (
              <div style={mutedStyle}>尚未授权任何连接。</div>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {grantedConnectionKeys.map((k) => (
                  <li key={k} style={metaStyle}>
                    <code style={inlineCodeStyle}>{k}</code>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div style={{ marginTop: 12 }}>
            <button
              type="button"
              style={primaryBtn}
              onClick={() => void saveGrants()}
              disabled={busy || !grantsDirty}
            >
              保存权限
            </button>
            <button
              type="button"
              style={ghostBtn}
              onClick={() => setGrantsDraft({ ...(agent.grants ?? {}) })}
              disabled={busy || !grantsDirty}
            >
              放弃改动
            </button>
          </div>
        </section>
      )}

      {tab === 'memory' && (
        <section style={sectionStyle}>
          <h2 style={sectionTitleStyle}>Memory</h2>
          <p style={hintStyle}>
            agent 的 memory 由 docs/memory.md 描述行为 —— 每轮注入预算、scope（team / project）、
            凭据形态禁用。下方的「记忆列表 / 新增 / 编辑 / 删除」直连后台 <code style={inlineCodeStyle}>/api/teams/.../agents/.../memories</code>。
          </p>
          <MemoryTab teamId={teamId} agentId={agentId} />
        </section>
      )}

      {/* ── 删除 ── */}
      <section style={dangerSectionStyle}>
        <h2 style={sectionTitleStyle}>删除 agent</h2>
        <p style={hintStyle}>
          agents.md: removing an agent is irreversible。下方按钮会弹出二次确认。
        </p>
        <button
          type="button"
          style={dangerBtn}
          onClick={() => void deleteAgent()}
          disabled={busy}
        >
          删除这个 agent
        </button>
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div style={statBoxStyle}>
      <div style={statValueStyle}>{value}</div>
      <div style={statLabelStyle}>{label}</div>
    </div>
  );
}

function CopyChip({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      style={copyChipStyle}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      title={text}
    >
      {copied ? '已复制' : text}
    </button>
  );
}

/**
 * MemoryTab —— 直连 `…/memories` 资源。
 *
 * 设计要点（与 `routes/agent-memory.ts` 的服务层契约锁步）：
 *   - 读取走 `proxyRead`：404/网络异常 → `{ready:false,reason}`，**绝不静默**，按
 *     reason 显示「数据未就绪」占位。比既有的「拉一条然后顶替」更诚实：服务端没接好
 *     时不要让 UI 装作已对接。memory 字段内容**不遮蔽凭据** —— 用户粘了过来又能
 *     看到自己粘错（service 422 拦下写，列出 reason）。
 *   - 写成功：保存后整体 reload；upsert-by-title 看不到指定 id 时服务端按
 *     (agentId,title) 二次匹配，前端不强求拿到 memoryId 也能编辑同 title 条目。
 *   - 删除走 `window.confirm`，并落 audit_event；前端**不**试图把删除理由
 *     揉进单一字符串，避免与 service 403 措辞漂移。
 *
 * 设计上自包含一份轻量状态（list / busy / 两个草稿 / error），不依赖父组件
 * `AgentDetailContent` 的 hooks —— 这样该组件在其它 tab 被激活时也能保住草稿。
 */
interface MemoryRow {
  id: string;
  agentId: string;
  scope: string;
  projectId: string | null;
  title: string;
  content: string;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface MemoryDraft {
  /** 选中的既有条目 id；null = 新建 */
  memoryId: string | null;
  title: string;
  content: string;
  scope: 'team' | 'project';
}

function emptyDraft(): MemoryDraft {
  return { memoryId: null, title: '', content: '', scope: 'team' };
}

function MemoryTab({ teamId, agentId }: { teamId: string; agentId: string }): React.JSX.Element {
  const [list, setList] = useState<MemoryRow[] | null>(null);
  /** ready===false 时展示占位 + reason；===true 时展示列表（可能为空数组）。 */
  const [readState, setReadState] = useState<{ ready: boolean; reason?: string }>({ ready: false });
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [draft, setDraft] = useState<MemoryDraft>(emptyDraft());
  /** 正在删除的条目 id —— 给单行局部 busy 提示。 */
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(
        `/api/teams/${encodeURIComponent(teamId)}/agents/${encodeURIComponent(agentId)}/memory`,
        { cache: 'no-store' },
      );
      const body = (await res.json().catch(() => null)) as
        | { ready?: boolean; data?: MemoryRow[]; reason?: string }
        | null;
      if (body?.ready === true && Array.isArray(body.data)) {
        setList(body.data);
        setReadState({ ready: true });
      } else {
        setList(null);
        setReadState({
          ready: false,
          reason: body?.reason ?? `http-${res.status}`,
        });
      }
    } catch (err) {
      setList(null);
      setReadState({
        ready: false,
        reason: err instanceof Error ? err.name : 'unknown',
      });
    }
  }, [teamId, agentId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const startEdit = useCallback((row: MemoryRow): void => {
    setDraft({
      memoryId: row.id,
      title: row.title,
      content: row.content,
      scope: row.scope === 'project' ? 'project' : 'team',
    });
    setWriteError(null);
  }, []);

  const startCreate = useCallback((): void => {
    setDraft(emptyDraft());
    setWriteError(null);
  }, []);

  async function saveDraft(): Promise<void> {
    if (busy) return;
    const title = draft.title.trim();
    const content = draft.content.trim();
    if (title.length === 0 || content.length === 0) {
      setWriteError('title 和 content 都不能为空');
      return;
    }
    setBusy(true);
    setWriteError(null);
    try {
      const payload: Record<string, unknown> = {
        title,
        content,
        scope: draft.scope,
      };
      // 编辑既有条目带上 memoryId；不传时由服务端按 (agentId,title) upsert
      if (draft.memoryId !== null) payload['memoryId'] = draft.memoryId;
      const res = await fetch(
        `/api/teams/${encodeURIComponent(teamId)}/agents/${encodeURIComponent(agentId)}/memory`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        memory?: MemoryRow;
        error?: string;
        reason?: string;
      };
      if (res.ok && body.memory) {
        setDraft(emptyDraft());
        await reload();
        return;
      }
      // 透传上游文案（422 凭据形态、422 长度、404 memoryId 不存在、403 跨 team 等）
      const reason =
        typeof body.error === 'string'
          ? body.error
          : typeof body.reason === 'string'
            ? body.reason
            : `save failed (${res.status})`;
      setWriteError(reason);
    } catch (err) {
      setWriteError(err instanceof Error ? err.message : 'network error');
    } finally {
      setBusy(false);
    }
  }

  async function deleteMemory(row: MemoryRow): Promise<void> {
    if (busy) return;
    // 二次确认：与 agent 删除同款（用 window.confirm；不在这里拆按钮再确认，
    // 那样要新增 state 且新覆盖整片 UI，与「删除要二次确认」的最低门槛不符）
    const ok = window.confirm(
      `删除记忆「${row.title}」？\n\n` +
        `这条记忆会立刻从 agent 的注入预算里被剔除，并落 audit_event 记录。\n` +
        `可重新创建同 title 条目，但 id / updatedAt 会变。`,
    );
    if (!ok) return;
    setDeletingId(row.id);
    setWriteError(null);
    try {
      const res = await fetch(
        `/api/teams/${encodeURIComponent(teamId)}/agents/${encodeURIComponent(agentId)}/memory/${encodeURIComponent(row.id)}`,
        { method: 'DELETE' },
      );
      if (res.ok) {
        // 正在编辑的就是这条 → 清空草稿
        if (draft.memoryId === row.id) setDraft(emptyDraft());
        await reload();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        reason?: string;
      };
      const reason =
        typeof body.error === 'string'
          ? body.error
          : typeof body.reason === 'string'
            ? body.reason
            : `delete failed (${res.status})`;
      setWriteError(reason);
    } catch (err) {
      setWriteError(err instanceof Error ? err.message : 'network error');
    } finally {
      setDeletingId(null);
    }
  }

  const isEditing = draft.memoryId !== null;
  const dirty = draft.title.length > 0 || draft.content.length > 0;

  return (
    <div>
      {writeError !== null && (
        <div style={errorStyle}>{writeError}</div>
      )}

      {/* 失败占位（readState.ready === false）：**不**静默替代成假空数组 */}
      {!readState.ready && (
        <div style={memoryPlaceholderStyle}>
          <strong>记忆数据未就绪</strong>
          <div style={{ marginTop: 4, fontSize: 13, lineHeight: 1.5 }}>
            拉取记忆列表失败（reason = <code style={inlineCodeStyle}>{readState.reason ?? 'unknown'}</code>）。
            这通常是上游 BFF / 服务端还没就绪 —— 等就绪后再回 Memory tab。新增记忆
            的写入按钮**仍然可用**，写完会自动重拉列表。
          </div>
        </div>
      )}

      {/* 新增 / 编辑草稿块 —— 不依赖 readState.ready，写路径独立 */}
      <div style={memoryDraftBoxStyle}>
        <div style={{ ...sectionTitleStyle, fontSize: T.base, marginBottom: 6 }}>
          {isEditing ? '编辑记忆' : '新增记忆'}
        </div>
        <label style={labelStyle}>title（≤ 80 字符）</label>
        <input
          type="text"
          value={draft.title}
          maxLength={80}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          style={inputStyle}
          placeholder="e.g. release-tag-rule"
          disabled={busy}
        />
        <label style={labelStyle}>content（≤ 1200 字符；禁止凭据 / API key）</label>
        <textarea
          value={draft.content}
          maxLength={1200}
          onChange={(e) => setDraft({ ...draft, content: e.target.value })}
          style={textareaStyle}
          placeholder="记一份规则或上下文"
          disabled={busy}
        />
        <label style={labelStyle}>scope</label>
        <select
          value={draft.scope}
          onChange={(e) =>
            setDraft({ ...draft, scope: e.target.value === 'project' ? 'project' : 'team' })
          }
          style={selectStyle}
          disabled={busy}
        >
          <option value="team">team（团队共享）</option>
          <option value="project">project（仅该 project）</option>
        </select>
        <div style={{ ...fieldRowStyle, display: 'flex', gap: 8 }}>
          <button
            type="button"
            style={primaryBtn}
            onClick={() => void saveDraft()}
            disabled={busy || !dirty}
          >
            {busy ? '保存中…' : isEditing ? '保存' : '创建'}
          </button>
          {(isEditing || dirty) && (
            <button
              type="button"
              style={ghostBtn}
              onClick={startCreate}
              disabled={busy}
            >
              放弃改动
            </button>
          )}
        </div>
      </div>

      {/* 列表 */}
      {readState.ready && (
        <div style={memoryListStyle}>
          <div style={{ ...sectionTitleStyle, fontSize: T.base, marginBottom: 6 }}>
            已记忆（{(list ?? []).length}）
          </div>
          {(list ?? []).length === 0 ? (
            <div style={mutedStyle}>暂无记忆。用上方表单新增，或等 Chief 自动注入。</div>
          ) : (
            (list ?? []).map((row) => (
              <div key={row.id} style={memoryRowStyle}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={memoryTitleStyle}>
                    {row.title}
                    <span style={memoryScopeChipStyle}>{row.scope}</span>
                  </div>
                  <div style={memoryContentStyle}>
                    {row.content.length > 160 ? row.content.slice(0, 160) + '…' : row.content}
                  </div>
                  <div style={memoryMetaStyle}>
                    更新于 {new Date(row.updatedAt).toLocaleString()} · 创建于{' '}
                    {new Date(row.createdAt).toLocaleString()}
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <button
                    type="button"
                    style={ghostBtn}
                    onClick={() => startEdit(row)}
                    disabled={busy || deletingId !== null}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    style={dangerBtn}
                    onClick={() => void deleteMemory(row)}
                    disabled={busy || deletingId !== null}
                  >
                    {deletingId === row.id ? '删除中…' : '删除'}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      <div style={{ marginTop: 8 }}>
        <button
          type="button"
          style={ghostBtn}
          onClick={() => void reload()}
          disabled={busy || deletingId !== null}
        >
          刷新记忆列表
        </button>
      </div>
    </div>
  );
}

// ── 样式 ─────────────────────────────────────────────────────────

const backLinkStyle: CSSProperties = { fontSize: T.meta, color: C.accent, textDecoration: 'none' };
const hintStyle: CSSProperties = { color: C.textDim, fontSize: T.meta, marginBottom: S.md, lineHeight: 1.5 };
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
/**
 * MemoryTab 占位 —— 仅 `readState.ready === false` 时显示，绝不替代成空数组占位，
 * 让「上游断了」这件事能被立刻看到。仍允许写：用 `shared.placeholderBox` 做警示
 * 视觉，不在这里用 placeholderStyle（那是删除按钮区专属的，区别开来避免混淆）。
 */
const memoryPlaceholderStyle: CSSProperties = {
  ...shared.placeholderBox,
  fontSize: T.meta,
  color: C.textDim,
  marginBottom: S.md,
};
const memoryDraftBoxStyle: CSSProperties = {
  border: `1px solid ${C.line}`,
  borderRadius: R.md,
  padding: S.md,
  background: C.surface,
  marginBottom: S.md,
};
const memoryListStyle: CSSProperties = { marginTop: S.md };
const memoryRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
  padding: '10px 12px',
  border: `1px solid ${C.line}`,
  borderRadius: R.md,
  background: C.surface,
  marginBottom: 6,
};
const memoryTitleStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: T.base,
  fontWeight: 600,
  color: C.text,
  wordBreak: 'break-word',
};
const memoryScopeChipStyle: CSSProperties = {
  fontSize: T.sm,
  fontWeight: 400,
  color: C.textDim,
  border: `1px solid ${C.line}`,
  borderRadius: R.sm,
  padding: '1px 6px',
  background: C.code,
};
const memoryContentStyle: CSSProperties = {
  fontSize: T.meta,
  color: C.text,
  marginTop: 4,
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};
const memoryMetaStyle: CSSProperties = {
  fontSize: T.sm,
  color: C.textDim,
  marginTop: 4,
};
const sectionStyle: CSSProperties = {
  ...shared.card,
  marginBottom: 16,
};
const sectionTitleStyle: CSSProperties = { fontSize: T.bodyLg, margin: '0 0 8px', color: C.text };
const profileStyle: CSSProperties = {
  ...shared.card,
  marginBottom: 16,
};
const avatarStyle: CSSProperties = {
  width: 64,
  height: 64,
  borderRadius: 32,
  background: 'rgba(129,140,248,0.14)',
  color: C.accent,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 26,
  fontWeight: 700,
  flex: '0 0 64px',
};
const statsStripStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
  gap: 8,
  marginTop: 12,
  borderTop: '1px solid rgba(255,255,255,0.06)',
  paddingTop: 12,
};
/** 三项统计盒子（活跃 todo / default skills / 已授权连接 / 创建于）—— 走 surfaceHi 底。 */
const statBoxStyle: CSSProperties = {
  background: C.surfaceHi,
  border: `1px solid ${C.line}`,
  borderRadius: R.md,
  padding: 8,
  textAlign: 'center',
};
const statValueStyle: CSSProperties = { fontSize: 16, fontWeight: 600, color: C.text };
const statLabelStyle: CSSProperties = { fontSize: T.sm, color: C.textDim, marginTop: 2 };
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
const selectStyle: CSSProperties = {
  ...inputStyle,
  width: '100%',
  background: C.bg,
};
const fieldRowStyle: CSSProperties = { marginTop: 8 };
const primaryBtn: CSSProperties = {
  ...shared.primaryBtn,
  padding: '6px 14px',
  fontSize: T.meta,
};
const ghostBtn: CSSProperties = {
  ...shared.ghostBtn,
  padding: '5px 10px',
  fontSize: T.base,
  marginRight: 6,
  marginLeft: 6,
};
const dangerBtn: CSSProperties = {
  ...shared.dangerBtn,
  padding: '6px 14px',
  fontSize: T.meta,
};
const metaStyle: CSSProperties = { color: C.textDim, fontSize: T.base };
const copyChipStyle: CSSProperties = {
  display: 'inline-block',
  fontSize: T.base,
  padding: '4px 10px',
  border: `1px solid ${C.line}`,
  background: C.code,
  color: C.text,
  borderRadius: R.md,
  fontFamily: F.mono,
  cursor: 'pointer',
  wordBreak: 'break-all',
  maxWidth: '100%',
};
const inlineCodeStyle: CSSProperties = {
  background: C.code,
  color: C.text,
  padding: '1px 6px',
  borderRadius: R.sm,
  fontSize: T.base,
  fontFamily: F.mono,
  marginLeft: 4,
};
const tabNavStyle: CSSProperties = {
  display: 'flex',
  gap: 4,
  borderBottom: `1px solid ${C.line}`,
  marginBottom: 16,
};
const tabBtnStyle: CSSProperties = {
  padding: '8px 14px',
  border: 'none',
  background: 'transparent',
  fontSize: T.meta,
  color: C.textDim,
  cursor: 'pointer',
  borderRadius: '6px 6px 0 0',
};
const activeTabBtnStyle: CSSProperties = {
  color: C.text,
  fontWeight: 600,
  borderBottom: `2px solid ${C.accent}`,
};
const chipGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
  gap: 6,
};
const chipLabelStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: T.meta,
  padding: '4px 8px',
  border: `1px solid ${C.line}`,
  borderRadius: R.md,
  background: C.surface,
  color: C.text,
};
const todoRowStyle: CSSProperties = {
  padding: '8px 12px',
  borderBottom: '1px solid rgba(255,255,255,0.06)',
  display: 'flex',
  alignItems: 'center',
  gap: 12,
};
const todoLinkStyle: CSSProperties = {
  flex: 1,
  color: C.accent,
  textDecoration: 'none',
  fontSize: T.meta,
  minWidth: 0,
};
const grantListStyle: CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: 0,
};
const grantItemStyle: CSSProperties = {
  padding: '10px 12px',
  border: `1px solid ${C.line}`,
  borderRadius: R.md,
  marginBottom: 6,
  background: C.surface,
};
/** 删除区：红底浅染 + danger 边。 */
const dangerSectionStyle: CSSProperties = {
  background: 'rgba(248,113,113,0.12)',
  border: `1px solid ${C.danger}`,
  borderRadius: R.xl,
  padding: S.lg,
  marginTop: 24,
};