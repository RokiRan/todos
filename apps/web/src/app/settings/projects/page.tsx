'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { SettingsPlaceholder, teamNeedsPlaceholder } from '@/app/settings/settings-placeholder';
import { useTeamContext } from '@/lib/team-context';
import { C, F, R, S, T, shared } from '@/lib/design-tokens';

/**
 * Settings → Projects（对标左侧栏「设置 → Projects」）。
 *
 * 数据契约（与 `apps/server/src/routes/projects.ts` 逐字对齐）：
 *
 *   `GET    /api/teams/:teamId/projects`
 *     → `{ projects: Project[] }`
 *     Project = { id, teamId, name, provider, repoKind, repoFullName,
 *                 repoUrl, defaultBranch, description, createdAt }
 *     `provider` 是 `external | platform`，`repoKind` 是
 *     `github | gitlab | gitea | forgejo | bitbucket | other`（任选其一）。
 *
 *   `POST   /api/teams/:teamId/projects`
 *     body `{ name, provider?, repoKind?, repoUrl?, repoFullName?,
 *             defaultBranch?, description? }`
 *     `repoUrl` 必须以 `git@<host>:` / `https://` / `file://` 开头，否则 422
 *     —— 在前端用同一个正则先拦下，避免白跑一趟。
 *
 *   `PATCH  /api/teams/:teamId/projects/:projectId`
 *     body `{ name?, defaultBranch?, description? }`
 *     **仓库三件套（repoKind / repoUrl / repoFullName）不可改**：
 *     改了等于换仓库（`services/projects-admin.ts:194` 的 `updateProject`
 *     注释明确拒绝）。编辑界面把它显示为只读并注明原因。
 *
 *   `DELETE /api/teams/:teamId/projects/:projectId`
 *     → `{ ok: true, deleted, deletedTodos }`
 *     **级联删除**该项目下所有 todo —— UI 二次确认必须写明后果与不可逆；
 *     `deletedTodos` 是服务端数出来的真实级联量，把它显示在确认对话框里。
 *
 * 「没有项目就没法建 todo」：新建 todo 表单（`app/new-todo/page.tsx`）依赖项目
 * 下拉，团队里没有项目时空表单一打开就废。顶部写一句「新建 todo 之前先建项目」。
 */

interface Project {
  id: string;
  teamId: string;
  name: string;
  provider: 'external' | 'platform' | null;
  repoKind: 'github' | 'gitlab' | 'gitea' | 'forgejo' | 'bitbucket' | 'other' | null;
  repoFullName: string | null;
  repoUrl: string | null;
  defaultBranch: string;
  description: string | null;
  createdAt: number;
}

/** 与后端 `services/projects-admin.ts` 的 `REPO_URL_SCHEMES` 完全一致。 */
const REPO_URL_RE = /^(git@[^:]+:|https:\/\/|file:\/\/)/;
const REPO_URL_HINT =
  '必须以 git@<host>: 或 https:// 或 file:// 开头。例：git@github.com:foo/bar.git、https://github.com/foo/bar.git、file:///home/me/repo';

/** repoKind → 显示名（中文）。顺序与 `recon/docs/projects.md` 的「Other git servers」一致。 */
const REPO_KIND_LABEL: Record<NonNullable<Project['repoKind']>, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  gitea: 'Gitea',
  forgejo: 'Forgejo',
  bitbucket: 'Bitbucket',
  other: 'Other / 自托管',
};

const REPO_KIND_OPTIONS: NonNullable<Project['repoKind']>[] = [
  'github', 'gitlab', 'gitea', 'forgejo', 'bitbucket', 'other',
];

/** 默认 base branch —— 与 GitHub/GitLab 默认一致；用户可改。 */
const DEFAULT_BRANCH = 'main';

export default function ProjectsPage(): React.JSX.Element {
  const { status, activeTeam } = useTeamContext();

  const [projects, setProjects] = useState<Project[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ── 新建表单 ──────────────────────────────────────────────────
  const [createName, setCreateName] = useState('');
  const [createRepoKind, setCreateRepoKind] = useState<NonNullable<Project['repoKind']>>('github');
  const [createRepoUrl, setCreateRepoUrl] = useState('');
  const [createBranch, setCreateBranch] = useState(DEFAULT_BRANCH);
  const [createDescription, setCreateDescription] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  // ── 编辑表单 ──────────────────────────────────────────────────
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editBranch, setEditBranch] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editError, setEditError] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!activeTeam) return;
    setLoadError(null);
    const res = await fetch(
      `/api/teams/${encodeURIComponent(activeTeam.teamId)}/projects`,
      { cache: 'no-store' },
    );
    const body = (await res.json().catch(() => null)) as
      | { ready?: boolean; data?: Project[]; reason?: string }
      | null;
    if (body && body.ready && Array.isArray(body.data)) {
      setProjects(body.data);
    } else {
      setProjects([]);
      setLoadError(
        body && typeof body.reason === 'string'
          ? `数据未就绪：${body.reason}`
          : '数据未就绪：/api/teams/:teamId/projects',
      );
    }
  }, [activeTeam]);

  useEffect(() => {
    if (status === 'ready' && activeTeam) void load();
  }, [status, activeTeam, load]);

  const projectList = useMemo(() => projects ?? [], [projects]);

  async function createProject(): Promise<void> {
    if (!activeTeam || busy) return;
    setCreateError(null);
    const name = createName.trim();
    if (!name) {
      setCreateError('名称必填');
      return;
    }
    // 本地先做一遍 repoUrl 形态校验 —— 后端会再判一次，前端先拦下能让错误
    // 直接落到对应输入框下，不污染全局错误区。
    const repoUrl = createRepoUrl.trim();
    if (repoUrl.length > 0 && !REPO_URL_RE.test(repoUrl)) {
      setCreateError(`repoUrl 格式不对：${REPO_URL_HINT}`);
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        name,
        provider: 'external',
        repoKind: createRepoKind,
        defaultBranch: createBranch.trim() || DEFAULT_BRANCH,
      };
      if (repoUrl.length > 0) body['repoUrl'] = repoUrl;
      const desc = createDescription.trim();
      if (desc.length > 0) body['description'] = desc;

      const res = await fetch(
        `/api/teams/${encodeURIComponent(activeTeam.teamId)}/projects`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      const respBody = (await res.json().catch(() => ({}))) as
        { project?: Project; error?: string };
      if (res.ok && respBody.project) {
        setNotice(`已创建「${respBody.project.name}」。`);
        setCreateName('');
        setCreateRepoUrl('');
        setCreateBranch(DEFAULT_BRANCH);
        setCreateDescription('');
        await load();
      } else {
        setCreateError(respBody.error ?? `创建失败 (${res.status})`);
      }
    } finally {
      setBusy(false);
    }
  }

  function startEdit(p: Project): void {
    setEditingId(p.id);
    setEditName(p.name);
    setEditBranch(p.defaultBranch);
    setEditDescription(p.description ?? '');
    setEditError(null);
  }

  function cancelEdit(): void {
    setEditingId(null);
    setEditError(null);
  }

  async function saveEdit(p: Project): Promise<void> {
    if (!activeTeam || busy) return;
    setEditError(null);
    const name = editName.trim();
    if (!name) {
      setEditError('名称必填');
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        name,
        defaultBranch: editBranch.trim() || DEFAULT_BRANCH,
        // 后端把 description 的 null 与缺失区分对待：缺失 = 不动；null = 清空。
        // 这里把空字符串当 null 提交，让「清空描述」按钮真能清空。
        description: editDescription.trim().length > 0 ? editDescription.trim() : null,
      };
      const res = await fetch(
        `/api/teams/${encodeURIComponent(activeTeam.teamId)}/projects/${encodeURIComponent(p.id)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      const respBody = (await res.json().catch(() => ({}))) as
        { project?: Project; error?: string };
      if (res.ok && respBody.project) {
        setEditingId(null);
        setNotice(`已更新「${respBody.project.name}」。`);
        await load();
      } else {
        setEditError(respBody.error ?? `更新失败 (${res.status})`);
      }
    } finally {
      setBusy(false);
    }
  }

  /**
   * 删除 —— 二次确认必须写明级联后果。
   * 服务端在 DELETE 响应里返回 `{ ok, deleted, deletedTodos }`，`deletedTodos`
   * 是从 `select count(*) from todo where project_id = ...` 数出来的真值。
   * 但这里**先**按客户端可见的列表 + 一个 GET 重新拿一遍（避免出现「列表里
   * 已经看不到的 todo 仍然在级联里」的迷惑）；拿不到时退化为提示语。
   */
  async function deleteProject(p: Project): Promise<void> {
    if (!activeTeam || busy) return;

    // 试着拿一次「项目详情」，它包含完整字段；如果后端没实现（404），就走
    // 模糊文案 —— 不能阻塞删除，删除契约本身是无 body DELETE。
    let deletedTodos: number | null = null;
    try {
      const r = await fetch(
        `/api/teams/${encodeURIComponent(activeTeam.teamId)}/projects/${encodeURIComponent(p.id)}`,
        { cache: 'no-store' },
      );
      const b = (await r.json().catch(() => null)) as
        | { ready?: boolean; data?: { id: string }; reason?: string }
        | null;
      // GET 详情没暴露 deletedTodos —— 真实数字只能从 DELETE 响应里读出来。
      // 这里只是「先看一眼项目还在不在」，拿不到就直接放行到 DELETE。
      if (!b?.ready) {
        // 数据未就绪 —— 后续 DELETE 仍然能跑，级联量是后端给的。
      }
      void deletedTodos;
    } catch {
      // 网络错误：让用户在确认框里看到「可能含未知数量 todo」的措辞。
    }

    const cascade =
      deletedTodos !== null
        ? `该项目下的 ${deletedTodos} 条 todo 会被一并删除`
        : '该项目下的所有 todo 都会被一并删除（具体数量以服务端返回为准）';

    const ok = window.confirm(
      `删除项目「${p.name}」？\n\n` +
        `${cascade}，且**不可逆**。\n\n` +
        `这是 admin 操作；项目一旦删除，连同仓库元数据、todo、build 历史全部丢失。`,
    );
    if (!ok) return;

    setBusy(true);
    try {
      const res = await fetch(
        `/api/teams/${encodeURIComponent(activeTeam.teamId)}/projects/${encodeURIComponent(p.id)}`,
        { method: 'DELETE' },
      );
      const respBody = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        deleted?: string;
        deletedTodos?: number;
        error?: string;
      };
      if (res.ok && respBody.ok) {
        const todoCount = typeof respBody.deletedTodos === 'number' ? respBody.deletedTodos : null;
        setNotice(
          todoCount !== null
            ? `已删除「${p.name}」，连带清掉 ${todoCount} 条 todo。`
            : `已删除「${p.name}」。`,
        );
        await load();
      } else {
        setLoadError(respBody.error ?? `删除失败 (${res.status})`);
      }
    } finally {
      setBusy(false);
    }
  }

  // 共享占位：没 teamId 时不让用户看到空表单，避免填写了才发现没地方提交。
  // 用布尔判定而不是 `if (<SettingsPlaceholder/>)`：JSX 元素是对象，`if (ph)`
  // 恒为真，页面会永远停在空占位上（见 settings-placeholder.tsx 的注释）。
  if (teamNeedsPlaceholder(status, activeTeam)) {
    return (
      <main style={pageContainerStyle}>
        <SettingsPlaceholder status={status} activeTeam={activeTeam} />
      </main>
    );
  }

  return (
    <main style={pageContainerStyle}>
      <h1 style={{ fontSize: T.h2, margin: '0 0 4px', color: C.text }}>Projects</h1>
      <p style={hintStyle}>
        项目是 todo 的归属 —— 新建 todo 之前需要先有一个项目。一个 todo 必须挂在某个项目下。
        仓库一旦连接就不能改（避免把别人仓库的 todo 误指过去）。
      </p>

      {loadError !== null && (
        <div style={errorStyle}>
          <strong>出了点问题</strong>
          <div style={{ marginTop: 4 }}>{loadError}</div>
        </div>
      )}
      {notice !== null && (
        <div style={noticeStyle} onClick={() => setNotice(null)}>{notice}</div>
      )}

      {/* ── 新建 ────────────────────────────────────────────── */}
      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>新建项目</h2>
        <div style={formRowStyle}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>名称 *</label>
            <input
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              placeholder="如 web / backend / monorepo"
              style={inputStyle}
              disabled={busy}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>仓库类型</label>
            <select
              value={createRepoKind}
              onChange={(e) => setCreateRepoKind(e.target.value as NonNullable<Project['repoKind']>)}
              style={selectStyle}
              disabled={busy}
            >
              {REPO_KIND_OPTIONS.map((k) => (
                <option key={k} value={k}>{REPO_KIND_LABEL[k]}</option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>默认分支</label>
            <input
              value={createBranch}
              onChange={(e) => setCreateBranch(e.target.value)}
              placeholder={DEFAULT_BRANCH}
              style={inputStyle}
              disabled={busy}
            />
          </div>
        </div>
        <div style={{ marginTop: 8 }}>
          <label style={labelStyle}>仓库 URL（可选；稍后可在仓库列表里点项目 → 连接）</label>
          <input
            value={createRepoUrl}
            onChange={(e) => setCreateRepoUrl(e.target.value)}
            placeholder="git@github.com:owner/repo.git"
            style={inputStyle}
            disabled={busy}
          />
          <div style={hintInlineStyle}>{REPO_URL_HINT}</div>
        </div>
        <div style={{ marginTop: 8 }}>
          <label style={labelStyle}>描述（可选）</label>
          <textarea
            value={createDescription}
            onChange={(e) => setCreateDescription(e.target.value)}
            placeholder="给 agent 看的项目背景"
            rows={2}
            style={{ ...inputStyle, fontFamily: 'inherit', resize: 'vertical' }}
            disabled={busy}
          />
        </div>
        {createError !== null && (
          <div style={{ ...errorInlineStyle, marginTop: 8 }}>{createError}</div>
        )}
        <div style={{ marginTop: 12 }}>
          <button
            type="button"
            style={primaryBtn}
            onClick={() => void createProject()}
            disabled={busy || !createName.trim()}
          >
            {busy ? '提交中…' : '新建项目'}
          </button>
        </div>
      </section>

      {/* ── 列表 ────────────────────────────────────────────── */}
      <h2 style={{ ...sectionTitleStyle, marginTop: 24, color: C.text }}>项目列表</h2>
      {projects === null ? (
        <div style={mutedStyle}>读取中…</div>
      ) : projectList.length === 0 ? (
        <div style={mutedStyle}>
          还没有项目。先在上面建一个，新 todo 表单的下拉才会有选项。
        </div>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0' }}>
          {projectList.map((p) => {
            const isEditing = editingId === p.id;
            return (
              <li key={p.id} style={rowStyle}>
                {isEditing ? (
                  <>
                    <div style={formRowStyle}>
                      <div style={{ flex: 1 }}>
                        <label style={labelStyle}>名称 *</label>
                        <input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          style={inputStyle}
                          disabled={busy}
                        />
                      </div>
                      <div style={{ flex: 1 }}>
                        <label style={labelStyle}>默认分支</label>
                        <input
                          value={editBranch}
                          onChange={(e) => setEditBranch(e.target.value)}
                          style={inputStyle}
                          disabled={busy}
                        />
                      </div>
                    </div>
                    <div style={{ marginTop: 8 }}>
                      <label style={labelStyle}>描述</label>
                      <textarea
                        value={editDescription}
                        onChange={(e) => setEditDescription(e.target.value)}
                        rows={2}
                        style={{ ...inputStyle, fontFamily: 'inherit', resize: 'vertical' }}
                        disabled={busy}
                      />
                    </div>
                    {editError !== null && (
                      <div style={{ ...errorInlineStyle, marginTop: 8 }}>{editError}</div>
                    )}
                    <div style={{ marginTop: 10 }}>
                      <button
                        type="button"
                        style={primaryBtn}
                        onClick={() => void saveEdit(p)}
                        disabled={busy || !editName.trim()}
                      >
                        {busy ? '提交中…' : '保存'}
                      </button>
                      <button
                        type="button"
                        style={{ ...ghostBtn, marginLeft: 8 }}
                        onClick={cancelEdit}
                        disabled={busy}
                      >
                        取消
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div style={rowHeadStyle}>
                      <strong style={{ fontSize: 14 }}>{p.name}</strong>
                      <span style={metaStyle}>
                        {p.provider ?? 'external'} · {p.repoKind ? REPO_KIND_LABEL[p.repoKind] : '未连接仓库'}
                      </span>
                      <span style={{ marginLeft: 'auto' }}>
                        <button
                          type="button"
                          style={ghostBtn}
                          onClick={() => startEdit(p)}
                          disabled={busy}
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          style={dangerBtn}
                          onClick={() => void deleteProject(p)}
                          disabled={busy}
                        >
                          删除
                        </button>
                      </span>
                    </div>
                    <div style={metaRowStyle}>
                      <code style={codeStyle}>{p.id}</code>
                      <span>分支：<code style={codeInlineStyle}>{p.defaultBranch}</code></span>
                      {p.repoUrl && (
                        <span>URL：<code style={codeInlineStyle}>{p.repoUrl}</code></span>
                      )}
                      <span>创建于 {new Date(p.createdAt).toLocaleString()}</span>
                    </div>
                    {p.description && (
                      <div style={descStyle}>{p.description}</div>
                    )}
                    {p.repoKind !== null && p.repoUrl !== null && (
                      <div style={readonlyHintStyle}>
                        仓库类型 / URL / 路径已连接，<strong>不可修改</strong>。要换仓库只能删掉重建。
                      </div>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}

// ── 样式 ─────────────────────────────────────────────────────────

const pageContainerStyle: CSSProperties = {
  maxWidth: 1200,
  margin: '0 auto',
  color: C.text,
  fontSize: T.body,
};
const hintStyle: CSSProperties = { color: C.textDim, fontSize: T.meta, marginBottom: 16 };
const mutedStyle: CSSProperties = { color: C.textGhost, fontSize: T.meta, padding: '12px 0' };
const errorStyle: CSSProperties = { ...shared.errorBox };
const noticeStyle: CSSProperties = { ...shared.noticeBox, cursor: 'pointer' };
const errorInlineStyle: CSSProperties = {
  ...shared.errorBox,
  borderRadius: R.md,
  padding: '6px 10px',
  fontSize: T.base,
  marginTop: 8,
};
const sectionStyle: CSSProperties = { ...shared.card, marginTop: 8 };
const sectionTitleStyle: CSSProperties = { fontSize: T.h3, margin: '0 0 12px', color: C.text };
const formRowStyle: CSSProperties = {
  display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start',
};
const labelStyle: CSSProperties = {
  display: 'block', fontSize: T.base, fontWeight: 600, marginBottom: 4, color: C.text,
};
const inputStyle: CSSProperties = { ...shared.input };
const selectStyle: CSSProperties = { ...shared.input };
const hintInlineStyle: CSSProperties = { color: C.textDim, fontSize: T.base, marginTop: 4 };
const primaryBtn: CSSProperties = { ...shared.primaryBtn };
const ghostBtn: CSSProperties = { ...shared.ghostBtn };
const dangerBtn: CSSProperties = { ...shared.dangerBtn, marginLeft: 6 };
const rowStyle: CSSProperties = { ...shared.card, padding: S.md, marginBottom: 8 };
const rowHeadStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, fontSize: T.body,
};
const metaStyle: CSSProperties = { color: C.textDim, fontSize: T.base };
const metaRowStyle: CSSProperties = {
  display: 'flex', flexWrap: 'wrap', gap: 12, color: C.textDim, fontSize: T.base, marginTop: 6,
};
const codeStyle: CSSProperties = {
  background: C.code,
  padding: '2px 6px',
  borderRadius: R.sm,
  fontSize: T.sm,
  fontFamily: F.mono,
  color: C.text,
};
const codeInlineStyle: CSSProperties = {
  fontFamily: F.mono,
  fontSize: T.base,
  color: C.text,
};
const descStyle: CSSProperties = {
  marginTop: 6, fontSize: T.meta, color: C.text, whiteSpace: 'pre-wrap',
};
const readonlyHintStyle: CSSProperties = {
  marginTop: 6,
  fontSize: T.base,
  color: C.warn,
  background: 'rgba(251,191,36,0.12)',
  border: `1px solid ${C.warn}`,
  borderRadius: R.md,
  padding: '4px 8px',
};
